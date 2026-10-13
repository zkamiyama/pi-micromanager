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
function fixture(limits){
 const root=mkdtempSync(join(tmpdir(),'mm-runtime-proof-')),cwd=join(root,'work');mkdirSync(cwd);writeFileSync(join(cwd,'source.txt'),'source');
 const agents=new AgentRegistry(join(root,'agents.sqlite')),ledger=new AutopilotLedger(join(root,'ledger.sqlite'));
 const faux=fauxProvider({tokensPerSecond:100000}),models=createModels();models.setProvider(faux.provider);
 const events=[];
 const callbacks={dataDirectory:root,agents,ledger,models,...(limits?{limits}:{}),
  activity(b,e){events.push(e);agents.record(b,e);},changed(){},report(b,r){ledger.recordReport(b,r);},wake(){}};
 let host=new DurableRunHost(callbacks);
 const reservation={projectId:'p',orchestraWorkspaceId:'o',workflowId:'wf',taskId:'a',runId:'qc-a-1',workspaceId:'wt',seat:'qc',requestId:'auto:q'};
 const launch={reservation,cwd,kind:'qc',model:{provider:'faux',model:'faux-1'},prompt:'Review source and report.'};
 const current=()=>agents.getRun('p','o','wf','qc-a-1');
 const wait=async f=>{const end=Date.now()+12000;while(Date.now()<end){const r=f();if(r)return r;await new Promise(r=>setTimeout(r,20));}throw Error('Runtime proof condition timed out');};
 return {agents,ledger,faux,events,launch,current,wait,get host(){return host;},async reopen(){await host.close();host=new DurableRunHost(callbacks);},async close(){await host.close();agents.close();ledger.close();rmSync(root,{recursive:true,force:true});}};
}
test('S01 real Harness: provisional QC PASS followed by terminal provider error never settles successfully',async()=>{
 const x=fixture();try{
 x.faux.setResponses([fauxAssistantMessage([fauxToolCall('mm_qc_report',{verdict:'pass',summary:'Provisional result'},{id:'report'})],{stopReason:'toolUse'}),
  fauxAssistantMessage([fauxText('Provider rejected final request')],{stopReason:'error',errorMessage:'Invalid request body'})]);
 await x.host.launch(x.launch);await x.wait(()=>x.current()?.phase==='uncertain');
 assert.equal(x.ledger.report(x.current()).verdict,'pass');
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
