/** Durable opt-in autonomous execution settings and evidence. No credentials are stored. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Seat, AgentBinding } from "../runtime/registry.js";
import { parseRunReport, type RunReport } from "./report.js";
import type {LaunchJob} from "./engine.js";
import type {WorkflowAction} from "../core/workflow.js";
import {parseAutomaticDiagnosisPolicy,type AutomaticDiagnosisPolicy} from "../core/automatic-diagnosis.js";

export interface ModelProfile { provider:string; model:string; effort?:string }
export interface PublicationConfig {
  /** Named Git remote only. Authentication stays outside this configuration. */
  remote:string;
  /** Explicit target base branch; no guessing production defaults. */
  baseBranch:string;
  draft:true;
}
export interface FinalizationConfig {
  /** Real PI WEB ID, or "auto" until opted-in provisioning resolves it. */
  workspaceId:string;
  /** End-to-end YOLO: promote Draft PR to ready and use GitHub auto-merge. */
  autoMerge:boolean;
}
export type AgentRuntime="durable"|"pi-web";
export interface AutopilotConfig {
  /** Newly admitted Workflows use Pi Durable unless native Pi is selected.
   * Legacy persisted records are migrated as pi-web, not silently switched. */
  runtime:AgentRuntime;
  /** Explicit finite diagnostic opt-in; native execution cannot enforce it. */
  automaticDiagnosis?:AutomaticDiagnosisPolicy;
  /** Explicitly serialize implementation DAGs to avoid divergent pre-QC fan-in merges. */
  convergenceMode?:"linearized";
  /** No final Git integration for legacy configurations unless set explicitly. */
  finalization?:FinalizationConfig;
  /** Explicit permission to create missing linked Worktrees when Autopilot starts. */
  managedWorktrees?:true;
  /** Configured publication target enables YOLO push + Draft PR creation.
   * Legacy saved configurations without this field never acquire new network effects. */
  publication?:PublicationConfig;
  /** Workflow-local admission budget; running and QC sessions share it. */
  maxConcurrentRuns?:number;
  /** Cap opt-in managed Worktree creation before any Git mutation. */
  maxManagedWorktrees?:number;
  /** Existing PI WEB linked, isolated worktree per implementation Task. */
  workspaces:Record<string,string>;
  /** An optional independent prelinked read-only QC snapshot workspace, per Task. */
  reviewWorkspaces?:Record<string,string>;
  models:Record<Seat,ModelProfile>;
  /** Host executes directly as argv, with no shell and no inherited secret overrides. */
  test:{file:string;args:string[];timeoutMs:number;execution?:"sandbox"|"trusted-host"};
  maxAttempts:number;
}
export interface AutopilotRecord {
  projectId:string; orchestraWorkspaceId:string; workflowId:string;
  enabled:boolean; status:string; updatedAt:string; config:AutopilotConfig;
  /** Monotone operator control/configuration generation, independent of progress text. */
  generation:number;
}
export interface EvidenceReceipt {
  ref:string; runId:string; sessionId:string; kind:string; text:string; createdAt:string;
}
export interface PreparedTransition {
  kind:string;action:WorkflowAction;details:string;
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
  const runtime=raw.runtime===undefined?"durable":raw.runtime;
  if(runtime!=="durable"&&runtime!=="pi-web")
    throw new Error("Agent runtime must be durable or pi-web");
  if(raw.convergenceMode!==undefined&&raw.convergenceMode!=="linearized")
    throw new Error("Convergence mode must be linearized if configured");
  if(raw.maxConcurrentRuns!==undefined&&
    (!Number.isSafeInteger(raw.maxConcurrentRuns)||(raw.maxConcurrentRuns as number)<1||
      (raw.maxConcurrentRuns as number)>32))
    throw new Error("maxConcurrentRuns must be 1..32");
  if(raw.maxManagedWorktrees!==undefined&&
    (!Number.isSafeInteger(raw.maxManagedWorktrees)||(raw.maxManagedWorktrees as number)<1||
      (raw.maxManagedWorktrees as number)>64))
    throw new Error("maxManagedWorktrees must be 1..64");
  const models=Object.create(null) as Record<Seat,ModelProfile>;
  for(const seat of seats){
    const p=object(profiles[seat]);
    models[seat]={provider:str(p.provider,120),model:str(p.model,160),
      ...(p.effort===undefined?{}:{effort:str(p.effort,32)})};
  }
  if(raw.managedWorktrees!==undefined&&raw.managedWorktrees!==true)
    throw new Error("managedWorktrees must be true when configured");
  const managedWorktrees=raw.managedWorktrees===true;
  const workspaces=workspaceMap(raw.workspaces??(managedWorktrees?{}:undefined));
  // A single modifying Worktree shared across Tasks is never safe, even when
  // the current workflow happens to dispatch those Tasks sequentially.
  if(new Set(Object.values(workspaces)).size!==Object.keys(workspaces).length)
    throw new Error("Each implementation Task requires a distinct linked worktree");
  let finalization:FinalizationConfig|undefined;
  if(raw.finalization!==undefined){
    const f=object(raw.finalization);
    if(Object.keys(f).some(k=>!["workspaceId","autoMerge"].includes(k)))
      throw new Error("Unknown finalization field");
    const workspaceId=str(f.workspaceId,128);
    if(workspaceId==="auto"&&!managedWorktrees)
      throw new Error("Automatic final Workspace requires managedWorktrees opt-in");
    if(Object.values(workspaces).includes(workspaceId)||
      (raw.reviewWorkspaces!==undefined&&
        Object.values(workspaceMap(raw.reviewWorkspaces)).includes(workspaceId)))
      throw new Error("Final integration Workspace must be distinct from all code/QC Worktrees");
    if(f.autoMerge!==true&&f.autoMerge!==false)
      throw new Error("Finalization autoMerge must be a boolean");
    finalization={workspaceId,autoMerge:f.autoMerge};
  }
  const t=object(raw.test),file=str(t.file,256);
  const execution=t.execution??"sandbox";
  if(execution!=="sandbox"&&execution!=="trusted-host")
    throw new Error("Test execution must be sandbox or explicitly trusted-host");
  if(!Array.isArray(t.args)||t.args.length>32||
    !t.args.every(x=>typeof x==="string"&&x.length<=1000))
    throw new Error("Test command must be an argv list of <=32 bounded strings");
  const timeoutMs=t.timeoutMs===undefined?60000:t.timeoutMs;
  if(!Number.isSafeInteger(timeoutMs)||typeof timeoutMs!=="number"||timeoutMs<1000||timeoutMs>120000)
    throw new Error("Test timeout must be 1000..120000ms");
  const maxAttempts=raw.maxAttempts??5;
  if(!Number.isSafeInteger(maxAttempts)||typeof maxAttempts!=="number"||maxAttempts<1||maxAttempts>10)
    throw new Error("Implementation attempt budget must be 1..10");
  let publication:PublicationConfig|undefined;
  if(raw.publication!==undefined){
    const p=object(raw.publication);
    if(Object.keys(p).some(k=>!["remote","baseBranch","draft"].includes(k)))
      throw new Error("Unknown publication field");
    const remote=str(p.remote,60),baseBranch=str(p.baseBranch,120);
    if(!/^[a-zA-Z][a-zA-Z0-9-]{0,59}$/.test(remote)||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(baseBranch)||
      baseBranch.includes("..")||baseBranch.includes("//")||
      baseBranch.endsWith(".")||baseBranch.endsWith("/")||
      baseBranch.includes("@{")||baseBranch.endsWith(".lock"))
      throw new Error("Invalid Git publication remote/base branch");
    if(p.draft!==true)throw new Error("Initial automatic PR publication must be Draft");
    publication={remote,baseBranch,draft:true};
  }
  if(finalization&&!publication)
    throw new Error("Final integration requires a configured GitHub publication destination");
  const automaticDiagnosis=parseAutomaticDiagnosisPolicy(raw.automaticDiagnosis);
  if(automaticDiagnosis&&runtime!=="durable")throw new Error("Automatic diagnosis requires the budgeted Durable runtime");
  return {runtime,workspaces,...(automaticDiagnosis?{automaticDiagnosis}:{}),
    ...(raw.maxConcurrentRuns===undefined?{}:{maxConcurrentRuns:raw.maxConcurrentRuns as number}),
    ...(raw.maxManagedWorktrees===undefined?{}:{maxManagedWorktrees:raw.maxManagedWorktrees as number}),
    ...(raw.convergenceMode==="linearized"?{convergenceMode:"linearized" as const}:{}),
    ...(managedWorktrees?{managedWorktrees:true as const}:{}),
    ...(finalization?{finalization}:{}),
    ...(raw.reviewWorkspaces===undefined?{}:{
    reviewWorkspaces:workspaceMap(raw.reviewWorkspaces)}),
    ...(publication?{publication}:{}),
    models,test:{file,args:t.args as string[],timeoutMs,execution},maxAttempts};
}
export function automationScope(projectId:string,workspaceId:string):string {
  return JSON.stringify([str(projectId,512),str(workspaceId,512)]);
}
export class StaleControlError extends Error {
  constructor(){super("Autopilot control generation changed; stale work discarded");}
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
      CREATE TABLE IF NOT EXISTS autopilot_contract_reads(
        scope TEXT NOT NULL,workflow_id TEXT NOT NULL,run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,manifest_sha TEXT NOT NULL,contract_index INTEGER NOT NULL,
        PRIMARY KEY(scope,workflow_id,run_id,session_id,manifest_sha,contract_index));
      CREATE TABLE IF NOT EXISTS autopilot_launches(
        scope TEXT NOT NULL,workflow_id TEXT NOT NULL,run_id TEXT NOT NULL,
        job_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(scope,workflow_id,run_id));
      CREATE TABLE IF NOT EXISTS autopilot_prepared(
        scope TEXT NOT NULL,workflow_id TEXT NOT NULL,run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,kind TEXT NOT NULL,
        action_json TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(scope,workflow_id,run_id));
    `);
    const columns=this.db.prepare("PRAGMA table_info(autopilots)").all() as {name:string}[];
    if(!columns.some(c=>c.name==="generation"))
      this.db.exec("ALTER TABLE autopilots ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
  }
  close():void{this.db.close();}
  /** Pre-Durable configurations remain on native PI WEB Sessions,
   * including currently running Workflows after a daemon upgrade. */
  private persisted(raw:unknown):AutopilotConfig{
    const value=object(raw);
    return parseAutopilotConfig(value.runtime===undefined?
      {...value,runtime:"pi-web"}:value);
  }
  save(projectId:string,workspaceId:string,workflowId:string,input:unknown,
    expectedGeneration?:number):AutopilotRecord {
    const config=parseAutopilotConfig(input),scope=automationScope(projectId,workspaceId);
    str(workflowId,128);
    const at=new Date().toISOString();
    if(expectedGeneration!==undefined&&this.get(projectId,workspaceId,workflowId)?.generation!==expectedGeneration)
      throw new StaleControlError();
    const saved=this.db.prepare(`INSERT INTO autopilots(scope,workflow_id,config_json,enabled,status,updated_at)
      VALUES(?,?,?,0,'Configured. Start explicitly.',?)
      ON CONFLICT(scope,workflow_id) DO UPDATE SET config_json=excluded.config_json,
      enabled=0,status='Configuration changed; explicit restart required',updated_at=excluded.updated_at,
      generation=autopilots.generation+1
      WHERE ? IS NULL OR autopilots.generation=?`)
      .run(scope,workflowId,JSON.stringify(config),at,expectedGeneration??null,expectedGeneration??null);
    if(saved.changes!==1)throw new StaleControlError();
    return this.get(projectId,workspaceId,workflowId)!;
  }
  get(projectId:string,workspaceId:string,workflowId:string):AutopilotRecord|undefined {
    const scope=automationScope(projectId,workspaceId);
    const row=this.db.prepare(`SELECT config_json,enabled,status,updated_at,generation FROM autopilots
      WHERE scope=? AND workflow_id=?`).get(scope,workflowId) as
      {config_json:string;enabled:number;status:string;updated_at:string;generation:number}|undefined;
    return row?{projectId,orchestraWorkspaceId:workspaceId,workflowId,
      enabled:row.enabled===1,status:row.status,updatedAt:row.updated_at,generation:row.generation,
      config:this.persisted(JSON.parse(row.config_json))}:undefined;
  }
  /** Scheduler inventory, unlike the bounded UI list: every enabled workflow. */
  listMaintenanceCandidates():AutopilotRecord[]{
    const rows=this.db.prepare(`SELECT scope,workflow_id,config_json,enabled,status,updated_at,generation
      FROM autopilots WHERE enabled=0 ORDER BY updated_at ASC`).all() as
      {scope:string;workflow_id:string;config_json:string;enabled:number;status:string;updated_at:string;generation:number}[];
    return rows.map(row=>{
      const [projectId,orchestraWorkspaceId]=JSON.parse(row.scope) as [string,string];
      return {projectId,orchestraWorkspaceId,workflowId:row.workflow_id,
        config:this.persisted(JSON.parse(row.config_json)),
        enabled:false,status:row.status,updatedAt:row.updated_at,generation:row.generation};
    });
  }
  listEnabled():AutopilotRecord[]{
    const rows=this.db.prepare(`SELECT scope,workflow_id,config_json,enabled,status,updated_at,generation
      FROM autopilots WHERE enabled=1 ORDER BY updated_at ASC`).all() as
      {scope:string;workflow_id:string;config_json:string;enabled:number;status:string;updated_at:string;generation:number}[];
    return rows.map(row=>{
      const [projectId,orchestraWorkspaceId]=JSON.parse(row.scope) as [string,string];
      return {projectId,orchestraWorkspaceId,workflowId:row.workflow_id,
        config:this.persisted(JSON.parse(row.config_json)),
        enabled:true,status:row.status,updatedAt:row.updated_at,generation:row.generation};
    });
  }
  list():AutopilotRecord[]{
    const rows=this.db.prepare(`SELECT scope,workflow_id,config_json,enabled,status,updated_at,generation
      FROM autopilots ORDER BY updated_at DESC LIMIT 200`).all() as
      {scope:string;workflow_id:string;config_json:string;enabled:number;status:string;updated_at:string;generation:number}[];
    return rows.map(row=>{
      const [projectId,orchestraWorkspaceId]=JSON.parse(row.scope) as [string,string];
      return {projectId,orchestraWorkspaceId,workflowId:row.workflow_id,
        config:this.persisted(JSON.parse(row.config_json)),
        enabled:row.enabled===1,status:row.status,updatedAt:row.updated_at,generation:row.generation};
    });
  }
  setStatus(projectId:string,workspaceId:string,workflowId:string,enabled:boolean,status:string):void {
    str(status,1000);
    const result=this.db.prepare(`UPDATE autopilots SET enabled=?,status=?,updated_at=?,generation=generation+1
      WHERE scope=? AND workflow_id=?`).run(enabled?1:0,status,new Date().toISOString(),
      automationScope(projectId,workspaceId),workflowId);
    if(result.changes!==1)throw new Error("Configure the workflow before starting");
  }
  /** A progress update cannot resurrect a paused/reconfigured Workflow. */
  setProgress(record:AutopilotRecord,enabled:boolean,status:string):boolean {
    str(status,1000);
    const result=this.db.prepare(`UPDATE autopilots SET enabled=?,status=?,updated_at=?,
      generation=generation+CASE WHEN enabled<>? THEN 1 ELSE 0 END
      WHERE scope=? AND workflow_id=? AND generation=?`).run(
        enabled?1:0,status,new Date().toISOString(),enabled?1:0,
        automationScope(record.projectId,record.orchestraWorkspaceId),
        record.workflowId,record.generation);
    return result.changes===1;
  }
  assertCurrent(record:AutopilotRecord,requireEnabled=true):void {
    const latest=this.get(record.projectId,record.orchestraWorkspaceId,record.workflowId);
    if(!latest||latest.generation!==record.generation||(requireEnabled&&!latest.enabled))
      throw new StaleControlError();
  }
  contractReads(binding:AgentBinding,manifestSha:string):number[]{
    if(!binding.sessionId||!/^[a-f0-9]{64}$/.test(manifestSha))throw new Error("Invalid final contract identity");
    return (this.db.prepare("SELECT contract_index AS n FROM autopilot_contract_reads WHERE scope=? AND workflow_id=? AND run_id=? AND session_id=? AND manifest_sha=? ORDER BY contract_index")
      .all(automationScope(binding.projectId,binding.orchestraWorkspaceId),binding.workflowId,
        binding.runId,binding.sessionId,manifestSha) as {n:number}[]).map(r=>r.n);
  }
  recordContractRead(binding:AgentBinding,manifestSha:string,index:number):void{
    this.contractReads(binding,manifestSha);
    if(!Number.isSafeInteger(index)||index<0||index>=64)throw new Error("Invalid final contract index");
    this.db.prepare("INSERT INTO autopilot_contract_reads VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .run(automationScope(binding.projectId,binding.orchestraWorkspaceId),binding.workflowId,
        binding.runId,binding.sessionId,manifestSha,index);
  }
  /** Freeze the host-built initial input before native/Durable Session creation. */
  recordLaunch(job:LaunchJob):void {
    const {controlGeneration:_,...frozen}=job;
    const json=JSON.stringify(frozen),scope=automationScope(job.projectId,job.orchestraWorkspaceId);
    if(json.length>40000)throw new Error("Launch contract exceeds durable input budget");
    this.db.prepare("INSERT INTO autopilot_launches VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING")
      .run(scope,job.workflowId,job.runId,json,new Date().toISOString());
    const stored=this.db.prepare("SELECT job_json FROM autopilot_launches WHERE scope=? AND workflow_id=? AND run_id=?")
      .get(scope,job.workflowId,job.runId) as {job_json:string};
    if(stored.job_json!==json)throw new Error("Initial Run contract changed after reservation");
  }
  findLaunch(binding:Pick<AgentBinding,"projectId"|"orchestraWorkspaceId"|"workflowId"|"runId">):LaunchJob|undefined {
    const row=this.db.prepare("SELECT job_json FROM autopilot_launches WHERE scope=? AND workflow_id=? AND run_id=?")
      .get(automationScope(binding.projectId,binding.orchestraWorkspaceId),binding.workflowId,binding.runId) as {job_json:string}|undefined;
    return row?JSON.parse(row.job_json) as LaunchJob:undefined;
  }
  launchFor(binding:AgentBinding):LaunchJob {
    const result=this.findLaunch(binding);
    if(!result)throw new Error("No frozen initial input exists for this legacy Run; never reconstruct or replay it blindly");
    return result;
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
  /** Freeze the verified transition once before a potentially conflicting
   * Workflow CAS. Retries reuse this receipt, not nondeterministic test output. */
  preparedTransition(binding:AgentBinding):PreparedTransition|undefined{
    if(!binding.sessionId)return;
    const row=this.db.prepare(`SELECT session_id,kind,action_json,details FROM autopilot_prepared
      WHERE scope=? AND workflow_id=? AND run_id=?`).get(
        automationScope(binding.projectId,binding.orchestraWorkspaceId),
        binding.workflowId,binding.runId) as
        {session_id:string;kind:string;action_json:string;details:string}|undefined;
    if(!row)return;
    if(row.session_id!==binding.sessionId)
      throw new Error("Prepared transition belongs to another Pi Session");
    return {kind:row.kind,action:JSON.parse(row.action_json) as WorkflowAction,
      details:row.details};
  }
  prepareTransition(binding:AgentBinding,kind:string,action:WorkflowAction,
    details:string):PreparedTransition{
    if(!binding.sessionId)throw new Error("Cannot prepare unassigned Run");
    str(kind,60);str(details,3500);
    const old=this.preparedTransition(binding);
    if(old){
      if(old.kind!==kind)throw new Error("Prepared Run kind mismatch");
      return old;
    }
    this.db.prepare(`INSERT INTO autopilot_prepared(
      scope,workflow_id,run_id,session_id,kind,action_json,details,created_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,workflow_id,run_id) DO NOTHING`)
      .run(automationScope(binding.projectId,binding.orchestraWorkspaceId),
        binding.workflowId,binding.runId,binding.sessionId,kind,
        JSON.stringify(action),details,new Date().toISOString());
    const prepared=this.preparedTransition(binding);
    if(!prepared||prepared.kind!==kind)throw new Error("Prepared Run transition conflicted");
    return prepared;
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
