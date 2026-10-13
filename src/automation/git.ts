/** Host-mediated argv-only Git gateway. Never invoke a shell or inherit Git routing overrides. */
import {resolve} from "node:path";
import type {ServerPluginActivationContext} from "@jmfederico/pi-web/server-plugin-api";

const GIT_ENV_KEYS=[
  "GIT_ALTERNATE_OBJECT_DIRECTORIES","GIT_COMMON_DIR","GIT_DIR",
  "GIT_INDEX_FILE","GIT_OBJECT_DIRECTORY","GIT_PREFIX",
  "GIT_QUARANTINE_PATH","GIT_WORK_TREE",
];
export interface GitOutput {
  exitCode:number|null; signal:string|null; stdout:string;stderr:string;
  stdoutTruncated:boolean;stderrTruncated:boolean;
}
export type GitHost=Pick<ServerPluginActivationContext,"execFile"|"lifetimeSignal">;
export async function git(host:GitHost,root:string,args:readonly string[],
  timeoutMs=10000):Promise<GitOutput>{
  host.lifetimeSignal.throwIfAborted();
  if(!root||args.length<1||args.some(a=>typeof a!=="string"||a.includes("\0")))
    throw new Error("Invalid Git argv");
  const response=await host.execFile({
    file:"git",args:["-C",root,...args],timeoutMs,unsetEnv:GIT_ENV_KEYS,
    signal:host.lifetimeSignal,
  });
  if(response.stdoutTruncated||response.stderrTruncated||response.signal)
    throw new Error("Git command truncated/interrupted: "+args[0]);
  return response;
}
export async function gitValue(host:GitHost,root:string,args:readonly string[]):Promise<string>{
  const result=await git(host,root,args);
  if(result.exitCode!==0)
    throw new Error("Git "+args[0]+" failed: "+result.stderr.slice(-350));
  return result.stdout.trim();
}
export function gitSha(value:string):boolean{return /^[a-f0-9]{40,64}$/.test(value);}
export async function inspectedGitRoot(host:GitHost,path:string):Promise<string>{
  const found=await gitValue(host,path,["rev-parse","--show-toplevel"]);
  if(resolve(found)!==resolve(path))
    throw new Error("Resolved Git root does not match the selected workspace");
  return found;
}
export async function gitHead(host:GitHost,root:string):Promise<string>{
  const result=await gitValue(host,root,["rev-parse","HEAD"]);
  if(!gitSha(result))throw new Error("Invalid Git HEAD");
  return result;
}
export async function requireCleanGit(host:GitHost,path:string):Promise<string>{
  await inspectedGitRoot(host,path);
  const [head,status]=await Promise.all([
    gitHead(host,path),gitValue(host,path,["status","--porcelain","--untracked-files=all","--ignore-submodules=none"]),
  ]);
  if(status!=="")throw new Error("Git workspace has uncommitted/untracked files");
  const index=await gitValue(host,path,["ls-files","-v","-z"]);
  if(index.split("\0").some(entry=>entry&&(/^[a-z]/.test(entry)||entry[0]==="S")))
    throw new Error("Git index contains assume-unchanged or skip-worktree flags; restore explicit tracking before verification");
  const disk=await git(host,path,["diff-files","--quiet","--ignore-submodules=none"]);
  if(disk.exitCode!==0)throw new Error("Tracked Git bytes changed during snapshot verification");
  if(await gitHead(host,path)!==head)throw new Error("Git HEAD moved during snapshot verification");
  return head;
}
export async function requireAncestor(host:GitHost,root:string,
  sourceSha:string,targetSha:string):Promise<void>{
  if(!gitSha(sourceSha)||!gitSha(targetSha))throw new Error("Invalid ancestor Git SHA");
  const result=await git(host,root,["merge-base","--is-ancestor",sourceSha,targetSha]);
  if(result.exitCode!==0)
    throw new Error("Git target does not contain QC-passed source commit "+sourceSha.slice(0,12));
}
