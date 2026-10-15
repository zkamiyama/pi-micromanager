// Mandatory real isolation/public-server acceptance. No skip or unconfined fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {fixture,workflow,configuration,runGit} from './helpers/production-server-fixture.mjs';

test('ADR19 public production server: explicit QC fail creates two budgeted readonly diagnoses and waits for human resume',
 {timeout:35000},async()=>{
 const x=fixture(),old=ModelRuntime.create,models=createModels(),faux=fauxProvider({tokensPerSecond:100000});
 models.setProvider(faux.provider);ModelRuntime.create=async()=>models;
 const original=x.host.execFile;
 x.host.execFile=async request=>{
  if(request.file!=='/usr/bin/bwrap')return original(request);
  const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',...request.env};
  for(const k of request.unsetEnv??[])delete env[k];
  const r=spawnSync(request.file,request.args,{encoding:'utf8',cwd:request.cwd,env,timeout:request.timeoutMs});
  return {exitCode:r.status,signal:r.signal,stdout:r.stdout??'',stderr:r.stderr??'',stdoutTruncated:false,stderrTruncated:false};
 };
 const use=(name,args)=>fauxAssistantMessage([fauxToolCall(name,args)],{stopReason:'toolUse'});
 const respond=context=>{
  const messages=context.messages,tools=new Set(messages.filter(m=>m.role==='system').flatMap(m=>m.toolsAdded??[]).map(t=>t.name));
  const called=name=>messages.filter(m=>m.role==='assistant').flatMap(m=>m.content??[]).some(c=>c.type==='toolCall'&&c.name===name);
  if(tools.has('mm_git_commit')){
   if(!called('write'))return use('write',{path:'marker.txt',content:'synthetic\n'});
   if(!called('mm_git_commit'))return use('mm_git_commit',{message:'test-only marker'});
  }else if(tools.has('mm_qc_report')){
   if(!called('mm_qc_report'))return use('mm_qc_report',{verdict:'fail',summary:'Synthetic explicit QC failure for bounded diagnosis'});
  }else if(tools.has('mm_task_report')){
   if(!called('read'))return use('read',{path:'marker.txt'});
   if(!called('mm_task_report'))return use('mm_task_report',{summary:'Read-only diagnosis/synthesis completed; human decides rework'});
  }else throw Error('Unexpected model tool registry');
  return fauxAssistantMessage('Turn completed');
 };
 faux.setResponses(Array.from({length:40},()=>respond));
 try{
  writeFileSync(join(x.project,'pass.test.mjs'),"import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';assert.equal(readFileSync('marker.txt','utf8'),'synthetic\\n');\n");
  runGit(x.project,'add','pass.test.mjs');runGit(x.project,'commit','-m','synthetic host verification');
  const worker=join(x.project,'worker');runGit(x.project,'worktree','add','-b','diagnostic-boundary',worker);x.setWorker(worker);
  await x.activate();await x.peer('create',{...workflow,permissions:{default:'deny',actions:{'git.commit':'allow'}}});
  await x.peer('auto.configure',{workflowId:'wf',config:{...configuration,managedWorktrees:undefined,workspaces:{task:'worker'},
   test:{execution:'sandbox',file:'node',args:['--test','pass.test.mjs'],timeoutMs:10000},
   automaticDiagnosis:{afterFailures:1,maxModelRequests:12,maxToolCalls:30,maxDurationMs:60000,maxOutputTokens:1024}}});
  await x.peer('auto.start',{workflowId:'wf'});
  let current,status;const deadline=Date.now()+27000;
  while(Date.now()<deadline){
   current=await x.peer('get','wf');status=await x.peer('auto.status',{workflowId:'wf'});
   const a=current.amendments.find(a=>a.automatic);
   if(!status.enabled&&a?.synthesisTaskId&&current.tasks[a.synthesisTaskId]?.status==='done')break;
   await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(status.enabled,false,status.status);assert.match(status.status,/human resume/);
  assert.equal(current.tasks.task.status,'held');assert.equal(current.tasks.task.attempts,1);
  const episode=current.amendments[0];assert.ok(episode.automatic);assert.equal(episode.agents.length,2);
  const runs=await x.peer('agents.list',{view:'all'});
  assert.equal(runs.length,5);assert.ok(runs.every(r=>r.phase==='sealed'&&r.sessionId.startsWith('durable:')));
  const diagnosis=runs.filter(r=>r.taskId!== 'task');assert.equal(diagnosis.length,3);
  const db=new DatabaseSync(join(x.state,'run-safety.sqlite'),{readOnly:true});
  try{for(const run of diagnosis){
   const key=createHash('sha256').update(JSON.stringify(['p','orchestra','wf',run.runId])).digest('hex');
   const row=db.prepare('SELECT deadline,requests,tools,outcome,limits_json FROM safety_runs WHERE key=?').get(key);
   assert.ok(row);const limits=JSON.parse(row.limits_json);
   assert.equal(limits.maxModelRequests,4);assert.equal(limits.maxToolCalls,10);
   assert.equal(row.deadline,episode.automatic.deadline);assert.equal(row.outcome,'completed');
   assert.ok(row.requests<=4&&row.tools<=10);
  }}finally{db.close();}
  const before=faux.state.callCount;await new Promise(r=>setTimeout(r,200));
  assert.equal(faux.state.callCount,before,'No autonomous rework after synthesis');
  await x.plugin.dispose(new AbortController().signal);await x.activate();
  current=await x.peer('get','wf');
  assert.equal(current.tasks.task.status,'held');assert.equal(current.amendments[0].id,episode.id);
  assert.equal(current.amendments[0].automatic.deadline,episode.automatic.deadline);
  assert.equal(faux.state.callCount,before,'Restart does not repeat diagnoses or refresh budgets');
  const a={workflowId:'wf',expectedRevision:current.revision,commandId:'human-review-resume',
   action:{type:'resume_after_diagnosis',amendmentId:episode.id,decision:'rework'}};
  const resumed=await x.peer('act',a),repeat=await x.peer('act',a);
  assert.equal(repeat.revision,resumed.revision);assert.equal(resumed.tasks.task.status,'ready');
  assert.equal((await x.peer('agents.list',{view:'all'})).length,5,'Resume decision alone is not a launch');
 }finally{await x.close();ModelRuntime.create=old;}
});
