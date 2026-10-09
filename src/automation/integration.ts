/** Human-confirmed Git integration verification. Only observes Git; never merges, pushes or checks out. */
import {randomUUID} from "node:crypto";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";
import type {WorkflowStore} from "../core/store.js";
import type {AgentRegistry,AgentBinding} from "../runtime/registry.js";
import type {AutopilotLedger} from "./ledger.js";
import {automationScope} from "./ledger.js";
import {gitSha,requireCleanGit,requireAncestor,type GitHost} from "./git.js";

export interface IntegrationPreview {
  id:string;workflowId:string;taskId:string;targetWorkspaceId:string;
  sourceSha:string;targetHead:string;qcRunId:string;revision:number;
  evidenceRef:string;expiresAt:number;state:"prepared"|"confirmed";
}
interface IntegrationRow extends IntegrationPreview {scope:string}
interface IntegrationOptions {
  path:string;host:GitHost;workflows:WorkflowStore;agents:AgentRegistry;
  ledger:AutopilotLedger;workspaces():PiWebHostWorkspacesV1|undefined;
}
const PREVIEW_TTL=10*60*1000;
const ROWS="id,scope,workflow_id AS workflowId,task_id AS taskId,"+
  "target_workspace_id AS targetWorkspaceId,source_sha AS sourceSha,"+
  "target_head AS targetHead,qc_run_id AS qcRunId,revision,evidence_ref AS evidenceRef,"+
  "expires_at AS expiresAt,state";

