import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkflowStore} from "../dist/core/store.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {PermissionLedger} from "../dist/automation/permissions.js";
import {PublicationManager} from "../dist/automation/publication.js";
const SHA="a".repeat(40),BRANCH="feature/api";
const definition={id:"workflow",title:"Publish feature",maxQcRounds:3,
  maxParallelByRole:{planner:1,implementer:1,reviewer:1,architect:1},
  tasks:[{id:"api",title:"Feature API",kind:"implementation",role:"implementer",
    dependsOn:[],description:"Provide endpoint",
    acceptanceCriteria:["Contract passes"]}]};
const models=Object.fromEntries(["planner","implementer","qc","architect"]
  .map(role=>[role,{provider:"mock",model:"mock"}]));
const config={workspaces:{api:"wt-api"},
  publication:{remote:"origin",baseBranch:"main",draft:true},
  models,test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:2};
function fixture(policy){
  const dir=mkdtempSync(join(tmpdir(),"mm-pub-"));
  const wf=new WorkflowStore(join(dir,"wf.sqlite"));
  const agents=new AgentRegistry(join(dir,"runs.sqlite"));
  const ledger=new AutopilotLedger(join(dir,"ledger.sqlite"));
  let current=wf.create("p","o",{...definition,permissions:policy});
  current=wf.act("p","o","workflow",current.revision,"start",{type:"start",taskId:"api"});
  current=wf.act("p","o","workflow",current.revision,"done",{
    type:"implementation_finished",taskId:"api",headSha:SHA,criteriaRevision:0,
    testsPassed:true});
  current=wf.act("p","o","workflow",current.revision,"qc",{
    type:"qc_finalized",taskId:"api",runId:"qc-api-1",headSha:SHA,
    criteriaRevision:0,attempt:1,verdict:"pass"});
  const reservation={projectId:"p",orchestraWorkspaceId:"o",workspaceId:"wt-api",
    workflowId:"workflow",taskId:"api",runId:"qc-api-1",
    seat:"qc",requestId:"auto:qc-api"};
  agents.reserve(reservation);const b=agents.assign(reservation,"qc-session");
  agents.record(b,{kind:"agent_settled",text:"Agent settled",at:Date.now(),sequence:1});
  const evidence=ledger.sealEvidence(b,"qc","PASS at "+SHA);
  agents.seal("p","o","qc-session",evidence.ref);
  ledger.save("p","o","workflow",config);
  ledger.setStatus("p","o","workflow",true,"running");
  const approvals=new PermissionLedger(join(dir,"perms.sqlite"),wf,ledger);
  let remoteSha=null,pr=null,pushes=0,creates=0,pushUncertain=false,prUncertain=false;
  let headSha=SHA,worktreeDirty=false;
  let fetchUrl="https://github.com/acme/repo.git",pushUrl=fetchUrl;
  let pauseDuringPreflight=false,statusChecks=0;
  const commands=[];
  const output=(stdout="",exitCode=0)=>({stdout,exitCode,signal:null,
    stderr:"",stdoutTruncated:false,stderrTruncated:false});
  const host={lifetimeSignal:new AbortController().signal,async execFile(req){
    commands.push({file:req.file,args:[...(req.args??[])],cwd:req.cwd,
      unsetEnv:req.unsetEnv});
    if(req.file==="git"){
      const args=req.args.slice(2).join(" ");
      if(args==="rev-parse --show-toplevel")return output("/repo/api\n");
      if(args==="rev-parse HEAD")return output(headSha+"\n");
      if(args==="status --porcelain"){
        statusChecks++;
        if(pauseDuringPreflight&&statusChecks>=2)
          ledger.setStatus("p","o","workflow",false,"Paused during Git preflight");
        return output(worktreeDirty?"?? dirty.txt\n":"");
      }
      if(args==="symbolic-ref --quiet --short HEAD")return output(BRANCH+"\n");
      if(args==="remote get-url origin")return output(fetchUrl+"\n");
      if(args==="remote get-url --push --all origin")return output(pushUrl+"\n");
      if(args==="ls-remote --heads "+pushUrl+" refs/heads/"+BRANCH)
        return output(remoteSha?remoteSha+"\trefs/heads/"+BRANCH+"\n":"");
      if(args==="push --porcelain "+pushUrl+" "+SHA+":refs/heads/"+BRANCH){
        pushes++;remoteSha=SHA;
        if(pushUncertain)throw new Error("Lost Git push response");
        return output("To github.com:acme/repo.git\n");
      }
      throw new Error("Unexpected Git request "+args);
    }
    if(req.file==="gh"){
      if(req.args.slice(0,2).join(" ")==="pr list")
        return output(JSON.stringify(pr?[pr]:[]));
      if(req.args.slice(0,2).join(" ")==="pr create"){
        creates++;
        pr={number:10,url:"https://github.com/acme/repo/pull/10",
          headRefName:BRANCH,baseRefName:"main",isDraft:true,
          state:"OPEN",headRefOid:SHA};
        if(prUncertain)throw new Error("Lost GitHub PR response");
        return output(pr.url);
      }
      throw new Error("Unexpected gh request "+req.args.join(" "));
    }
    throw new Error("Unexpected executable "+req.file);
  }};
  const workspace={version:1,async resolve({projectId,workspaceId}){
    if(projectId!=="p"||workspaceId!=="wt-api")throw new Error("Unknown Workspace");
    return {project:{id:"p",name:"Test",path:"/repo"},
      workspace:{id:"wt-api",projectId:"p",path:"/repo/api",isMain:false,
        label:"Worker",provider:{metadata:{isGitWorktree:true}}}};
  }};
  const options={path:join(dir,"published.sqlite"),host,workflows:wf,
    agents,ledger,permissions:approvals,workspaces:()=>workspace};
  let service=new PublicationManager(options);
  return {wf,agents,ledger,approvals,config,host,commands,options,
    get service(){return service;},replace(){service.close();service=new PublicationManager(options);},
    get pushes(){return pushes;},get creates(){return creates;},
    get remoteSha(){return remoteSha;},get pr(){return pr;},
    losePush(){pushUncertain=true;},clearPushLoss(){pushUncertain=false;},
    losePr(){prUncertain=true;},clearPrLoss(){prUncertain=false;},
    setRemote(value){remoteSha=value;},setHead(value){headSha=value;},
    setDirty(value){worktreeDirty=value;},
    setPushUrl(value){pushUrl=value;},setRepo(value){fetchUrl=value;pushUrl=value;},
    pauseDuringNextPreflight(){pauseDuringPreflight=true;statusChecks=0;},
    tick(){return service.step(ledger.get("p","o","workflow"),wf.get("p","o","workflow"));},
    close(){service.close();approvals.close();ledger.close();agents.close();wf.close();
      rmSync(dir,{recursive:true,force:true});}};
}
test("YOLO defaults to host Git push and a Draft GitHub PR after sealed QC",async()=>{
  const x=fixture(undefined);
  try{
    assert.equal(await x.tick(),"acted");
    assert.equal(x.pushes,1);
    assert.equal(x.remoteSha,SHA);
    assert.equal(x.creates,0);
    assert.equal(await x.tick(),"acted");
    assert.equal(x.creates,1);
    assert.equal(x.pr?.isDraft,true);
    assert.equal(await x.tick(),"none");
    assert.equal(x.service.list("p","o","workflow").length,2);
    assert.ok(x.service.list("p","o","workflow").every(r=>r.state==="completed"));
    assert.ok(x.commands.every(c=>c.file!=="bash"&&c.file!=="sh"));
    assert.ok(!x.commands.some(c=>c.args.includes("merge")||
      c.args.includes("delete")||c.args.includes("--force")));
    assert.equal(x.wf.get("p","o","workflow").tasks.api.status,"passed",
      "Draft PR creation does not silently merge or bypass DAG integration gates");
  }finally{x.close();}
});
test("Ask blocks each exact Git side effect until a durable human approval",async()=>{
  const x=fixture({actions:{"git.push":"ask","github.pr.create":"ask"}});
  try{
    assert.equal(await x.tick(),"waiting");
    assert.equal(await x.tick(),"waiting");
    assert.equal(x.pushes,0);
    let approval=x.approvals.list("p","o","workflow")[0];
    assert.equal(approval.action,"git.push");
    assert.equal(approval.state,"pending");
    x.approvals.decide("p","o",approval.id,"approved");
    assert.equal(await x.tick(),"acted");
    assert.equal(x.pushes,1);
    assert.equal(await x.tick(),"waiting");
    approval=x.approvals.list("p","o","workflow")[0];
    assert.equal(approval.action,"github.pr.create");
    assert.equal(x.creates,0);
    x.approvals.decide("p","o",approval.id,"approved");
    assert.equal(await x.tick(),"acted");
    assert.equal(x.creates,1);
  }finally{x.close();}
});
test("Deny suppresses publication without an approval prompt or remote mutation",async()=>{
  const x=fixture({actions:{"git.push":"deny"}});
  try{
    assert.equal(await x.tick(),"none");
    assert.equal(x.pushes,0);
    assert.equal(x.creates,0);
    assert.deepEqual(x.approvals.list("p","o","workflow"),[]);
  }finally{x.close();}
});
test("Lost push reply re-inspects exact remote SHA rather than duplicating the push",async()=>{
  const x=fixture(undefined);
  try{
    x.losePush();
    await assert.rejects(x.tick(),/Lost Git push response/);
    assert.equal(x.pushes,1);
    assert.equal(x.service.list("p","o","workflow")[0].state,"reserved");
    x.replace();x.clearPushLoss();
    assert.equal(await x.tick(),"acted");
    assert.equal(x.pushes,1,"A matching remote commit proves original push completion");
    assert.equal(await x.tick(),"acted");
    assert.equal(x.creates,1);
  }finally{x.close();}
});
test("Lost PR response is recovered from GitHub's exact Draft PR head, not repeated",async()=>{
  const x=fixture(undefined);
  try{
    await x.tick();
    x.losePr();
    await assert.rejects(x.tick(),/Lost GitHub PR response/);
    assert.equal(x.creates,1);
    x.replace();x.clearPrLoss();
    assert.equal(await x.tick(),"acted");
    assert.equal(x.creates,1);
    assert.equal(await x.tick(),"none");
  }finally{x.close();}
});
test("An uncertain push whose remote is still missing is never blindly retried",async()=>{
  const x=fixture(undefined);
  try{
    x.losePush();
    await assert.rejects(x.tick());
    x.replace();x.clearPushLoss();
    x.setRemote(null);
    await assert.rejects(x.tick(),/uncertain/);
    assert.equal(x.pushes,1);
  }finally{x.close();}
});
test("Publisher rejects dirty, stale or non QC-passed Git snapshots",async()=>{
  const x=fixture(undefined);
  try{
    x.setDirty(true);
    await assert.rejects(x.tick(),/uncommitted/);
    x.setDirty(false);
    x.setHead("b".repeat(40));
    await assert.rejects(x.tick(),/differs from QC-pass/);
    assert.equal(x.pushes,0);
  }finally{x.close();}
});

