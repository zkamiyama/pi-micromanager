import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRunReport } from "../dist/automation/report.js";
import { WorkflowStore } from "../dist/core/store.js";
import { AgentRegistry } from "../dist/runtime/registry.js";
import { AutopilotLedger } from "../dist/automation/ledger.js";
import { parseRuntimeControl } from "../dist/runtime/protocol.js";

const proposal={
  kind:"workflow_plan",runId:"goal-abc123",summary:"Build and verify a health-check endpoint",
  definition:{
    id:"health-feature",title:"Add health check",maxQcRounds:3,
    maxParallelByRole:{planner:1,implementer:2,reviewer:2,architect:2},
    tasks:[
      {id:"api",title:"Implement endpoint",description:"Expose /health as a GET endpoint",
        acceptanceCriteria:["Valid request returns HTTP 200","No private tokens in response"],
        kind:"implementation",role:"implementer",dependsOn:[]},
      {id:"tests",title:"Add integration tests",
        description:"Write automated integration tests for /health",
        acceptanceCriteria:["Test pass on a clean checkout"],
        kind:"implementation",role:"implementer",
        dependsOn:[{taskId:"api",gate:"qc_passed"}]},
    ],
  },at:Date.now(),
};
test("Read-only initial Sol plan only accepts bounded, acyclic, testable DAGs",()=>{
  assert.deepEqual(parseRunReport(proposal),proposal);
  assert.deepEqual(parseRuntimeControl({type:"configure",requestId:"cfg1",
    provider:"provider",model:"model",job:{kind:"workflow_plan",runId:"goal-abc123"}}),{
    type:"configure",requestId:"cfg1",provider:"provider",model:"model",
    job:{kind:"workflow_plan",runId:"goal-abc123"},
  });
  assert.equal(parseRunReport({...proposal,definition:{
    ...proposal.definition,tasks:proposal.definition.tasks.map(t=>({...t,acceptanceCriteria:[]})),
  }}),undefined);
  assert.equal(parseRunReport({...proposal,definition:{
    ...proposal.definition,tasks:[...proposal.definition.tasks,
      {...proposal.definition.tasks[0],id:"cycle",
        dependsOn:[{taskId:"cycle",gate:"qc_passed"}]}],
  }}),undefined);
  assert.equal(parseRunReport({...proposal,definition:{
    ...proposal.definition,tasks:proposal.definition.tasks.concat(
      Array.from({length:15},(_,i)=>({...proposal.definition.tasks[0],id:"more-"+i}))),
  }}),undefined);
  assert.equal(parseRunReport({...proposal,definition:{
    ...proposal.definition,tasks:[{...proposal.definition.tasks[0],role:"architect"}],
  }}),undefined);
});
test("A typed Sol proposal remains inert until explicitly saved as Workflow",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pi-mm-goal-"));
  const store=new WorkflowStore(join(dir,"workflows.sqlite"));
  const agents=new AgentRegistry(join(dir,"runs.sqlite"));
  const ledger=new AutopilotLedger(join(dir,"autopilot.sqlite"));
  try{
    const reservation={projectId:"p",orchestraWorkspaceId:"o",workspaceId:"o",
      workflowId:"draft-abc123",taskId:"goal",runId:"goal-abc123",
      seat:"planner",requestId:"auto:goal:abc123"};
    agents.reserve(reservation);
    agents.assign(reservation,"sol-goal-session");
    const binding=agents.get("p","o","sol-goal-session");
    const report=ledger.recordReport(binding,proposal);
    assert.equal(report.kind,"workflow_plan");
    assert.deepEqual(store.list("p","o"),[],"Pi report alone must never create a Workflow");
    agents.record(binding,{kind:"agent_settled",text:"Agent settled",at:Date.now(),sequence:1});
    const created=store.create("p","o",report.definition);
    assert.equal(created.tasks.api.status,"ready");
    assert.equal(created.tasks.tests.status,"blocked");
    const evidence=ledger.sealEvidence(binding,"workflow-proposal","Human accepted "+
      created.definition.id);
    agents.seal("p","o","sol-goal-session",evidence.ref);
    assert.equal(agents.get("p","o","sol-goal-session").phase,"sealed");
    assert.equal(store.create("p","o",report.definition).revision,0,
      "Exact repeated acceptance is idempotent");
  }finally{
    ledger.close();agents.close();store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
