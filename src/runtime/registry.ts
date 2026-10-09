/** Finite, workspace-scoped Pi session binding and activity registry. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeActivity } from "./protocol.js";

export type Seat = "planner" | "implementer" | "qc" | "architect";
export type BindingPhase = "reserved" | "created" | "connected" | "configured" | "blocked" | "uncertain";
export interface AgentBinding {
  projectId: string; workspaceId: string; workflowId: string; taskId: string;
  seat: Seat; requestId: string; sessionId: string | null; phase: BindingPhase;
  provider: string | null; model: string | null; effort: string | null;
  latestKind: string | null; latestText: string | null; updatedAt: string;
}
export interface Reservation {
  projectId: string; workspaceId: string; workflowId: string; taskId: string;
  seat: Seat; requestId: string;
}
export interface SavedActivity {
  id: number; sessionId: string; kind: string; text: string; at: number;
}
const fields = "project_id AS projectId,workspace_id AS workspaceId,workflow_id AS workflowId," +
  "task_id AS taskId,seat,request_id AS requestId,session_id AS sessionId,phase,provider,model,effort," +
  "latest_kind AS latestKind,latest_text AS latestText,updated_at AS updatedAt";
function identity(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) {
    throw new Error("Invalid " + name);
  }
}
function validate(input: Reservation): void {
  for (const key of ["projectId","workspaceId","workflowId","taskId","requestId"] as const) {
    identity(input[key],key);
  }
  if (!["planner","implementer","qc","architect"].includes(input.seat)) throw new Error("Invalid seat");
}
export class AgentRegistry {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec([
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
      "CREATE TABLE IF NOT EXISTS agent_bindings (",
      "project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL,",
      "task_id TEXT NOT NULL,seat TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,",
      "session_id TEXT UNIQUE,phase TEXT NOT NULL,provider TEXT,model TEXT,effort TEXT,",
      "latest_kind TEXT,latest_text TEXT,updated_at TEXT NOT NULL,",
      "PRIMARY KEY(project_id,workspace_id,workflow_id,task_id,seat));",
      "CREATE TABLE IF NOT EXISTS agent_activity (",
      "id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL,",
      "session_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL);",
      "CREATE INDEX IF NOT EXISTS agent_activity_session ON",
      "agent_activity(project_id,workspace_id,session_id,id);",
    ].join(" "));
  }
  close(): void { this.db.close(); }
  list(projectId: string, workspaceId: string): AgentBinding[] {
    identity(projectId,"projectId"); identity(workspaceId,"workspaceId");
    return this.db.prepare("SELECT " + fields + " FROM agent_bindings WHERE project_id=? AND workspace_id=? ORDER BY updated_at DESC LIMIT 100")
      .all(projectId,workspaceId) as unknown as AgentBinding[];
  }
  get(projectId: string, workspaceId: string, sessionId: string): AgentBinding {
    identity(sessionId,"sessionId");
    const row = this.db.prepare("SELECT " + fields + " FROM agent_bindings WHERE project_id=? AND workspace_id=? AND session_id=?")
      .get(projectId,workspaceId,sessionId) as unknown as AgentBinding | undefined;
    if (!row) throw new Error("Agent session is not registered in this workspace");
    return row;
  }
  reserve(input: Reservation, at = new Date().toISOString()): AgentBinding {
    validate(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT " + fields +
        " FROM agent_bindings WHERE project_id=? AND workspace_id=? AND workflow_id=? AND task_id=? AND seat=?")
        .get(input.projectId,input.workspaceId,input.workflowId,input.taskId,input.seat) as unknown as AgentBinding | undefined;
      if (prior) {
        if (prior.requestId !== input.requestId) throw new Error("This Task/seat already has a Pi session reservation");
        this.db.exec("COMMIT"); return prior;
      }
      // This fences MAMC's own modifying sessions, not external/PI WEB manual writers.
      if (input.seat === "implementer") {
        const existing = this.db.prepare("SELECT COUNT(*) AS n FROM agent_bindings WHERE project_id=? AND workspace_id=? AND seat='implementer'")
          .get(input.projectId,input.workspaceId) as { n: number };
        if (existing.n) throw new Error("An implementer occupies this worktree; choose another workspace");
      }
      this.db.prepare("INSERT INTO agent_bindings(project_id,workspace_id,workflow_id,task_id,seat,request_id,phase,updated_at) VALUES(?,?,?,?,?,?,'reserved',?)")
        .run(input.projectId,input.workspaceId,input.workflowId,input.taskId,input.seat,input.requestId,at);
      const row = this.db.prepare("SELECT " + fields +
        " FROM agent_bindings WHERE project_id=? AND workspace_id=? AND workflow_id=? AND task_id=? AND seat=?")
        .get(input.projectId,input.workspaceId,input.workflowId,input.taskId,input.seat) as unknown as AgentBinding;
      this.db.exec("COMMIT"); return row;
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
  assign(input: Reservation, sessionId: string, at = new Date().toISOString()): AgentBinding {
    identity(sessionId,"sessionId");
    const update = this.db.prepare("UPDATE agent_bindings SET session_id=?,phase='created',updated_at=? " +
      "WHERE project_id=? AND workspace_id=? AND workflow_id=? AND task_id=? AND seat=? " +
      "AND request_id=? AND (session_id IS NULL OR session_id=?)")
      .run(sessionId,at,input.projectId,input.workspaceId,input.workflowId,input.taskId,input.seat,input.requestId,sessionId);
    if(update.changes !== 1) throw new Error("Reservation is missing, mismatched or already bound");
    return this.get(input.projectId,input.workspaceId,sessionId);
  }
  update(binding: AgentBinding, phase: BindingPhase, details?: { provider?: string; model?: string; effort?: string }): AgentBinding {
    if (!binding.sessionId) throw new Error("A Pi session has not been assigned");
    this.db.prepare("UPDATE agent_bindings SET phase=?,provider=COALESCE(?,provider)," +
      "model=COALESCE(?,model),effort=COALESCE(?,effort),updated_at=? " +
      "WHERE project_id=? AND workspace_id=? AND session_id=?")
      .run(phase,details?.provider ?? null,details?.model ?? null,details?.effort ?? null,
        new Date().toISOString(),binding.projectId,binding.workspaceId,binding.sessionId);
    return this.get(binding.projectId,binding.workspaceId,binding.sessionId);
  }
  record(binding: AgentBinding, activity: RuntimeActivity): void {
    if (!binding.sessionId) return;
    this.db.prepare("UPDATE agent_bindings SET latest_kind=?,latest_text=?,updated_at=? " +
      "WHERE project_id=? AND workspace_id=? AND session_id=?")
      .run(activity.kind,activity.text,new Date().toISOString(),
        binding.projectId,binding.workspaceId,binding.sessionId);
    if (activity.kind === "message_delta") return;
    this.db.prepare("INSERT INTO agent_activity(project_id,workspace_id,session_id,kind,text,at) VALUES(?,?,?,?,?,?)")
      .run(binding.projectId,binding.workspaceId,binding.sessionId,activity.kind,activity.text,activity.at);
    this.db.prepare("DELETE FROM agent_activity WHERE project_id=? AND workspace_id=? AND session_id=? AND " +
      "id NOT IN (SELECT id FROM agent_activity WHERE project_id=? AND workspace_id=? AND session_id=? ORDER BY id DESC LIMIT 60)")
      .run(binding.projectId,binding.workspaceId,binding.sessionId,binding.projectId,binding.workspaceId,binding.sessionId);
  }
  activities(projectId: string, workspaceId: string, sessionId: string): SavedActivity[] {
    this.get(projectId,workspaceId,sessionId);
    return this.db.prepare("SELECT id,session_id AS sessionId,kind,text,at FROM agent_activity " +
      "WHERE project_id=? AND workspace_id=? AND session_id=? ORDER BY id DESC LIMIT 60")
      .all(projectId,workspaceId,sessionId) as unknown as SavedActivity[];
  }
}
