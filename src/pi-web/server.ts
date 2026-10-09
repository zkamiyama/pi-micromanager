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
import { AutopilotLedger, parseAutopilotConfig } from "../automation/ledger.js";
import { AutopilotEngine } from "../automation/engine.js";
import { createHostExecutor } from "../automation/host-port.js";
import { IntegrationVerifier } from "../automation/integration.js";
import { ManagedWorktreeProvisioner } from "../automation/worktree-provisioner.js";
import { ActivityRetention } from "../automation/retention.js";
import { buildJournal } from "../automation/journal.js";
import { ScreenshotEvidence } from "../automation/screenshots.js";
import { AdrPromotion } from "../automation/adr-promotion.js";
import { PermissionLedger } from "../automation/permissions.js";
import { PublicationManager } from "../automation/publication.js";
import { AutomaticIntegrator } from "../automation/convergence.js";
import { classifyRecoveredRun } from "../automation/recovery.js";
import type { AutopilotRecord } from "../automation/ledger.js";

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
  if((seat==="architect"||seat==="planner"||seat==="qc")&&
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
  const ledger=new AutopilotLedger(join(host.dataDirectory,"autopilot.sqlite"));
  const permissions=new PermissionLedger(
    join(host.dataDirectory,"workflow-permissions.sqlite"),store,ledger);
  const publisher=new PublicationManager({
    path:join(host.dataDirectory,"publication.sqlite"),host,
    workflows:store,agents,ledger,permissions,
    workspaces:()=>workspaces,
  });
  const convergence=new AutomaticIntegrator({
    path:join(host.dataDirectory,"git-convergence.sqlite"),
    host,workflows:store,agents,ledger,permissions,
    workspaces:()=>workspaces,
  });
  const screenshots=new ScreenshotEvidence({
    path:join(host.dataDirectory,"screenshot-evidence.sqlite"),
    dataDirectory:host.dataDirectory,workflows:store,agents,ledger,host,
    workspaces:()=>workspaces,
  });
  const adr=new AdrPromotion({
    path:join(host.dataDirectory,"adr-drafts.sqlite"),
    workflows:store,agents,ledger,screenshots,host,
    workspaces:()=>workspaces,
  });
  const retention=new ActivityRetention({
    path:join(host.dataDirectory,"activity-retention.sqlite"),
    workflows:store,agents,ledger,
  });
  const provisioner=new ManagedWorktreeProvisioner({
    path:join(host.dataDirectory,"worktree-provisions.sqlite"),
    dataDirectory:host.dataDirectory,host,workflows:store,ledger,
  });
  const integration=new IntegrationVerifier({
    path:join(host.dataDirectory,"integration.sqlite"),
    host,workflows:store,agents,ledger,workspaces:()=>workspaces,
  });
  let sessions:PiWebHostPiSessionsV1|undefined;
  let sessionEvents:PiWebHostPiSessionEventsV1|undefined;
  let workspaces:PiWebHostWorkspacesV1|undefined;
  const live=new Map<string,PiSessionBridge>();
  const viewers=new Set<Fanout>();
  let autopilot:AutopilotEngine|undefined;
  let automationTimer:ReturnType<typeof setInterval>|undefined;
  let bootstrap:Promise<void>|undefined;
  let automationReady=false;
  const recoveryFlights=new Map<string,Promise<void>>();
  function scheduleAutopilot(projectId:string,workspaceId:string,workflowId:string):void {
    if(host.lifetimeSignal.aborted||!automationReady)return;
    const cfg=ledger.get(projectId,workspaceId,workflowId);
    if(cfg?.enabled&&autopilot)queueMicrotask(()=>{
      if(!host.lifetimeSignal.aborted)void autopilot!.tick(cfg);
    });
  }
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
    if(event.kind==="agent_settled"){
      notifyRun(agents.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId!));
      scheduleAutopilot(binding.projectId,binding.orchestraWorkspaceId,binding.workflowId);
    }
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
    const bridge=new PiSessionBridge(conn,event=>emit(binding,event),report=>{
      if(!binding.requestId.startsWith("auto:"))return;
      try{
        ledger.recordReport(binding,report);
        scheduleAutopilot(binding.projectId,binding.orchestraWorkspaceId,binding.workflowId);
      }catch(error){
        try{ledger.setStatus(binding.projectId,binding.orchestraWorkspaceId,binding.workflowId,
          false,"Paused safely: invalid/conflicting Run report: "+String(error).slice(0,750));}
        catch{/* Workflow may not be configured. */}
      }
    });
    live.set(key,bridge);
    conn.signal.addEventListener("abort",()=>{if(live.get(key)===bridge)live.delete(key);},{once:true});
    return bridge;
  }
  /**
   * A settled Run has left the live canvas, but its native Pi Session may
   * contain a structured report whose original event was lost. Reconnect to
   * that SAME session read-only, inspect durable turn state and replay report.
   * A report is not accepted from an unrelated Session or wrong Run identity.
   */
  async function replaySettledReport(binding:AgentBinding):Promise<void>{
    if(binding.phase!=="settled"||!binding.sessionId||
      !binding.requestId.startsWith("auto:")||!sessionEvents)
      throw new Error("Only a settled automated Pi Run can replay its report");
    const conn=await sessionEvents.connect({
      projectId:binding.projectId,workspaceId:binding.workspaceId,
      sessionId:binding.sessionId,
    });
    let reportError:unknown;
    const bridge=new PiSessionBridge(conn,()=>{},report=>{
      try{
        if(report.runId!==binding.runId)
          throw new Error("Wrong Run identity in replayed native Pi report");
        ledger.recordReport(binding,report);
      }catch(error){reportError=error;}
    });
    try{
      const inspected=await bridge.send({type:"inspect",requestId:randomUUID()},7000);
      if(reportError)throw reportError;
      if(classifyRecoveredRun(binding.runId,inspected)!=="settled"||
        inspected.hasReport!==true)
        throw new Error("Settled Pi report replay lacks a valid durable turn proof");
      if(!ledger.report(binding))
        throw new Error("Pi inspection confirmed a report, but it was not delivered");
    }finally{bridge.stop();}
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

  /** Attach to the *same* Pi Session after restart; never replay an uncertain Run. */
  function reconcileWorkflow(record:AutopilotRecord):Promise<void>{
    const key=JSON.stringify([record.projectId,record.orchestraWorkspaceId,record.workflowId]);
    const existing=recoveryFlights.get(key);
    if(existing)return existing;
    const flight=(async()=>{
      const entries=agents.list(record.projectId,record.orchestraWorkspaceId,"active")
        .filter(b=>b.workflowId===record.workflowId&&b.requestId.startsWith("auto:"));
      for(const binding of entries){
        if(host.lifetimeSignal.aborted)throw new Error("Plugin is shutting down");
        if(binding.phase!=="running"||!binding.sessionId)
          throw new Error("Run "+binding.runId+" requires manual reconciliation ("+binding.phase+")");
        const bridge=await connect(binding);
        const response=await bridge.send({type:"inspect",requestId:randomUUID()},7000);
        const outcome=classifyRecoveredRun(binding.runId,response);
        if(outcome==="uncertain")
          throw new Error("Run "+binding.runId+" has no provable last-turn state; no replay permitted");
        if(outcome==="running")continue;
        const current=agents.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId);
        if(current.phase==="running"){
          agents.record(current,{
            kind:"agent_settled",sequence:1,at:Date.now(),
            text:outcome==="aborted"?"Agent interrupted":"Agent settled",
          });
          notifyRun(agents.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId));
        }
      }
    })();
    recoveryFlights.set(key,flight);
    void flight.finally(()=>{if(recoveryFlights.get(key)===flight)recoveryFlights.delete(key);})
      .catch(()=>{/* Awaited caller handles failures. */});
    return flight;
  }
  async function restoreEnabledAutopilots():Promise<void>{
    for(const cfg of ledger.list().filter(x=>x.enabled)){
      try{await reconcileWorkflow(cfg);}
      catch(error){
        ledger.setStatus(cfg.projectId,cfg.orchestraWorkspaceId,cfg.workflowId,false,
          "Paused on restart: "+String(error).slice(0,800));
      }
    }
  }
  autopilot=new AutopilotEngine(store,agents,ledger,{
    ...createHostExecutor({
      host,workflows:store,agents,
      getSessions:()=>sessions,getWorkspaces:()=>workspaces,probe,
      validateRun:plannedRunId,notify:notifyRun,
      replaySettledReport,
    }),
    publish:(record,workflow)=>publisher.step(record,workflow),
    converge:(record,workflow)=>convergence.step(record,workflow),
    authorizeImplementation:(record,_workflow,taskId,nextAttempt)=>{
      const workspaceId=record.config.workspaces[taskId];
      if(!workspaceId)throw new Error("Missing linked implementation Workspace");
      return permissions.ensureCommit(record.projectId,record.orchestraWorkspaceId,
        record.workflowId,taskId,nextAttempt,workspaceId).decision;
    },
  });
  return {
    start({capabilities}){
      sessions=capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
      sessionEvents=capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
      workspaces=capabilities.resolve(PI_WEB_HOST_WORKSPACES_CAPABILITY);
      bootstrap=restoreEnabledAutopilots().then(()=>{
        if(host.lifetimeSignal.aborted)return;
        // Validate persisted configuration before enabling a background timer.
        const enabled=ledger.list().filter(x=>x.enabled);
        automationReady=true;
        automationTimer=setInterval(()=>{
          if(host.lifetimeSignal.aborted)return;
          try{
            for(const cfg of ledger.list().filter(x=>x.enabled))
              void autopilot!.tick(cfg);
          }catch(error){
            automationReady=false;
            if(automationTimer)clearInterval(automationTimer);
            host.logger.error("Autopilot scheduler suspended after ledger failure",
              {message:String(error).slice(0,500)});
          }
        },1500);
        automationTimer.unref();
        for(const cfg of enabled)scheduleAutopilot(
          cfg.projectId,cfg.orchestraWorkspaceId,cfg.workflowId);
      }).catch(error=>{
        automationReady=false;
        if(automationTimer)clearInterval(automationTimer);
        host.logger.error("Autopilot restore failed; scheduler not started",
          {message:String(error).slice(0,500)});
      });
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
            const input=object(ctx.input),workflowId=id(input.workflowId);
            const action=object(input.action) as unknown as WorkflowAction;
            const running=ledger.get(p,o,workflowId)?.enabled===true;
            const automatedRuns=agents.list(p,o,"all").some(b=>b.workflowId===workflowId&&
              b.requestId.startsWith("auto:"));
            if((running||automatedRuns)&&
              !["request_intervention","cancel_amendment","resume_after_diagnosis"].includes(action.type))
              throw new WorkflowError("autopilot_owns_transition",
                "Autopilot owns real Task/QC transitions; simulation commands cannot overwrite its history");
            if(!Number.isSafeInteger(input.expectedRevision))throw new WorkflowError("invalid_revision","Expected revision required");
            const next=store.act(p,o,workflowId,input.expectedRevision as number,
              id(input.commandId),action);
            if(running)scheduleAutopilot(p,o,workflowId);
            return j(next);
          }


          case "auto.propose":{
            const input=object(ctx.input),goal=nonempty(input.goal,4000);
            if(goal.includes("\0"))throw new Error("Invalid goal input");
            const provider=nonempty(input.provider,120),model=nonempty(input.model,160);
            const effort=input.effort===undefined?undefined:nonempty(input.effort,32);
            if(!sessions||!workspaces)throw new Error("Pi Session/Workspace provider unavailable");
            const available=agents.list(p,o,"active").filter(b=>b.taskId==="goal"&&
              b.requestId.startsWith("auto:goal:"));
            if(available.length>=3)throw new Error("Resolve or accept previous goal proposals first");
            const authorized=await workspaces.resolve({projectId:p,workspaceId:o});
            if(authorized.project.id!==p||authorized.workspace.id!==o)
              throw new Error("Current PI WEB Workspace authority changed");
            const token=randomUUID().replace(/-/g,"").slice(0,16);
            const draftWorkflowId="draft-"+token,runId="goal-"+token;
            const reservation:Reservation={
              projectId:p,orchestraWorkspaceId:o,workspaceId:o,workflowId:draftWorkflowId,
              taskId:"goal",runId,seat:"planner",requestId:"auto:goal:"+token,
            };
            notifyRun(agents.reserve(reservation));
            // Exactly-once native Session creation is protected by the
            // durable reservation; uncertain outcomes are not retried.
            const created=await sessions.create({projectId:p,workspaceId:o});
            let binding=agents.assign(reservation,created.sessionId);
            notifyRun(binding);
            const checked=await probe(binding);
            binding=agents.get(p,o,created.sessionId);
            if(checked.status!=="ok")throw new Error("Pi planner companion unavailable");
            const receipt=await checked.bridge.send({
              type:"configure",requestId:randomUUID(),provider,model,
              ...(effort?{effort}:{}),
              job:{runId,kind:"workflow_plan"},
              sessionName:"Goal proposal "+draftWorkflowId,
            });
            if(receipt.status!=="ok"||receipt.provider!==provider||receipt.model!==model||
              (effort!==undefined&&receipt.effort!==effort)){
              binding=agents.update(binding,receipt.status==="uncertain"?"uncertain":"blocked");
              notifyRun(binding);
              throw new Error("Pi did not confirm exact Sol model configuration");
            }
            binding=agents.update(binding,"configured",{provider,model,...(effort?{effort}:{})});
            notifyRun(binding);
            const prompt="You are Sol, an independent READ-ONLY workflow planner. User goal:\n"+
              goal+"\nPropose a precise, acyclic Task DAG with 1..16 implementation Tasks. "+
              "Each Task MUST contain bounded detailed requirements and independently testable "+
              "acceptance criteria. Prefer qc_passed dependency gates; use integrated only "+
              "where explicit upstream Git integration is required. "+
              "Use lowercase kebab-case Task/workflow IDs. "+
              "Call mm_workflow_proposal exactly once. Do not edit source files, "+
              "create Pi Sessions, execute shell commands, or start implementation. "+
              "A human will review the proposal and separately configure Worktrees/models.";
            const started=await checked.bridge.send({type:"message",requestId:randomUUID(),
              text:prompt,delivery:"newTurn"},10000);
            const current=agents.get(p,o,created.sessionId);
            if(started.status!=="ok"){
              if(!["settled","sealed"].includes(current.phase)){
                binding=agents.update(current,started.status==="uncertain"?"uncertain":"blocked");
                notifyRun(binding);
              }
              throw new Error("Sol did not acknowledge proposal request ("+started.status+")");
            }
            if(current.phase!=="settled"&&current.phase!=="running"){
              binding=agents.update(current,"running");
              notifyRun(binding);
            }
            return j({draftWorkflowId,runId,sessionId:created.sessionId,
              status:"Sol is preparing a read-only, human-reviewed DAG proposal"});
          }
          case "auto.proposal":{
            const input=object(ctx.input),draftWorkflowId=id(input.draftWorkflowId);
            const runId=id(input.runId);
            let binding=agents.getRun(p,o,draftWorkflowId,runId);
            if(!binding||binding.taskId!=="goal"||!binding.requestId.startsWith("auto:goal:"))
              throw new Error("Goal proposal Run not found");
            let notice="";
            if(binding.phase==="running"&&binding.sessionId){
              try{
                const bridge=await connect(binding);
                const receipt=await bridge.send({type:"inspect",requestId:randomUUID()},7000);
                const outcome=classifyRecoveredRun(runId,receipt);
                if(outcome==="settled"||outcome==="aborted"){
                  agents.record(binding,{kind:"agent_settled",sequence:1,at:Date.now(),
                    text:outcome==="aborted"?"Agent interrupted":"Agent settled"});
                  binding=agents.get(p,o,binding.sessionId);
                  notifyRun(binding);
                }else if(outcome==="uncertain")
                  notice="Planner Session state could not be proved; no automatic replay";
              }catch(error){notice="Proposal inspection unavailable: "+String(error).slice(0,250);}
            }
            if(binding.phase==="settled"&&!ledger.report(binding)){
              try{await replaySettledReport(binding);}
              catch(error){notice=String(error).slice(0,280);}
            }
            const report=ledger.report(binding);
            return j({phase:binding.phase,runId,draftWorkflowId,
              proposal:report?.kind==="workflow_plan"?report.definition:null,
              summary:report?.kind==="workflow_plan"?report.summary:null,
              canAccept:!!report&&report.kind==="workflow_plan"&&
                ["settled","sealed"].includes(binding.phase)&&
                !(binding.latestKind==="agent_settled"&&binding.latestText==="Agent interrupted"),
              ...(notice?{notice}:{})});
          }
          case "auto.acceptProposal":{
            const input=object(ctx.input),draftWorkflowId=id(input.draftWorkflowId);
            const runId=id(input.runId);
            const binding=agents.getRun(p,o,draftWorkflowId,runId);
            if(!binding||binding.taskId!=="goal"||!binding.requestId.startsWith("auto:goal:")||
              (binding.phase!=="settled"&&binding.phase!=="sealed")||
              (binding.latestKind==="agent_settled"&&binding.latestText==="Agent interrupted"))
              throw new Error("A completed, registered Sol proposal is required");
            if(binding.phase==="settled"&&!ledger.report(binding))
              await replaySettledReport(binding);
            const report=ledger.report(binding);
            if(!report||report.kind!=="workflow_plan")
              throw new Error("Sol did not submit a valid typed Workflow proposal");
            const created=store.create(p,o,report.definition);
            if(binding.phase==="settled"){
              const evidence=ledger.sealEvidence(binding,"workflow-proposal",
                ("Approved "+created.definition.id+" ("+created.definition.tasks.length+
                  " Tasks): "+report.summary).slice(0,3500));
              const sealed=agents.seal(p,o,binding.sessionId!,evidence.ref);
              notifyRun(sealed);
            }
            return j(created);
          }
          case "auto.permissions":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            return j({approvals:permissions.list(p,o,workflowId),
              publication:publisher.list(p,o,workflowId),
              convergence:convergence.list(p,o,workflowId)});
          }
          case "auto.permission.decide":{
            const input=object(ctx.input),approvalId=id(input.approvalId);
            if(input.decision!=="approved"&&input.decision!=="rejected")
              throw new Error("Approval decision must be approved or rejected");
            const approved=permissions.decide(p,o,approvalId,input.decision);
            scheduleAutopilot(p,o,approved.workflowId);
            return j(approved);
          }
          case "auto.adr.latest":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            store.get(p,o,workflowId);
            return j(adr.latest(p,o,workflowId));
          }
          case "auto.adr.preview":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            return j(await adr.preview(p,o,workflowId,
              id(input.targetWorkspaceId),input.fields));
          }
          case "auto.adr.inspect":{
            const input=object(ctx.input);
            return j(adr.inspect(p,o,id(input.draftId)));
          }
          case "auto.adr.stage":{
            const input=object(ctx.input);
            return j(await adr.stage(p,o,id(input.draftId)));
          }
          case "auto.screenshot.list":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            store.get(p,o,workflowId);
            return j(screenshots.list(p,o,workflowId));
          }
          case "auto.screenshot.capture":{
            const input=object(ctx.input),workflowId=id(input.workflowId),runId=id(input.runId);
            const relativePath=nonempty(input.relativePath,180);
            return j(await screenshots.capture(p,o,workflowId,runId,relativePath));
          }
          case "auto.screenshot.preview":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            return j(screenshots.preview(p,o,workflowId,id(input.artifactId)));
          }
          case "auto.journal":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            const current=store.get(p,o,workflowId);
            return j(buildJournal(current,agents.list(p,o,"all"),ledger,
              screenshots.list(p,o,workflowId)));
          }
          case "auto.retention.preview":{
            const input=ctx.input===null?{}:object(ctx.input);
            const days=input.days===undefined?30:input.days;
            if(typeof days!=="number"||!Number.isSafeInteger(days))
              throw new Error("Retention days must be an integer");
            return j(retention.preview(p,o,days));
          }
          case "auto.retention.confirm":{
            const input=object(ctx.input);
            return j(retention.confirm(p,o,id(input.previewId)));
          }
          case "auto.worktree.status":{
            const input=object(ctx.input);
            return j(provisioner.find(p,o,id(input.workflowId),id(input.taskId)));
          }
          case "auto.worktree.preview":{
            const input=object(ctx.input),workflowId=id(input.workflowId),taskId=id(input.taskId);
            if(!workspaces)throw new Error("PI WEB workspace authority missing");
            const resolved=await workspaces.resolve({projectId:p,workspaceId:o});
            if(resolved.project.id!==p||resolved.workspace.id!==o||
              resolved.workspace.projectId!==p)
              throw new Error("Orchestra Workspace authority changed");
            return j(await provisioner.preview(p,o,workflowId,taskId,ctx.project.path));
          }
          case "auto.worktree.create":{
            const input=object(ctx.input);
            return j(await provisioner.create(p,o,id(input.planId),ctx.project.path));
          }
          case "auto.worktree.inspect":{
            const input=object(ctx.input);
            return j(await provisioner.inspect(p,o,id(input.planId)));
          }
          case "auto.integration.preview":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            if(ledger.get(p,o,workflowId)?.enabled)
              throw new Error("Pause Autopilot before confirming external Git integration");
            return j(await integration.preview(p,o,workflowId,
              id(input.taskId),id(input.targetWorkspaceId)));
          }
          case "auto.integration.confirm":{
            const input=object(ctx.input),previewId=id(input.previewId);
            // Revalidation of the exact Task revision, QC evidence and external
            // target commit is performed inside the verifier before CAS.
            return j(await integration.confirm(p,o,previewId));
          }
          case "auto.status":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            store.get(p,o,workflowId);
            return j(ledger.get(p,o,workflowId)??null);
          }
          case "auto.configure":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            const workflow=store.get(p,o,workflowId);
            const config=parseAutopilotConfig(input.config);
            const current=ledger.get(p,o,workflowId);
            if(current?.enabled)throw new Error("Pause Autopilot before changing its configuration");
            const active=agents.list(p,o,"active").some(b=>b.workflowId===workflowId&&
              b.requestId.startsWith("auto:"));
            if(active)throw new Error("Cannot reconfigure while an automated Pi Run is unsealed");
            const missing=Object.values(workflow.tasks).filter(t=>t.spec.kind==="implementation"&&
              !config.workspaces[t.spec.id]).map(t=>t.spec.id);
            if(missing.length)throw new WorkflowError("missing_worktrees",
              "Configure an existing linked worktree per implementation Task: "+missing.join(", "));
            return j(ledger.save(p,o,workflowId,config));
          }
          case "auto.start":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            const workflow=store.get(p,o,workflowId);
            const configured=ledger.get(p,o,workflowId);
            if(!configured)throw new WorkflowError("not_configured","Configure Autopilot first");
            if(bootstrap)await bootstrap;
            const fresh=ledger.get(p,o,workflowId);
            if(fresh?.enabled)return j(fresh);
            if(!workspaces)throw new Error("PI WEB workspace authority unavailable");
            const owners=new Set<string>();
            for(const task of Object.values(workflow.tasks).filter(t=>t.spec.kind==="implementation")){
              const workerId=configured.config.workspaces[task.spec.id];
              if(!workerId)throw new Error("Task "+task.spec.id+" needs a linked Worktree");
              const resolved=await workspaces.resolve({projectId:p,workspaceId:workerId});
              if(resolved.project.id!==p||resolved.workspace.projectId!==p||
                resolved.workspace.id!==workerId||resolved.workspace.isMain||
                resolved.workspace.provider?.metadata?.isGitWorktree!==true)
                throw new Error("Task "+task.spec.id+" has no valid linked PI WEB worktree");
              if(owners.has(resolved.workspace.path))
                throw new Error("Multiple implementation Tasks resolve to the same Worktree path");
              owners.add(resolved.workspace.path);
              const reviewId=configured.config.reviewWorkspaces?.[task.spec.id];
              if(reviewId){
                const qc=await workspaces.resolve({projectId:p,workspaceId:reviewId});
                if(qc.project.id!==p||qc.workspace.id!==reviewId||qc.workspace.isMain||
                  qc.workspace.provider?.metadata?.isGitWorktree!==true)
                  throw new Error("QC requires an existing linked Worktree");
              }
            }
            const manual=agents.list(p,o,"all").some(b=>b.workflowId===workflowId&&
              !b.requestId.startsWith("auto:")&&
              !["sealed","failed"].includes(b.phase));
            if(manual)throw new Error("Manually owned Runs are still live or unsealed; reconcile them first");
            await reconcileWorkflow(configured);
            ledger.setStatus(p,o,workflowId,true,"Autopilot running; no merge or Worktree GC is automatic");
            scheduleAutopilot(p,o,workflowId);
            return j(ledger.get(p,o,workflowId));
          }
          case "auto.pause":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            store.get(p,o,workflowId);
            ledger.setStatus(p,o,workflowId,false,"Paused by operator. Running Pi Sessions are not aborted.");
            return j(ledger.get(p,o,workflowId));
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
            if(binding.requestId.startsWith("auto:")&&action==="newTurn")
              throw new Error("Only Autopilot may admit the initial turn of its bound Pi Session");
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
            if(binding.requestId.startsWith("auto:")){
              const authorized=store.wasApplied(p,o,binding.workflowId,"auto:complete:"+binding.runId);
              const persisted=ledger.evidence(binding);
              if(!authorized||!persisted||persisted.ref!==input.evidenceRef)
                throw new Error("Autopilot Run sealing requires its committed workflow transition and exact evidence");
            }
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
    async dispose(){
      automationReady=false;
      if(automationTimer)clearInterval(automationTimer);
      // First reject new executor ticks, then drain outstanding I/O before
      // closing the ledger and Workflow/Run DBs. PI WEB has already cancelled
      // our lifetime signal, so hosted Pi operations fail closed if interrupted.
      const drained=autopilot?.stop();
      if(bootstrap)await bootstrap;
      if(drained)await drained;
      for(const bridge of live.values())bridge.stop();
      live.clear();viewers.clear();convergence.close();publisher.close();permissions.close();adr.close();screenshots.close();retention.close();provisioner.close();integration.close();ledger.close();agents.close();store.close();
    },
  };
 },
};
export default plugin;
