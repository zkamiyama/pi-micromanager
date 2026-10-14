import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall,fauxText} from '@earendil-works/pi-ai/providers/faux';
import {AgentRegistry} from '../dist/runtime/registry.js';
import {AutopilotLedger} from '../dist/automation/ledger.js';
import {DurableRunHost} from '../dist/runtime/durable-runner.js';
import {DEFAULT_LIMITS} from '../dist/security/run-safety.js';
function fixture(limits,lifetimeSignal,tokensPerSecond=100000,kind='qc'){
 const root=mkdtempSync(join(tmpdir(),'mm-runtime-proof-')),cwd=join(root,'work');mkdirSync(cwd);writeFileSync(join(cwd,'source.txt'),'source');
 const agents=new AgentRegistry(join(root,'agents.sqlite')),ledger=new AutopilotLedger(join(root,'ledger.sqlite'));
 const faux=fauxProvider({tokensPerSecond}),models=createModels();models.setProvider(faux.provider);
 const events=[];
 const callbacks={dataDirectory:root,agents,ledger,models,lifetimeSignal,...(limits?{limits}:{}),
  activity(b,e){events.push(e);agents.record(b,e);},changed(){},report(b,r){ledger.recordReport(b,r);},wake(){}};
 let host=new DurableRunHost(callbacks);
 const planning=kind==='planning',runId=planning?'plan-a-1':'qc-a-1';
 const reservation={projectId:'p',orchestraWorkspaceId:'o',workflowId:'wf',taskId:'a',
  runId,workspaceId:'wt',seat:planning?'planner':'qc',requestId:'auto:'+runId};
 const launch={reservation,cwd,kind,model:{provider:'faux',model:'faux-1'},prompt:'Review source and report.'};
 const current=()=>agents.getRun('p','o','wf',runId);
 const wait=async f=>{const end=Date.now()+12000;while(Date.now()<end){const r=f();if(r)return r;await new Promise(r=>setTimeout(r,20));}throw Error('Runtime proof condition timed out');};
 return {agents,ledger,faux,events,launch,current,wait,get host(){return host;},async reopen(signal){await host.close();if(signal)callbacks.lifetimeSignal=signal;host=new DurableRunHost(callbacks);},async close(){await host.close();agents.close();ledger.close();rmSync(root,{recursive:true,force:true});}};
}
test('S01 real Harness: provisional QC PASS followed by terminal provider error never settles successfully',async()=>{
 const x=fixture();try{
 x.faux.setResponses([fauxAssistantMessage([fauxToolCall('mm_qc_report',{verdict:'pass',summary:'Provisional result'},{id:'report'})],{stopReason:'toolUse'}),
  fauxAssistantMessage([fauxText('Provider rejected final request')],{stopReason:'error',errorMessage:'Invalid request body'})]);
 await x.host.launch(x.launch);await x.wait(()=>x.current()?.phase==='uncertain');
 assert.equal(x.ledger.report(x.current()).verdict,'pass');
 assert.throws(()=>x.host.assertProvedCompleted(x.current()),/persisted successful/);
 assert.equal(x.events.some(e=>e.kind==='agent_settled'&&e.text==='Agent settled'),false);
 const count=x.faux.state.callCount;await x.reopen();await assert.rejects(x.host.reconnect(x.current(),x.launch.cwd,'qc'),/not successful/);assert.equal(x.faux.state.callCount,count);
 }finally{await x.close();}
});
test('S03 real Harness: model request budget is enforced before a second provider call',async()=>{
 const x=fixture({...DEFAULT_LIMITS,maxModelRequests:1});try{
 x.faux.setResponses([fauxAssistantMessage([fauxToolCall('mm_qc_report',{verdict:'pass',summary:'Provisional result'},{id:'report'})],{stopReason:'toolUse'}),fauxAssistantMessage('Should never be requested')]);
 await x.host.launch(x.launch);await x.wait(()=>x.current()?.phase==='uncertain');assert.equal(x.faux.state.callCount,1);
 assert.equal(x.events.some(e=>e.kind==='agent_settled'&&e.text==='Agent settled'),false);
 }finally{await x.close();}
});
test('S01 real Harness: proved normal completion still settles once and reconnect makes no provider request',async()=>{
 const x=fixture();try{x.faux.setResponses([fauxAssistantMessage([fauxToolCall('mm_qc_report',{verdict:'pass',summary:'Reviewed exact source'},{id:'report'})],{stopReason:'toolUse'}),fauxAssistantMessage('Done')]);
 await x.host.launch(x.launch);await x.wait(()=>x.current()?.phase==='settled');assert.equal(x.faux.state.callCount,2);await x.reopen();assert.equal(await x.host.reconnect(x.current(),x.launch.cwd,'qc'),'settled');assert.equal(x.faux.state.callCount,2);
 }finally{await x.close();}
});

