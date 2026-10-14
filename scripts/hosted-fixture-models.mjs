/** Credential-free provider for the REAL hosted Workflow/Runtime/browser test.
 * Only model responses are scripted; no Run/QC/Workflow state or host tool result
 * is forged. This module is never installed into an operator's Pi profile. */
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {setTimeout as delay} from 'node:timers/promises';
export function hostedFixtureModels(runtime){
 const models=runtime??createModels(),faux=fauxProvider({tokensPerSecond:100000});
 const response=async(context,options)=>{
  await delay(120,undefined,{signal:options?.signal});
  const messages=context.messages;
  const calls=messages.filter(m=>m.role==='assistant').flatMap(m=>m.content??[]).filter(b=>b.type==='toolCall');
  const called=name=>calls.some(c=>c.name===name);
  const prompt=messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:
   m.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')).join('\n');
  const names=new Set(messages.filter(m=>m.role==='system').flatMap(m=>m.toolsAdded??[]).map(t=>t.name));
  const use=(name,args)=>fauxAssistantMessage([fauxToolCall(name,args)],{stopReason:'toolUse'});
  if(names.has('mm_git_merge_source')){
   const contract=JSON.parse(prompt);
   for(const source of contract.sourceCommits){
    if(!calls.some(c=>c.name==='mm_git_merge_source'&&c.arguments?.sha===source.headSha))
     return use('mm_git_merge_source',{sha:source.headSha});
   }
  }else if(names.has('mm_git_commit')){
   if(!called('bash'))return use('bash',{command:prompt.includes('ACCEPTANCE_ABORT_HOLD')?'sleep 20':'sleep 10'});
   if(!called('write'))return use('write',{path:'acceptance.txt',content:'synthetic acceptance confirmed\n'});
   if(!called('mm_git_commit'))return use('mm_git_commit',{message:'test: commit synthetic acceptance fixture'});
  }else if(names.has('mm_qc_report')){
   if(names.has('mm_final_qc_contract')&&!called('mm_final_qc_contract'))return use('mm_final_qc_contract',{index:0});
   if(!called('read'))return use('read',{path:'acceptance.txt'});
   if(!called('mm_qc_report'))return use('mm_qc_report',{verdict:'pass',summary:'Read the committed synthetic fixture; host independently verifies SHA and test execution.'});
  }else if(names.has('mm_plan_intervention')){
   if(!called('mm_plan_intervention'))return use('mm_plan_intervention',{summary:'Two independent read-only investigations before explicit human resume.',
    agents:[{id:'safety',title:'Synthetic safety review',role:'architect',model:'faux/faux-1'},
      {id:'compat',title:'Synthetic compatibility review',role:'reviewer',model:'faux/faux-1'}]});
  }else if(names.has('mm_task_report')){
   if(!called('read'))return use('read',{path:'acceptance.txt'});
   if(!called('mm_task_report'))return use('mm_task_report',{summary:'Read-only synthetic evidence was independently inspected.'});
  }else throw Error('Fixture model received an unsupported declared tool set');
  return fauxAssistantMessage('Synthetic turn completed.');
 };
 // Finite process-wide script in addition to the product's persisted Run budget.
 faux.setResponses(Array.from({length:160},()=>response));
 if(runtime)runtime.registerNativeProvider(faux.provider);else models.setProvider(faux.provider);
 return models;
}
