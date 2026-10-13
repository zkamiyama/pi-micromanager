import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {validatePermissions,permissionDecision} from "../dist/core/permissions.js";
import {parseDefinition,newWorkflow,applyAction} from "../dist/core/workflow.js";
import {internalRunId,internalCommandId} from "../dist/core/identifiers.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";

const SHA="a".repeat(40),at="2026-10-13T00:00:00.000Z";
const models=Object.fromEntries(["implementer","qc","planner","architect"]
  .map(k=>[k,{provider:"faux",model:"faux-1"}]));
const config={models,workspaces:{api:"wt-api"},
  test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:2};
const def=(taskId="api")=>({id:"wf",title:"Audit",maxQcRounds:2,
  maxParallelByRole:{implementer:1,reviewer:1,planner:1,architect:1},
  tasks:[{id:taskId,title:"API",kind:"implementation",role:"implementer",
    dependsOn:[]}]});
const root=()=>mkdtempSync(join(tmpdir(),"mm-audit-fixed-"));

test("F01: permission policies reject non-string enum impostors",()=>{
  assert.throws(()=>validatePermissions({default:["deny"]}),/Invalid default/);
  assert.throws(()=>validatePermissions({actions:{"git.commit":["deny"]}}),/Invalid permission/);
  assert.throws(()=>permissionDecision({default:["deny"]},"git.commit"),/Invalid default/);
  assert.throws(()=>permissionDecision({actions:{"git.commit":["deny"]}},"git.commit"),
    /Invalid permission/);
  assert.equal(permissionDecision({default:"deny"},"git.commit"),"deny");
});

test("F02: invalid resume decision never promotes a failing QC to passed",()=>{
  let w=newWorkflow(def(),at);
  const act=a=>{w=applyAction(w,a,at);};
  act({type:"request_intervention",interventionId:"stop",targetTaskId:"api",
    afterQcRunId:"next",instruction:"Investigate"});
  act({type:"start",taskId:"api"});
  act({type:"implementation_finished",taskId:"api",headSha:SHA,
    criteriaRevision:0,testsPassed:true});
  act({type:"qc_finalized",taskId:"api",runId:"qc-api-1",headSha:SHA,
    criteriaRevision:0,attempt:1,verdict:"fail"});
  act({type:"plan_intervention",interventionId:"stop",rationale:"Inspect",
    agents:[{id:"r",title:"Review",role:"reviewer",model:"faux/faux-1"}]});
  act({type:"start",taskId:"diag-stop-r"});
  act({type:"complete",taskId:"diag-stop-r"});
  act({type:"start",taskId:"synthesis-stop"});
  act({type:"complete",taskId:"synthesis-stop"});
  assert.throws(()=>applyAction(w,{type:"resume_after_diagnosis",
    amendmentId:"stop",decision:"typo"},at),/Resume decision/);
  assert.equal(w.tasks.api.status,"held");
  assert.equal(w.tasks.api.lastQc.verdict,"fail");
});
test("F15: maximal external Task IDs generate bounded Run/command IDs",()=>{
  const taskId="a".repeat(64),workflowId="w".repeat(64);
  const run=internalRunId("qc",taskId,1),command=internalCommandId(
    "auto:start:"+workflowId+":"+taskId+":1");
  assert.ok(run.length<=64);
  assert.match(run,/^[a-z][a-z0-9-]{0,63}$/);
  assert.ok(command.length<=128);
  let wf=newWorkflow(def(taskId),at);
  wf=applyAction(wf,{type:"start",taskId},at);
  wf=applyAction(wf,{type:"implementation_finished",taskId,headSha:SHA,
    criteriaRevision:0,testsPassed:true},at);
  wf=applyAction(wf,{type:"qc_finalized",taskId,runId:run,headSha:SHA,
    criteriaRevision:0,attempt:1,verdict:"pass"},at);
  assert.equal(wf.tasks[taskId].status,"passed");
  assert.equal(internalRunId("qc","api",1),"qc-api-1");
});

test("F16/F17: reserve internal task IDs and reject impossible dependency gates",()=>{
  assert.throws(()=>parseDefinition(def("mm-final-integration")) ,/reserved/);
  const malformed=def();
  malformed.tasks.push({id:"diag",title:"Read-only",kind:"diagnosis",
    role:"reviewer",dependsOn:[]});
  malformed.tasks.push({id:"bad",title:"Consumer",kind:"implementation",
    role:"implementer",dependsOn:[{taskId:"diag",gate:"qc_passed"}]});
  assert.throws(()=>parseDefinition(malformed),/cannot be satisfied/);
});
test("F05/F10: workflow ownership and unsealed leases are not UI-list-limited",()=>{
  const dir=root(),reg=new AgentRegistry(join(dir,"registry.sqlite"));
  try{
    const first={projectId:"p",orchestraWorkspaceId:"o",workflowId:"wf",
      taskId:"api",runId:"impl-api-1",workspaceId:"first",
      seat:"planner",requestId:"auto:initial"};
    reg.reserve(first,"2026-01-01T00:00:00.000Z");
    const b=reg.assign(first,"first-session");
    reg.record(b,{kind:"agent_settled",text:"Agent settled",
      at:Date.now(),sequence:1});
    for(let i=0;i<205;i++)reg.reserve({projectId:"p",
      orchestraWorkspaceId:"o",workflowId:"other",taskId:"t",
      runId:"run-"+i,workspaceId:"other-"+i,seat:"planner",
      requestId:"manual-"+i},new Date(Date.UTC(2030,0,2,0,0,i)).toISOString());
    assert.equal(reg.list("p","o","all").length,200);
    assert.equal(reg.list("p","o","all").some(x=>x.runId==="impl-api-1"),false);
    assert.equal(reg.hasAutomatedRun("p","o","wf"),true);
    assert.equal(reg.hasUnsealedAutomatedRun("p","o","wf"),true);
    assert.equal(reg.listWorkflow("p","o","wf").length,1);
  }finally{reg.close();rmSync(dir,{recursive:true,force:true});}
});

test("F09: every enabled scheduler record survives 200 newer disabled configs",()=>{
  const dir=root(),ledger=new AutopilotLedger(join(dir,"ledger.sqlite"));
  try{
    ledger.save("p","o","older",config);
    ledger.setStatus("p","o","older",true,"running");
    for(let i=0;i<205;i++)ledger.save("p","o","disabled-"+i,config);
    assert.equal(ledger.list().some(x=>x.workflowId==="older"),false);
    assert.equal(ledger.listEnabled().some(x=>x.workflowId==="older"),true);
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});
test("F08: once prepared, CAS retry keeps the original verification receipt",()=>{
  const dir=root(),ledger=new AutopilotLedger(join(dir,"ledger.sqlite"));
  try{
    const binding={projectId:"p",orchestraWorkspaceId:"o",workflowId:"wf",
      runId:"impl-api-1",sessionId:"session-a"};
    const action={type:"implementation_finished",taskId:"api",headSha:SHA,
      criteriaRevision:0,testsPassed:true};
    const first=ledger.prepareTransition(binding,"implementation",action,
      "host test output digest=A");
    const retry=ledger.prepareTransition(binding,"implementation",action,
      "host test output digest=B");
    assert.deepEqual(retry,first);
    const proof=ledger.sealEvidence(binding,"implementation",retry.details);
    assert.equal(proof.text,"host test output digest=A");
    assert.equal(ledger.preparedTransition(binding).action.headSha,SHA);
  }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});
