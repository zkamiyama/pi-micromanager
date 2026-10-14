/** Public PI WEB Host API adapter for the deterministic Autopilot engine. */
import { internalRunId,sessionDisplayName } from "../core/identifiers.js";
import { randomUUID,createHash } from "node:crypto";
import {boundedFailureDiagnostics} from "./test-diagnostics.js";
import {requireCleanGit} from "./git.js";
import {testInvocation,assertTestEnvironment} from "./test-execution.js";
import { resolve } from "node:path";
import type {
  ServerPluginActivationContext, PiWebHostPiSessionsV1,
  PiWebHostWorkspacesV1,
} from "@jmfederico/pi-web/server-plugin-api";
import type { WorkflowStore } from "../core/store.js";
import type { TaskState } from "../core/workflow.js";
import type { AgentBinding, AgentRegistry, Reservation, Seat } from "../runtime/registry.js";
import type { PiSessionBridge } from "../runtime/session-bridge.js";
import {isDurableSession,type DurableRunHost} from "../runtime/durable-runner.js";
import type { AgentRuntime } from "./ledger.js";
import type { ExecutorPort, LaunchJob } from "./engine.js";

// Prevent Git environment inherited from a Pi/PI WEB host from redirecting
// commands to an unrelated repository, index, or object store.
const GIT_ENV_KEYS=[
  "GIT_ALTERNATE_OBJECT_DIRECTORIES","GIT_COMMON_DIR","GIT_DIR",
  "GIT_INDEX_FILE","GIT_OBJECT_DIRECTORY","GIT_PREFIX",
  "GIT_QUARANTINE_PATH","GIT_WORK_TREE",
];
export interface HostPortOptions {
  host:ServerPluginActivationContext;
  workflows:WorkflowStore;
  agents:AgentRegistry;
  /** Production routes new Workflows to Durable; legacy fixtures and
   * persisted pi-web profiles keep the host-native session path. */
  durable?:DurableRunHost;
  getRuntime?(p:string,o:string,w:string):AgentRuntime;
  getSessions():PiWebHostPiSessionsV1|undefined;
  getWorkspaces():PiWebHostWorkspacesV1|undefined;
  probe(binding:AgentBinding):Promise<{bridge:PiSessionBridge;status:string}>;
  validateRun(task:TaskState,seat:Seat):string;
  replaySettledReport(binding:AgentBinding):Promise<void>;
  notify(binding:AgentBinding):void;
  assertAdmitted?(job:LaunchJob):void;
}
export function createHostExecutor(options:HostPortOptions):ExecutorPort & {
  resumeUnstarted(binding:AgentBinding,job:LaunchJob,assertAdmitted:()=>void):Promise<AgentBinding>;
} {
  const {host,workflows,agents,probe,notify}=options;
  const assertActive=()=>host.lifetimeSignal.throwIfAborted();
  async function workspace(projectId:string,workspaceId:string){
    const api=options.getWorkspaces();
    if(!api)throw new Error("PI WEB workspaces capability unavailable");
    const authority=await api.resolve({projectId,workspaceId});
    if(authority.project.id!==projectId||authority.workspace.projectId!==projectId||
      authority.workspace.id!==workspaceId)throw new Error("Workspace authority mismatch");
    agents.registerWorkspacePath?.(projectId,workspaceId,authority.workspace.path);
    return authority.workspace;
  }
  async function gitRead(path:string,args:string[]):Promise<string> {
    const r=await host.execFile({file:"git",args:["-C",path,...args],
      signal:host.lifetimeSignal,timeoutMs:10000,unsetEnv:GIT_ENV_KEYS});
    if(r.exitCode!==0||r.signal||r.stdoutTruncated||r.stderrTruncated)
      throw new Error("Git check failed: "+(r.stderr||r.stdout).slice(-280));
    return r.stdout.trim();
  }
  async function snapshot(path:string):Promise<{sha:string;clean:boolean}>{
    return {sha:await requireCleanGit(host,path),clean:true};
  }
  async function linkedWorktree(projectId:string,workspaceId:string){
    const w=await workspace(projectId,workspaceId);
    if(w.isMain||w.provider?.metadata?.isGitWorktree!==true)
      throw new Error("Automatic code execution requires an existing linked, isolated PI WEB Git worktree");
    const root=await gitRead(w.path,["rev-parse","--show-toplevel"]);
    if(resolve(root)!==resolve(w.path))
      throw new Error("Git root does not match the resolved PI WEB linked worktree");
    return w;
  }
  return {
    assertCompleted(binding){
      if(isDurableSession(binding.sessionId)){
        if(!options.durable)throw new Error("Durable runtime authority unavailable");
        options.durable.assertProvedCompleted(binding);
      }
    },
    recoverReport:options.replaySettledReport,
    async launch(job:LaunchJob){
      const admitted=()=>{assertActive();options.assertAdmitted?.(job);};
      admitted();
      let executablePath:string;
      if(job.kind==="implementation"||job.kind==="qc"||job.kind==="diagnosis"){
        const w=await linkedWorktree(job.projectId,job.workspaceId);
        executablePath=w.path;
        const before=await snapshot(w.path);
        if(!before.clean)throw new Error("Dirty Worktree; refusing automated Pi launch");
        if(job.kind!=="implementation"&&before.sha!==job.headSha)
          throw new Error("Review/diagnosis snapshot SHA differs from the implementation commit");
        if(job.kind==="implementation"){
          for(const upstreamSha of job.requiredAncestors??[]){
            if(!/^[0-9a-f]{40,64}$/.test(upstreamSha))
              throw new Error("Unverified upstream dependency Git SHA");
            try{await gitRead(w.path,["merge-base","--is-ancestor",upstreamSha,"HEAD"]);}
            catch{
              throw new Error("Dependent Worktree is missing QC-passed upstream commit "+
                upstreamSha.slice(0,12)+"; integrate dependencies before launching this Task");
            }
          }
        }
      }else executablePath=(await workspace(job.projectId,job.workspaceId)).path;
      admitted();
      const current=workflows.get(job.projectId,job.orchestraWorkspaceId,job.workflowId);
      const task=current.tasks[job.taskId];
      if(!task)throw new Error("Unknown Task");
      if(job.kind==="planning"){
        const amendment=current.amendments.find(a=>a.targetTaskId===job.taskId&&
          a.status==="planning"&&internalRunId("plan",a.id)===job.runId);
        if(!amendment||job.seat!=="planner")
          throw new Error("Stale/invalid Sol planning Run");
      }else if(options.validateRun(task,job.seat)!==job.runId)
        throw new Error("Stale or invalid Task admission");
      const reservation:Reservation={
        projectId:job.projectId,orchestraWorkspaceId:job.orchestraWorkspaceId,
        workspaceId:job.workspaceId,workflowId:job.workflowId,
        taskId:job.taskId,runId:job.runId,seat:job.seat,requestId:"auto:"+randomUUID(),
      };
      if(agents.getRun(job.projectId,job.orchestraWorkspaceId,job.workflowId,job.runId))
        throw new Error("Already reserved: never create the same one-shot Run twice");
      admitted();
      if(options.durable&&options.getRuntime?.(job.projectId,job.orchestraWorkspaceId,
        job.workflowId)==="durable"){
        return options.durable.launch({reservation,kind:job.kind,model:job.model,
          cwd:executablePath,prompt:job.prompt,assertAdmitted:admitted});
      }
      const sessions=options.getSessions();
      if(!sessions)throw new Error("PI WEB native Pi sessions capability unavailable");
      notify(agents.reserve(reservation));
      // Any uncertain sessions.create response intentionally leaves this durable
      // reservation untouched; operator reconciliation is required.
      admitted();
      const created=await sessions.create({projectId:job.projectId,workspaceId:job.workspaceId});
      // Preserve the exact Session identity even if the plugin was revoked
      // during the non-atomic host creation response. Never send a new prompt
      // when shutdown is already in progress.
      let binding=agents.assign(reservation,created.sessionId);
      notify(binding);
      admitted();
      const checked=await probe(binding);
      binding=agents.get(job.projectId,job.orchestraWorkspaceId,created.sessionId);
      admitted();
      if(checked.status!=="ok")throw new Error("Pi companion did not acknowledge its probe");
      const configured=await checked.bridge.send({
        type:"configure",requestId:randomUUID(),provider:job.model.provider,
        model:job.model.model,...(job.model.effort?{effort:job.model.effort}:{}),
        job:{runId:job.runId,kind:job.kind},
        sessionName:sessionDisplayName("AUTO",job.seat,job.taskId,job.runId),
      },10000);
      if(configured.status!=="ok"||configured.provider!==job.model.provider||
        configured.model!==job.model.model||
        (job.model.effort!==undefined&&configured.effort!==job.model.effort)){
        binding=agents.update(binding,configured.status==="uncertain"?"uncertain":"blocked");
        notify(binding);
        throw new Error("Exact model/effort setup failed or was not acknowledged");
      }
      binding=agents.update(binding,"configured",{provider:job.model.provider,model:job.model.model,
        ...(job.model.effort?{effort:job.model.effort}:{})});
      notify(binding);
      admitted();
      const started=await checked.bridge.send({
        type:"message",requestId:randomUUID(),text:job.prompt,delivery:"newTurn",
      },10000);
      const observed=agents.get(job.projectId,job.orchestraWorkspaceId,created.sessionId);
      if(started.status!=="ok"){
        // A short Pi turn may have settled before the command receipt arrives.
        // Never regress a terminal Run to blocked/uncertain or replay its prompt.
        if(observed.phase!=="settled"&&observed.phase!=="sealed"){
          binding=agents.update(observed,started.status==="uncertain"?"uncertain":"blocked");
          notify(binding);
        }
        throw new Error("Pi did not acknowledge the automatic start ("+started.status+")");
      }
      if(observed.phase==="settled"||observed.phase==="running"){
        notify(observed);
        return observed;
      }
      binding=agents.update(observed,"running");
      notify(binding);
      return binding;
    },
    async resumeUnstarted(binding,job,assertAdmitted){
      const admitted=()=>{assertActive();assertAdmitted();};
      admitted();
      if(!binding.sessionId||!binding.requestId.startsWith("auto:")||binding.abortRequested===1||
        !["created","connected","configured"].includes(binding.phase))
        throw new Error("Only an attached, unstarted automatic Run may be recovered explicitly");
      for(const key of ["projectId","orchestraWorkspaceId","workflowId","taskId","runId","workspaceId","seat"] as const)
        if(binding[key]!==job[key])throw new Error("Frozen launch contract does not match the exact Run");
      const current=workflows.get(job.projectId,job.orchestraWorkspaceId,job.workflowId);
      const task=current.tasks[job.taskId];
      if(!task)throw new Error("Recovery Task is missing");
      if(job.kind==="planning"){
        if(!current.amendments.some(a=>a.status==="planning"&&a.targetTaskId===job.taskId&&
          internalRunId("plan",a.id)===job.runId))throw new Error("Recovery intervention changed");
      }else if(options.validateRun(task,job.seat)!==job.runId)
        throw new Error("Recovery Task admission changed");
      const ws=job.kind==="implementation"||job.kind==="qc"||job.kind==="diagnosis"?
        await linkedWorktree(job.projectId,job.workspaceId):await workspace(job.projectId,job.workspaceId);
      if(job.kind==="implementation"||job.kind==="qc"||job.kind==="diagnosis"){
        const state=await snapshot(ws.path);
        if(job.kind!=="implementation"&&state.sha!==job.headSha)
          throw new Error("Recovery snapshot differs from the frozen review SHA");
        for(const sha of job.requiredAncestors??[])
          await gitRead(ws.path,["merge-base","--is-ancestor",sha,"HEAD"]);
      }
      admitted();
      if(binding.sessionId.startsWith("durable:")){
        if(!options.durable)throw new Error("Original Durable runtime is unavailable");
        return options.durable.resumeUnstarted(binding,{reservation:{
          projectId:binding.projectId,orchestraWorkspaceId:binding.orchestraWorkspaceId,
          workflowId:binding.workflowId,taskId:binding.taskId,runId:binding.runId,
          workspaceId:binding.workspaceId,seat:binding.seat,requestId:binding.requestId},
          cwd:ws.path,kind:job.kind,model:job.model,prompt:job.prompt,assertAdmitted:admitted});
      }
      const checked=await probe(binding);
      admitted();
      if(checked.status!=="ok")throw new Error("Original native Pi Session is unavailable");
      const proof=await checked.bridge.send({type:"inspect",requestId:randomUUID()},7000);
      if(proof.status!=="ok"||proof.idle!==true||proof.fresh!==true||
        proof.inputAccepted!==false||proof.pendingMessages!==false||
        proof.jobRunId!==undefined&&proof.jobRunId!==job.runId)
        throw new Error("Native Session cannot prove zero accepted input; no replay permitted");
      admitted();
      const configured=await checked.bridge.send({type:"configure",requestId:randomUUID(),
        provider:job.model.provider,model:job.model.model,...(job.model.effort?{effort:job.model.effort}:{}),
        job:{runId:job.runId,kind:job.kind},sessionName:sessionDisplayName("AUTO",job.seat,job.taskId,job.runId)});
      if(configured.status!=="ok"||configured.provider!==job.model.provider||configured.model!==job.model.model||
        job.model.effort!==undefined&&configured.effort!==job.model.effort)
        throw new Error("Original model configuration was not acknowledged");
      notify(agents.update(agents.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId),"configured",job.model));
      admitted();
      const started=await checked.bridge.send({type:"message",
        requestId:"initial:"+createHash("sha256").update(JSON.stringify([binding.projectId,binding.orchestraWorkspaceId,binding.workflowId,binding.runId])).digest("hex"),
        text:job.prompt,delivery:"newTurn"},10000);
      const observed=agents.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId);
      if(started.status!=="ok"){
        if(!["running","settled","sealed"].includes(observed.phase))notify(agents.update(observed,"uncertain"));
        throw new Error("Recovery input admission is uncertain; inspect, never repeat blindly");
      }
      if(!["running","settled","sealed"].includes(observed.phase))notify(agents.update(observed,"running"));
      return agents.get(binding.projectId,binding.orchestraWorkspaceId,binding.sessionId);
    },
    async checkSnapshot(binding,expectedSha){
      const w=await linkedWorktree(binding.projectId,binding.workspaceId);
      const state=await snapshot(w.path);
      if(!state.clean||state.sha!==expectedSha)
        throw new Error("Read-only diagnosis modified or lost its frozen QC snapshot");
    },
    async verify(binding,config,expectedSha){
      const w=await linkedWorktree(binding.projectId,binding.workspaceId);
      const before=await snapshot(w.path);
      if(expectedSha!==undefined&&before.sha!==expectedSha)
        throw new Error("QC SHA mismatch; refuse to finalize verdict");
      if(!before.clean)throw new Error("Uncommitted files in inspected worktree");
      const workflow=workflows.get(binding.projectId,
        binding.orchestraWorkspaceId,binding.workflowId);
      const task=workflow.tasks[binding.taskId];
      if(task?.spec.systemPurpose==="final-integration"){
        if(!config.finalization||binding.workspaceId!==config.finalization.workspaceId)
          throw new Error("Final QC must run in the configured integration Worktree");
        for(const source of Object.values(workflow.tasks)){
          if(source.spec.kind!=="implementation"||
            source.spec.systemPurpose==="final-integration")continue;
          if(!["passed","integrated"].includes(source.status)||
            source.lastQc?.verdict!=="pass")
            throw new Error("Final QC source Task is no longer passed");
          try{
            await gitRead(w.path,["merge-base","--is-ancestor",
              source.lastQc.headSha,"HEAD"]);
          }catch{
            throw new Error("Final integration is missing QC-approved source commit "+
              source.spec.id+" "+source.lastQc.headSha.slice(0,12));
          }
        }
      }
      const invocation=testInvocation(config.test,w.path);
      const result=await host.execFile({
        ...invocation,
        timeoutMs:config.test.timeoutMs,signal:host.lifetimeSignal,
        // Test code is not an OS sandbox: at least prevent accidental
        // provider and publication credentials from environment inheritance.
        unsetEnv:Object.keys(process.env).filter(key=>
          !["PATH","SystemRoot","WINDIR","COMSPEC","PATHEXT","LANG","LC_ALL","TMPDIR","TEMP","TMP"].includes(key)),
      });
      assertTestEnvironment(config.test,result);
      const after=await snapshot(w.path);
      const clean=before.clean&&after.clean&&before.sha===after.sha;
      const testsPassed=result.exitCode===0&&!result.signal&&
        !result.stdoutTruncated&&!result.stderrTruncated;
      // Output may contain credentials or proprietary code. Persist finite
      // fingerprints and exit metadata, NOT the raw stdout/stderr or arguments.
      const details="file="+config.test.file.slice(0,100)+
        " argc="+config.test.args.length+
        " exit="+String(result.exitCode)+
        " truncated="+String(result.stdoutTruncated||result.stderrTruncated)+
        " stdoutBytes="+Buffer.byteLength(result.stdout)+
        " stdoutSha256="+createHash("sha256").update(result.stdout).digest("hex")+
        " stderrBytes="+Buffer.byteLength(result.stderr)+
        " stderrSha256="+createHash("sha256").update(result.stderr).digest("hex");
      const actionable=testsPassed?"":" redactedFailure="+boundedFailureDiagnostics(result.stdout,result.stderr);
      return {headSha:after.sha,clean,testsPassed,details:details+actionable};
    },
    onTransition:notify,
  };
}
