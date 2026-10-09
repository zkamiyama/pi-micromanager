/** Two-step retention of MAMC public activity projections only.
 * Native Pi transcripts, Git worktrees, Workflow state and evidence receipts
 * are never modified by this service. */
import {createHash,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import type {WorkflowStore} from "../core/store.js";
import type {AgentRegistry,ExpiredActivity} from "../runtime/registry.js";
import type {AutopilotLedger} from "./ledger.js";
import {automationScope} from "./ledger.js";

export interface RetentionPreview {
  id:string;olderThanDays:number;rowCount:number;estimatedBytes:number;
  affectedRuns:number;expiresAt:number;state:"prepared"|"completed";
  deletedRows:number;
}
interface PlanRow {
  id:string;scope:string;before_at:number;before_iso:string;
  older_than_days:number;ids_json:string;fingerprint:string;
  bytes:number;runs:number;expires_at:number;state:"prepared"|"completed";
  deleted_rows:number;
}
export interface RetentionOptions {
  path:string;workflows:WorkflowStore;agents:AgentRegistry;ledger:AutopilotLedger;
}
const TTL=10*60*1000;
const DAY=24*60*60*1000;
function digest(rows:readonly ExpiredActivity[]):string{
  return createHash("sha256").update(JSON.stringify(rows.map(r=>
    [r.id,r.sessionId,r.workflowId,r.taskId,r.at,r.bytes]))).digest("hex");
}
export class ActivityRetention {
  private readonly db:DatabaseSync;
  constructor(private readonly opts:RetentionOptions){
    mkdirSync(dirname(opts.path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(opts.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS retention_previews(
      id TEXT PRIMARY KEY,scope TEXT NOT NULL,before_at INTEGER NOT NULL,
      before_iso TEXT NOT NULL,older_than_days INTEGER NOT NULL,
      ids_json TEXT NOT NULL,fingerprint TEXT NOT NULL,
      bytes INTEGER NOT NULL,runs INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      state TEXT NOT NULL,deleted_rows INTEGER NOT NULL DEFAULT 0);`);
  }
  close():void{this.db.close();}
  private closed(p:string,o:string,r:ExpiredActivity):boolean{
    // A "passed", held, needs_human or otherwise unresolved Task protects
    // all of this Workflow's public Run activity until human decisions finish.
    try{
      const wf=this.opts.workflows.get(p,o,r.workflowId);
      if(Object.values(wf.tasks).some(t=>t.status!=="done"&&t.status!=="integrated"))
        return false;
      if(wf.amendments.some(a=>a.status!=="cancelled"&&a.status!=="completed"))
        return false;
      const run=this.opts.agents.get(p,o,r.sessionId);
      if(run.workflowId!==r.workflowId||run.taskId!==r.taskId||
        run.phase!=="sealed"||!run.evidenceRef)return false;
      const receipt=this.opts.ledger.evidence(run);
      return receipt?.ref===run.evidenceRef&&receipt.sessionId===r.sessionId;
    }catch{return false;}
  }
  private candidates(p:string,o:string,beforeAt:number,beforeIso:string):ExpiredActivity[]{
    // Scan at most 250 sealed public projections per preview. Rows with
    // open Workflows cannot be skipped to reach arbitrarily old hidden data.
    return this.opts.agents.expiredActivity(p,o,beforeAt,beforeIso,200)
      .filter(row=>this.closed(p,o,row));
  }
  private display(row:PlanRow):RetentionPreview{
    const ids=JSON.parse(row.ids_json) as number[];
    return {id:row.id,olderThanDays:row.older_than_days,
      rowCount:ids.length,estimatedBytes:row.bytes,affectedRuns:row.runs,
      expiresAt:row.expires_at,state:row.state,deletedRows:row.deleted_rows};
  }
  preview(p:string,o:string,days=30,now=Date.now()):RetentionPreview|null{
    if(!Number.isSafeInteger(days)||days<30||days>365||
      !Number.isSafeInteger(now)||now<DAY*365)
      throw new Error("Retention minimum 30 days and maximum 365 days");
    const scope=automationScope(p,o);
    // Retention receipts are finite, while recent committed/unresolved proofs
    // remain available for crash reconciliation and explicit reinspection.
    this.db.prepare("DELETE FROM retention_previews WHERE expires_at<?")
      .run(now-30*DAY);
    const active=this.db.prepare("SELECT COUNT(*) AS count FROM retention_previews "+
      "WHERE scope=? AND state='prepared' AND expires_at>=?")
      .get(scope,now) as {count:number};
    if(active.count>=8)throw new Error("Too many active retention previews; wait for expiry");
    const beforeAt=now-days*DAY;
    const beforeIso=new Date(beforeAt).toISOString();
    const candidates=this.candidates(p,o,beforeAt,beforeIso);
    if(!candidates.length)return null;
    const row:PlanRow={
      id:randomUUID(),scope:automationScope(p,o),
      before_at:beforeAt,before_iso:beforeIso,older_than_days:days,
      ids_json:JSON.stringify(candidates.map(r=>r.id)),
      fingerprint:digest(candidates),
      bytes:candidates.reduce((sum,r)=>sum+r.bytes,0),
      runs:new Set(candidates.map(r=>r.sessionId)).size,
      expires_at:now+TTL,state:"prepared",deleted_rows:0,
    };
    this.db.prepare(`INSERT INTO retention_previews(
      id,scope,before_at,before_iso,older_than_days,ids_json,
      fingerprint,bytes,runs,expires_at,state,deleted_rows)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.id,row.scope,row.before_at,row.before_iso,row.older_than_days,
      row.ids_json,row.fingerprint,row.bytes,row.runs,row.expires_at,
      row.state,row.deleted_rows);
    return this.display(row);
  }
  confirm(p:string,o:string,id:string,now=Date.now()):RetentionPreview{
    if(!/^[0-9a-f-]{36}$/.test(id))throw new Error("Invalid retention preview ID");
    const row=this.db.prepare("SELECT * FROM retention_previews WHERE id=?")
      .get(id) as PlanRow|undefined;
    if(!row||row.scope!==automationScope(p,o))
      throw new Error("Retention preview was not found in this workspace");
    const ids=JSON.parse(row.ids_json) as number[];
    if(row.state==="completed")return this.display(row);
    if(now>row.expires_at)throw new Error("Retention preview expired");
    const remaining=this.opts.agents.remainingActivityIds(p,o,ids);
    if(remaining.length===0){
      // Activity SQLite committed deletion, but a crash prevented recording
      // the receipt in this separate SQLite file. Recovery is read-only.
      this.db.prepare("UPDATE retention_previews SET state='completed',deleted_rows=? WHERE id=?")
        .run(ids.length,id);
      return {...this.display(row),state:"completed",deletedRows:ids.length};
    }
    if(remaining.length!==ids.length)
      throw new Error("Partial activity retention state; manual reconciliation required");
    const selected=this.candidates(p,o,row.before_at,row.before_iso)
      .filter(r=>ids.includes(r.id));
    if(selected.length!==ids.length||digest(selected)!==row.fingerprint)
      throw new Error("Workflow/Run retention eligibility changed after preview");
    // No await: candidate revalidation and the exact DELETE are synchronous
    // on the same server event loop; SQLite rechecks Run sealing atomically.
    this.opts.agents.deleteExpiredActivity(p,o,ids,row.before_at,row.before_iso);
    this.db.prepare("UPDATE retention_previews SET state='completed',deleted_rows=? WHERE id=?")
      .run(ids.length,id);
    return {...this.display(row),state:"completed",deletedRows:ids.length};
  }
}
