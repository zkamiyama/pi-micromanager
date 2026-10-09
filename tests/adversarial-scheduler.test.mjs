/** Adversarial scheduling tests: exact role/seat capacity, reentrancy,
 * interleaved QC, read-only intervention planners, and randomized DAG progress.
 * No live provider, private GitHub state, or destructive external operations. */
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {newWorkflow,applyAction} from "../dist/core/workflow.js";
import {WorkflowStore} from "../dist/core/store.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {AutopilotEngine,planNext} from "../dist/automation/engine.js";

const NOW="2026-10-10T00:00:00.000Z";
const model={provider:"mock",model:"fixed"};
const roles={implementer:4,reviewer:2,architect:2,planner:1};
const policy={
  models:{implementer:model,qc:model,architect:model,planner:model},
  workspaces:{},test:{file:"node",args:["--test"],timeoutMs:15000},maxAttempts:3,
};
function defOf(tasks,capacity=roles,id="stress"){
  return {id,title:"Adversarial execution",maxQcRounds:3,
    maxParallelByRole:{...capacity},tasks};
}
function impl(id,dependsOn=[]){
  return {id,title:id,kind:"implementation",role:"implementer",
    description:"Build "+id,acceptanceCriteria:["Test "+id],
    dependsOn};
}
const action=(w,a)=>applyAction(w,a,NOW);
const finished=(task,attempt=1)=>({type:"implementation_finished",
  taskId:task,headSha:sha(task,attempt),criteriaRevision:0,testsPassed:true});
const qc=(task,attempt=1,verdict="pass")=>({type:"qc_finalized",
  taskId:task,runId:"qc-"+task+"-"+attempt,headSha:sha(task,attempt),
  criteriaRevision:0,attempt,verdict});
const sha=(id,attempt)=>createHash("sha256").update(id+"#"+attempt).digest("hex").slice(0,40);
const models={...policy.models};
function configFor(tasks){return {...policy,workspaces:Object.fromEntries(
  tasks.filter(t=>t.kind==="implementation").map(t=>[t.id,"wt-"+t.id]))};}

test("Reviewer capacity counts a real QC seat before admitting a read-only investigator",()=>{
  const tasks=[impl("alpha"),impl("beta")],cfg=configFor(tasks);
  let w=newWorkflow(defOf(tasks,{...roles,reviewer:1}),NOW);
  w=action(w,{type:"start",taskId:"alpha"});
  w=action(w,{type:"start",taskId:"beta"});
  w=action(w,finished("alpha"));
  w=action(w,finished("beta"));
  w=action(w,{type:"arm_diagnosis",targetTaskId:"alpha",amendmentId:"review",
    afterQcRunId:"next",agents:[{id:"read",title:"Independent review",
      role:"reviewer",model:"mock/fixed"}]});
  w=action(w,qc("alpha"));
  assert.equal(w.tasks["diag-review-read"].status,"ready");
  const inFlight=[{seat:"qc",runId:"qc-beta-1",phase:"running",workflowId:w.definition.id}];
  assert.equal(planNext(w,inFlight,cfg),undefined,
    "Active QC owns the sole reviewer seat; diagnosis must not start");
  w=action(w,{type:"start",taskId:"diag-review-read"});
  assert.equal(planNext(w,[],cfg),undefined,
    "Reserved but not yet launched reviewer diagnosis blocks another QC");
});

test("Planner capacity includes live Sol planning sessions when synthesis becomes ready",()=>{
  const tasks=[{id:"synthesize",title:"Synthesis",kind:"synthesis",role:"planner",dependsOn:[]}];
  const w=newWorkflow(defOf(tasks,{...roles,planner:1}),NOW);
  assert.deepEqual(planNext(w,[],configFor(tasks)),
    {action:"start",taskId:"synthesize"});
  const live=[{seat:"planner",runId:"plan-a",phase:"running",workflowId:w.definition.id}];
  assert.equal(planNext(w,live,configFor(tasks)),undefined,
    "Synthesis must not steal the only planner slot from a human intervention");
});

