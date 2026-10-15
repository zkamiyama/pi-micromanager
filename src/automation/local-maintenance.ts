/** Durable, bounded admission for maintenance that outlives a peer request.
 * Reply loss never causes a second invocation. Reopen marks interrupted work
 * uncertain; underlying resource receipts retain the actual mutation evidence. */
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {automationScope} from "./ledger.js";

export interface MaintenanceOperation {
  id:string;workflowId:string;action:string;
  phase:"running"|"completed"|"blocked"|"uncertain";
  message:string;startedAt:number;deadline:number;
}
interface Row extends MaintenanceOperation {scope:string;requestId:string;intent:string}
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class LocalMaintenance {
  private readonly db:DatabaseSync;
  private readonly flights=new Map<string,Promise<void>>();
  private closing=false;
  constructor(file:string,private readonly signal:AbortSignal){
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS local_maintenance(
        id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflowId TEXT NOT NULL,action TEXT NOT NULL,
        requestId TEXT NOT NULL,intent TEXT NOT NULL,phase TEXT NOT NULL,message TEXT NOT NULL,
        startedAt INTEGER NOT NULL,deadline INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS maintenance_scope ON local_maintenance(scope,workflowId);
      UPDATE local_maintenance SET phase='uncertain',message='Interrupted maintenance; inspect retained resource receipts. No automatic replay.' WHERE phase='running';`);
  }
  private view(row:Row):MaintenanceOperation{
    const {scope:_,requestId:__,intent:___,...value}=row;return value;
  }
  get(p:string,o:string,id:string):MaintenanceOperation{
    const row=this.db.prepare("SELECT * FROM local_maintenance WHERE id=? AND scope=?")
      .get(id,automationScope(p,o)) as unknown as Row|undefined;
    if(!row)throw new Error("Maintenance receipt not in the selected scope");
    return this.view(row);
  }
  latest(p:string,o:string,w:string):MaintenanceOperation|null{
    const row=this.db.prepare("SELECT * FROM local_maintenance WHERE scope=? AND workflowId=? ORDER BY rowid DESC LIMIT 1")
      .get(automationScope(p,o),w) as unknown as Row|undefined;
    return row?this.view(row):null;
  }
  admit(p:string,o:string,w:string,requestId:string,action:string,payload:unknown,
    execute:(assertActive:()=>void)=>Promise<void>):MaintenanceOperation{
    this.signal.throwIfAborted();if(this.closing)throw new Error("Maintenance is draining");
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(requestId))throw new Error("Explicit bounded maintenance request ID required");
    const scope=automationScope(p,o),id=hash([scope,w,requestId]),intent=hash([action,payload]);
    const previous=this.db.prepare("SELECT * FROM local_maintenance WHERE id=?").get(id) as unknown as Row|undefined;
    if(previous){if(previous.intent!==intent)throw new Error("Maintenance request ID reused with different intent");return this.view(previous);}
    if(this.db.prepare("SELECT 1 FROM local_maintenance WHERE scope=? AND workflowId=? AND phase IN ('running','uncertain') LIMIT 1").get(scope,w))
      throw new Error("Prior maintenance is running or uncertain; inspect its receipt instead of replaying");
    if(this.flights.size>=4||(this.db.prepare("SELECT count(*) AS n FROM local_maintenance").get() as {n:number}).n>=25000)
      throw new Error("Maintenance admission capacity reached; original receipts retained");
    const now=Date.now(),row:Row={id,scope,workflowId:w,action,requestId,intent,phase:"running",
      message:"Admitted. Inspect this receipt; do not resubmit with a new ID after a timeout.",startedAt:now,deadline:now+120000};
    this.db.prepare("INSERT INTO local_maintenance VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id,scope,w,action,requestId,intent,row.phase,row.message,now,row.deadline);
    const check=()=>{
      this.signal.throwIfAborted();
      if(this.closing||Date.now()>=row.deadline)throw new Error("Maintenance stopped or deadline exceeded");
    };
    const flight=Promise.resolve().then(async()=>{
      check();await execute(check);
      // A completed effect is not promoted to success if owner/deadline changed.
      check();this.db.prepare("UPDATE local_maintenance SET phase='completed',message='Maintenance completed; resource receipts retained.' WHERE id=?").run(id);
    }).catch(error=>{
      const phase=this.signal.aborted||this.closing||Date.now()>=row.deadline?"uncertain":"blocked";
      const text=error instanceof Error?error.message:"";
      const reason=/pinned|active|unsealed|unfinished|pending/i.test(text)?"Workflow is held, pinned or unfinished":
        /archive|artifact|decod/i.test(text)?"Required archive is unavailable or failed integrity validation":
        /generation|authority/i.test(text)?"Control authority changed":
        /untracked|ignored|uncommitted|inventory/i.test(text)?"Working copy has changed or contains unpreserved files":
        /alias|ownership|identity/i.test(text)?"Resource identity is unproved":
        "Operation not fully confirmed";
      this.db.prepare("UPDATE local_maintenance SET phase=?,message=? WHERE id=?")
        .run(phase,reason+"; inspect retained resource receipts. No blind replay.",id);
    });
    this.flights.set(id,flight);
    void flight.finally(()=>this.flights.delete(id)).catch(()=>{});
    return this.view(row);
  }
  async close():Promise<void>{
    this.closing=true;
    await Promise.allSettled([...this.flights.values()]);
    this.db.close();
  }
}
