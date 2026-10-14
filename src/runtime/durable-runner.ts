/** Pi Durable one-shot sessions. Runtime success is proved from committed input
 * outcomes, not merely from an idle Harness or a model-authored report. */
import {createHash} from "node:crypto";
import {mkdirSync,realpathSync,existsSync,lstatSync,chmodSync} from "node:fs";
import {join,resolve,isAbsolute} from "node:path";
import {BACKGROUND_CONTEXT,withAbortSignal} from "@earendil-works/chord/context";
import {Type} from "@earendil-works/pi-ai";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import type {Models} from "@earendil-works/pi-ai/models";
import type {ModelThinkingLevel} from "@earendil-works/pi-ai";
import {Harness,createRegistry,defineExtension,defineTool,watchEvents,
  type AgentEvent,type AgentEventStream,type Conversation,type ToolRegistration} from "@earendil-works/pi-durable";
import {CodingTools} from "@earendil-works/pi-durable/tools";
import {NodeExecutionEnv} from "@earendil-works/pi-durable/env/node";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import type {AgentRegistry,AgentBinding,Reservation} from "./registry.js";
import type {RuntimeActivity} from "./protocol.js";
import type {AutopilotLedger,ModelProfile} from "../automation/ledger.js";
import type {RunReport} from "../automation/report.js";
import {readonlyDiscoveryTools} from "./repository-discovery.js";
import {productionPolicy,assertProductionModel} from "../security/policy.js";
import {productionTools} from "./production-tools.js";
import {sandboxExec,inspectSandboxWorkspace} from "../security/sandbox.js";
import {reportTools} from "./durable-reports.js";
import {withModelBudget} from "../security/model-boundary.js";
import {RunSafetyLedger,DEFAULT_LIMITS,classifyInputOutcomes,type RunLimits} from "../security/run-safety.js";