test("PR publication denied by Workflow policy does not call GitHub even after allowed Push",async()=>{
  const x=fixture({actions:{"github.pr.create":"deny"}});
  try{
    assert.equal(await x.tick(),"acted");
    assert.equal(x.pushes,1);
    assert.equal(await x.tick(),"none");
    assert.equal(x.creates,0);
    assert.equal(x.service.list("p","o","workflow").length,1);
  }finally{x.close();}
});
test("Remote divergence refuses non-force YOLO Push and never makes a PR",async()=>{
  const x=fixture(undefined);
  try{
    x.setRemote("d".repeat(40));
    await assert.rejects(x.tick(),/different commit/);
    assert.equal(x.pushes,0);
    assert.equal(x.creates,0);
    assert.equal(x.service.list("p","o","workflow").length,0);
  }finally{x.close();}
});
test("Paused Autopilot forbids any new external side effect",async()=>{
  const x=fixture(undefined);
  try{
    x.ledger.setStatus("p","o","workflow",false,"Operator paused");
    await assert.rejects(x.tick(),/paused/);
    assert.equal(x.pushes,0);
    assert.equal(x.creates,0);
    assert.equal(x.service.list("p","o","workflow").length,0);
  }finally{x.close();}
});

test("Audit F03: mismatched fetch and effective push URLs prevent network side effects",async()=>{
  const x=fixture(undefined);
  try{
    x.setPushUrl("https://github.com/other/repo.git");
    await assert.rejects(x.tick(),/fetch and push repositories differ/);
    assert.equal(x.pushes,0);
    assert.equal(x.creates,0);
  }finally{x.close();}
});
test("Audit F04: human approval is bound to actual GitHub repository and source branch",async()=>{
  const x=fixture({actions:{"git.push":"ask"}});
  try{
    assert.equal(await x.tick(),"waiting");
    const first=x.approvals.list("p","o","workflow")[0];
    assert.deepEqual(JSON.parse(first.target),{
      repository:"acme/repo",sourceBranch:BRANCH,
      pushUrl:"https://github.com/acme/repo.git",
    });
    x.approvals.decide("p","o",first.id,"approved");
    x.setRepo("https://github.com/other/repo.git");
    assert.equal(await x.tick(),"waiting");
    assert.equal(x.pushes,0);
    const current=x.approvals.list("p","o","workflow");
    assert.equal(current.length,2);
    assert.notEqual(current[0].id,first.id);
    assert.equal(JSON.parse(current[0].target).repository,"other/repo");
  }finally{x.close();}
});
test("Audit F07: pausing during async Git preflight fences a new push",async()=>{
  const x=fixture(undefined);
  try{
    x.pauseDuringNextPreflight();
    await assert.rejects(x.tick(),/paused or its destination changed/);
    assert.equal(x.pushes,0);
    assert.equal(x.ledger.get("p","o","workflow").enabled,false);
  }finally{x.close();}
});
