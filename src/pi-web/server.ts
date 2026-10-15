/** Security entrypoint around the existing public PI WEB control plane. */
import base from "./control-plane.js";
import {chmodSync,readdirSync,lstatSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {PiWebServerPlugin,PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";
import {parseProductionPolicy,installProductionPolicy,assertProductionProject,
  assertProductionConfig,assertProductionModel} from "../security/policy.js";
import {acquireStateOwner} from "../security/state-owner.js";
import {guardedHostExecution,type HostRequest} from "../security/host-execution.js";
import {assertWorkspaceBoundary} from "../security/workspace-boundary.js";
import {assertStateActivation,persistProductionMode} from "../security/state-mode.js";
import {validateModelAuthFile} from "../security/auth-source.js";
import {parseAutopilotConfig,AutopilotLedger} from "../automation/ledger.js";
import {QuickLaunchLedger,parseQuickProfile} from "../automation/quick-launch.js";
import {WorkflowStore} from "../core/store.js";
import {inspectStorage,assertStorageAdmission} from "../security/storage-admission.js";
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const plugin:PiWebServerPlugin={...base,async activate(host){
  const policy=parseProductionPolicy(host.settings.productionSecurity);
  if(policy?.modelAuthFile)validateModelAuthFile(policy.modelAuthFile,
    [...policy.projectRoots,host.dataDirectory,host.packageRoot]);
  const owner=policy?await acquireStateOwner(host.dataDirectory):undefined;
  let uninstall:()=>void=()=>{};
  const signal=owner?AbortSignal.any([host.lifetimeSignal,owner.lost]):host.lifetimeSignal;
  let generations:DatabaseSync|undefined;
  // Capture an immutable cross-workflow control-generation snapshot at Git
  // invocation, and compare it AFTER asynchronous repository inspection.
  // This deliberately invalidates unrelated in-flight Git operations on an
  // operator transition rather than allowing a stale push/merge.
  const snapshotGenerations=()=>{
    if(!generations)throw new Error("Production operation-generation ledger unavailable");
    return JSON.stringify(generations.prepare(
      "SELECT scope,workflow_id,enabled,generation FROM autopilots ORDER BY scope,workflow_id").all());
  };
  const captureFence=(request:HostRequest)=>{
    signal.throwIfAborted();owner?.assertHeld();
    const captured=policy?snapshotGenerations():undefined;
    return ()=>{
      signal.throwIfAborted();owner?.assertHeld();
      // Capacity may change while asynchronous Git config inspection runs.
      // Recheck before new Worktree allocation, never while only inspecting it.
      if(policy&&["git","/usr/bin/git"].includes(request.file)&&
        request.args?.[2]==="worktree"&&request.args?.[3]==="add")
        assertStorageAdmission(host.dataDirectory,policy.storage);
      signal.throwIfAborted();owner?.assertHeld();
      if(policy&&snapshotGenerations()!==captured)
        throw new Error("Operator control generation changed during Git preflight");
    };
  };
  let failedActivationCleanup:(()=>Promise<void>)|undefined;
  try{
    assertStateActivation(host.dataDirectory,Boolean(policy));
    if(policy){owner?.assertHeld();persistProductionMode(host.dataDirectory);}
    if(policy)uninstall=installProductionPolicy(host.dataDirectory,policy);
    const backend=await base.activate({...host,lifetimeSignal:signal,
      execFile:guardedHostExecution(host.execFile,policy,captureFence)});
    if(policy)generations=new DatabaseSync(join(host.dataDirectory,"autopilot.sqlite"),
      {readOnly:true,allowExtension:false});
    let disposal:Promise<void>|undefined;
    let draining=false;
    const requestsInFlight=new Set<Promise<unknown>>();
    const dispose=(disposeSignal:AbortSignal):Promise<void>=>{
      if(!disposal){
        draining=true;
        disposal=(async()=>{
        // A request that entered before owner loss may still be in asynchronous
        // preflight. Join it before backend DBs close and before releasing flock.
        await Promise.allSettled([...requestsInFlight]);
        // Never release the state lock if active workers could not be joined.
        await backend.dispose?.(disposeSignal);
        signal.removeEventListener("abort",onLifetimeEnd);
        generations?.close();
        uninstall();
        await owner?.release();
      })();
      }
      return disposal;
    };
    const onLifetimeEnd=()=>{
      void dispose(new AbortController().signal).catch(()=>
        host.logger.error("Control-plane shutdown failed; ownership retained for safety"));
    };
    signal.addEventListener("abort",onLifetimeEnd,{once:true});
    if(signal.aborted)onLifetimeEnd();
    failedActivationCleanup=()=>dispose(new AbortController().signal);
    signal.throwIfAborted();
    if(policy){
      for(const name of readdirSync(host.dataDirectory))if(/\.sqlite(?:-(?:wal|shm))?$/.test(name)){
        const file=join(host.dataDirectory,name),s=lstatSync(file);
        if(!s.isFile()||s.nlink!==1)throw new Error("Unexpected SQLite alias during activation");
        chmodSync(file,0o600);
      }
    }
    const request=backend.peer?.request;
    return {...backend,
      async start(ctx){
        if(policy){
          signal.throwIfAborted();
          const ledger=new AutopilotLedger(join(host.dataDirectory,"autopilot.sqlite"));
          const workflows=new WorkflowStore(join(host.dataDirectory,"workflows.sqlite"));
          const quick=new QuickLaunchLedger(join(host.dataDirectory,"quick-launch.sqlite"));
          try{
            for(const record of ledger.listEnabled())assertProductionConfig(policy,record.config,
              workflows.get(record.projectId,record.orchestraWorkspaceId,record.workflowId).definition);
            for(const goal of quick.pending())assertProductionConfig(policy,goal.profile.config,
              {permissions:goal.profile.permissions});
          }finally{quick.close();workflows.close();ledger.close();}
        }
        const capabilities=policy?{...ctx.capabilities,
          resolve:((cap:Parameters<typeof ctx.capabilities.resolve>[0])=>{
            const api=ctx.capabilities.resolve(cap);
            if(cap.id==="pi-sessions"||cap.id==="pi-session-events"){
              return {version:1,create:async()=>{throw new Error("Native sessions are forbidden in production");},
                connect:async()=>{throw new Error("Native sessions are forbidden in production");}};
            }
            if(cap.id!=="workspaces")return api;
            const ws=api as PiWebHostWorkspacesV1;
            return {...ws,async resolve(selection:Parameters<typeof ws.resolve>[0]){
              const result=await ws.resolve(selection);
              if(result.project.id!==selection.projectId||
                result.workspace.id!==selection.workspaceId||
                result.workspace.projectId!==selection.projectId)
                throw new Error("Workspace authority does not match its selected project");
              assertWorkspaceBoundary(policy,result.project.path,result.workspace.path,
                host.dataDirectory,host.packageRoot);
              return result;
            }};
          }) as typeof ctx.capabilities.resolve}:ctx.capabilities;
        await backend.start?.({...ctx,capabilities});
      },
      peer:{...backend.peer,async request(ctx){
        signal.throwIfAborted();
        if(draining)throw new Error("Control plane is stopping");
        const flight=(async()=>{
        if(ctx.operation==="security.capacity"){
          if(!policy)return {status:"not-enforced",reason:"production-profile-required",hardQuotaVerified:false};
          const capacity=inspectStorage(host.dataDirectory,policy.storage);
          return {...capacity,limits:{...capacity.limits}};
        }
        if(ctx.operation==="security.readiness")return {
          mode:policy?"production":"compatibility",
          admissionPolicy:policy?"host-enforced":"not-production",
          controlPlaneOwnership:owner&&!owner.lost.aborted?"locked":"not-enforced",
          workerTools:policy?"sandbox-only-with-fixed-git-broker":"unconfined-compatibility",
          testExecution:policy?"sandbox-only":"operator-configurable",
          universalSafetyGuarantee:false,
          // Evidence statuses distinguish enforced code-level controls from
          // operator/deployment facts. No application result certifies the host.
          checks:[
            {id:"host-policy",status:policy?"pass":"fail",
              evidence:policy?"Host production profile parsed and installed":"Compatibility mode is not production isolation"},
            {id:"state-owner",status:owner&&!owner.lost.aborted?"pass":"not-verified",
              evidence:owner&&!owner.lost.aborted?"Local OS flock descriptor retained by this server":"Exclusive production ownership not established"},
            {id:"worker-isolation-on-deployment-host",status:"not-verified",
              evidence:"GitHub runner isolation is not evidence for the deployed host"},
            {id:"ingress-auth-and-tls",status:"not-verified",
              evidence:"Ingress authentication, TLS and operator authorization need external review"},
            {id:"resource-and-spend-quotas",status:"not-verified",
              evidence:"cgroup, filesystem and provider billing limits need operator evidence"},
            {id:"external-recovery",status:"not-verified",
              evidence:"External Git, provider and hosted-session reconciliation needs an offline drill"},
            {id:"independent-security-review",status:"not-verified",
              evidence:"No independent deployment security attestation is recorded"},
          ],
          notVerified:["deployment authentication/TLS","OS and kernel patch status","cgroup and disk quotas",
            "provider billing ceiling","external-state restore drill","independent security review"],
        };
        if(!request)throw new Error("Control-plane request endpoint unavailable");
        if(policy){
          assertProductionProject(policy,ctx.project.path);
          if(["auto.start","auto.propose","auto.quick.start","auto.worktree.create","auto.recover.unstarted"].includes(ctx.operation))
            assertStorageAdmission(host.dataDirectory,policy.storage);
          if(["agents.create","agents.attach","agents.configure"].includes(ctx.operation))
            throw new Error("Manual native Pi execution is forbidden in production");
          const input=ctx.input;
          if(ctx.operation==="auto.propose"){
            if(!object(input)||input.runtime!==undefined&&input.runtime!=="durable")throw new Error("Production requires Durable planning");
            assertProductionModel(policy,{provider:String(input.provider),model:String(input.model)});
          }
          if(ctx.operation==="auto.configure"){
            if(!object(input)||typeof input.workflowId!=="string")throw new Error("Workflow configuration required");
            const workflow=await request({...ctx,operation:"get",input:input.workflowId});
            assertProductionConfig(policy,parseAutopilotConfig(input.config),object(workflow)?workflow.definition:undefined);
          }
          if(ctx.operation==="auto.start"){
            if(!object(input)||typeof input.workflowId!=="string")throw new Error("Workflow identity required");
            const record=await request({...ctx,operation:"auto.status",input:{workflowId:input.workflowId}});
            const workflow=await request({...ctx,operation:"get",input:input.workflowId});
            assertProductionConfig(policy,object(record)?record.config:undefined,object(workflow)?workflow.definition:undefined);
          }
          if(ctx.operation==="auto.quick.configure"){
            const profile=parseQuickProfile(input);assertProductionConfig(policy,profile.config,{permissions:profile.permissions});
          }
          if(ctx.operation==="auto.quick.start"){
            const status=await request({...ctx,operation:"auto.quick.status",input:null});
            const profile=object(status)?status.profile:undefined;
            assertProductionConfig(policy,object(profile)?profile.config:undefined,{permissions:object(profile)?profile.permissions:undefined});
          }
        }
        return request(ctx);
        })();
        requestsInFlight.add(flight);
        try{return await flight;}finally{requestsInFlight.delete(flight);}
      }},
      dispose,
    };
  }catch(error){
    if(failedActivationCleanup){
      // A failed join must not hand the lock to another control plane.
      try{await failedActivationCleanup();}catch{
        host.logger.error("Activation cleanup failed; ownership retained for safety");
      }
    }else{uninstall();await owner?.release();}
    throw error;
  }
}};
export default plugin;
