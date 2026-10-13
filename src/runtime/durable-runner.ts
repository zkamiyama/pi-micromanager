/** True Pi Durable execution: each automated Run owns one crash-resumable
 * durable SQLite Harness. PI WEB sees bounded public events through this
 * plugin; this is NOT a simulated Pi session or a native PI WEB conversation.
 *
 * Pi Durable 1.2.0 API is experimental and intentionally pinned. Do not
 * auto-replay unknown shell side-effects after an interrupted host process.
 */
import {createHash} from "node:crypto";
import {mkdirSync,realpathSync,existsSync} from "node:fs";
import {join,resolve,isAbsolute} from "node:path";
import {BACKGROUND_CONTEXT} from "@earendil-works/chord/context";
import {Type} from "@earendil-works/pi-ai";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import type {Models} from "@earendil-works/pi-ai/models";
import type {ModelThinkingLevel} from "@earendil-works/pi-ai";
import {
  Harness,createRegistry,defineExtension,defineTool,watchEvents,
  type AgentEvent,type AgentEventStream,type Conversation,type ToolRegistration,
} from "@earendil-works/pi-durable";
import {CodingTools} from "@earendil-works/pi-durable/tools";
import {NodeExecutionEnv} from "@earendil-works/pi-durable/env/node";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import type {AgentRegistry,AgentBinding,Reservation} from "./registry.js";
import type {RuntimeActivity} from "./protocol.js";
import type {AutopilotLedger,ModelProfile} from "../automation/ledger.js";
import {parseRunReport,type RunReport} from "../automation/report.js";

export type DurableKind="implementation"|"qc"|"diagnosis"|"synthesis"|
  "planning"|"workflow_plan";
