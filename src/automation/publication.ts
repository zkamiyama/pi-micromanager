/** YOLO publication with exact QC SHA, untrusted Pi isolation boundary,
 * durable no-repeat reservations and optional workflow-scoped approvals.
 * Only host-owned argv Git/gh may publish. No merge or branch deletion. */
import {createHash,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import type {PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";
import type {WorkflowStore} from "../core/store.js";
import type {WorkflowInstance} from "../core/workflow.js";
import type {AgentRegistry} from "../runtime/registry.js";
import type {AutopilotLedger,AutopilotRecord,PublicationConfig} from "./ledger.js";
import {automationScope} from "./ledger.js";
import {git,gitValue,requireAncestor,requireCleanGit,type GitHost} from "./git.js";
import type {PermissionLedger} from "./permissions.js";
import type {PermissionAction} from "../core/permissions.js";

type PublicationAction="git.push"|"github.pr.create"|"github.pr.ready"|"github.pr.merge";
export interface PublishedOperation {
  id:string;workflowId:string;taskId:string;action:PublicationAction;
  qcRunId:string;sha:string;branch:string;destination:string;
  state:"reserved"|"scheduled"|"completed";result:string;createdAt:string;updatedAt:string;
}
interface OperationRow extends PublishedOperation {scope:string;fingerprint:string}
interface PublicationOptions {
  path:string;host:GitHost;workflows:WorkflowStore;
  agents:AgentRegistry;ledger:AutopilotLedger;permissions:PermissionLedger;
  workspaces():PiWebHostWorkspacesV1|undefined;
}
const COLS="id,scope,workflow_id AS workflowId,task_id AS taskId,"+
  "action,qc_run_id AS qcRunId,sha,branch,destination,"+
  "fingerprint,state,result,created_at AS createdAt,updated_at AS updatedAt";
function fingerprint(action:PublicationAction,runId:string,sha:string,branch:string,
  destination:string):string{
  return createHash("sha256").update(JSON.stringify(
    [action,runId,sha,branch,destination])).digest("hex");
}
function safeBranch(branch:string):boolean{
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,118}$/.test(branch)&&
    !branch.includes("..")&&!branch.includes("//")&&!branch.includes("@{")&&
    !branch.endsWith(".")&&!branch.endsWith("/")&&!branch.endsWith(".lock");
}
function publicRepo(url:string):string{
  const match=url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if(!match)throw new Error("Only a verified github.com remote is supported for automatic PR creation");
  const name=match[2]!.endsWith(".git")?match[2]!.slice(0,-4):match[2]!;
  if(!name||name==="."||name===".."||match[1]==="."||match[1]==="..")
    throw new Error("Invalid GitHub repository remote");
  return match[1]+"/"+name;
}
interface PrResult {number:number;url:string;headRefName:string;
  baseRefName:string;isDraft:boolean;state:string;headRefOid:string}
interface FinalPrState {
  number:number;url:string;headRefOid:string;baseRefName:string;
  isDraft:boolean;state:string;autoMergeRequest:unknown;
}
export class PublicationManager {
  private readonly db:DatabaseSync;
  constructor(private readonly options:PublicationOptions){
    mkdirSync(dirname(options.path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS publication_operations(
      id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflow_id TEXT NOT NULL,
      task_id TEXT NOT NULL,action TEXT NOT NULL,qc_run_id TEXT NOT NULL,
      sha TEXT NOT NULL,branch TEXT NOT NULL,destination TEXT NOT NULL,
      fingerprint TEXT NOT NULL,state TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope,workflow_id,task_id,action,qc_run_id));`);
  }
  close():void{this.db.close();}
  list(p:string,o:string,w:string):PublishedOperation[]{
    this.options.workflows.get(p,o,w);
    return this.db.prepare("SELECT "+COLS+" FROM publication_operations WHERE scope=?"+
      " AND workflow_id=? ORDER BY created_at DESC LIMIT 100")
      .all(automationScope(p,o),w) as unknown as PublishedOperation[];
  }
  private existing(p:string,o:string,w:string,taskId:string,
    action:PublicationAction,runId:string):OperationRow|undefined{
    return this.db.prepare("SELECT "+COLS+" FROM publication_operations"+
      " WHERE scope=? AND workflow_id=? AND task_id=? AND action=? AND qc_run_id=?")
      .get(automationScope(p,o),w,taskId,action,runId) as OperationRow|undefined;
  }
  private reserve(p:string,o:string,w:string,taskId:string,action:PublicationAction,
    runId:string,sha:string,branch:string,destination:string):OperationRow{
    const mark=fingerprint(action,runId,sha,branch,destination);
    const existing=this.existing(p,o,w,taskId,action,runId);
    if(existing){
      if(existing.fingerprint!==mark)
        throw new Error("Publication target changed after operation reservation; manual reconciliation required");
      return existing;
    }
    const id=randomUUID(),at=new Date().toISOString();
    this.db.prepare(`INSERT INTO publication_operations
      (id,scope,workflow_id,task_id,action,qc_run_id,sha,branch,destination,
      fingerprint,state,result,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'reserved','',?,?)
      ON CONFLICT(scope,workflow_id,task_id,action,qc_run_id) DO NOTHING`)
      .run(id,automationScope(p,o),w,taskId,action,runId,sha,branch,destination,mark,at,at);
    const row=this.existing(p,o,w,taskId,action,runId);
    if(!row||row.fingerprint!==mark)
      throw new Error("Conflicting publication reservation");
    return row;
  }
  private complete(row:OperationRow,result:string):void{
    if(result.length>500)throw new Error("Publication result exceeds 500 characters");
    this.db.prepare("UPDATE publication_operations SET state='completed',result=?,updated_at=?"+
      " WHERE id=? AND state IN ('reserved','scheduled')")
      .run(result,new Date().toISOString(),row.id);
  }
  private scheduled(row:OperationRow,result:string):void{
    if(result.length>500)throw new Error("Publication scheduling receipt exceeds 500 characters");
    this.db.prepare("UPDATE publication_operations SET state='scheduled',result=?,updated_at=?"+
      " WHERE id=? AND state='reserved'")
      .run(result,new Date().toISOString(),row.id);
  }
  private assertAdmitted(record:AutopilotRecord):void{
    this.options.host.lifetimeSignal.throwIfAborted();
    const current=this.options.ledger.get(record.projectId,
      record.orchestraWorkspaceId,record.workflowId);
    if(!current?.enabled||!current.config.publication||
      JSON.stringify(current.config.publication)!==
        JSON.stringify(record.config.publication))
      throw new Error("Autopilot publication is paused or its destination changed");
  }
  private async gh(path:string,args:string[]):Promise<string>{
    const result=await this.options.host.execFile({
      file:"gh",args,cwd:path,timeoutMs:60000,signal:this.options.host.lifetimeSignal,
      unsetEnv:["GH_REPO","GH_HOST","GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE"],
    });
    if(result.signal||result.stdoutTruncated||result.stderrTruncated)
      throw new Error("GitHub CLI response was interrupted/truncated; publication state is uncertain");
    if(result.exitCode!==0)
      throw new Error("GitHub CLI failed: "+result.stderr.slice(-150));
    return result.stdout.trim();
  }
  private async remoteSha(path:string,pub:PublicationConfig,branch:string):Promise<string|undefined>{
    const res=await git(this.options.host,path,
      ["ls-remote","--heads",pub.remote,"refs/heads/"+branch],45000);
    if(res.exitCode!==0)throw new Error("Cannot inspect Git remote branch: "+res.stderr.slice(-170));
    const lines=res.stdout.trim().split("\n").filter(Boolean);
    if(lines.length>1)throw new Error("Ambiguous remote Git branch");
    if(!lines.length)return;
    const parts=lines[0]!.split(/\s+/);
    if(parts.length!==2||parts[1]!=="refs/heads/"+branch||
      !/^[0-9a-f]{40,64}$/.test(parts[0]!))
      throw new Error("Invalid remote Git branch identity");
    return parts[0];
  }
  private async pullRequests(path:string,repo:string,branch:string):Promise<PrResult[]>{
    const response=await this.gh(path,["pr","list","--repo",repo,
      "--state","all","--head",branch,"--json",
      "number,url,headRefName,baseRefName,isDraft,state,headRefOid","--limit","20"]);
    const parsed:unknown=JSON.parse(response);
    if(!Array.isArray(parsed))throw new Error("Unexpected GitHub PR list");
    if(parsed.length>20)throw new Error("Ambiguous remote Pull Requests");
    return parsed.map(v=>{
      if(!v||typeof v!=="object"||Array.isArray(v))
        throw new Error("Malformed GitHub PR result");
      const pr=v as Record<string,unknown>;
      if(!Number.isSafeInteger(pr.number)||typeof pr.url!=="string"||
        typeof pr.headRefName!=="string"||typeof pr.baseRefName!=="string"||
        typeof pr.isDraft!=="boolean"||typeof pr.state!=="string"||
        typeof pr.headRefOid!=="string")
        throw new Error("Untrusted GitHub PR result");
      return pr as unknown as PrResult;
    }).filter(pr=>pr.headRefName===branch);
  }
  private async finalPrState(path:string,repo:string,number:number):Promise<FinalPrState>{
    const raw=await this.gh(path,["pr","view",String(number),"--repo",repo,
      "--json","number,url,headRefOid,baseRefName,isDraft,state,autoMergeRequest"]);
    const p:unknown=JSON.parse(raw);
    if(!p||typeof p!=="object"||Array.isArray(p))throw new Error("Invalid GitHub PR state");
    const row=p as Record<string,unknown>;
    if(row.number!==number||typeof row.url!=="string"||
      typeof row.headRefOid!=="string"||typeof row.baseRefName!=="string"||
      typeof row.isDraft!=="boolean"||typeof row.state!=="string"||
      !Object.hasOwn(row,"autoMergeRequest"))
      throw new Error("Incomplete GitHub PR merge state");
    return row as unknown as FinalPrState;
  }
  /** Poll exact PR CI without relying on GitHub's optional repository
   * "Allow auto-merge" setting. Refuse empty, failing or unknown checks.
   * The PR head is verified again immediately before merge. */
  private async prChecks(path:string,repo:string,number:number):Promise<"pass"|"pending">{
    const result=await this.options.host.execFile({
      file:"gh",args:["pr","checks",String(number),"--repo",repo,
        "--json","name,bucket"],
      cwd:path,timeoutMs:45000,signal:this.options.host.lifetimeSignal,
      unsetEnv:["GH_REPO","GH_HOST","GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE"],
    });
    if(result.signal||result.stdoutTruncated||result.stderrTruncated||
      ![0,1,8].includes(result.exitCode??-1))
      throw new Error("Cannot verify GitHub PR checks; CI state is uncertain");
    let raw:unknown;
    try{raw=JSON.parse(result.stdout);}catch{
      throw new Error("GitHub PR checks did not return valid JSON");
    }
    if(!Array.isArray(raw)||raw.length>200)
      throw new Error("Invalid GitHub PR checks result");
    let passed=0,waiting=false;
    for(const item of raw){
      if(!item||typeof item!=="object"||Array.isArray(item)||
        typeof (item as Record<string,unknown>).name!=="string"||
        typeof (item as Record<string,unknown>).bucket!=="string")
        throw new Error("Malformed GitHub PR check");
      const bucket=(item as {bucket:string}).bucket;
      if(bucket==="fail"||bucket==="cancel")
        throw new Error("GitHub PR checks failed or cancelled; no merge permitted");
      if(bucket==="pass")passed++;
      else if(bucket==="pending")waiting=true;
      else if(bucket!=="skipping")throw new Error("Unknown GitHub PR CI status");
    }
    if(raw.length===0||passed===0||waiting)return "pending";
    return "pass";
  }
  private async completeFinalPR(record:AutopilotRecord,taskId:string,
    qcRunId:string,sha:string,path:string,branch:string,repo:string,
    destination:string):Promise<"acted"|"waiting"|"scheduled"|"checks_pending"|"none">{
    const p=record.projectId,o=record.orchestraWorkspaceId,w=record.workflowId;
    const pub=record.config.publication!;
    if(!record.config.finalization?.autoMerge)return "none";
    const approval=this.options.permissions.ensure(p,o,w,taskId,
      "github.pr.merge",qcRunId,sha,pub);
    if(approval.decision==="deny")return "none";
    if(approval.decision==="ask")return "waiting";
    const prs=await this.pullRequests(path,repo,branch);
    if(prs.length!==1||prs[0]?.headRefOid!==sha||
      prs[0]?.baseRefName!==pub.baseBranch||
      !["OPEN","MERGED"].includes(prs[0]!.state))
      throw new Error("Final PR branch/base/head changed or is missing");
    const number=prs[0]!.number;
    const inspected=await this.finalPrState(path,repo,number);
    if(inspected.headRefOid!==sha||inspected.baseRefName!==pub.baseBranch||
      inspected.url!==prs[0]!.url)
      throw new Error("Final GitHub PR identity changed");
    const ready=this.existing(p,o,w,taskId,"github.pr.ready",qcRunId);
    const merge=this.existing(p,o,w,taskId,"github.pr.merge",qcRunId);
    if(inspected.state==="MERGED"){
      const merged=this.reserve(p,o,w,taskId,"github.pr.merge",
        qcRunId,sha,branch,destination);
      if(merged.state!=="completed")this.complete(merged,inspected.url);
      // Actual GitHub MERGED state, not a scheduled autoMergeRequest,
      // is the only proof that permits the final DAG integration transition.
      const current=this.options.workflows.get(p,o,w);
      const finalTask=current.tasks[taskId];
      if(finalTask?.status==="passed"){
        this.options.workflows.act(p,o,w,current.revision,
          "auto:remote-merge:"+qcRunId,
          {type:"final_merge_confirmed",taskId,headSha:sha,prUrl:inspected.url});
        return "acted";
      }
      if(finalTask?.status!=="integrated")
        throw new Error("Final Workflow Task was changed after GitHub merged");
      return merge?.state==="completed"?"none":"acted";
    }
    if(inspected.state!=="OPEN")
      throw new Error("PR is closed or no longer eligible for automatic merge");
    if(inspected.isDraft){
      if(ready)throw new Error("Uncertain PR ready promotion; inspect GitHub rather than replaying");
      // No ready-to-review transition is allowed until merge policy consent.
      const receipt=this.reserve(p,o,w,taskId,"github.pr.ready",
        qcRunId,sha,branch,destination);
      this.assertAdmitted(record);
      if(this.options.agents.hasUnsealedWorkspace(p,
        record.config.finalization!.workspaceId)||
        await requireCleanGit(this.options.host,path)!==sha||
        await this.remoteSha(path,pub,branch)!==sha)
        throw new Error("Final PR source changed before Ready transition");
      await this.gh(path,["pr","ready",String(number),"--repo",repo]);
      const after=await this.finalPrState(path,repo,number);
      if(after.isDraft||after.headRefOid!==sha||after.baseRefName!==pub.baseBranch)
        throw new Error("GitHub did not prove matching PR is ready");
      this.complete(receipt,after.url);
      return "acted";
    }
    if(!ready){
      const recovered=this.reserve(p,o,w,taskId,"github.pr.ready",
        qcRunId,sha,branch,destination);
      this.complete(recovered,inspected.url);
      return "acted";
    }
    if(ready.state==="reserved"){
      this.complete(ready,inspected.url);
      return "acted";
    }
    if(inspected.autoMergeRequest!==null){
      const receipt=this.reserve(p,o,w,taskId,"github.pr.merge",
        qcRunId,sha,branch,destination);
      if(receipt.state==="reserved")this.scheduled(receipt,inspected.url);
      return "scheduled";
    }
    if(merge)
      throw new Error("Merge response is uncertain: PR is still OPEN without a scheduled request");
    if(await this.prChecks(path,repo,number)!=="pass")
      return "checks_pending";
    // A genuine passing GitHub CI run is mandatory, even if the repository
    // has no required checks or Allow auto-merge is disabled.
    const receipt=this.reserve(p,o,w,taskId,"github.pr.merge",
      qcRunId,sha,branch,destination);
    this.assertAdmitted(record);
    if(this.options.agents.hasUnsealedWorkspace(p,
      record.config.finalization.workspaceId)||
      await requireCleanGit(this.options.host,path)!==sha||
      await this.remoteSha(path,pub,branch)!==sha)
      throw new Error("Final PR source was modified before scheduling merge");
    // Host verifies actual passing PR checks before requesting native GitHub
    // auto-merge, including on repos with no required-status-check rule.
    // --auto may either merge immediately or remain scheduled for required
    // reviewer approvals; only API-confirmed MERGED completes the workflow.
    // --match-head-commit protects against stale source SHA. No --admin/force.
    await this.gh(path,["pr","merge",String(number),"--repo",repo,
      "--auto","--merge","--match-head-commit",sha]);
    const after=await this.finalPrState(path,repo,number);
    if(after.headRefOid!==sha||after.baseRefName!==pub.baseBranch)
      throw new Error("Final PR moved during automatic merge");
    if(after.state==="MERGED"){
      this.complete(receipt,after.url);
      return "acted";
    }
    if(after.state==="OPEN"&&after.autoMergeRequest!==null){
      this.scheduled(receipt,after.url);
      return "scheduled";
    }
    throw new Error("GitHub merge result is uncertain; inspect MERGED before another attempt");
  }
  /** At most one external side effect per tick, after all QC/permission gates. */
  async step(record:AutopilotRecord,workflow:WorkflowInstance):Promise<"acted"|"waiting"|"scheduled"|"checks_pending"|"none">{
    const pub=record.config.publication;
    if(!pub)return "none"; // historical configs do not unexpectedly start network actions
    this.assertAdmitted(record);
    const p=record.projectId,o=record.orchestraWorkspaceId,w=record.workflowId;
    for(const task of Object.values(workflow.tasks)){
      if(record.config.finalization&&
        task.spec.systemPurpose!=="final-integration")continue;
      if(task.spec.kind!=="implementation"||
        !["passed","integrated"].includes(task.status)||task.lastQc?.verdict!=="pass")continue;
      const qc=task.lastQc,session=this.options.agents.getRun(p,o,w,qc.runId);
      if(!session||session.taskId!==task.spec.id||session.phase!=="sealed"||
        session.seat!=="qc"||!session.evidenceRef||!session.sessionId||
        !session.requestId.startsWith("auto:"))
        throw new Error("Cannot publish without sealed automatic QC evidence");
      const evidence=this.options.ledger.evidence(session);
      if(!evidence||evidence.ref!==session.evidenceRef||evidence.sessionId!==session.sessionId)
        throw new Error("QC evidence mismatch at publication");
      const workspaceId=task.spec.systemPurpose==="final-integration"?
        record.config.finalization?.workspaceId:record.config.workspaces[task.spec.id];
      if(!workspaceId)throw new Error("Missing implementation workspace for publication");
      if(this.options.agents.hasUnsealedWorkspace(p,workspaceId))
        throw new Error("Implementation workspace is still leased by an active Run");
      const api=this.options.workspaces();
      if(!api)throw new Error("PI WEB Workspaces capability is unavailable");
      const authority=await api.resolve({projectId:p,workspaceId});
      const target=authority.workspace;
      if(authority.project.id!==p||target.projectId!==p||target.id!==workspaceId||
        target.isMain||target.provider?.metadata?.isGitWorktree!==true)
        throw new Error("Publication Workspace authority changed");
      const sha=await requireCleanGit(this.options.host,target.path);
      if(sha!==qc.headSha)throw new Error("Publication source Git HEAD differs from QC-pass commit");
      if(task.spec.systemPurpose==="final-integration"){
        for(const source of Object.values(workflow.tasks)){
          if(source.spec.kind!=="implementation"||
            source.spec.systemPurpose==="final-integration")continue;
          if(!["passed","integrated"].includes(source.status)||
            source.lastQc?.verdict!=="pass")
            throw new Error("Final publish source Task has no QC PASS");
          await requireAncestor(this.options.host,target.path,
            source.lastQc.headSha,sha);
        }
      }
      const branch=await gitValue(this.options.host,target.path,
        ["symbolic-ref","--quiet","--short","HEAD"]);
      if(!safeBranch(branch)||branch===pub.baseBranch||
        /^(main|master|develop|production|stable|release)(\/|$)/i.test(branch))
        throw new Error("Refusing to publish to a protected or invalid Git branch");
      const url=await gitValue(this.options.host,target.path,["remote","get-url",pub.remote]);
      const repo=publicRepo(url);
      const dest=repo+" "+pub.remote+" "+pub.baseBranch;
      if(this.options.agents.hasUnsealedWorkspace(p,workspaceId))
        throw new Error("Worker lease changed during Git publication preflight");
      const donePush=this.existing(p,o,w,task.spec.id,"git.push",qc.runId);
      if(donePush&&donePush.fingerprint!==fingerprint("git.push",
        qc.runId,sha,branch,dest))
        throw new Error("Git publication destination changed after reservation");
      if(!donePush||donePush.state!=="completed"){
        const approval=this.options.permissions.ensure(p,o,w,task.spec.id,
          "git.push",qc.runId,qc.headSha,pub);
        if(approval.decision==="deny")continue;
        if(approval.decision==="ask")return "waiting";
        const remote=await this.remoteSha(target.path,pub,branch);
        if(remote&&remote!==sha)
          throw new Error("Remote branch has a different commit; never force push");
        if(remote===sha){
          const receipt=this.reserve(p,o,w,task.spec.id,"git.push",
            qc.runId,sha,branch,dest);
          if(receipt.state!=="completed")
            this.complete(receipt,"Remote matches QC commit "+sha);
          return "acted";
        }
        if(donePush)
          throw new Error("Reserved Git push is uncertain; remote does not contain expected QC SHA");
        const receipt=this.reserve(p,o,w,task.spec.id,"git.push",qc.runId,sha,branch,dest);
        if(receipt.state==="reserved"){
          this.assertAdmitted(record);
          if(this.options.agents.hasUnsealedWorkspace(p,workspaceId)||
            await requireCleanGit(this.options.host,target.path)!==sha)
            throw new Error("Publication Git checkout changed immediately before push");
          const pushed=await git(this.options.host,target.path,
            ["push","--porcelain",pub.remote,"HEAD:refs/heads/"+branch],120000);
          if(pushed.exitCode!==0)
            throw new Error("Git push not confirmed; inspect remote before any retry");
          const confirmed=await this.remoteSha(target.path,pub,branch);
          if(confirmed!==sha)throw new Error("Git remote did not confirm QC SHA after push");
          this.complete(receipt,"Remote HEAD="+sha);
        }
        return "acted";
      }
      const approval=this.options.permissions.ensure(p,o,w,task.spec.id,
        "github.pr.create",qc.runId,qc.headSha,pub);
      if(approval.decision==="deny")continue;
      if(approval.decision==="ask")return "waiting";
      const previous=this.existing(p,o,w,task.spec.id,"github.pr.create",qc.runId);
      if(previous&&previous.fingerprint!==fingerprint("github.pr.create",
        qc.runId,sha,branch,dest))
        throw new Error("GitHub PR target changed after reservation");
      if(previous?.state==="completed"){
        if(task.spec.systemPurpose==="final-integration"&&
          record.config.finalization?.autoMerge)
          return this.completeFinalPR(record,task.spec.id,qc.runId,sha,
            target.path,branch,repo,dest);
        continue;
      }
      // An existing identical Draft PR is proof even if the previous gh call
      // returned uncertain. A missing PR after reservation needs a human.
      const prList=await this.pullRequests(target.path,repo,branch);
      const match=prList.find(pr=>pr.state==="OPEN"&&pr.baseRefName===pub.baseBranch&&
        pr.headRefOid===sha);
      if(prList.length&&(!match||prList.length!==1))
        throw new Error("A different or closed PR already uses the source branch");
      if(match){
        const receipt=this.reserve(p,o,w,task.spec.id,"github.pr.create",
          qc.runId,sha,branch,dest);
        this.complete(receipt,match.url);
        return "acted";
      }
      const receipt=this.reserve(p,o,w,task.spec.id,"github.pr.create",
        qc.runId,sha,branch,dest);
      if(previous)throw new Error("Reserved PR creation is uncertain; inspect GitHub before retry");
      this.assertAdmitted(record);
      if(this.options.agents.hasUnsealedWorkspace(p,workspaceId)||
        await requireCleanGit(this.options.host,target.path)!==sha||
        await this.remoteSha(target.path,pub,branch)!==sha)
        throw new Error("Publication source/remote changed before Draft PR creation");
      const title=(task.spec.title||task.spec.id).slice(0,180);
      const body="Autonomous Draft PR for Workflow "+w+", Task "+task.spec.id+
        ".\nQC Run "+qc.runId+" PASS at "+sha+".\nEvidence: "+evidence.ref+
        ".\nHuman review and merge policy remain authoritative.";
      await this.gh(target.path,["pr","create","--repo",repo,
        "--head",branch,"--base",pub.baseBranch,"--draft",
        "--title",title,"--body",body]);
      const checked=await this.pullRequests(target.path,repo,branch);
      const created=checked.find(pr=>pr.state==="OPEN"&&pr.baseRefName===pub.baseBranch&&
        pr.headRefOid===sha&&pr.isDraft);
      if(!created)throw new Error("GitHub did not confirm matching Draft PR after creation");
      this.complete(receipt,created.url);
      return "acted";
    }
    return "none";
  }
}
