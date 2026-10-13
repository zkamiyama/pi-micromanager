/** Per-execution Pi sessions. A role is NOT a permanent seat or reusable agent identity. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeActivity } from "./protocol.js";

export type Seat = "planner" | "implementer" | "qc" | "architect";
export type BindingPhase =
  | "reserved" | "created" | "connected" | "configured" | "running"
  | "settled" | "sealed" | "failed" | "blocked" | "uncertain";

export interface AgentBinding {
  projectId: string;
  /** Workspace owning the authoritative Workflow Instance; not necessarily this Pi session's worktree. */
  orchestraWorkspaceId: string;
  /** Workspace in which this particular Pi process runs. */
  workspaceId: string;
  workflowId: string;
  taskId: string;
  /** Immutable run identity: implementation attempt / QC run / diagnosis / synthesis. */
  runId: string;
  seat: Seat;
  requestId: string;
  sessionId: string | null;
  phase: BindingPhase;
  provider: string | null;
  model: string | null;
  effort: string | null;
  latestKind: string | null;
  latestText: string | null;
  evidenceRef: string | null;
  /** Durable abort intent; sticky even if the terminal event is lost on restart. */
  abortRequested: number;
  createdAt: string;
  updatedAt: string;
}
export interface Reservation {
  projectId: string; orchestraWorkspaceId: string; workspaceId: string;
  workflowId: string; taskId: string; runId: string; seat: Seat; requestId: string;
}
export interface SavedActivity {
  id: number; sessionId: string; kind: string; text: string; at: number;
}
/** Only a bounded projection: never a native Pi JSONL transcript or artifact. */
export interface ExpiredActivity {
  id:number; sessionId:string; workflowId:string; taskId:string;
  at:number; bytes:number;
}
const fields = [
  "project_id AS projectId", "orchestra_workspace_id AS orchestraWorkspaceId",
  "workspace_id AS workspaceId", "workflow_id AS workflowId", "task_id AS taskId",
  "run_id AS runId", "seat", "request_id AS requestId", "session_id AS sessionId",
  "phase", "provider", "model", "effort", "latest_kind AS latestKind",
  "latest_text AS latestText", "evidence_ref AS evidenceRef",
  "abort_requested AS abortRequested",
  "created_at AS createdAt", "updated_at AS updatedAt",
].join(",");
const terminalPhases: BindingPhase[] = ["settled","sealed","failed"];
function identity(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) {
    throw new Error("Invalid " + name);
  }
}
function validate(input: Reservation): void {
  for (const key of ["projectId","orchestraWorkspaceId","workspaceId","workflowId","taskId","runId","requestId"] as const) {
    identity(input[key],key);
  }
  if (!["planner","implementer","qc","architect"].includes(input.seat)) throw new Error("Invalid role");
}
function sameReservation(a: AgentBinding, b: Reservation): boolean {
  return a.projectId===b.projectId && a.orchestraWorkspaceId===b.orchestraWorkspaceId &&
    a.workspaceId===b.workspaceId && a.workflowId===b.workflowId && a.taskId===b.taskId &&
    a.runId===b.runId && a.seat===b.seat && a.requestId===b.requestId;
}

