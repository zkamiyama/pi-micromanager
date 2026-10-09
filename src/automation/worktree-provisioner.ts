/** Durable Git Worktree provisioning under the plugin-owned data root.
 * PI WEB discovers Git worktrees on demand. The resolved PI WEB identity is
 * verified separately before admitting any Pi Session. */
import {createHash,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {mkdirSync,realpathSync,lstatSync,existsSync} from "node:fs";
import {dirname,join,resolve,relative,sep,isAbsolute} from "node:path";
import type {WorkflowStore} from "../core/store.js";
import type {AutopilotLedger} from "./ledger.js";
import {automationScope} from "./ledger.js";
import {git,requireCleanGit,type GitHost} from "./git.js";

export type WorktreeStage="prepared"|"reserved"|"created";
export interface WorktreePlan {
  id:string;workflowId:string;taskId:string;repoRoot:string;path:string;
  branch:string;baseSha:string;revision:number;expiresAt:number;
  stage:WorktreeStage;
}
interface PlanRow extends WorktreePlan {scope:string}
interface ProvisionOptions {
  path:string;dataDirectory:string;host:GitHost;
  workflows:WorkflowStore;ledger:AutopilotLedger;
}
const PLAN_TTL=10*60*1000;
const FIELDS="id,scope,workflow_id AS workflowId,task_id AS taskId,"+
  "repo_root AS repoRoot,path,branch,base_sha AS baseSha,revision,"+
  "expires_at AS expiresAt,stage";

function safeId(value:string):boolean{return /^[a-z][a-z0-9-]{0,63}$/.test(value);}
function managedPath(dataRoot:string,scope:string,workflowId:string,taskId:string){
  if(!safeId(workflowId)||!safeId(taskId))throw new Error("Invalid Workflow/Task ID");
  const hash=createHash("sha256").update(scope).digest("hex").slice(0,16);
  const root=realpathSync(dataRoot);
  const location=resolve(root,"managed-worktrees",hash,workflowId,taskId);
  const rel=relative(root,location);
  if(!rel||rel.startsWith("..")||rel.startsWith(sep))
    throw new Error("Managed Worktree escaped the plugin-owned directory");
  return {location,branch:"mm/"+hash+"/"+workflowId+"/"+taskId,root};
}
function noSymlinkParents(path:string,root:string):void{
  const relativePath=relative(root,dirname(path));
  let current=root;
  for(const segment of relativePath.split(sep).filter(Boolean)){
    current=join(current,segment);
    if(!existsSync(current))continue;
    const info=lstatSync(current);
    if(info.isSymbolicLink()||!info.isDirectory())
      throw new Error("Unsafe plugin-owned Worktree parent path");
  }
}
function parseWorktreeList(raw:string):Array<{path:string;branch:string;head:string}>{
  return raw.split("\0\0").flatMap(record=>{
    if(!record)return [];
    const value:{path:string;branch:string;head:string}={path:"",branch:"",head:""};
    for(const field of record.split("\0")){
      if(field.startsWith("worktree "))value.path=field.slice(9);
      else if(field.startsWith("branch "))value.branch=field.slice(7);
      else if(field.startsWith("HEAD "))value.head=field.slice(5);
    }
    return value.path?[value]:[];
  });
}
export class ManagedWorktreeProvisioner {
  private readonly db:DatabaseSync;
  constructor(private readonly options:ProvisionOptions){
    mkdirSync(dirname(options.path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(options.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS worktree_plans(
        id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflow_id TEXT NOT NULL,
        task_id TEXT NOT NULL,repo_root TEXT NOT NULL,path TEXT NOT NULL,
        branch TEXT NOT NULL,base_sha TEXT NOT NULL,revision INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,stage TEXT NOT NULL,
        UNIQUE(scope,workflow_id,task_id));`);
  }
  close():void{this.db.close();}
  /** Restore the exact persisted plan after browser/server restart. Read-only. */
  find(projectId:string,orchestraWorkspaceId:string,workflowId:string,taskId:string):WorktreePlan|null{
    if(!safeId(workflowId)||!safeId(taskId))throw new Error("Invalid Workflow/Task ID");
    const row=this.db.prepare("SELECT "+FIELDS+
      " FROM worktree_plans WHERE scope=? AND workflow_id=? AND task_id=?")
      .get(automationScope(projectId,orchestraWorkspaceId),workflowId,taskId) as PlanRow|undefined;
    return row??null;
  }
  private load(id:string):PlanRow {
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error("Invalid Worktree plan identity");
    const row=this.db.prepare("SELECT "+FIELDS+" FROM worktree_plans WHERE id=?")
      .get(id) as PlanRow|undefined;
    if(!row)throw new Error("Unknown Worktree provisioning plan");
    return row;
  }
  private validateTask(projectId:string,orchestraWorkspaceId:string,
    workflowId:string,taskId:string){
    if(this.options.ledger.get(projectId,orchestraWorkspaceId,workflowId)?.enabled)
      throw new Error("Pause Autopilot before modifying Git Worktrees");
    const workflow=this.options.workflows.get(projectId,orchestraWorkspaceId,workflowId);
    const config=this.options.ledger.get(projectId,orchestraWorkspaceId,workflowId)?.config;
    const isFinal=taskId==="mm-final-integration"&&
      config?.managedWorktrees===true&&config.finalization?.workspaceId==="auto"&&
      !Object.hasOwn(workflow.tasks,taskId);
    if(isFinal){
      if(Object.values(workflow.tasks).some(t=>t.attempts!==0))
        throw new Error("Final Worktree must be provisioned before any Task starts");
    }else{
      const task=workflow.tasks[taskId];
      if(!task||task.spec.kind!=="implementation"||task.attempts!==0||
        !["ready","blocked"].includes(task.status))
        throw new Error("Only unstarted implementation Tasks may receive managed Worktrees");
      if(config?.workspaces[taskId])
        throw new Error("Task already has a configured PI WEB Workspace ID");
    }
    return workflow;
  }
  async preview(projectId:string,orchestraWorkspaceId:string,
    workflowId:string,taskId:string,repoRoot:string):Promise<WorktreePlan>{
    const workflow=this.validateTask(projectId,orchestraWorkspaceId,workflowId,taskId);
    if(!repoRoot||!isAbsolute(repoRoot))throw new Error("Expected host-resolved absolute project path");
    const cleanSha=await requireCleanGit(this.options.host,repoRoot);
    const scope=automationScope(projectId,orchestraWorkspaceId);
    const target=managedPath(this.options.dataDirectory,scope,workflowId,taskId);
    noSymlinkParents(target.location,target.root);
    if(existsSync(target.location))
      throw new Error("Managed Worktree path already exists; reconcile the previous creation");
    const ref=await git(this.options.host,repoRoot,
      ["show-ref","--verify","--quiet","refs/heads/"+target.branch]);
    if(ref.exitCode!==1)
      throw new Error(ref.exitCode===0?"Managed Git branch already exists":
        "Unable to prove the planned Git branch is free");
    const old=this.db.prepare("SELECT "+FIELDS+
      " FROM worktree_plans WHERE scope=? AND workflow_id=? AND task_id=?")
      .get(scope,workflowId,taskId) as PlanRow|undefined;
    if(old?.stage==="reserved"||old?.stage==="created")
      throw new Error("A Worktree creation is already reserved; inspect it rather than retry");
    const plan:WorktreePlan={
      id:randomUUID(),workflowId,taskId,repoRoot,
      path:target.location,branch:target.branch,baseSha:cleanSha,
      revision:workflow.revision,expiresAt:Date.now()+PLAN_TTL,stage:"prepared",
    };
    this.db.prepare(`INSERT INTO worktree_plans(
      id,scope,workflow_id,task_id,repo_root,path,branch,base_sha,revision,expires_at,stage)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(scope,workflow_id,task_id)
      DO UPDATE SET id=excluded.id,repo_root=excluded.repo_root,path=excluded.path,
      branch=excluded.branch,base_sha=excluded.base_sha,revision=excluded.revision,
      expires_at=excluded.expires_at,stage='prepared'
      WHERE stage='prepared'`)
      .run(plan.id,scope,workflowId,taskId,repoRoot,target.location,
        target.branch,cleanSha,workflow.revision,plan.expiresAt,plan.stage);
    return plan;
  }
  private async inspectExact(plan:PlanRow):Promise<boolean>{
    const list=await git(this.options.host,plan.repoRoot,["worktree","list","--porcelain","-z"]);
    if(list.exitCode!==0)throw new Error("Could not inspect Git Worktree registry");
    const candidate=parseWorktreeList(list.stdout).find(w=>resolve(w.path)===resolve(plan.path));
    if(!candidate)return false;
    if(!existsSync(plan.path))return false;
    const info=lstatSync(plan.path);
    if(info.isSymbolicLink()||!info.isDirectory()||
      resolve(realpathSync(plan.path))!==resolve(plan.path))
      throw new Error("Managed Worktree checkout path is not a real owned directory");
    if(candidate.branch!=="refs/heads/"+plan.branch||candidate.head!==plan.baseSha)
      throw new Error("Managed Worktree was altered from the reserved commit/branch");
    const actual=await requireCleanGit(this.options.host,plan.path);
    if(actual!==plan.baseSha)
      throw new Error("Managed Worktree HEAD moved before PI WEB linking");
    return true;
  }
  async inspect(projectId:string,orchestraWorkspaceId:string,id:string):Promise<WorktreePlan>{
    const row=this.load(id);
    if(row.scope!==automationScope(projectId,orchestraWorkspaceId))
      throw new Error("Worktree plan belongs to another Orchestra");
    if(row.stage==="prepared")return row;
    const created=await this.inspectExact(row);
    if(!created)throw new Error("Git Worktree absent; reserved creation is uncertain and cannot be retried");
    this.db.prepare("UPDATE worktree_plans SET stage='created' WHERE id=?").run(id);
    return {...row,stage:"created"};
  }
  async create(projectId:string,orchestraWorkspaceId:string,id:string,
    currentProjectRoot?:string):Promise<WorktreePlan>{
    const row=this.load(id);
    if(row.scope!==automationScope(projectId,orchestraWorkspaceId))
      throw new Error("Worktree plan belongs to another Orchestra");
    if(currentProjectRoot&&resolve(currentProjectRoot)!==resolve(row.repoRoot))
      throw new Error("Registered project path changed since Worktree preview");
    if(row.stage!=="prepared")return this.inspect(projectId,orchestraWorkspaceId,id);
    if(Date.now()>row.expiresAt)throw new Error("Worktree preview expired");
    const workflow=this.validateTask(projectId,orchestraWorkspaceId,row.workflowId,row.taskId);
    if(workflow.revision!==row.revision)
      throw new Error("Workflow changed; create a new Worktree preview");
    const target=managedPath(this.options.dataDirectory,row.scope,row.workflowId,row.taskId);
    if(target.location!==row.path||target.branch!==row.branch)
      throw new Error("Provisioning target path/branch tampered");
    noSymlinkParents(target.location,target.root);
    const head=await requireCleanGit(this.options.host,row.repoRoot);
    if(head!==row.baseSha)throw new Error("Project HEAD changed since Worktree preview");
    if(existsSync(row.path))throw new Error("Target Worktree path already exists");
    const ref=await git(this.options.host,row.repoRoot,
      ["show-ref","--verify","--quiet","refs/heads/"+row.branch]);
    if(ref.exitCode!==1)throw new Error("Managed branch unexpectedly exists or cannot be inspected");
    // Persist reservation BEFORE the non-atomic native Git action. Never
    // repeat git worktree add after uncertain completion or a restart.
    const reserved=this.db.prepare("UPDATE worktree_plans SET stage='reserved'"+
      " WHERE id=? AND stage='prepared'").run(id);
    if(reserved.changes!==1)throw new Error("Concurrent provisioning reservation; inspect state");
    mkdirSync(dirname(row.path),{recursive:true,mode:0o700});
    const result=await git(this.options.host,row.repoRoot,
      ["worktree","add","--no-track","-b",row.branch,row.path,row.baseSha],60000);
    if(result.exitCode!==0)
      throw new Error("Git Worktree add was not confirmed; inspect reserved plan, do not retry: "+
        result.stderr.slice(-230));
    return this.inspect(projectId,orchestraWorkspaceId,id);
  }
  /** Opt-in automatic provisioning. Reserved mutations are only inspected,
   * never replayed, including after a host restart or lost Git response. */
  async ensure(projectId:string,orchestraWorkspaceId:string,workflowId:string,
    taskId:string,repoRoot:string):Promise<WorktreePlan>{
    const existing=this.find(projectId,orchestraWorkspaceId,workflowId,taskId);
    if(existing?.stage==="reserved"||existing?.stage==="created")
      return this.inspect(projectId,orchestraWorkspaceId,existing.id);
    const revision=this.options.workflows.get(projectId,orchestraWorkspaceId,workflowId).revision;
    const prepared=existing?.stage==="prepared"&&existing.revision===revision&&
      existing.expiresAt>Date.now()?existing:
      await this.preview(projectId,orchestraWorkspaceId,workflowId,taskId,repoRoot);
    return this.create(projectId,orchestraWorkspaceId,prepared.id,repoRoot);
  }
}