export interface DurableLaunch {
  reservation:Reservation;model:ModelProfile;cwd:string;
  kind:DurableKind;prompt:string;
}
interface DurableCallbacks{
  dataDirectory:string;agents:AgentRegistry;ledger:AutopilotLedger;
  /** Test hook for the real Durable Harness with a deterministic faux provider. */
  models?:Models;
  activity(binding:AgentBinding,event:RuntimeActivity):void;
  changed(binding:AgentBinding):void;
  report(binding:AgentBinding,report:RunReport):void;
  wake(binding:AgentBinding):void;
}
type Active={
  harness:Awaited<ReturnType<typeof Harness.open>>;
  root:Conversation;stream:AgentEventStream;binding:AgentBinding;
  closed:boolean;stopped:boolean;seq:number;text:string;abortRequested:boolean;
};
const UUID_HASH=/^durable:([a-f0-9]{64})$/;
const readonlyKinds=new Set<DurableKind>(["qc","diagnosis","synthesis","planning","workflow_plan"]);
const MAX_PUBLIC_TEXT=512;
function bounded(input:string):string{return input.slice(-MAX_PUBLIC_TEXT);}
function sessionHash(r:Reservation):string {
  return createHash("sha256").update(JSON.stringify([
    r.projectId,r.orchestraWorkspaceId,r.workflowId,r.runId
  ])).digest("hex");
}
export function isDurableSession(id:string|null):boolean {
  return id!==null&&UUID_HASH.test(id);
}
function identity(r:Reservation):string{return "durable:"+sessionHash(r);}
function shellEnvironment():NodeJS.ProcessEnv{
  const env:{[key:string]:string|undefined}={...process.env};
  // Model provider owns credentials; coding shells must not inherit them.
  // This is not an OS sandbox against arbitrary readable host files.
  for(const key of Object.keys(env))
    if(/(?:^GH_|^GITHUB_|^GIT_ASKPASS|^GIT_CONFIG|^AWS_|^AZURE_|^OPENAI_|^ANTHROPIC_|^GOOGLE_|^GEMINI_|^CLOUDFLARE_|^RADIUS_|API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i.test(key))
      delete env[key];
  return env;
}
/** Local Git merges are required only to assemble QC-approved commits in
 * the isolated final-integration Worktree. Other workers cannot merge. This
 * heuristic guard is not a sandbox and is never relied on as a permission
 * boundary; the host independently verifies Git ancestry and runs QC. */
export function isSafeBashCommand(command:string,allowFinalLocalMerge=false):boolean{
  const c=command.toLowerCase();
  if(!allowFinalLocalMerge&&/\bgit\s+merge\b/.test(c))return false;
  return !/\b(?:git\s+(?:push|remote|fetch|pull|rebase|reset|checkout|switch|worktree\s+remove)|gh\s+(?:pr|repo|api|workflow|release)\s+|git\s+config\s+.*(?:credential|http\.)|curl\s+.*github\.com|wget\s+.*github\.com)\b/.test(c);
}
/** One safe-to-display event; never forward hidden thinking, raw tool
 * arguments, messages from another Run, tokens, or full tool output. */
export function durableActivity(event:AgentEvent,text:string,sequence:number):
  {event:RuntimeActivity;text:string}|undefined{
  const at=Date.now();
  if(event.type==="run_start")
    return {event:{kind:"agent_started",at,sequence,text:"Pi Durable run started"},text:""};
  if(event.type==="message_update"){
    const delta=event.changes.map(c=>
      c.type==="text_delta"?c.delta:"").join("");
    if(!delta)return;
    const updated=bounded(text+delta);
    return {event:{kind:"message_delta",at,sequence,text:updated},text:updated};
  }
  if(event.type==="message_end")
    return {event:{kind:"message_completed",at,sequence,
      text:bounded(text||"Assistant message committed")},text:""};
  if(event.type==="tool_execution_start")
    return {event:{kind:"tool_started",at,sequence,text:event.toolName.slice(0,100)},text};
  if(event.type==="tool_execution_end")
    return {event:{kind:event.entry?.model?.[0]?.role==="toolResult"&&
      event.entry.model[0].isError?"error":"tool_finished",
      at,sequence,text:event.toolName.slice(0,100)+" finished"},text};
  if(event.type==="task_failed")
    return {event:{kind:"error",at,sequence,text:"Durable task failed: "+event.kind.slice(0,100)},text};
  return;
}
function reportTools(kind:DurableKind,runId:string,emit:(report:RunReport)=>void,
  at:number){
  let submitted=false;
  function record(value:unknown){
    const r=parseRunReport(value);
    if(!r||r.runId!==runId)throw new Error("Invalid Durable Run report");
    if(submitted)throw new Error("Run report already submitted");
    emit(r);submitted=true;
    return {output:[{type:"text" as const,text:"Structured report stored. Host Git/QC gates still apply."}]};
  }
  const summary=Type.String({minLength:1,maxLength:2000});
  const qc=defineTool({name:"mm_qc_report",
    description:"Submit an independent QC verdict exactly once. This does not authorize merging.",
    parameters:Type.Object({verdict:Type.Union([
      Type.Literal("pass"),Type.Literal("fail"),Type.Literal("inconclusive")]),
      summary}),replay:"safe",
    async execute(args){if(kind!=="qc")throw new Error("Not a QC Run");
      return record({kind:"qc",runId,verdict:args.verdict,summary:args.summary,at});},
  });
  const task=defineTool({name:"mm_task_report",
    description:"Submit an evidence-backed read-only investigation or synthesis summary.",
    parameters:Type.Object({summary}),replay:"safe",
    async execute(args){if(kind!=="diagnosis"&&kind!=="synthesis")
      throw new Error("Not an investigation Run");
      return record({kind:"task",runId,summary:args.summary,at});},
  });
  const plan=defineTool({name:"mm_plan_intervention",
    description:"Propose 1–4 independent investigators. The host validates models, roles and DAG gates.",
    parameters:Type.Object({summary,agents:Type.Array(Type.Object({
      id:Type.String({minLength:1,maxLength:32}),
      title:Type.String({minLength:1,maxLength:200}),
      role:Type.Union([Type.Literal("architect"),Type.Literal("reviewer")]),
      model:Type.String({minLength:1,maxLength:160}),
    }),{minItems:1,maxItems:4})}),replay:"safe",
    async execute(args){if(kind!=="planning")throw new Error("Not a planning Run");
      return record({kind:"plan",runId,summary:args.summary,agents:args.agents,at});},
  });
  const proposal=defineTool({name:"mm_workflow_proposal",
    description:"Submit a valid DAG for host-side verification. Never start code automatically from this tool.",
    parameters:Type.Object({
      id:Type.String({minLength:1,maxLength:64}),
      title:Type.String({minLength:1,maxLength:200}),summary,
      maxQcRounds:Type.Integer({minimum:1,maximum:10}),
      tasks:Type.Array(Type.Object({
        id:Type.String({minLength:1,maxLength:64}),
        title:Type.String({minLength:1,maxLength:200}),
        description:Type.String({minLength:1,maxLength:4000}),
        acceptanceCriteria:Type.Array(Type.String({minLength:1,maxLength:500}),
          {minItems:1,maxItems:20}),
        dependsOn:Type.Array(Type.Object({
          taskId:Type.String({minLength:1,maxLength:64}),
          gate:Type.Union([Type.Literal("qc_passed"),Type.Literal("integrated")]),
        }),{maxItems:16}),
      }),{minItems:1,maxItems:16}),
    }),replay:"safe",
    async execute(args){
      if(kind!=="workflow_plan")throw new Error("Not a goal proposal Run");
      const definition={
        id:args.id,title:args.title,maxQcRounds:args.maxQcRounds,
        maxParallelByRole:{planner:1,implementer:2,reviewer:2,architect:2},
        tasks:args.tasks.map(t=>({...t,kind:"implementation" as const,role:"implementer" as const})),
      };
      return record({kind:"workflow_plan",runId,summary:args.summary,definition,at});
    },
  });
  return {qc,task,plan,proposal};
}
/** Use the public Pi SDK authentication pipeline. The daemon's Pi CLI
 * profile resolves API keys and OAuth credentials (including refresh) without
 * copying bearer tokens into any Micromanager SQLite table or Run event.
 * A different daemon OS user must authenticate their own Pi profile. */
export async function createDurableModels(authPath?:string):Promise<Models>{
  return ModelRuntime.create({
    allowModelNetwork:false,refreshOnCreate:false,
    ...(authPath?{authPath}:{}),
  });
}
export class DurableRunHost {
  private modelsPromise:Promise<Models>|undefined;
  private readonly active=new Map<string,Active>();
  private readonly opening=new Map<string,Promise<Active>>();
  private closing=false;
  constructor(private readonly options:DurableCallbacks){}
  connected(id:string):boolean{return this.active.get(id)?.closed===false;}
  private configuredModels():Promise<Models>{
    if(this.options.models)return Promise.resolve(this.options.models);
    if(!this.modelsPromise){
      this.modelsPromise=createDurableModels().catch(error=>{
        this.modelsPromise=undefined;
        throw error;
      });
    }
    return this.modelsPromise;
  }
  private path(reservation:Reservation):string{
    const home=resolve(this.options.dataDirectory),directory=join(home,"durable-runs");
    mkdirSync(directory,{recursive:true,mode:0o700});
    return join(directory,sessionHash(reservation)+".sqlite");
  }
  private reservation(binding:AgentBinding):Reservation{
    return {projectId:binding.projectId,orchestraWorkspaceId:binding.orchestraWorkspaceId,
      workflowId:binding.workflowId,taskId:binding.taskId,runId:binding.runId,
      workspaceId:binding.workspaceId,seat:binding.seat,requestId:binding.requestId};
  }
  private async open(binding:AgentBinding,cwd:string,kind:DurableKind,
    model:ModelProfile):Promise<Active>{
    if(this.closing)throw new Error("Durable host shutting down");
    const reservation=this.reservation(binding),sessionId=identity(reservation);
    if(binding.sessionId!==null&&binding.sessionId!==sessionId)
      throw new Error("Durable session ID does not match its scoped Run");
    if(!cwd||!isAbsolute(cwd))
      throw new Error("Durable requires an absolute trusted Worktree");
    const canonical=realpathSync(cwd);
    if(canonical!==resolve(cwd))throw new Error("Durable Worktree path is not canonical");
    const found=this.active.get(sessionId);
    if(found&&!found.closed)return found;
    const opening=this.opening.get(sessionId);
    if(opening)return opening;
    const future=(async()=>{
      const models=await this.configuredModels();
      if(!models.getModel(model.provider,model.model))
        throw new Error("Pi Durable model is not in the configured Pi catalog: "+
          model.provider+"/"+model.model);
      // ModelRuntime reads the daemon OS user's Pi auth.json and refreshes
      // OAuth using Pi's lock-aware credential store. PI WEB browser/session
      // credentials owned by another user remain outside this trust boundary.
      // Scripted test models are injected and may intentionally be keyless.
      if(!this.options.models){
        let authorized=false;
        try{authorized=Boolean(await models.getAuth(model.provider));}
        catch{
          throw new Error("Pi Durable provider authentication failed for "+
            model.provider+"; run pi auth check --provider "+model.provider+
            " as the daemon OS user");
        }
        if(!authorized)throw new Error("Pi Durable provider is not authenticated: "+
          model.provider+"; authenticate Pi as the daemon OS user first");
      }
      const rootPath=this.path(reservation);
      const registry=createRegistry();
      const reports=reportTools(kind,binding.runId,r=>{
        const current=this.options.agents.getRun(binding.projectId,
          binding.orchestraWorkspaceId,binding.workflowId,binding.runId);
        if(!current?.sessionId||current.sessionId!==sessionId)
          throw new Error("Durable report not authorized by exact Run reservation");
        this.options.report(current,r);
      },Date.parse(binding.createdAt));
      const provided=kind==="qc"?reports.qc:
        kind==="planning"?reports.plan:kind==="workflow_plan"?reports.proposal:reports.task;
      const coding=(CodingTools.tools??[]).map(tool=>{
        if(tool.name==="read")return {...tool,replay:"safe" as const};
        if(tool.name!=="bash")return tool;
        return {...tool,async execute(args:never,api:never,context:never){
          const command=String((args as {command?:string}).command??"");
          if(!isSafeBashCommand(command,
            kind==="implementation"&&binding.taskId==="mm-final-integration"))
            throw new Error("Direct GitHub publication and dangerous Git mutations "+
              "must use the Orchestrator's exact QC/permission gates");
          return tool.execute(args,api,context);
        }};
      }) as ToolRegistration[];
      registry.install(defineExtension({name:"micromanager-coding-tools",tools:coding}));
      registry.install(defineExtension({name:"micromanager-durable-reports",tools:[provided]}));
      const harness=await Harness.open(await openNodeSqliteStorage(rootPath),
        {models,registry,settings:{toolExecution:"sequential",
          progress:{partialIntervalMs:100,outputIntervalMs:100}},
         env:({cwd})=>{
           if(resolve(cwd??"")!==canonical)
             throw new Error("Durable execution cwd changed after trusted Workspace validation");
           return new NodeExecutionEnv({cwd:canonical,
             shellEnv:shellEnvironment()});
         }},BACKGROUND_CONTEXT);
      try{
        const original=[...coding];
        const read=original.find(x=>x.name==="read");
        if(!read)throw new Error("Pi Durable CodingTools lacks the safe read tool");
        // TypeBox-specific registrations share the durable ToolRegistration
        // interface but inferred schema unions are not homogeneous arrays.
        const tools:ToolRegistration[]=(kind==="implementation"?
          original:[read,provided]) as ToolRegistration[];
        const effort=model.effort;
        const levels=new Set<string>(["off","minimal","low","medium","high","xhigh","max"]);
        if(effort!==undefined&&!levels.has(effort))
          throw new Error("Unsupported Pi Durable thinking level: "+effort);
        const agent={
          model:{provider:model.provider,modelId:model.model},
          ...(effort?{thinkingLevel:effort as ModelThinkingLevel}:{}),
          cwd:canonical,tools,
          modelTools:tools,
          instructions:kind==="implementation"?
            "Implement only in this isolated Git Worktree. Commit verified code. "+
            "No direct git push, gh PR, remote merge or protected branch mutations; "+
            "the Orchestrator publishes only after sealed QC.": 
            "READ ONLY. Do not edit source, create processes or write files. "+
            "Inspect the exact provided commit. Submit the required mm_* report once.",
        };
        const root=await harness.root(BACKGROUND_CONTEXT,{agent});
        const stream=await watchEvents(harness,root.id,BACKGROUND_CONTEXT);
        const live:Active={harness,root,stream,binding,closed:false,stopped:false,
          seq:0,text:"",abortRequested:false};
        stream.start(async events=>{
          if(live.closed)return;
          for(const event of events){
            const value=durableActivity(event,live.text,++live.seq);
            if(!value)continue;
            live.text=value.text;
            const current=this.options.agents.getRun(binding.projectId,
              binding.orchestraWorkspaceId,binding.workflowId,binding.runId);
            if(current?.sessionId!==sessionId||current.phase==="sealed"||
              current.phase==="failed")continue;
            this.options.activity(current,value.event);
          }
        });
        this.active.set(sessionId,live);
        return live;
      }catch(error){await harness.close(BACKGROUND_CONTEXT).catch(()=>{});throw error;}
    })();
    this.opening.set(sessionId,future);
    try{return await future;}
    finally{if(this.opening.get(sessionId)===future)this.opening.delete(sessionId);}
  }
  private supervise(live:Active):void{
    if(live.stopped)return;
    live.stopped=true;
    void live.root.waitForIdle(BACKGROUND_CONTEXT).then(()=>{
      if(live.closed||this.closing)return;
      const b=live.binding;
      const current=this.options.agents.getRun(b.projectId,b.orchestraWorkspaceId,
        b.workflowId,b.runId);
      if(!current||current.phase==="sealed"||current.phase==="settled"||
        current.phase==="failed")return;
      this.options.activity(current,{kind:"agent_settled",at:Date.now(),
        sequence:++live.seq,text:live.abortRequested?"Agent interrupted":"Agent settled"});
      this.options.wake(current);
    }).catch(error=>{
      if(live.closed||this.closing)return;
      const b=live.binding;
      const current=this.options.agents.getRun(b.projectId,b.orchestraWorkspaceId,
        b.workflowId,b.runId);
      if(current?.sessionId)
        this.options.changed(this.options.agents.update(current,"uncertain"));
    });
  }
  async launch(spec:DurableLaunch):Promise<AgentBinding>{
    const r=spec.reservation;
    if(this.options.agents.getRun(r.projectId,r.orchestraWorkspaceId,
      r.workflowId,r.runId))
      throw new Error("Durable Run already reserved; reconcile, never replay blindly");
    const reserved=this.options.agents.reserve(r);
    this.options.changed(reserved);
    const sid=identity(r);
    const active=await this.open(reserved,spec.cwd,spec.kind,spec.model);
    let current=this.options.agents.assign(r,sid);
    this.options.changed(current);
    current=this.options.agents.update(current,"configured",{
      provider:spec.model.provider,model:spec.model.model,
      ...(spec.model.effort?{effort:spec.model.effort}:{})});
    active.binding=current;this.options.changed(current);
    const accepted=await active.root.submit({type:"input",content:spec.prompt,
      requestId:"mm:"+sessionHash(r),whenBusy:"reject"},BACKGROUND_CONTEXT);
    if(!accepted.id)throw new Error("Durable did not commit the exact Run input");
    current=this.options.agents.get(r.projectId,r.orchestraWorkspaceId,sid);
    if(current.phase!=="settled"&&current.phase!=="running")
      this.options.changed(this.options.agents.update(current,"running"));
    this.supervise(active);
    return this.options.agents.get(r.projectId,r.orchestraWorkspaceId,sid);
  }
  async reconnect(binding:AgentBinding,cwd:string,kind:DurableKind):
    Promise<"running"|"settled"|"uncertain">{
    if(!isDurableSession(binding.sessionId))
      throw new Error("Not a Pi Durable Run");
    // The initial watch snapshot predates the first submit. Do not re-read
    // that stale pre-submit snapshot when a live owned Harness is already
    // supervising the same Run. No second Harness may open the same SQLite.
    if(this.connected(binding.sessionId!))
      return binding.phase==="settled"?"settled":"running";
    const manifest=this.path(this.reservation(binding));
    if(!existsSync(manifest))
      throw new Error("Durable storage missing; do not create a replacement Run");
    if(!binding.provider||!binding.model)
      throw new Error("Durable model identity was not durably acknowledged");
    const live=await this.open(binding,cwd,kind,{
      provider:binding.provider,model:binding.model,
      ...(binding.effort?{effort:binding.effort}:{})
    });
    const snap=live.stream.snapshot;
    if(!snap.entries.some(e=>e.kind==="pi.user")&&!snap.run)
      throw new Error("Durable input receipt missing; refusing to declare settlement");
    // If an unknown Tool was live when the daemon crashed, do not resume it
    // behind the operator's back. Pi Durable marks non-replay-safe tools as
    // interrupted; the current implementation errs on the conservative side.
    const inspection=await live.harness.inspect(BACKGROUND_CONTEXT);
    const uncertain=inspection.tasks.some(task=>{
      if(task.record.kind!=="pi.tool"||
        task.record.state.status==="terminal"||
        task.record.state.status==="completing")return false;
      const checkpoint=task.record.state.checkpoint as
        {phase?:string;replay?:string}|undefined;
      // No committed tool intent means it did not run. Otherwise replay
      // only tools whose exact persisted intent explicitly allows it.
      return checkpoint?.phase==="execute"&&checkpoint.replay!=="safe";
    });
    if(uncertain)
      throw new Error("Interrupted non-replay-safe Durable Tool requires human reconciliation");
    live.harness.resume();
    this.supervise(live);
    return live.stream.snapshot.run?"running":"settled";
  }
  async command(binding:AgentBinding,cwd:string,kind:DurableKind,
    action:"steer"|"followUp"|"abort",requestId:string,text?:string){
    if(binding.phase!=="running")
      throw new Error("Only running Durable conversations accept live intervention");
    let live=this.active.get(binding.sessionId!);
    if(!live||live.closed){
      await this.reconnect(binding,cwd,kind);
      live=this.active.get(binding.sessionId!);
    }
    if(!live||live.closed)throw new Error("Durable conversation is not connected");
    if(action==="abort"){
      live.abortRequested=true;
      await live.root.abort(BACKGROUND_CONTEXT);
    }else{
      if(!text||text.length>16000||!text.trim())
        throw new Error("Bounded nonempty Durable message required");
      await live.root.submit({type:"input",content:text,
        requestId,whenBusy:action},BACKGROUND_CONTEXT);
    }
    return {requestId,status:"ok",message:"Durable "+action+" admitted durably"};
  }
  async stopRun(binding:AgentBinding):Promise<void>{
    if(!binding.sessionId)return;
    const live=this.active.get(binding.sessionId);
    if(!live)return;
    live.closed=true;this.active.delete(binding.sessionId);
    await live.stream.stop().catch(()=>{});
    await live.harness.close(BACKGROUND_CONTEXT);
  }
  async close():Promise<void>{
    this.closing=true;
    await Promise.allSettled([...this.active.values()].map(async live=>{
      live.closed=true;await live.stream.stop();await live.harness.close(BACKGROUND_CONTEXT);
    }));
    this.active.clear();
  }
}
