import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {newWorkflow,applyAction,automaticTaskContract} from '../dist/core/workflow.js';
import {WorkflowStore} from '../dist/core/store.js';
import {automaticDiagnosisDirective,parseAutomaticDiagnosisPolicy} from '../dist/core/automatic-diagnosis.js';
import {parseAutopilotConfig} from '../dist/automation/ledger.js';
import {assertAutomaticDiagnosisJob} from '../dist/automation/host-port.js';
const at='2026-10-15T00:00:00.000Z',epoch=Date.parse(at),sha='a'.repeat(40);
const definition={id:'auto',title:'Bounded diagnostic test',maxQcRounds:5,
 maxParallelByRole:{implementer:2,reviewer:2,architect:2,planner:1},
 tasks:[{id:'a',title:'Synthetic task',role:'implementer',kind:'implementation',dependsOn:[]},
  {id:'dependent',title:'Blocked dependent',role:'implementer',kind:'implementation',dependsOn:[{taskId:'a',gate:'qc_passed'}]}]};
const profile={provider:'faux',model:'faux-1',effort:'low'};
const policy={afterFailures:1,maxModelRequests:12,maxToolCalls:30,maxDurationMs:60000,maxOutputTokens:1024};
const directive=automaticDiagnosisDirective(policy,{architect:profile,reviewer:profile,synthesis:profile});
const action=(w,a)=>applyAction(w,a,at);
function awaiting(w=newWorkflow(definition,at)){
 w=action(w,{type:'start',taskId:'a'});
 return action(w,{type:'implementation_finished',taskId:'a',headSha:sha,criteriaRevision:0,testsPassed:true});
}
function qc(w,verdict='fail',d=directive){return {type:'qc_finalized',taskId:'a',runId:'qc-a-'+w.tasks.a.attempts,
 headSha:sha,criteriaRevision:0,attempt:w.tasks.a.attempts,verdict,...(d?{automaticDiagnosis:d}:{})};}
