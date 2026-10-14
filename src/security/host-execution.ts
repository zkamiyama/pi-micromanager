import {gitExecutionEnvironment,assertPassiveRepositoryConfig} from "./git-guard.js";
import {sandboxExec} from "./sandbox.js";
import type {ProductionPolicy} from "./policy.js";
export interface HostRequest {
  file:string;args?:readonly string[];cwd?:string;env?:Readonly<Record<string,string>>;
  unsetEnv?:readonly string[];timeoutMs?:number;signal:AbortSignal;
}
export interface HostResult {exitCode:number|null;signal:string|null;stdout:string;stderr:string;stdoutTruncated:boolean;stderrTruncated:boolean}
/** The final fence must run AFTER any asynchronous security inspection, directly
 * before the underlying host accepts a side effect. It supplements, not replaces,
 * the caller's Workflow/SHA/permission checks. */
export function guardedHostExecution(exec:(request:HostRequest)=>Promise<HostResult>,policy?:ProductionPolicy,
  captureFence?:()=>()=>void){
  return async(request:HostRequest):Promise<HostResult>=>{
    request.signal.throwIfAborted();
    const fence=captureFence?.();
    const admitted=()=>{request.signal.throwIfAborted();fence?.();};
    if(policy&&request.file==="/usr/bin/bwrap"){
      const args=request.args??[],split=args.indexOf("--");
      if(!request.cwd||split<0)throw new Error("Invalid production test invocation");
      admitted();
      const r=await sandboxExec(request.cwd,args.slice(split+1),true,
        {...policy,maxCommandMs:Math.min(policy.maxCommandMs,request.timeoutMs??policy.maxCommandMs)},request.signal);
      return {exitCode:r.exitCode,signal:null,stdout:r.stdout,stderr:r.stderr,stdoutTruncated:false,stderrTruncated:false};
    }
    if(request.file==="git"||request.file==="/usr/bin/git"){
      const guard=gitExecutionEnvironment({...process.env,...request.env});
      const env:Record<string,string>={...request.env,...guard.env,...(policy?{
        GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_SYSTEM:"/dev/null",GIT_CONFIG_GLOBAL:"/dev/null",
      }: {})};
      const unsetEnv=[...new Set([...(request.unsetEnv??[]),...guard.unsetEnv,
        ...(policy?["GIT_SSH","GIT_SSH_COMMAND","GIT_ASKPASS","SSH_ASKPASS","GIT_EXEC_PATH"]:[])])]
        .filter(k=>!Object.hasOwn(env,k));
      const r={...request,env,unsetEnv,...(policy?{file:"/usr/bin/git"}:{})};
      if(policy){
        const args=request.args??[];
        if(args[0]!=="-C"||!args[1])throw new Error("Production Git requires an exact Workspace");
        const cwd=args[1];
        const check=await exec({...r,args:["-C",cwd,"config","--local","--no-includes","--name-only","--list"]});
        admitted();
        if(check.exitCode!==0||check.signal||check.stdoutTruncated||check.stderrTruncated)
          throw new Error("Cannot prove passive repository Git configuration");
        assertPassiveRepositoryConfig(check.stdout);
        if(args.includes("push")||args.includes("ls-remote")){
          const destination=args.find(x=>x.startsWith("https://github.com/"));
          if(!destination)throw new Error("Production Git publication requires explicit canonical HTTPS destination");
          const repo=destination.slice("https://github.com/".length).replace(/\.git$/,"").toLowerCase();
          if(!policy.publication.some(p=>p.repository===repo))throw new Error("Git destination outside production allowlist");
          r.env={...env,GIT_CONFIG_COUNT:String(Number(env.GIT_CONFIG_COUNT)+1),
            ["GIT_CONFIG_KEY_"+env.GIT_CONFIG_COUNT]:"credential.helper",
            ["GIT_CONFIG_VALUE_"+env.GIT_CONFIG_COUNT]:"!/usr/bin/gh auth git-credential"};
        }
      }
      admitted();return exec(r);
    }
    if(policy&&request.file==="gh"){
      const args=request.args??[];
      const repoIndex=args.findIndex(a=>a==="--repo"||a==="-R");
      const api=args[0]==="api"?args.find(a=>a.startsWith("repos/")):undefined;
      const repo=(api?api.split("/").slice(1,3).join("/"):repoIndex>=0?args[repoIndex+1]:undefined)?.toLowerCase();
      if(!repo||!policy.publication.some(p=>p.repository===repo))throw new Error("GitHub command outside production repository allowlist");
      admitted();return exec({...request,file:"/usr/bin/gh"});
    }
    if(policy)throw new Error("Unconfined process execution is forbidden by the production profile");
    admitted();return exec(request);
  };
}
