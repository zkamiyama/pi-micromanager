/** Linux control-plane ownership. No PID-based stale-lock stealing. */
import {spawn,type ChildProcess} from "node:child_process";
import {constants,openSync,closeSync,lstatSync,realpathSync,mkdirSync,readdirSync,existsSync} from "node:fs";
import {join,resolve} from "node:path";
export function privateStateRoot(path:string):string{
  mkdirSync(path,{recursive:true,mode:0o700});
  const root=realpathSync(path),stat=lstatSync(path);
  if(root!==resolve(path)||!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
    typeof process.getuid==="function"&&stat.uid!==process.getuid())throw new Error("Production state must be a private, owned canonical directory (0700)");
  for(const name of readdirSync(root)){
    if(!/\.sqlite(?:-(?:wal|shm))?$/.test(name))continue;
    const file=lstatSync(join(root,name));
    if(!file.isFile()||file.nlink!==1||(file.mode&0o077)!==0||
      typeof process.getuid==="function"&&file.uid!==process.getuid())throw new Error("Unsafe production SQLite target: "+name);
  }
  if(existsSync(join(root,"RESTORE_REQUIRES_REVIEW")))throw new Error("Restored state is quarantined; reconcile external Git/Run facts before activation");
  return root;
}
export interface StateOwner {readonly root:string;readonly lost:AbortSignal;release():Promise<void>}
export async function acquireStateOwner(path:string):Promise<StateOwner>{
  if(process.platform!=="linux")throw new Error("Production ownership requires Linux flock");
  const root=privateStateRoot(path),lock=join(root,".micromanager-owner.lock");
  const fd=openSync(lock,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{const s=lstatSync(lock);if(!s.isFile()||s.nlink!==1||(s.mode&0o077)!==0)throw new Error("Unsafe owner lock");}
  finally{closeSync(fd);}
  const lost=new AbortController();let releasing=false;
  const child:ChildProcess=spawn("/usr/bin/flock",["--exclusive","--nonblock",lock,
    "/bin/sh","-c","printf 'OWNED\\n'; cat >/dev/null"],{stdio:["pipe","pipe","pipe"],env:{PATH:"/usr/bin:/bin"}});
  let exitResolve:()=>void=()=>{};
  const exited=new Promise<void>(resolve=>{exitResolve=resolve;});
  child.once("close",()=>{exitResolve();if(!releasing)lost.abort(new Error("Control-plane ownership was lost"));});
  try{
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(new Error("Control-plane lock handshake timed out"));},3000);
      let output="";
      const fail=()=>{clearTimeout(timer);reject(new Error("Another control-plane owner is active or locking is unavailable"));};
      child.once("error",fail);child.once("close",fail);
      child.stdout!.on("data",chunk=>{
        output+=String(chunk);if(output.length>64){fail();return;}
        if(output==="OWNED\n"){clearTimeout(timer);child.removeListener("error",fail);child.removeListener("close",fail);resolve();}
      });
      child.stderr!.resume();
    });
  }catch(error){releasing=true;child.stdin?.end();child.kill();await exited;throw error;}
  let releaseFlight:Promise<void>|undefined;
  return {root,lost:lost.signal,release(){
    if(!releaseFlight){releasing=true;child.stdin?.end();releaseFlight=exited;}
    return releaseFlight;
  }};
}
