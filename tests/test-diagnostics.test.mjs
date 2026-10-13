import test from "node:test";
import assert from "node:assert/strict";
import {boundedFailureDiagnostics} from "../dist/automation/test-diagnostics.js";
test("test diagnostics retain actionable failure names but not secrets or raw output",()=>{
 const data=[
  "not ok 3 - checkout returns 200",
  "not ok 4 - token=ghp_ABCDEF123456SECRET",
  "not ok 5 - abcdefghijklmnopqrstuvwxyzabcdef",
  "private output: email=a@example.com secret=x",
 ].join("\n");
 const report=boundedFailureDiagnostics(data,"error TS2322: key=example-secret");
 assert.equal(report.includes("returns 200"),true);
 assert.equal(report.includes("ghp_"),false);
 assert.equal(report.includes("ABCDEF"),false);
 assert.equal(report.includes("a@example.com"),false);
 assert.equal(report.includes("example-secret"),false);
 const result=JSON.parse(report);
 assert.equal(result.failedTests.length,3);
 assert.deepEqual(result.compilerCodes,["TS2322"]);
 assert.equal(result.failedTests[1].name,"[redacted]");
});
