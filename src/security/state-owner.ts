/** Linux state ownership is retained by a descriptor in the daemon itself.
 * The short-lived flock launcher inherits the SAME open file description.
 * Its exit cannot release the lock while the daemon still holds that descriptor.
 * Local filesystem and cooperating, separate-UID isolation remain requirements. */
import {spawn} from "node:child_process";
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,mkdirSync,readdirSync,existsSync} from "node:fs";
import {join,resolve} from "node:path";
export function privateStateRoot(path:string,allowQuarantine=false):string{
  mkdirSync(path,{recursive:true,mode:0o700});
  const root=realpathSync(path),stat=lstatSync(path);
  if(root!==resolve(path)||!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
    typeof process.getuid==="function"&&stat.uid!==process.getuid())
    throw new Error("Production state must be a private, owned canonical directory (0700)");
  for(const name of readdirSync(root)){
    if(!/\.sqlite(?:-(?:wal|shm))?$/.test(name))continue;
    const file=lstatSync(join(root,name));
    if(!file.isFile()||file.nlink!==1||(file.mode&0o077)!==0||
      typeof process.getuid==="function"&&file.uid!==process.getuid())throw new Error("Unsafe production SQLite target: "+name);
  }
  if(!allowQuarantine&&existsSync(join(root,"RESTORE_REQUIRES_REVIEW")))
    throw new Error("Restored state is quarantined; reconcile external Git/Run facts before activation");
  return root;
}
export interface StateOwner {
  readonly root:string;readonly lost:AbortSignal;assertHeld():void;release():Promise<void>;
}
export async function acquireStateOwner(path:string,options:{allowQuarantine?:boolean}={}):Promise<StateOwner>{
  if(process.platform!=="linux")throw new Error("Production ownership requires Linux flock");
  const root=privateStateRoot(path,options.allowQuarantine),lock=join(root,".micromanager-owner.lock");
  const fd=openSync(lock,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  const lost=new AbortController();let released=false;
  const verify=()=>{
    const actual=fstatSync(fd),named=lstatSync(lock);
    if(!actual.isFile()||actual.nlink!==1||(actual.mode&0o077)!==0||
      actual.ino!==named.ino||actual.dev!==named.dev||named.isSymbolicLink()||
      (typeof process.getuid==="function"&&actual.uid!==process.getuid()))
      throw new Error("State ownership inode changed");
  };
  try{
    verify();
    await new Promise<void>((resolve,reject)=>{
      const child=spawn("/usr/bin/flock",["--exclusive","--nonblock","3"],{
        stdio:["ignore","ignore","ignore",fd],env:{PATH:"/usr/bin:/bin"}});
      const timer=setTimeout(()=>{child.kill("SIGKILL");},3000);
      child.once("error",error=>{clearTimeout(timer);reject(error);});
      child.once("close",code=>{clearTimeout(timer);code===0?resolve():
        reject(new Error("Another control-plane owner is active or locking is unavailable"));});
    });
    verify();
  }catch(error){closeSync(fd);throw error;}
  const assertHeld=()=>{
    lost.signal.throwIfAborted();
    try{verify();}catch(error){lost.abort(error);throw error;}
  };
  const check=setInterval(()=>{try{assertHeld();}catch{/* Loss listeners shut down owners. */}},250);
  check.unref();
  return {root,lost:lost.signal,assertHeld,async release(){
    if(released)return;released=true;clearInterval(check);
    // Normal callers first join every worker, then release ownership.
    lost.abort(new Error("Control-plane ownership released"));closeSync(fd);
  }};
}