export class IntegrationVerifier {
  private readonly db:DatabaseSync;
  constructor(private readonly options:IntegrationOptions){
    mkdirSync(dirname(options.path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS integration_previews(
      id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflow_id TEXT NOT NULL,
      task_id TEXT NOT NULL,target_workspace_id TEXT NOT NULL,
      source_sha TEXT NOT NULL,target_head TEXT NOT NULL,qc_run_id TEXT NOT NULL,
      revision INTEGER NOT NULL,evidence_ref TEXT NOT NULL,
      expires_at INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS integration_previews_scope
      ON integration_previews(scope,workflow_id,expires_at);`);
  }
  close():void{this.db.close();}
  private get(id:string):IntegrationRow{
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error("Invalid integration preview ID");
    const row=this.db.prepare("SELECT "+ROWS+" FROM integration_previews WHERE id=?")
      .get(id) as IntegrationRow|undefined;
    if(!row)throw new Error("Integration preview not found");
    return row;
  }
  private source(projectId:string,orchestraWorkspaceId:string,workflowId:string,taskId:string){
    const workflow=this.options.workflows.get(projectId,orchestraWorkspaceId,workflowId);
    const task=workflow.tasks[taskId];
    if(!task||task.spec.kind!=="implementation"||task.status!=="passed"||!task.lastQc||
      task.lastQc.verdict!=="pass"||!gitSha(task.lastQc.headSha))
      throw new Error("Task requires a real passing QC verdict before Git integration");
    const qc=this.options.agents.getRun(projectId,orchestraWorkspaceId,workflowId,task.lastQc.runId);
    if(!qc||qc.taskId!==taskId||qc.seat!=="qc"||qc.phase!=="sealed"||
      !qc.requestId.startsWith("auto:")||!qc.sessionId||!qc.evidenceRef)
      throw new Error("QC Run is not durably sealed with verified evidence");
    const evidence=this.options.ledger.evidence(qc);
    if(!evidence||evidence.ref!==qc.evidenceRef||evidence.sessionId!==qc.sessionId)
      throw new Error("QC evidence does not match sealed Session");
    return {workflow,task,qc,evidence};
  }
  private async checkTarget(projectId:string,orchestraWorkspaceId:string,
    workflowId:string,taskId:string,targetWorkspaceId:string,source:AgentBinding,
    sourceSha:string,expectedHead?:string):Promise<string>{
    if(!targetWorkspaceId||targetWorkspaceId.length>512)throw new Error("Missing target Workspace ID");
    const implementerWorkspace=this.options.ledger.get(projectId,orchestraWorkspaceId,
      workflowId)?.config.workspaces[taskId];
    if(source.workspaceId===targetWorkspaceId||implementerWorkspace===targetWorkspaceId)
      throw new Error("Source implementation/QC Worktree is not proof of integration into another Workspace");
    const provider=this.options.workspaces();
    if(!provider)throw new Error("Public PI WEB Workspaces capability is not ready");
    const authority=await provider.resolve({projectId,workspaceId:targetWorkspaceId});
    const target=authority.workspace;
    if(authority.project.id!==projectId||target.id!==targetWorkspaceId||
      target.projectId!==projectId)
      throw new Error("Integration target no longer belongs to this project");
    // The target must be an actual Git Worktree, but can be main (read-only
    // validation of an integration performed by the operator outside MAMC).
    if(target.provider?.metadata?.isGitWorktree!==true)
      throw new Error("Target must be an existing PI WEB Git workspace");
    if(this.options.agents.hasUnsealedWorkspace(projectId,targetWorkspaceId))
      throw new Error("Target has an active or unsealed Pi Run");
    const head=await requireCleanGit(this.options.host,target.path);
    if(expectedHead&&head!==expectedHead)
      throw new Error("Target Worktree HEAD moved since the preview; request a new preview");
    await requireAncestor(this.options.host,target.path,sourceSha,head);
    return head;
  }
  async preview(projectId:string,orchestraWorkspaceId:string,
    workflowId:string,taskId:string,targetWorkspaceId:string):Promise<IntegrationPreview>{
    const {workflow,qc,evidence}=this.source(projectId,orchestraWorkspaceId,workflowId,taskId);
    const targetHead=await this.checkTarget(projectId,orchestraWorkspaceId,
      workflowId,taskId,targetWorkspaceId,qc,workflow.tasks[taskId]!.lastQc!.headSha);
    this.options.host.lifetimeSignal.throwIfAborted();
    const result:IntegrationPreview={
      id:randomUUID(),workflowId,taskId,targetWorkspaceId,
      sourceSha:workflow.tasks[taskId]!.lastQc!.headSha,targetHead,
      qcRunId:qc.runId,revision:workflow.revision,evidenceRef:evidence.ref,
      expiresAt:Date.now()+PREVIEW_TTL,state:"prepared",
    };
    this.db.prepare(`INSERT INTO integration_previews(
      id,scope,workflow_id,task_id,target_workspace_id,source_sha,
      target_head,qc_run_id,revision,evidence_ref,expires_at,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(result.id,
      automationScope(projectId,orchestraWorkspaceId),workflowId,taskId,
      targetWorkspaceId,result.sourceSha,result.targetHead,result.qcRunId,
      result.revision,result.evidenceRef,result.expiresAt,result.state);
    // No Git state was modified. The operator must confirm this exact proof.
    return result;
  }
  async confirm(projectId:string,orchestraWorkspaceId:string,id:string){
    const row=this.get(id);
    if(row.scope!==automationScope(projectId,orchestraWorkspaceId))
      throw new Error("Integration preview belongs to a different Orchestra");
    const commandId="integration:"+id;
    // Crash-safe cross-database finish: the authoritative CAS may have
    // committed before the preview receipt was marked confirmed.
    if(this.options.workflows.wasApplied(projectId,orchestraWorkspaceId,
      row.workflowId,commandId)){
      this.db.prepare("UPDATE integration_previews SET state='confirmed' WHERE id=?").run(id);
      return this.options.workflows.get(projectId,orchestraWorkspaceId,row.workflowId);
    }
    if(row.state==="confirmed"){
      if(!this.options.workflows.wasApplied(projectId,orchestraWorkspaceId,
        row.workflowId,commandId))throw new Error("Integration receipt is inconsistent");
      return this.options.workflows.get(projectId,orchestraWorkspaceId,row.workflowId);
    }
    if(this.options.ledger.get(projectId,orchestraWorkspaceId,row.workflowId)?.enabled)
      throw new Error("Pause Autopilot before confirming Git integration");
    if(Date.now()>row.expiresAt)throw new Error("Integration preview expired; request a new preview");
    const {workflow,qc,evidence}=this.source(projectId,orchestraWorkspaceId,
      row.workflowId,row.taskId);
    if(workflow.revision!==row.revision||qc.runId!==row.qcRunId||
      evidence.ref!==row.evidenceRef||workflow.tasks[row.taskId]!.lastQc!.headSha!==row.sourceSha)
      throw new Error("Workflow/QC evidence changed since integration preview");
    // The caller explicitly asserts that external Git integration is complete.
    // Recheck the same clean target SHA before advancing the DAG. This endpoint
    // is strictly observational; it does not run merge/cherry-pick/reset/push.
    await this.checkTarget(projectId,orchestraWorkspaceId,row.workflowId,
      row.taskId,row.targetWorkspaceId,qc,row.sourceSha,row.targetHead);
    this.options.host.lifetimeSignal.throwIfAborted();
    const next=this.options.workflows.act(projectId,orchestraWorkspaceId,row.workflowId,
      row.revision,commandId,{type:"integrate",taskId:row.taskId});
    this.db.prepare("UPDATE integration_previews SET state='confirmed' WHERE id=?").run(id);
    return next;
  }
}
