/** A production root cannot silently fall back to compatibility mode. */
import {constants,existsSync,openSync,closeSync,fstatSync,readFileSync,writeFileSync,fsyncSync,lstatSync} from "node:fs";
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
