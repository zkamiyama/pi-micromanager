/** Reclaim only this controller's completed clean checkouts. Git refs and user
 * Worktrees are never removed. Unknown native deletion results are never replayed. */
import {createHash,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {existsSync,lstatSync,realpathSync,readdirSync} from "node:fs";
import {join,resolve} from "node:path";
import type {PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";
import type {WorkflowStore} from "../core/store.js";
import type {AgentRegistry} from "../runtime/registry.js";
import {managedBranch} from "../core/identifiers.js";
import {automationScope,type AutopilotLedger} from "./ledger.js";
import type {ManagedWorktreeProvisioner,WorktreePlan} from "./worktree-provisioner.js";
import {git,gitValue,requireCleanGit,type GitHost} from "./git.js";

export interface WorktreeRetirement {
 id:string;workflowId:string;taskId:string;planId:string;workspaceId:string;
 headSha:string;preservedRef:string;estimatedBytes:number;revision:number;generation:number;
 expiresAt:number;state:"prepared"|"reserved"|"completed"|"uncertain";
}
interface Row extends WorktreeRetirement {scope:string;path:string;repoRoot:string;inode:string;manifest:string}
interface Options {
 dataDirectory:string;host:GitHost;workflows:WorkflowStore;agents:AgentRegistry;ledger:AutopilotLedger;
 provisioner:ManagedWorktreeProvisioner;workspaces():PiWebHostWorkspacesV1|undefined;
 protected(p:string,o:string,w:string):boolean;
 /** Joins only owned successful Runs and exports their public projections. */
 prepareRuns(p:string,o:string,w:string):Promise<void>;
}
const hash=(x:unknown)=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
function registry(raw:string):Array<{path:string;head:string;branch:string;blocked:boolean}>{
 if(raw.length>2*1024*1024)throw new Error("Git Worktree registry too large");
 return raw.split("\0\0").filter(Boolean).map(s=>{
  const fields=s.split("\0");const get=(p:string)=>fields.find(f=>f.startsWith(p))?.slice(p.length)??"";
  const path=get("worktree "),head=get("HEAD "),branch=get("branch ");
  if(!path||!head)throw new Error("Malformed Git Worktree registry");
  return {path,head,branch,blocked:fields.some(f=>/^(locked|prunable|bare|detached)( |$)/.test(f))};
 });
}
function treeBytes(root:string):number{
 let bytes=0,files=0;const dirs=[root];
 while(dirs.length){const dir=dirs.pop()!;
  for(const ent of readdirSync(dir,{withFileTypes:true})){
   if(++files>30000)throw new Error("Worktree inventory exceeds bounded scan");
   const path=join(dir,ent.name),s=lstatSync(path);
   if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||s.isFile()&&s.nlink!==1)throw new Error("Worktree contains unsafe filesystem aliases");
   if(s.isDirectory())dirs.push(path);else bytes+=s.size;
  }
 }
 return bytes;
}
export class OwnedWorktreeRetention {
 private readonly db:DatabaseSync;
 constructor(private readonly opt:Options){
  this.db=new DatabaseSync(join(opt.dataDirectory,"worktree-retirements.sqlite"));
  this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS retirements(id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflowId TEXT NOT NULL,taskId TEXT NOT NULL,
    planId TEXT NOT NULL,workspaceId TEXT NOT NULL,headSha TEXT NOT NULL,preservedRef TEXT NOT NULL,estimatedBytes INTEGER NOT NULL,
    revision INTEGER NOT NULL,generation INTEGER NOT NULL,expiresAt INTEGER NOT NULL,state TEXT NOT NULL,path TEXT NOT NULL,
    repoRoot TEXT NOT NULL,inode TEXT NOT NULL,manifest TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS retirements_plan ON retirements(scope,planId);`);
 }
 close():void{this.db.close();}
 private view(r:Row):WorktreeRetirement{const {scope:_,path:__,repoRoot:___,inode:____,manifest:_____,...v}=r;return v;}
 list(p:string,o:string,w:string):WorktreeRetirement[]{
  return (this.db.prepare("SELECT * FROM retirements WHERE scope=? AND workflowId=? ORDER BY rowid DESC LIMIT 128")
   .all(automationScope(p,o),w) as unknown as Row[]).map(r=>this.view(r));
 }
 private original(p:string,o:string,w:string,t:string):WorktreePlan{
  const plan=this.opt.provisioner.find(p,o,w,t);
  if(!plan||plan.stage!=="created")throw new Error("Only a confirmed controller-owned Worktree may be retired");
  const scopeHash=hashScope(p,o),expected=join(realpathSync(this.opt.dataDirectory),"managed-worktrees",scopeHash,w,t);
  if(plan.path!==expected||plan.branch!==managedBranch(scopeHash,w,t)||resolve(plan.repoRoot)!==plan.repoRoot||
    realpathSync(plan.repoRoot)!==plan.repoRoot)throw new Error("Managed Worktree ownership differs from creation receipt");
  return plan;
 }
 private guard(p:string,o:string,w:string,revision?:number,generation?:number):void{
  this.opt.host.lifetimeSignal.throwIfAborted();
  const wf=this.opt.workflows.get(p,o,w),config=this.opt.ledger.get(p,o,w);
  if(!config||config.config.runtime!=="durable"||config.enabled||this.opt.protected(p,o,w)||
    Object.values(wf.tasks).some(t=>!["integrated","done"].includes(t.status))||
    this.opt.agents.hasUnsealedWorkflow(p,o,w)||wf.amendments.some(a=>!["completed","cancelled"].includes(a.status)))
   throw new Error("Worktree retained: unfinished, pinned, active or uncertain Workflow");
  if(revision!==undefined&&wf.revision!==revision||generation!==undefined&&config.generation!==generation)
   throw new Error("Workflow/control generation changed during Worktree retirement");
 }
 private async snapshot(p:string,o:string,plan:WorktreePlan){
  this.guard(p,o,plan.workflowId);
  const cfg=this.opt.ledger.get(p,o,plan.workflowId)!,wf=this.opt.workflows.get(p,o,plan.workflowId);
  const workspaceId=plan.taskId==="mm-final-integration"?cfg.config.finalization?.workspaceId:cfg.config.workspaces[plan.taskId];
  const source=wf.tasks[plan.taskId];
  if(!workspaceId||workspaceId==="auto"||source?.lastQc?.verdict!=="pass")throw new Error("Worktree has no exact finalized source");
  const qc=this.opt.agents.getRun(p,o,plan.workflowId,source.lastQc.runId);
  if(!qc||qc.phase!=="sealed"||qc.seat!=="qc"||!qc.evidenceRef||!qc.sessionId||
    this.opt.ledger.evidence(qc)?.ref!==qc.evidenceRef)throw new Error("Retirement needs sealed QC evidence");
  const api=this.opt.workspaces();if(!api)throw new Error("Workspace authority unavailable");
  const a=await api.resolve({projectId:p,workspaceId});
  if(a.project.id!==p||a.workspace.id!==workspaceId||a.workspace.projectId!==p||a.workspace.isMain||
    a.workspace.path!==plan.path||a.project.path!==plan.repoRoot||a.workspace.provider?.metadata?.isGitWorktree!==true)
   throw new Error("Retirement Workspace authority changed");
  this.opt.agents.registerWorkspacePath(p,workspaceId,plan.path);
  const stat=lstatSync(plan.path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(plan.path)!==plan.path)throw new Error("Unsafe Worktree directory");
  const common=await gitValue(this.opt.host,plan.path,["rev-parse","--path-format=absolute","--git-common-dir"]);
  const rootCommon=await gitValue(this.opt.host,plan.repoRoot,["rev-parse","--path-format=absolute","--git-common-dir"]);
  if(common!==rootCommon||realpathSync(common)!==common)throw new Error("Worktree Git ownership mismatch");
  const entries=registry(await gitValue(this.opt.host,plan.repoRoot,["worktree","list","--porcelain","-z"]));
  const exact=entries.filter(x=>x.path===plan.path);
  if(exact.length!==1||exact[0]!.blocked||exact[0]!.branch!=="refs/heads/"+plan.branch||exact[0]!.head!==source.lastQc.headSha)
   throw new Error("Locked, changed or unproved Git Worktree registration");
  const head=await requireCleanGit(this.opt.host,plan.path);
  if(head!==source.lastQc.headSha||await gitValue(this.opt.host,plan.repoRoot,["rev-parse","refs/heads/"+plan.branch])!==head)
   throw new Error("Worktree result is not preserved by its original Git ref");
  // Ignored files can contain user data too. No --force or guessed cache deletion.
  if(await gitValue(this.opt.host,plan.path,["status","--porcelain","--ignored","--untracked-files=all","--ignore-submodules=none"])||
    /(^|\0)160000 /.test(await gitValue(this.opt.host,plan.path,["ls-files","--stage","-z"])))
   throw new Error("Worktree contains untracked, ignored or submodule data; retain for manual review");
  const estimatedBytes=treeBytes(plan.path);
  this.guard(p,o,plan.workflowId,wf.revision,cfg.generation);
  return {workspaceId,headSha:head,preservedRef:"refs/heads/"+plan.branch,estimatedBytes,
   revision:wf.revision,generation:cfg.generation,inode:stat.dev+":"+stat.ino};
 }
 async preview(p:string,o:string,w:string,t:string):Promise<WorktreeRetirement>{
  const plan=this.original(p,o,w,t);
  const old=this.db.prepare("SELECT * FROM retirements WHERE scope=? AND planId=? AND state!='prepared' ORDER BY rowid DESC LIMIT 1")
   .get(automationScope(p,o),plan.id) as unknown as Row|undefined;
  if(old)return this.view(old);
  const snapshot=await this.snapshot(p,o,plan);
  const count=this.db.prepare("SELECT count(*) AS n FROM retirements WHERE scope=? AND state='prepared' AND expiresAt>?").get(automationScope(p,o),Date.now()) as {n:number};
  if(count.n>=64)throw new Error("Too many active Worktree previews");
  const row:Row={id:randomUUID(),scope:automationScope(p,o),workflowId:w,taskId:t,planId:plan.id,...snapshot,
   expiresAt:Date.now()+10*60*1000,state:"prepared",path:plan.path,repoRoot:plan.repoRoot,manifest:hash(snapshot)};
  this.db.prepare("INSERT INTO retirements VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
   .run(row.id,row.scope,w,t,plan.id,row.workspaceId,row.headSha,row.preservedRef,row.estimatedBytes,row.revision,row.generation,
    row.expiresAt,row.state,row.path,row.repoRoot,row.inode,row.manifest);
  return this.view(row);
 }
 async confirm(p:string,o:string,id:string):Promise<WorktreeRetirement>{
  const row=this.db.prepare("SELECT * FROM retirements WHERE id=? AND scope=?").get(id,automationScope(p,o)) as unknown as Row|undefined;
  if(!row)throw new Error("Worktree retirement belongs to another scope");
  if(row.state==="completed")return this.view(row);
  if(row.state!=="prepared")throw new Error("Previous Worktree removal unconfirmed; no replay or lock release");
  if(row.expiresAt<Date.now())throw new Error("Worktree retirement preview expired");
  this.guard(p,o,row.workflowId,row.revision,row.generation);
  const plan=this.original(p,o,row.workflowId,row.taskId);
  if(plan.id!==row.planId)throw new Error("Worktree creation identity changed");
  const owner="retire:"+row.id;let submitted=false;
  this.opt.agents.acquireWorkspaceOperation(p,row.workspaceId,owner);
  try{
   await this.opt.prepareRuns(p,o,row.workflowId);
   const fresh=await this.snapshot(p,o,plan);if(hash(fresh)!==row.manifest)throw new Error("Worktree retirement proof changed");
   const fence=()=>{
    this.guard(p,o,row.workflowId,row.revision,row.generation);
    const s=lstatSync(row.path);
    if(!s.isDirectory()||s.isSymbolicLink()||s.dev+":"+s.ino!==row.inode||realpathSync(row.path)!==row.path)
     throw new Error("Worktree identity changed before removal");
   };
   fence();if(this.db.prepare("UPDATE retirements SET state='reserved' WHERE id=? AND state='prepared'").run(row.id).changes!==1)
    throw new Error("Concurrent Worktree retirement reservation");
   submitted=true;
   const result=await git(this.opt.host,row.repoRoot,["worktree","remove",row.path],60000,fence);
   if(result.exitCode!==0||result.signal)throw new Error("Git did not confirm Worktree removal");
   this.guard(p,o,row.workflowId,row.revision,row.generation);
   const remaining=registry(await gitValue(this.opt.host,row.repoRoot,["worktree","list","--porcelain","-z"]));
   if(existsSync(row.path)||remaining.some(r=>r.path===row.path)||
     await gitValue(this.opt.host,row.repoRoot,["rev-parse",row.preservedRef])!==row.headSha)
    throw new Error("Worktree removal result or retained ref unproved");
   this.db.prepare("UPDATE retirements SET state='completed' WHERE id=? AND state='reserved'").run(row.id);
   this.opt.agents.releaseWorkspaceOperation(p,row.workspaceId,owner);
   return {...this.view(row),state:"completed"};
  }catch(error){
   if(submitted)this.db.prepare("UPDATE retirements SET state='uncertain' WHERE id=?").run(row.id);
   else this.opt.agents.releaseWorkspaceOperation(p,row.workspaceId,owner);
   throw error;
  }
 }
}
function hashScope(p:string,o:string):string{return createHash("sha256").update(automationScope(p,o)).digest("hex").slice(0,16);}
