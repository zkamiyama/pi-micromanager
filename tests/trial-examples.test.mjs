import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {validateDefinition} from "../dist/core/workflow.js";
import {parseAutopilotConfig} from "../dist/automation/ledger.js";

test("The published trial workflow and Autopilot configuration pass the actual validators",()=>{
  const dag=JSON.parse(readFileSync(resolve("examples/trial.workflow.json"),"utf8"));
  assert.doesNotThrow(()=>validateDefinition(dag));
  assert.equal(dag.tasks.length,1);
  const conf=JSON.parse(readFileSync(resolve("examples/trial.autopilot.json"),"utf8"));
  const parsed=parseAutopilotConfig(conf);
  assert.equal(parsed.managedWorktrees,true);
  assert.equal(parsed.finalization.workspaceId,"auto");
  assert.equal(parsed.finalization.autoMerge,true);
  assert.equal(parsed.publication.baseBranch,"main");
  assert.deepEqual(parsed.test,{execution:"sandbox",file:"node",args:["--test"],timeoutMs:60000});
});

test("The disposable starter repository really passes baseline Node tests",async()=>{
  const cwd=resolve("examples/trial-repo");
  const checked=spawnSync(process.execPath,["--test"],{
    cwd,encoding:"utf8",timeout:10000,
  });
  assert.equal(checked.status,0,checked.stderr||checked.stdout);
  // Node's nested test-runner child may suppress TAP output even when its
  // process exits successfully. Assert the executable behavior explicitly.
  const {add}=await import("../examples/trial-repo/src/math.mjs");
  assert.equal(add(2,3),5);
  assert.equal(add(-4,7),3);
});