function harness(def,settings=configFor(def.tasks)){
 const dir=mkdtempSync(join(tmpdir(),"mm-adversarial-"));
 const store=new WorkflowStore(join(dir,"wf.sqlite"));
 const registry=new AgentRegistry(join(dir,"runs.sqlite"));
 const ledger=new AutopilotLedger(join(dir,"ledger.sqlite"));
 store.create("p","o",def);
 ledger.save("p","o",def.id,settings);
 ledger.setStatus("p","o",def.id,true,"test-running");
 const launches=[];
 let commandSerial=0;
 const verify=(binding)=>({
   headSha:sha(binding.taskId,Number(binding.runId.split("-").at(-1))),
   clean:true,testsPassed:true,details:"strict fake SHA and test checks",
 });
 const engine=new AutopilotEngine(store,registry,ledger,{
   async launch(job){
     launches.push(job);
     const reservation={projectId:"p",orchestraWorkspaceId:"o",workflowId:def.id,
       taskId:job.taskId,runId:job.runId,workspaceId:job.workspaceId,
       seat:job.seat,requestId:"auto:"+job.runId};
     registry.reserve(reservation);
     registry.assign(reservation,"pi-"+job.runId);
     const bound=registry.get("p","o","pi-"+job.runId);
     registry.update(bound,"running",{provider:job.model.provider,model:job.model.model});
     return registry.get("p","o","pi-"+job.runId);
   },
   async verify(binding){return verify(binding);},
   async checkSnapshot(binding,expected){
     if(verify(binding).headSha!==expected)throw Error("Immutable snapshot mismatch");
   },
 });
 const wf=()=>store.get("p","o",def.id);
 const run=(id)=>registry.getRun("p","o",def.id,id);
 const jobs=()=>registry.list("p","o","all").filter(b=>b.workflowId===def.id);
 const status=()=>ledger.get("p","o",def.id);
 const act=(a,key)=>store.act("p","o",def.id,wf().revision,
   key??"test-"+(++commandSerial),a);
 const settle=(id,kind="implementation",verdict="pass")=>{
   const b=run(id);
   if(!b||b.phase!=="running")throw Error("Cannot settle non-running "+id);
   if(kind==="qc")ledger.recordReport(b,{kind:"qc",runId:id,verdict,
     summary:"Independent QC="+verdict,at:Date.now()});
   else if(kind==="planning")ledger.recordReport(b,{kind:"plan",runId:id,
     summary:"Valid investigation plan",agents:[{
       id:"architect",title:"Inspect architecture",role:"architect",model:"mock/fixed",
     }],at:Date.now()});
   else if(kind==="diagnosis"||kind==="synthesis")ledger.recordReport(b,{
     kind:"task",runId:id,summary:"Independent investigation result",at:Date.now()});
   registry.record(b,{kind:"agent_settled",sequence:1,at:Date.now(),text:"Agent settled"});
   return run(id);
 };
 return {dir,engine,store,registry,ledger,launches,wf,run,jobs,status,settle,act,
   tick:()=>engine.tick(status()),
   close(){ledger.close();registry.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test("Two concurrent human interventions use one planner seat, then recover the other",async()=>{
 const tasks=[impl("alpha"),impl("beta")],def=defOf(tasks,{...roles,planner:1},"two-interventions");
 const x=harness(def);
 try{
   x.act({type:"request_intervention",interventionId:"first",
     targetTaskId:"alpha",afterQcRunId:"next",instruction:"Analyze alpha"});
   x.act({type:"request_intervention",interventionId:"second",
     targetTaskId:"beta",afterQcRunId:"next",instruction:"Analyze beta"});
   await x.tick();await x.tick();await x.tick();
   assert.equal(x.jobs().filter(b=>b.seat==="planner"&&b.phase==="running").length,1,
     "Only one Sol may plan interventions when planner capacity is one");
   assert.equal(x.launches.filter(j=>j.kind==="planning").length,1);
   x.settle("plan-first","planning");
   await x.tick();
   for(let i=0;i<8&&!x.run("plan-second");i++)await x.tick();
   assert.ok(x.run("plan-second"),
     "The second waiting human intervention is admitted after the first settled");
   assert.equal(x.launches.filter(j=>j.kind==="planning").length,2);
 }finally{x.close();}
});

function rng(seed){
 let value=seed>>>0;
 return ()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/4294967296;};
}
async function execute(seed,taskCount,capacity){
 const rand=rng(seed);
 const tasks=Array.from({length:taskCount},(_,i)=>impl("task-"+String(i).padStart(3,"0")));
 const wfdef=defOf(tasks,capacity,"random-"+seed);
 const x=harness(wfdef);
 let peakImpl=0,peakQc=0,settled=0,failRounds=0;
 try{
   for(let tick=0;tick<1600;tick++){
     await x.tick();
     const snapshot=x.wf();
     const bindings=x.jobs();
     const imp=bindings.filter(b=>b.seat==="implementer"&&b.phase==="running");
     const reviews=bindings.filter(b=>b.seat==="qc"&&b.phase==="running");
     peakImpl=Math.max(peakImpl,imp.length);
     peakQc=Math.max(peakQc,reviews.length);
     assert.ok(imp.length<=capacity.implementer,
       "Exceeded implementation parallel capacity at seed "+seed+" tick "+tick);
     assert.ok(reviews.length<=capacity.reviewer,
       "Exceeded independent QC parallel capacity at seed "+seed+" tick "+tick);
     const implState=Object.values(snapshot.tasks).filter(t=>
       t.status==="running"&&t.spec.role==="implementer");
     assert.ok(implState.length<=capacity.implementer);
     assert.equal(new Set(imp.map(b=>b.workspaceId)).size,imp.length,
       "Concurrent modifying Pi Sessions cannot share a Worktree");
     const running=bindings.filter(b=>b.phase==="running");
     // First force both resource pools to their declared limits, rather
     // than randomly completing a Task before saturation can be observed.
     // Then freely permute completion order with a deterministic PRNG.
     let subset;
     if(peakImpl<Math.min(capacity.implementer,taskCount)){
       subset=[];
     }else if(peakQc<Math.min(capacity.reviewer,taskCount)){
       subset=running.filter(b=>b.seat==="implementer");
     }else{
       subset=running.filter(()=>rand()<0.17);
       if(subset.length===0&&tick%13===0&&running.length)
         subset.push(running[Math.floor(rand()*running.length)]);
     }
     for(const b of subset){
       if(b.phase!=="running")continue;
       const attempt=Number(b.runId.split("-").at(-1));
       const hash=createHash("sha1").update(b.taskId).digest()[0];
       const fail=b.seat==="qc"&&hash%7===0&&attempt===1;
       if(fail)failRounds++;
       x.settle(b.runId,b.seat==="qc"?"qc":"implementation",fail?"fail":"pass");
       settled++;
     }
     if(!x.status().enabled)break;
   }
   const out=x.wf();
   assert.equal(x.status().enabled,false,"Scheduler did not finish under randomized interleavings");
   assert.equal(Object.values(out.tasks).filter(t=>t.status==="passed").length,taskCount,
     "All independent Task QCs must pass eventually");
   assert.equal(new Set(x.launches.map(job=>job.runId)).size,x.launches.length,
     "Never duplicate a hosted Pi Run identity");
   assert.ok(peakImpl>=Math.min(capacity.implementer,taskCount),
     "Independent workers were not filled to permitted peak parallelism");
   assert.ok(peakQc>=Math.min(capacity.reviewer,taskCount),
     "Independent QC slots were not filled to permitted peak parallelism");
   assert.equal(x.launches.filter(x=>x.kind==="qc").length,taskCount+failRounds);
   return {seed,taskCount,peakImpl,peakQc,settled,failRounds};
 }finally{x.close();}
}

test("32 independent DAG branches saturate 8 implementation and 4 QC seats, despite mixed completion order",async()=>{
 const result=await execute(983021,32,{implementer:8,reviewer:4,architect:2,planner:1});
 assert.equal(result.peakImpl,8);
 assert.equal(result.peakQc,4);
});

test("Reproducible stress: eight seeded interleavings, isolated Worktrees and bounded fresh QC retries",async()=>{
 for(let seed=1;seed<=8;seed++)
   await execute(seed*7919,16,{implementer:4,reviewer:2,architect:2,planner:1});
});

test("Workflow import rejects task kind/role combinations that bypass seat accounting",()=>{
 const bad=[
   {kind:"implementation",role:"reviewer"},
   {kind:"implementation",role:"planner"},
   {kind:"diagnosis",role:"implementer"},
   {kind:"synthesis",role:"architect"},
 ];
 for(const combination of bad){
   const input=defOf([{...impl("bad"),...combination}]);
   assert.throws(()=>newWorkflow(input,NOW),
     e=>e.code==="invalid_role",JSON.stringify(combination));
 }
 const valid=defOf([
  impl("worker"),
  {id:"diagnose",title:"Review",kind:"diagnosis",role:"reviewer",dependsOn:[]},
  {id:"synthesize",title:"Summary",kind:"synthesis",role:"planner",dependsOn:[]},
 ]);
 assert.doesNotThrow(()=>newWorkflow(valid,NOW));
});

test("Reentrant scheduler ticks cannot duplicate Task admissions or launch the same Pi Run",async()=>{
 const x=harness(defOf([impl("single")],{...roles,implementer:1},"single"));
 try{
   await Promise.all(Array.from({length:120},()=>x.tick()));
   assert.equal(x.wf().tasks.single.attempts,1);
   assert.equal(x.launches.length,0,"The first wave performs one CAS admission");
   await Promise.all(Array.from({length:120},()=>x.tick()));
   assert.equal(x.launches.length,1,"The next wave opens one and only one Pi Session");
   assert.equal(x.run("impl-single-1").phase,"running");
   await Promise.all(Array.from({length:120},()=>x.tick()));
   assert.equal(x.launches.length,1,"A third wave cannot duplicate the hosted Run");
 }finally{x.close();}
});

test("Four investigators use maximum 2 architect + 1 reviewer slots without oversubscription",()=>{
 const def=defOf([impl("root")],
  {implementer:1,reviewer:1,architect:2,planner:1},"diagnostic-pool");
 let w=newWorkflow(def,NOW);
 w=action(w,{type:"start",taskId:"root"});
 w=action(w,finished("root"));
 w=action(w,{type:"arm_diagnosis",amendmentId:"four",targetTaskId:"root",
  afterQcRunId:"next",agents:[
   {id:"architect-a",title:"Architecture one",role:"architect",model:"mock/fixed"},
   {id:"architect-b",title:"Architecture two",role:"architect",model:"mock/fixed"},
   {id:"reviewer-a",title:"Review one",role:"reviewer",model:"mock/fixed"},
   {id:"reviewer-b",title:"Review two",role:"reviewer",model:"mock/fixed"},
  ]});
 w=action(w,qc("root",1,"fail"));
 assert.equal(w.tasks.root.status,"held");
 let peakArchitect=0,peakReviewer=0,launches=0;
 const bindings=[];
 const cfg=configFor([impl("root")]);
 for(let step=0;step<75;step++){
   const active=Object.values(w.tasks).filter(t=>t.status==="running"&&
     t.spec.kind==="diagnosis");
   const architects=active.filter(t=>t.spec.role==="architect").length;
   const reviewers=active.filter(t=>t.spec.role==="reviewer").length;
   peakArchitect=Math.max(peakArchitect,architects);
   peakReviewer=Math.max(peakReviewer,reviewers);
   assert.ok(architects<=2&&reviewers<=1,"Diagnostic role quota exceeded");
   const next=planNext(w,bindings,cfg);
   if(next?.action==="start"){
     w=action(w,{type:"start",taskId:next.taskId});
     continue;
   }
   if(next?.action==="launch"){
     bindings.push({workflowId:def.id,taskId:next.taskId,seat:next.seat,
       runId:next.runId,phase:"running"});
     launches++;
     continue;
   }
   const running=Object.values(w.tasks).find(t=>
     t.status==="running"&&t.spec.kind==="diagnosis");
   if(running){
     const bound=bindings.find(x=>x.taskId===running.spec.id);
     if(!bound)throw Error("Running investigator was not admitted");
     bound.phase="settled";
     w=action(w,{type:"complete",taskId:running.spec.id});
     continue;
   }
   const diag=Object.values(w.tasks).filter(t=>t.spec.kind==="diagnosis");
   if(diag.length===4&&diag.every(t=>t.status==="done"))break;
   throw Error("Investigator deadlock: "+JSON.stringify(Object.values(w.tasks)
     .map(t=>[t.spec.id,t.status])));
 }
 const diagnostic=Object.values(w.tasks).filter(t=>t.spec.kind==="diagnosis");
 assert.equal(diagnostic.length,4);
 assert.ok(diagnostic.every(t=>t.status==="done"));
 assert.equal(launches,4);
 assert.equal(peakArchitect,2);
 assert.equal(peakReviewer,1);
 assert.equal(w.tasks["synthesis-four"].status,"ready");
 assert.equal(w.tasks.root.status,"held",
   "The human barrier must remain until synthesis and explicit approval");
});
