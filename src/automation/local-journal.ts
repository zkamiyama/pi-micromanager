/** One local Journal, Git-owned ADRs. Links do not create commits or publish. */
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {join} from "node:path";
import type {PiWebHostWorkspacesV1} from "@jmfederico/pi-web/server-plugin-api";
import type {WorkflowStore} from "../core/store.js";
import type {AgentBinding,AgentRegistry} from "../runtime/registry.js";
import {isDurableSession} from "../runtime/durable-runner.js";
import type {AutopilotLedger} from "./ledger.js";
import {automationScope} from "./ledger.js";
import {LOCAL_IMAGE_MAX_BASE64} from "./local-image.js";
import {LocalArtifacts,localImageMime,type ArtifactPolicy,type LocalArtifact} from "./local-artifacts.js";
import {gitValue,requireCleanGit,type GitHost} from "./git.js";

interface Options {
  dataDirectory:string;workflows:WorkflowStore;agents:AgentRegistry;ledger:AutopilotLedger;
  host:GitHost;policy:ArtifactPolicy;workspaces():PiWebHostWorkspacesV1|undefined;
  externallyPinned(p:string,o:string,w:string):boolean;
  retirementPending?(p:string,o:string,w:string):boolean;
}
export interface AdrLink {id:string;workflowId:string;workspaceId:string;path:string;commit:string;title:string;repository:string|null;url:string|null}
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
export class LocalJournal {
  readonly artifacts:LocalArtifacts;private readonly db:DatabaseSync;
  constructor(private readonly opt:Options){
    this.artifacts=new LocalArtifacts({directory:join(opt.dataDirectory,"local-journal"),policy:opt.policy,
      signal:opt.host.lifetimeSignal,protected:(p,o,w)=>this.protected(p,o,w)||opt.retirementPending?.(p,o,w)===true});
    this.db=new DatabaseSync(join(opt.dataDirectory,"local-doc-links.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS adr_links(id TEXT PRIMARY KEY,scope TEXT NOT NULL,workflowId TEXT NOT NULL,
        workspaceId TEXT NOT NULL,path TEXT NOT NULL,commitSha TEXT NOT NULL,title TEXT NOT NULL,repository TEXT,url TEXT);`);
  }
  close():void{this.artifacts.close();this.db.close();}
  protected(p:string,o:string,w:string):boolean{
    try{
      if(this.artifacts.hasPins(p,o,w)||this.opt.externallyPinned(p,o,w)||this.opt.agents.hasUnsealedWorkflow(p,o,w)||this.opt.ledger.get(p,o,w)?.enabled)return true;
      const wf=this.opt.workflows.get(p,o,w);
      return Object.values(wf.tasks).some(t=>!["integrated","done"].includes(t.status))||wf.amendments.some(a=>!["completed","cancelled"].includes(a.status));
    }catch{return true;}
  }
  private source(p:string,o:string,w:string,runId:string){
    const wf=this.opt.workflows.get(p,o,w),b=this.opt.agents.getRun(p,o,w,runId);
    if(!b||b.phase!=="sealed"||!b.sessionId||!isDurableSession(b.sessionId)||!b.evidenceRef)
      throw new Error("Local artifacts require a sealed owned Durable Run");
    const receipt=this.opt.ledger.evidence(b);
    if(!receipt||receipt.ref!==b.evidenceRef||receipt.sessionId!==b.sessionId)throw new Error("Artifact source evidence mismatch");
    const launch=this.opt.ledger.findLaunch(b),transition=this.opt.ledger.preparedTransition(b);
    const action=transition?.action;
    const sourceSha=launch?.headSha??(action&&"headSha" in action?action.headSha:undefined)??wf.tasks[b.taskId]?.lastQc?.headSha;
    if(typeof sourceSha!=="string"||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha))throw new Error("Run source Git SHA unavailable; retain original state");
    return {wf,b,receipt,sourceSha};
  }
  archiveRun(binding:AgentBinding):LocalArtifact{
    const {projectId:p,orchestraWorkspaceId:o,workflowId:w,runId}=binding;
    const source=this.source(p,o,w,runId);
    const prior=this.artifacts.find(p,o,w,"run:"+runId);
    if(prior){
      if(prior.kind!=="run-log"||prior.runId!==runId||prior.sourceSha!==source.sourceSha||
        prior.provenance!=="public-run-projection")throw new Error("Original Run archive authority changed");
      if(prior.state==="ready"){
        const content=this.artifacts.read(p,o,prior.id).text;
        const first=JSON.parse(content!.split("\n",1)[0]!);
        if(first.runId!==runId||first.sourceSha!==source.sourceSha||first.evidenceRef!==source.receipt.ref)
          throw new Error("Original archive does not prove this sealed Run");
      }else if(prior.state!=="removed")throw new Error("Original archive is uncertain; no rewrite");
      // Expired detail remains expired. The separate retirement receipt, not
      // an absent archive, determines whether original Run data can be removed.
      return prior;
    }
    const metadata={schemaVersion:1,provenance:"public-run-projection",runId,taskId:source.b.taskId,seat:source.b.seat,
      sourceSha:source.sourceSha,evidenceRef:source.receipt.ref,summary:source.receipt.text.slice(0,4000)};
    const events=this.opt.agents.activities(p,o,source.b.sessionId!).map(e=>({kind:e.kind,at:e.at,text:e.text.slice(0,512)})).reverse();
    const content=Buffer.from([metadata,...events].map(e=>JSON.stringify(e)).join("\n")+"\n");
    return this.artifacts.put(p,o,{key:"run:"+runId,workflowId:w,runId,kind:"run-log",sourceSha:source.sourceSha,
      mime:"application/x-ndjson",label:"Public activity · "+runId},content);
  }
  importImage(p:string,o:string,input:{workflowId:string;runId:string;sourceSha:string;requestId:string;label:string;base64:string}):LocalArtifact{
    const source=this.source(p,o,input.workflowId,input.runId);
    if(source.b.seat!=="qc"||source.wf.tasks[source.b.taskId]?.lastQc?.runId!==input.runId||input.sourceSha!==source.sourceSha)
      throw new Error("Local image must reference the current exact QC source");
    if(typeof input.base64!=="string"||input.base64.length>LOCAL_IMAGE_MAX_BASE64||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64))
      throw new Error("Invalid bounded base64 image");
    const bytes=Buffer.from(input.base64,"base64"),mime=localImageMime(bytes);
    return this.artifacts.put(p,o,{key:"image:"+input.requestId,workflowId:input.workflowId,runId:input.runId,
      sourceSha:source.sourceSha,kind:"image",mime,label:input.label},bytes);
  }
  links(p:string,o:string,w:string):AdrLink[]{
    return this.db.prepare("SELECT id,workflowId,workspaceId,path,commitSha AS [commit],title,repository,url FROM adr_links WHERE scope=? AND workflowId=? ORDER BY rowid DESC LIMIT 64")
      .all(automationScope(p,o),w) as unknown as AdrLink[];
  }
  async link(p:string,o:string,input:{workflowId:string;workspaceId:string;path:string}):Promise<AdrLink>{
    const wf=this.opt.workflows.get(p,o,input.workflowId);
    if(typeof input.path!=="string"||!/^docs\/adr\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}\.md$/.test(input.path))
      throw new Error("ADR reference must be a tracked docs/adr Markdown file");
    const api=this.opt.workspaces();if(!api)throw new Error("Workspace authority unavailable");
    const a=await api.resolve({projectId:p,workspaceId:input.workspaceId});
    if(a.project.id!==p||a.workspace.id!==input.workspaceId||a.workspace.projectId!==p)throw new Error("ADR Workspace belongs to another project");
    const root=a.workspace.path;
    this.opt.agents.registerWorkspacePath(p,a.workspace.id,root);const owner="adr-link:"+sha(JSON.stringify([p,o,input]));
    this.opt.agents.acquireWorkspaceOperation(p,a.workspace.id,owner);
    try{
      const commit=await requireCleanGit(this.opt.host,root);
      const tree=await gitValue(this.opt.host,root,["ls-tree",commit,"--",input.path]);
      if(!/^100(?:644|755) blob [a-f0-9]+\t/.test(tree))throw new Error("ADR must be a regular tracked file, not an alias");
      const content=await gitValue(this.opt.host,root,["show",commit+":"+input.path]);
      if(Buffer.byteLength(content)>30000||!content.trim())throw new Error("ADR reference is empty or oversized");
      if(await requireCleanGit(this.opt.host,root)!==commit)throw new Error("ADR source changed during link verification");
      const remote=await gitValue(this.opt.host,root,["remote","get-url","origin"]).catch(()=>"");
      const match=remote.match(/^https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/);
      const repository=match?.[1]??null;
      const title=(content.split(/\r?\n/).find(s=>s.startsWith("# "))?.slice(2)||input.path).slice(0,180);
      this.opt.host.lifetimeSignal.throwIfAborted();
      if(this.opt.workflows.get(p,o,input.workflowId).revision!==wf.revision)throw new Error("Workflow changed during ADR reference inspection");
      const id=sha(JSON.stringify([p,o,input.workflowId,input.workspaceId,input.path,commit]));
      const count=this.db.prepare("SELECT count(*) AS n FROM adr_links WHERE scope=? AND workflowId=?").get(automationScope(p,o),input.workflowId) as {n:number};
      if(count.n>=64&&!this.db.prepare("SELECT 1 FROM adr_links WHERE id=?").get(id))throw new Error("ADR link limit reached");
      const url=repository?"https://github.com/"+repository+"/blob/"+commit+"/"+input.path:null;
      this.db.prepare("INSERT OR IGNORE INTO adr_links(id,scope,workflowId,workspaceId,path,commitSha,title,repository,url) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id,automationScope(p,o),input.workflowId,input.workspaceId,input.path,commit,title,repository,url);
      return {id,workflowId:input.workflowId,workspaceId:input.workspaceId,path:input.path,commit,title,repository,url};
    }finally{this.opt.agents.releaseWorkspaceOperation(p,a.workspace.id,owner);}
  }
}
