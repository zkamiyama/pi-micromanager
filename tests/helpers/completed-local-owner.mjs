import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {fixture,workflow,configuration,runGit} from './production-server-fixture.mjs';

export async function completedLocalOwner({autoReclaimWorktrees=false}={}){
 const previous=ModelRuntime.create,models=createModels(),faux=fauxProvider({tokensPerSecond:100000});
 models.setProvider(faux.provider);ModelRuntime.create=async()=>models;
 const x=fixture();let fault;
 const native=x.host.execFile;
 x.host.execFile=request=>fault?fault(request,()=>native(request),x):native(request);
 try{
  writeFileSync(join(x.project,'fixture.test.mjs'),"import test from 'node:test';test('disposable source',()=>{});\n");
  runGit(x.project,'add','fixture.test.mjs');runGit(x.project,'commit','-m','Add synthetic source test');
  x.host.settings.productionSecurity.mode='local-owner';
  x.host.settings.productionSecurity.localRetention={autoReclaimWorktrees};
  await x.activate();await x.peer('create',{...workflow,permissions:{default:'ask',actions:{'git.commit':'allow'}}});
  await x.peer('auto.configure',{workflowId:'wf',config:configuration});
  const proposed=await x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'});
  const plan=await x.peer('auto.worktree.create',{planId:proposed.id});x.setWorker(plan.path);
  await x.peer('auto.configure',{workflowId:'wf',config:{...configuration,workspaces:{task:'worker'},
   test:{execution:'sandbox',file:'node',args:['--test','fixture.test.mjs'],timeoutMs:10000}}});
  faux.setResponses([
   fauxAssistantMessage([fauxToolCall('mm_task_report',{summary:'Synthetic source needs no changes'},{id:'impl'})],{stopReason:'toolUse'}),
   fauxAssistantMessage('Done'),
   fauxAssistantMessage([fauxToolCall('mm_qc_report',{verdict:'pass',summary:'Verified source and test'},{id:'qc'})],{stopReason:'toolUse'}),
   fauxAssistantMessage('Done'),
  ]);
  await x.peer('auto.start',{workflowId:'wf'});
  let passed=false;const end=Date.now()+15000;
  while(Date.now()<end){
   const wf=await x.peer('get','wf'),runs=await x.peer('agents.list',{view:'all'});
   if(wf.tasks.task.status==='passed'&&runs.length===2&&runs.every(r=>r.phase==='sealed')){passed=true;break;}
   await new Promise(r=>setTimeout(r,25));
  }
  assert.equal(passed,true,'The actual public server and Harness must finish before a fault can be injected');
  await x.peer('auto.pause',{workflowId:'wf'});
  const integration=await x.peer('auto.integration.preview',{workflowId:'wf',taskId:'task',targetWorkspaceId:'orchestra'});
  await x.peer('auto.integration.confirm',{previewId:integration.id});
  assert.equal(faux.state.callCount,4);
  // Preserve the live accessor: spreading x alone freezes the original instance.
  return {...x,plan,faux,get plugin(){return x.plugin;},setFault(f){fault=f;},
   async close(){try{await x.close();}finally{ModelRuntime.create=previous;}}};
 }catch(error){try{await x.close();}finally{ModelRuntime.create=previous;}throw error;}
}
