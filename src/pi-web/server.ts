/** PI WEB Server API v3: deterministic workflow plus per-attempt ephemeral Pi runs. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,
  PI_WEB_HOST_WORKSPACES_CAPABILITY,
  type PiWebHostPiSessionsV1, type PiWebHostPiSessionEventsV1, type PiWebHostWorkspacesV1,
  type PiWebServerPlugin, type JsonValue, type ServerPluginPeerRequestContext,
} from "@jmfederico/pi-web/server-plugin-api";
import { WorkflowStore } from "../core/store.js";
import { WorkflowError, type WorkflowAction, type TaskState } from "../core/workflow.js";
import { AgentRegistry, type AgentBinding, type Reservation, type Seat } from "../runtime/registry.js";
import { PiSessionBridge } from "../runtime/session-bridge.js";
import { type RuntimeActivity, type RuntimeControl } from "../runtime/protocol.js";

function object(value:unknown):Record<string,unknown> {
  if(value===null||typeof value!=="object"||Array.isArray(value))
    throw new WorkflowError("invalid_input","Object required");
  return value as Record<string,unknown>;
}
function nonempty(value:unknown,max=160):string {
  if(typeof value!=="string"||!value.trim()||value.length>max)
    throw new WorkflowError("invalid_input","Nonempty bounded text required");
  return value;
}
function id(value:unknown):string {return nonempty(value,128);}
function role(value:unknown):Seat {
  if(value!=="planner"&&value!=="implementer"&&value!=="qc"&&value!=="architect")
    throw new WorkflowError("invalid_seat","Unknown run role");
  return value;
}
function j(value:unknown):JsonValue {return value as JsonValue;}
function plannedRunId(task:TaskState,seat:Seat):string {
  if(seat==="implementer"&&task.spec.kind==="implementation"&&task.status==="running"&&task.attempts>0)
    return "impl-"+task.spec.id+"-"+task.attempts;
  if(seat==="qc"&&task.spec.kind==="implementation"&&task.status==="awaiting_qc"&&task.pendingWork)
    return "qc-"+task.spec.id+"-"+task.pendingWork.attempt;
  if((seat==="architect"||seat==="planner")&&
    (task.spec.kind==="diagnosis"||task.spec.kind==="synthesis")&&task.status==="running"&&task.attempts>0)
    return "task-"+task.spec.id+"-"+task.attempts;
  throw new WorkflowError("task_not_dispatchable","The task has no admitted run for this role");
}
type Fanout={scope:string;send:(payload:JsonValue)=>void};
const plugin:PiWebServerPlugin={
 apiVersion:3,name:"pi-micromanager",
 requires:[PI_WEB_HOST_PI_SESSIONS_CAPABILITY,PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,PI_WEB_HOST_WORKSPACES_CAPABILITY],
 activate(host){
  const store=new WorkflowStore(join(host.dataDirectory,"workflows.sqlite"));
  const agents=new AgentRegistry(join(host.dataDirectory,"agents.sqlite"));
  let sessions:PiWebHostPiSessionsV1|undefined;
  let sessionEvents:PiWebHostPiSessionEventsV1|undefined;
  let workspaces:PiWebHostWorkspacesV1|undefined;
  const live=new Map<string,PiSessionBridge>();
  const viewers=new Set<Fanout>();
  const orchestraKey=(project:string,orchestraWorkspaceId:string)=>JSON.stringify([project,orchestraWorkspaceId]);
  const bridgeKey=(binding:AgentBinding)=>JSON.stringify([binding.projectId,binding.orchestraWorkspaceId,binding.sessionId]);
  function notifyRun(binding:AgentBinding):void {
    const scope=orchestraKey(binding.projectId,binding.orchestraWorkspaceId);
    for(const viewer of viewers){
      if(viewer.scope!==scope)continue;
      try{viewer.send(j({type:"run_changed",workflowId:binding.workflowId,
        runId:binding.runId,phase:binding.phase}));}
      catch{viewers.delete(viewer);}
    }
  }
  function emit(binding:AgentBinding,event:RuntimeActivity):void {
    agents.record(binding,event);
    const scope=orchestraKey(binding.projectId,binding.orchestraWorkspaceId);
    for(const viewer of viewers){
      if(viewer.scope!==scope)continue;
      try{viewer.send(j({type:"agent_activity",sessionId:binding.sessionId,runId:binding.runId,event}));}
      catch{viewers.delete(viewer);}
    }
  }
  async function connect(binding:AgentBinding):Promise<PiSessionBridge>{
    if(!binding.sessionId)throw new Error("Unknown session identity; reconcile uncertain create first");
    if(binding.phase==="settled"||binding.phase==="sealed"||binding.phase==="failed")
      throw new Error("Run has ended; spawn a fresh Pi Session for the next stage");
    const key=bridgeKey(binding);
    const old=live.get(key);
    if(old?.connected)return old;
    if(old){old.stop();live.delete(key);}
    if(!sessionEvents)throw new Error("PI WEB session-events capability missing");
    const conn=await sessionEvents.connect({
      projectId:binding.projectId,workspaceId:binding.workspaceId,sessionId:binding.sessionId});
    const bridge=new PiSessionBridge(conn,event=>emit(binding,event));
    live.set(key,bridge);
    conn.signal.addEventListener("abort",()=>{if(live.get(key)===bridge)live.delete(key);},{once:true});
    return bridge;
  }
  function registered(ctx:ServerPluginPeerRequestContext,sessionId:string):AgentBinding {
    return agents.get(ctx.project.id,ctx.workspace.id,sessionId);
  }
  async function reservation(ctx:ServerPluginPeerRequestContext,input:Record<string,unknown>):Promise<Reservation> {
    const workflowId=id(input.workflowId),taskId=id(input.taskId);
    const workflow=store.get(ctx.project.id,ctx.workspace.id,workflowId);
    const task=Object.hasOwn(workflow.tasks,taskId)?workflow.tasks[taskId]:undefined;
    if(!task)throw new WorkflowError("unknown_task","Choose an existing Task");
    const seat=role(input.seat);
    const expectedRunId=plannedRunId(task,seat);
    const runId=input.runId===undefined?expectedRunId:id(input.runId);
    if(runId!==expectedRunId)throw new WorkflowError("run_mismatch","Run ID must match the currently admitted attempt/QC");
    const targetWorkspace=input.workspaceId===undefined?ctx.workspace.id:id(input.workspaceId);
    if(!workspaces)throw new Error("Workspace resolver is not available");
    const resolved=await workspaces.resolve({projectId:ctx.project.id,workspaceId:targetWorkspace});
    if(resolved.project.id!==ctx.project.id||resolved.workspace.id!==targetWorkspace)
      throw new Error("Workspace belongs to a different project");
    if(seat==="implementer"){
      if(resolved.workspace.isMain||resolved.workspace.provider?.metadata?.isGitWorktree!==true)
        throw new WorkflowError("worktree_required","Select an independently linked Git worktree before launching Luna");
    }
    return {
      projectId:ctx.project.id,orchestraWorkspaceId:ctx.workspace.id,
      workspaceId:targetWorkspace,workflowId,taskId,runId,seat,requestId:id(input.requestId),
    };
  }
  async function probe(binding:AgentBinding):Promise<{bridge:PiSessionBridge;status:string}> {
    const bridge=await connect(binding);
    const reply=await bridge.send({type:"probe",requestId:randomUUID()},7000);
    // A live probe cannot prove whether an earlier unacknowledged command ran.
    // Keep uncertain runs fenced until an explicit reconciliation protocol exists.
    agents.update(binding,reply.status==="ok"?
      (binding.phase==="uncertain"?"uncertain":
        binding.phase==="configured"||binding.phase==="running"?binding.phase:"connected"):"uncertain");
    return {bridge,status:reply.status};
  }
  return {
    start({capabilities}){
      sessions=capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
      sessionEvents=capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
      workspaces=capabilities.resolve(PI_WEB_HOST_WORKSPACES_CAPABILITY);
    },
    peer:{
      async request(ctx){
        ctx.signal.throwIfAborted();host.lifetimeSignal.throwIfAborted();
        const p=ctx.project.id,o=ctx.workspace.id;
        switch(ctx.operation){
          case "list":return j(store.list(p,o));
          case "get":return j(store.get(p,o,id(ctx.input)));
          case "create":return j(store.create(p,o,ctx.input));
          case "act":{
            const input=object(ctx.input);
            if(!Number.isSafeInteger(input.expectedRevision))throw new WorkflowError("invalid_revision","Expected revision required");
            return j(store.act(p,o,id(input.workflowId),input.expectedRevision as number,
              id(input.commandId),object(input.action) as unknown as WorkflowAction));
          }
          case "agents.list":{
            const input=ctx.input===null?{}:object(ctx.input);
            const view=input.view==="history"?"history":input.view==="all"?"all":"active";
            return j(agents.list(p,o,view).map(b=>({
              ...b,connected:Boolean(b.sessionId&&live.get(bridgeKey(b))?.connected),
            })));
          }
          case "agents.history":{
            const input=object(ctx.input);
            return j(agents.activities(p,o,id(input.sessionId)));
          }
          case "agents.create":{
            const input=object(ctx.input);
            // Validate model configuration before reserving the immutable run ID.
            const provider=nonempty(input.provider,120),model=nonempty(input.model);
            const effort=input.effort===undefined?undefined:nonempty(input.effort,32);
            const run=await reservation(ctx,input);
            const existing=agents.getRun(p,o,run.workflowId,run.runId);
            if(existing){
              if(existing.requestId!==run.requestId)throw new Error("Run already reserved for another command");
              return j({...existing,note:"Existing run returned. No second Pi Session created."});
            }
            notifyRun(agents.reserve(run));
            if(!sessions)throw new Error("PI WEB pi-sessions capability missing");
            // If create times out, keep the reservation. Manual reconciliation is
            // needed; an unknown result is never retried as a new Pi session.
            const created=await sessions.create({projectId:p,workspaceId:run.workspaceId});
            let binding=agents.assign(run,created.sessionId);
            notifyRun(binding);
            const checked=await probe(binding);
            binding=agents.get(p,o,created.sessionId);
            if(checked.status!=="ok"){
              return j({...binding,notice:"Pi companion did not acknowledge probe. Reconcile session; do not respawn."});
            }
            const receipt=await checked.bridge.send({
              type:"configure",requestId:randomUUID(),provider,model,...(effort?{effort}:{}),
              sessionName:"MM "+run.seat+" "+run.taskId+" "+run.runId,
            });
            binding=agents.update(binding,receipt.status==="ok"?"configured":
              receipt.status==="uncertain"?"uncertain":"blocked",
              receipt.status==="ok"?{provider,model,...(effort?{effort}:{})}:undefined);
            notifyRun(binding);
            return j({...binding,configuration:receipt});
          }
          case "agents.attach":{
            const input=object(ctx.input);
            const run=await reservation(ctx,input);
            const sessionId=id(input.sessionId);
            const existing=agents.getRun(p,o,run.workflowId,run.runId);
            if(!existing||existing.phase!=="reserved"||existing.sessionId!==null||
              existing.requestId!==run.requestId||existing.workspaceId!==run.workspaceId)
              throw new Error("Attach is only for reconciling an unassigned, already reserved run. Do not reuse prior Sessions.");
            if(!sessionEvents)throw new Error("PI WEB session-events capability missing");
            const conn=await sessionEvents.connect({
              projectId:p,workspaceId:run.workspaceId,sessionId});
            const tmp=new PiSessionBridge(conn,()=>{});
            const receipt=await tmp.send({type:"probe",requestId:randomUUID()},7000);
            tmp.stop();
            if(receipt.status!=="ok"||receipt.fresh!==true)
              throw new Error("Reconciliation requires an idle Pi Session without prior conversation history");
            agents.reserve(run);
            notifyRun(agents.assign(run,sessionId));
            let binding=agents.get(p,o,sessionId);
            binding=agents.update(binding,"connected");
            await connect(binding);
            notifyRun(binding);
            return j({...binding,configuration:receipt});
          }
          case "agents.reconnect":{
            const input=object(ctx.input);
            const binding=registered(ctx,id(input.sessionId));
            const checked=await probe(binding);
            const current=agents.get(p,o,binding.sessionId!);
            notifyRun(current);
            return j({...current,probeStatus:checked.status});
          }
          case "agents.configure":{
            const input=object(ctx.input);
            let binding=registered(ctx,id(input.sessionId));
            if(binding.phase==="running"||binding.phase==="settled"||binding.phase==="sealed"||
              binding.phase==="uncertain"||binding.phase==="failed")
              throw new Error("Cannot configure a running, completed or uncertain execution");
            const bridge=live.get(bridgeKey(binding));
            if(!bridge?.connected)throw new Error("Reconnect this Pi Session first");
            const provider=nonempty(input.provider,120),model=nonempty(input.model);
            const effort=input.effort===undefined?undefined:nonempty(input.effort,32);
            const receipt=await bridge.send({type:"configure",requestId:id(input.requestId),
              provider,model,...(effort?{effort}:{})});
            binding=agents.update(binding,receipt.status==="ok"?"configured":
              receipt.status==="uncertain"?"uncertain":"blocked",
              receipt.status==="ok"?{provider,model,...(effort?{effort}:{})}:undefined);
            notifyRun(binding);
            return j({...binding,configuration:receipt});
          }
          case "agents.command":{
            const input=object(ctx.input);
            const binding=registered(ctx,id(input.sessionId));
            if(binding.phase==="settled"||binding.phase==="sealed"||binding.phase==="failed"||
              binding.phase==="uncertain"||binding.phase==="blocked")
              throw new Error("This run has ended or needs reconciliation. Do not retry uncertain sends.");
            const bridge=live.get(bridgeKey(binding));
            if(!bridge?.connected)throw new Error("Reconnect before sending a command");
            const action=input.action;
            let cmd:RuntimeControl;
            if(action==="abort")cmd={type:"abort",requestId:id(input.requestId)};
            else{
              if(action!=="newTurn"&&action!=="steer"&&action!=="followUp")
                throw new Error("Invalid Pi message delivery mode");
              if(action==="newTurn"&&binding.phase!=="configured")
                throw new Error("Configure the exact model before starting a fresh execution");
              cmd={type:"message",requestId:id(input.requestId),
                text:nonempty(input.text,16000),delivery:action};
            }
            const receipt=await bridge.send(cmd,10000);
            if(receipt.status==="ok"&&action==="newTurn")
              agents.update(binding,"running");
            if(receipt.status==="uncertain")
              agents.update(binding,"uncertain");
            notifyRun(agents.get(p,o,binding.sessionId!));
            return j(receipt);
          }
          case "agents.seal":{
            const input=object(ctx.input);
            const binding=registered(ctx,id(input.sessionId));
            const sealed=agents.seal(p,o,binding.sessionId!,nonempty(input.evidenceRef,512));
            notifyRun(sealed);
            const bridge=live.get(bridgeKey(binding));
            if(bridge){bridge.stop();live.delete(bridgeKey(binding));}
            return j(sealed);
          }
          default:throw new WorkflowError("invalid_operation","Unsupported PI WEB micromanager operation");
        }
      },
      openChannel(ctx){
        if(ctx.operation!=="agents.events"||ctx.input!==null)throw new Error("Unknown read-only live channel");
        const viewer:Fanout={scope:orchestraKey(ctx.project.id,ctx.workspace.id),send:ctx.send};
        viewers.add(viewer);
        const close=()=>{viewers.delete(viewer);ctx.signal.removeEventListener("abort",close);};
        ctx.signal.addEventListener("abort",close,{once:true});
        return {receive(_data,signal){signal.throwIfAborted();throw new Error("Activity channel is read-only");},
          close};
      },
    },
    dispose(){
      for(const bridge of live.values())bridge.stop();
      live.clear();viewers.clear();agents.close();store.close();
    },
  };
 },
};
export default plugin;
