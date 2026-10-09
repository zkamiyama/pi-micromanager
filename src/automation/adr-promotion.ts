/** Human-authored, evidence-backed ADR drafts staged in an explicit non-main
 * linked Git Worktree. Never commits, pushes, merges or publishes a PR. */
import {createHash,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {dirname,join,resolve,sep} from "node:path";
import {mkdirSync,existsSync,lstatSync,realpathSync,
  readFileSync,writeFileSync} from "node:fs";
import type {PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";
import type {WorkflowStore,} from "../core/store.js";
import type {AgentRegistry} from "../runtime/registry.js";
import type {AutopilotLedger} from "./ledger.js";
import {automationScope} from "./ledger.js";
import type {ScreenshotEvidence} from "./screenshots.js";
import {gitValue,requireCleanGit,type GitHost} from "./git.js";

const ADR_NAME=/^\d{4}-[a-z][a-z0-9-]{0,63}\.md$/;
const TTL=10*60*1000;
export interface AdrFields{
  filename:string;title:string;context:string;options:string;
  decision:string;consequences:string;
}
export interface AdrDraft{
  id:string;workflowId:string;targetWorkspaceId:string;filename:string;
  targetHead:string;workflowRevision:number;sourceDigest:string;
  sha256:string;content:string;expiresAt:number;state:"prepared"|"reserved"|"staged";
}
interface AdrRow extends AdrDraft{scope:string;target_path:string;created_at:string}
interface AdrOptions {
  path:string;workflows:WorkflowStore;agents:AgentRegistry;ledger:AutopilotLedger;
  screenshots:ScreenshotEvidence;host:GitHost;
  workspaces():PiWebHostWorkspacesV1|undefined;
}
const FIELDS="id,scope,workflow_id AS workflowId,target_workspace_id AS targetWorkspaceId,"+
  "filename,target_head AS targetHead,workflow_revision AS workflowRevision,"+
  "source_digest AS sourceDigest,sha256,content,expires_at AS expiresAt,"+
  "state,target_path,created_at";
function valid(value:unknown,max:number,label:string):string{
  if(typeof value!=="string"||!value.trim()||value.length>max||
    value.includes("\0"))
    throw new Error("ADR "+label+" must be nonempty and at most "+max+" characters");
  return value.trim();
}
function parseFields(input:unknown):AdrFields{
  if(!input||typeof input!=="object"||Array.isArray(input))
    throw new Error("ADR fields must be an object");
  const f=input as Record<string,unknown>;
  const filename=valid(f.filename,80,"filename");
  if(!ADR_NAME.test(filename))
    throw new Error("ADR filename must be 0000-kebab-case.md");
  return {filename,title:valid(f.title,200,"title"),
    context:valid(f.context,4000,"context"),options:valid(f.options,4000,"options"),
    decision:valid(f.decision,4000,"decision"),
    consequences:valid(f.consequences,4000,"consequences")};
}
function escaped(value:string):string {
  // Keep operator sections plain Markdown; disable injected top-level
  // frontmatter that would change rendered ADR metadata unexpectedly.
  return value.replace(/\r/g,"").replace(/^---$/gm,"\\---");
}
function digest(value:unknown):string{
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sha(value:string):string{return createHash("sha256").update(value).digest("hex");}
export class AdrPromotion {
  private readonly db:DatabaseSync;
  constructor(private readonly opt:AdrOptions){
    mkdirSync(dirname(opt.path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(opt.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS adr_drafts(
      id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflow_id TEXT NOT NULL,
      target_workspace_id TEXT NOT NULL,filename TEXT NOT NULL,
      target_head TEXT NOT NULL,workflow_revision INTEGER NOT NULL,
      source_digest TEXT NOT NULL,sha256 TEXT NOT NULL,
      content TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,
      target_path TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS adr_drafts_workflow
      ON adr_drafts(scope,workflow_id,created_at);`);
  }
  close():void{this.db.close();}
  private row(p:string,o:string,id:string):AdrRow {
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error("Invalid ADR draft ID");
    const row=this.db.prepare("SELECT "+FIELDS+" FROM adr_drafts WHERE id=? AND scope=?")
      .get(id,automationScope(p,o)) as AdrRow|undefined;
    if(!row)throw new Error("ADR draft does not belong to this Orchestra");
    return row;
  }
  private view(row:AdrRow):AdrDraft {
    return {id:row.id,workflowId:row.workflowId,
      targetWorkspaceId:row.targetWorkspaceId,filename:row.filename,
      targetHead:row.targetHead,workflowRevision:row.workflowRevision,
      sourceDigest:row.sourceDigest,sha256:row.sha256,content:row.content,
      expiresAt:row.expiresAt,state:row.state};
  }
  latest(p:string,o:string,workflowId:string):AdrDraft|null{
    const row=this.db.prepare("SELECT "+FIELDS+" FROM adr_drafts WHERE scope=?"+
      " AND workflow_id=? ORDER BY created_at DESC LIMIT 1")
      .get(automationScope(p,o),workflowId) as AdrRow|undefined;
    return row?this.view(row):null;
  }
  /** Only immutable, sealed, real QC evidence may be used to ground the ADR. */
  private evidence(p:string,o:string,workflowId:string) {
    const workflow=this.opt.workflows.get(p,o,workflowId);
    if(this.opt.ledger.get(p,o,workflowId)?.enabled)
      throw new Error("Pause Autopilot before reviewing an ADR");
    if(Object.values(workflow.tasks).some(t=>
      t.status!=="done"&&t.status!=="integrated")||
      workflow.amendments.some(a=>a.status!=="cancelled"&&a.status!=="completed"))
      throw new Error("ADR promotion requires a completely resolved Workflow");
    const verified:Array<{taskId:string;task:string;qcRunId:string;
      commit:string;evidenceRef:string}>=[];
    for(const task of Object.values(workflow.tasks)){
      if(task.spec.kind!=="implementation")continue;
      if(task.status!=="integrated"||task.lastQc?.verdict!=="pass")
        throw new Error("ADR needs a QC-passed and integrated implementation Task");
      const qc=this.opt.agents.getRun(p,o,workflowId,task.lastQc.runId);
      if(!qc||qc.seat!=="qc"||qc.taskId!==task.spec.id||
        qc.phase!=="sealed"||!qc.sessionId||!qc.evidenceRef||
        !qc.requestId.startsWith("auto:"))
        throw new Error("ADR source QC has no durable sealed native Run");
      const evidence=this.opt.ledger.evidence(qc);
      if(!evidence||evidence.ref!==qc.evidenceRef||evidence.sessionId!==qc.sessionId)
        throw new Error("ADR QC evidence receipt mismatch");
      verified.push({taskId:task.spec.id,task:task.spec.title,
        qcRunId:qc.runId,commit:task.lastQc.headSha,evidenceRef:evidence.ref});
    }
    if(!verified.length)throw new Error("ADR source has no implementation QC evidence");
    // Only current QC-passed source snapshots are cited. Verify stored
    // screenshot bytes again; a modified object may never be promoted as
    // immutable engineering evidence.
    const screenshots=this.opt.screenshots.list(p,o,workflowId)
      .filter(s=>verified.some(v=>v.qcRunId===s.runId&&v.commit===s.sourceSha))
      .map(s=>{
        this.opt.screenshots.preview(p,o,workflowId,s.id);
        return {runId:s.runId,sourceSha:s.sourceSha,sha256:s.sha256,
          bytes:s.bytes,relativePath:s.relativePath};
      });
    return {workflow,verified,screenshots,
      sourceDigest:digest([workflow.revision,verified,screenshots])};
  }
  private async target(p:string,o:string,workflowId:string,workspaceId:string){
    if(this.opt.agents.wasWorkflowWorkspace(p,o,workflowId,workspaceId)||
      Object.values(this.opt.ledger.get(p,o,workflowId)?.config.workspaces??{})
        .includes(workspaceId))
      throw new Error("ADR review target must be separate from implementation/QC Worktrees");
    const api=this.opt.workspaces();
    if(!api)throw new Error("PI WEB Workspace capability unavailable");
    const result=await api.resolve({projectId:p,workspaceId});
    const workspace=result.workspace;
    if(result.project.id!==p||workspace.projectId!==p||
      workspace.id!==workspaceId||workspace.isMain||
      workspace.provider?.metadata?.isGitWorktree!==true)
      throw new Error("ADRs can only be staged in a linked non-main PI WEB Git Worktree");
    if(this.opt.agents.hasUnsealedWorkspace(p,workspaceId))
      throw new Error("Target ADR Git Worktree is leased by an unfinished Pi Run");
    const head=await requireCleanGit(this.opt.host,workspace.path);
    const branch=await gitValue(this.opt.host,workspace.path,
      ["symbolic-ref","--quiet","--short","HEAD"]);
    if(!branch||/^(main|master|develop|production|stable|release)(\/|$)/i.test(branch))
      throw new Error("ADR target must be a non-protected review branch");
    return {workspace,head,branch};
  }
  private filePath(root:string,filename:string):string{
    if(!ADR_NAME.test(filename))throw new Error("Invalid ADR filename");
    const source=realpathSync(root),dir=join(source,"docs","adr");
    for(const path of [join(source,"docs"),dir]){
      if(existsSync(path)){
        const info=lstatSync(path);
        if(info.isSymbolicLink()||!info.isDirectory())
          throw new Error("ADR directory is a symlink or not a directory");
        if(realpathSync(path)!==path)
          throw new Error("ADR directory canonical root changed");
      }
    }
    const target=resolve(dir,filename);
    if(!target.startsWith(source+sep))
      throw new Error("ADR path escapes the selected Worktree");
    if(existsSync(target))throw new Error("ADR file already exists; refuse overwrite");
    return target;
  }
  async preview(p:string,o:string,workflowId:string,targetWorkspaceId:string,
    input:unknown):Promise<AdrDraft>{
    const fields=parseFields(input);
    const proof=this.evidence(p,o,workflowId);
    const selected=await this.target(p,o,workflowId,targetWorkspaceId);
    const targetPath=this.filePath(selected.workspace.path,fields.filename);
    const now=new Date().toISOString();
    const source=proof.verified.map(x=>"- **"+x.task+"** (`"+x.taskId+"`): "+
      "QC `"+x.qcRunId+"`, Git `"+x.commit+"`, sealed evidence `"+x.evidenceRef+"`")
      .join("\n");
    const screenshotList=proof.screenshots.map(s=>"- QC `"+s.runId+
      "` `"+s.relativePath+"` sha256:`"+s.sha256+"` ("+s.bytes+" bytes)")
      .join("\n");
    const markdown=[
      "# "+escaped(fields.title),"",
      "- Status: Proposed (human review required)",
      "- Date: "+now.slice(0,10),
      "- Source Workflow: `"+workflowId+"` revision "+proof.workflow.revision,
      "- Target Git branch: `"+selected.branch+"`","",
      "## Context","",escaped(fields.context),"",
      "## Considered options","",escaped(fields.options),"",
      "## Decision","",escaped(fields.decision),"",
      "## Consequences","",escaped(fields.consequences),"",
      "## Verification and source evidence","",source,"",
      ...(screenshotList?["### Captured screenshot references","",screenshotList,""]:[]),
      "The referenced QC evidence is preserved in the scoped Micromanager ledger. "+
        "This draft is not an approved architecture decision or a published PR.","",
    ].join("\n");
    if(Buffer.byteLength(markdown)>30000)throw new Error("ADR draft exceeds 30 KiB");
    const draft:AdrDraft={
      id:randomUUID(),workflowId,targetWorkspaceId,filename:fields.filename,
      targetHead:selected.head,workflowRevision:proof.workflow.revision,
      sourceDigest:proof.sourceDigest,sha256:sha(markdown),content:markdown,
      expiresAt:Date.now()+TTL,state:"prepared",
    };
    // Keep review attempts finite; never delete reserved/staged receipts
    // that are needed to reconcile an uncertain filesystem write.
    const scope=automationScope(p,o);
    this.db.prepare("DELETE FROM adr_drafts WHERE state='prepared' AND expires_at<?")
      .run(Date.now()-30*24*60*60*1000);
    const pending=this.db.prepare("SELECT COUNT(*) AS n FROM adr_drafts WHERE scope=?"+
      " AND workflow_id=? AND state='prepared' AND expires_at>=?")
      .get(scope,workflowId,Date.now()) as {n:number};
    if(pending.n>=8)
      throw new Error("Too many pending ADR previews; let earlier reviews expire");
    this.db.prepare(`INSERT INTO adr_drafts
      (id,scope,workflow_id,target_workspace_id,filename,target_head,
       workflow_revision,source_digest,sha256,content,expires_at,state,
       target_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(draft.id,automationScope(p,o),workflowId,targetWorkspaceId,
        fields.filename,selected.head,draft.workflowRevision,draft.sourceDigest,
        draft.sha256,markdown,draft.expiresAt,draft.state,targetPath,now);
    return draft;
  }
  /** Does not mutate Git. Verify the exact staged file bytes after uncertain writes. */
  inspect(p:string,o:string,id:string):AdrDraft {
    const row=this.row(p,o,id);
    if(row.state==="prepared")return this.view(row);
    if(!existsSync(row.target_path))
      throw new Error("Reserved ADR file is missing; reconcile rather than blindly rewrite");
    const info=lstatSync(row.target_path);
    if(info.isSymbolicLink()||!info.isFile()||info.size>30000)
      throw new Error("ADR target has unsafe filesystem type");
    const actual=readFileSync(row.target_path);
    if(sha(actual.toString("utf8"))!==row.sha256)
      throw new Error("ADR bytes differ from the approved preview");
    if(row.state!=="staged"){
      this.db.prepare("UPDATE adr_drafts SET state='staged' WHERE id=?").run(id);
      row.state="staged";
    }
    return this.view(row);
  }
  async stage(p:string,o:string,id:string):Promise<AdrDraft> {
    const row=this.row(p,o,id);
    if(row.state!=="prepared")return this.inspect(p,o,id);
    if(Date.now()>row.expiresAt)throw new Error("ADR preview expired; request a new review");
    const proof=this.evidence(p,o,row.workflowId);
    if(proof.workflow.revision!==row.workflowRevision||
      proof.sourceDigest!==row.sourceDigest)
      throw new Error("ADR source evidence changed since review");
    const current=await this.target(p,o,row.workflowId,row.targetWorkspaceId);
    if(current.head!==row.targetHead||
      this.filePath(current.workspace.path,row.filename)!==row.target_path)
      throw new Error("ADR Git target changed since review");
    // Host Workspace resolution is asynchronous. Close the admission race
    // before the non-atomic file write with synchronous authoritative checks.
    const latest=this.evidence(p,o,row.workflowId);
    if(latest.sourceDigest!==row.sourceDigest||
      latest.workflow.revision!==row.workflowRevision)
      throw new Error("ADR evidence changed while validating the target");
    if(this.opt.agents.hasUnsealedWorkspace(p,row.targetWorkspaceId))
      throw new Error("ADR review target became busy during staging");
    this.opt.host.lifetimeSignal.throwIfAborted();
    const reserved=this.db.prepare("UPDATE adr_drafts SET state='reserved'"+
      " WHERE id=? AND state='prepared'").run(id);
    if(reserved.changes!==1)throw new Error("ADR stage is already reserved");
    // The approved bytes and SHA are persisted BEFORE the non-atomic write.
    // Any host failure can only be resolved by inspect, not an unsafe retry.
    mkdirSync(dirname(row.target_path),{recursive:true,mode:0o700});
    writeFileSync(row.target_path,row.content,{encoding:"utf8",flag:"wx",mode:0o600});
    return this.inspect(p,o,id);
  }
}
