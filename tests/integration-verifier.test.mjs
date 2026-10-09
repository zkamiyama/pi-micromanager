import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkflowStore} from "../dist/core/store.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {IntegrationVerifier} from "../dist/automation/integration.js";

const SHA="a".repeat(40),HEAD="b".repeat(40);
const definition={id:"flow",title:"Implement API",maxQcRounds:3,
  maxParallelByRole:{implementer:2,reviewer:2,architect:1,planner:1},
  tasks:[{id:"api",title:"API",kind:"implementation",role:"implementer",
    dependsOn:[]},{id:"consumer",title:"Consumer",kind:"implementation",
    role:"implementer",dependsOn:[{taskId:"api",gate:"integrated"}]}]};
const models=Object.fromEntries(["implementer","qc","architect","planner"].map(role=>
  [role,{provider:"mock-provider",model:"mock-model"}]));
const config={models,workspaces:{api:"wt-source",consumer:"wt-consumer"},
  test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:2};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"mm-integrate-"));
  const workflows=new WorkflowStore(join(dir,"workflow.sqlite"));
  const agents=new AgentRegistry(join(dir,"agents.sqlite"));
  const ledger=new AutopilotLedger(join(dir,"autopilot.sqlite"));
  const wf=workflows.create("p","o",definition);
  let current=workflows.act("p","o","flow",wf.revision,"start",{
    type:"start",taskId:"api"});
  current=workflows.act("p","o","flow",current.revision,"finish",{
    type:"implementation_finished",taskId:"api",headSha:SHA,
    criteriaRevision:0,testsPassed:true});
  current=workflows.act("p","o","flow",current.revision,"qc",{
    type:"qc_finalized",taskId:"api",runId:"qc-api-1",headSha:SHA,
    criteriaRevision:0,attempt:1,verdict:"pass"});
  const reservation={projectId:"p",orchestraWorkspaceId:"o",workspaceId:"wt-source",
    workflowId:"flow",taskId:"api",runId:"qc-api-1",
    seat:"qc",requestId:"auto:review-1"};
  agents.reserve(reservation);agents.assign(reservation,"session-qc-1");
  const binding=agents.get("p","o","session-qc-1");
  agents.record(binding,{kind:"agent_settled",text:"Agent settled",
    at:Date.now(),sequence:1});
  const evidence=ledger.sealEvidence(binding,"qc","PASS at "+SHA);
  agents.seal("p","o","session-qc-1",evidence.ref);
  ledger.save("p","o","flow",config);
  let targetHead=HEAD,dirty=false,isAncestor=true;
  const calls=[];
  const host={lifetimeSignal:new AbortController().signal,
    async execFile(req){
      calls.push({file:req.file,args:req.args});
      if(req.file!=="git")throw Error("Git only");
      const args=req.args.slice(2);
      const operation=args.join(" ");
      let stdout="",exitCode=0,stderr="";
      if(operation==="rev-parse --show-toplevel")stdout="/git/integration\n";
      else if(operation==="rev-parse HEAD")stdout=targetHead+"\n";
      else if(operation==="status --porcelain")stdout=dirty?"?? untracked.txt\n":"";
      else if(operation.startsWith("merge-base --is-ancestor")){
        exitCode=isAncestor?0:1;
      }else throw Error("Unexpected Git command "+operation);
      return {exitCode,signal:null,stdout,stderr,stdoutTruncated:false,stderrTruncated:false};
    }};
  const workspaces={version:1,async resolve({projectId,workspaceId}){
    if(projectId!=="p"||workspaceId!=="wt-integration")
      throw Error("Unknown target");
    return {project:{id:"p",name:"Mock",path:"/git"},
      workspace:{id:workspaceId,projectId:"p",path:"/git/integration",
        label:"integration",isMain:false,provider:{metadata:{isGitWorktree:true}}}};
  }};
  function open(){
    return new IntegrationVerifier({path:join(dir,"integration.sqlite"),host,
      workflows,agents,ledger,workspaces:()=>workspaces});
  }
  let service=open();
  const close=()=>{
    service.close();ledger.close();agents.close();workflows.close();
    rmSync(dir,{recursive:true,force:true});
  };
  return {workflows,agents,ledger,host,calls,evidence,open,
    get service(){return service;},set service(value){service=value;},
    setTargetHead(value){targetHead=value;},setDirty(value){dirty=value;},
    setAncestry(value){isAncestor=value;},close};
}
test("Integration proof is read-only, QC sealed, verified in target and CAS-backed",async()=>{
  const x=fixture();
  try{
    const preview=await x.service.preview("p","o","flow","api","wt-integration");
    assert.equal(preview.sourceSha,SHA);
    assert.equal(preview.targetHead,HEAD);
    assert.equal(x.workflows.get("p","o","flow").tasks.api.status,"passed");
    const updated=await x.service.confirm("p","o",preview.id);
    assert.equal(updated.tasks.api.status,"integrated");
    assert.equal(updated.tasks.consumer.status,"ready");
    const repeat=await x.service.confirm("p","o",preview.id);
    assert.equal(repeat.revision,updated.revision);
    assert.ok(x.calls.every(c=>c.file==="git"),"No shell commands");
    assert.ok(x.calls.every(c=>["rev-parse","status","merge-base"].includes(c.args[2])),
      "Never merge/cherry-pick/reset or push");
    assert.ok(x.calls.every(c=>c.args.includes("-C")&&c.args.includes("/git/integration")));
  }finally{x.close();}
});
test("Cannot call a source checkout 'integrated', or assert Git ancestry without proof",async()=>{
  const x=fixture();
  try{
    await assert.rejects(x.service.preview("p","o","flow","api","wt-source"),/not proof/);
    x.setAncestry(false);
    await assert.rejects(x.service.preview("p","o","flow","api","wt-integration"),
      /does not contain/);
    assert.equal(x.workflows.get("p","o","flow").tasks.api.status,"passed");
  }finally{x.close();}
});
test("Dirty or advanced target invalidates a preview; no DAG transition occurs",async()=>{
  const x=fixture();
  try{
    x.setDirty(true);
    await assert.rejects(x.service.preview("p","o","flow","api","wt-integration"),/uncommitted/);
    x.setDirty(false);
    const proof=await x.service.preview("p","o","flow","api","wt-integration");
    x.setTargetHead("c".repeat(40));
    await assert.rejects(x.service.confirm("p","o",proof.id),/moved since/);
    assert.equal(x.workflows.get("p","o","flow").tasks.api.status,"passed");
  }finally{x.close();}
});
test("Integration confirmation requires paused scheduler, not just an earlier snapshot",async()=>{
  const x=fixture();
  try{
    const proof=await x.service.preview("p","o","flow","api","wt-integration");
    x.ledger.setStatus("p","o","flow",true,"running");
    await assert.rejects(x.service.confirm("p","o",proof.id),/Pause Autopilot/);
    assert.equal(x.workflows.get("p","o","flow").tasks.api.status,"passed");
    x.ledger.setStatus("p","o","flow",false,"paused");
    await x.service.confirm("p","o",proof.id);
    assert.equal(x.workflows.get("p","o","flow").tasks.api.status,"integrated");
  }finally{x.close();}
});
test("Crash between authoritative integration commit and preview receipt recovers idempotently",async()=>{
  const x=fixture();
  try{
    const proof=await x.service.preview("p","o","flow","api","wt-integration");
    const current=x.workflows.get("p","o","flow");
    x.workflows.act("p","o","flow",current.revision,"integration:"+proof.id,
      {type:"integrate",taskId:"api"});
    x.service.close();
    x.service=x.open();
    const after=await x.service.confirm("p","o",proof.id);
    assert.equal(after.tasks.api.status,"integrated");
    assert.equal(after.revision,current.revision+1);
  }finally{x.close();}
});

test("Separate QC review workspace cannot disguise the writer's own checkout as integration",async()=>{
  const x=fixture();
  try{
    const current=x.ledger.get("p","o","flow");
    x.ledger.save("p","o","flow",{
      ...current.config,
      workspaces:{...current.config.workspaces,api:"wt-integration"},
      reviewWorkspaces:{api:"wt-source"},
    });
    await assert.rejects(x.service.preview("p","o","flow","api","wt-integration"),
      /Source implementation\/QC Worktree/);
    assert.equal(x.workflows.get("p","o","flow").tasks.api.status,"passed");
  }finally{x.close();}
});
