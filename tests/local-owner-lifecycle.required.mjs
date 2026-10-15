import {retire} from './helpers/local-maintenance-receipt.mjs';
// Required real-namespace tests, separate from the portable glob. No skip,
// credentials, remote publication, or pre-existing Session/Worktree is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {fixture,workflow,configuration,runGit} from './helpers/production-server-fixture.mjs';
import {AgentRegistry} from '../dist/runtime/registry.js';

async function waitFor(read,{timeout=15000}={}){
 const end=Date.now()+timeout;
 while(Date.now()<end){const value=await read();if(value)return value;await new Promise(r=>setTimeout(r,25));}
 throw new Error('Required local-owner condition not reached');
}
function modelFixture(tokensPerSecond=100000){
 const previous=ModelRuntime.create,models=createModels(),faux=fauxProvider({tokensPerSecond});
 models.setProvider(faux.provider);ModelRuntime.create=async()=>models;
 return {faux,restore(){ModelRuntime.create=previous;}};
}

test('local-owner actual server: real Harness completion precedes owned DB/Worktree retirement and retained refs survive',
 {timeout:35000},async()=>{
 const m=modelFixture(),x=fixture();
 try{
  writeFileSync(join(x.project,'fixture.test.mjs'),"import test from 'node:test'; import assert from 'node:assert/strict'; test('synthetic baseline',()=>assert.equal(1,1));\n");
  runGit(x.project,'add','fixture.test.mjs');runGit(x.project,'commit','-m','Add disposable sandbox test');
  x.host.settings.productionSecurity.mode='local-owner';
  x.host.settings.productionSecurity.localRetention={autoReclaimWorktrees:false};
  await x.activate();await x.peer('create',{...workflow,permissions:{default:'ask',actions:{'git.commit':'allow'}}});
  await x.peer('auto.configure',{workflowId:'wf',config:configuration});
  const proposed=await x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'});
  const plan=await x.peer('auto.worktree.create',{planId:proposed.id});x.setWorker(plan.path);
  await x.peer('auto.configure',{workflowId:'wf',config:{...configuration,workspaces:{task:'worker'},test:{execution:'sandbox',file:'node',args:['--test','fixture.test.mjs'],timeoutMs:10000}}});
  m.faux.setResponses([
   fauxAssistantMessage([fauxToolCall('mm_task_report',{summary:'Existing synthetic baseline satisfies the task'},{id:'implementation-report'})],{stopReason:'toolUse'}),
   fauxAssistantMessage('Implementation complete without source changes.'),
   fauxAssistantMessage([fauxToolCall('mm_qc_report',{verdict:'pass',summary:'Checked exact baseline and synthetic tests'},{id:'qc-report'})],{stopReason:'toolUse'}),
   fauxAssistantMessage('QC complete.'),
  ]);
  await x.peer('auto.start',{workflowId:'wf'});
  await waitFor(async()=>{
   const wf=await x.peer('get','wf');
   const runs=await x.peer('agents.list',{view:'all'});
   return wf.tasks.task.status==='passed'&&runs.length===2&&runs.every(r=>r.phase==='sealed');
  });
  await x.peer('auto.pause',{workflowId:'wf'});
  const integration=await x.peer('auto.integration.preview',{workflowId:'wf',taskId:'task',targetWorkspaceId:'orchestra'});
  await x.peer('auto.integration.confirm',{previewId:integration.id});
  const runs=await x.peer('agents.list',{view:'all'});assert.equal(m.faux.state.callCount,4);
  assert.ok(runs.every(r=>r.sessionId.startsWith('durable:')&&r.evidenceRef));
  const before=await x.peer('auto.journal',{workflowId:'wf'});
  const preview=await x.peer('auto.worktree.retire.preview',{workflowId:'wf',taskId:'task'});
  assert.ok(preview.estimatedBytes>0);assert.equal(existsSync(plan.path),true);
  const result=await retire(x,preview);
  assert.equal(result.phase,'completed');assert.equal(existsSync(plan.path),false);
  const ref=execFileSync('/usr/bin/git',['-C',x.project,'rev-parse','refs/heads/'+plan.branch],{encoding:'utf8'}).trim();
  assert.equal(ref,plan.baseSha,'Retiring the working copy must not delete its result ref');
  assert.equal((await retire(x,preview)).phase,'completed');
  assert.equal(x.calls.filter(c=>c.args[2]==='worktree'&&c.args[3]==='remove').length,1);
  const journal=await x.peer('auto.journal',{workflowId:'wf'});
  assert.equal(journal.local.artifacts.filter(a=>a.kind==='run-log'&&a.state==='ready').length,2);
  for(const r of runs){
   const key=r.sessionId.slice('durable:'.length);
   assert.equal(existsSync(join(x.state,'durable-runs',key+'.sqlite')),false);
  }
  const db=new DatabaseSync(join(x.state,'run-safety.sqlite'),{readOnly:true});
  try{assert.equal(db.prepare("SELECT count(*) AS n FROM retired_runs WHERE state='completed'").get().n,2);}
  finally{db.close();}
  assert.deepEqual(journal.runs.map(r=>r.evidence.ref).sort(),before.runs.map(r=>r.evidence.ref).sort());
  assert.equal(m.faux.state.callCount,4,'Retirement and duplicate confirmation cannot dispatch a model');
 }finally{await x.close();m.restore();}
});

test('local-owner actual server: delayed provider is joined on lifetime loss and remains uncertain',
 {timeout:20000},async()=>{
 const m=modelFixture(10),x=fixture();
 try{
  m.faux.setResponses([fauxAssistantMessage('Synthetic delayed provider response '.repeat(1000))]);
  x.host.settings.productionSecurity.mode='local-owner';await x.activate();
  const run=await x.peer('auto.propose',{goal:'Create a synthetic test-only plan',provider:'faux',model:'faux-1',runtime:'durable'});
  await waitFor(()=>m.faux.state.callCount===1);
  x.lifetime.abort(new Error('Synthetic local owner ended'));
  await x.plugin.dispose(new AbortController().signal);
  const agents=new AgentRegistry(join(x.state,'agents.sqlite'));
  try{
   const state=agents.getRun('p','orchestra',run.draftWorkflowId,run.runId);
   assert.equal(state.abortRequested,1);assert.equal(state.phase,'uncertain');
  }finally{agents.close();}
  assert.equal(m.faux.state.callCount,1);
 }finally{await x.close();m.restore();}
});
