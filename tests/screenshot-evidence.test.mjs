import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readdirSync,
  symlinkSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkflowStore} from "../dist/core/store.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {ScreenshotEvidence} from "../dist/automation/screenshots.js";
import {buildJournal} from "../dist/automation/journal.js";

const PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3vVbcAAAAASUVORK5CYII=","base64");
function git(cwd,...args){
  return execFileSync("git",["-C",cwd,...args],{encoding:"utf8",timeout:10000}).trim();
}
function commit(cwd,...args){
  git(cwd,"add",...args);
  git(cwd,"-c","user.name=Test","-c","user.email=test@example.invalid",
    "commit","-m","Test screenshot");
}
function fixture(){
  const base=mkdtempSync(join(tmpdir(),"mm-real-screenshot-"));
  const main=join(base,"project"),linked=join(base,"qc-worktree"),data=join(base,"private");
  mkdirSync(main,{recursive:true});mkdirSync(data,{recursive:true});
  execFileSync("git",["init","-b","main",main],{encoding:"utf8"});
  writeFileSync(join(main,"README.md"),"Private example");
  commit(main,"README.md");
  git(main,"worktree","add","-b","review",linked);
  mkdirSync(join(linked,"screenshots"),{recursive:true});
  writeFileSync(join(linked,"screenshots","qc.png"),PNG);
  commit(linked,"screenshots/qc.png");
  const sha=git(linked,"rev-parse","HEAD");
  const workflows=new WorkflowStore(join(data,"wf.sqlite"));
  const agents=new AgentRegistry(join(data,"agents.sqlite"));
  const ledger=new AutopilotLedger(join(data,"ledger.sqlite"));
  let wf=workflows.create("project","orchestra",{
    id:"feature",title:"Test screenshots",maxQcRounds:2,
    maxParallelByRole:{implementer:1,reviewer:1,architect:1,planner:1},
    tasks:[{id:"ui",title:"Implement UI",kind:"implementation",role:"implementer",
      dependsOn:[],description:"Document a UI result",
      acceptanceCriteria:["Screenshot exists"]}],
  });
  wf=workflows.act("project","orchestra","feature",wf.revision,"start",
    {type:"start",taskId:"ui"});
  wf=workflows.act("project","orchestra","feature",wf.revision,"finished",
    {type:"implementation_finished",taskId:"ui",headSha:sha,
      criteriaRevision:0,testsPassed:true});
  wf=workflows.act("project","orchestra","feature",wf.revision,"qc",
    {type:"qc_finalized",taskId:"ui",runId:"qc-ui-1",headSha:sha,
      criteriaRevision:0,attempt:1,verdict:"pass"});
  const reservation={projectId:"project",orchestraWorkspaceId:"orchestra",
    workspaceId:"qc-linked",workflowId:"feature",taskId:"ui",runId:"qc-ui-1",
    seat:"qc",requestId:"auto:qc1"};
  agents.reserve(reservation);
  const binding=agents.assign(reservation,"session-qc");
  agents.record(binding,{kind:"agent_settled",text:"Agent settled",
    at:Date.now(),sequence:1});
  const evidence=ledger.sealEvidence(binding,"qc","Pass "+sha);
  agents.seal("project","orchestra","session-qc",evidence.ref);
  const host={lifetimeSignal:new AbortController().signal,
    async execFile(command){
      try{
        const stdout=execFileSync(command.file,[...(command.args??[])],{
          encoding:"utf8",cwd:command.cwd,timeout:10000,
          env:{...process.env},maxBuffer:1024*1024});
        return {stdout,stderr:"",exitCode:0,signal:null,
          stdoutTruncated:false,stderrTruncated:false};
      }catch(error){
        return {stdout:String(error.stdout??""),stderr:String(error.stderr??""),
          exitCode:error.status??null,signal:error.signal??null,
          stdoutTruncated:false,stderrTruncated:false};
      }
    }};
  const opts={path:join(data,"screenshot-evidence.sqlite"),dataDirectory:data,
    workflows,agents,ledger,host,
    workspaces:()=>({version:1,async resolve({projectId,workspaceId}){
      if(projectId!=="project"||workspaceId!=="qc-linked")throw Error("Other workspace");
      return {project:{id:"project",name:"Test",path:main},
        workspace:{id:"qc-linked",projectId:"project",label:"QC",path:linked,isMain:false,
          provider:{metadata:{isGitWorktree:true}}}};
    }})};
  let screenshots=new ScreenshotEvidence(opts);
  const capture=(path="screenshots/qc.png")=>
    screenshots.capture("project","orchestra","feature","qc-ui-1",path);
  return {base,main,linked,data,sha,workflows,agents,ledger,opts,
    get screenshots(){return screenshots;},set screenshots(v){screenshots=v;},
    capture,close(){screenshots.close();ledger.close();agents.close();workflows.close();
      rmSync(base,{recursive:true,force:true});}};
}
test("Real Git SHA-backed screenshot becomes immutable private bytes with a scoped Journal reference",async()=>{
  const x=fixture();
  try{
    const saved=await x.capture();
    assert.equal(saved.mime,"image/png");
    assert.equal(saved.sourceSha,x.sha);
    assert.equal(saved.bytes,PNG.length);
    assert.equal(saved.sha256,createHash("sha256").update(PNG).digest("hex"));
    assert.equal((await x.capture()).id,saved.id,"Exact capture must be idempotent");
    const read=x.screenshots.preview("project","orchestra","feature",saved.id);
    assert.equal(read.artifact.id,saved.id);
    assert.equal(read.dataUrl,"data:image/png;base64,"+PNG.toString("base64"));
    assert.deepEqual(x.screenshots.list("project","orchestra","feature").map(r=>r.id),
      [saved.id]);
    const journal=buildJournal(x.workflows.get("project","orchestra","feature"),
      x.agents.list("project","orchestra","all"),x.ledger,
      x.screenshots.list("project","orchestra","feature"));
    assert.equal(journal.screenshots.length,1);
    assert.equal(journal.screenshots[0].runId,"qc-ui-1");
    assert.ok(!JSON.stringify(journal).includes(PNG.toString("base64")),
      "Journal metadata must not eagerly include sensitive screenshot bytes");
    assert.throws(()=>x.screenshots.preview("other","orchestra","feature",saved.id),
      /does not belong/);
    assert.throws(()=>x.screenshots.preview("project","orchestra","another",saved.id),
      /does not belong/);
    x.screenshots.close();
    x.screenshots=new ScreenshotEvidence(x.opts);
    assert.equal(x.screenshots.preview("project","orchestra","feature",saved.id).artifact.id,
      saved.id,"Actual immutable bytes persist across plugin restarts");
  }finally{x.close();}
});
test("Image capture rejects parent traversal and non-image bytes",async()=>{
  const x=fixture();
  try{
    for(const path of ["../README.md","screenshots/../../README.md",
      "screenshots/not-an-image.svg","/tmp/a.png","screenshots/a%2fb.png"])
      await assert.rejects(x.capture(path),/Screenshots must/);
    writeFileSync(join(x.linked,"screenshots","fake.png"),"not an image");
    commit(x.linked,"screenshots/fake.png");
    await assert.rejects(x.capture("screenshots/fake.png"),
      /HEAD differs/,"New commit after QC invalidates any screenshot capture");
  }finally{x.close();}
});
test("Capture requires a clean exact Git snapshot and refuses symlinked screenshot",async()=>{
  const x=fixture();
  try{
    writeFileSync(join(x.linked,"screenshots","dirty.png"),PNG);
    await assert.rejects(x.capture(),/uncommitted/);
    rmSync(join(x.linked,"screenshots","dirty.png"));
    symlinkSync(join(x.main,"README.md"),join(x.linked,"screenshots","linked.png"));
    await assert.rejects(x.capture("screenshots/linked.png"),/uncommitted/);
    rmSync(join(x.linked,"screenshots","linked.png"));
    const first=await x.capture();
    const entries=readdirSync(join(x.data,"screenshot-objects"),{withFileTypes:true});
    const objectDir=join(x.data,"screenshot-objects",entries[0].name);
    const object=join(objectDir,first.sha256+".png");
    writeFileSync(object,Buffer.alloc(PNG.length,3));
    assert.throws(()=>x.screenshots.preview("project","orchestra","feature",first.id),
      /no longer match/);
  }finally{x.close();}
});
test("Ignored but visually valid PNG is refused unless it is in the exact QC commit",async()=>{
  const x=fixture();
  try{
    const ignoreFile=join(x.base,"git-exclusions");
    writeFileSync(ignoreFile,"screenshots/ignored.png\n");
    git(x.linked,"config","core.excludesFile",ignoreFile);
    writeFileSync(join(x.linked,"screenshots","ignored.png"),PNG);
    assert.equal(git(x.linked,"status","--porcelain"),"",
      "Ignored screenshot does not appear in Git porcelain state");
    await assert.rejects(x.capture("screenshots/ignored.png"),
      /absent from the QC-reviewed Git commit/);
  }finally{x.close();}
});
test("Invalid or missing Run evidence can never be used to capture arbitrary files",async()=>{
  const x=fixture();
  try{
    await assert.rejects(x.screenshots.capture("project","orchestra","feature",
      "qc-ui-missing","screenshots/qc.png"),/sealed automatic QC/);
    await assert.rejects(x.screenshots.capture("project","orchestra","another",
      "qc-ui-1","screenshots/qc.png"),/Workflow/);
    assert.equal(x.screenshots.list("project","orchestra","feature").length,0);
  }finally{x.close();}
});