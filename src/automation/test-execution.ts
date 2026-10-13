/** Repository tests are untrusted code, not privileged publisher helpers.
 * Linux Bubblewrap uses a fresh filesystem/pid/network namespace and no host
 * credentials/home. trusted-host is an explicit compatibility opt-in, NOT isolation.
 */
import {realpathSync} from "node:fs";
import {isAbsolute,resolve} from "node:path";
import type {AutopilotConfig} from "./ledger.js";
export function testInvocation(test:AutopilotConfig["test"],cwd:string){
  if(!isAbsolute(cwd))throw new Error("Test Workspace must be absolute");
  if(test.execution==="trusted-host")return {file:test.file,args:test.args,cwd};
  if(process.platform!=="linux")
    throw new Error("Sandboxed verification requires Linux Bubblewrap; select a dedicated isolated host or explicitly opt into trusted-host tests");
  return {file:"/usr/bin/bwrap",cwd,args:[
    "--unshare-all","--die-with-parent","--new-session","--cap-drop","ALL",
    "--ro-bind","/usr","/usr","--ro-bind","/bin","/bin",
    "--ro-bind-try","/lib","/lib","--ro-bind-try","/lib64","/lib64",
    "--ro-bind-try","/etc/ld.so.cache","/etc/ld.so.cache",
    "--dir","/runtime","--ro-bind",realpathSync(process.execPath),"/runtime/node",
    "--proc","/proc","--dev","/dev","--tmpfs","/tmp",
    "--bind",resolve(cwd),"/workspace","--chdir","/workspace",
    "--clearenv","--setenv","PATH","/runtime:/usr/bin:/bin",
    "--setenv","HOME","/tmp","--setenv","LANG","C.UTF-8",
    "--",test.file===process.execPath?"/runtime/node":test.file,...test.args,
  ]};
}
