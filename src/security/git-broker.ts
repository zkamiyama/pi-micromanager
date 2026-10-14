/** Fixed local Git operations only. Agent shell never mounts shared Git metadata. */
import {lstatSync} from "node:fs";
import {join} from "node:path";
import {gitExecutionEnvironment,assertPassiveRepositoryConfig} from "./git-guard.js";
import {boundedProcess,inspectSandboxWorkspace,type SandboxLimits} from "./sandbox.js";
export async function localGit(root:string,args:readonly string[],signal?:AbortSignal){
  const {env}=gitExecutionEnvironment({});
  return boundedProcess("/usr/bin/git",["-C",root,...args],{cwd:root,timeoutMs:60_000,
    env:{PATH:"/usr/bin:/bin",HOME:"/nonexistent",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",
      GIT_CONFIG_SYSTEM:"/dev/null",...env},...(signal?{signal}:{})});
}
export async function assertBrokerCheckout(root:string,limits:SandboxLimits,signal?:AbortSignal):Promise<void>{
  inspectSandboxWorkspace(root,limits.maxWorkspaceBytes);
  if(!lstatSync(join(root,".git")).isFile())throw new Error("Git broker requires a linked, non-main Worktree");
  const names=await localGit(root,["config","--local","--no-includes","--name-only","--list"],signal);
  if(names.exitCode!==0||names.truncated)throw new Error("Cannot verify local Git configuration");
  assertPassiveRepositoryConfig(names.stdout);
  const branch=await localGit(root,["symbolic-ref","--quiet","--short","HEAD"],signal);
  if(branch.exitCode!==0||/^(?:main|master|trunk|production|prod|release)$/i.test(branch.stdout.trim()))
    throw new Error("Protected or detached checkout is not a coding Worktree");
}
export async function brokerGit(root:string,action:"status"|"diff"|"commit"|"merge",
  value:string|undefined,allowedMergeShas:readonly string[],limits:SandboxLimits,signal?:AbortSignal){
  await assertBrokerCheckout(root,limits,signal);
  if(action==="status")return localGit(root,["status","--porcelain","--untracked-files=all","--ignore-submodules=none"],signal);
  if(action==="diff")return localGit(root,["diff","--no-ext-diff","--no-textconv","HEAD","--"],signal);
  if(action==="merge"){
    if(!value||!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)||!allowedMergeShas.includes(value))
      throw new Error("Merge requires an exact host-frozen source QC SHA");
    return localGit(root,["merge","--no-edit","--no-gpg-sign",value],signal);
  }
  if(!value||!value.trim()||value.length>300||value.includes("\0"))throw new Error("Bounded commit message required");
  const added=await localGit(root,["add","--all","--","."],signal);
  if(added.exitCode!==0||added.truncated)throw new Error("Git staging was not confirmed");
  return localGit(root,["-c","user.name=Micromanager worker","-c","user.email=micromanager@localhost",
    "commit","--no-gpg-sign","-m",value,"--"],signal);
}