test('S03 real Harness: tool budget exhaustion invalidates an earlier QC PASS across restart',async()=>{
 const x=fixture({...DEFAULT_LIMITS,maxToolCalls:1});
 try{
  x.faux.setResponses([
   fauxAssistantMessage([
    fauxToolCall('mm_qc_report',{verdict:'pass',summary:'Provisional before exhaustion'},{id:'early-report'}),
    fauxToolCall('read',{path:join(x.launch.cwd,'source.txt')},{id:'over-budget'}),
   ],{stopReason:'toolUse'}),
   fauxAssistantMessage('Must not rescue an exhausted run'),
  ]);
  await x.host.launch(x.launch);
  await x.wait(()=>x.current()?.phase==='uncertain');
  assert.equal(x.ledger.report(x.current()).verdict,'pass');
  assert.equal(x.faux.state.callCount,1,'No later provider request after the failed budget latch');
  assert.equal(x.events.some(e=>e.kind==='agent_settled'&&e.text==='Agent settled'),false);
  await x.reopen();
  await assert.rejects(x.host.reconnect(x.current(),x.launch.cwd,'qc'),/not successful/);
  assert.equal(x.faux.state.callCount,1);
 }finally{await x.close();}
});


test('#80 Durable API: lifetime loss joins a delayed provider and cannot resume it under a fresh owner', {timeout:8000}, async()=>{
 const lifetime=new AbortController(),x=fixture(undefined,lifetime.signal,10);
 try{
  x.faux.setResponses([fauxAssistantMessage('Delayed provider response '.repeat(500))]);
  await x.host.launch(x.launch);await x.wait(()=>x.faux.state.callCount===1);
  lifetime.abort(new Error('Synthetic ownership loss'));await x.host.close();
  assert.equal(x.current().abortRequested,1);assert.equal(x.current().phase,'uncertain');
  assert.equal(x.events.some(e=>e.kind==='agent_settled'&&e.text==='Agent settled'),false);
  const count=x.faux.state.callCount;
  await x.reopen(new AbortController().signal);
  await assert.rejects(x.host.reconnect(x.current(),x.launch.cwd,'qc'),/not successful/);
  assert.equal(x.faux.state.callCount,count);
 }finally{await x.close();}
});

test('S01 planning: provisional typed Plan followed by provider failure stays non-authoritative after restart',async()=>{
 const x=fixture(undefined,undefined,100000,'planning');
 try{
  x.faux.setResponses([
   fauxAssistantMessage([fauxToolCall('mm_plan_intervention',{
     summary:'Provisional plan before terminal failure',
     agents:[{id:'review',title:'Review independently',role:'reviewer',model:'faux/faux-1'}]},
     {id:'provisional-plan'})],{stopReason:'toolUse'}),
   fauxAssistantMessage([fauxText('Provider failed after the plan tool')],
     {stopReason:'error',errorMessage:'Synthetic provider rejected the request'}),
  ]);
  await x.host.launch(x.launch);
  await x.wait(()=>x.current()?.phase==='uncertain');
  assert.equal(x.ledger.report(x.current())?.kind,'plan');
  assert.throws(()=>x.host.assertProvedCompleted(x.current()),/persisted successful/);
  assert.equal(x.events.some(e=>e.kind==='agent_settled'&&e.text==='Agent settled'),false);
  const count=x.faux.state.callCount;
  await x.reopen();
  await assert.rejects(x.host.reconnect(x.current(),x.launch.cwd,'planning'),/not successful/);
  assert.equal(x.faux.state.callCount,count,'Failed Plan must not restart its model');
 }finally{await x.close();}
});
