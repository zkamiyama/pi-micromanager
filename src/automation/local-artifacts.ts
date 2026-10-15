/** Local, bounded derivative artifacts. Never the authoritative Run/permission DB.
 * A lost unlink receipt remains uncertain; absence is not our completion proof. */
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,writeFileSync,
  mkdirSync,realpathSync,fsyncSync,unlinkSync,existsSync,chmodSync} from "node:fs";
import {join,resolve} from "node:path";
import {zstdCompressSync,zstdDecompressSync,constants as zconst} from "node:zlib";
import {localImageMime,LOCAL_IMAGE_MAX_BYTES} from "./local-image.js";
export {localImageMime} from "./local-image.js";
import {automationScope} from "./ledger.js";

export type ArtifactKind="run-log"|"image";
export interface LocalArtifact {
  id:string;workflowId:string;runId:string;kind:ArtifactKind;sourceSha:string;
  mime:string;provenance:"public-run-projection"|"operator-upload";
  label:string;bytes:number;storedBytes:number;sha256:string;createdAt:number;
  pinned:boolean;state:"writing"|"ready"|"retiring"|"removed"|"uncertain";
}
interface Row extends Omit<LocalArtifact,"pinned"> {scope:string;requestHash:string;storedHash:string;pinned:number}
export interface ArtifactPolicy {maxBytes:number;maxAgeDays:number}
export interface ArtifactInput {key:string;workflowId:string;runId:string;kind:ArtifactKind;sourceSha:string;mime:string;label:string}
interface Options {
  directory:string;policy:ArtifactPolicy;signal:AbortSignal;
  /** Includes all unsealed/uncertain Runs, enabled work and unresolved external effects. */
  protected(p:string,o:string,workflowId:string):boolean;
}
const MAX_RAW=LOCAL_IMAGE_MAX_BYTES,MAX_LOG=128*1024,MAX_ROWS=25000;
const hash=(data:string|Buffer)=>createHash("sha256").update(data).digest("hex");
const text=(s:unknown,max:number):s is string=>typeof s==="string"&&s.length>0&&s.length<=max&&!s.includes("\0");
function syncDirectory(dir:string):void{const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function privateDirectory(dir:string):void{
  mkdirSync(dir,{recursive:true,mode:0o700});const s=lstatSync(dir);
  if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(dir)!==resolve(dir)||(s.mode&0o077)||s.uid!==process.getuid?.())
    throw new Error("Local artifact directory must be private, owned and canonical");
}
export class LocalArtifacts {
  private readonly db:DatabaseSync;private readonly objects:string;
  constructor(private readonly opt:Options){
    if(!Number.isSafeInteger(opt.policy.maxBytes)||opt.policy.maxBytes<1024||opt.policy.maxBytes>8*1024**3||
      !Number.isSafeInteger(opt.policy.maxAgeDays)||opt.policy.maxAgeDays<1||opt.policy.maxAgeDays>365)
      throw new Error("Invalid local artifact quota");
    privateDirectory(opt.directory);this.objects=join(opt.directory,"objects");privateDirectory(this.objects);
    const dbPath=join(opt.directory,"index.sqlite");
    if(existsSync(dbPath)){const s=lstatSync(dbPath);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid?.())throw new Error("Unsafe artifact database");}
    this.db=new DatabaseSync(dbPath);chmodSync(dbPath,0o600);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflowId TEXT NOT NULL,runId TEXT NOT NULL,
        kind TEXT NOT NULL,sourceSha TEXT NOT NULL,mime TEXT NOT NULL,provenance TEXT NOT NULL,label TEXT NOT NULL,
        bytes INTEGER NOT NULL,storedBytes INTEGER NOT NULL,sha256 TEXT NOT NULL,storedHash TEXT NOT NULL,
        requestHash TEXT NOT NULL,createdAt INTEGER NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS artifacts_scope ON artifacts(scope,workflowId,createdAt);`);
  }
  close():void{this.db.close();}
  private path(id:string):string{if(!/^[a-f0-9]{64}$/.test(id))throw new Error("Invalid artifact identity");return join(this.objects,id+".blob");}
  private row(p:string,o:string,id:string):Row{
    const row=this.db.prepare("SELECT * FROM artifacts WHERE id=? AND scope=?").get(id,automationScope(p,o)) as unknown as Row|undefined;
    if(!row)throw new Error("Artifact is not in the selected scope");return row;
  }
  private view(r:Row):LocalArtifact{
    const {scope:_,requestHash:__,storedHash:___,...v}=r;return {...v,pinned:r.pinned===1};
  }
  list(p:string,o:string,workflowId:string):LocalArtifact[]{
    return (this.db.prepare("SELECT * FROM artifacts WHERE scope=? AND workflowId=? ORDER BY createdAt DESC LIMIT 100")
      .all(automationScope(p,o),workflowId) as unknown as Row[]).map(r=>this.view(r));
  }
  /** Exact identity lookup, independent of display pagination. */
  find(p:string,o:string,workflowId:string,key:string):LocalArtifact|undefined{
    const scope=automationScope(p,o),id=hash(JSON.stringify([scope,workflowId,key]));
    const row=this.db.prepare("SELECT * FROM artifacts WHERE id=? AND scope=? AND workflowId=?")
      .get(id,scope,workflowId) as unknown as Row|undefined;
    return row?this.view(row):undefined;
  }
  hasPins(p:string,o:string,w:string):boolean{
    return Boolean(this.db.prepare("SELECT 1 FROM artifacts WHERE scope=? AND workflowId=? AND pinned=1 AND state!='removed' LIMIT 1")
      .get(automationScope(p,o),w));
  }
  usage():{storedBytes:number;maxBytes:number;maxAgeDays:number;unresolved:number}{
    const r=this.db.prepare("SELECT coalesce(sum(storedBytes),0) AS bytes,sum(CASE WHEN state IN ('writing','retiring','uncertain') THEN 1 ELSE 0 END) AS unresolved FROM artifacts WHERE state!='removed'").get() as {bytes:number;unresolved:number};
    return {storedBytes:r.bytes,maxBytes:this.opt.policy.maxBytes,maxAgeDays:this.opt.policy.maxAgeDays,unresolved:r.unresolved??0};
  }
  private stored(r:Row):Buffer{
    if(!Number.isSafeInteger(r.storedBytes)||r.storedBytes<1||r.storedBytes>MAX_RAW+65536)throw new Error("Invalid stored artifact bound");
    const fd=openSync(this.path(r.id),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o077)||info.size!==r.storedBytes)
        throw new Error("Artifact ownership or size changed");
      const buf=Buffer.alloc(r.storedBytes+1);let n=0;
      while(n<buf.length){const got=readSync(fd,buf,n,buf.length-n,n);if(!got)break;n+=got;}
      if(n!==r.storedBytes||fstatSync(fd).size!==r.storedBytes||hash(buf.subarray(0,n))!==r.storedHash)
        throw new Error("Artifact bytes changed");
      return buf.subarray(0,n);
    }finally{closeSync(fd);}
  }
  read(p:string,o:string,id:string):{artifact:LocalArtifact;text?:string;dataUrl?:string}{
    const r=this.row(p,o,id);if(r.state!=="ready")throw new Error("Artifact unavailable or awaiting reconciliation");
    const packed=this.stored(r);let bytes:Buffer;
    try{bytes=r.kind==="run-log"?zstdDecompressSync(packed,{maxOutputLength:MAX_LOG,params:{[zconst.ZSTD_d_windowLogMax]:17}}):packed;}
    catch{throw new Error("Compressed archive is invalid or exceeds its decoding resource limit");}
    if(bytes.length!==r.bytes||hash(bytes)!==r.sha256)throw new Error("Artifact decompressed content changed");
    if(r.kind==="image"&&localImageMime(bytes)!==r.mime)throw new Error("Artifact image type changed");
    return {artifact:this.view(r),...(r.kind==="run-log"?{text:bytes.toString("utf8")}:{dataUrl:"data:"+r.mime+";base64,"+bytes.toString("base64")})};
  }
  pin(p:string,o:string,id:string,pinned:boolean):LocalArtifact{
    this.opt.signal.throwIfAborted();if(typeof pinned!=="boolean")throw new Error("Explicit pin boolean required");
    const r=this.row(p,o,id);if(r.state!=="ready")throw new Error("Only complete artifacts can be pinned");
    this.db.prepare("UPDATE artifacts SET pinned=? WHERE id=? AND state='ready'").run(pinned?1:0,id);return this.view(this.row(p,o,id));
  }
  private eligible(p:string,o:string,r:Row):boolean{
    return r.scope===automationScope(p,o)&&r.state==="ready"&&r.pinned===0&&!this.opt.protected(p,o,r.workflowId);
  }
  preview(p:string,o:string,needed=0,now=Date.now()):{ids:string[];bytes:number;protectedCount:number}{
    if(!Number.isSafeInteger(needed)||needed<0||needed>MAX_RAW+65536)throw new Error("Invalid reclamation bound");
    const rows=this.db.prepare("SELECT * FROM artifacts WHERE scope=? AND state='ready' ORDER BY createdAt,id LIMIT 1000")
      .all(automationScope(p,o)) as unknown as Row[];
    let remaining=this.usage().storedBytes+needed,bytes=0,protectedCount=0;const ids:string[]=[];
    for(const r of rows){
      if(!this.eligible(p,o,r)){protectedCount++;continue;}
      if(r.createdAt>now-this.opt.policy.maxAgeDays*86400000&&remaining<=this.opt.policy.maxBytes)continue;
      ids.push(r.id);bytes+=r.storedBytes;remaining-=r.storedBytes;
    }
    return {ids,bytes,protectedCount};
  }
  collect(p:string,o:string,needed=0,now=Date.now()):{removed:number;bytes:number}{
    const preview=this.preview(p,o,needed,now);let removed=0,bytes=0;
    for(const id of preview.ids){
      this.opt.signal.throwIfAborted();const r=this.row(p,o,id);if(!this.eligible(p,o,r))throw new Error("Artifact became pinned or active");
      this.stored(r); // A type/size/hash change refuses deletion, never follows aliases.
      this.opt.signal.throwIfAborted();
      if(this.db.prepare("UPDATE artifacts SET state='retiring' WHERE id=? AND state='ready' AND pinned=0").run(id).changes!==1)
        throw new Error("Artifact retirement is already reserved");
      try{unlinkSync(this.path(id));syncDirectory(this.objects);}
      catch{this.db.prepare("UPDATE artifacts SET state='uncertain' WHERE id=?").run(id);throw new Error("Artifact removal unconfirmed; no replay");}
      this.db.prepare("UPDATE artifacts SET state='removed' WHERE id=? AND state='retiring'").run(id);
      removed++;bytes+=r.storedBytes;
    }
    return {removed,bytes};
  }
  put(p:string,o:string,input:ArtifactInput,raw:Buffer):LocalArtifact{
    this.opt.signal.throwIfAborted();
    for(const [v,n] of [[input.key,160],[input.workflowId,64],[input.runId,128],[input.label,180]] as const)
      if(!text(v,n))throw new Error("Invalid bounded artifact metadata");
    if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.sourceSha)||!["run-log","image"].includes(input.kind)||raw.length<1||raw.length>(input.kind==="run-log"?MAX_LOG:MAX_RAW))
      throw new Error("Invalid artifact source or content bound");
    if(input.kind==="image"?localImageMime(raw)!==input.mime:input.mime!=="application/x-ndjson")throw new Error("Invalid artifact media type");
    const scope=automationScope(p,o),id=hash(JSON.stringify([scope,input.workflowId,input.key]));
    const requestHash=hash(JSON.stringify([input,hash(raw)]));
    const old=this.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as unknown as Row|undefined;
    if(old){if(old.requestHash!==requestHash)throw new Error("Artifact request identity reused with different bytes");
      if(old.state!=="ready"&&old.state!=="removed")throw new Error("Previous artifact write/removal uncertain; inspect, never overwrite");
      if(old.state==="ready")this.read(p,o,id);
      return this.view(old);}
    const count=this.db.prepare("SELECT count(*) AS n FROM artifacts").get() as {n:number};
    if(count.n>=MAX_ROWS)throw new Error("Artifact metadata quota reached; audit receipts retained");
    const packed=input.kind==="run-log"?zstdCompressSync(raw,{params:{[zconst.ZSTD_c_compressionLevel]:3,[zconst.ZSTD_c_checksumFlag]:1,[zconst.ZSTD_c_windowLog]:17},maxOutputLength:MAX_RAW+65536}):raw;
    this.collect(p,o,packed.length);
    if(this.usage().storedBytes+packed.length>this.opt.policy.maxBytes)throw new Error("Local artifact quota full; active/pinned evidence is retained");
    const r:Row={id,scope,workflowId:input.workflowId,runId:input.runId,kind:input.kind,sourceSha:input.sourceSha,
      mime:input.mime,provenance:input.kind==="image"?"operator-upload":"public-run-projection",label:input.label,
      bytes:raw.length,storedBytes:packed.length,sha256:hash(raw),storedHash:hash(packed),requestHash,createdAt:Date.now(),pinned:0,state:"writing"};
    this.db.prepare("INSERT INTO artifacts(id,scope,workflowId,runId,kind,sourceSha,mime,provenance,label,bytes,storedBytes,sha256,storedHash,requestHash,createdAt,pinned,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(r.id,r.scope,r.workflowId,r.runId,r.kind,r.sourceSha,r.mime,r.provenance,r.label,r.bytes,r.storedBytes,r.sha256,r.storedHash,r.requestHash,r.createdAt,0,r.state);
    const fd=openSync(this.path(id),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,packed);fsyncSync(fd);}finally{closeSync(fd);}
    syncDirectory(this.objects);this.opt.signal.throwIfAborted();
    this.db.prepare("UPDATE artifacts SET state='ready' WHERE id=? AND state='writing'").run(id);
    return this.view(this.row(p,o,id));
  }
}
