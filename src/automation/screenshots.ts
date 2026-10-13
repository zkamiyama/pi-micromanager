/** Immutable, content-addressed QC screenshot evidence from an exact clean Git SHA.
 * Explicit operator capture or opt-in import of already tracked files;
 * never pretend to capture a new browser screenshot.
 * Original bytes are private to the plugin host and are NOT sent to a model. */
import {createHash,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdirSync,existsSync,lstatSync,realpathSync,openSync,closeSync,
  fstatSync,readFileSync,writeFileSync,unlinkSync,readdirSync,statSync,constants} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import type {PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";
import type {WorkflowStore} from "../core/store.js";
import type {AgentRegistry} from "../runtime/registry.js";
import type {AutopilotLedger} from "./ledger.js";
import {automationScope} from "./ledger.js";
import {gitValue,gitSha,requireCleanGit,type GitHost} from "./git.js";

const MAX_IMAGE=1024*1024;
const MAX_INLINE=512*1024;
const MAX_ITEMS_WORKFLOW=32;
const MAX_ITEMS_SCOPE=200;
const MAX_BYTES_SCOPE=16*1024*1024;
const PATH_PATTERN=/^screenshots\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.(png|jpe?g)$/;
const IMAGE_FIELDS="id,workflow_id AS workflowId,run_id AS runId,"+
  "session_id AS sessionId,relative_path AS relativePath,mime,sha256,bytes,"+
  "source_sha AS sourceSha,created_at AS createdAt";

export interface ScreenshotArtifact {
  id:string;workflowId:string;runId:string;sessionId:string;
  relativePath:string;mime:"image/png"|"image/jpeg";sha256:string;bytes:number;
  sourceSha:string;createdAt:string;
}
export interface ScreenshotPreview {
  artifact:ScreenshotArtifact;dataUrl:string|null;inlineLimit:number;
}
export interface ScreenshotOrphanPreview {
  id:string;workflowId:string;files:number;bytes:number;
  expiresAt:number;state:"prepared"|"reserved"|"completed";
}
const ORPHAN_MIN_AGE=24*60*60*1000,GC_PREVIEW_TTL=10*60*1000;
const OBJECT_NAME=/^[0-9a-f]{64}\.(?:png|jpg)$/;
interface ArtifactRow extends ScreenshotArtifact {scope:string;object_path:string}
interface EvidenceOptions {
  path:string;dataDirectory:string;workflows:WorkflowStore;
  agents:AgentRegistry;ledger:AutopilotLedger;
  host:GitHost;workspaces():PiWebHostWorkspacesV1|undefined;
}
function mimeOf(blob:Buffer,filename:string):"image/png"|"image/jpeg"{
  if(filename.endsWith(".png")){
    if(blob.length<33||!blob.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
      blob.toString("ascii",12,16)!=="IHDR")
      throw new Error("File is not a valid PNG header");
    const w=blob.readUInt32BE(16),h=blob.readUInt32BE(20);
    if(w<1||h<1||w>4096||h>4096)
      throw new Error("PNG dimensions must be within 4096 pixels");
    return "image/png";
  }
  if(!/\.jpe?g$/i.test(filename)||blob.length<4||
    blob[0]!==0xff||blob[1]!==0xd8||
    blob[blob.length-2]!==0xff||blob[blob.length-1]!==0xd9)
    throw new Error("File is not a complete JPEG image");
  return "image/jpeg";
}
function safeScreenshotBytes(workspacePath:string,relativePath:string):Buffer {
  if(!PATH_PATTERN.test(relativePath))
    throw new Error("Screenshots must be screenshots/<safe-file>.png/.jpg");
  const root=realpathSync(workspacePath);
  const filename=resolve(root,...relativePath.split("/"));
  if(!filename.startsWith(root+sep))
    throw new Error("Screenshot path escapes the selected Git Workspace");
  const parent=realpathSync(dirname(filename));
  if(!parent.startsWith(root+sep))
    throw new Error("Screenshot directory escapes the selected Git Workspace");
  const info=lstatSync(filename);
  if(info.isSymbolicLink()||!info.isFile()||info.size<16||info.size>MAX_IMAGE)
    throw new Error("Screenshot must be a real regular file of at most 1 MiB");
  const fd=openSync(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.size<16||opened.size>MAX_IMAGE||
      opened.ino!==info.ino||opened.dev!==info.dev)
      throw new Error("Screenshot changed during open");
    const blob=readFileSync(fd);
    if(blob.length!==opened.size)throw new Error("Screenshot changed while reading");
    return blob;
  }finally{closeSync(fd);}
}
export class ScreenshotEvidence {
  private readonly db:DatabaseSync;
  constructor(private readonly options:EvidenceOptions){
    mkdirSync(dirname(options.path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS screenshot_evidence(
      id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,session_id TEXT NOT NULL,relative_path TEXT NOT NULL,
      mime TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,
      source_sha TEXT NOT NULL,object_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(scope,workflow_id,run_id,relative_path));
      CREATE INDEX IF NOT EXISTS screenshot_evidence_scoped
      ON screenshot_evidence(scope,workflow_id,created_at);
      CREATE TABLE IF NOT EXISTS screenshot_orphan_gc(
        id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflow_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,fingerprint TEXT NOT NULL,
        expires_at INTEGER NOT NULL,state TEXT NOT NULL);`);
  }
  close():void{this.db.close();}
  list(projectId:string,orchestraWorkspaceId:string,workflowId:string):ScreenshotArtifact[]{
    const scope=automationScope(projectId,orchestraWorkspaceId);
    return this.db.prepare("SELECT "+IMAGE_FIELDS+" FROM screenshot_evidence"+
      " WHERE scope=? AND workflow_id=? ORDER BY created_at DESC LIMIT 40")
      .all(scope,workflowId) as unknown as ScreenshotArtifact[];
  }
  private row(projectId:string,orchestraWorkspaceId:string,workflowId:string,id:string):ArtifactRow {
    if(!/^[0-9a-f-]{36}$/.test(id))throw new Error("Invalid screenshot ID");
    const result=this.db.prepare("SELECT "+IMAGE_FIELDS+",scope,object_path"+
      " FROM screenshot_evidence WHERE scope=? AND workflow_id=? AND id=?")
      .get(automationScope(projectId,orchestraWorkspaceId),workflowId,id) as ArtifactRow|undefined;
    if(!result)throw new Error("Screenshot does not belong to this Workflow");
    return result;
  }
  async capture(projectId:string,orchestraWorkspaceId:string,workflowId:string,
    runId:string,relativePath:string):Promise<ScreenshotArtifact>{
    const wf=this.options.workflows.get(projectId,orchestraWorkspaceId,workflowId);
    const binding=this.options.agents.getRun(projectId,orchestraWorkspaceId,workflowId,runId);
    if(!binding||binding.seat!=="qc"||binding.phase!=="sealed"||
      !binding.sessionId||!binding.evidenceRef||!binding.requestId.startsWith("auto:"))
      throw new Error("Capture requires a sealed automatic QC Pi Run");
    const task=wf.tasks[binding.taskId];
    if(!task||task.spec.kind!=="implementation"||task.lastQc?.runId!==runId)
      throw new Error("Only the latest QC Run can source a screenshot");
    const evidence=this.options.ledger.evidence(binding);
    if(!evidence||evidence.ref!==binding.evidenceRef||
      evidence.sessionId!==binding.sessionId)
      throw new Error("QC Run evidence is missing or mismatched");
    if(this.options.agents.hasUnsealedWorkspace(projectId,binding.workspaceId))
      throw new Error("QC Worktree is currently owned by an unsealed Run");
    const provider=this.options.workspaces();
    if(!provider)throw new Error("PI WEB Workspace authority unavailable");
    const resolved=await provider.resolve({projectId,workspaceId:binding.workspaceId});
    const ws=resolved.workspace;
    if(resolved.project.id!==projectId||ws.id!==binding.workspaceId||
      ws.projectId!==projectId||ws.isMain||ws.provider?.metadata?.isGitWorktree!==true)
      throw new Error("QC Run's Git Worktree authority is missing");
    const head=await requireCleanGit(this.options.host,ws.path);
    if(head!==task.lastQc.headSha)
      throw new Error("Screenshot Git HEAD differs from the QC-evaluated SHA");
    if(!PATH_PATTERN.test(relativePath))
      throw new Error("Screenshots must be screenshots/<safe-file>.png/.jpg");
    // A clean Worktree does not prove an ignored file is part of Git HEAD.
    // Require exact tracked blob identity in the verified QC commit.
    const commitBlob=await gitValue(this.options.host,ws.path,
      ["rev-parse","HEAD:"+relativePath]).catch(()=>{
        throw new Error("Screenshot is absent from the QC-reviewed Git commit");
      });
    const diskBlob=await gitValue(this.options.host,ws.path,
      ["hash-object","--",relativePath]);
    if(!gitSha(commitBlob)||commitBlob!==diskBlob)
      throw new Error("Screenshot bytes do not match the QC-reviewed Git blob");
    const blob=safeScreenshotBytes(ws.path,relativePath);
    const afterReadBlob=await gitValue(this.options.host,ws.path,
      ["hash-object","--",relativePath]);
    if(afterReadBlob!==commitBlob)
      throw new Error("Screenshot changed during the Git blob validation");
    if(this.options.agents.hasUnsealedWorkspace(projectId,binding.workspaceId))
      throw new Error("QC Worktree became busy during screenshot validation");
    const mime=mimeOf(blob,relativePath);
    const sha256=createHash("sha256").update(blob).digest("hex");
    const scope=automationScope(projectId,orchestraWorkspaceId);
    const existing=this.db.prepare("SELECT "+IMAGE_FIELDS+" FROM screenshot_evidence"+
      " WHERE scope=? AND workflow_id=? AND run_id=? AND relative_path=?")
      .get(scope,workflowId,runId,relativePath) as ScreenshotArtifact|undefined;
    if(existing){
      if(existing.sha256!==sha256||existing.sourceSha!==head)
        throw new Error("Immutable screenshot evidence differs from the earlier capture");
      return existing;
    }
    const usage=this.db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes"+
      " FROM screenshot_evidence WHERE scope=?").get(scope) as {count:number;bytes:number};
    const workflowCount=this.db.prepare("SELECT COUNT(*) AS count FROM screenshot_evidence"+
      " WHERE scope=? AND workflow_id=?").get(scope,workflowId) as {count:number};
    if(usage.count>=MAX_ITEMS_SCOPE||workflowCount.count>=MAX_ITEMS_WORKFLOW||
      usage.bytes+blob.length>MAX_BYTES_SCOPE)
      throw new Error("Screenshot storage quota exhausted; required evidence must be reviewed manually");
    this.options.host.lifetimeSignal.throwIfAborted();
    const owner=createHash("sha256").update(JSON.stringify([scope,workflowId]))
      .digest("hex").slice(0,32);
    const directory=join(this.options.dataDirectory,"screenshot-objects",owner);
    mkdirSync(directory,{recursive:true,mode:0o700});
    const path=join(directory,sha256+(mime==="image/png"?".png":".jpg"));
    if(existsSync(path)){
      const previous=readFileSync(path);
      if(previous.length!==blob.length||
        createHash("sha256").update(previous).digest("hex")!==sha256)
        throw new Error("Existing screenshot object has been modified");
    }else{
      // Content-addressed, no overwrite. A crash may leave a harmless orphan
      // blob, but never an authorized record pointing to different bytes.
      writeFileSync(path,blob,{flag:"wx",mode:0o600});
    }
    const record:ScreenshotArtifact={
      id:randomUUID(),workflowId,runId,sessionId:binding.sessionId,relativePath,
      mime,sha256,bytes:blob.length,sourceSha:head,createdAt:new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO screenshot_evidence
      (id,scope,workflow_id,run_id,session_id,relative_path,mime,sha256,
      bytes,source_sha,object_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.id,scope,workflowId,runId,binding.sessionId,relativePath,
        mime,sha256,blob.length,head,path,record.createdAt);
    return record;
  }
  /** Import a small, explicitly opt-in set of existing screenshots
   * tracked by the QC-evaluated Git SHA. Never take a screenshot, never
   * run browser capture APIs, and never accept untracked/ignored images. */
  async captureTracked(projectId:string,orchestraWorkspaceId:string,
    workflowId:string,runId:string):Promise<ScreenshotArtifact[]>{
    const wf=this.options.workflows.get(projectId,orchestraWorkspaceId,workflowId);
    const binding=this.options.agents.getRun(projectId,orchestraWorkspaceId,workflowId,runId);
    const task=binding?wf.tasks[binding.taskId]:undefined;
    if(!binding||binding.seat!=="qc"||binding.phase!=="sealed"||
      !binding.requestId.startsWith("auto:")||!task||
      task.spec.kind!=="implementation"||task.lastQc?.runId!==runId)
      throw new Error("Automatic import needs current sealed QC evidence");
    const provider=this.options.workspaces();
    if(!provider)throw new Error("PI WEB Workspace capability unavailable");
    const resolved=await provider.resolve({projectId,workspaceId:binding.workspaceId});
    if(resolved.project.id!==projectId||
      resolved.workspace.id!==binding.workspaceId||
      resolved.workspace.projectId!==projectId||
      resolved.workspace.isMain||
      resolved.workspace.provider?.metadata?.isGitWorktree!==true)
      throw new Error("QC screenshot Worktree authority mismatch");
    const head=await requireCleanGit(this.options.host,resolved.workspace.path);
    if(head!==task.lastQc.headSha)
      throw new Error("QC screenshot auto-import requires exact verified Git HEAD");
    const listed=await gitValue(this.options.host,resolved.workspace.path,[
      "ls-tree","-r","--name-only",head,"--","screenshots/"]);
    const paths=listed?listed.split("\n").filter(Boolean):[];
    if(paths.length>64)
      throw new Error("Too many screenshot files; inspect and import selectively");
    const accepted=paths.filter(path=>PATH_PATTERN.test(path));
    if(accepted.length>8)
      throw new Error("Automatic QC screenshot import permits at most eight images per Run");
    const records:ScreenshotArtifact[]=[];
    for(const path of accepted){
      this.options.host.lifetimeSignal.throwIfAborted();
      records.push(await this.capture(projectId,orchestraWorkspaceId,
        workflowId,runId,path));
    }
    return records;
  }
  private objectDirectory(p:string,o:string,workflowId:string):string{
    const scope=automationScope(p,o);
    const owner=createHash("sha256").update(JSON.stringify([scope,workflowId]))
      .digest("hex").slice(0,32);
    return join(this.options.dataDirectory,"screenshot-objects",owner);
  }
  /** Preview only plugin-owned orphan blobs. Never prune referenced QC
   * evidence, hosted Pi Sessions, Git Worktrees, or ADR references.
   * A 24h age boundary prevents racing an interrupted capture. */
  private orphanManifest(p:string,o:string,workflowId:string,now:number){
    const workflow=this.options.workflows.get(p,o,workflowId);
    if(this.options.ledger.get(p,o,workflowId)?.enabled||
      Object.values(workflow.tasks).some(t=>t.status!=="done"&&t.status!=="integrated")||
      workflow.amendments.some(a=>a.status!=="cancelled"&&a.status!=="completed")||
      this.options.agents.list(p,o,"active").some(b=>b.workflowId===workflowId))
      throw new Error("Orphan cleanup requires a finished, inactive Workflow");
    const root=this.objectDirectory(p,o,workflowId),scope=automationScope(p,o);
    if(!existsSync(root))return [] as Array<{name:string;sha:string;bytes:number}>;
    if(lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory()||
      realpathSync(root)!==root)
      throw new Error("Screenshot orphan directory has an unsafe filesystem type");
    const entries=readdirSync(root,{withFileTypes:true});
    if(entries.length>512)throw new Error("Too many screenshot objects for bounded orphan scan");
    const candidates:Array<{name:string;sha:string;bytes:number}>=[];
    for(const entry of entries){
      if(!entry.isFile()||!OBJECT_NAME.test(entry.name))continue;
      const file=join(root,entry.name),info=lstatSync(file);
      if(info.isSymbolicLink()||!info.isFile()||info.size<1||info.size>MAX_IMAGE)
        throw new Error("Unsafe private screenshot object discovered");
      if(info.mtimeMs>now-ORPHAN_MIN_AGE)continue;
      const used=this.db.prepare("SELECT 1 AS present FROM screenshot_evidence"+
        " WHERE scope=? AND workflow_id=? AND object_path=?")
        .get(scope,workflowId,file) as {present:number}|undefined;
      if(used)continue;
      const bytes=readFileSync(file);
      const digest=createHash("sha256").update(bytes).digest("hex");
      if(digest!==entry.name.slice(0,64)||bytes.length!==info.size)
        throw new Error("Orphan file bytes do not match content-addressed filename");
      candidates.push({name:entry.name,sha:digest,bytes:info.size});
    }
    if(candidates.length>32)throw new Error("Too many orphan objects for one review");
    return candidates.sort((a,b)=>a.name.localeCompare(b.name));
  }
  orphanPreview(p:string,o:string,workflowId:string,now=Date.now()):ScreenshotOrphanPreview{
    const files=this.orphanManifest(p,o,workflowId,now);
    const at=new Date().toISOString(),id=randomUUID(),
      digest=createHash("sha256").update(JSON.stringify(files)).digest("hex");
    const scope=automationScope(p,o);
    this.db.prepare("DELETE FROM screenshot_orphan_gc WHERE state='prepared' AND expires_at<?")
      .run(now);
    const active=this.db.prepare("SELECT COUNT(*) AS total FROM screenshot_orphan_gc"+
      " WHERE scope=? AND workflow_id=? AND state='prepared' AND expires_at>=?")
      .get(scope,workflowId,now) as {total:number};
    if(active.total>=4)throw new Error("Too many pending orphan cleanup previews");
    this.db.prepare("INSERT INTO screenshot_orphan_gc"+
      "(id,scope,workflow_id,manifest_json,fingerprint,expires_at,state)"+
      " VALUES(?,?,?,?,?,?,'prepared')").run(
        id,scope,workflowId,JSON.stringify(files),digest,now+GC_PREVIEW_TTL);
    return {id,workflowId,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),
      expiresAt:now+GC_PREVIEW_TTL,state:"prepared"};
  }
  /** Exact reviewed manifest only. Any changed object, active Run or
   * referenced evidence makes the confirmation fail before unlink. */
  orphanConfirm(p:string,o:string,workflowId:string,id:string,
    now=Date.now()):ScreenshotOrphanPreview{
    if(!/^[0-9a-f-]{36}$/.test(id))throw new Error("Invalid orphan cleanup receipt");
    const scope=automationScope(p,o);
    const row=this.db.prepare("SELECT manifest_json,fingerprint,expires_at,state"+
      " FROM screenshot_orphan_gc WHERE id=? AND scope=? AND workflow_id=?")
      .get(id,scope,workflowId) as {manifest_json:string;fingerprint:string;
        expires_at:number;state:string}|undefined;
    if(!row)throw new Error("Unknown orphan cleanup preview");
    const entries=JSON.parse(row.manifest_json) as Array<{name:string;sha:string;bytes:number}>;
    const info={id,workflowId,files:entries.length,
      bytes:entries.reduce((sum,x)=>sum+x.bytes,0),expiresAt:row.expires_at};
    if(row.state==="completed")return {...info,state:"completed"};
    if(row.state!=="prepared"||now>row.expires_at)
      throw new Error("Orphan preview expired or needs manual reconciliation");
    const current=this.orphanManifest(p,o,workflowId,now);
    if(createHash("sha256").update(JSON.stringify(current)).digest("hex")!==row.fingerprint)
      throw new Error("Private screenshot orphan set changed after preview");
    const res=this.db.prepare("UPDATE screenshot_orphan_gc SET state='reserved'"+
      " WHERE id=? AND state='prepared'").run(id);
    if(res.changes!==1)throw new Error("Concurrent orphan cleanup is reserved");
    const root=this.objectDirectory(p,o,workflowId);
    for(const file of current){
      this.options.host.lifetimeSignal.throwIfAborted();
      const path=join(root,file.name),meta=lstatSync(path);
      if(!meta.isFile()||meta.isSymbolicLink()||meta.size!==file.bytes||
        createHash("sha256").update(readFileSync(path)).digest("hex")!==file.sha)
        throw new Error("Orphan bytes changed after confirmation reservation");
      unlinkSync(path);
    }
    this.db.prepare("UPDATE screenshot_orphan_gc SET state='completed' WHERE id=?")
      .run(id);
    return {...info,state:"completed"};
  }
  preview(projectId:string,orchestraWorkspaceId:string,
    workflowId:string,id:string):ScreenshotPreview{
    const row=this.row(projectId,orchestraWorkspaceId,workflowId,id);
    const blob=readFileSync(row.object_path);
    if(blob.length!==row.bytes||createHash("sha256").update(blob).digest("hex")!==row.sha256)
      throw new Error("Screenshot bytes no longer match the immutable evidence record");
    return {artifact:{id:row.id,workflowId:row.workflowId,runId:row.runId,
      sessionId:row.sessionId,relativePath:row.relativePath,mime:row.mime,
      sha256:row.sha256,bytes:row.bytes,sourceSha:row.sourceSha,createdAt:row.createdAt},
      dataUrl:blob.length<=MAX_INLINE?"data:"+row.mime+";base64,"+blob.toString("base64"):null,
      inlineLimit:MAX_INLINE};
  }
}
