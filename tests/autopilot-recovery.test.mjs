import test from "node:test";
import assert from "node:assert/strict";
import { classifyRecoveredRun } from "../dist/automation/recovery.js";
import { parseRuntimeControl, parseRuntimeReceipt } from "../dist/runtime/protocol.js";
import { parseRunReport } from "../dist/automation/report.js";

test("inspect requests are typed and cannot carry arbitrary recovery state",()=>{
  assert.deepEqual(parseRuntimeControl({type:"inspect",requestId:"inspect-1",secret:"drop"}),
    {type:"inspect",requestId:"inspect-1"});
  assert.equal(parseRuntimeControl({type:"inspect",requestId:"invalid id"}),undefined);
  assert.deepEqual(parseRuntimeReceipt({requestId:"inspect1",status:"ok",jobRunId:"impl-api-1",
    idle:true,turnSettled:true,turnInterrupted:false,hasReport:true}),{
    requestId:"inspect1",status:"ok",jobRunId:"impl-api-1",idle:true,
    turnSettled:true,turnInterrupted:false,hasReport:true,
  });
  assert.equal(parseRuntimeReceipt({requestId:"inspect1",status:"ok",turnSettled:"true"}),undefined);
  assert.equal(parseRuntimeReceipt({requestId:"inspect1",status:"ok",jobRunId:"wrong id"}),undefined);
});
const base={requestId:"inspect1",status:"ok",jobRunId:"impl-api-1"};
test("only matching durable Pi Session turn proof can resume orchestration",()=>{
  assert.equal(classifyRecoveredRun("impl-api-1",{...base,idle:true,
    turnSettled:true,turnInterrupted:false}),"settled");
  assert.equal(classifyRecoveredRun("impl-api-1",{...base,idle:true,
    turnSettled:true,turnInterrupted:true}),"aborted");
  assert.equal(classifyRecoveredRun("impl-api-1",{...base,idle:false,
    turnSettled:false,turnInterrupted:false}),"running");
  for(const receipt of [
    {...base,idle:true},
    {...base,idle:true,turnSettled:false,turnInterrupted:false},
    {...base,idle:false,turnSettled:true,turnInterrupted:false},
    {...base,idle:false,turnSettled:false,turnInterrupted:true},
    {...base,idle:true,turnSettled:true},
    {...base,jobRunId:"impl-other-1",idle:true,turnSettled:true,turnInterrupted:false},
    {...base,status:"uncertain",idle:true,turnSettled:true,turnInterrupted:false},
  ])assert.equal(classifyRecoveredRun("impl-api-1",receipt),"uncertain");
});
test("typed Sol plan rejects unexpected model and investigator forms",()=>{
  const report={kind:"plan",runId:"plan-human-hold",
    summary:"Investigate contract failure",
    agents:[
      {id:"astra",title:"Read-only root cause",role:"architect",model:"a/model"},
      {id:"opus",title:"Independent alternatives",role:"reviewer",model:"b/model"},
    ],at:Date.now()};
  assert.deepEqual(parseRunReport(report),report);
  assert.equal(parseRunReport({...report,agents:[report.agents[0],report.agents[0]]}),undefined);
  assert.equal(parseRunReport({...report,agents:[]}),undefined);
  assert.equal(parseRunReport({...report,agents:[{...report.agents[0],role:"implementer"}]}),undefined);
  assert.equal(parseRunReport({...report,agents:[{...report.agents[0],model:""}]}),undefined);
});
