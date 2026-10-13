import test from "node:test";
import assert from "node:assert/strict";
import {parseDefinition, newWorkflow, applyAction} from "../dist/core/workflow.js";
import {permissionDecision} from "../dist/core/permissions.js";

const base = {
  id:"audit-recovery", title:"Audit regression", maxQcRounds:2,
  maxParallelByRole:{planner:1,implementer:1,reviewer:1,architect:1},
  tasks:[{id:"api",title:"API",kind:"implementation",role:"implementer",dependsOn:[]}],
};
test("F01: malformed permission values are rejected rather than permitting execution",()=>{
  for(const value of [["deny"],["allow"],{},true,1]){
    assert.throws(()=>parseDefinition({...base,permissions:{default:value}}),/Invalid (default permission|permission decision)/);
    assert.throws(()=>parseDefinition({...base,permissions:{actions:{"git.commit":value}}}),/Invalid (default permission|permission decision)/);
  }
  assert.throws(()=>permissionDecision({default:["deny"]},"git.commit"),/Invalid default permission/);
  assert.throws(()=>permissionDecision({actions:{"git.commit":["deny"]}},"git.commit"),/Invalid permission decision/);
});
test("F02: unknown resume decisions cannot turn failed QC into PASS",()=>{
  let w=newWorkflow(base,"2026-10-13T00:00:00Z");
  const act=(a)=>{w=applyAction(w,a,"2026-10-13T00:00:00Z");};
  act({type:"start",taskId:"api"});
  act({type:"implementation_finished",taskId:"api",headSha:"a".repeat(40),criteriaRevision:0,testsPassed:true});
  act({type:"request_intervention",interventionId:"audit",targetTaskId:"api",afterQcRunId:"next",instruction:"Investigate"});
  act({type:"qc_finalized",taskId:"api",runId:"qc-api-1",headSha:"a".repeat(40),criteriaRevision:0,attempt:1,verdict:"fail"});
  act({type:"plan_intervention",interventionId:"audit",rationale:"Inspect",agents:[{id:"reader",title:"Inspect",role:"reviewer",model:"test/model"}]});
  act({type:"start",taskId:"diag-audit-reader"});
  act({type:"complete",taskId:"diag-audit-reader"});
  act({type:"start",taskId:"synthesis-audit"});
  act({type:"complete",taskId:"synthesis-audit"});
  const prior=w.revision;
  assert.throws(()=>applyAction(w,{type:"resume_after_diagnosis",amendmentId:"audit",decision:"typo"},"2026-10-13T00:00:00Z"),/Resume decision/);
  assert.equal(w.revision,prior);
  assert.equal(w.tasks.api.status,"held");
  assert.equal(w.tasks.api.lastQc.verdict,"fail");
});
