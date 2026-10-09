/** Public PI WEB Host API adapter for the deterministic Autopilot engine. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  ServerPluginActivationContext, PiWebHostPiSessionsV1,
  PiWebHostWorkspacesV1,
} from "@jmfederico/pi-web/server-plugin-api";
import type { WorkflowStore } from "../core/store.js";
import type { TaskState } from "../core/workflow.js";
import type { AgentBinding, AgentRegistry, Reservation, Seat } from "../runtime/registry.js";
import type { PiSessionBridge } from "../runtime/session-bridge.js";
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
  getSessions():PiWebHostPiSessionsV1|undefined;
  getWorkspaces():PiWebHostWorkspacesV1|undefined;
  probe(binding:AgentBinding):Promise<{bridge:PiSessionBridge;status:string}>;
  validateRun(task:TaskState,seat:Seat):string;
  replaySettledReport(binding:AgentBinding):Promise<void>;
  notify(binding:AgentBinding):void;
}
export function createHostExecutor(options:HostPortOptions):ExecutorPort {
  const {host,workflows,agents,probe,notify}=options;
  const assertActive=()=>host.lifetimeSignal.throwIfAborted();
  async function workspace(projectId:string,workspaceId:string){
    const api=options.getWorkspaces();
    if(!api)throw new Error("PI WEB workspaces capability unavailable");
    const authority=await api.resolve({projectId,workspaceId});
    if(authority.project.id!==projectId||authority.workspace.projectId!==projectId||
      authority.workspace.id!==workspaceId)throw new Error("Workspace authority mismatch");
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
    const sha=await gitRead(path,["rev-parse","HEAD"]);
    const status=await gitRead(path,["status","--porcelain"]);
    if(!/^[0-9a-f]{40,64}$/.test(sha))throw new Error("No Git HEAD in resolved workspace");
    return {sha,clean:status.length===0};
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
    recoverReport:options.replaySettledReport,
    async launch(job:LaunchJob){
      assertActive();
      const sessions=options.getSessions();
      if(!sessions)throw new Error("Pi sessions capability unavailable");
      if(job.kind==="implementation"||job.kind==="qc"||job.kind==="diagnosis"){
        const w=await linkedWorktree(job.projectId,job.workspaceId);
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
      }else await workspace(job.projectId,job.workspaceId);
      assertActive();
      const current=workflows.get(job.projectId,job.orchestraWorkspaceId,job.workflowId);
      const task=current.tasks[job.taskId];
      if(!task)throw new Error("Unknown Task");
      if(job.kind==="planning"){
        const amendment=current.amendments.find(a=>a.targetTaskId===job.taskId&&
          a.status==="planning"&&"plan-"+a.id===job.runId);
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
      assertActive();
      notify(agents.reserve(reservation));
      // Any uncertain sessions.create response intentionally leaves this durable
      // reservation untouched; operator reconciliation is required.
      assertActive();
      const created=await sessions.create({projectId:job.projectId,workspaceId:job.workspaceId});
      // Preserve the exact Session identity even if the plugin was revoked
      // during the non-atomic host creation response. Never send a new prompt
      // when shutdown is already in progress.
      let binding=agents.assign(reservation,created.sessionId);
      notify(binding);
      assertActive();
      const checked=await probe(binding);
      binding=agents.get(job.projectId,job.orchestraWorkspaceId,created.sessionId);
      assertActive();
      if(checked.status!=="ok")throw new Error("Pi companion did not acknowledge its probe");
      const configured=await checked.bridge.send({
        type:"configure",requestId:randomUUID(),provider:job.model.provider,
        model:job.model.model,...(job.model.effort?{effort:job.model.effort}:{}),
        job:{runId:job.runId,kind:job.kind},
        sessionName:"AUTO "+job.seat+" "+job.taskId+" "+job.runId,
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
      assertActive();
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
      const result=await host.execFile({
        file:config.test.file,args:config.test.args,cwd:w.path,
        timeoutMs:config.test.timeoutMs,signal:host.lifetimeSignal,
      });
      const after=await snapshot(w.path);
      const clean=before.clean&&after.clean&&before.sha===after.sha;
      const testsPassed=result.exitCode===0&&!result.signal&&
        !result.stdoutTruncated&&!result.stderrTruncated;
      const details="argv="+JSON.stringify([config.test.file,...config.test.args]).slice(0,350)+
        " exit="+String(result.exitCode)+" truncated="+String(result.stdoutTruncated||result.stderrTruncated)+
        " stderr="+result.stderr.slice(-400);
      return {headSha:after.sha,clean,testsPassed,details};
    },
    onTransition:notify,
  };
}
