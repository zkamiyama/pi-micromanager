import test from "node:test";
import assert from "node:assert/strict";
import {evaluatePrActionsRuns} from "../dist/automation/publication.js";

const sha="f".repeat(40),repo="zkamiyama/pi-micromanager",pr=12;
const good={
  head_sha:sha,event:"pull_request",status:"completed",conclusion:"success",
  repository:{full_name:repo},pull_requests:[{number:pr}],
};
const page=(...runs)=>({total_count:runs.length,workflow_runs:runs});

test("PR Actions REST fallback accepts only exact successful commit",()=>{
  assert.equal(evaluatePrActionsRuns(page(good),repo,pr,sha),"pass");
  assert.equal(evaluatePrActionsRuns(page(),repo,pr,sha),"pending");
  assert.equal(evaluatePrActionsRuns(page({...good,head_sha:"a".repeat(40)}),repo,pr,sha),"pending");
  assert.equal(evaluatePrActionsRuns(page({...good,status:"in_progress",conclusion:null}),repo,pr,sha),"pending");
  assert.equal(evaluatePrActionsRuns({total_count:2,workflow_runs:[good]},repo,pr,sha),"pending");
});

test("PR Actions REST fallback refuses failures and malformed checks",()=>{
  for(const conclusion of ["failure","cancelled","timed_out","skipped","neutral"]){
    assert.throws(()=>evaluatePrActionsRuns(page({...good,conclusion}),repo,pr,sha),/did not succeed/);
  }
  assert.throws(()=>evaluatePrActionsRuns(page({...good,pull_requests:undefined}),repo,pr,sha),/association/);
});
