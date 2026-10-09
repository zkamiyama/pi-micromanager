import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  WorkflowError, applyAction, newWorkflow, parseDefinition,
  type WorkflowAction, type WorkflowDefinition, type WorkflowInstance,
} from "./workflow.js";

/** v0.1: one authoritative, local SQLite file; never copy pi transcripts. */
export class WorkflowStore {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS workflows (
        scope TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        state_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, id)
      );
      CREATE TABLE IF NOT EXISTS command_receipts (
        scope TEXT NOT NULL, workflow_id TEXT NOT NULL,
        command_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        applied_revision INTEGER NOT NULL,
        PRIMARY KEY(scope, workflow_id, command_id),
        FOREIGN KEY(scope, workflow_id) REFERENCES workflows(scope, id) ON DELETE CASCADE
      );
    `);
  }
  close(): void { this.db.close(); }
  private scope(projectId: string, workspaceId: string): string {
    if (!projectId || !workspaceId || projectId.length > 512 || workspaceId.length > 512) {
      throw new WorkflowError("invalid_scope", "Project/workspace identity required");
    }
    return `${projectId}\u0000${workspaceId}`;
  }
  private transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private row(scope: string, id: string): { revision: number; state_json: string } | undefined {
    return this.db.prepare("SELECT revision, state_json FROM workflows WHERE scope = ? AND id = ?")
      .get(scope, id) as { revision: number; state_json: string } | undefined;
  }
  list(projectId: string, workspaceId: string): WorkflowInstance[] {
    const scope = this.scope(projectId, workspaceId);
    const rows = this.db.prepare("SELECT state_json FROM workflows WHERE scope = ? ORDER BY updated_at DESC LIMIT 100").all(scope) as { state_json: string }[];
    return rows.map(row => JSON.parse(row.state_json) as WorkflowInstance);
  }
  get(projectId: string, workspaceId: string, id: string): WorkflowInstance {
    const row = this.row(this.scope(projectId, workspaceId), id);
    if (!row) throw new WorkflowError("not_found", `Workflow ${id} not found`);
    return JSON.parse(row.state_json) as WorkflowInstance;
  }
  create(projectId: string, workspaceId: string, input: unknown, at = new Date().toISOString()): WorkflowInstance {
    const scope = this.scope(projectId, workspaceId);
    const def: WorkflowDefinition = parseDefinition(input);
    return this.transaction(() => {
      const existing = this.row(scope, def.id);
      if (existing) {
        const current = JSON.parse(existing.state_json) as WorkflowInstance;
        if (JSON.stringify(current.definition) === JSON.stringify(def)) return current;
        throw new WorkflowError("already_exists", `Workflow ${def.id} already exists with a different definition`);
      }
      const instance = newWorkflow(def, at);
      this.db.prepare("INSERT INTO workflows (scope, id, revision, state_json, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(scope, def.id, instance.revision, JSON.stringify(instance), at);
      return instance;
    });
  }
  /** Whether an exact automation transition was committed (used before sealing a Run). */
  wasApplied(projectId:string,workspaceId:string,workflowId:string,commandId:string):boolean{
    const row=this.db.prepare("SELECT 1 AS applied FROM command_receipts "+
      "WHERE scope=? AND workflow_id=? AND command_id=?")
      .get(this.scope(projectId,workspaceId),workflowId,commandId) as
      {applied:number}|undefined;
    return row?.applied===1;
  }
  /** Atomic CAS + durable request deduplication. Unsafe retry never replays an action. */
  act(projectId: string, workspaceId: string, id: string, expectedRevision: number, commandId: string, action: WorkflowAction, at = new Date().toISOString()): WorkflowInstance {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(commandId)) throw new WorkflowError("invalid_command_id", "Invalid command ID");
    const scope = this.scope(projectId, workspaceId);
    const payloadHash = createHash("sha256").update(JSON.stringify(action)).digest("hex");
    return this.transaction(() => {
      const row = this.row(scope, id);
      if (!row) throw new WorkflowError("not_found", `Workflow ${id} not found`);
      const receipt = this.db.prepare("SELECT payload_hash FROM command_receipts WHERE scope=? AND workflow_id=? AND command_id=?")
        .get(scope, id, commandId) as { payload_hash: string } | undefined;
      if (receipt) {
        if (receipt.payload_hash !== payloadHash) throw new WorkflowError("command_conflict", "Command ID reused with different action");
        return JSON.parse(row.state_json) as WorkflowInstance;
      }
      if (!Number.isSafeInteger(expectedRevision) || row.revision !== expectedRevision) {
        throw new WorkflowError("revision_conflict", `Expected revision ${expectedRevision}, current revision ${row.revision}`);
      }
      const next = applyAction(JSON.parse(row.state_json) as WorkflowInstance, action, at);
      const write = this.db.prepare("UPDATE workflows SET revision=?, state_json=?, updated_at=? WHERE scope=? AND id=? AND revision=?")
        .run(next.revision, JSON.stringify(next), at, scope, id, expectedRevision);
      if (write.changes !== 1) throw new WorkflowError("revision_conflict", "Concurrent workflow mutation");
      this.db.prepare("INSERT INTO command_receipts(scope, workflow_id, command_id, payload_hash, applied_revision) VALUES (?,?,?,?,?)")
        .run(scope, id, commandId, payloadHash, next.revision);
      return next;
    });
  }
}
