/** Offline plugin-state snapshots. Hold the daemon's ownership lock across all
 * databases; use SQLite backup for committed WAL data. Never copy hosted native
 * sessions, worktrees or provider state and claim they form a machine backup. */
import {DatabaseSync,backup} from "node:sqlite";
import {createHash} from "node:crypto";
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,writeSync,
  mkdirSync,realpathSync,readdirSync,readFileSync,writeFileSync,fsyncSync,chmodSync,existsSync} from "node:fs";
import {join,dirname,resolve,isAbsolute} from "node:path";
import {acquireStateOwner,privateStateRoot} from "./state-owner.js";
import {isWithin} from "./policy.js";
const MAX_FILES=10000,MAX_BYTES=16*1024*1024*1024,MAX_MANIFEST=8*1024*1024;
const OMIT=new Set([".micromanager-owner.lock","RESTORE_REQUIRES_REVIEW"]);
interface Entry {path:string;kind:"sqlite"|"file";size:number;sha256:string}
export interface StateManifest {
  version:1;sourceRoot:string;createdAt:string;reason:string;files:Entry[];
  external:{managedWorktrees:string;requirements:string[];inventory:Record<string,unknown[]>};
}
function text(value:string):void {
  if(typeof value!=="string"||!value.trim()||value.length>1000||value.includes("\0"))
    throw new Error("A bounded offline operation reason is required");
}
function safePath(path:unknown):path is string {
  return typeof path==="string"&&path.length>0&&path.length<1024&&
    /^[a-zA-Z0-9._/-]+$/.test(path)&&!isAbsolute(path)&&
    path.split("/").every(p=>p!==""&&p!=="."&&p!=="..")&&
    !OMIT.has(path)&&path!=="managed-worktrees"&&!path.startsWith("managed-worktrees/");
}
function directory(path:string):string {
  const root=realpathSync(path);
  if(root!==resolve(path)||!lstatSync(path).isDirectory())throw new Error("Expected canonical directory");
  return root;
}
function newDestination(path:string,source:string):string {
  if(!isAbsolute(path)||resolve(path)!==path)throw new Error("Destination must be an absolute canonical path");
  directory(dirname(path));
  if(isWithin(source,path)||isWithin(path,source))throw new Error("Source and destination may not overlap");
  // mkdir without recursive is an atomic refusal of every existing destination.
  mkdirSync(path,{mode:0o700});return path;
}
function regular(path:string):ReturnType<typeof fstatSync> {
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_BYTES)
    throw new Error("Refusing symlink, hardlink, special or oversized snapshot file");
  return stat;
}
function flush(path:string,dir=false):void {
  const fd=openSync(path,constants.O_RDONLY|(dir?constants.O_DIRECTORY:0)|constants.O_NOFOLLOW);
  try{fsyncSync(fd);}finally{closeSync(fd);}
}
function transfer(source:string,target?:string):{size:number;sha256:string} {
  const stat=regular(source),input=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW);
  let output:number|undefined;
  try{
    const current=fstatSync(input);
    if(current.ino!==stat.ino||current.dev!==stat.dev||current.nlink!==1)throw new Error("Snapshot source moved");
    if(target){mkdirSync(dirname(target),{recursive:true,mode:0o700});output=openSync(target,
      constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
    const digest=createHash("sha256"),buffer=Buffer.allocUnsafe(512*1024);let size=0,n:number;
    while((n=readSync(input,buffer,0,buffer.length,null))!==0){
      size+=n;if(size>MAX_BYTES||size>stat.size)throw new Error("Snapshot source grew or exceeds quota");
      digest.update(buffer.subarray(0,n));
      if(output!==undefined){let written=0;while(written<n)written+=writeSync(output,buffer,written,n-written);}
    }
    const after=fstatSync(input);
    if(size!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)
      throw new Error("Snapshot source changed while copying");
    if(output!==undefined)fsyncSync(output);
    return {size,sha256:digest.digest("hex")};
  }finally{closeSync(input);if(output!==undefined)closeSync(output);}
}
function scan(root:string,sourceMode:boolean):string[] {
  const files:string[]=[],pending=[""];let inspected=0;
  while(pending.length){
    const prefix=pending.pop()!;
    for(const name of readdirSync(join(root,prefix)).sort()){
      if(++inspected>MAX_FILES*3)throw new Error("Snapshot directory quota exceeded");
      const rel=prefix?prefix+"/"+name:name,path=join(root,rel),s=lstatSync(path);
      if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw new Error("Snapshot contains a symlink or special file");
      if(sourceMode&&!prefix&&OMIT.has(name))continue;
      if(sourceMode&&!prefix&&name==="managed-worktrees"){
        if(!s.isDirectory())throw new Error("Managed Worktree root is not a directory");continue;
      }
      if(!safePath(rel))throw new Error("Unsafe snapshot relative path: "+rel);
      if(s.isDirectory()){pending.push(rel);continue;}
      regular(path);
      if(sourceMode&&/\.sqlite-(wal|shm)$/.test(name)){
        if(!existsSync(path.replace(/-(wal|shm)$/, "")))throw new Error("Orphan SQLite sidecar");continue;
      }
      files.push(rel);if(files.length>MAX_FILES)throw new Error("Snapshot file quota exceeded");
    }
  }
  return files.sort();
}
function checkDatabase(path:string):void {
  const db=new DatabaseSync(path,{readOnly:true,allowExtension:false});
  try{db.exec("PRAGMA trusted_schema=OFF");const rows=db.prepare("PRAGMA quick_check(1)").all();
    if(rows.length!==1||Object.values(rows[0]!)[0]!=="ok")throw new Error("SQLite integrity check failed");
  }finally{db.close();}
}
function inventory(root:string):Record<string,unknown[]> {
  const output:Record<string,unknown[]>={};
  const queries=[
    ["agents.sqlite","execution_runs","project_id,workspace_id,workflow_id,run_id,session_id,phase"],
    ["worktree-provisions.sqlite","worktree_plans","workflow_id,task_id,repo_root,path,branch,base_sha,stage"],
    ["publication.sqlite","publication_operations","workflow_id,task_id,action,sha,branch,destination,state,result"],
  ] as const;
  for(const [file,table,fields] of queries){
    const path=join(root,file);if(!existsSync(path))continue;
    const db=new DatabaseSync(path,{readOnly:true,allowExtension:false});
    try{db.exec("PRAGMA trusted_schema=OFF");
      if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))continue;
      const rows=db.prepare(`SELECT ${fields} FROM ${table} LIMIT ${MAX_FILES+1}`).all();
      if(rows.length>MAX_FILES)throw new Error("External dependency inventory exceeds quota");
      output[table]=rows;
    }finally{db.close();}
  }
  return output;
}
export async function snapshotState(source:string,destination:string,reason:string):Promise<{root:string;digest:string;manifest:StateManifest}> {
  text(reason);const root=privateStateRoot(directory(source),true),owner=await acquireStateOwner(root,{allowQuarantine:true});
  try{
    const files=scan(root,true),target=newDestination(destination,root),payload=join(target,"payload");
    mkdirSync(payload,{mode:0o700});
    const before=files.map(p=>{const s=lstatSync(join(root,p));return [p,s.ino,s.dev,s.size,s.mtimeMs];});
    const entries:Entry[]=[];let total=0;const deadline=Date.now()+120000;
    for(const path of files){
      owner.assertHeld();if(Date.now()>deadline)throw new Error("Offline snapshot time budget exhausted");
      const from=join(root,path),to=join(payload,path);
      let proof:{size:number;sha256:string};
      if(path.endsWith(".sqlite")){
        checkDatabase(from);mkdirSync(dirname(to),{recursive:true,mode:0o700});
        const db=new DatabaseSync(from,{readOnly:true,allowExtension:false});
        try{db.exec("PRAGMA trusted_schema=OFF");await backup(db,to,{progress:()=>{
          owner.assertHeld();if(Date.now()>deadline)throw new Error("Offline snapshot time budget exhausted");
        }});}finally{db.close();}
        chmodSync(to,0o600);
        const copy=new DatabaseSync(to,{allowExtension:false});
        try{copy.exec("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE");}finally{copy.close();}
        checkDatabase(to);flush(to);proof=transfer(to);
      }else proof=transfer(from,to);
      total+=proof.size;if(total>MAX_BYTES)throw new Error("Snapshot total byte quota exceeded");
      entries.push({path,kind:path.endsWith(".sqlite")?"sqlite":"file",...proof});
    }
    owner.assertHeld();
    const after=scan(root,true).map(p=>{const s=lstatSync(join(root,p));return [p,s.ino,s.dev,s.size,s.mtimeMs];});
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error("State changed despite exclusive offline ownership");
    const manifest:StateManifest={version:1,sourceRoot:root,createdAt:new Date().toISOString(),reason,files:entries,
      external:{managedWorktrees:join(root,"managed-worktrees"),requirements:[
        "Restore/reconcile linked Git repositories and Worktrees separately",
        "Reconcile exact GitHub PR/branch state and ambiguous publication receipts",
        "Reconcile provider submissions and PI WEB-native session storage separately",
        "Restore no credentials from this archive; reauthorize the host deployment explicitly",
      ],inventory:inventory(payload)}};
    const raw=JSON.stringify(manifest,null,2)+"\n";
    if(Buffer.byteLength(raw)>MAX_MANIFEST)throw new Error("Snapshot manifest quota exceeded");
    owner.assertHeld();writeFileSync(join(target,"MANIFEST.json"),raw,{flag:"wx",mode:0o600});
    flush(join(target,"MANIFEST.json"));
    const directories=new Set<string>([payload]);
    for(const entry of entries){let path=dirname(join(payload,entry.path));
      while(isWithin(payload,path)){directories.add(path);if(path===payload)break;path=dirname(path);}}
    for(const path of [...directories].sort((a,b)=>b.length-a.length))flush(path,true);
    flush(target,true);flush(dirname(target),true);
    return {root:target,digest:createHash("sha256").update(raw).digest("hex"),manifest};
  }finally{await owner.release();}
}

