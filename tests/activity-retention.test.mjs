import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {WorkflowStore} from "../dist/core/store.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {ActivityRetention} from "../dist/automation/retention.js";
import {buildJournal} from "../dist/automation/journal.js";

const DAY=24*60*60*1000,sha="a".repeat(40);
const workflow={id:"flow",title:"A verified API",maxQcRounds:3,
  maxParallelByRole:{implementer:2,reviewer:2,architect:1,planner:1},
  tasks:[{id:"api",title:"Implement API",kind:"implementation",
    role:"implementer",description:"Implement HTTP API",
    acceptanceCriteria:["HTTP 200 for a valid request"],dependsOn:[]}]};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"mm-retention-"));
  const wf=new WorkflowStore(join(dir,"workflow.sqlite"));
  const agents=new AgentRegistry(join(dir,"agents.sqlite"));
  const ledger=new AutopilotLedger(join(dir,"autopilot.sqlite"));
  const retirement=new ActivityRetention({path:join(dir,"retention.sqlite"),
    workflows:wf,agents,ledger});
  let state=wf.create("p","o",workflow);
  state=wf.act("p","o","flow",state.revision,"start",{type:"start",taskId:"api"});
  state=wf.act("p","o","flow",state.revision,"finish",{
    type:"implementation_finished",taskId:"api",
    headSha:sha,criteriaRevision:0,testsPassed:true});
  state=wf.act("p","o","flow",state.revision,"qc",{
    type:"qc_finalized",taskId:"api",runId:"qc-api-1",headSha:sha,
    criteriaRevision:0,attempt:1,verdict:"pass"});
  const input={projectId:"p",orchestraWorkspaceId:"o",workspaceId:"linked-qc",
    workflowId:"flow",taskId:"api",runId:"qc-api-1",seat:"qc",requestId:"auto:qc1"};
  agents.reserve(input);agents.assign(input,"pi-qc");
  const binding=agents.get("p","o","pi-qc");
  const old=Date.now()-48*DAY;
  agents.record(binding,{kind:"agent_started",text:"Started",at:old,sequence:1});
  agents.record(binding,{kind:"agent_settled",text:"Agent settled",at:old+1000,sequence:2});
  const evidence=ledger.sealEvidence(binding,"qc","PASS at "+sha);
  agents.seal("p","o","pi-qc",evidence.ref);
  const db=new DatabaseSync(join(dir,"agents.sqlite"));
  db.prepare("UPDATE execution_runs SET updated_at=? WHERE session_id='pi-qc'")
    .run(new Date(old+1000).toISOString());
  db.close();
  return {dir,wf,agents,ledger,retirement,evidence,
    integrate(){
      const current=wf.get("p","o","flow");
      return wf.act("p","o","flow",current.revision,"integrate",{type:"integrate",taskId:"api"});
    },
    close(){
      retirement.close();ledger.close();agents.close();wf.close();
      rmSync(dir,{recursive:true,force:true});
    }};
}
test("Journal links actual QC evidence and Task status without full Pi transcripts",()=>{
  const x=fixture();
  try{
    const instance=x.wf.get("p","o","flow");
    const runs=x.agents.list("p","o","all");
    const journal=buildJournal(instance,runs,x.ledger);
    assert.equal(journal.workflowId,"flow");
    assert.equal(journal.tasks[0].status,"passed");
    assert.equal(journal.tasks[0].lastQc.headSha,sha);
    assert.equal(journal.runs.length,1);
    assert.equal(journal.runs[0].evidence.ref,x.evidence.ref);
    assert.match(journal.runs[0].evidence.summary,/PASS/);
    assert.ok(journal.notes.some(x=>x.includes("integration")));
    assert.ok(journal.events.every(e=>!Object.hasOwn(e,"hiddenThinking")));
    assert.ok(!Object.hasOwn(journal.runs[0],"transcript"));
  }finally{x.close();}
});
test("Expired public activity is protected while a QC-passed Task awaits integration",()=>{
  const x=fixture();
  try{
    assert.equal(x.retirement.preview("p","o",30),null);
    assert.equal(x.agents.activities("p","o","pi-qc").length,2);
    assert.throws(()=>x.retirement.preview("p","o",29),/minimum 30 days/);
  }finally{x.close();}
});
test("Two-step retention prunes only sealed and old public projections, not evidence or Workflow",()=>{
  const x=fixture();
  try{
    x.integrate();
    const plan=x.retirement.preview("p","o",30);
    assert.equal(plan.state,"prepared");
    assert.equal(plan.rowCount,2);
    assert.equal(plan.affectedRuns,1);
    assert.ok(plan.estimatedBytes>0);
    assert.equal(x.agents.activities("p","o","pi-qc").length,2,
      "Preview must not delete a record");
    assert.throws(()=>x.retirement.confirm("different","o",plan.id),/different workspace|not found/);
    const done=x.retirement.confirm("p","o",plan.id);
    assert.equal(done.deletedRows,2);
    assert.equal(done.state,"completed");
    assert.equal(x.agents.activities("p","o","pi-qc").length,0);
    assert.equal(x.retirement.confirm("p","o",plan.id).deletedRows,2);
    assert.equal(x.agents.get("p","o","pi-qc").phase,"sealed");
    assert.equal(x.ledger.evidence(x.agents.get("p","o","pi-qc")).ref,x.evidence.ref);
    assert.equal(x.wf.get("p","o","flow").tasks.api.status,"integrated");
    assert.ok(x.wf.get("p","o","flow").events.length>0,
      "Authoritative Workflow event history is never touched");
    assert.equal(x.retirement.preview("p","o",30),null);
  }finally{x.close();}
});
test("A late event or renewed Run activity invalidates a retention preview",()=>{
  const x=fixture();
  try{
    x.integrate();
    const preview=x.retirement.preview("p","o",30);
    const binding=x.agents.get("p","o","pi-qc");
    x.agents.record(binding,{kind:"tool_finished",text:"Late event",
      at:Date.now(),sequence:3});
    assert.throws(()=>x.retirement.confirm("p","o",preview.id),
      /eligibility changed/);
    assert.equal(x.agents.activities("p","o","pi-qc").length,3);
    assert.equal(x.retirement.preview("p","o",30),null);
  }finally{x.close();}
});
test("Expired preview cannot be confirmed after deadline or for a new run",()=>{
  const x=fixture();
  try{
    x.integrate();
    const preview=x.retirement.preview("p","o",30);
    assert.throws(()=>x.retirement.confirm("p","o",preview.id,
      preview.expiresAt+1),/expired/);
    assert.equal(x.agents.activities("p","o","pi-qc").length,2);
  }finally{x.close();}
});
test("Unsealed Run activity is never pruned even when its event timestamp is old",()=>{
  const x=fixture();
  try{
    x.integrate();
    const input={projectId:"p",orchestraWorkspaceId:"o",workspaceId:"other",
      workflowId:"flow",taskId:"api",runId:"qc-api-2",seat:"qc",requestId:"manual:qc2"};
    x.agents.reserve(input);x.agents.assign(input,"pi-unsealed");
    const bound=x.agents.get("p","o","pi-unsealed");
    x.agents.record(bound,{kind:"agent_started",text:"Pending",
      at:Date.now()-70*DAY,sequence:1});
    const preview=x.retirement.preview("p","o",30);
    assert.equal(preview.rowCount,2);
    x.retirement.confirm("p","o",preview.id);
    assert.equal(x.agents.activities("p","o","pi-unsealed").length,1);
  }finally{x.close();}
});
