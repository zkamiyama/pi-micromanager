/** Durable natural-language goal → validated DAG → opt-in Autopilot admission.
 * Settings are selected by the human once; Sol cannot change permissions.
 * A request is reserved BEFORE any hosted Pi Session or Git mutation. */
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {parseAutopilotConfig,type AutopilotConfig,automationScope} from "./ledger.js";
import {validatePermissions,type WorkflowPermissions} from "../core/permissions.js";

export type QuickPhase="reserved"|"planning"|"starting"|"running"|"finished"|"needs_attention"|"cancelled";
export interface QuickProfile {config:AutopilotConfig;permissions:WorkflowPermissions}
export interface QuickGoal {
  requestId:string;projectId:string;orchestraWorkspaceId:string;
  workflowId:string;draftWorkflowId:string;runId:string;
  goal:string;profile:QuickProfile;phase:QuickPhase;
  message:string;createdAt:string;updatedAt:string;
}
interface QuickRow {
  scope:string;request_id:string;workflow_id:string;draft_workflow_id:string;
  run_id:string;goal:string;profile_json:string;phase:QuickPhase;
  message:string;created_at:string;updated_at:string;
}
const COLS="scope,request_id,workflow_id,draft_workflow_id,run_id,goal,profile_json,phase,message,created_at,updated_at";
const REQUEST_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function cleanGoal(goal:unknown):string{
  if(typeof goal!=="string"||!goal.trim()||goal.length>4000||goal.includes("\0"))
    throw new Error("Enter a development goal of 1–4000 characters");
  return goal.trim();
}
export function parseQuickProfile(value:unknown):QuickProfile{
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw new Error("One-command setup must be a configuration object");
  const raw=value as Record<string,unknown>;
  if(Object.keys(raw).some(k=>k!=="config"&&k!=="permissions"))
    throw new Error("Unknown one-command setup field");
  const config=parseAutopilotConfig(raw.config);
  if(!config.managedWorktrees||Object.keys(config.workspaces).length>0||
    config.reviewWorkspaces!==undefined)
    throw new Error("One-command mode requires managedWorktrees and empty workspaces; it never reuses Task/QC checkouts");
  if(!config.finalization||config.finalization.workspaceId!=="auto"||
    !config.publication)
    throw new Error("One-command mode requires explicit finalization:auto and a reviewed publication destination");
  validatePermissions(raw.permissions);
  if(raw.permissions===undefined)
    throw new Error("One-command setup must include an explicit Workflow permissions policy");
  const permissions=raw.permissions;
  // Force each external action to be governed by the operator's saved policy,
  // rather than blindly accepting a permission map proposed by Sol.
  return {config,permissions};
}
function rowToGoal(row:QuickRow):QuickGoal{
  const [projectId,orchestraWorkspaceId]=JSON.parse(row.scope) as [string,string];
  return {requestId:row.request_id,projectId,orchestraWorkspaceId,
    workflowId:row.workflow_id,draftWorkflowId:row.draft_workflow_id,
    runId:row.run_id,goal:row.goal,
    profile:parseQuickProfile(JSON.parse(row.profile_json)),
    phase:row.phase,message:row.message,createdAt:row.created_at,updatedAt:row.updated_at};
}
export class QuickLaunchLedger{
  private readonly db:DatabaseSync;
  constructor(file:string){
    mkdirSync(dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS quick_profiles(
        scope TEXT PRIMARY KEY,profile_json TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quick_goals(
        scope TEXT NOT NULL,request_id TEXT NOT NULL,workflow_id TEXT NOT NULL,
        draft_workflow_id TEXT NOT NULL,run_id TEXT NOT NULL,
        goal TEXT NOT NULL,profile_json TEXT NOT NULL,
        phase TEXT NOT NULL,message TEXT NOT NULL,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(scope,request_id),UNIQUE(scope,workflow_id));
      CREATE INDEX IF NOT EXISTS quick_goals_recent ON
        quick_goals(scope,created_at DESC); `);
  }
  close():void{this.db.close();}
  profile(p:string,o:string):QuickProfile|null{
    const row=this.db.prepare("SELECT profile_json FROM quick_profiles WHERE scope=?")
      .get(automationScope(p,o)) as {profile_json:string}|undefined;
    return row?parseQuickProfile(JSON.parse(row.profile_json)):null;
  }
  saveProfile(p:string,o:string,input:unknown):QuickProfile{
    const profile=parseQuickProfile(input),scope=automationScope(p,o);
    const at=new Date().toISOString();
    this.db.prepare(`INSERT INTO quick_profiles(scope,profile_json,updated_at)
      VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET
      profile_json=excluded.profile_json,updated_at=excluded.updated_at`)
      .run(scope,JSON.stringify(profile),at);
    return profile;
  }
  list(p:string,o:string):QuickGoal[]{
    const rows=this.db.prepare("SELECT "+COLS+
      " FROM quick_goals WHERE scope=? ORDER BY created_at DESC LIMIT 12")
      .all(automationScope(p,o)) as unknown as QuickRow[];
    return rows.map(rowToGoal);
  }
  /** Snapshot the reviewed profile BEFORE any new model/Git side effects. */
  begin(p:string,o:string,goalValue:unknown,requestId:string):QuickGoal{
    const goal=cleanGoal(goalValue);
    if(!REQUEST_ID.test(requestId))throw new Error("A cryptographically unique requestId is required");
    const scope=automationScope(p,o),profile=this.profile(p,o);
    if(!profile)throw new Error("Save a one-command project setup before starting");
    const old=this.db.prepare("SELECT "+COLS+
      " FROM quick_goals WHERE scope=? AND request_id=?")
      .get(scope,requestId) as QuickRow|undefined;
    if(old){
      if(old.goal!==goal)throw new Error("Request ID reused with a different goal");
      return rowToGoal(old);
    }
    const active=this.db.prepare("SELECT workflow_id FROM quick_goals WHERE scope=?"+
      " AND phase IN ('reserved','planning','starting','running') LIMIT 1")
      .get(scope) as {workflow_id:string}|undefined;
    if(active)throw new Error("A one-command run is already active; finish or pause it before starting another");
    const token=createHash("sha256").update(scope+"|"+requestId).digest("hex").slice(0,16);
    const workflowId="quick-"+token,draftId="draft-"+token,runId="goal-"+token;
    const at=new Date().toISOString();
    this.db.prepare(`INSERT INTO quick_goals(scope,request_id,workflow_id,
      draft_workflow_id,run_id,goal,profile_json,phase,message,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'reserved','Queued for read-only Sol planning',?,?)`)
      .run(scope,requestId,workflowId,draftId,runId,goal,JSON.stringify(profile),at,at);
    return this.find(p,o,requestId)!;
  }
  find(p:string,o:string,requestId:string):QuickGoal|null{
    const row=this.db.prepare("SELECT "+COLS+
      " FROM quick_goals WHERE scope=? AND request_id=?")
      .get(automationScope(p,o),requestId) as QuickRow|undefined;
    return row?rowToGoal(row):null;
  }
  pending():QuickGoal[]{
    const rows=this.db.prepare("SELECT "+COLS+" FROM quick_goals WHERE"+
      " phase IN ('reserved','planning','starting','running')"+
      " ORDER BY created_at ASC LIMIT 100").all() as unknown as QuickRow[];
    return rows.map(rowToGoal);
  }
  phase(p:string,o:string,requestId:string,phase:QuickPhase,message:string):QuickGoal{
    if(!message.trim()||message.length>700)throw new Error("Bounded one-command progress required");
    const scope=automationScope(p,o);
    const row=this.db.prepare("SELECT phase FROM quick_goals WHERE scope=? AND request_id=?")
      .get(scope,requestId) as {phase:QuickPhase}|undefined;
    if(!row)throw new Error("Unknown one-command request");
    if(row.phase==="cancelled"&&phase!=="cancelled")
      throw new Error("Cancelled one-command request cannot restart");
    if(["finished","needs_attention"].includes(row.phase)&&phase!==row.phase)
      throw new Error("Terminal one-command request cannot restart");
    this.db.prepare("UPDATE quick_goals SET phase=?,message=?,updated_at=?"+
      " WHERE scope=? AND request_id=?")
      .run(phase,message,new Date().toISOString(),scope,requestId);
    return this.find(p,o,requestId)!;
  }
  cancel(p:string,o:string,requestId:string):QuickGoal{
    const row=this.find(p,o,requestId);
    if(!row)throw new Error("Unknown one-command request");
    if(row.phase!=="reserved"&&row.phase!=="planning")
      throw new Error("The code run has begun or this request is already terminal; use Pause admission for active Autopilot");
    return this.phase(p,o,requestId,"cancelled",
      "Auto-start cancelled. A running read-only Sol proposal may still settle, but will not start code.");
  }
}