test('ADR19 automatic diagnosis is strictly explicit, bounded, and Durable-only',()=>{
 assert.equal(parseAutomaticDiagnosisPolicy(undefined),undefined);
 for(const bad of [null,false,{},'on',{...policy,maxModelRequests:2},{...policy,maxModelRequests:Infinity},
  {...policy,maxDurationMs:900001},{...policy,maxOutputTokens:0},{...policy,maxEpisodes:2}])
  assert.throws(()=>parseAutomaticDiagnosisPolicy(bad));
 const cfg={runtime:'pi-web',workspaces:{a:'w'},models:{implementer:profile,qc:profile,architect:profile,planner:profile},
  test:{file:'node',args:[],timeoutMs:1000},maxAttempts:3,automaticDiagnosis:policy};
 assert.throws(()=>parseAutopilotConfig(cfg),/Durable/);
 assert.deepEqual(parseAutopilotConfig({...cfg,runtime:'durable'}).automaticDiagnosis,policy);
});
test('ADR19 explicit fail atomically holds Task and creates exactly two readonly diagnoses plus synthesis',()=>{
 const pending=awaiting(),next=action(pending,qc(pending));
 assert.equal(pending.tasks.a.status,'awaiting_qc','Input state must remain immutable');
 assert.equal(next.tasks.a.status,'held');assert.equal(next.tasks.dependent.status,'blocked');
 assert.equal(next.amendments.length,1);assert.equal(next.amendments[0].status,'activated');
 const tasks=Object.values(next.tasks).filter(t=>t.parentTaskId==='a');
 assert.equal(tasks.length,3);assert.equal(tasks.filter(t=>t.spec.kind==='diagnosis'&&t.status==='ready').length,2);
 assert.equal(tasks.find(t=>t.spec.kind==='synthesis').status,'blocked');
 assert.equal(next.amendments[0].automatic.deadline,epoch+60000);
 for(const t of tasks){const c=automaticTaskContract(next,t);assert.equal(c.budget.maxModelRequests,4);
  assert.equal(c.budget.maxToolCalls,10);assert.equal(c.budget.maxOutputTokens,1024);assert.equal(c.budget.deadline,epoch+60000);}
 assert.throws(()=>action(next,{type:'start',taskId:'a'}),/ready/);
});
test('ADR19 ordinary fail/pass/inconclusive and unsupported results never implicitly enable diagnosis',()=>{
 for(const verdict of ['fail','inconclusive','pass']){const w=awaiting(),out=action(w,qc(w,verdict,null));
  assert.equal(out.amendments.length,0);assert.equal(out.tasks.a.status,verdict==='pass'?'passed':'ready');}
 for(const verdict of ['pass','inconclusive']){const w=awaiting();assert.throws(()=>action(w,qc(w,verdict,directive)),/explicit failing/);}
});
test('ADR19 configured consecutive failure threshold is not carried over from another policy or inconclusive QC',()=>{
 const d=automaticDiagnosisDirective({...policy,afterFailures:2},directive.profiles);
 let w=awaiting();w=action(w,qc(w,'fail',d));assert.equal(w.tasks.a.status,'ready');
 w=awaiting(w);w=action(w,qc(w,'inconclusive',null));
 w=awaiting(w);w=action(w,qc(w,'fail',d));assert.equal(w.amendments.length,0);
 w=awaiting(w);w=action(w,qc(w,'fail',d));assert.equal(w.amendments.length,1);
});
test('ADR19 a human intervention wins over automatic failure escalation at the same QC boundary',()=>{
 let w=awaiting();w=action(w,{type:'request_intervention',interventionId:'human',targetTaskId:'a',afterQcRunId:'next',instruction:'Inspect first'});
 w=action(w,qc(w));assert.equal(w.tasks.a.status,'held');assert.equal(w.amendments.length,1);
 assert.equal(w.amendments[0].id,'human');assert.equal(w.tasks.a.automaticDiagnosisId,undefined);
});
test('ADR19 neither synthesis nor reconfiguration can create a second automatic episode for a Task',()=>{
 let w=awaiting();w=action(w,qc(w));const a=w.amendments[0];
 for(const t of Object.values(w.tasks).filter(t=>t.spec.kind==='diagnosis')){w=action(w,{type:'start',taskId:t.spec.id});w=action(w,{type:'complete',taskId:t.spec.id});}
 w=action(w,{type:'start',taskId:a.synthesisTaskId});w=action(w,{type:'complete',taskId:a.synthesisTaskId});
 assert.equal(w.tasks.a.status,'held');
 assert.throws(()=>action(w,{type:'resume_after_diagnosis',amendmentId:a.id,decision:'accept_pass'}),/failing QC/);
 w=action(w,{type:'resume_after_diagnosis',amendmentId:a.id,decision:'rework'});
 const changed=automaticDiagnosisDirective({...policy,maxModelRequests:15},directive.profiles);
 w=awaiting(w);w=action(w,qc(w,'fail',changed));assert.equal(w.amendments.length,1);assert.equal(w.tasks.a.automaticDiagnosisId,a.id);
});
test('ADR19 dynamic capacity or ID collision cannot partially commit a QC/automatic hold',()=>{
 const full={...definition,tasks:Array.from({length:510},(_,i)=>({id:'t-'+i,title:'t',kind:'implementation',role:'implementer',dependsOn:[]}))};
 full.tasks[0]={...definition.tasks[0]};const w=awaiting(newWorkflow(full,at));
 assert.throws(()=>action(w,qc(w)),/Task slots/);assert.equal(w.tasks.a.status,'awaiting_qc');assert.equal(w.revision,2);
 const fake={...directive,fingerprint:'0'.repeat(64)};assert.throws(()=>action(awaiting(),qc(awaiting(),'fail',fake)),/changed/);
});
test('ADR19 a persisted automatic boundary survives reopen and command replay with no duplicate episode',()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-diagnostic-cas-'));let store;
 try{
  store=new WorkflowStore(join(root,'workflow.sqlite'));let w=store.create('p','o',definition,at);
  w=store.act('p','o','auto',w.revision,'start',{type:'start',taskId:'a'},at);
  w=store.act('p','o','auto',w.revision,'work',{type:'implementation_finished',taskId:'a',headSha:sha,criteriaRevision:0,testsPassed:true},at);
  const report=qc(w),before=w.revision;w=store.act('p','o','auto',before,'qc',report,at);store.close();
  store=new WorkflowStore(join(root,'workflow.sqlite'));const repeated=store.act('p','o','auto',before,'qc',report,at);
  assert.equal(repeated.revision,w.revision);assert.equal(repeated.amendments.length,1);
  assert.equal(repeated.tasks.a.status,'held');assert.equal(repeated.amendments[0].automatic.deadline,epoch+60000);
  assert.throws(()=>store.act('p','o','auto',before,'qc',{...report,verdict:'pass'},at),/Command ID reused/);
 }finally{store?.close();rmSync(root,{recursive:true,force:true});}
});
test('ADR19 actual executor rejects erased/changed budgets, profile changes, expired deadline, or repeated child Run',()=>{
 let w=awaiting();w=action(w,qc(w));const t=Object.values(w.tasks).find(t=>t.spec.kind==='diagnosis');
 w=action(w,{type:'start',taskId:t.spec.id});const c=automaticTaskContract(w,w.tasks[t.spec.id]);
 const job={taskId:t.spec.id,kind:'diagnosis',model:c.model,diagnosticBudget:c.budget};
 assert.doesNotThrow(()=>assertAutomaticDiagnosisJob(job,w,epoch));
 for(const changed of [{...job,diagnosticBudget:undefined},{...job,model:{...profile,effort:'max'}},
  {...job,diagnosticBudget:{...c.budget,maxModelRequests:999}},{...job,kind:'implementation'}])
  assert.throws(()=>assertAutomaticDiagnosisJob(changed,w,epoch),/changed|refused/);
 assert.throws(()=>assertAutomaticDiagnosisJob(job,w,epoch+60000),/expired/);
 const retry=structuredClone(w);retry.tasks[t.spec.id].attempts=2;
 assert.throws(()=>assertAutomaticDiagnosisJob(job,retry,epoch),/authorized/);
});
