/** Durable opt-in autonomous execution settings and evidence. No credentials are stored. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Seat, AgentBinding } from "../runtime/registry.js";
import { parseRunReport, type RunReport } from "./report.js";

export interface ModelProfile { provider:string; model:string; effort?:string }
export interface AutopilotConfig {
  /** Existing PI WEB linked, isolated worktree per implementation Task. */
  workspaces:Record<string,string>;
  /** An optional independent prelinked read-only QC snapshot workspace, per Task. */
  reviewWorkspaces?:Record<string,string>;
  models:Record<Seat,ModelProfile>;
  /** Host executes directly as argv, with no shell and no inherited secret overrides. */
  test:{file:string;args:string[];timeoutMs:number};
  maxAttempts:number;
}
export interface AutopilotRecord {
  projectId:string; orchestraWorkspaceId:string; workflowId:string;
  enabled:boolean; status:string; updatedAt:string; config:AutopilotConfig;
}
export interface EvidenceReceipt {
  ref:string; runId:string; sessionId:string; kind:string; text:string; createdAt:string;
}
const seats:Seat[]=["implementer","qc","architect","planner"];
function str(value:unknown,max:number):string {
  if(typeof value!=="string"||!value.trim()||value.length>max||value.includes("\0"))
    throw new Error("Required bounded text");
  return value;
}
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Object expected");
  return value as Record<string,unknown>;
}
function workspaceMap(value:unknown):Record<string,string>{
  const entries=Object.entries(object(value));
  if(entries.length>100)throw new Error("At most 100 workspaces");
  const map:Record<string,string>=Object.create(null) as Record<string,string>;
  for(const [taskId,workspaceId] of entries){
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(taskId))throw new Error("Invalid Task key");
    map[taskId]=str(workspaceId,128);
  }
  return map;
}
export function parseAutopilotConfig(value:unknown):AutopilotConfig{
  const raw=object(value),profiles=object(raw.models);
  const models=Object.create(null) as Record<Seat,ModelProfile>;
  for(const seat of seats){
    const p=object(profiles[seat]);
    models[seat]={provider:str(p.provider,120),model:str(p.model,160),
      ...(p.effort===undefined?{}:{effort:str(p.effort,32)})};
  }
  const workspaces=workspaceMap(raw.workspaces);
  // A single modifying Worktree shared across Tasks is never safe, even when
  // the current workflow happens to dispatch those Tasks sequentially.
  if(new Set(Object.values(workspaces)).size!==Object.keys(workspaces).length)
    throw new Error("Each implementation Task requires a distinct linked worktree");
  const t=object(raw.test),file=str(t.file,256);
  if(!Array.isArray(t.args)||t.args.length>32||
    !t.args.every(x=>typeof x==="string"&&x.length<=1000))
    throw new Error("Test command must be an argv list of <=32 bounded strings");
  const timeoutMs=t.timeoutMs===undefined?60000:t.timeoutMs;
  if(!Number.isSafeInteger(timeoutMs)||typeof timeoutMs!=="number"||timeoutMs<1000||timeoutMs>120000)
    throw new Error("Test timeout must be 1000..120000ms");
  const maxAttempts=raw.maxAttempts??5;
  if(!Number.isSafeInteger(maxAttempts)||typeof maxAttempts!=="number"||maxAttempts<1||maxAttempts>10)
    throw new Error("Implementation attempt budget must be 1..10");
  return {workspaces, ...(raw.reviewWorkspaces===undefined?{}:{
    reviewWorkspaces:workspaceMap(raw.reviewWorkspaces)}),
    models,test:{file,args:t.args as string[],timeoutMs},maxAttempts};
}
export function automationScope(projectId:string,workspaceId:string):string {
  return JSON.stringify([str(projectId,512),str(workspaceId,512)]);
}
export class AutopilotLedger {
  private readonly db:DatabaseSync;
  constructor(path:string){
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS autopilots(
        scope TEXT NOT NULL,workflow_id TEXT NOT NULL,config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,
        updated_at TEXT NOT NULL,PRIMARY KEY(scope,workflow_id));
      CREATE TABLE IF NOT EXISTS autopilot_reports(
        scope TEXT NOT NULL,workflow_id TEXT NOT NULL,run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,report_json TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(scope,workflow_id,run_id));
      CREATE TABLE IF NOT EXISTS autopilot_evidence(
        scope TEXT NOT NULL,workflow_id TEXT NOT NULL,run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,ref TEXT NOT NULL,kind TEXT NOT NULL,
        text TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(scope,workflow_id,run_id));
    `);
  }
  close():void{this.db.close();}
  save(projectId:string,workspaceId:string,workflowId:string,input:unknown):AutopilotRecord {
    const config=parseAutopilotConfig(input),scope=automationScope(projectId,workspaceId);
    str(workflowId,128);
    const at=new Date().toISOString();
    this.db.prepare(`INSERT INTO autopilots(scope,workflow_id,config_json,enabled,status,updated_at)
      VALUES(?,?,?,0,'Configured. Start explicitly.',?)
      ON CONFLICT(scope,workflow_id) DO UPDATE SET config_json=excluded.config_json,
      enabled=0,status='Configuration changed; explicit restart required',updated_at=excluded.updated_at`)
      .run(scope,workflowId,JSON.stringify(config),at);
    return this.get(projectId,workspaceId,workflowId)!;
  }
  get(projectId:string,workspaceId:string,workflowId:string):AutopilotRecord|undefined {
    const scope=automationScope(projectId,workspaceId);
    const row=this.db.prepare(`SELECT config_json,enabled,status,updated_at FROM autopilots
      WHERE scope=? AND workflow_id=?`).get(scope,workflowId) as
      {config_json:string;enabled:number;status:string;updated_at:string}|undefined;
    return row?{projectId,orchestraWorkspaceId:workspaceId,workflowId,
      enabled:row.enabled===1,status:row.status,updatedAt:row.updated_at,
      config:parseAutopilotConfig(JSON.parse(row.config_json))}:undefined;
  }
  list():AutopilotRecord[]{
    const rows=this.db.prepare(`SELECT scope,workflow_id,config_json,enabled,status,updated_at
      FROM autopilots ORDER BY updated_at DESC LIMIT 200`).all() as
      {scope:string;workflow_id:string;config_json:string;enabled:number;status:string;updated_at:string}[];
    return rows.map(row=>{
      const [projectId,orchestraWorkspaceId]=JSON.parse(row.scope) as [string,string];
      return {projectId,orchestraWorkspaceId,workflowId:row.workflow_id,
        config:parseAutopilotConfig(JSON.parse(row.config_json)),
        enabled:row.enabled===1,status:row.status,updatedAt:row.updated_at};
    });
  }
  setStatus(projectId:string,workspaceId:string,workflowId:string,enabled:boolean,status:string):void {
    str(status,1000);
    const result=this.db.prepare(`UPDATE autopilots SET enabled=?,status=?,updated_at=?
      WHERE scope=? AND workflow_id=?`).run(enabled?1:0,status,new Date().toISOString(),
      automationScope(projectId,workspaceId),workflowId);
    if(result.changes!==1)throw new Error("Configure the workflow before starting");
  }
  recordReport(binding:AgentBinding,value:unknown):RunReport {
    if(!binding.sessionId)throw new Error("A report requires an attached Pi Session");
    const report=parseRunReport(value);
    if(!report||report.runId!==binding.runId)throw new Error("Invalid/mismatched structured Pi report");
    const scope=automationScope(binding.projectId,binding.orchestraWorkspaceId);
    const current=this.db.prepare(`SELECT session_id,report_json FROM autopilot_reports
      WHERE scope=? AND workflow_id=? AND run_id=?`).get(scope,binding.workflowId,binding.runId) as
      {session_id:string;report_json:string}|undefined;
    if(current){
      if(current.session_id!==binding.sessionId||JSON.stringify(JSON.parse(current.report_json))!==JSON.stringify(report))
        throw new Error("Conflicting duplicate run report");
      return report;
    }
    this.db.prepare(`INSERT INTO autopilot_reports
      (scope,workflow_id,run_id,session_id,report_json,created_at) VALUES(?,?,?,?,?,?)`)
      .run(scope,binding.workflowId,binding.runId,binding.sessionId,JSON.stringify(report),new Date().toISOString());
    return report;
  }
  report(binding:AgentBinding):RunReport|undefined {
    if(!binding.sessionId)return;
    const row=this.db.prepare(`SELECT report_json FROM autopilot_reports
      WHERE scope=? AND workflow_id=? AND run_id=? AND session_id=?`)
      .get(automationScope(binding.projectId,binding.orchestraWorkspaceId),
        binding.workflowId,binding.runId,binding.sessionId) as {report_json:string}|undefined;
    return row?parseRunReport(JSON.parse(row.report_json)):undefined;
  }
  sealEvidence(binding:AgentBinding,kind:string,text:string):EvidenceReceipt{
    if(!binding.sessionId)throw new Error("Cannot persist evidence without a Session");
    str(kind,60);str(text,3500);
    const ref="sha256:"+createHash("sha256").update(JSON.stringify([
      binding.projectId,binding.orchestraWorkspaceId,binding.workflowId,
      binding.runId,binding.sessionId,kind,text])).digest("hex");
    const scope=automationScope(binding.projectId,binding.orchestraWorkspaceId);
    const at=new Date().toISOString();
    this.db.prepare(`INSERT INTO autopilot_evidence
      (scope,workflow_id,run_id,session_id,ref,kind,text,created_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(scope,workflow_id,run_id) DO NOTHING`)
      .run(scope,binding.workflowId,binding.runId,binding.sessionId,ref,kind,text,at);
    const receipt=this.evidence(binding);
    if(!receipt||receipt.ref!==ref||receipt.sessionId!==binding.sessionId)
      throw new Error("Conflicting evidence for same Run");
    return receipt;
  }
  evidence(binding:AgentBinding):EvidenceReceipt|undefined {
    const row=this.db.prepare(`SELECT ref,run_id AS runId,session_id AS sessionId,
      kind,text,created_at AS createdAt FROM autopilot_evidence
      WHERE scope=? AND workflow_id=? AND run_id=?`)
      .get(automationScope(binding.projectId,binding.orchestraWorkspaceId),
        binding.workflowId,binding.runId) as EvidenceReceipt|undefined;
    return row;
  }
}
