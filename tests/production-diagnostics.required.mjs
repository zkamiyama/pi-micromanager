import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {fixture,workflow,configuration,runGit} from './helpers/production-server-fixture.mjs';

test('#35 actual production server test failure reaches redacted status; optional raw evidence remains private',
 {timeout:18000},async()=>{
 const x=fixture(),previous=ModelRuntime.create,faux=fauxProvider({tokensPerSecond:100000}),models=createModels();models.setProvider(faux.provider);
 ModelRuntime.create=async()=>models;
 const original=x.host.execFile;
 x.host.execFile=async request=>{
  if(request.file!=='/usr/bin/bwrap')return original(request);
  const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',...request.env};
  for(const name of request.unsetEnv??[])delete env[name];
  const r=spawnSync(request.file,request.args,{encoding:'utf8',cwd:request.cwd,env,timeout:request.timeoutMs});
  return {exitCode:r.status,signal:r.signal,stdout:r.stdout??'',stderr:r.stderr??'',stdoutTruncated:false,stderrTruncated:false};
 };
 x.host.settings.productionSecurity.diagnostics={labels:{'allowed synthetic contract':'Fixture contract failure'},retainPrivateRaw:true};
 try{
  writeFileSync(join(x.project,'diagnostic.test.mjs'),
   "console.log('not ok 1 - private customer marker');console.log('not ok 2 - allowed synthetic contract');console.error('SYNTHETIC-CREDENTIAL-MARKER');process.exitCode=1;\n");
  runGit(x.project,'add','diagnostic.test.mjs');runGit(x.project,'commit','-m','test-only diagnostics');
  const worker=join(x.project,'worker');runGit(x.project,'worktree','add','-b','diagnostic-fixture',worker);x.setWorker(worker);
  faux.setResponses([
   fauxAssistantMessage([fauxToolCall('write',{path:'implemented.txt',content:'synthetic work\n'},{id:'write'})],{stopReason:'toolUse'}),
   fauxAssistantMessage([fauxToolCall('mm_git_commit',{message:'test-only model fixture'},{id:'commit'})],{stopReason:'toolUse'}),
   fauxAssistantMessage('Work committed'),
  ]);
  await x.activate();await x.peer('create',{...workflow,permissions:{default:'deny',actions:{'git.commit':'allow'}}});
  await x.peer('auto.configure',{workflowId:'wf',config:{...configuration,managedWorktrees:undefined,workspaces:{task:'worker'},maxAttempts:1,
   test:{execution:'sandbox',file:'node',args:['--test','diagnostic.test.mjs'],timeoutMs:10000}}});
  await x.peer('auto.start',{workflowId:'wf'});
  let status;const deadline=Date.now()+12000;
  do{status=await x.peer('auto.status',{workflowId:'wf'});if(!status.enabled&&faux.state.callCount>=3)break;await new Promise(r=>setTimeout(r,50));}while(Date.now()<deadline);
  assert.equal(status.enabled,false);
  const runs=await x.peer('agents.list',{view:'all'}),w=await x.peer('get','wf');
  assert.notEqual(w.tasks.task.status,'passed');
  const exposed=JSON.stringify({status,runs,w});
  assert.doesNotMatch(exposed,/SYNTHETIC-CREDENTIAL-MARKER|private customer marker/);
  // Rework/failed-test evidence is read from the product-owned Journal API.
  const journal=await x.peer('auto.journal',{workflowId:'wf'});
  assert.doesNotMatch(JSON.stringify(journal),/SYNTHETIC-CREDENTIAL-MARKER|private customer marker/);
  assert.match(JSON.stringify(journal),/Fixture contract failure/);
  const privateDir=join(x.state,'private-test-failures'),files=readdirSync(privateDir);
  assert.ok(files.length>=1&&files.length<=32);
  assert.match(readFileSync(join(privateDir,files[0]),'utf8'),/SYNTHETIC-CREDENTIAL-MARKER/);
 }finally{await x.close();ModelRuntime.create=previous;}
});
