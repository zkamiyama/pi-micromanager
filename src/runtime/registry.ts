/** Per-execution Pi sessions. A role is NOT a permanent seat or reusable agent identity. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeActivity } from "./protocol.js";

export type Seat = "planner" | "implementer" | "qc" | "architect";
export type BindingPhase =
  | "reserved" | "created" | "connected" | "configured" | "running"
  | "settled" | "sealed" | "failed" | "uncertain";

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
const fields = [
  "project_id AS projectId", "orchestra_workspace_id AS orchestraWorkspaceId",
  "workspace_id AS workspaceId", "workflow_id AS workflowId", "task_id AS taskId",
  "run_id AS runId", "seat", "request_id AS requestId", "session_id AS sessionId",
  "phase", "provider", "model", "effort", "latest_kind AS latestKind",
  "latest_text AS latestText", "evidence_ref AS evidenceRef",
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
      "CREATE TABLE IF NOT EXISTS execution_runs(",
      "project_id TEXT NOT NULL,orchestra_workspace_id TEXT NOT NULL,workspace_id TEXT NOT NULL,",
      "workflow_id TEXT NOT NULL,task_id TEXT NOT NULL,run_id TEXT NOT NULL,",
      "seat TEXT NOT NULL,request_id TEXT NOT NULL,session_id TEXT UNIQUE,",
      "phase TEXT NOT NULL,provider TEXT,model TEXT,effort TEXT,",
      "latest_kind TEXT,latest_text TEXT,evidence_ref TEXT,",
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
  }
  close():void {this.db.close();}
  list(projectId:string,orchestraWorkspaceId:string, view:"active"|"history"|"all"="active"):AgentBinding[] {
    identity(projectId,"projectId");identity(orchestraWorkspaceId,"orchestraWorkspaceId");
    const where=view==="active" ? " AND phase NOT IN ('settled','sealed','failed')" :
      view==="history" ? " AND phase IN ('settled','sealed','failed')" : "";
    return this.db.prepare("SELECT "+fields+" FROM execution_runs WHERE project_id=? AND orchestra_workspace_id=?"+
      where+" ORDER BY updated_at DESC LIMIT 200").all(projectId,orchestraWorkspaceId) as unknown as AgentBinding[];
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
      if(input.seat==="implementer"){
        const busy=this.db.prepare("SELECT COUNT(*) AS n FROM execution_runs WHERE project_id=? AND workspace_id=?"+
          " AND seat='implementer' AND phase NOT IN ('sealed','failed')")
          .get(input.projectId,input.workspaceId) as {n:number};
        if(busy.n) throw new Error("This worktree is still owned by an unsealed implementer run");
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
  /** Pi agent_settled ends one execution; later stages always spawn a new session. */
  record(binding:AgentBinding,event:RuntimeActivity):void {
    if(!binding.sessionId)return;
    this.db.prepare("UPDATE execution_runs SET latest_kind=?,latest_text=?,"+
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