/** Read-only verification. The caller supplies the manifest digest from the
 * trusted snapshot receipt, not a digest recomputed from an untrusted archive. */
export function verifySnapshot(source:string,expectedDigest:string):StateManifest {
  const root=directory(source),manifestPath=join(root,"MANIFEST.json");
  if(!/^[a-f0-9]{64}$/.test(expectedDigest))throw new Error("Expected trusted manifest SHA-256 is required");
  const stat=regular(manifestPath);if(stat.size>MAX_MANIFEST)throw new Error("Oversized snapshot manifest");
  const fd=openSync(manifestPath,constants.O_RDONLY|constants.O_NOFOLLOW);
  let raw:Buffer;try{raw=readFileSync(fd);}finally{closeSync(fd);}
  if(createHash("sha256").update(raw).digest("hex")!==expectedDigest)
    throw new Error("Snapshot manifest digest mismatch");
  const parsed:unknown=JSON.parse(raw.toString("utf8"));
  const isRecord=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);
  if(!isRecord(parsed)||parsed.version!==1||typeof parsed.sourceRoot!=="string"||
    !isAbsolute(parsed.sourceRoot)||!Array.isArray(parsed.files)||parsed.files.length>MAX_FILES||
    !isRecord(parsed.external)||!Array.isArray(parsed.external.requirements))
    throw new Error("Unsupported or malformed snapshot manifest");
  const names=new Set<string>();let total=0;
  const payload=directory(join(root,"payload"));
  for(const entry of parsed.files){
    if(!isRecord(entry)||!safePath(entry.path)||names.has(entry.path)||
      (entry.kind!=="sqlite"&&entry.kind!=="file")||
      (entry.kind==="sqlite")!==entry.path.endsWith(".sqlite")||
      typeof entry.size!=="number"||!Number.isSafeInteger(entry.size)||entry.size<0||
      typeof entry.sha256!=="string"||!/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error("Invalid or duplicate snapshot file entry");
    names.add(entry.path);total+=entry.size;if(total>MAX_BYTES)throw new Error("Snapshot byte quota exceeded");
  }
  // Reject aliasing parents and unmanifested files before opening payload paths.
  const actual=scan(payload,false);
  if(JSON.stringify(actual)!==JSON.stringify([...names].sort()))throw new Error("Snapshot inventory mismatch");
  for(const item of parsed.files as Entry[]){
    const path=join(payload,item.path),proof=transfer(path);
    if(proof.size!==item.size||proof.sha256!==item.sha256)throw new Error("Snapshot file digest mismatch: "+item.path);
    if(item.kind==="sqlite")checkDatabase(path);
  }
  return parsed as unknown as StateManifest;
}
