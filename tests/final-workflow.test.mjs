import test from "node:test";
import assert from "node:assert/strict";
import {WorkflowStore} from "../dist/core/store.js";
import {newWorkflow,applyAction} from "../dist/core/workflow.js";
import {parseAutopilotConfig} from "../dist/automation/ledger.js";
import {buildJobPrompt,workspaceFor,planNext} from "../dist/automation/engine.js";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const sha="a".repeat(40);
const def={id:"integration-flow",title:"Final integration system test",
  maxQcRounds:2,maxParallelByRole:{
    planner:1,implementer:2,reviewer:1,architect:1},
  tasks:[
    {id:"api",title:"API implementation",role:"implementer",kind:"implementation",
      dependsOn:[],description:"Provide API contract",acceptanceCriteria:["Pass unit tests"]},
    {id:"frontend",title:"Frontend",role:"implementer",kind:"implementation",
      dependsOn:[],description:"Provide UI",acceptanceCriteria:["Pass UI tests"]},
  ],
};
const profiles=Object.fromEntries(["planner","implementer","qc","architect"].map(role=>
  [role,{provider:"mock",model:"mock"}]));
const config={workspaces:{api:"wt-api",frontend:"wt-ui"},models:profiles,
  test:{file:"node",args:["--test"],timeoutMs:30000},maxAttempts:3,
  publication:{remote:"origin",baseBranch:"main",draft:true},
  finalization:{workspaceId:"wt-final",autoMerge:true},
};
function passed(){
  let w=newWorkflow(def,new Date().toISOString());
  for(const id of ["api","frontend"]){
    w=applyAction(w,{type:"start",taskId:id},new Date().toISOString());
    w=applyAction(w,{type:"implementation_finished",taskId:id,
      headSha:sha,criteriaRevision:0,testsPassed:true},new Date().toISOString());
    w=applyAction(w,{type:"qc_finalized",taskId:id,runId:"qc-"+id+"-1",
      verdict:"pass",headSha:sha,criteriaRevision:0,attempt:1},
      new Date().toISOString());
  }
  return w;
}
test("Only a complete QC-passed DAG may spawn exactly one final integration Task",()=>{
  const now=new Date().toISOString();
  assert.throws(()=>applyAction(newWorkflow(def,now),
    {type:"prepare_final_integration"},now),/QC PASS/);
  const ready=passed();
  assert.equal(ready.tasks.api.status,"passed");
  const prepared=applyAction(ready,{type:"prepare_final_integration"},now);
  const final=prepared.tasks["mm-final-integration"];
  assert.equal(final.status,"ready");
  assert.equal(final.spec.systemPurpose,"final-integration");
  assert.equal(final.spec.kind,"implementation");
  assert.deepEqual(final.spec.dependsOn.map(d=>d.taskId),["api","frontend"]);
  assert.equal(final.spec.dependsOn.every(d=>d.gate==="qc_passed"),true);
  assert.equal(prepared.definition.tasks.length,3);
  assert.equal(ready.tasks["mm-final-integration"],undefined,
    "Existing Workflow revisions remain immutable");
  assert.throws(()=>applyAction(prepared,{type:"prepare_final_integration"},now),
    /already exists/);
});
test("Finalizer is a real fresh implementation/QC Task, not an agent prose verdict",()=>{
  const now=new Date().toISOString();
  let workflow=applyAction(passed(),{type:"prepare_final_integration"},now);
  const parsed=parseAutopilotConfig(config);
  const task=workflow.tasks["mm-final-integration"];
  assert.equal(workspaceFor(task,"implementation",parsed,"o"),"wt-final");
  assert.equal(workspaceFor(task,"qc",parsed,"o"),"wt-final");
  assert.deepEqual(planNext(workflow,[],parsed),{
    action:"start",taskId:"mm-final-integration"});
  const prompt=buildJobPrompt(workflow,task,"implementation");
  assert.match(prompt,/FINAL integration run/);
  assert.match(prompt,/Resolve conflicts/);
  assert.match(prompt,/Merge ALL source Git commits/);
  assert.match(prompt,/QC-approved/);
  workflow=applyAction(workflow,{type:"start",taskId:"mm-final-integration"},now);
  assert.equal(planNext(workflow,[],parsed).runId,"impl-mm-final-integration-1");
  workflow=applyAction(workflow,{type:"implementation_finished",
    taskId:"mm-final-integration",headSha:sha,
    criteriaRevision:0,testsPassed:true},now);
  assert.equal(workflow.tasks["mm-final-integration"].status,"awaiting_qc");
  const next=planNext(workflow,[],parsed);
  assert.equal(next.runId,"qc-mm-final-integration-1");
  workflow=applyAction(workflow,{type:"qc_finalized",
    taskId:"mm-final-integration",runId:next.runId,headSha:sha,
    criteriaRevision:0,attempt:1,verdict:"fail"},now);
  assert.equal(workflow.tasks["mm-final-integration"].status,"ready",
    "Failed final QC triggers a bounded fresh implementation attempt");
  assert.equal(workflow.tasks.api.status,"passed",
    "Retrying the merged result never falsifies upstream QC records");
});
test("Config allows independent final Worktree and rejects missing publication or duplicate source checkout",()=>{
  const parsed=parseAutopilotConfig(config);
  assert.deepEqual(parsed.finalization,{workspaceId:"wt-final",autoMerge:true});
  assert.equal(parseAutopilotConfig({...config,finalization:undefined}).finalization,undefined);
  assert.throws(()=>parseAutopilotConfig({...config,publication:undefined}),
    /publication destination/);
  assert.throws(()=>parseAutopilotConfig({...config,
    finalization:{workspaceId:"wt-api",autoMerge:true}}),
    /distinct/);
  assert.throws(()=>parseAutopilotConfig({...config,
    reviewWorkspaces:{api:"wt-final"}}),
    /distinct/);
  assert.throws(()=>parseAutopilotConfig({...config,
    finalization:{workspaceId:"wt-final",autoMerge:"yes"}}),
    /boolean/);
});
test("Durable prepare command is replay safe and does not create duplicate final Runs",()=>{
  const dir=mkdtempSync(join(tmpdir(),"mm-final-workflow-"));
  const store=new WorkflowStore(join(dir,"workflow.sqlite"));
  try{
    // Persist a passed instance by applying native Workflow actions.
    let w=store.create("p","o",def);
    for(const id of ["api","frontend"]){
      w=store.act("p","o",def.id,w.revision,"start:"+id,
        {type:"start",taskId:id});
      w=store.act("p","o",def.id,w.revision,"impl:"+id,
        {type:"implementation_finished",taskId:id,headSha:sha,
          criteriaRevision:0,testsPassed:true});
      w=store.act("p","o",def.id,w.revision,"qc:"+id,
        {type:"qc_finalized",taskId:id,runId:"qc-"+id+"-1",
          headSha:sha,criteriaRevision:0,attempt:1,verdict:"pass"});
    }
    const created=store.act("p","o",def.id,w.revision,"auto:prepare:final-integration",
      {type:"prepare_final_integration"});
    assert.equal(created.tasks["mm-final-integration"].status,"ready");
    const replayed=store.act("p","o",def.id,w.revision,
      "auto:prepare:final-integration",{type:"prepare_final_integration"});
    assert.equal(replayed.revision,created.revision);
    assert.equal(store.list("p","o")[0].definition.tasks.length,3);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test("Read-only final QC receives concrete source contracts, not only uninspectable Git ancestry criteria",()=>{
 const at=new Date().toISOString();
 let workflow=applyAction(passed(),{type:"prepare_final_integration"},at);
 workflow=applyAction(workflow,{type:"start",taskId:"mm-final-integration"},at);
 workflow=applyAction(workflow,{type:"implementation_finished",
   taskId:"mm-final-integration",headSha:sha,criteriaRevision:0,testsPassed:true},at);
 const prompt=buildJobPrompt(workflow,workflow.tasks["mm-final-integration"],"qc");
 assert.match(prompt,/Source Task api: API implementation/);
 assert.match(prompt,/Provide API contract/);
 assert.match(prompt,/Source Task frontend: Frontend/);
 assert.match(prompt,/Provide UI/);
 assert.match(prompt,/using the read tool/);
 assert.match(prompt,/host independently proves the source Git SHA ancestry/i);
 assert.match(prompt,/Do not mark inconclusive merely because/);
 assert.match(prompt,/mm_qc_report exactly once/);
});
