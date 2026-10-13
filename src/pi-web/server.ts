/** Security entrypoint around the existing public PI WEB control plane. */
import base from "./control-plane.js";
import {chmodSync,readdirSync,lstatSync,realpathSync} from "node:fs";
import {join} from "node:path";
import type {PiWebServerPlugin,PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";
import {parseProductionPolicy,installProductionPolicy,assertProductionProject,
  assertProductionConfig,assertProductionModel,isWithin} from "../security/policy.js";
import {acquireStateOwner} from "../security/state-owner.js";
import {guardedHostExecution} from "../security/host-execution.js";
import {parseAutopilotConfig,AutopilotLedger} from "../automation/ledger.js";
import {QuickLaunchLedger,parseQuickProfile} from "../automation/quick-launch.js";
import {WorkflowStore} from "../core/store.js";
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const plugin:PiWebServerPlugin={...base,async activate(host){
  const policy=parseProductionPolicy(host.settings.productionSecurity);
  const owner=policy?await acquireStateOwner(host.dataDirectory):undefined;
  let uninstall:()=>void=()=>{};
  const signal=owner?AbortSignal.any([host.lifetimeSignal,owner.lost]):host.lifetimeSignal;
  let failedActivationCleanup:(()=>Promise<void>)|undefined;
  try{
    if(policy)uninstall=installProductionPolicy(host.dataDirectory,policy);
    const backend=await base.activate({...host,lifetimeSignal:signal,
      execFile:guardedHostExecution(host.execFile,policy)});
    let disposal:Promise<void>|undefined;
    const dispose=(disposeSignal:AbortSignal):Promise<void>=>{
      if(!disposal)disposal=(async()=>{
        try{await backend.dispose?.(disposeSignal);}finally{uninstall();await owner?.release();}
      })();
      return disposal;
    };
    failedActivationCleanup=()=>dispose(new AbortController().signal);
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
              assertProductionProject(policy,result.project.path);
              const canonical=realpathSync(result.workspace.path);
              if(!policy.projectRoots.some(root=>isWithin(root,canonical))&&
                !isWithin(join(realpathSync(host.dataDirectory),"managed-worktrees"),canonical))
                throw new Error("Workspace is outside host production project/managed roots");
              if(isWithin(host.dataDirectory,result.workspace.path)&&
                !isWithin(join(host.dataDirectory,"managed-worktrees"),result.workspace.path))
                throw new Error("Control-plane state cannot be an agent Workspace");
              return result;
            }};
          }) as typeof ctx.capabilities.resolve}:ctx.capabilities;
        await backend.start?.({...ctx,capabilities});
      },
      peer:{...backend.peer,async request(ctx){
        signal.throwIfAborted();
        if(ctx.operation==="security.readiness")return {
          mode:policy?"production":"compatibility",
          admissionPolicy:policy?"host-enforced":"not-production",
          controlPlaneOwnership:owner&&!owner.lost.aborted?"locked":"not-enforced",
          workerTools:policy?"sandbox-only-with-fixed-git-broker":"unconfined-compatibility",
          testExecution:policy?"sandbox-only":"operator-configurable",
          universalSafetyGuarantee:false,
          notVerified:["deployment authentication/TLS","OS and kernel patch status","cgroup and disk quotas",
            "provider billing ceiling","external-state restore drill","independent security review"],
        };
        if(!request)throw new Error("Control-plane request endpoint unavailable");
        if(policy){
          assertProductionProject(policy,ctx.project.path);
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
      }},
      dispose,
    };
  }catch(error){
    try{await failedActivationCleanup?.();}finally{uninstall();await owner?.release();}
    throw error;
  }
}};
export default plugin;
