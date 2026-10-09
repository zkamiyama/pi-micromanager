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
    async checkSnapshot(_binding,expectedSha){
      if(verifyResult.headSha!==expectedSha||!verifyResult.clean)
        throw new Error("Frozen QC snapshot changed");
    },
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
    for(let i=0;i<6&&!x.run("impl-api-1");i++)await x.tick();
    assert.ok(x.run("impl-api-1"),"The implementation Run is launched after the planner reservation");
    assert.ok(x.run("plan-human-hold"),"Sol's separate planning Run was launched");
    x.settled("impl-api-1");
    await x.tick();await x.tick();
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

test("Sol typed planning → parallel independent diagnoses → synthesis never auto-resumes held Task",async()=>{
  const x=setup();
  try{
    await x.tick(); // Admit implementation Task (no Pi Session yet)
    let workflow=x.wf();
    x.store.act("project","orchestra","wf",workflow.revision,"human-request",{
      type:"request_intervention",interventionId:"human-hold",
      targetTaskId:"api",afterQcRunId:"next",
      instruction:"After next QC, run independent failure diagnoses",
    });
    await x.tick();
    assert.equal(x.launches[0].kind,"planning");
    const planner=x.settled("plan-human-hold");
    x.ledger.recordReport(planner,{kind:"plan",runId:"plan-human-hold",
      summary:"Independently inspect the API failure",
      agents:[
        {id:"astra",title:"Root cause",role:"architect",model:"test-provider/test-model"},
        {id:"opus",title:"Alternative approach",role:"reviewer",model:"test-provider/test-model"},
      ],at:Date.now()});
    await x.tick();
    assert.equal(x.wf().amendments[0].status,"armed");
    assert.equal(x.run("plan-human-hold").phase,"sealed");
    await x.tick();
    assert.ok(x.run("impl-api-1"));
    x.settled("impl-api-1");
    await x.tick();await x.tick();
    const qc=x.settled("qc-api-1");
    x.ledger.recordReport(qc,{kind:"qc",runId:"qc-api-1",verdict:"fail",
      summary:"API contract mismatch",at:Date.now()});
    await x.tick();
    assert.equal(x.wf().tasks.api.status,"held");
    assert.equal(x.wf().amendments[0].status,"activated");
    assert.equal(x.wf().tasks["diag-human-hold-astra"].status,"ready");
    assert.equal(x.wf().tasks["diag-human-hold-opus"].status,"ready");
    for(let i=0;i<6&&(!x.run("task-diag-human-hold-astra-1")||
        !x.run("task-diag-human-hold-opus-1"));i++)await x.tick();
    assert.ok(x.run("task-diag-human-hold-astra-1"));
    assert.ok(x.run("task-diag-human-hold-opus-1"));
    assert.equal(x.launches.find(j=>j.taskId==="diag-human-hold-astra").workspaceId,"linked-wt-api");
    assert.equal(x.launches.find(j=>j.taskId==="diag-human-hold-opus").headSha,sha);
    for(const [runId,summary] of [
      ["task-diag-human-hold-astra-1","Root cause: contract typo"],
      ["task-diag-human-hold-opus-1","Use a compatibility adapter"],
    ]){
      const binding=x.settled(runId);
      x.ledger.recordReport(binding,{kind:"task",runId,summary,at:Date.now()});
      await x.tick();
    }
    for(let i=0;i<5&&!x.run("task-synthesis-human-hold-1");i++)await x.tick();
    assert.ok(x.run("task-synthesis-human-hold-1"));
    const synthesisJob=x.launches.find(j=>j.kind==="synthesis");
    assert.match(synthesisJob.prompt,/Root cause: contract typo/);
    assert.match(synthesisJob.prompt,/compatibility adapter/);
    const synthesis=x.settled("task-synthesis-human-hold-1");
    x.ledger.recordReport(synthesis,{kind:"task",runId:synthesis.runId,
      summary:"Use the compatibility adapter",at:Date.now()});
    await x.tick();await x.tick();
    assert.equal(x.wf().tasks.api.status,"held");
    assert.equal(x.status().enabled,false);
    assert.match(x.status().status,/Awaiting human resume/);
  }finally{x.close();}
});
test("Unconfigured Sol plan models fail closed without creating diagnosis Tasks",async()=>{
  const x=setup();
  try{
    await x.tick();
    const workflow=x.wf();
    x.store.act("project","orchestra","wf",workflow.revision,"human-request",{
      type:"request_intervention",interventionId:"human-hold",targetTaskId:"api",
      afterQcRunId:"next",instruction:"Compare approaches",
    });
    await x.tick();
    const planner=x.settled("plan-human-hold");
    x.ledger.recordReport(planner,{kind:"plan",runId:planner.runId,
      summary:"Try an unsupported diagnosis model",
      agents:[{id:"unsupported",title:"Unknown model",role:"architect",model:"other/unapproved"}],
      at:Date.now()});
    await x.tick();
    assert.equal(x.status().enabled,false);
    assert.match(x.status().status,/unconfigured diagnosis model/);
    assert.equal(x.wf().amendments[0].status,"planning");
    assert.equal(x.wf().definition.tasks.length,1);
  }finally{x.close();}
});

test("A failed QC becomes bounded evidence in a fresh implementation attempt",async()=>{
  const x=setup();
  try{
    await x.tick();await x.tick();
    x.settled("impl-api-1");await x.tick();await x.tick();
    const qc=x.settled("qc-api-1");
    x.ledger.recordReport(qc,{kind:"qc",runId:qc.runId,verdict:"fail",
      summary:"Contract header missing in response",at:Date.now()});
    await x.tick();
    assert.equal(x.wf().tasks.api.status,"ready");
    await x.tick();await x.tick();
    const rerun=x.launches.find(j=>j.runId==="impl-api-2");
    assert.ok(rerun,"New Pi session starts with next attempt identity");
    assert.match(rerun.prompt,/Contract header missing in response/);
    assert.match(rerun.prompt,/Prior evidence\/QC feedback/);
  }finally{x.close();}
});
test("The configured reviewer capacity also limits auto QC Sessions",()=>{
  const x=setup();
  try{
    const wf=structuredClone(x.wf());
    const task=structuredClone(wf.tasks.api);
    task.spec.id="other";task.spec.title="Another independent Task";
    wf.tasks.other=task;
    wf.definition.tasks.push(task.spec);
    for(const current of [wf.tasks.api,wf.tasks.other]){
      current.status="awaiting_qc";
      current.attempts=1;
      current.pendingWork={headSha:sha,criteriaRevision:0,attempt:1};
    }
    wf.definition.maxParallelByRole.reviewer=1;
    const busy=[{seat:"qc",workflowId:"wf",runId:"qc-api-1",phase:"running"}];
    assert.equal(planNext(wf,busy,{...config,workspaces:{...config.workspaces,other:"wt-other"}}),
      undefined);
  }finally{x.close();}
});
