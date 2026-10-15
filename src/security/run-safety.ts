/** Host-owned run limits and terminal facts. Never a model's own verdict. */
import {DatabaseSync} from "node:sqlite";
import {mkdirSync,chmodSync,lstatSync} from "node:fs";
import {dirname} from "node:path";
export interface RunLimits {
  maxModelRequests:number;maxToolCalls:number;maxRunMs:number;maxConcurrentRuns:number;
}
export const DEFAULT_LIMITS:Readonly<RunLimits>=Object.freeze({
  maxModelRequests:120,maxToolCalls:500,maxRunMs:60*60_000,maxConcurrentRuns:16,
});
export type RunOutcome="completed"|"aborted"|"failed"|"uncertain";
export interface RunSafetyRecord {
  key:string;fingerprint:string;deadline:number;requests:number;tools:number;
  outcome:RunOutcome|null;limits:RunLimits;
}
export function validateRunLimits(v:RunLimits):RunLimits{
  for(const [k,min,max] of [["maxModelRequests",1,500],["maxToolCalls",1,2000],
    ["maxRunMs",1000,14_400_000],["maxConcurrentRuns",1,32]] as const){
    if(!Number.isSafeInteger(v[k])||v[k]<min||v[k]>max)throw new Error("Invalid run budget: "+k);
  }
  return {...v};
}
export class RunSafetyLedger {
  private readonly db:DatabaseSync;
  constructor(path:string){
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    try{const s=lstatSync(path);if(!s.isFile()||s.nlink!==1)throw new Error("Unsafe run-safety database");}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    this.db=new DatabaseSync(path);chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS safety_runs(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,
        deadline INTEGER NOT NULL,requests INTEGER NOT NULL DEFAULT 0,tools INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,limits_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS safety_inputs(run_key TEXT NOT NULL,request_id TEXT NOT NULL,
        PRIMARY KEY(run_key,request_id));`);
  }
  get(key:string):RunSafetyRecord|undefined{
    const row=this.db.prepare("SELECT key,fingerprint,deadline,requests,tools,outcome,limits_json FROM safety_runs WHERE key=?")
      .get(key) as Omit<RunSafetyRecord,"limits">&{limits_json:string}|undefined;
    if(!row)return;
    const {limits_json,...rest}=row;return {...rest,limits:validateRunLimits(JSON.parse(limits_json))};
  }
  reserve(key:string,fingerprint:string,limits:RunLimits,startedAt:number):RunSafetyRecord{
    validateRunLimits(limits);
    if(!/^[a-f0-9]{64}$/.test(key)||!fingerprint||fingerprint.length>128||!Number.isSafeInteger(startedAt)||startedAt<0)
      throw new Error("Invalid run-safety identity");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const existing=this.get(key);
      if(existing){if(existing.fingerprint!==fingerprint)throw new Error("Frozen runtime contract changed");
        this.db.exec("COMMIT");return existing;}
      const count=this.db.prepare("SELECT COUNT(*) AS n FROM safety_runs WHERE outcome IS NULL OR outcome='uncertain'").get() as {n:number};
      if(count.n>=limits.maxConcurrentRuns)throw new Error("Host-wide run admission budget exhausted");
      this.db.prepare("INSERT INTO safety_runs(key,fingerprint,deadline,limits_json) VALUES(?,?,?,?)")
        .run(key,fingerprint,startedAt+limits.maxRunMs,JSON.stringify(limits));
      this.db.exec("COMMIT");return this.get(key)!;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  hasCapacity(limits:RunLimits):boolean{
    validateRunLimits(limits);
    const row=this.db.prepare("SELECT COUNT(*) AS n FROM safety_runs WHERE outcome IS NULL OR outcome='uncertain'").get() as {n:number};
    return row.n<limits.maxConcurrentRuns;
  }
  assertActive(key:string,now=Date.now()):RunSafetyRecord{
    const r=this.get(key);if(!r)throw new Error("Missing frozen runtime contract");
    if(r.outcome)throw new Error("Run has a terminal runtime outcome: "+r.outcome);
    if(now>=r.deadline)throw new Error("Run wall-clock budget exhausted");
    return r;
  }
  consume(key:string,kind:"model"|"tool",now=Date.now()):void{
    this.db.exec("BEGIN IMMEDIATE");
    let exhausted=false;
    try{
      const r=this.assertActive(key,now),column=kind==="model"?"requests":"tools";
      const max=kind==="model"?r.limits.maxModelRequests:r.limits.maxToolCalls;
      exhausted=r[column]>=max;
      if(exhausted){
        // A rejected tool can be followed by a nominally successful model
        // response. Latch failure before returning the error to the SDK so a
        // provisional report cannot become authoritative after exhaustion.
        this.db.prepare("UPDATE safety_runs SET outcome='failed' WHERE key=? AND outcome IS NULL").run(key);
      }else this.db.prepare("UPDATE safety_runs SET "+column+"="+column+"+1 WHERE key=?").run(key);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    if(exhausted)throw new Error("Run "+kind+" budget exhausted");
  }
  trackInput(key:string,requestId:string):void{
    this.assertActive(key);
    if(!requestId.trim()||requestId.length>128||requestId.includes("\0"))throw new Error("Invalid runtime input identity");
    const old=this.inputs(key);if(old.includes(requestId))return;
    if(old.length>=256)throw new Error("Run input budget exhausted");
    this.db.prepare("INSERT INTO safety_inputs(run_key,request_id) VALUES(?,?)").run(key,requestId);
  }
  inputs(key:string):string[]{
    return (this.db.prepare("SELECT request_id FROM safety_inputs WHERE run_key=? ORDER BY request_id")
      .all(key) as {request_id:string}[]).map(x=>x.request_id);
  }
  finish(key:string,outcome:RunOutcome):void{
    if(!["completed","aborted","failed","uncertain"].includes(outcome))throw new Error("Invalid terminal outcome");
    const r=this.get(key);if(!r)throw new Error("Missing run-safety record");
    if(r.outcome&&r.outcome!==outcome)throw new Error("Terminal runtime outcome is immutable");
    this.db.prepare("UPDATE safety_runs SET outcome=? WHERE key=? AND outcome IS NULL").run(outcome,key);
  }
  close():void{this.db.close();}
}
/** Pure classification accepts only explicit success of every tracked input. */
export function classifyInputOutcomes(inputs:readonly unknown[],aborted:boolean):RunOutcome{
  if(aborted)return "aborted";
  if(!inputs.length)return "uncertain";
  const records=inputs.filter((x):x is {type?:unknown;status?:unknown}=>!!x&&typeof x==="object");
  if(records.some(x=>x.type==="input"&&x.status==="unanswered"))return "failed";
  return records.length===inputs.length&&records.every(x=>x.type==="input"&&x.status==="done")?
    "completed":"uncertain";
}
