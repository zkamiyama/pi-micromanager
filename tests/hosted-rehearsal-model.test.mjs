import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {InMemoryCredentialStore,Type} from '@earendil-works/pi-ai';
import {installRehearsalModels} from '../scripts/hosted-e2e-fixture-model.mjs';

const fixture='examples/acceptance/12345678';
const tool={name:'mm_final_qc_contract',description:'Read the frozen host contract',
 parameters:Type.Object({index:Type.Integer({minimum:0,maximum:63})})};
const user={role:'user',content:'Task ID: mm-final-integration\nREAD-ONLY QC session',timestamp:1};

test('Hosted rehearsal uses actual normalized Pi system tool declarations before final QC PASS',async()=>{
 const uninstall=installRehearsalModels(fixture);
 try{
  const models=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),
   modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  const model=models.getModel('faux','faux-1'),messages=[user];
  for(let index=0;index<2;index++){
   const response=await models.completeSimple(model,{messages,tools:[tool]});
   assert.equal(response.stopReason,'toolUse');
   const call=response.content.find(c=>c.type==='toolCall');
   assert.equal(call.name,'mm_final_qc_contract');assert.equal(call.arguments.index,index);
   messages.push(response,{role:'toolResult',toolName:call.name,toolCallId:call.id,
    content:[{type:'text',text:'Synthetic immutable source contract'}],isError:false,timestamp:2+index});
  }
  const next=await models.completeSimple(model,{messages,tools:[tool]});
  assert.equal(next.content.find(c=>c.type==='toolCall').name,'read');
 }finally{uninstall();}
});

test('Hosted rehearsal does not manufacture final-QC PASS when the contract tool is absent',async()=>{
 const uninstall=installRehearsalModels(fixture);
 try{
  const models=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),
   modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  const response=await models.completeSimple(models.getModel('faux','faux-1'),{messages:[user]});
  assert.equal(response.stopReason,'error');
  assert.equal(response.content.some(c=>c.type==='toolCall'&&c.name==='mm_qc_report'),false);
 }finally{uninstall();}
});
