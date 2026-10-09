/** Immutable, content-addressed QC screenshot evidence from an exact clean Git SHA.
 * Only explicit operator-requested local captures; never pretend to take a screenshot.
 * Original bytes are private to the plugin host and are NOT sent to a model. */
import {createHash,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdirSync,existsSync,lstatSync,realpathSync,openSync,closeSync,
  fstatSync,readFileSync,writeFileSync,constants} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import type {PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";
import type {WorkflowStore} from "../core/store.js";
import type {AgentRegistry} from "../runtime/registry.js";
import type {AutopilotLedger} from "./ledger.js";
import {automationScope} from "./ledger.js";
import {requireCleanGit,type GitHost} from "./git.js";

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
      ON screenshot_evidence(scope,workflow_id,created_at);`);
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
    const blob=safeScreenshotBytes(ws.path,relativePath);
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
