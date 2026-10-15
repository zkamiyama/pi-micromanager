import {productionPolicy} from "../security/policy.js";
import {LocalJournal} from "../automation/local-journal.js";
import {OwnedWorktreeRetention} from "../automation/owned-worktree-retention.js";
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
import {internalRunId,sessionDisplayName} from "../core/identifiers.js";
import { WorkflowError, type WorkflowAction, type TaskState } from "../core/workflow.js";
import { AgentRegistry, type AgentBinding, type Reservation, type Seat } from "../runtime/registry.js";
import { PiSessionBridge } from "../runtime/session-bridge.js";
import { type RuntimeActivity, type RuntimeControl } from "../runtime/protocol.js";
import { AutopilotLedger, parseAutopilotConfig } from "../automation/ledger.js";
import { QuickLaunchLedger, type QuickGoal } from "../automation/quick-launch.js";
import {linearizeImplementationDag} from "../automation/dag-linearization.js";
import {validateExecutionPlan} from "../automation/admission.js";
import {newWorkflow} from "../core/workflow.js";
import { AutopilotEngine } from "../automation/engine.js";
import { createHostExecutor } from "../automation/host-port.js";
import { DurableRunHost,isDurableSession,type DurableKind } from "../runtime/durable-runner.js";
import type { AgentRuntime } from "../automation/ledger.js";
import { IntegrationVerifier } from "../automation/integration.js";
import { ManagedWorktreeProvisioner } from "../automation/worktree-provisioner.js";
import { resolveManagedGitWorkspace } from "../automation/workspace-discovery.js";
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
    return internalRunId("impl",task.spec.id,task.attempts);
  if(seat==="qc"&&task.spec.kind==="implementation"&&task.status==="awaiting_qc"&&task.pendingWork)
    return internalRunId("qc",task.spec.id,task.pendingWork.attempt);
  if((seat==="architect"||seat==="planner"||seat==="qc")&&
    (task.spec.kind==="diagnosis"||task.spec.kind==="synthesis")&&task.status==="running"&&task.attempts>0)
    return internalRunId("task",task.spec.id,task.attempts);
  throw new WorkflowError("task_not_dispatchable","The task has no admitted run for this role");
}
type Fanout={scope:string;send:(payload:JsonValue)=>void};
const plugin:PiWebServerPlugin={
 apiVersion:3,name:"pi-micromanager",
 // PI WEB only resolves capabilities declared here. Keep native session
 // requirements even though newly configured Autopilot Runs default to Durable,
 // otherwise the explicit pi-web compatibility backend would be unreachable.
 requires:[PI_WEB_HOST_PI_SESSIONS_CAPABILITY,PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,PI_WEB_HOST_WORKSPACES_CAPABILITY],
 activate(host){
  const store=new WorkflowStore(join(host.dataDirectory,"workflows.sqlite"));
  const agents=new AgentRegistry(join(host.dataDirectory,"agents.sqlite"));
  const ledger=new AutopilotLedger(join(host.dataDirectory,"autopilot.sqlite"));
  const quick=new QuickLaunchLedger(join(host.dataDirectory,"quick-launch.sqlite"));
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
    externallyPinned:(p,o,w)=>permissions.hasPending(p,o,w)||publisher.hasIncomplete(p,o,w),
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
  const quickFlights=new Map<string,Promise<void>>();
  const startFlights=new Map<string,Promise<AutopilotRecord>>();
  const durable=new DurableRunHost({
    dataDirectory:host.dataDirectory,lifetimeSignal:host.lifetimeSignal,agents,ledger,
    finalContracts:binding=>{
      const workflow=store.get(binding.projectId,binding.orchestraWorkspaceId,binding.workflowId);
      const final=workflow.tasks[binding.taskId];
      if(final?.spec.systemPurpose!=="final-integration"||
        final.status!=="awaiting_qc")
        throw new Error("Final QC contract request is not bound to an awaiting final Task");
      return Object.values(workflow.tasks).filter(t=>t.spec.kind==="implementation"&&
        t.spec.systemPurpose!=="final-integration").map(t=>{
          if(!t.lastQc||t.lastQc.verdict!=="pass"||
            !["passed","integrated"].includes(t.status))
            throw new Error("Unverified source in final QC contract set");
          return {taskId:t.spec.id,title:t.spec.title,qcSha:t.lastQc.headSha,
            ...(t.spec.description?{description:t.spec.description}:{}),
            ...(t.spec.acceptanceCriteria?{acceptanceCriteria:t.spec.acceptanceCriteria}:{})};
        });
    },
    activity:emit,changed:notifyRun,
    report:(binding,report)=>{
      ledger.recordReport(binding,report);
      scheduleAutopilot(binding.projectId,binding.orchestraWorkspaceId,binding.workflowId);
    },
    wake:binding=>scheduleAutopilot(binding.projectId,binding.orchestraWorkspaceId,
      binding.workflowId),
  });
  const localPolicy=productionPolicy(host.dataDirectory)?.localRetention;
  const localJournal=localPolicy?new LocalJournal({dataDirectory:host.dataDirectory,workflows:store,agents,ledger,host,
    policy:localPolicy,workspaces:()=>workspaces,
    externallyPinned:(p,o,w)=>permissions.hasPending(p,o,w)||publisher.hasIncomplete(p,o,w)}):undefined;
  const localFlights=new Map<string,Promise<void>>();
  const localStatus=new Map<string,{phase:string;message:string}>();
  const maintenanceKey=(p:string,o:string,w:string)=>JSON.stringify([p,o,w]);
  const assertRetirable=(p:string,o:string,w:string,revision?:number,generation?:number)=>{
    host.lifetimeSignal.throwIfAborted();
    if(!localJournal||localJournal.protected(p,o,w))throw new Error("Local retention is blocked by active, unsealed, pending or uncertain work");
    if(revision!==undefined&&store.get(p,o,w).revision!==revision||generation!==undefined&&ledger.get(p,o,w)?.generation!==generation)
      throw new Error("Local retention authority changed");
  };
  async function archiveFinishedRuns(p:string,o:string,w:string):Promise<void>{
    assertRetirable(p,o,w);
    const revision=store.get(p,o,w).revision,generation=ledger.get(p,o,w)!.generation;
    const check=()=>assertRetirable(p,o,w,revision,generation);
    for(const b of agents.listWorkflow(p,o,w)){
      check();if(!isDurableSession(b.sessionId))throw new Error("Native Session lifecycle is human-owned");
      await durable.stopRun(b);check();
      const artifact=localJournal!.archiveRun(b);
      await durable.retireCompleted(b,artifact.id,check);
    }
  }
  const worktreeRetention=localJournal?new OwnedWorktreeRetention({dataDirectory:host.dataDirectory,host,workflows:store,agents,ledger,
    provisioner,workspaces:()=>workspaces,protected:(p,o,w)=>localJournal.protected(p,o,w),prepareRuns:archiveFinishedRuns}):undefined;
  function maintainLocal(p:string,o:string,w:string):Promise<void>{
    if(!localJournal||!worktreeRetention)throw new Error("Explicit local-owner profile required");
    const key=maintenanceKey(p,o,w),old=localFlights.get(key);if(old)return old;
    assertRetirable(p,o,w);
    const flight=(async()=>{
      localStatus.set(key,{phase:"running",message:"Archiving completed public logs and reclaiming owned working copies"});
      await archiveFinishedRuns(p,o,w);
      if(localPolicy!.autoReclaimWorktrees){
        for(const t of Object.values(store.get(p,o,w).tasks)){
          if(t.spec.kind!=="implementation"||!provisioner.find(p,o,w,t.spec.id))continue;
          const preview=await worktreeRetention.preview(p,o,w,t.spec.id);
          if(preview.state!=="completed")await worktreeRetention.confirm(p,o,preview.id);
        }
      }
      localJournal.artifacts.collect(p,o);
      localStatus.set(key,{phase:"completed",message:"Completed Run details bounded; Git refs and minimal no-replay receipts retained"});
    })().catch(error=>{
      localStatus.set(key,{phase:"blocked",message:"Retention unconfirmed; original resources/receipts retained for inspection"});
      throw error;
    });
    localFlights.set(key,flight);
    void flight.finally(()=>{if(localFlights.get(key)===flight)localFlights.delete(key);}).catch(()=>{});
    return flight;
  }
  function scheduleLocalMaintenance(p:string,o:string,w:string):void{
    if(!localJournal||host.lifetimeSignal.aborted||localJournal.protected(p,o,w))return;
    const key=maintenanceKey(p,o,w);if(localStatus.get(key)?.phase==="blocked"||localStatus.get(key)?.phase==="completed")return;
    void maintainLocal(p,o,w).catch(()=>host.logger.warn("Local maintenance retained unresolved test/Run state",{workflowId:w}));
  }
  function durableKind(binding:AgentBinding):DurableKind{
    if(binding.runId.startsWith("goal-"))return "workflow_plan";
    if(binding.runId.startsWith("plan-"))return "planning";
    const wf=store.get(binding.projectId,binding.orchestraWorkspaceId,binding.workflowId);
    const task=wf.tasks[binding.taskId];
    if(!task)throw new Error("Durable Run Task no longer belongs to its Workflow");
    return binding.seat==="qc"&&task.spec.kind==="implementation"?"qc":
      task.spec.kind==="implementation"?"implementation":task.spec.kind;
  }
  async function durablePath(binding:AgentBinding):Promise<string>{
    if(!workspaces)throw new Error("PI WEB workspace authority unavailable");
    const authority=await workspaces.resolve({
      projectId:binding.projectId,workspaceId:binding.workspaceId});
    if(authority.project.id!==binding.projectId||
      authority.workspace.id!==binding.workspaceId||
      authority.workspace.projectId!==binding.projectId)
      throw new Error("Durable workspace authority changed");
    return authority.workspace.path;
  }
  function scheduleAutopilot(projectId:string,workspaceId:string,workflowId:string):void {
    if(host.lifetimeSignal.aborted||!automationReady)return;
    const cfg=ledger.get(projectId,workspaceId,workflowId);
    if(cfg?.enabled&&autopilot)queueMicrotask(()=>{
      if(!host.lifetimeSignal.aborted)void autopilot!.tick(cfg).then(()=>scheduleLocalMaintenance(projectId,workspaceId,workflowId));
    });
  }
  const orchestraKey=(project:string,orchestraWorkspaceId:string)=>JSON.stringify([project,orchestraWorkspaceId]);
  const bridgeKey=(binding:AgentBinding)=>JSON.stringify([binding.projectId,binding.orchestraWorkspaceId,binding.sessionId]);
  function notifyRun(binding:AgentBinding):void {
    // Engine, one-command and explicit operator sealing all converge here.
    // Release the live Durable watcher/SQLite handle once evidence is sealed;
    // the transcript and host evidence remain on disk for read-only history.
    if(binding.phase==="sealed"&&isDurableSession(binding.sessionId)){
      void durable.stopRun(binding).catch(error=>
        host.logger.error("Sealed Pi Durable Run could not be released",
          {runId:binding.runId,message:String(error).slice(0,400)}));
    }
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
      !binding.requestId.startsWith("auto:"))
      throw new Error("Only a settled automated Pi Run can replay its report");
    if(isDurableSession(binding.sessionId)){
      durable.assertProvedCompleted(binding);
      if(!ledger.report(binding))
        throw new Error("Durable tool result is missing a committed host report; stop safely");
      return;
    }
    if(!sessionEvents)throw new Error("PI WEB session-events capability missing");
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
    agents.registerWorkspacePath(ctx.project.id,targetWorkspace,resolved.workspace.path);
    if(seat==="implementer"||seat==="qc"||seat==="architect"){
      if(resolved.workspace.isMain||resolved.workspace.provider?.metadata?.isGitWorktree!==true)
        throw new WorkflowError("worktree_required",
          "Implementation and QC Runs require an isolated linked Git worktree");
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
      const entries=agents.listWorkflow(record.projectId,record.orchestraWorkspaceId,
        record.workflowId,"active").filter(b=>b.requestId.startsWith("auto:"));
      for(const binding of entries){
        if(host.lifetimeSignal.aborted)throw new Error("Plugin is shutting down");
        if(binding.phase!=="running"||!binding.sessionId)
          throw new Error("Run "+binding.runId+" requires manual reconciliation ("+binding.phase+")");
        if(isDurableSession(binding.sessionId)){
          const outcome=await durable.reconnect(binding,await durablePath(binding),
            durableKind(binding));
          if(outcome==="uncertain")
            throw new Error("Durable Run needs manual reconciliation");
          if(outcome==="settled"){
            const current=agents.get(binding.projectId,binding.orchestraWorkspaceId,
              binding.sessionId);
            if(current.phase==="running")emit(current,{kind:"agent_settled",
              sequence:1,at:Date.now(),text:"Agent settled"});
          }
          continue;
        }
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
    for(const cfg of ledger.listEnabled()){
      try{await reconcileWorkflow(cfg);}
      catch(error){
        ledger.setStatus(cfg.projectId,cfg.orchestraWorkspaceId,cfg.workflowId,false,
          "Paused on restart: "+String(error).slice(0,800));
      }
    }
  }
  const executor=createHostExecutor({
      host,workflows:store,agents,durable,
      getRuntime:(p,o,w)=>ledger.get(p,o,w)?.config.runtime??"pi-web",
      getSessions:()=>sessions,getWorkspaces:()=>workspaces,probe,
      validateRun:plannedRunId,notify:notifyRun,
      assertAdmitted:job=>{
        const state=ledger.get(job.projectId,job.orchestraWorkspaceId,job.workflowId);
        if(!state||!state.enabled||state.generation!==job.controlGeneration)
          throw new Error("Autopilot stopped or reconfigured during Run admission");
      },
      replaySettledReport,
    });
  autopilot=new AutopilotEngine(store,agents,ledger,{
    ...executor,
    publish:(record,workflow)=>publisher.step(record,workflow),
    converge:(record,workflow)=>convergence.step(record,workflow),
    authorizeImplementation:(record,workflow,taskId,nextAttempt)=>{
      const workspaceId=workflow.tasks[taskId]?.spec.systemPurpose==="final-integration"?
        record.config.finalization?.workspaceId:record.config.workspaces[taskId];
      if(!workspaceId)throw new Error("Missing linked implementation Workspace");
      return permissions.ensureCommit(record.projectId,record.orchestraWorkspaceId,
        record.workflowId,taskId,nextAttempt,workspaceId).decision;
    },
  });
  async function launchGoalProposal(p:string,o:string,goal:string,
    provider:string,model:string,effort:string|undefined,
    token:string,oneCommand:boolean,runtime:AgentRuntime="durable"){
            if(!workspaces)throw new Error("PI WEB Workspace provider unavailable");
            const available=agents.list(p,o,"active").filter(b=>b.taskId==="goal"&&
              b.requestId.startsWith("auto:goal:"));
            if(available.length>=3)throw new Error("Resolve or accept previous goal proposals first");
            const authorized=await workspaces.resolve({projectId:p,workspaceId:o});
            if(authorized.project.id!==p||authorized.workspace.id!==o)
              throw new Error("Current PI WEB Workspace authority changed");
            const draftWorkflowId="draft-"+token,runId="goal-"+token;
            const prompt="You are Sol, an independent READ-ONLY workflow planner. User goal:\n"+
              goal+"\nPropose a precise, acyclic Task DAG with 1..16 implementation Tasks. "+
              "Each Task MUST contain bounded detailed requirements and independently testable "+
              "acceptance criteria. Prefer qc_passed dependency gates; use integrated only "+
              "where explicit upstream Git integration is required. "+
              "Use lowercase kebab-case Task/workflow IDs. "+
              "Call mm_workflow_proposal exactly once. Do not edit source files, "+
              "create Pi Sessions, execute shell commands, or start implementation. "+
              (oneCommand?
                "The human has explicitly preauthorized automatic execution under a saved "+
                "project profile and fixed permission policy. Do not include permission "+
                "overrides or skip validation; the host will verify and start the DAG.":
                "A human will review the proposal and separately configure Worktrees/models.");
            const reservation:Reservation={
              projectId:p,orchestraWorkspaceId:o,workspaceId:o,workflowId:draftWorkflowId,
              taskId:"goal",runId,seat:"planner",requestId:"auto:goal:"+token,
            };
            if(runtime==="durable"){
              const binding=await durable.launch({reservation,
                kind:"workflow_plan",cwd:authorized.workspace.path,
                model:{provider,model,...(effort?{effort}:{})},prompt});
              return {draftWorkflowId,runId,sessionId:binding.sessionId,
                status:oneCommand?
                  "Durable Sol is planning; validated tasks will start automatically":
                  "Durable Sol is preparing a human-reviewed DAG proposal"};
            }
            if(!sessions)throw new Error("PI WEB native Pi Sessions capability missing");
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
            return {draftWorkflowId,runId,sessionId:created.sessionId,
              status:oneCommand?"Sol is planning; validated tasks will start automatically":
                "Sol is preparing a read-only, human-reviewed DAG proposal"};
  }

  function startConfiguredAutopilot(p:string,o:string,workflowId:string,
    projectRoot:string):Promise<AutopilotRecord>{
    const key=JSON.stringify([p,o,workflowId]);
    const existing=startFlights.get(key);if(existing)return existing;
    const flight=startConfiguredOnce(p,o,workflowId,projectRoot);
    startFlights.set(key,flight);
    void flight.finally(()=>{if(startFlights.get(key)===flight)startFlights.delete(key);}).catch(()=>{});
    return flight;
  }
  async function startConfiguredOnce(p:string,o:string,
    workflowId:string,projectRoot:string):Promise<AutopilotRecord>{
            const workflow=store.get(p,o,workflowId);
            const configured=ledger.get(p,o,workflowId);
            if(!configured)throw new WorkflowError("not_configured","Configure Autopilot first");
            validateExecutionPlan(workflow,configured.config);
            if(bootstrap)await bootstrap;
            ledger.assertCurrent(configured,false);
            const fresh=ledger.get(p,o,workflowId);
            if(fresh?.enabled)return fresh;
            if(!workspaces)throw new Error("PI WEB workspace authority unavailable");
            const manual=agents.listWorkflow(p,o,workflowId).some(b=>
              !b.requestId.startsWith("auto:")&&
              !["sealed","failed"].includes(b.phase));
            if(manual)throw new Error("Manually owned Runs are still live or unsealed; reconcile them first");
            // The operator explicitly started Autopilot; save/configure alone
            // never mutates Git. Prepare ALL Worktrees before starting a Pi Run.
            let ready=configured;
            if(ready.config.managedWorktrees){
              const needed=Object.values(workflow.tasks).filter(t=>
                t.spec.kind==="implementation"&&t.spec.systemPurpose!=="final-integration").length+
                (ready.config.finalization?.workspaceId==="auto"?1:0);
              if(needed>(ready.config.maxManagedWorktrees??32))
                throw new Error("Managed Worktree budget exceeded before Git mutation: "+needed);
              const workspacesByTask={...ready.config.workspaces};
              const missing=Object.values(workflow.tasks).filter(t=>
                t.spec.kind==="implementation"&&
                t.spec.systemPurpose!=="final-integration"&&!workspacesByTask[t.spec.id]);
              const needsFinal=ready.config.finalization?.workspaceId==="auto";
              if(missing.length||needsFinal){
                for(const task of missing){
                  ledger.assertCurrent(ready,false);
                  const plan=await provisioner.ensure(p,o,workflowId,task.spec.id,projectRoot,()=>ledger.assertCurrent(ready,false));
                  workspacesByTask[task.spec.id]=await resolveManagedGitWorkspace(
                    workspaces,p,plan.path);
                }
                let finalization=ready.config.finalization;
                if(needsFinal&&finalization){
                  ledger.assertCurrent(ready,false);
                  const plan=await provisioner.ensure(p,o,workflowId,
                    "mm-final-integration",projectRoot,()=>ledger.assertCurrent(ready,false));
                  finalization={...finalization,workspaceId:
                    await resolveManagedGitWorkspace(workspaces,p,plan.path)};
                }
                // Persist all host-validated identities before ANY Pi Session.
                ledger.assertCurrent(ready,false);
                ready=ledger.save(p,o,workflowId,{
                  ...ready.config,workspaces:workspacesByTask,
                  ...(finalization?{finalization}:{}),
                },ready.generation);
              }
            }
            const owners=new Set<string>();
            for(const task of Object.values(workflow.tasks).filter(t=>
              t.spec.kind==="implementation"&&t.spec.systemPurpose!=="final-integration")){
              const workerId=ready.config.workspaces[task.spec.id];
              if(!workerId)throw new Error("Task "+task.spec.id+" needs a linked Worktree");
              const resolved=await workspaces.resolve({projectId:p,workspaceId:workerId});
              if(resolved.project.id!==p||resolved.workspace.projectId!==p||
                resolved.workspace.id!==workerId||resolved.workspace.isMain||
                resolved.workspace.provider?.metadata?.isGitWorktree!==true)
                throw new Error("Task "+task.spec.id+" has no valid linked PI WEB worktree");
              const physical=agents.registerWorkspacePath(p,workerId,resolved.workspace.path);
              if(owners.has(physical))
                throw new Error("Multiple implementation Tasks resolve to the same Worktree path");
              owners.add(physical);
              const reviewId=ready.config.reviewWorkspaces?.[task.spec.id];
              if(reviewId){
                const qc=await workspaces.resolve({projectId:p,workspaceId:reviewId});
                if(qc.project.id!==p||qc.workspace.id!==reviewId||qc.workspace.isMain||
                  qc.workspace.provider?.metadata?.isGitWorktree!==true)
                  throw new Error("QC requires an existing linked Worktree");
                agents.registerWorkspacePath(p,reviewId,qc.workspace.path);
              }
            }
            if(ready.config.finalization){
              const finalId=ready.config.finalization.workspaceId;
              if(finalId==="auto")throw new Error("Final Worktree identity remains unresolved");
              const final=await workspaces.resolve({projectId:p,workspaceId:finalId});
              if(final.project.id!==p||final.workspace.projectId!==p||
                final.workspace.id!==finalId||final.workspace.isMain||
                final.workspace.provider?.metadata?.isGitWorktree!==true||
                owners.has(agents.registerWorkspacePath(p,finalId,final.workspace.path)))
                throw new Error("Final integration requires an independent linked Worktree");
              agents.registerWorkspacePath(p,finalId,final.workspace.path);
              if(Object.values(ready.config.reviewWorkspaces??{}).includes(finalId))
                throw new Error("Final Worktree cannot share a QC Workspace");
            }
            ledger.assertCurrent(ready,false);
            await reconcileWorkflow(ready);
            ledger.assertCurrent(ready,false);
            if(!ledger.setProgress(ready,true,
              "Autopilot running; managed Worktrees retained, PR merge gated by QC and policy"))
              throw new Error("Autopilot admission changed while starting");
            scheduleAutopilot(p,o,workflowId);
            return ledger.get(p,o,workflowId)!;
  }

  /** One per-workspace flight; the immutable request receipt is committed
   * before opening any Pi Session. Network and Git replies are never replayed
   * when the prior result is uncertain. */
  async function advanceQuick(job:QuickGoal):Promise<void>{
    const p=job.projectId,o=job.orchestraWorkspaceId;
    const current=quick.find(p,o,job.requestId);
    if(!current||current.phase==="cancelled"||current.phase==="needs_attention"||
      current.phase==="finished")return;
    if(current.phase==="running"||current.phase==="paused"){
      const config=ledger.get(p,o,current.workflowId);
      if(config?.enabled){
        if(current.phase==="paused")quick.phase(p,o,current.requestId,"running","Autopilot resumed.");
        return;
      }
      const workflow=store.get(p,o,current.workflowId);
      const completed=Object.values(workflow.tasks).every(t=>
        t.status==="integrated"||t.status==="done");
      quick.phase(p,o,current.requestId,completed?"finished":"paused",
        completed?"GitHub merge / DAG complete":
          "Autopilot paused: "+(config?.status??"inspect the Workflow"));
      return;
    }
    const run=agents.getRun(p,o,current.draftWorkflowId,current.runId);
    if(!run){
      if(current.phase!=="reserved")
        throw new Error("Missing reserved Sol Session; refusing a duplicate");
      const profile=current.profile.config.models.planner;
      await launchGoalProposal(p,o,current.goal,profile.provider,profile.model,
        profile.effort,current.draftWorkflowId.slice(6),true,
        current.profile.config.runtime);
      quick.phase(p,o,current.requestId,"planning",
        "Sol is building a validated Task DAG. No modifying Pi run has started.");
      return;
    }
    if(["reserved","created","connected","configured","uncertain","blocked","failed"].includes(run.phase))
      throw new Error("Sol Session requires reconciliation ("+run.phase+"); no repeated prompt");
    if(run.phase==="running"){
      if(current.phase==="reserved")
        quick.phase(p,o,current.requestId,"planning","Sol is planning in its original Pi Session.");
      if(run.sessionId&&isDurableSession(run.sessionId)){
        await durable.reconnect(run,await durablePath(run),"workflow_plan");
        return;
      }
      if(run.sessionId&&!live.get(bridgeKey(run))?.connected){
        const connected=await connect(run);
        const receipt=await connected.send({type:"inspect",requestId:randomUUID()},7000);
        const outcome=classifyRecoveredRun(run.runId,receipt);
        if(outcome==="uncertain")throw new Error("Sol result uncertain; no prompt replay");
        if(outcome==="settled"||outcome==="aborted"){
          agents.record(run,{kind:"agent_settled",sequence:1,at:Date.now(),
            text:outcome==="aborted"?"Agent interrupted":"Agent settled"});
          notifyRun(agents.get(p,o,run.sessionId));
        }
      }
      return;
    }
    if(current.phase==="reserved"||current.phase==="planning"){
      if(run.latestKind==="agent_settled"&&run.latestText==="Agent interrupted")
        throw new Error("Sol planning was interrupted; never auto-accept");
      if(!ledger.report(run)&&run.phase==="settled")
        await replaySettledReport(run);
      const report=ledger.report(run);
      if(!report||report.kind!=="workflow_plan")
        throw new Error("Sol ended without a valid structured DAG report");
      if(quick.find(p,o,current.requestId)?.phase==="cancelled")return;
      // Ignore model-authored permissions; freeze the operator's reviewed
      // policy and assign a deterministic, collision-resistant Workflow ID.
      const proposed={...report.definition,id:current.workflowId,
        permissions:current.profile.permissions};
      const def=current.profile.config.convergenceMode==="linearized"?
        linearizeImplementationDag(proposed):proposed;
      validateExecutionPlan(newWorkflow(def,new Date().toISOString()),current.profile.config);
      store.create(p,o,def); // Idempotent if we crashed after the DB commit.
      if(run.phase==="settled"){
        const evidence=ledger.sealEvidence(run,"one-command-proposal",
          ("Automatic DAG "+current.workflowId+" ("+def.tasks.length+
            " Tasks): "+report.summary).slice(0,3500));
        const sealed=agents.seal(p,o,run.sessionId!,evidence.ref);
        notifyRun(sealed);
      }
      if(!ledger.get(p,o,current.workflowId))
        ledger.save(p,o,current.workflowId,current.profile.config);
      quick.phase(p,o,current.requestId,"starting",
        "DAG validated and saved. Preparing isolated Worktrees and starting Autopilot.");
      return;
    }
    if(current.phase==="starting"){
      const state=ledger.get(p,o,current.workflowId);
      if(state?.enabled){
        quick.phase(p,o,current.requestId,"running","Autopilot is running.");
        return;
      }
      if(!state)throw new Error("Saved Workflow configuration is missing");
      // The profile snapshot may be used only for this exact Workflow; no
      // reconfiguration from the mutable project profile during execution.
      const resolved=await workspaces?.resolve({projectId:p,workspaceId:o});
      if(!resolved||resolved.project.id!==p||resolved.workspace.id!==o)
        throw new Error("Original PI WEB project/workspace authority changed");
      if(quick.find(p,o,current.requestId)?.phase!=="starting")return;
      await startConfiguredAutopilot(p,o,current.workflowId,resolved.project.path);
      if(quick.find(p,o,current.requestId)?.phase!=="cancelled")
        quick.phase(p,o,current.requestId,"running",
          "Autopilot started. Follow the DAG and Journal for QC and PR status.");
    }
  }
  function scheduleQuick(job:QuickGoal):void{
    if(host.lifetimeSignal.aborted||!automationReady)return;
    const key=JSON.stringify([job.projectId,job.orchestraWorkspaceId,job.requestId]);
    if(quickFlights.has(key))return;
    const flight=advanceQuick(job).catch(error=>{
      const current=quick.find(job.projectId,job.orchestraWorkspaceId,job.requestId);
      if(current&&current.phase!=="cancelled"&&current.phase!=="needs_attention"){
        quick.phase(job.projectId,job.orchestraWorkspaceId,job.requestId,
          "needs_attention","Paused safely: "+String(error).slice(0,610));
      }
    });
    quickFlights.set(key,flight);
    void flight.finally(()=>{if(quickFlights.get(key)===flight)quickFlights.delete(key);})
      .catch(()=>{});
  }

  return {
    start({capabilities}){
      sessions=capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
      sessionEvents=capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
      workspaces=capabilities.resolve(PI_WEB_HOST_WORKSPACES_CAPABILITY);
      bootstrap=restoreEnabledAutopilots().then(()=>{
        if(host.lifetimeSignal.aborted)return;
        // Validate persisted configuration before enabling a background timer.
        const enabled=ledger.listEnabled();
        automationReady=true;
        if(localJournal)for(const cfg of ledger.listMaintenanceCandidates())
          scheduleLocalMaintenance(cfg.projectId,cfg.orchestraWorkspaceId,cfg.workflowId);
        automationTimer=setInterval(()=>{
          if(host.lifetimeSignal.aborted)return;
          try{
            for(const cfg of ledger.listEnabled())
              void autopilot!.tick(cfg).then(()=>scheduleLocalMaintenance(cfg.projectId,cfg.orchestraWorkspaceId,cfg.workflowId));
            for(const job of quick.pending())scheduleQuick(job);
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
        for(const job of quick.pending())scheduleQuick(job);
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
            const automatedRuns=agents.hasAutomatedRun(p,o,workflowId);
            if((running||automatedRuns)&&
              !["request_intervention","cancel_amendment","resume_after_diagnosis","extend_qc_budget"].includes(action.type))
              throw new WorkflowError("autopilot_owns_transition",
                "Autopilot owns real Task/QC transitions; simulation commands cannot overwrite its history");
            if(action.type==="request_intervention"){
              const current=store.get(p,o,workflowId);
              if(ledger.get(p,o,workflowId)?.config.finalization&&!current.tasks["mm-final-integration"]&&current.definition.tasks.length+6>512)
                throw new Error("Reserve diagnosis and final integration Task slots before intervention");
            }
            if(action.type==="extend_qc_budget"&&(running||agents.hasUnsealedAutomatedRun(p,o,workflowId)))
              throw new Error("Pause and reconcile unsealed Runs before extending a QC budget");
            if(!Number.isSafeInteger(input.expectedRevision))throw new WorkflowError("invalid_revision","Expected revision required");
            const next=store.act(p,o,workflowId,input.expectedRevision as number,
              id(input.commandId),action);
            if(running)scheduleAutopilot(p,o,workflowId);
            return j(next);
          }


          case "auto.quick.status":{
            const goals=quick.list(p,o).map(goal=>{
              if(goal.phase!=="running"&&goal.phase!=="paused")return goal;
              const current=ledger.get(p,o,goal.workflowId);
              return {...goal,message:current?.status??goal.message};
            });
            return j({profile:quick.profile(p,o),goals});
          }
          case "auto.quick.configure":{
            const profile=quick.saveProfile(p,o,object(ctx.input));
            return j({profile,goals:quick.list(p,o)});
          }
          case "auto.quick.start":{
            const input=object(ctx.input),requestId=id(input.requestId);
            // Retrying the exact accepted request is idempotent; starting a
            // different DAG while the same workspace runs another Autopilot
            // would race source Git/remote publication and is not allowed.
            if(!quick.find(p,o,requestId)&&ledger.listEnabled().some(record=>
              record.projectId===p&&record.orchestraWorkspaceId===o))
              throw new Error("Another Autopilot is running in this project Workspace; pause or complete it first");
            const goal=quick.begin(p,o,input.goal,requestId);
            scheduleQuick(goal);
            return j(goal);
          }
          case "auto.quick.cancel":{
            const input=object(ctx.input);
            const requestId=id(input.requestId);
            const pending=quick.find(p,o,requestId);
            if(pending?.phase==="starting"){
              if(agents.hasAutomatedRun(p,o,pending.workflowId))
                throw new Error("Code admission has begun; pause the Workflow instead");
              if(ledger.get(p,o,pending.workflowId))
                ledger.setStatus(p,o,pending.workflowId,false,"One-command Start cancelled by operator");
            }
            const goal=quick.cancel(p,o,requestId);
            return j(goal);
          }
          case "auto.propose":{
            const input=object(ctx.input),goal=nonempty(input.goal,4000);
            if(goal.includes("\0"))throw new Error("Invalid goal input");
            const provider=nonempty(input.provider,120),model=nonempty(input.model,160);
            const effort=input.effort===undefined?undefined:nonempty(input.effort,32);
            const token=randomUUID().replace(/-/g,"").slice(0,16);
            const runtime=input.runtime===undefined?"durable":input.runtime;
            if(runtime!=="durable"&&runtime!=="pi-web")
              throw new Error("Invalid goal runtime");
            return j(await launchGoalProposal(p,o,goal,provider,model,effort,
              token,false,runtime));
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
                if(isDurableSession(binding.sessionId)){
                  // Goal proposals are Durable Conversations by default, not
                  // host-native Pi Sessions. Reconnect to their own SQLite
                  // Harness; never pass a durable:<hash> to session-events.
                  const outcome=await durable.reconnect(binding,
                    await durablePath(binding),"workflow_plan");
                  if(outcome==="settled"){
                    agents.record(binding,{kind:"agent_settled",sequence:1,
                      at:Date.now(),text:"Agent settled"});
                    binding=agents.get(p,o,binding.sessionId);
                    notifyRun(binding);
                  }
                }else{
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
                }
              }catch(error){notice="Proposal inspection unavailable: "+String(error).slice(0,250);}
            }
            if(binding.phase==="settled"&&!ledger.report(binding)){
              try{await replaySettledReport(binding);}
              catch(error){notice=String(error).slice(0,280);}
            }
            const report=ledger.report(binding);
            let provedCompleted=!isDurableSession(binding.sessionId);
            if(!provedCompleted){
              try{durable.assertProvedCompleted(binding);provedCompleted=true;}
              catch{/* A provisional report must never become an accepted proposal. */}
            }
            return j({phase:binding.phase,runId,draftWorkflowId,
              proposal:report?.kind==="workflow_plan"?report.definition:null,
              summary:report?.kind==="workflow_plan"?report.summary:null,
              canAccept:provedCompleted&&binding.abortRequested!==1&&
                !!report&&report.kind==="workflow_plan"&&
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
            if(isDurableSession(binding.sessionId))durable.assertProvedCompleted(binding);
            if(binding.abortRequested===1)
              throw new Error("Interrupted proposal cannot be accepted");
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
          case "auto.journal.local.import":{
            if(!localJournal)throw new Error("Local-owner Journal is not enabled");
            const i=object(ctx.input);
            return j(localJournal.importImage(p,o,{workflowId:id(i.workflowId),runId:id(i.runId),sourceSha:nonempty(i.sourceSha,64),
              requestId:id(i.requestId),label:nonempty(i.label,180),base64:nonempty(i.base64,700000)}));
          }
          case "auto.journal.local.read":{
            if(!localJournal)throw new Error("Local-owner Journal is not enabled");
            return j(localJournal.artifacts.read(p,o,id(object(ctx.input).artifactId)));
          }
          case "auto.journal.local.pin":{
            if(!localJournal)throw new Error("Local-owner Journal is not enabled");
            const i=object(ctx.input);if(typeof i.pinned!=="boolean")throw new Error("Explicit pin decision required");
            return j(localJournal.artifacts.pin(p,o,id(i.artifactId),i.pinned));
          }
          case "auto.journal.adr.link":{
            if(!localJournal)throw new Error("Local-owner Journal is not enabled");
            const i=object(ctx.input);return j(await localJournal.link(p,o,{workflowId:id(i.workflowId),workspaceId:id(i.workspaceId),path:nonempty(i.path,180)}));
          }
          case "auto.maintenance.preview":{
            if(!localJournal||!worktreeRetention)throw new Error("Local-owner maintenance is not enabled");
            const i=object(ctx.input),w=id(i.workflowId);store.get(p,o,w);
            return j({artifacts:localJournal.artifacts.preview(p,o),worktrees:worktreeRetention.list(p,o,w),
              status:localStatus.get(maintenanceKey(p,o,w))??{phase:"not-run",message:"No completion claim"}});
          }
          case "auto.maintenance.run":{
            const w=id(object(ctx.input).workflowId);await maintainLocal(p,o,w);
            return j(localStatus.get(maintenanceKey(p,o,w)));
          }
          case "auto.worktree.retire.preview":{
            if(!worktreeRetention)throw new Error("Local-owner maintenance is not enabled");
            const i=object(ctx.input);return j(await worktreeRetention.preview(p,o,id(i.workflowId),id(i.taskId)));
          }
          case "auto.worktree.retire.confirm":{
            if(!worktreeRetention)throw new Error("Local-owner maintenance is not enabled");
            return j(await worktreeRetention.confirm(p,o,id(object(ctx.input).previewId)));
          }
          case "auto.journal":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            const current=store.get(p,o,workflowId);
            const journal=buildJournal(current,agents.listWorkflow(p,o,workflowId),ledger,screenshots.list(p,o,workflowId));
            return j({...journal,...(localJournal?{local:{artifacts:localJournal.artifacts.list(p,o,workflowId),
              adrLinks:localJournal.links(p,o,workflowId),usage:localJournal.artifacts.usage(),
              retirements:worktreeRetention!.list(p,o,workflowId),
              status:localStatus.get(maintenanceKey(p,o,workflowId))??{phase:"not-run",message:"No completion claim"}}}:{})});
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
            const active=agents.hasUnsealedAutomatedRun(p,o,workflowId);
            if(active)throw new Error("Cannot reconfigure while an automated Pi Run is unsealed");
            const missing=Object.values(workflow.tasks).filter(t=>
              t.spec.kind==="implementation"&&t.spec.systemPurpose!=="final-integration"&&
              !config.workspaces[t.spec.id]).map(t=>t.spec.id);
            if(missing.length&&!config.managedWorktrees)
              throw new WorkflowError("missing_worktrees",
                "Configure a linked Worktree per Task or opt into managedWorktrees: "+missing.join(", "));
            validateExecutionPlan(workflow,config);
            return j(ledger.save(p,o,workflowId,config));
          }
          case "auto.recover.unstarted":{
            const input=object(ctx.input),binding=registered(ctx,id(input.sessionId));
            const reason=nonempty(input.reason,1000),workflowId=binding.workflowId;
            const config=ledger.get(p,o,workflowId);
            if(!config||config.enabled)throw new Error("Pause Autopilot before inspecting an unstarted Run");
            const key=JSON.stringify([p,o,workflowId]);
            if(recoveryFlights.has(key)||startFlights.has(key))throw new Error("Workflow admission/recovery is already in progress");
            const job=ledger.launchFor(binding);
            ledger.setStatus(p,o,workflowId,false,"Operator requested zero-input Run recovery: "+reason.slice(0,700));
            const paused=ledger.get(p,o,workflowId)!;
            const flight=(async()=>{
              try{
                await executor.resumeUnstarted(binding,job,()=>ledger.assertCurrent(paused,false));
                ledger.assertCurrent(paused,false);
                if(!ledger.setProgress(paused,true,"Original Run resumed after verified zero-input inspection"))
                  throw new Error("Operator control changed during recovery");
                scheduleAutopilot(p,o,workflowId);
              }catch(error){
                ledger.setProgress(paused,false,"Recovery paused safely: "+String(error).slice(0,800));
                throw error;
              }
            })();
            recoveryFlights.set(key,flight);
            try{await flight;}finally{if(recoveryFlights.get(key)===flight)recoveryFlights.delete(key);}
            return j(agents.get(p,o,binding.sessionId!));
          }
          case "auto.start":{
            const workflowId=id(object(ctx.input).workflowId);
            return j(await startConfiguredAutopilot(p,o,workflowId,ctx.project.path));
          }
          case "auto.pause":{
            const input=object(ctx.input),workflowId=id(input.workflowId);
            store.get(p,o,workflowId);
            ledger.setStatus(p,o,workflowId,false,"Paused by operator. Running Pi Sessions are not aborted.");
            const paused=ledger.get(p,o,workflowId)!;
            try{await publisher.cancelScheduled(paused);}catch(error){
              ledger.setProgress(paused,false,"Paused locally; legacy GitHub cancellation needs attention: "+String(error).slice(0,700));
            }
            return j(ledger.get(p,o,workflowId));
          }
          case "agents.list":{
            const input=ctx.input===null?{}:object(ctx.input);
            const view=input.view==="history"?"history":input.view==="all"?"all":"active";
            return j(agents.list(p,o,view).map(b=>({
              ...b,connected:Boolean(b.sessionId&&
                 (isDurableSession(b.sessionId)?durable.connected(b.sessionId):
                   live.get(bridgeKey(b))?.connected)),
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
            const manualTask=store.get(p,o,run.workflowId).tasks[run.taskId];
            if(!manualTask)throw new Error("Manual Run Task disappeared");
            const receipt=await checked.bridge.send({
              type:"configure",requestId:randomUUID(),provider,model,...(effort?{effort}:{}),
              job:{runId:run.runId,
                kind:run.seat==="qc"&&manualTask.spec.kind==="implementation"?
                  "qc":manualTask.spec.kind},
              sessionName:sessionDisplayName("MM",run.seat,run.taskId,run.runId),
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
            if(isDurableSession(binding.sessionId)){
              const status=await durable.reconnect(binding,await durablePath(binding),
                durableKind(binding));
              return j({...binding,probeStatus:status,runtime:"durable"});
            }
            const checked=await probe(binding);
            const current=agents.get(p,o,binding.sessionId!);
            notifyRun(current);
            return j({...current,probeStatus:checked.status});
          }
          case "agents.configure":{
            const input=object(ctx.input);
            let binding=registered(ctx,id(input.sessionId));
            if(binding.requestId.startsWith("auto:"))
              throw new Error("Automatic model configuration is owned by the frozen launch contract; use explicit unstarted recovery");
            if(binding.phase==="running"||binding.phase==="settled"||binding.phase==="sealed"||
              binding.phase==="uncertain"||binding.phase==="failed")
              throw new Error("Cannot configure a running, completed or uncertain execution");
            const bridge=live.get(bridgeKey(binding));
            if(!bridge?.connected)throw new Error("Reconnect this Pi Session first");
            const provider=nonempty(input.provider,120),model=nonempty(input.model);
            const effort=input.effort===undefined?undefined:nonempty(input.effort,32);
            const manualTask=store.get(p,o,binding.workflowId).tasks[binding.taskId];
            if(!manualTask)throw new Error("Manual Run Task disappeared");
            const receipt=await bridge.send({type:"configure",requestId:id(input.requestId),
              provider,model,...(effort?{effort}:{}),
              job:{runId:binding.runId,
                kind:binding.seat==="qc"&&manualTask.spec.kind==="implementation"?
                  "qc":manualTask.spec.kind}});
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
            const action=input.action;
            if((action==="steer"||action==="followUp")&&binding.phase!=="running")
              throw new Error("Live messages require a configured, already running Run");
            if(isDurableSession(binding.sessionId)){
              if(action!=="abort"&&action!=="steer"&&action!=="followUp")
                throw new Error("Durable Run accepts steer, followUp, or abort only");
              const receipt=await durable.command(binding,await durablePath(binding),
                durableKind(binding),action,id(input.requestId),
                action==="abort"?undefined:nonempty(input.text,16000));
              return j(receipt);
            }
            const bridge=live.get(bridgeKey(binding));
            if(!bridge?.connected)throw new Error("Reconnect before sending a command");
            if(binding.requestId.startsWith("auto:")&&action==="newTurn")
              throw new Error("Only Autopilot may admit the initial turn of its bound Pi Session");
            let cmd:RuntimeControl;
            if(action==="abort"){
              agents.requestAbort(binding);
              cmd={type:"abort",requestId:id(input.requestId)};
            }
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
      const quickDrain=Promise.allSettled([...quickFlights.values()]);
      if(bootstrap)await bootstrap;
      if(drained)await drained;
      await quickDrain;
      await Promise.allSettled([...startFlights.values(),...recoveryFlights.values()]);
      await Promise.allSettled([...localFlights.values()]);
      await durable.close();
      worktreeRetention?.close();localJournal?.close();
      for(const bridge of live.values())bridge.stop();
      live.clear();viewers.clear();convergence.close();publisher.close();permissions.close();adr.close();screenshots.close();retention.close();provisioner.close();integration.close();quick.close();ledger.close();agents.close();store.close();
    },
  };
 },
};
export default plugin;