export type DurableKind="implementation"|"qc"|"diagnosis"|"synthesis"|"planning"|"workflow_plan";
export interface DurableLaunch {
  reservation:Reservation;model:ModelProfile;cwd:string;kind:DurableKind;prompt:string;
  assertAdmitted?:()=>void;
}
export interface FinalQcContract {
  taskId:string;title:string;description?:string;acceptanceCriteria?:string[];qcSha:string;
}
interface DurableCallbacks {
  dataDirectory:string;agents:AgentRegistry;ledger:AutopilotLedger;
  finalContracts?(binding:AgentBinding):FinalQcContract[];
  models?:Models;
  limits?:RunLimits;
  lifetimeSignal?:AbortSignal;
  activity(binding:AgentBinding,event:RuntimeActivity):void;
  changed(binding:AgentBinding):void;
  report(binding:AgentBinding,report:RunReport):void;
  wake(binding:AgentBinding):void;
}
type Active={
  harness:Awaited<ReturnType<typeof Harness.open>>;root:Conversation;stream:AgentEventStream;
  binding:AgentBinding;closed:boolean;verified:boolean;finishing:boolean;seq:number;text:string;
  abortRequested:boolean;completion:Promise<void>|undefined;timer:ReturnType<typeof setTimeout>|undefined;
};
const ID=/^durable:([a-f0-9]{64})$/;
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
function sessionHash(r:Reservation):string{return hash(JSON.stringify([r.projectId,r.orchestraWorkspaceId,r.workflowId,r.runId]));}
function identity(r:Reservation):string{return "durable:"+sessionHash(r);}
export function isDurableSession(id:string|null):boolean{return id!==null&&ID.test(id);}
function shellEnvironment():NodeJS.ProcessEnv{
  const env:NodeJS.ProcessEnv={...process.env};
  for(const key of Object.keys(env))if(/(?:^GH_|^GITHUB_|^GIT_ASKPASS|^GIT_CONFIG|^AWS_|^AZURE_|^OPENAI_|^ANTHROPIC_|^GOOGLE_|^GEMINI_|^CLOUDFLARE_|^RADIUS_|API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i.test(key))delete env[key];
  return env;
}
export function isSafeBashCommand(command:string,allowFinalLocalMerge=false):boolean{
  const c=command.toLowerCase();
  if(!allowFinalLocalMerge&&/\bgit\s+merge\b/.test(c))return false;
  return !/\b(?:git\s+(?:push|remote|fetch|pull|rebase|reset|checkout|switch|worktree\s+remove)|gh\s+(?:pr|repo|api|workflow|release)\s+|git\s+config\s+.*(?:credential|http\.)|curl\s+.*github\.com|wget\s+.*github\.com)\b/.test(c);
}
export function durableActivity(event:AgentEvent,text:string,sequence:number):{event:RuntimeActivity;text:string}|undefined{
  const at=Date.now(),bounded=(s:string)=>s.slice(-512);
  if(event.type==="run_start")return {event:{kind:"agent_started",at,sequence,text:"Pi Durable run started"},text:""};
  if(event.type==="message_update"){
    const delta=event.changes.map(c=>c.type==="text_delta"?c.delta:"").join("");
    if(!delta)return;const updated=bounded(text+delta);
    return {event:{kind:"message_delta",at,sequence,text:updated},text:updated};
  }
  if(event.type==="message_end")return {event:{kind:"message_completed",at,sequence,text:bounded(text||"Assistant message committed")},text:""};
  if(event.type==="tool_execution_start")return {event:{kind:"tool_started",at,sequence,text:event.toolName.slice(0,100)},text};
  if(event.type==="tool_execution_end")return {event:{kind:event.entry?.model?.[0]?.role==="toolResult"&&event.entry.model[0].isError?"error":"tool_finished",at,sequence,text:event.toolName.slice(0,100)+" finished"},text};
  if(event.type==="task_failed")return {event:{kind:"error",at,sequence,text:"Durable task failed: "+event.kind.slice(0,100)},text};
  return;
}
export async function createDurableModels(authPath?:string):Promise<Models>{
  return ModelRuntime.create({allowModelNetwork:false,refreshOnCreate:false,...(authPath?{authPath}:{})});
}
import {assertStorageAdmission} from "../security/storage-admission.js";
export class DurableRunHost {
  private modelsPromise:Promise<Models>|undefined;
  private readonly active=new Map<string,Active>();
  private readonly opening=new Map<string,Promise<Active>>();
  private readonly stopping=new Set<Promise<void>>();
  private stopFailure:unknown;
  private latchFailure:unknown;
  private readonly safety:RunSafetyLedger;
  private closing=false;
  private readonly stopSignal=new AbortController();
  private latchInterruptedOutcomes():void{
    // Explicit dispose and owner loss have identical uncertainty semantics:
    // an unfinished input must never become a successful or replayable Run.
    for(const live of this.active.values()){
      try{
        const current=this.current(live.binding),key=sessionHash(this.reservation(live.binding));
        if(!current||["settled","sealed","failed"].includes(current.phase)||!this.safety.inputs(key).length)continue;
        if(!this.safety.get(key)?.outcome)this.safety.finish(key,"uncertain");
        const stopped=this.options.agents.requestAbort(current);
        this.options.changed(this.options.agents.update(stopped,"uncertain"));
      }catch(error){
        // Preserve the failure for close(); workers still receive abort, but
        // ownership must not be transferred if uncertainty was not persisted.
        this.latchFailure=error;
      }
    }
  }
  private readonly onLifetimeAbort=()=>{void this.close().catch(()=>{});};
  private closeFlight:Promise<void>|undefined;
  constructor(private readonly options:DurableCallbacks){
    this.safety=new RunSafetyLedger(join(options.dataDirectory,"run-safety.sqlite"));
    if(options.lifetimeSignal?.aborted)this.onLifetimeAbort();
    else options.lifetimeSignal?.addEventListener("abort",this.onLifetimeAbort,{once:true});
  }
  private assertLive():void{
    this.options.lifetimeSignal?.throwIfAborted();
    this.stopSignal.signal.throwIfAborted();
    if(this.closing)throw new Error("Durable host shutting down");
  }
  connected(id:string):boolean{return this.active.get(id)?.closed===false;}
  /** No persisted provisional report, missing outcome, or interrupted turn may
   * authorize QC, planning, implementation, or human proposal acceptance.
   * Call at the workflow transition boundary, not from a model-provided tool. */
  assertProvedCompleted(binding:AgentBinding):void{
    if(!isDurableSession(binding.sessionId)||
      !["settled","sealed"].includes(binding.phase)||
      binding.abortRequested===1||
      this.safety.get(sessionHash(this.reservation(binding)))?.outcome!=="completed")
      throw new Error("Durable Run lacks a persisted successful input outcome");
  }
  private configuredModels():Promise<Models>{
    if(this.options.models)return Promise.resolve(this.options.models);
    if(!this.modelsPromise)this.modelsPromise=createDurableModels().catch(error=>{this.modelsPromise=undefined;throw error;});
    return this.modelsPromise;
  }
  private async validatedModels(model:ModelProfile):Promise<Models>{
    const levels=new Set(["off","minimal","low","medium","high","xhigh","max"]);
    if(model.effort!==undefined&&!levels.has(model.effort))throw new Error("Unsupported Pi Durable thinking level: "+model.effort);
    const production=productionPolicy(this.options.dataDirectory);
    if(production)assertProductionModel(production,model);
    const models=await this.configuredModels();
    if(!models.getModel(model.provider,model.model))throw new Error("Pi Durable model is not in the configured Pi catalog: "+model.provider+"/"+model.model);
    if(!this.options.models){
      let authorized=false;
      try{authorized=Boolean(await models.getAuth(model.provider));}
      catch{throw new Error("Pi Durable provider authentication failed for "+model.provider+"; run pi auth check --provider "+model.provider+" as the daemon OS user");}
      if(!authorized)throw new Error("Pi Durable provider is not authenticated: "+model.provider+"; authenticate Pi as the daemon OS user first");
    }
    return models;
  }
  private path(r:Reservation):string{
    const directory=join(resolve(this.options.dataDirectory),"durable-runs");
    mkdirSync(directory,{recursive:true,mode:0o700});
    if(realpathSync(directory)!==resolve(directory)||!lstatSync(directory).isDirectory())throw new Error("Unsafe Durable state directory");
    const path=join(directory,sessionHash(r)+".sqlite");
    if(existsSync(path)){const stat=lstatSync(path);if(!stat.isFile()||stat.nlink!==1)throw new Error("Unsafe Durable SQLite target");}
    return path;
  }
  private reservation(b:AgentBinding):Reservation{
    return {projectId:b.projectId,orchestraWorkspaceId:b.orchestraWorkspaceId,workflowId:b.workflowId,
      taskId:b.taskId,runId:b.runId,workspaceId:b.workspaceId,seat:b.seat,requestId:b.requestId};
  }
  private current(b:AgentBinding):AgentBinding|undefined{
    return this.options.agents.getRun(b.projectId,b.orchestraWorkspaceId,b.workflowId,b.runId);
  }
  private async open(binding:AgentBinding,cwd:string,kind:DurableKind,model:ModelProfile):Promise<Active>{
    this.assertLive();
    const r=this.reservation(binding),sid=identity(r),key=sessionHash(r);
    if(binding.sessionId!==null&&binding.sessionId!==sid)throw new Error("Durable session ID does not match its scoped Run");
    if(!cwd||!isAbsolute(cwd))throw new Error("Durable requires an absolute trusted Worktree");
    const canonical=realpathSync(cwd);
    if(canonical!==resolve(cwd))throw new Error("Durable Worktree path is not canonical");
    const found=this.active.get(sid);if(found&&!found.closed)return found;
    const opening=this.opening.get(sid);if(opening)return opening;
    const future=(async()=>{
      const models=await this.validatedModels(model);
      if(this.closing)throw new Error("Durable host shutting down during open");
      const record=this.safety.reserve(key,hash(JSON.stringify([kind,canonical,model])),
        productionPolicy(this.options.dataDirectory)?.limits??this.options.limits??DEFAULT_LIMITS,Date.parse(binding.createdAt));
      const registry=createRegistry();
      const finalQc=kind==="qc"&&binding.taskId==="mm-final-integration";
      const contracts=finalQc?this.options.finalContracts?.(binding):undefined;
      if(finalQc&&(!contracts||contracts.length===0||contracts.length>64))throw new Error("Final QC needs 1..64 host-verified source contracts");
      const contractBinding={...binding,sessionId:sid};
      const manifestSha=hash(JSON.stringify(contracts??[])),ledger=this.options.ledger;
      const seen=new Set<number>(contracts?ledger.contractReads(contractBinding,manifestSha):[]);
      const contractTool=contracts?defineTool({name:"mm_final_qc_contract",
        description:"Return the full immutable acceptance contract for an original source Task.",
        parameters:Type.Object({index:Type.Integer({minimum:0,maximum:63})}),replay:"safe",
        async execute(args){
          if(!Number.isSafeInteger(args.index)||args.index<0||args.index>=contracts.length)throw new Error("Final QC source contract index out of bounds");
          ledger.recordContractRead(contractBinding,manifestSha,args.index);seen.add(args.index);
          return {output:[{type:"text" as const,text:JSON.stringify(contracts[args.index])}]};
        }}):undefined;
      const production=productionPolicy(this.options.dataDirectory);
      const discovery=production?[]:readonlyDiscoveryTools(canonical);
      const reports=reportTools(kind,binding.runId,report=>{
        this.safety.assertActive(key);
        const b=this.current(binding);
        if(!b?.sessionId||b.sessionId!==sid)throw new Error("Durable report not authorized by exact Run reservation");
        this.options.report(b,report);
      },Date.parse(binding.createdAt),contracts?()=>seen.size===contracts.length:undefined);
      const provided=kind==="qc"?reports.qc:kind==="planning"?reports.plan:kind==="workflow_plan"?reports.proposal:reports.task;
      const allowedMerges=production&&kind==="implementation"&&binding.taskId==="mm-final-integration"?
        this.options.ledger.launchFor(binding).requiredAncestors??[]:[];
      const coding=(production?productionTools(canonical,kind==="implementation",allowedMerges,
        production,()=>this.safety.assertActive(key)):CodingTools.tools??[]).map(tool=>{
        if(tool.name==="read")return {...tool,replay:"safe" as const};
        if(tool.name!=="bash")return tool;
        return {...tool,async execute(args:never,api:never,context:never){
          const command=String((args as {command?:string}).command??"");
          if(!isSafeBashCommand(command,kind==="implementation"&&binding.taskId==="mm-final-integration"))
            throw new Error("Direct GitHub publication and dangerous Git mutations must use the Orchestrator's exact QC/permission gates");
          return tool.execute(args,api,context);
        }};
      }) as ToolRegistration[];
      registry.install(defineExtension({name:"micromanager-coding-tools",tools:coding}));
      registry.install(defineExtension({name:"micromanager-durable-reports",tools:[provided,...(contractTool?[contractTool]:[]),...discovery]}));
      // Enforce at the actual executable boundary; hook exceptions can be
      // swallowed by the public SDK's observational hook dispatcher.
      const budgetedTools=(tools:readonly ToolRegistration[])=>tools.map(tool=>({
        ...tool,async execute(args:never,api:never,context:never){
          thisHost.assertLive();thisHost.safety.consume(key,"tool");
          const original=(context as {abortSignal?:AbortSignal}|undefined)?.abortSignal;
          const signal=original?AbortSignal.any([original,thisHost.stopSignal.signal]):thisHost.stopSignal.signal;
          return tool.execute(args,api,withAbortSignal(signal,context));
        },
      })) as ToolRegistration[];
      const thisHost=this;
      registry.install(defineExtension({name:"micromanager-coding-tools",tools:budgetedTools(coding)}));
      registry.install(defineExtension({name:"micromanager-durable-reports",
        tools:budgetedTools([provided,...(contractTool?[contractTool]:[]),...discovery])}));
      const harness=await Harness.open(await openNodeSqliteStorage(this.path(r)),{
        models:withModelBudget(models,()=>{this.assertLive();this.safety.consume(key,"model");}),registry,settings:{toolExecution:"sequential",compaction:{enabled:false},
          stream:{maxRetries:0,timeoutMs:120_000},retry:{maxRetries:2},
          progress:{partialIntervalMs:100,outputIntervalMs:100}},
        env:({cwd})=>{
          if(resolve(cwd??"")!==canonical)throw new Error("Durable execution cwd changed after trusted Workspace validation");
          if(production)return undefined;
          return new NodeExecutionEnv({cwd:canonical,shellEnv:shellEnvironment()});
        }},BACKGROUND_CONTEXT);
      try{
        chmodSync(this.path(r),0o600);
        if(this.closing)throw new Error("Durable host shutting down during Harness open");
        const read=coding.find(t=>t.name==="read");if(!read)throw new Error("Pi Durable CodingTools lacks the safe read tool");
        const tools:ToolRegistration[]=(kind==="implementation"?coding:[...(production?coding:[read,...discovery]),...(contractTool?[contractTool]:[]),provided]) as ToolRegistration[];
        const root=await harness.root(BACKGROUND_CONTEXT,{agent:{
          model:{provider:model.provider,modelId:model.model},
          ...(model.effort?{thinkingLevel:model.effort as ModelThinkingLevel}:{}),
          cwd:canonical,tools,modelTools:tools,
          instructions:kind==="implementation"?
            (production?"All repository tools are sandboxed. Git metadata is not mounted in bash; use mm_git_status, mm_git_diff, mm_git_commit and, for final integration only, mm_git_merge_source. ":"")+
            "Implement only in this isolated Git Worktree. Commit verified code. No direct git push, gh PR, remote merge or protected branch mutations; the Orchestrator publishes only after sealed QC.":
            "READ ONLY. Do not edit source, create processes or write files. Inspect the exact provided commit. Submit the required mm_* report once.",
        }});
        const stream=await watchEvents(harness,root.id,BACKGROUND_CONTEXT);
        const live:Active={harness,root,stream,binding,closed:false,verified:false,finishing:false,
          seq:0,text:"",abortRequested:false,completion:undefined,timer:undefined};
        stream.start(async events=>{
          if(live.closed)return;
          for(const event of events){
            const v=durableActivity(event,live.text,++live.seq);if(!v)continue;live.text=v.text;
            const b=this.current(binding);
            if(b?.sessionId!==sid||b.phase==="sealed"||b.phase==="failed")continue;
            this.options.activity(b,v.event);
          }
        });
        if(this.closing)throw new Error("Durable host shutting down during open");
        if(!record.outcome&&record.deadline>Date.now()){
          live.timer=setTimeout(()=>{void this.expire(live);},record.deadline-Date.now());
          live.timer.unref();
        }
        this.active.set(sid,live);return live;
      }catch(error){await harness.close(BACKGROUND_CONTEXT).catch(()=>{});throw error;}
    })();
    this.opening.set(sid,future);
    try{return await future;}finally{if(this.opening.get(sid)===future)this.opening.delete(sid);}
  }
  private async expire(live:Active):Promise<void>{
    if(live.closed||this.closing||live.finishing)return;
    const current=this.current(live.binding);
    if(!current?.sessionId||["settled","sealed","failed"].includes(current.phase))return;
    live.abortRequested=true;
    this.options.changed(this.options.agents.requestAbort(current));
    this.options.activity(current,{kind:"error",at:Date.now(),sequence:++live.seq,
      text:"Run wall-clock budget exhausted; interruption requested"});
    try{await live.root.abort(BACKGROUND_CONTEXT);}catch{await this.stopRun(current).catch(()=>{});}
  }
  private supervise(live:Active):Promise<void>{
    if(live.completion)return live.completion;
    live.completion=live.root.waitForIdle(BACKGROUND_CONTEXT).then(async()=>{
      if(live.closed||this.closing)return;
      live.finishing=true;
      const b=live.binding,key=sessionHash(this.reservation(b));
      let current=this.current(b);
      if(!current||["sealed","settled","failed"].includes(current.phase))return;
      const requests=this.safety.inputs(key);
      const primary="mm:"+key;
      if(!requests.includes(primary))throw new Error("Missing complete input admission inventory");
      const proof=await live.harness.commit(async tx=>{
        const results=[];
        for(const request of requests)results.push(await tx.submissionByRequest(live.root.id,request));
        return results;
      },BACKGROUND_CONTEXT);
      if(live.closed||this.closing)return;
      current=this.current(b);
      if(!current||["sealed","settled","failed"].includes(current.phase))return;
      const outcome=classifyInputOutcomes(proof,current.abortRequested===1||live.abortRequested);
      this.safety.finish(key,outcome);
      if(live.timer)clearTimeout(live.timer);
      if(outcome==="failed"||outcome==="uncertain"){
        this.options.activity(current,{kind:"error",at:Date.now(),sequence:++live.seq,
          text:outcome==="failed"?"Runtime input failed; report cannot finalize this Run":
            "Runtime input outcome is not proved; manual reconciliation required"});
        this.options.changed(this.options.agents.update(current,"uncertain"));
      }else{
        this.options.activity(current,{kind:"agent_settled",at:Date.now(),sequence:++live.seq,
          text:outcome==="aborted"?"Agent interrupted":"Agent settled"});
      }
      this.options.wake(current);
    }).catch(()=>{
      if(live.closed||this.closing)return;
      const current=this.current(live.binding);
      if(current?.sessionId&&!["settled","sealed","failed"].includes(current.phase)){
        this.options.changed(this.options.agents.update(current,"uncertain"));
        this.options.wake(current);
      }
    });
    return live.completion;
  }
  async launch(spec:DurableLaunch):Promise<AgentBinding>{
    this.assertLive();
    const capacityPolicy=productionPolicy(this.options.dataDirectory);
    if(capacityPolicy)assertStorageAdmission(this.options.dataDirectory,capacityPolicy.storage);
    const r=spec.reservation,key=sessionHash(r);
    if(this.closing)throw new Error("Durable host shutting down");
    if(this.options.agents.getRun(r.projectId,r.orchestraWorkspaceId,r.workflowId,r.runId))
      throw new Error("Durable Run already reserved; reconcile, never replay blindly");
    await this.validatedModels(spec.model);
    if(this.closing)throw new Error("Durable host shutting down");
    spec.assertAdmitted?.();
    if(!spec.prompt.trim()||spec.prompt.length>16000||!isAbsolute(spec.cwd)||realpathSync(spec.cwd)!==resolve(spec.cwd))
      throw new Error("Invalid bounded prompt or canonical Worktree");
    const production=productionPolicy(this.options.dataDirectory);
    if(production){
      inspectSandboxWorkspace(spec.cwd,production.maxWorkspaceBytes);
      const probe=await sandboxExec(spec.cwd,["/bin/true"],true,production,this.stopSignal.signal);
      if(probe.exitCode!==0)throw new Error("Production sandbox preflight failed");
    }
    this.assertLive();spec.assertAdmitted?.();
    if(production)assertStorageAdmission(this.options.dataDirectory,production.storage);
    const startedAt=Date.now();
    this.safety.reserve(key,hash(JSON.stringify([spec.kind,realpathSync(spec.cwd),spec.model])),
      production?.limits??this.options.limits??DEFAULT_LIMITS,startedAt);
    this.safety.assertActive(key);
    const reserved=this.options.agents.reserve(r,new Date(startedAt).toISOString());this.options.changed(reserved);
    const active=await this.open(reserved,spec.cwd,spec.kind,spec.model);
    if(this.closing)throw new Error("Durable host closed before Run admission");
    let current=this.options.agents.assign(r,identity(r));this.options.changed(current);
    current=this.options.agents.update(current,"configured",spec.model);
    active.binding=current;this.options.changed(current);
    this.assertLive();spec.assertAdmitted?.();
    if(capacityPolicy)assertStorageAdmission(this.options.dataDirectory,capacityPolicy.storage);
    this.safety.trackInput(key,"mm:"+key);
    const accepted=await active.root.submit({type:"input",content:spec.prompt,requestId:"mm:"+key,whenBusy:"reject"},BACKGROUND_CONTEXT);
    if(!accepted.id)throw new Error("Durable did not commit the exact Run input");
    active.verified=true;current=this.options.agents.get(r.projectId,r.orchestraWorkspaceId,identity(r));
    if(current.phase!=="settled"&&current.phase!=="running")this.options.changed(this.options.agents.update(current,"running"));
    void this.supervise(active);
    return this.options.agents.get(r.projectId,r.orchestraWorkspaceId,identity(r));
  }
  async resumeUnstarted(binding:AgentBinding,spec:DurableLaunch):Promise<AgentBinding>{
    this.assertLive();spec.assertAdmitted?.();
    const capacityPolicy=productionPolicy(this.options.dataDirectory);
    if(capacityPolicy)assertStorageAdmission(this.options.dataDirectory,capacityPolicy.storage);
    if(!isDurableSession(binding.sessionId)||binding.abortRequested===1||!["created","connected","configured"].includes(binding.phase))
      throw new Error("Only an attached, proved-unstarted Durable Run can be recovered");
    if(!existsSync(this.path(this.reservation(binding))))throw new Error("Original Durable storage is missing");
    if(identity(spec.reservation)!==binding.sessionId)throw new Error("Recovery Run identity mismatch");
    if(binding.provider&&binding.provider!==spec.model.provider||binding.model&&binding.model!==spec.model.model||
      binding.effort&&binding.effort!==spec.model.effort)throw new Error("Recovery model identity changed");
    const live=await this.open(binding,spec.cwd,spec.kind,spec.model),key=sessionHash(spec.reservation);
    try{
      const entries=await live.root.entries({},1,undefined,BACKGROUND_CONTEXT);
      const inspection=await live.harness.inspect(BACKGROUND_CONTEXT);
      if(entries.items.length||inspection.tasks.length||inspection.submissions.length||live.verified)
        throw new Error("Durable Session has accepted input/work; zero-input continuation refused");
      this.assertLive();spec.assertAdmitted?.();this.safety.assertActive(key);
      if(capacityPolicy)assertStorageAdmission(this.options.dataDirectory,capacityPolicy.storage);
      this.options.changed(this.options.agents.update(binding,"configured",spec.model));
      this.safety.trackInput(key,"mm:"+key);
      const accepted=await live.root.submit({type:"input",content:spec.prompt,requestId:"mm:"+key,whenBusy:"reject"},BACKGROUND_CONTEXT);
      if(!accepted.id)throw new Error("Durable did not commit the original Run input");
      live.verified=true;const current=this.options.agents.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId!);
      if(!["running","settled","sealed"].includes(current.phase))this.options.changed(this.options.agents.update(current,"running"));
      void this.supervise(live);return this.options.agents.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId!);
    }catch(error){await this.stopRun(binding).catch(()=>{});throw error;}
  }
  async reconnect(binding:AgentBinding,cwd:string,kind:DurableKind):Promise<"running"|"settled"|"uncertain">{
    this.assertLive();
    if(!isDurableSession(binding.sessionId))throw new Error("Not a Pi Durable Run");
    if(this.connected(binding.sessionId!)){
      const active=this.active.get(binding.sessionId!)!;
      if(!active.verified)throw new Error("Durable reconnect is not yet verified");
      const current=this.current(binding)!;
      return current.phase==="settled"||current.phase==="sealed"?"settled":current.phase==="uncertain"?"uncertain":"running";
    }
    const key=sessionHash(this.reservation(binding));
    if(!existsSync(this.path(this.reservation(binding))))throw new Error("Durable storage missing; do not create a replacement Run");
    if(!binding.provider||!binding.model)throw new Error("Durable model identity was not durably acknowledged");
    const live=await this.open(binding,cwd,kind,{provider:binding.provider,model:binding.model,...(binding.effort?{effort:binding.effort}:{})});
    try{
      const snap=live.stream.snapshot;
      if(!snap.entries.some(e=>e.kind==="pi.user")&&!snap.run)throw new Error("Durable input receipt missing; refusing to declare settlement");
      const state=this.safety.get(key);
      if(state?.outcome==="failed"||state?.outcome==="uncertain")throw new Error("Persisted runtime input outcome is not successful");
      const inspection=await live.harness.inspect(BACKGROUND_CONTEXT);
      const uncertain=inspection.tasks.some(task=>{
        if(task.record.kind!=="pi.tool"||task.record.state.status==="terminal"||task.record.state.status==="completing")return false;
        const checkpoint=task.record.state.checkpoint as {phase?:string;replay?:string}|undefined;
        return checkpoint?.phase==="execute"&&checkpoint.replay!=="safe";
      });
      if(uncertain)throw new Error("Interrupted non-replay-safe Durable Tool requires human reconciliation");
      if(!this.safety.inputs(key).includes("mm:"+key))throw new Error("Legacy input inventory is unproved; no automatic replay");
      if(inspection.tasks.length||inspection.submissions.length)this.safety.assertActive(key);
      live.verified=true;
      if(inspection.tasks.length||inspection.submissions.length){live.harness.resume();void this.supervise(live);return "running";}
      await this.supervise(live);
      const current=this.current(binding)!;
      return current.phase==="settled"||current.phase==="sealed"?"settled":"uncertain";
    }catch(error){await this.stopRun(binding).catch(()=>{});throw error;}
  }
  async command(binding:AgentBinding,cwd:string,kind:DurableKind,action:"steer"|"followUp"|"abort",requestId:string,text?:string){
    this.assertLive();
    if(binding.phase!=="running")throw new Error("Only running Durable conversations accept live intervention");
    let live=this.active.get(binding.sessionId!);
    if(!live||live.closed){await this.reconnect(binding,cwd,kind);live=this.active.get(binding.sessionId!);}
    if(!live||live.closed)throw new Error("Durable conversation is not connected");
    this.assertLive();
    if(live.finishing)throw new Error("Run is settling; no further input can be admitted");
    if(action==="abort"){
      this.options.changed(this.options.agents.requestAbort(binding));live.abortRequested=true;
      await live.root.abort(BACKGROUND_CONTEXT);
    }else{
      if(!text||text.length>16000||!text.trim())throw new Error("Bounded nonempty Durable message required");
      this.safety.trackInput(sessionHash(this.reservation(binding)),requestId);
      await live.root.submit({type:"input",content:text,requestId,whenBusy:action},BACKGROUND_CONTEXT);
    }
    return {requestId,status:"ok",message:"Durable "+action+" admitted durably"};
  }
  async stopRun(binding:AgentBinding):Promise<void>{
    if(!binding.sessionId)return;const live=this.active.get(binding.sessionId);if(!live)return;
    live.closed=true;if(live.timer)clearTimeout(live.timer);this.active.delete(binding.sessionId);
    // A sealed Run remains a live shutdown obligation until close is proven.
    const flight=(async()=>{
      await live.stream.stop().catch(()=>{});
      await live.harness.close(BACKGROUND_CONTEXT);
      if(live.completion)await live.completion;
    })();
    this.stopping.add(flight);
    try{await flight;}catch(error){this.stopFailure=error;throw error;}
    finally{this.stopping.delete(flight);}
  }
  close():Promise<void>{
    if(this.closeFlight)return this.closeFlight;
    this.closing=true;
    this.latchInterruptedOutcomes();
    this.options.lifetimeSignal?.removeEventListener("abort",this.onLifetimeAbort);
    this.stopSignal.abort(new Error("Durable host shutting down"));
    this.closeFlight=(async()=>{
      await Promise.allSettled([...this.opening.values()]);
      const closing=[...this.active.values()];
      for(const live of closing){live.closed=true;if(live.timer)clearTimeout(live.timer);}
      const results=await Promise.allSettled([
        ...this.stopping,
        ...closing.map(async live=>{
          try{await live.stream.stop();}finally{await live.harness.close(BACKGROUND_CONTEXT);}
          if(live.completion)await live.completion;
        }),
      ]);
      // Never mask an unjoined Harness/tool and release the state owner lock.
      if(this.latchFailure||this.stopFailure||results.some(result=>result.status==="rejected"))
        throw new Error("Durable worker shutdown could not be proved; retain state ownership");
      this.active.clear();this.safety.close();
    })();
    return this.closeFlight;
  }
}
