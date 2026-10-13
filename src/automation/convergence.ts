/** QC-evidence-gated propagation of upstream commits into dependent Worktrees.
 * Only provable fast-forward Git integration is automatic; divergent branches,
 * busy workers, unknown Git outcomes and conflicting approvals fail closed. */
import {createHash,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import type {PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";
import type {WorkflowStore} from "../core/store.js";
import type {WorkflowInstance,TaskState} from "../core/workflow.js";
import type {AgentRegistry,AgentBinding} from "../runtime/registry.js";
import type {AutopilotLedger,AutopilotRecord} from "./ledger.js";
import {automationScope} from "./ledger.js";
import {internalCommandId} from "../core/identifiers.js";
import type {PermissionLedger} from "./permissions.js";
import {git,gitSha,gitValue,requireAncestor,requireCleanGit,type GitHost} from "./git.js";

export interface ConvergenceReceipt {
  id:string;workflowId:string;sourceTaskId:string;targetTaskId:string;
  targetWorkspaceId:string;qcRunId:string;sourceSha:string;baselineSha:string;
  branch:string;state:"reserved"|"completed";createdAt:string;updatedAt:string;
}
interface ConvergenceRow extends ConvergenceReceipt{scope:string;fingerprint:string}
interface ConvergenceOptions {
  path:string;host:GitHost;workflows:WorkflowStore;
  agents:AgentRegistry;ledger:AutopilotLedger;
  permissions:PermissionLedger;workspaces():PiWebHostWorkspacesV1|undefined;
}
const COLS="id,scope,workflow_id AS workflowId,source_task_id AS sourceTaskId,"+
  "target_task_id AS targetTaskId,target_workspace_id AS targetWorkspaceId,"+
  "qc_run_id AS qcRunId,source_sha AS sourceSha,baseline_sha AS baselineSha,"+
  "branch,fingerprint,state,created_at AS createdAt,updated_at AS updatedAt";
function operationKey(row:Omit<ConvergenceReceipt,"id"|"state"|"createdAt"|"updatedAt">):string{
  return createHash("sha256").update(JSON.stringify([
    row.workflowId,row.sourceTaskId,row.targetTaskId,row.targetWorkspaceId,
    row.qcRunId,row.sourceSha,row.baselineSha,row.branch])).digest("hex");
}
function safeBranch(branch:string):boolean{
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,118}$/.test(branch)&&
    !branch.includes("..")&&!branch.includes("//")&&!branch.includes("@{")&&
    !branch.endsWith("/")&&!branch.endsWith(".")&&!branch.endsWith(".lock")&&
    !/^(main|master|develop|production|stable|release)(\/|$)/i.test(branch);
}
export class AutomaticIntegrator {
  private readonly db:DatabaseSync;
  /** One host-owned Git convergence operation at a time, even when several
   * independently ticked Workflows reference the same linked Worktree. */
  private operationQueue:Promise<void>=Promise.resolve();
  constructor(private readonly opt:ConvergenceOptions){
    mkdirSync(dirname(opt.path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(opt.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS auto_git_convergence(
        id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflow_id TEXT NOT NULL,
        source_task_id TEXT NOT NULL,target_task_id TEXT NOT NULL,
        target_workspace_id TEXT NOT NULL,qc_run_id TEXT NOT NULL,
        source_sha TEXT NOT NULL,baseline_sha TEXT NOT NULL,
        branch TEXT NOT NULL,fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        UNIQUE(scope,workflow_id,source_task_id,target_task_id,qc_run_id));`);
  }
  close():void{this.db.close();}
  list(p:string,o:string,workflowId:string):ConvergenceReceipt[]{
    this.opt.workflows.get(p,o,workflowId);
    return this.db.prepare("SELECT "+COLS+" FROM auto_git_convergence"+
      " WHERE scope=? AND workflow_id=? ORDER BY created_at DESC LIMIT 100")
      .all(automationScope(p,o),workflowId) as unknown as ConvergenceReceipt[];
  }
  private get(p:string,o:string,w:string,sourceId:string,targetId:string,runId:string):
    ConvergenceRow|undefined {
    return this.db.prepare("SELECT "+COLS+" FROM auto_git_convergence"+
      " WHERE scope=? AND workflow_id=? AND source_task_id=?"+
      " AND target_task_id=? AND qc_run_id=?")
      .get(automationScope(p,o),w,sourceId,targetId,runId) as ConvergenceRow|undefined;
  }
  private reserve(p:string,o:string,w:string,
    record:Omit<ConvergenceReceipt,"id"|"state"|"createdAt"|"updatedAt">):ConvergenceRow{
    const fingerprint=operationKey(record);
    const existing=this.get(p,o,w,record.sourceTaskId,record.targetTaskId,record.qcRunId);
    if(existing){
      if(existing.fingerprint!==fingerprint)
        throw new Error("Git convergence target changed after the first attempt; manual reconciliation required");
      return existing;
    }
    const at=new Date().toISOString(),id=randomUUID();
    this.db.prepare(`INSERT INTO auto_git_convergence(
      id,scope,workflow_id,source_task_id,target_task_id,
      target_workspace_id,qc_run_id,source_sha,baseline_sha,branch,
      fingerprint,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)
      ON CONFLICT(scope,workflow_id,source_task_id,target_task_id,qc_run_id) DO NOTHING`)
      .run(id,automationScope(p,o),w,record.sourceTaskId,record.targetTaskId,
        record.targetWorkspaceId,record.qcRunId,record.sourceSha,record.baselineSha,
        record.branch,fingerprint,at,at);
    const row=this.get(p,o,w,record.sourceTaskId,record.targetTaskId,record.qcRunId);
    if(!row||row.fingerprint!==fingerprint)
      throw new Error("Conflicting Git convergence reservation");
    return row;
  }
  private complete(row:ConvergenceRow):void{
    this.db.prepare("UPDATE auto_git_convergence SET state='completed',updated_at=?"+
      " WHERE id=? AND state='reserved'").run(new Date().toISOString(),row.id);
  }
  private source(record:AutopilotRecord,workflow:WorkflowInstance,task:TaskState):AgentBinding{
    const p=record.projectId,o=record.orchestraWorkspaceId,w=record.workflowId;
    const qc=task.lastQc;
    if(task.status!=="passed"||task.spec.kind!=="implementation"||
      qc?.verdict!=="pass"||!gitSha(qc.headSha))
      throw new Error("Automatic integration requires a current QC PASS");
    const binding=this.opt.agents.getRun(p,o,w,qc.runId);
    if(!binding||binding.taskId!==task.spec.id||binding.seat!=="qc"||
      binding.phase!=="sealed"||!binding.sessionId||!binding.evidenceRef||
      !binding.requestId.startsWith("auto:"))
      throw new Error("Automatic integration QC Run is not sealed");
    const receipt=this.opt.ledger.evidence(binding);
    if(!receipt||receipt.ref!==binding.evidenceRef||
      receipt.sessionId!==binding.sessionId)
      throw new Error("Automatic integration QC evidence mismatch");
    // A QC hold never permits modifying a downstream task. The Workflow
    // state machine returns status 'held', so this source check rejects it.
    return binding;
  }
  private ensureCurrent(record:AutopilotRecord,sourceId:string,runId:string,
    sourceSha:string,targetId:string):void{
    this.opt.host.lifetimeSignal.throwIfAborted();
    const p=record.projectId,o=record.orchestraWorkspaceId,w=record.workflowId;
    const current=this.opt.ledger.get(p,o,w);
    if(!current?.enabled||JSON.stringify(current.config.workspaces)!==
      JSON.stringify(record.config.workspaces))
      throw new Error("Autopilot stopped or Task Worktree assignments changed");
    const workflow=this.opt.workflows.get(p,o,w);
    const source=workflow.tasks[sourceId],target=workflow.tasks[targetId];
    if(!source||source.status!=="passed"||
      source.lastQc?.runId!==runId||source.lastQc.headSha!==sourceSha||
      !target||target.spec.kind!=="implementation"||
      target.attempts!==0||!["ready","blocked"].includes(target.status)||
      !target.spec.dependsOn.some(d=>d.taskId===sourceId))
      throw new Error("Integration source or dependent Task changed during admission");
  }
  private async resolveTarget(projectId:string,workspaceId:string){
    const api=this.opt.workspaces();
    if(!api)throw new Error("PI WEB Workspaces capability unavailable");
    const authority=await api.resolve({projectId,workspaceId});
    const ws=authority.workspace;
    if(authority.project.id!==projectId||ws.id!==workspaceId||
      ws.projectId!==projectId||ws.isMain||
      ws.provider?.metadata?.isGitWorktree!==true)
      throw new Error("Dependent checkout must be an existing linked non-main Git Worktree");
    if(this.opt.agents.hasUnsealedWorkspace(projectId,workspaceId))
      throw new Error("Dependent Worktree has a pending or active Pi Run");
    const head=await requireCleanGit(this.opt.host,ws.path);
    const branch=await gitValue(this.opt.host,ws.path,
      ["symbolic-ref","--quiet","--short","HEAD"]);
    if(!safeBranch(branch))
      throw new Error("Refusing automatic integration into a protected or detached branch");
    return {path:ws.path,head,branch};
  }
  /** Serialize Git mutations from concurrent Workflow ticks in this plugin
   * process; this is not a distributed lock across independent daemon roots. */
  async step(record:AutopilotRecord,workflow:WorkflowInstance):
    Promise<"acted"|"waiting"|"denied"|"none">{
    const preceding=this.operationQueue;
    let release:()=>void=()=>{};
    this.operationQueue=new Promise<void>(resolve=>{release=resolve;});
    try{
      await preceding;
      return await this.stepOne(record,workflow);
    }finally{release();}
  }
  /** One deterministic action per scheduler tick. No Git merge except ff-only. */
  private async stepOne(record:AutopilotRecord,workflow:WorkflowInstance):
    Promise<"acted"|"waiting"|"denied"|"none">{
    const p=record.projectId,o=record.orchestraWorkspaceId,w=record.workflowId;
    for(const source of Object.values(workflow.tasks)){
      if(source.status!=="passed"||source.spec.kind!=="implementation")continue;
      const targets=Object.values(workflow.tasks).filter(task=>
        task.spec.kind==="implementation"&&
        // A final integration Run must deliberately combine independent
        // branch histories and solve conflicts, not be preemptively mutated
        // by the safe-only dependent fast-forward service.
        task.spec.systemPurpose!=="final-integration"&&
        task.spec.dependsOn.some(dep=>dep.taskId===source.spec.id));
      if(!targets.length)continue;
      const binding=this.source(record,workflow,source);
      const qc=source.lastQc!;
      for(const target of targets){
        if(target.attempts!==0||!["ready","blocked"].includes(target.status))
          throw new Error("Dependent Task "+target.spec.id+
            " already started; no automatic Git history rewrite is permitted");
        const workspaceId=record.config.workspaces[target.spec.id];
        const sourceWorkspaceId=record.config.workspaces[source.spec.id];
        if(!workspaceId||workspaceId===sourceWorkspaceId||
          workspaceId===binding.workspaceId)
          throw new Error("Dependent Task requires a separate real Git Worktree");
        this.ensureCurrent(record,source.spec.id,qc.runId,qc.headSha,target.spec.id);
        const checkout=await this.resolveTarget(p,workspaceId);
        const head=checkout.head,branch=checkout.branch;
        const old=this.get(p,o,w,source.spec.id,target.spec.id,qc.runId);
        if(old&&(old.sourceSha!==qc.headSha||
          old.targetWorkspaceId!==workspaceId||old.branch!==branch))
          throw new Error("Dependent Git branch or QC snapshot changed after convergence reservation");
        if(old?.state==="reserved"){
          // The original git merge --ff-only may have succeeded before its
          // result was persisted. Only the *exact* source SHA proves success.
          if(head!==qc.headSha)
            throw new Error("Uncertain Git fast-forward: target HEAD does not match reserved QC SHA; inspect manually");
          this.complete(old);
          return "acted";
        }
        if(old?.state==="completed"){
          await requireAncestor(this.opt.host,checkout.path,qc.headSha,head);
          continue;
        }
        const approval=this.opt.permissions.ensureIntegration(p,o,w,
          source.spec.id,qc.runId,qc.headSha,target.spec.id,workspaceId,head);
        if(approval.decision==="deny")return "denied";
        if(approval.decision==="ask")return "waiting";
        if(head===qc.headSha){
          const row=this.reserve(p,o,w,{workflowId:w,
            sourceTaskId:source.spec.id,targetTaskId:target.spec.id,
            targetWorkspaceId:workspaceId,qcRunId:qc.runId,
            sourceSha:qc.headSha,baselineSha:head,branch});
          this.complete(row);
          return "acted";
        }
        const already=await git(this.opt.host,checkout.path,
          ["merge-base","--is-ancestor",qc.headSha,head]);
        if(already.exitCode===0){
          const row=this.reserve(p,o,w,{workflowId:w,
            sourceTaskId:source.spec.id,targetTaskId:target.spec.id,
            targetWorkspaceId:workspaceId,qcRunId:qc.runId,
            sourceSha:qc.headSha,baselineSha:head,branch});
          this.complete(row);
          return "acted";
        }
        if(already.exitCode!==1)
          throw new Error("Git ancestry check unavailable; refusing to integrate");
        const canFastForward=await git(this.opt.host,checkout.path,
          ["merge-base","--is-ancestor",head,qc.headSha]);
        if(canFastForward.exitCode!==0)
          throw new Error("Dependent branch diverged from QC commit; safe fast-forward unavailable. Review Git integration manually");
        // Revalidate the exact submitted approval and checkout immediately
        // before reserving the non-idempotent Git mutation.
        this.ensureCurrent(record,source.spec.id,qc.runId,qc.headSha,target.spec.id);
        const checked=await this.resolveTarget(p,workspaceId);
        if(checked.head!==head||checked.branch!==branch)
          throw new Error("Dependent Git checkout moved during fast-forward preflight");
        if(this.opt.permissions.ensureIntegration(p,o,w,
          source.spec.id,qc.runId,qc.headSha,target.spec.id,workspaceId,head)
          .decision!=="allow")
          return "waiting";
        const row=this.reserve(p,o,w,{workflowId:w,
          sourceTaskId:source.spec.id,targetTaskId:target.spec.id,
          targetWorkspaceId:workspaceId,qcRunId:qc.runId,
          sourceSha:qc.headSha,baselineSha:head,branch});
        this.opt.host.lifetimeSignal.throwIfAborted();
        const result=await git(this.opt.host,checkout.path,
          ["merge","--ff-only",qc.headSha],60000);
        if(result.exitCode!==0)
          throw new Error("Git fast-forward was not confirmed; reconcile the reserved receipt");
        const after=await requireCleanGit(this.opt.host,checkout.path);
        if(after!==qc.headSha)
          throw new Error("Git fast-forward did not leave the exact QC commit at HEAD");
        this.complete(row);
        return "acted";
      }
      // Re-resolve ALL dependent Worktrees and their current Git ancestry
      // before declaring the upstream Task integrated; an earlier child may
      // have changed while an independent target was being inspected.
      for(const target of targets){
        const workspaceId=record.config.workspaces[target.spec.id];
        if(!workspaceId)throw new Error("Dependent Worktree configuration disappeared");
        this.ensureCurrent(record,source.spec.id,qc.runId,qc.headSha,target.spec.id);
        const latestCheckout=await this.resolveTarget(p,workspaceId);
        await requireAncestor(this.opt.host,latestCheckout.path,qc.headSha,
          latestCheckout.head);
      }
      this.ensureCurrent(record,source.spec.id,qc.runId,qc.headSha,targets[0]!.spec.id);
      const latest=this.opt.workflows.get(p,o,w);
      this.opt.workflows.act(p,o,w,latest.revision,
        internalCommandId("auto:integrate:"+source.spec.id+":"+qc.runId),
        {type:"integrate",taskId:source.spec.id});
      return "acted";
    }
    return "none";
  }
}
