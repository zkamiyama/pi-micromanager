import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "../dist/core/store.js";
import { AgentRegistry } from "../dist/runtime/registry.js";
import { AutopilotLedger, parseAutopilotConfig } from "../dist/automation/ledger.js";
import { AutopilotEngine, planNext, buildJobPrompt } from "../dist/automation/engine.js";

const sha="a".repeat(40);
const definition={id:"wf",title:"Implement API",maxQcRounds:3,
  maxParallelByRole:{implementer:2,reviewer:2,architect:2,planner:1},
  tasks:[{id:"api",title:"Build an API endpoint",kind:"implementation",role:"implementer",dependsOn:[]}]};
const profile={provider:"test-provider",model:"test-model",effort:"low"};
const config={
  workspaces:{api:"linked-wt-api"},
  models:{implementer:profile,qc:profile,architect:profile,planner:profile},
  test:{file:"node",args:["--test"],timeoutMs:30000},maxAttempts:3,
};
function setup(){
  const dir=mkdtempSync(join(tmpdir(),"pi-mm-auto-"));
  const store=new WorkflowStore(join(dir,"workflow.sqlite"));
  const registry=new AgentRegistry(join(dir,"runs.sqlite"));
  const ledger=new AutopilotLedger(join(dir,"auto.sqlite"));
  store.create("project","orchestra",definition);
  ledger.save("project","orchestra","wf",config);
  ledger.setStatus("project","orchestra","wf",true,"running");
  const launches=[];
  let verifyResult={headSha:sha,clean:true,testsPassed:true,details:"unit fake checked"};
  const engine=new AutopilotEngine(store,registry,ledger,{
    async launch(job){
      launches.push(job);
      const reservation={projectId:job.projectId,orchestraWorkspaceId:job.orchestraWorkspaceId,
        workflowId:job.workflowId,taskId:job.taskId,runId:job.runId,
        workspaceId:job.workspaceId,seat:job.seat,requestId:"auto:"+job.runId};
      registry.reserve(reservation);
      registry.assign(reservation,"session-"+job.runId);
      const binding=registry.get("project","orchestra","session-"+job.runId);
      registry.update(binding,"running",{provider:profile.provider,model:profile.model,effort:profile.effort});
      return registry.get("project","orchestra","session-"+job.runId);
    },
    async verify(){return verifyResult;},
  });
  const status=()=>ledger.get("project","orchestra","wf");
  const wf=()=>store.get("project","orchestra","wf");
  const run=(id)=>registry.getRun("project","orchestra","wf",id);
  const settled=(id,aborted=false)=>{
    const binding=run(id);
    registry.record(binding,{kind:"agent_settled",sequence:1,at:Date.now(),
      text:aborted?"Agent interrupted":"Agent settled"});
    return run(id);
  };
  return {dir,store,registry,ledger,engine,launches,status,wf,run,settled,
    setVerification(value){verifyResult=value;},
    async tick(){await engine.tick(status());},
    close(){ledger.close();registry.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test("Autopilot config requires explicit profiles, unique worktrees and safe argv",()=>{
  assert.equal(parseAutopilotConfig(config).maxAttempts,3);
  assert.throws(()=>parseAutopilotConfig({...config,workspaces:{a:"same",b:"same"}}),/distinct/);
  assert.throws(()=>parseAutopilotConfig({...config,test:{file:"",args:[]}}),/bounded/);
  assert.throws(()=>parseAutopilotConfig({...config,maxAttempts:Infinity}),/budget/);
  assert.throws(()=>parseAutopilotConfig({...config,test:{file:"node",args:["a"],timeoutMs:999999}}),/timeout/);
});
test("Real transition chain: ready -> implementation -> verified QC -> passed, no implicit integration",async()=>{
  const x=setup();
  try{
    assert.deepEqual(planNext(x.wf(),[],config),{action:"start",taskId:"api"});
    await x.tick();
    assert.equal(x.wf().tasks.api.status,"running");
    await x.tick();
    assert.equal(x.launches.length,1);
    assert.equal(x.launches[0].kind,"implementation");
    assert.equal(x.launches[0].workspaceId,"linked-wt-api");
    assert.ok(x.launches[0].prompt.includes("COMMIT all intended changes"));
    await x.tick();
    assert.equal(x.launches.length,1); // no duplicate sessions
    x.settled("impl-api-1");
    await x.tick();
    assert.equal(x.wf().tasks.api.status,"awaiting_qc");
    assert.equal(x.wf().tasks.api.pendingWork.headSha,sha);
    assert.equal(x.run("impl-api-1").phase,"sealed");
    await x.tick();
    assert.equal(x.launches.length,2);
    assert.equal(x.launches[1].kind,"qc");
    assert.equal(x.launches[1].headSha,sha);
    const qc=x.settled("qc-api-1");
    x.ledger.recordReport(qc,{kind:"qc",runId:"qc-api-1",verdict:"pass",
      summary:"Tests and contract reviewed",at:Date.now()});
    await x.tick();
    assert.equal(x.wf().tasks.api.status,"passed");
    assert.equal(x.wf().tasks.api.qcRounds,1);
    assert.equal(x.run("qc-api-1").phase,"sealed");
    assert.ok(x.ledger.evidence(qc).ref.startsWith("sha256:"));
    assert.equal(x.wf().tasks.api.status==="integrated",false);
  }finally{x.close();}
});
test("Unreported QC pauses instead of treating agent_settled as success",async()=>{
  const x=setup();
  try{
    await x.tick();await x.tick();
    x.settled("impl-api-1");await x.tick();await x.tick();
    x.settled("qc-api-1");await x.tick();
    assert.equal(x.status().enabled,false);
    assert.match(x.status().status,/structured qc report/);
    assert.equal(x.wf().tasks.api.status,"awaiting_qc");
    assert.equal(x.run("qc-api-1").phase,"settled");
  }finally{x.close();}
});
test("Host test failure forces QC fail regardless of model's PASS",async()=>{
  const x=setup();
  try{
    await x.tick();await x.tick();x.settled("impl-api-1");await x.tick();await x.tick();
    const qc=x.settled("qc-api-1");
    x.ledger.recordReport(qc,{kind:"qc",runId:"qc-api-1",
      verdict:"pass",summary:"Looked good",at:Date.now()});
    x.setVerification({headSha:sha,clean:true,testsPassed:false,details:"exit=1"});
    await x.tick();
    assert.equal(x.wf().tasks.api.lastQc.verdict,"fail");
    assert.equal(x.wf().tasks.api.status,"ready");
  }finally{x.close();}
});
test("QC snapshot mismatch never finalizes an agent PASS",async()=>{
  const x=setup();
  try{
    await x.tick();await x.tick();x.settled("impl-api-1");await x.tick();await x.tick();
    const qc=x.settled("qc-api-1");
    x.ledger.recordReport(qc,{kind:"qc",runId:"qc-api-1",verdict:"pass",
      summary:"Reviewed",at:Date.now()});
    x.setVerification({headSha:"b".repeat(40),clean:true,testsPassed:true,details:""});
    await x.tick();
    assert.equal(x.status().enabled,false);
    assert.equal(x.wf().tasks.api.status,"awaiting_qc");
  }finally{x.close();}
});
test("A human QC hold is preserved after automated QC finalization",async()=>{
  const x=setup();
  try{
    await x.tick();
    const w=x.wf();
    x.store.act("project","orchestra","wf",w.revision,"human-hold",{
      type:"request_intervention",interventionId:"human-hold",
      targetTaskId:"api",afterQcRunId:"next",instruction:"Stop and inspect alternatives",
    });
    await x.tick();x.settled("impl-api-1");await x.tick();await x.tick();
    const qc=x.settled("qc-api-1");
    x.ledger.recordReport(qc,{kind:"qc",runId:"qc-api-1",verdict:"fail",
      summary:"Contract mismatch",at:Date.now()});
    await x.tick();
    assert.equal(x.wf().tasks.api.status,"held");
    assert.equal(x.wf().amendments[0].status,"planning");
    await x.tick();
    assert.equal(x.launches.filter(t=>t.kind==="implementation").length,1);
  }finally{x.close();}
});
test("Crash between authoritative transition and seal can safely complete without a new Run",async()=>{
  const x=setup();
  try{
    await x.tick();await x.tick();
    const b=x.settled("impl-api-1");
    const evidence=x.ledger.sealEvidence(b,"implementation","implementation "+sha+" unit fake checked");
    const w=x.wf();
    x.store.act("project","orchestra","wf",w.revision,"auto:complete:impl-api-1",{
      type:"implementation_finished",taskId:"api",headSha:sha,
      criteriaRevision:0,testsPassed:true,
    });
    await x.tick();
    assert.equal(x.run("impl-api-1").phase,"sealed");
    assert.equal(x.run("impl-api-1").evidenceRef,evidence.ref);
    assert.equal(x.launches.length,1);
  }finally{x.close();}
});
test("Manual Run is never silently adopted by Autopilot",async()=>{
  const x=setup();
  try{
    await x.tick();
    const reservation={projectId:"project",orchestraWorkspaceId:"orchestra",
      workflowId:"wf",taskId:"api",runId:"impl-api-1",workspaceId:"linked-wt-api",
      seat:"implementer",requestId:"manual-1"};
    x.registry.reserve(reservation);
    x.registry.assign(reservation,"manual-session");
    x.registry.update(x.registry.get("project","orchestra","manual-session"),"running");
    await x.tick();
    assert.equal(x.status().enabled,false);
    assert.match(x.status().status,/manually owned Run/);
    assert.equal(x.launches.length,0);
  }finally{x.close();}
});
