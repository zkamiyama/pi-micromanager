// This suite executes only where actual Linux Bubblewrap success is required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {productionTools} from '../dist/runtime/production-tools.js';
import {parseProductionPolicy,installProductionPolicy} from '../dist/security/policy.js';
import {AgentRegistry} from '../dist/runtime/registry.js';
import {AutopilotLedger} from '../dist/automation/ledger.js';
import {DurableRunHost} from '../dist/runtime/durable-runner.js';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
const limits={maxCommandMs:5000,maxWorkspaceBytes:16*1024*1024};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'mm-search-proof-')),work=join(root,'work'),state=join(root,'state');
 for(const dir of [work,state,join(work,'src'),join(work,'.git'),join(work,'.private'),join(work,'node_modules')])mkdirSync(dir,{mode:0o700});
 writeFileSync(join(work,'src','a.ts'),'export const contractNeedle = true;\n');
 writeFileSync(join(work,'src','b.js'),'const contractNeedle = false;\n');
 for(const dir of ['.git','.private','node_modules'])writeFileSync(join(work,dir,'private.txt'),'SYNTHETIC-NOT-SOURCE contractNeedle');
 const tools=productionTools(work,false,[],limits,()=>{});
 const invoke=async(name,args)=>{
  const tool=tools.find(t=>t.name===name);assert.ok(tool);
  return tool.execute(args,{}, {abortSignal:new AbortController().signal});
 };
 return {root,work,state,tools,invoke,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('#34 production search: bounded glob and literal grep run inside the readonly namespace',async()=>{
 const x=fixture();try{
  const glob=await x.invoke('mm_glob_repo_files',{glob:'**/*.ts'});
  assert.equal(glob.isError,false);assert.deepEqual(JSON.parse(glob.output[0].text).files,['src/a.ts']);
  const found=await x.invoke('mm_search_repo_text',{text:'contractNeedle',pathPrefix:'src'});
  const result=JSON.parse(found.output[0].text);
  assert.equal(found.isError,false);assert.equal(result.matches.length,2);
  assert.equal(result.matches[0].line,1);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC-NOT-SOURCE/);
  const empty=await x.invoke('mm_search_repo_text',{text:'SYNTHETIC-NOT-SOURCE'});
  assert.deepEqual(JSON.parse(empty.output[0].text).matches,[]);
  assert.equal(x.tools.some(t=>['bash','write','edit','mm_git_commit'].includes(t.name)),false);
  assert.equal(readFileSync(join(x.work,'src/a.ts'),'utf8'),'export const contractNeedle = true;\n');
 }finally{x.close();}
});
test('#34 production search: path/glob attacks and late aliases do not disclose other files',async()=>{
 const x=fixture();try{
  for(const args of [{text:'needle',pathPrefix:'../state'},{text:'needle',pathPrefix:'/etc'},
    {text:'needle',pathPrefix:'.git'},{text:'needle',glob:'../*'},{text:'needle',glob:'[a-z]*'}]){
   const r=await x.invoke('mm_search_repo_text',args);assert.equal(r.isError,true);
  }
  symlinkSync(join(x.work,'src/a.ts'),join(x.work,'src/alias.ts'));
  const r=await x.invoke('mm_glob_repo_files',{glob:'**/*.ts'});
  assert.deepEqual(JSON.parse(r.output[0].text).files,['src/a.ts']);
 }finally{x.close();}
});
test('#34 production search: many matches and huge binary/source files remain bounded',async()=>{
 const x=fixture();try{
  writeFileSync(join(x.work,'src/many.txt'),'needle\n'.repeat(100));
  writeFileSync(join(x.work,'src/oversize.txt'),'needle'.repeat(50000));
  writeFileSync(join(x.work,'src/binary'),Buffer.from([0,110,101,101,100,108,101]));
  const r=await x.invoke('mm_search_repo_text',{text:'needle'}),data=JSON.parse(r.output[0].text);
  assert.equal(data.matches.length,60);assert.equal(data.truncated,true);
  assert.ok(Buffer.byteLength(r.output[0].text)<60000);assert.ok(data.scannedBytes<=3145728);
 }finally{x.close();}
});
test('#34 real production Durable QC provider invokes isolated glob/search and commits its report',async()=>{
 const x=fixture(),faux=fauxProvider({tokensPerSecond:100000}),models=createModels();models.setProvider(faux.provider);
 const policy=parseProductionPolicy({mode:'production',projectRoots:[x.work],models:[{provider:'faux',model:'faux-1'}]});
 const uninstall=installProductionPolicy(x.state,policy),agents=new AgentRegistry(join(x.state,'agents.sqlite')),
  ledger=new AutopilotLedger(join(x.state,'ledger.sqlite')),events=[];
 const host=new DurableRunHost({dataDirectory:x.state,agents,ledger,models,
  changed(){},wake(){},activity(b,e){events.push(e);agents.record(b,e);},report(b,r){ledger.recordReport(b,r);}});
 const reservation={projectId:'p',orchestraWorkspaceId:'o',workflowId:'wf',taskId:'task',runId:'qc-1',workspaceId:'w',seat:'qc',requestId:'request-1'};
 try{
  faux.setResponses([
   fauxAssistantMessage([fauxToolCall('mm_glob_repo_files',{glob:'src/*.ts'},{id:'glob'})],{stopReason:'toolUse'}),
   fauxAssistantMessage([fauxToolCall('mm_search_repo_text',{text:'contractNeedle',pathPrefix:'src'},{id:'grep'})],{stopReason:'toolUse'}),
   fauxAssistantMessage([fauxToolCall('mm_qc_report',{verdict:'pass',summary:'Read bounded source'},{id:'report'})],{stopReason:'toolUse'}),
   fauxAssistantMessage('Done'),
  ]);
  await host.launch({reservation,cwd:x.work,kind:'qc',model:{provider:'faux',model:'faux-1'},prompt:'Inspect the source then report.'});
  const deadline=Date.now()+10000;let run;
  do{run=agents.getRun('p','o','wf','qc-1');if(run?.phase==='settled')break;await new Promise(r=>setTimeout(r,20));}while(Date.now()<deadline);
  assert.equal(run.phase,'settled');host.assertProvedCompleted(run);
  for(const name of ['mm_glob_repo_files','mm_search_repo_text'])assert.ok(events.some(e=>e.kind==='tool_finished'&&e.text===name+' finished'));
  assert.equal(events.some(e=>e.kind==='error'),false);assert.equal(faux.state.callCount,4);
  assert.equal(ledger.report(run).verdict,'pass');
 }finally{await host.close();ledger.close();agents.close();uninstall();x.close();}
});