export class AgentRegistry {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), {recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);
    // Old alpha "agent_bindings" is intentionally left untouched. It had one
    // row per Task+role and cannot represent repeated QC/implementation sessions.
    this.db.exec([
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
      "CREATE TABLE IF NOT EXISTS workspace_authority(project_id TEXT NOT NULL,workspace_id TEXT NOT NULL,",
      "physical_key TEXT NOT NULL,PRIMARY KEY(project_id,workspace_id));",
      "CREATE TABLE IF NOT EXISTS workspace_operations(physical_key TEXT PRIMARY KEY,owner TEXT NOT NULL,created_at TEXT NOT NULL);",
      "CREATE TABLE IF NOT EXISTS execution_runs(",
      "project_id TEXT NOT NULL,orchestra_workspace_id TEXT NOT NULL,workspace_id TEXT NOT NULL,",
      "workflow_id TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,",
      "seat TEXT NOT NULL,request_id TEXT NOT NULL,session_id TEXT UNIQUE,",
      "phase TEXT NOT NULL,provider TEXT,model TEXT,effort TEXT,",
      "latest_kind TEXT,latest_text TEXT,evidence_ref TEXT,",
      "abort_requested INTEGER NOT NULL DEFAULT 0,",
      "created_at TEXT NOT NULL,updated_at TEXT NOT NULL,",
      "PRIMARY KEY(project_id,orchestra_workspace_id,workflow_id,run_id),",
      "UNIQUE(project_id,orchestra_workspace_id,workflow_id,request_id));",
      "CREATE INDEX IF NOT EXISTS execution_runs_workspace ON",
      "execution_runs(project_id,orchestra_workspace_id,updated_at);",
      "CREATE TABLE IF NOT EXISTS execution_activity(",
      "id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,",
      "orchestra_workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,",
      "kind TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL);",
      "CREATE INDEX IF NOT EXISTS execution_activity_session ON",
      "execution_activity(project_id,orchestra_workspace_id,session_id,id);",
    ].join(" "));
    // SQLite stores created by pre-abort-intent versions remain readable.
    const columns=this.db.prepare("PRAGMA table_info(execution_runs)").all() as {name:string}[];
    if(!columns.some(row=>row.name==="abort_requested"))
      this.db.exec("ALTER TABLE execution_runs ADD COLUMN abort_requested INTEGER NOT NULL DEFAULT 0");
  }
  close():void {this.db.close();}
  list(projectId:string,orchestraWorkspaceId:string, view:"active"|"history"|"all"="active"):AgentBinding[] {
    identity(projectId,"projectId");identity(orchestraWorkspaceId,"orchestraWorkspaceId");
    const where=view==="active" ? " AND phase NOT IN ('settled','sealed','failed')" :
      view==="history" ? " AND phase IN ('settled','sealed','failed')" : "";
    return this.db.prepare("SELECT "+fields+" FROM execution_runs WHERE project_id=? AND orchestra_workspace_id=?"+
      where+" ORDER BY updated_at DESC LIMIT 200").all(projectId,orchestraWorkspaceId) as unknown as AgentBinding[];
  }
  /** Workflow-owned execution queries must never use the UI's 200-row limit. */
  listWorkflow(projectId:string,orchestraWorkspaceId:string,workflowId:string,
    view:"active"|"history"|"all"="all"):AgentBinding[]{
    identity(projectId,"projectId");identity(orchestraWorkspaceId,"orchestraWorkspaceId");
    identity(workflowId,"workflowId");
    const where=view==="active"?" AND phase NOT IN ('settled','sealed','failed')":
      view==="history"?" AND phase IN ('settled','sealed','failed')":"";
    return this.db.prepare("SELECT "+fields+" FROM execution_runs WHERE project_id=?"+
      " AND orchestra_workspace_id=? AND workflow_id=?"+where+
      " ORDER BY updated_at DESC").all(projectId,orchestraWorkspaceId,workflowId) as
      unknown as AgentBinding[];
  }
  hasAutomatedRun(projectId:string,orchestraWorkspaceId:string,workflowId:string):boolean{
    return this.hasAutomatedRunWhere(projectId,orchestraWorkspaceId,workflowId,false);
  }
  hasUnsealedAutomatedRun(projectId:string,orchestraWorkspaceId:string,workflowId:string):boolean{
    return this.hasAutomatedRunWhere(projectId,orchestraWorkspaceId,workflowId,true);
  }
  private hasAutomatedRunWhere(p:string,o:string,w:string,unsealed:boolean):boolean{
    identity(p,"projectId");identity(o,"orchestraWorkspaceId");identity(w,"workflowId");
    return Boolean(this.db.prepare("SELECT 1 AS present FROM execution_runs WHERE"+
      " project_id=? AND orchestra_workspace_id=? AND workflow_id=?"+
      " AND request_id LIKE 'auto:%'"+
      (unsealed?" AND phase NOT IN ('sealed','failed')":"")+
      " LIMIT 1").get(p,o,w));
  }
  /** Unbounded SQL existence check; never depend on the 200-item UI listing
   * when enforcing workspace leases before reading evidence or writing ADRs. */
  hasUnsealedWorkspace(projectId:string,workspaceId:string):boolean{
    identity(projectId,"projectId");identity(workspaceId,"workspaceId");
    return Boolean(this.db.prepare("SELECT 1 AS present FROM execution_runs r LEFT JOIN workspace_authority a "+
      "ON a.project_id=r.project_id AND a.workspace_id=r.workspace_id "+
      "WHERE ((r.project_id=? AND r.workspace_id=?) OR a.physical_key=?) AND r.phase NOT IN ('sealed','failed') LIMIT 1")
      .get(projectId,workspaceId,this.workspaceKey(projectId,workspaceId)));
  }
  /** Never stage an ADR inside a historical Task's implementation/QC workspace. */
  wasWorkflowWorkspace(projectId:string,orchestraWorkspaceId:string,
    workflowId:string,workspaceId:string):boolean{
    identity(projectId,"projectId");identity(orchestraWorkspaceId,"orchestraWorkspaceId");
    identity(workflowId,"workflowId");identity(workspaceId,"workspaceId");
    return Boolean(this.db.prepare("SELECT 1 FROM execution_runs WHERE "+
      "project_id=? AND orchestra_workspace_id=? AND workflow_id=? AND workspace_id=? "+
      "LIMIT 1").get(projectId,orchestraWorkspaceId,workflowId,workspaceId));
  }
  /** Host-resolved aliases of a checkout must contend for the same physical lease. */
  registerWorkspacePath(p:string,w:string,path:string):void {
    identity(p,"projectId");identity(w,"workspaceId");identity(path,"Workspace path");
    let canonical=resolve(path);try{canonical=realpathSync(path);}catch{/* Remote host/mock authority is already resolved. */}
    const key="path:"+canonical;
    const old=this.db.prepare("SELECT physical_key FROM workspace_authority WHERE project_id=? AND workspace_id=?")
      .get(p,w) as {physical_key:string}|undefined;
    if(old&&old.physical_key!==key)throw new Error("Registered Workspace physical identity changed");
    this.db.prepare("INSERT INTO workspace_authority VALUES(?,?,?) ON CONFLICT DO NOTHING").run(p,w,key);
  }
  private workspaceKey(p:string,w:string):string {
    return (this.db.prepare("SELECT physical_key FROM workspace_authority WHERE project_id=? AND workspace_id=?")
      .get(p,w) as {physical_key:string}|undefined)?.physical_key??JSON.stringify([p,w]);
  }
  acquireWorkspaceOperation(p:string,w:string,owner:string):void {
    identity(owner,"Workspace operation owner");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const key=this.workspaceKey(p,w);
      const old=this.db.prepare("SELECT owner FROM workspace_operations WHERE physical_key=?").get(key) as {owner:string}|undefined;
      if(old&&old.owner!==owner)throw new Error("Workspace is leased by another host operation");
      if(this.hasUnsealedWorkspace(p,w))throw new Error("Workspace has an active or unsealed Pi Run");
      this.db.prepare("INSERT INTO workspace_operations VALUES(?,?,?) ON CONFLICT DO NOTHING")
        .run(key,owner,new Date().toISOString());
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  releaseWorkspaceOperation(p:string,w:string,owner:string):void {
    this.db.prepare("DELETE FROM workspace_operations WHERE physical_key=? AND owner=?")
      .run(this.workspaceKey(p,w),owner);
  }
  get(projectId:string,orchestraWorkspaceId:string,sessionId:string):AgentBinding {
    identity(sessionId,"sessionId");
    const record=this.db.prepare("SELECT "+fields+
      " FROM execution_runs WHERE project_id=? AND orchestra_workspace_id=? AND session_id=?")
      .get(projectId,orchestraWorkspaceId,sessionId) as unknown as AgentBinding|undefined;
    if(!record) throw new Error("Pi Session is not registered under this Orchestra");
    return record;
  }
  getRun(projectId:string,orchestraWorkspaceId:string,workflowId:string,runId:string):AgentBinding|undefined {
    for(const [v,n] of [[projectId,"projectId"],[orchestraWorkspaceId,"orchestraWorkspaceId"],
      [workflowId,"workflowId"],[runId,"runId"]] as const) identity(v,n);
    return this.db.prepare("SELECT "+fields+
      " FROM execution_runs WHERE project_id=? AND orchestra_workspace_id=? AND workflow_id=? AND run_id=?")
      .get(projectId,orchestraWorkspaceId,workflowId,runId) as unknown as AgentBinding|undefined;
  }
  reserve(input:Reservation,at=new Date().toISOString()):AgentBinding {
    validate(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous=this.getRun(input.projectId,input.orchestraWorkspaceId,input.workflowId,input.runId);
      if(previous) {
        if(!sameReservation(previous,input)) throw new Error("Run ID already refers to a different execution");
        this.db.exec("COMMIT");return previous;
      }
      if(this.db.prepare("SELECT 1 FROM workspace_operations WHERE physical_key=?")
        .get(this.workspaceKey(input.projectId,input.workspaceId)))
        throw new Error("Worktree is leased by a host Git operation");
      if(input.seat==="implementer"||input.seat==="qc"||input.seat==="architect"){
        // QC/diagnosis on a linked worktree holds a read lease. Writers may not
        // race either class of read-only reviewer, including Astra diagnoses.
        const conflicting=input.seat==="implementer"?
          "seat IN ('implementer','qc','architect')":"seat='implementer'";
        const busy=this.db.prepare("SELECT COUNT(*) AS n FROM execution_runs r LEFT JOIN workspace_authority a "+
          "ON a.project_id=r.project_id AND a.workspace_id=r.workspace_id "+
          "WHERE ((r.project_id=? AND r.workspace_id=?) OR a.physical_key=?)"+
          " AND "+conflicting+" AND phase NOT IN ('sealed','failed')")
          .get(input.projectId,input.workspaceId,this.workspaceKey(input.projectId,input.workspaceId)) as {n:number};
        if(busy.n)throw new Error("Worktree is leased by an unfinished writer or QC Run");
      }
      this.db.prepare("INSERT INTO execution_runs("+
        "project_id,orchestra_workspace_id,workspace_id,workflow_id,task_id,run_id,seat,request_id,phase,created_at,updated_at)"+
        " VALUES(?,?,?,?,?,?,?,?,'reserved',?,?)")
        .run(input.projectId,input.orchestraWorkspaceId,input.workspaceId,input.workflowId,
          input.taskId,input.runId,input.seat,input.requestId,at,at);
      const added=this.getRun(input.projectId,input.orchestraWorkspaceId,input.workflowId,input.runId);
      if(!added) throw new Error("Run reservation failed");
      this.db.exec("COMMIT");return added;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  assign(input:Reservation,sessionId:string,at=new Date().toISOString()):AgentBinding {
    validate(input);identity(sessionId,"sessionId");
    const updated=this.db.prepare("UPDATE execution_runs SET session_id=?,phase='created',updated_at=?"+
      " WHERE project_id=? AND orchestra_workspace_id=? AND workflow_id=? AND run_id=?"+
      " AND task_id=? AND workspace_id=? AND seat=? AND request_id=?"+
      " AND (session_id IS NULL OR session_id=?)")
      .run(sessionId,at,input.projectId,input.orchestraWorkspaceId,input.workflowId,input.runId,
        input.taskId,input.workspaceId,input.seat,input.requestId,sessionId);
    if(updated.changes!==1) throw new Error("Run reservation missing or already attached to another Pi session");
    return this.get(input.projectId,input.orchestraWorkspaceId,sessionId);
  }
  update(binding:AgentBinding,phase:BindingPhase,detail?:{provider?:string;model?:string;effort?:string}):AgentBinding {
    if(!binding.sessionId) throw new Error("Run has no Pi Session yet");
    const current=this.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId);
    if(terminalPhases.includes(current.phase)) throw new Error("Terminal run cannot be reused or reconfigured");
    this.db.prepare("UPDATE execution_runs SET phase=?,provider=COALESCE(?,provider),"+
      "model=COALESCE(?,model),effort=COALESCE(?,effort),updated_at=?"+
      " WHERE session_id=? AND phase NOT IN ('settled','sealed','failed')")
      .run(phase,detail?.provider??null,detail?.model??null,detail?.effort??null,
        new Date().toISOString(),binding.sessionId);
    return this.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId);
  }
  /** Record a durable, fail-closed abort intent BEFORE asking the agent to abort.
   * It must survive a lost settlement event and a server restart. */
  requestAbort(binding:AgentBinding):AgentBinding{
    if(!binding.sessionId)throw new Error("Cannot abort an unassigned Run");
    const current=this.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId);
    if(["settled","sealed","failed"].includes(current.phase))
      throw new Error("Cannot abort a completed Run");
    const changed=this.db.prepare("UPDATE execution_runs SET abort_requested=1,updated_at=?"+
      " WHERE session_id=? AND phase NOT IN ('settled','sealed','failed')")
      .run(new Date().toISOString(),binding.sessionId);
    if(changed.changes!==1)throw new Error("Abort reservation changed during request");
    return this.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId);
  }
  /** Pi agent_settled ends one execution; later stages always spawn a new session. */
  record(binding:AgentBinding,event:RuntimeActivity):void {
    if(!binding.sessionId)return;
    // Settlement/abort proof must be sticky. Late asynchronous tool/text
    // notifications must not overwrite the final "Agent interrupted" marker:
    // doing so could allow Autopilot to finalize an aborted QC or plan.
    this.db.prepare("UPDATE execution_runs SET "+
      "latest_kind=CASE WHEN phase IN ('settled','sealed','failed') THEN latest_kind ELSE ? END,"+
      "latest_text=CASE WHEN phase IN ('settled','sealed','failed') THEN latest_text ELSE ? END,"+
      "phase=CASE WHEN phase IN ('settled','sealed','failed') THEN phase"+
      " WHEN ?='agent_settled' THEN 'settled'"+
      " WHEN ?='agent_started' THEN 'running' ELSE phase END, updated_at=?"+
      " WHERE session_id=?")
      .run(event.kind,event.text,event.kind,event.kind,new Date().toISOString(),binding.sessionId);
    if(event.kind==="message_delta")return;
    this.db.prepare("INSERT INTO execution_activity(project_id,orchestra_workspace_id,session_id,kind,text,at)"+
      " VALUES(?,?,?,?,?,?)")
      .run(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId,event.kind,event.text,event.at);
    this.db.prepare("DELETE FROM execution_activity WHERE project_id=? AND orchestra_workspace_id=? AND session_id=?"+
      " AND id NOT IN (SELECT id FROM execution_activity"+
      " WHERE project_id=? AND orchestra_workspace_id=? AND session_id=? ORDER BY id DESC LIMIT 60)")
      .run(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId,
        binding.projectId,binding.orchestraWorkspaceId,binding.sessionId);
  }
  /**
   * Only public activity of a durably SEALED Run is a retention candidate.
   * Both the event and the Run's last update must be old; neither an unsealed
   * QC nor a Session receiving late events can be retired.
   */
  expiredActivity(projectId:string,orchestraWorkspaceId:string,
    beforeEventMs:number,beforeSealedIso:string,limit=200):ExpiredActivity[]{
    identity(projectId,"projectId");identity(orchestraWorkspaceId,"orchestraWorkspaceId");
    if(!Number.isSafeInteger(beforeEventMs)||!Number.isSafeInteger(limit)||
      limit<1||limit>250||!Number.isFinite(Date.parse(beforeSealedIso)))
      throw new Error("Invalid activity retention boundary");
    return this.db.prepare("SELECT a.id AS id,a.session_id AS sessionId,"+
      "r.workflow_id AS workflowId,r.task_id AS taskId,a.at,"+
      "length(CAST(a.text AS BLOB)) AS bytes "+
      "FROM execution_activity a JOIN execution_runs r ON "+
      "r.project_id=a.project_id AND r.orchestra_workspace_id=a.orchestra_workspace_id "+
      "AND r.session_id=a.session_id "+
      "WHERE a.project_id=? AND a.orchestra_workspace_id=? AND a.at<? "+
      "AND r.updated_at<? AND r.phase='sealed' AND r.evidence_ref IS NOT NULL "+
      "ORDER BY a.id LIMIT ?")
      .all(projectId,orchestraWorkspaceId,beforeEventMs,beforeSealedIso,limit) as
      unknown as ExpiredActivity[];
  }
  remainingActivityIds(projectId:string,orchestraWorkspaceId:string,ids:readonly number[]):number[]{
    if(ids.length<1||ids.length>250||ids.some(id=>!Number.isSafeInteger(id)||id<1))
      throw new Error("Invalid retention activity identifiers");
    identity(projectId,"projectId");identity(orchestraWorkspaceId,"orchestraWorkspaceId");
    const placeholders=ids.map(()=>"?").join(",");
    return (this.db.prepare("SELECT id FROM execution_activity "+
      "WHERE project_id=? AND orchestra_workspace_id=? AND id IN ("+placeholders+")"+
      " ORDER BY id").all(projectId,orchestraWorkspaceId,...ids) as {id:number}[])
      .map(r=>r.id);
  }
  /** Exact atomic deletion of previously verified projections only. */
  deleteExpiredActivity(projectId:string,orchestraWorkspaceId:string,
    ids:readonly number[],beforeEventMs:number,beforeSealedIso:string):number{
    const sorted=[...new Set(ids)].sort((a,b)=>a-b);
    if(sorted.length<1||sorted.length>200||sorted.length!==ids.length||
      sorted.some(id=>!Number.isSafeInteger(id)||id<1))
      throw new Error("Invalid retention deletion batch");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      // Recheck every ID under the same SQLite write transaction. Never
      // partially delete an altered or newly active Run's public log.
      const candidates=this.expiredActivity(projectId,orchestraWorkspaceId,
        beforeEventMs,beforeSealedIso,250);
      const approved=new Set(candidates.map(c=>c.id));
      if(sorted.some(id=>!approved.has(id)))
        throw new Error("Retention candidates changed after preview; start a new preview");
      const placeholders=sorted.map(()=>"?").join(",");
      const result=this.db.prepare("DELETE FROM execution_activity "+
        "WHERE project_id=? AND orchestra_workspace_id=? AND id IN ("+placeholders+")")
        .run(projectId,orchestraWorkspaceId,...sorted);
      if(result.changes!==sorted.length)throw new Error("Retention batch was not fully deleted");
      this.db.exec("COMMIT");return result.changes;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  /** Only after output/evidence was persisted. This does not delete a Pi JSONL or worktree. */
  seal(projectId:string,orchestraWorkspaceId:string,sessionId:string,evidenceRef:string):AgentBinding {
    identity(sessionId,"sessionId");identity(evidenceRef,"evidenceRef");
    const changed=this.db.prepare("UPDATE execution_runs SET phase='sealed',evidence_ref=?,updated_at=?"+
      " WHERE project_id=? AND orchestra_workspace_id=? AND session_id=? AND phase='settled'")
      .run(evidenceRef,new Date().toISOString(),projectId,orchestraWorkspaceId,sessionId);
    if(changed.changes!==1) throw new Error("Only settled runs with captured evidence may be sealed");
    return this.get(projectId,orchestraWorkspaceId,sessionId);
  }
  activities(projectId:string,orchestraWorkspaceId:string,sessionId:string):SavedActivity[] {
    this.get(projectId,orchestraWorkspaceId,sessionId);
    return this.db.prepare("SELECT id,session_id AS sessionId,kind,text,at FROM execution_activity"+
      " WHERE project_id=? AND orchestra_workspace_id=? AND session_id=? ORDER BY id DESC LIMIT 60")
      .all(projectId,orchestraWorkspaceId,sessionId) as unknown as SavedActivity[];
  }
}
