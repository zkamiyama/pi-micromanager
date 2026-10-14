/** Deterministic rehearsal only. Never selected by the live mode. */
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';

const text=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(x=>x.type==='text').map(x=>x.text).join('\n'):'';
export function installRehearsalModels(fixture){
 const original=ModelRuntime.create;
 const faux=fauxProvider({tokensPerSecond:100000,models:[{id:'faux-1',reasoning:true}]});
 faux.getModel().thinkingLevelMap={low:'low',max:'max'};
 const response=(context,_options,state)=>{
  const messages=context.messages??[];
  const prompt=messages.filter(m=>m.role==='user').map(m=>text(m.content)).find(s=>s.includes('Task ID:'))??'';
  const task=prompt.match(/Task ID: ([a-z0-9-]+)/)?.[1];
  const qc=prompt.includes('READ-ONLY QC session');
  const calls=messages.filter(m=>m.role==='assistant').flatMap(m=>Array.isArray(m.content)?m.content.filter(c=>c.type==='toolCall'):[]);
  const called=name=>calls.filter(c=>c.name===name);
  const invoke=(name,args)=>fauxAssistantMessage([fauxToolCall(name,args,{id:'rehearsal-'+state.callCount})],{stopReason:'toolUse'});
  if(!task)throw Error('Synthetic prompt lacks the bound Task identity');
  if(qc){
   const ids=task==='mm-final-integration'?['a','b']:[task];
   if(task==='mm-final-integration'&&context.tools?.some(t=>t.name==='mm_final_qc_contract')){
    for(let i=0;i<ids.length;i++)if(!called('mm_final_qc_contract').some(c=>c.arguments.index===i))
      return invoke('mm_final_qc_contract',{index:i});
   }
   for(const id of ids)if(!called('read').some(c=>c.arguments.path===fixture+'/'+id+'.txt'))
     return invoke('read',{path:fixture+'/'+id+'.txt'});
   if(!called('mm_qc_report').length)return invoke('mm_qc_report',{verdict:'pass',summary:'Synthetic rehearsal read completed; host verifies exact SHA and tests.'});
   return fauxAssistantMessage('Rehearsal QC complete.');
  }
  if(task==='mm-final-integration'){
   const shas=[...prompt.matchAll(/(?:^|\n)(?:a|b) at ([a-f0-9]{40})(?=\n|$)/g)].map(m=>m[1]);
   if(shas.length!==2)throw Error('Synthetic final prompt lacks two frozen source SHAs');
   for(const sha of shas)if(!called('mm_git_merge_source').some(c=>c.arguments.sha===sha))
     return invoke('mm_git_merge_source',{sha});
   return fauxAssistantMessage('Rehearsal final integration complete.');
  }
  if(task==='abort'){
   if(!called('bash').length)return invoke('bash',{command:'sleep 20; printf UNEXPECTED > '+fixture+'/abort.txt'});
   return fauxAssistantMessage('Rehearsal abort unexpectedly completed.');
  }
  if(!['a','b'].includes(task))throw Error('Unexpected synthetic Task');
  if(!called('bash').length)return invoke('bash',{command:'sleep 2; printf "'+task.toUpperCase()+'\\n" > '+fixture+'/'+task+'.txt'});
  if(!called('mm_git_commit').length)return invoke('mm_git_commit',{message:'test: add synthetic '+task+' marker'});
  return fauxAssistantMessage('Rehearsal implementation committed.');
 };
 faux.setResponses(Array.from({length:120},()=>response));
 const create=async options=>{
  const models=await original({...options,modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  models.registerNativeProvider(faux.provider);return models;
 };
 ModelRuntime.create=create;
 return ()=>{if(ModelRuntime.create===create)ModelRuntime.create=original;};
}
