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
function setup(workflowDefinition=definition,settings=config){
  const dir=mkdtempSync(join(tmpdir(),"pi-mm-auto-"));
  const store=new WorkflowStore(join(dir,"workflow.sqlite"));
  const registry=new AgentRegistry(join(dir,"runs.sqlite"));
  const ledger=new AutopilotLedger(join(dir,"auto.sqlite"));
  store.create("project","orchestra",workflowDefinition);
  ledger.save("project","orchestra","wf",settings);
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

test("Dependent writer carries the exact already-QC-passed upstream commit",async()=>{
  const def=structuredClone(definition);
  def.tasks.push({id:"ui",title:"Implement UI integration",kind:"implementation",
    role:"implementer",dependsOn:[{taskId:"api",gate:"qc_passed"}]});
  const settings={...config,workspaces:{api:"linked-wt-api",ui:"linked-wt-ui"}};
  const x=setup(def,settings);
  try{
    await x.tick();await x.tick();
    assert.equal(x.wf().tasks.ui.status,"blocked");
    x.settled("impl-api-1");await x.tick();await x.tick();
    const qc=x.settled("qc-api-1");
    x.ledger.recordReport(qc,{kind:"qc",runId:qc.runId,verdict:"pass",
      summary:"API verified",at:Date.now()});
    await x.tick();
    assert.equal(x.wf().tasks.api.status,"passed");
    assert.equal(x.wf().tasks.ui.status,"ready");
    await x.tick();await x.tick();
    const child=x.launches.find(j=>j.taskId==="ui");
    assert.ok(child,"DAG admits a dependent implementation only after parent QC");
    assert.deepEqual(child.requiredAncestors,[sha]);
    assert.equal(child.workspaceId,"linked-wt-ui");
  }finally{x.close();}
});

test("Implementation and QC prompts include the same explicit acceptance contract",()=>{
  const x=setup();
  try{
    const workflow=x.wf();
    const task=structuredClone(workflow.tasks.api);
    task.spec.description="Expose the endpoint without breaking old clients";
    task.spec.acceptanceCriteria=["HTTP 200 for valid requests","Reject invalid tokens"];
    task.pendingWork={headSha:sha,attempt:1,criteriaRevision:0};
    const impl=buildJobPrompt(workflow,task,"implementation");
    const qc=buildJobPrompt(workflow,task,"qc");
    for(const text of [impl,qc]){
      assert.match(text,/HTTP 200 for valid requests/);
      assert.match(text,/Reject invalid tokens/);
      assert.match(text,/without breaking old clients/);
    }
    assert.match(qc,new RegExp(sha));
  }finally{x.close();}
});

test("Shutdown waits for in-flight verification and cannot commit a Task after stop",async()=>{
  const x=setup();
  try{
    await x.tick();await x.tick();
    x.settled("impl-api-1");
    let release;
    const verification=new Promise(resolve=>{release=resolve;});
    x.setVerification(verification);
    const running=x.tick();
    let drained=false;
    const stopped=x.engine.stop().then(()=>{drained=true;});
    await Promise.resolve();
    assert.equal(drained,false,"Stop must await the host verifier before closing SQLite");
    release({headSha:sha,clean:true,testsPassed:true,details:"completed during stop"});
    await Promise.all([running,stopped]);
    assert.equal(drained,true);
    assert.equal(x.wf().tasks.api.status,"running",
      "In-flight verification may settle, but no authoritative transition is committed after stop");
    assert.equal(x.run("impl-api-1").phase,"settled",
      "Durably settled Run can be recovered at next startup");
    await x.tick();
    assert.equal(x.wf().tasks.api.status,"running","Stopped runner rejects further ticks");
  }finally{x.close();}
});

test("Human QC intervention arriving during async host verification wins over stale automatic CAS",async()=>{
  const x=setup();
  try{
    await x.tick();await x.tick();
    x.settled("impl-api-1");
    let release;
    const pending=new Promise(resolve=>{release=resolve;});
    x.setVerification(pending);
    const checking=x.tick(); // host verification now suspends on the unsettled Promise
    await new Promise(resolve=>setImmediate(resolve));
    const before=x.wf();
    x.store.act("project","orchestra","wf",before.revision,"racing-human-hold",{
      type:"request_intervention",interventionId:"racing-hold",targetTaskId:"api",
      afterQcRunId:"next",instruction:"Investigate after the next independent QC",
    });
    release({headSha:sha,clean:true,testsPassed:true,details:"host checked snapshot"});
    await checking;
    assert.equal(x.status().enabled,true,"Revision conflict is retried rather than bypassing the human hold");
    assert.equal(x.wf().tasks.api.status,"running");
    x.setVerification({headSha:sha,clean:true,testsPassed:true,details:"host checked snapshot"});
    for(let i=0;i<8&&x.wf().tasks.api.status!=="awaiting_qc";i++)await x.tick();
    assert.equal(x.wf().tasks.api.status,"awaiting_qc");
    for(let i=0;i<8&&!x.run("qc-api-1");i++)await x.tick();
    const qc=x.settled("qc-api-1");
    x.ledger.recordReport(qc,{kind:"qc",runId:"qc-api-1",verdict:"pass",
      summary:"Actual code passed independent checks",at:Date.now()});
    for(let i=0;i<6&&x.wf().tasks.api.status!=="held";i++)await x.tick();
    assert.equal(x.wf().tasks.api.status,"held");
    assert.equal(x.wf().amendments[0].status,"planning");
    assert.equal(x.wf().tasks.api.lastQc.verdict,"pass");
    assert.equal(x.wf().tasks.api.qcRounds,1);
    assert.ok(x.launches.some(j=>j.kind==="planning"),
      "Sol planning may continue but cannot void the held QC evidence");
  }finally{x.close();}
});

test("Audit G02: per-Task implementer override never changes the QC model",async()=>{
  const task={...definition.tasks[0],model:"special/implementation"};
  const def={...definition,tasks:[task]};
  const qcModel={provider:"independent",model:"reviewer-1",effort:"high"};
  const x=setup(def,{...config,models:{...config.models,qc:qcModel}});
  try{
    await x.tick();await x.tick();
    assert.equal(x.launches[0].model.provider,"special");
    x.settled("impl-api-1");await x.tick();await x.tick();
    const qc=x.launches.find(job=>job.kind==="qc");
    assert.deepEqual(qc.model,qcModel);
  }finally{x.close();}
});
test("Audit F18: final QC includes later source acceptance criteria without truncation",()=>{
  const x=setup();
  try{
    const w=structuredClone(x.wf());
    for(let i=1;i<=3;i++){
      const id="source-"+i;
      const spec={id,title:"Feature "+i,kind:"implementation",role:"implementer",
        description:"x".repeat(3500),acceptanceCriteria:["ACCEPTANCE-MARKER-"+i],
        dependsOn:[]};
      w.tasks[id]={spec,status:"passed",attempts:1,qcRounds:1,
        lastQc:{runId:"qc-"+id+"-1",verdict:"pass",
          headSha:sha,criteriaRevision:0,attempt:1}};
    }
    const spec={id:"mm-final-integration",title:"Final",kind:"implementation",
      role:"implementer",systemPurpose:"final-integration",dependsOn:[]};
    const task={spec,status:"awaiting_qc",attempts:1,qcRounds:0,
      pendingWork:{headSha:sha,attempt:1,criteriaRevision:0}};
    const prompt=buildJobPrompt(w,task,"qc");
    assert.match(prompt,/ACCEPTANCE-MARKER-1/);
    assert.match(prompt,/ACCEPTANCE-MARKER-3/);
    assert.ok(prompt.length<16000);
  }finally{x.close();}
});

test("Audit F08: CAS conflict reuses persisted host verification, not a second test outcome",async()=>{
  const x=setup();
  try{
    await x.tick();await x.tick();
    x.settled("impl-api-1");
    let release;
    const verification=new Promise(resolve=>{release=resolve;});
    x.setVerification(verification);
    const checking=x.tick();
    await new Promise(resolve=>setImmediate(resolve));
    const before=x.wf();
    x.store.act("project","orchestra","wf",before.revision,"human-hold",{
      type:"request_intervention",interventionId:"human-hold",
      targetTaskId:"api",afterQcRunId:"next",instruction:"Review after QC",
    });
    release({headSha:sha,clean:true,testsPassed:true,
      details:"stdoutSha256=first-deterministic-capture"});
    await checking;
    assert.equal(x.status().enabled,true);
    assert.equal(x.wf().tasks.api.status,"running");
    x.setVerification({headSha:sha,clean:true,testsPassed:false,
      details:"stdoutSha256=changed-on-a-second-run"});
    for(let i=0;i<10&&x.wf().tasks.api.status!=="awaiting_qc";i++)await x.tick();
    assert.equal(x.status().enabled,true);
    assert.equal(x.wf().tasks.api.status,"awaiting_qc");
    assert.equal(x.wf().tasks.api.pendingWork.headSha,sha);
    assert.match(x.ledger.evidence(x.run("impl-api-1")).text,
      /first-deterministic-capture/);
  }finally{x.close();}
});

test("Audit F18: paged final-QC prompt keeps source contracts retrievable beyond text budget",()=>{
 const def={...definition,id:"paging-wf",tasks:Array.from({length:8},(_,i)=>({
   id:"source-"+i,title:"Source "+i,kind:"implementation",role:"implementer",
   description:"D".repeat(3900),acceptanceCriteria:["Acceptance "+i],dependsOn:[],
 }))};
 const x=setup();
 try{
  const w=structuredClone(x.wf());
  w.tasks=Object.fromEntries(def.tasks.map(t=>[t.id,{
    spec:t,status:"passed",attempts:1,qcRounds:1,
    lastQc:{runId:"qc-"+t.id+"-1",headSha:sha,
      criteriaRevision:0,attempt:1,verdict:"pass"},
  }]));
  w.tasks["mm-final-integration"]={
    spec:{id:"mm-final-integration",title:"Final",kind:"implementation",
      role:"implementer",systemPurpose:"final-integration",dependsOn:[]},
    status:"awaiting_qc",attempts:1,qcRounds:0,
    pendingWork:{headSha:sha,criteriaRevision:0,attempt:1},
  };
  assert.throws(()=>buildJobPrompt(w,w.tasks["mm-final-integration"],"qc"),/Unsafe automatic prompt length/);
  const prompt=buildJobPrompt(w,w.tasks["mm-final-integration"],"qc",[],true);
  assert.ok(prompt.length<16000);
  assert.match(prompt,/mm_final_qc_contract/);
  assert.match(prompt,/index 0 through 7/);
 }finally{x.close();}
});

test("G06: per-workflow admission quota limits new sessions without stranding running tasks",()=>{
 const x=setup();
 try{
  const w=structuredClone(x.wf());
  const t=structuredClone(w.tasks.api);t.spec.id="other";t.spec.title="Other";
  w.tasks.other=t;w.definition.tasks.push(t.spec);
  const capped={...config,workspaces:{api:"wt-api",other:"wt-other"},
    maxConcurrentRuns:1};
  assert.deepEqual(planNext(w,[],capped),{action:"start",taskId:"api"});
  w.tasks.api.status="running";w.tasks.api.attempts=1;
  assert.deepEqual(planNext(w,[],capped),{
    action:"launch",taskId:"api",kind:"implementation",
    runId:"impl-api-1",seat:"implementer"});
  assert.equal(planNext(w,[{workflowId:"wf",seat:"implementer",runId:"impl-api-1",
    phase:"running",taskId:"api"}],capped),undefined);
 }finally{x.close();}
});
test("G06: configured runtime and managed Worktree budgets are finite",()=>{
 for(const [field,value] of [["maxConcurrentRuns",0],["maxConcurrentRuns",33],
    ["maxManagedWorktrees",0],["maxManagedWorktrees",65]]){
  assert.throws(()=>parseAutopilotConfig({...config,[field]:value}),/must be/);
 }
 assert.equal(parseAutopilotConfig({...config,maxConcurrentRuns:2,
   maxManagedWorktrees:16}).maxConcurrentRuns,2);
});
