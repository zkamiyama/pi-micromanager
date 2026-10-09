/** Durable, exact-subject approvals for autonomous publication.
 * These records authorize one QC commit+destination, never arbitrary shell access. */
import {randomUUID,createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import type {WorkflowStore} from "../core/store.js";
import {permissionDecision,type PermissionAction} from "../core/permissions.js";
import type {AutopilotLedger,PublicationConfig} from "./ledger.js";
import {automationScope} from "./ledger.js";

export type ApprovalState="pending"|"approved"|"rejected";
export interface ApprovalRequest {
  id:string;workflowId:string;taskId:string;
  action:PermissionAction;runId:string;headSha:string;
  target:string;state:ApprovalState;createdAt:string;updatedAt:string;
}
export interface PermissionOutcome {
  decision:"allow"|"ask"|"deny";approval?:ApprovalRequest;
}
interface ApprovalRow extends ApprovalRequest {scope:string;fingerprint:string}
const ROWS="id,scope,workflow_id AS workflowId,task_id AS taskId,"+
  "action,run_id AS runId,head_sha AS headSha,target,state,fingerprint,"+
  "created_at AS createdAt,updated_at AS updatedAt";
const supported=new Set<PermissionAction>(["git.push","github.pr.create"]);
function commitSubject(taskId:string,runId:string,revision:number,workspaceId:string):string{
  return createHash("sha256").update(JSON.stringify([
    "git.commit",taskId,runId,revision,workspaceId])).digest("hex");
}
function subject(action:PermissionAction,taskId:string,runId:string,
  sha:string,pub:PublicationConfig):string{
  return createHash("sha256").update(JSON.stringify([
    action,taskId,runId,sha,pub.remote,pub.baseBranch,pub.draft])).digest("hex");
}
export class PermissionLedger {
  private readonly db:DatabaseSync;
  constructor(private readonly path:string,private readonly workflows:WorkflowStore,
    private readonly settings:AutopilotLedger){
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workflow_approvals(
        id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflow_id TEXT NOT NULL,
        task_id TEXT NOT NULL,action TEXT NOT NULL,run_id TEXT NOT NULL,
        head_sha TEXT NOT NULL,target TEXT NOT NULL,fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        UNIQUE(scope,workflow_id,task_id,action,fingerprint));`);
  }
  close():void{this.db.close();}
  list(p:string,o:string,workflowId:string):ApprovalRequest[]{
    this.workflows.get(p,o,workflowId);
    return this.db.prepare("SELECT "+ROWS+" FROM workflow_approvals"+
      " WHERE scope=? AND workflow_id=? ORDER BY created_at DESC LIMIT 100")
      .all(automationScope(p,o),workflowId) as unknown as ApprovalRequest[];
  }
  /** The commit permission is admitted before a fresh implementation attempt,
   * not after code has already been changed. A newer Workflow revision
   * invalidates the approval and requires an exact new decision. */
  ensureCommit(p:string,o:string,workflowId:string,taskId:string,
    nextAttempt:number,workspaceId:string):PermissionOutcome{
    const workflow=this.workflows.get(p,o,workflowId),task=workflow.tasks[taskId];
    if(!task||task.spec.kind!=="implementation"||task.status!=="ready"||
      nextAttempt!==task.attempts+1||
      this.settings.get(p,o,workflowId)?.config.workspaces[taskId]!==workspaceId)
      throw new Error("Git commit approval must reference a ready implementation attempt");
    const decision=permissionDecision(workflow.definition.permissions,"git.commit");
    if(decision!=="ask")return {decision};
    const scope=automationScope(p,o),runId="impl-"+taskId+"-"+nextAttempt;
    const mark=commitSubject(taskId,runId,workflow.revision,workspaceId);
    const current=this.db.prepare("SELECT "+ROWS+" FROM workflow_approvals"+
      " WHERE scope=? AND workflow_id=? AND task_id=? AND action='git.commit'"+
      " AND fingerprint=?").get(scope,workflowId,taskId,mark) as ApprovalRow|undefined;
    if(current)return {decision:current.state==="approved"?"allow":
      current.state==="rejected"?"deny":"ask",approval:current};
    const id=randomUUID(),at=new Date().toISOString();
    this.db.prepare(`INSERT INTO workflow_approvals(
      id,scope,workflow_id,task_id,action,run_id,head_sha,target,
      fingerprint,state,created_at,updated_at)
      VALUES(?,?,? ,?,'git.commit',?,'pre-commit',?,?,'pending',?,?)
      ON CONFLICT(scope,workflow_id,task_id,action,fingerprint) DO NOTHING`)
      .run(id,scope,workflowId,taskId,runId,workspaceId,mark,at,at);
    const row=this.db.prepare("SELECT "+ROWS+" FROM workflow_approvals"+
      " WHERE scope=? AND workflow_id=? AND task_id=? AND action='git.commit'"+
      " AND fingerprint=?").get(scope,workflowId,taskId,mark) as unknown as ApprovalRow;
    return {decision:row.state==="approved"?"allow":
      row.state==="rejected"?"deny":"ask",approval:row};
  }
  ensure(p:string,o:string,workflowId:string,taskId:string,
    action:PermissionAction,runId:string,headSha:string,
    publication:PublicationConfig):PermissionOutcome{
    if(!supported.has(action))throw new Error("Unsupported autonomously gated operation");
    const workflow=this.workflows.get(p,o,workflowId);
    const task=workflow.tasks[taskId];
    if(!task||task.spec.kind!=="implementation"||
      !["passed","integrated"].includes(task.status)||
      task.lastQc?.verdict!=="pass"||task.lastQc.runId!==runId||
      task.lastQc.headSha!==headSha)
      throw new Error("Approval subject must be the currently QC-passed Task commit");
    const decision=permissionDecision(workflow.definition.permissions,action);
    if(decision!=="ask")return {decision};
    const scope=automationScope(p,o),fingerprint=subject(action,taskId,runId,headSha,publication);
    const existing=this.db.prepare("SELECT "+ROWS+" FROM workflow_approvals"+
      " WHERE scope=? AND workflow_id=? AND task_id=? AND action=? AND fingerprint=?")
      .get(scope,workflowId,taskId,action,fingerprint) as ApprovalRow|undefined;
    if(existing)return {decision:existing.state==="approved"?"allow":
      existing.state==="rejected"?"deny":"ask",approval:existing};
    const id=randomUUID(),at=new Date().toISOString();
    const target=publication.remote+":"+publication.baseBranch;
    this.db.prepare(`INSERT INTO workflow_approvals(
      id,scope,workflow_id,task_id,action,run_id,head_sha,target,
      fingerprint,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)
      ON CONFLICT(scope,workflow_id,task_id,action,fingerprint) DO NOTHING`)
      .run(id,scope,workflowId,taskId,action,runId,headSha,target,fingerprint,at,at);
    const row=this.db.prepare("SELECT "+ROWS+" FROM workflow_approvals"+
      " WHERE scope=? AND workflow_id=? AND task_id=? AND action=? AND fingerprint=?")
      .get(scope,workflowId,taskId,action,fingerprint) as unknown as ApprovalRow;
    return {decision:row.state==="approved"?"allow":
      row.state==="rejected"?"deny":"ask",approval:row};
  }
  decide(p:string,o:string,id:string,decision:"approved"|"rejected"):ApprovalRequest{
    if(!/^[0-9a-f-]{36}$/.test(id))throw new Error("Invalid approval identifier");
    if(decision!=="approved"&&decision!=="rejected")throw new Error("Invalid approval decision");
    const row=this.db.prepare("SELECT "+ROWS+" FROM workflow_approvals"+
      " WHERE id=? AND scope=?").get(id,automationScope(p,o)) as ApprovalRow|undefined;
    if(!row)throw new Error("Approval does not belong to this Orchestra");
    const config=this.settings.get(p,o,row.workflowId)?.config;
    if(!config)throw new Error("Workflow is no longer configured");
    const workflow=this.workflows.get(p,o,row.workflowId),task=workflow.tasks[row.taskId];
    if(row.action==="git.commit"){
      if(!task||task.spec.kind!=="implementation"||task.status!=="ready"||
        row.runId!=="impl-"+row.taskId+"-"+(task.attempts+1)||
        config.workspaces[row.taskId]!==row.target||row.headSha!=="pre-commit"||
        commitSubject(row.taskId,row.runId,workflow.revision,row.target)!==row.fingerprint)
        throw new Error("Commit approval no longer matches the ready Task/revision/workspace");
    }else {
      const pub=config.publication;
      if(!pub||!task||!["passed","integrated"].includes(task.status)||
        task.lastQc?.runId!==row.runId||task.lastQc.headSha!==row.headSha||
        subject(row.action,row.taskId,row.runId,row.headSha,pub)!==row.fingerprint)
        throw new Error("Approval no longer matches the exact Workflow QC commit and publication target");
    }
    if(permissionDecision(workflow.definition.permissions,row.action)!=="ask")
      throw new Error("Workflow no longer requires this authorization");
    if(row.state!=="pending"){
      if(row.state!==decision)throw new Error("An approval decision cannot be changed");
      return row;
    }
    const updated=this.db.prepare("UPDATE workflow_approvals SET state=?,updated_at=?"+
      " WHERE id=? AND scope=? AND state='pending'")
      .run(decision,new Date().toISOString(),id,automationScope(p,o));
    if(updated.changes!==1)throw new Error("Approval changed concurrently");
    return {...row,state:decision,updatedAt:new Date().toISOString()};
  }
}
