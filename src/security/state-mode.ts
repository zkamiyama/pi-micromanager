/** A production root cannot silently fall back to compatibility mode. */
import {constants,existsSync,readdirSync,openSync,closeSync,fstatSync,readFileSync,writeFileSync,fsyncSync,lstatSync} from "node:fs";
import {join} from "node:path";
const NAME=".micromanager-production.json";
const CONTENT=JSON.stringify({version:1,mode:"production"})+"\n";
export function assertStateActivation(root:string,production:boolean):void {
  if(existsSync(join(root,"RESTORE_REQUIRES_REVIEW")))
    throw new Error("Restored state is quarantined; offline external-state reconciliation is required");
  const marker=join(root,NAME);
  let stat;try{stat=lstatSync(marker);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0||
    (typeof process.getuid==="function"&&stat.uid!==process.getuid()))
    throw new Error("Invalid production-state marker");
  const fd=openSync(marker,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const actual=fstatSync(fd);
    if(actual.ino!==stat.ino||actual.dev!==stat.dev||actual.size>128||readFileSync(fd,"utf8")!==CONTENT)
      throw new Error("Invalid production-state marker contents");
  }finally{closeSync(fd);}
  if(!production)throw new Error("Production state requires productionSecurity; implicit downgrade is forbidden");
}
/** Called only while holding the exclusive state-owner lock. No downgrade API. */
export function persistProductionMode(root:string):void {
  assertStateActivation(root,true);
  const marker=join(root,NAME);
  let fd:number;
  try{fd=openSync(marker,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
  catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST"){assertStateActivation(root,true);return;}throw error;}
  try{writeFileSync(fd,CONTENT);fsyncSync(fd);}finally{closeSync(fd);}
  const directory=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY);
  try{fsyncSync(directory);}finally{closeSync(directory);}
}

/** An owner-approved YOLO root is created separately from previous strict or
 * native state. No request or Workflow can migrate a strict root into this mode. */
export function assertLocalOwnerState(root:string,local:boolean):void {
  const marker=join(root,".micromanager-local-owner.json");
  const expected=JSON.stringify({version:1,profile:"local-owner"})+"\n";
  if(existsSync(marker)){
    const fd=openSync(marker,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const s=fstatSync(fd);
      if(!s.isFile()||s.nlink!==1||(s.mode&0o077)||s.uid!==process.getuid?.()||s.size>128||readFileSync(fd,"utf8")!==expected)
        throw new Error("Invalid local-owner state marker");
    }finally{closeSync(fd);}
    if(!local)throw new Error("Local-owner state requires its original hardened profile; no implicit migration");
    return;
  }
  if(!local)return;
  if(readdirSync(root).some(n=>n!==".micromanager-owner.lock"))
    throw new Error("Local-owner profile requires a fresh empty state directory; never downgrade existing state");
  const fd=openSync(marker,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,expected);fsyncSync(fd);}finally{closeSync(fd);}
  const directory=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY);
  try{fsyncSync(directory);}finally{closeSync(directory);}
}
