import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync,unlinkSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WorkflowStore} from '../dist/core/store.js';
import {AgentRegistry} from '../dist/runtime/registry.js';
import {AutopilotLedger} from '../dist/automation/ledger.js';
import {LocalJournal} from '../dist/automation/local-journal.js';
import {completedLocalOwner} from './helpers/completed-local-owner.mjs';
import {retire,waitMaintenance} from './helpers/local-maintenance-receipt.mjs';
import {PNG} from './helpers/local-journal-ci-fixture.mjs';
const removals=x=>x.calls.filter(c=>c.args[2]==='worktree'&&c.args[3]==='remove').length;
const preview=x=>x.peer('auto.worktree.retire.preview',{workflowId:'wf',taskId:'task'});
function archive(x,binding){
 const workflows=new WorkflowStore(join(x.state,'workflows.sqlite'));
 const agents=new AgentRegistry(join(x.state,'agents.sqlite')),ledger=new AutopilotLedger(join(x.state,'autopilot.sqlite'));
 const journal=new LocalJournal({dataDirectory:x.state,workflows,agents,ledger,host:x.host,
  policy:{maxBytes:1024*1024,maxAgeDays:1},workspaces:()=>undefined,externallyPinned:()=>false});
 return {journal,artifact:journal.archiveRun(binding),close(){journal.close();ledger.close();agents.close();workflows.close();}};
}
test('local-owner retirement: a corrupt original archive cannot authorize removal of its Run DB', {timeout:35000},async()=>{
 const x=await completedLocalOwner();let saved;
 try{
  const proposal=await preview(x),run=(await x.peer('agents.list',{view:'all'}))[0];saved=archive(x,run);
  writeFileSync(join(x.state,'local-journal/objects',saved.artifact.id+'.blob'),'tampered bounded fixture');
  assert.equal((await retire(x,proposal)).phase,'blocked');
  assert.equal(existsSync(join(x.state,'durable-runs',run.sessionId.slice(8)+'.sqlite')),true);
  assert.equal(existsSync(x.plan.path),true);assert.equal(removals(x),0);
 }finally{saved?.close();await x.close();}
});
test('local-owner retirement: expired detail without a completed retirement receipt retains the original DB', {timeout:35000},async()=>{
 const x=await completedLocalOwner();let saved;
 try{
  const proposal=await preview(x),run=(await x.peer('agents.list',{view:'all'}))[0];saved=archive(x,run);
  saved.journal.artifacts.collect('p','orchestra',0,Date.now()+2*86400000);
  assert.equal(saved.journal.archiveRun(run).state,'removed');
  assert.equal((await retire(x,proposal)).phase,'blocked');
  assert.equal(existsSync(join(x.state,'durable-runs',run.sessionId.slice(8)+'.sqlite')),true);
  assert.equal(removals(x),0);
 }finally{saved?.close();await x.close();}
});
test('local-owner retirement: pin added during asynchronous Git preflight blocks new removal', {timeout:35000},async()=>{
 const x=await completedLocalOwner();try{
  const runs=await x.peer('agents.list',{view:'all'}),qc=runs.find(r=>r.seat==='qc');
  const a=await x.peer('auto.journal.local.import',{workflowId:'wf',runId:qc.runId,sourceSha:x.plan.baseSha,
   requestId:'late-pin',label:'Keep evidence',base64:PNG.toString('base64')});
  const proposal=await preview(x);let pinned=false;
  x.setFault(async(request,run)=>{
   const result=await run();
   if(request.args[2]==='config'&&!pinned){
    const db=new DatabaseSync(join(x.state,'worktree-retirements.sqlite'),{readOnly:true});
    const reserved=db.prepare("SELECT 1 FROM retirements WHERE state='reserved'").get();db.close();
    if(reserved){pinned=true;await x.peer('auto.journal.local.pin',{artifactId:a.id,pinned:true});}
   }return result;
  });
  assert.equal((await retire(x,proposal)).phase,'blocked');assert.equal(pinned,true);
  assert.equal(removals(x),0);assert.equal(existsSync(x.plan.path),true);
  assert.equal((await x.peer('auto.journal.local.read',{artifactId:a.id})).artifact.pinned,true);
 }finally{await x.close();}
});
test('local-owner retirement: an ignored file created after Git guard is retained', {timeout:35000},async()=>{
 const x=await completedLocalOwner();try{
  writeFileSync(join(x.project,'.git/info/exclude'),'\nlate.cache\n',{flag:'a'});
  const proposal=await preview(x);let inserted=false;const file=join(x.plan.path,'late.cache');
  x.setFault(async(request,run)=>{
   const result=await run();
   if(request.args[2]==='config'&&!inserted){
    const db=new DatabaseSync(join(x.state,'worktree-retirements.sqlite'),{readOnly:true});
    const reserved=db.prepare("SELECT 1 FROM retirements WHERE state='reserved'").get();db.close();
    if(reserved){inserted=true;writeFileSync(file,'Preserve this newly created ignored fixture');}
   }return result;
  });
  assert.equal((await retire(x,proposal)).phase,'blocked');assert.equal(inserted,true);
  assert.equal(removals(x),0);assert.match(readFileSync(file,'utf8'),/Preserve/);
 }finally{await x.close();}
});
test('local-owner retirement: a DB alias is refused before SQLite can checkpoint its target', {timeout:35000},async()=>{
 const x=await completedLocalOwner();try{
  const proposal=await preview(x),run=(await x.peer('agents.list',{view:'all'}))[0];
  const original=join(x.state,'durable-runs',run.sessionId.slice(8)+'.sqlite'),other=join(x.temp,'unrelated.sqlite');
  const db=new DatabaseSync(other);db.exec('CREATE TABLE keep(value); INSERT INTO keep VALUES(42)');db.close();
  const before=readFileSync(other);unlinkSync(original);symlinkSync(other,original);
  assert.equal((await retire(x,proposal)).phase,'blocked');assert.deepEqual(readFileSync(other),before);
  assert.equal(existsSync(other+'-wal'),false);assert.equal(removals(x),0);
 }finally{await x.close();}
});
test('local-owner retirement: a delayed operation acknowledges once while status remains queryable', {timeout:40000},async()=>{
 const x=await completedLocalOwner();let release;
 const gate=new Promise(r=>release=r);
 try{
  const proposal=await preview(x);let entered=false;
  x.setFault(async(request,run)=>{
   if(request.args[2]==='worktree'&&request.args[3]==='remove'){entered=true;await gate;}
   return run();
  });
  const start=Date.now(),a=await x.peer('auto.worktree.retire.confirm',{previewId:proposal.id});
  assert.equal(a.phase,'running');assert.ok(Date.now()-start<2000,'Admission must not wait for the external command');
  for(let i=0;i<200&&!entered;i++)await new Promise(r=>setTimeout(r,25));assert.equal(entered,true);
  const again=await x.peer('auto.worktree.retire.confirm',{previewId:proposal.id});assert.equal(again.id,a.id);
  assert.equal((await x.peer('auto.maintenance.status',{operationId:a.id})).phase,'running');
  release();assert.equal((await waitMaintenance(x,a)).phase,'completed');assert.equal(removals(x),1);
 }finally{release();await x.close();}
});

test('local-owner retirement: legacy creation rows without original directory identity are not upgraded into deletion authority', {timeout:35000},async()=>{
 const x=await completedLocalOwner();try{
  const db=new DatabaseSync(join(x.state,'worktree-provisions.sqlite'));
  db.prepare('UPDATE worktree_plans SET creation_identity=NULL WHERE id=?').run(x.plan.id);db.close();
  await assert.rejects(preview(x),/ownership receipt missing/);
  assert.equal(removals(x),0);assert.equal(existsSync(x.plan.path),true);
 }finally{await x.close();}
});
test('local-owner retirement: unresolved deletion protects its archived public evidence from expiry', {timeout:40000},async()=>{
 const x=await completedLocalOwner();try{
  const proposal=await preview(x);
  x.setFault(async(request,run)=>{
   const result=await run();
   if(request.args[2]==='worktree'&&request.args[3]==='remove')throw new Error('Synthetic lost delete response');
   return result;
  });
  assert.equal((await retire(x,proposal)).phase,'blocked');
  const db=new DatabaseSync(join(x.state,'local-journal/index.sqlite'));
  db.prepare('UPDATE artifacts SET createdAt=?').run(1);db.close();
  const planned=await x.peer('auto.maintenance.preview',{workflowId:'wf'});
  assert.equal(planned.artifacts.ids.length,0,'Unconfirmed resource retirement is a real retention pin');
  assert.ok(planned.artifacts.protectedCount>=2);assert.equal(removals(x),1);
  x.setFault(undefined);await x.plugin.dispose(new AbortController().signal);await x.activate();
  assert.equal((await x.peer('auto.maintenance.preview',{workflowId:'wf'})).artifacts.ids.length,0);
 }finally{await x.close();}
});
test('local-owner retirement: successful reopen preserves tombstones and never recreates retired Run databases', {timeout:40000},async()=>{
 const x=await completedLocalOwner();try{
  const proposal=await preview(x),runs=await x.peer('agents.list',{view:'all'});
  const first=await retire(x,proposal);assert.equal(first.phase,'completed');
  await x.plugin.dispose(new AbortController().signal);await x.activate();
  const again=await x.peer('auto.worktree.retire.confirm',{previewId:proposal.id});
  assert.equal(again.id,first.id);assert.equal(again.phase,'completed');
  for(const run of runs)assert.equal(existsSync(join(x.state,'durable-runs',run.sessionId.slice(8)+'.sqlite')),false);
  assert.equal(x.faux.state.callCount,4);assert.equal(removals(x),1);
  assert.equal((await x.peer('agents.list',{view:'all'})).length,runs.length);
 }finally{await x.close();}
});

test('local-owner retirement: an active SQLite WAL reader prevents checkpoint and preserves the Run database', {timeout:40000},async()=>{
 const x=await completedLocalOwner();let reader,writer;
 try{
  const proposal=await preview(x),run=(await x.peer('agents.list',{view:'all'}))[0];
  const path=join(x.state,'durable-runs',run.sessionId.slice(8)+'.sqlite');
  writer=new DatabaseSync(path);writer.exec('CREATE TABLE retention_fixture(value); INSERT INTO retention_fixture VALUES(1)');
  reader=new DatabaseSync(path);reader.exec('BEGIN');assert.equal(reader.prepare('SELECT value FROM retention_fixture').get().value,1);
  writer.exec('UPDATE retention_fixture SET value=2');
  assert.equal((await retire(x,proposal)).phase,'blocked');
  assert.equal(existsSync(path),true);assert.equal(removals(x),0);
  assert.equal(reader.prepare('SELECT value FROM retention_fixture').get().value,1);
 }finally{reader?.close();writer?.close();await x.close();}
});

test('local-owner retirement: startup automatically reclaims an eligible completed Workflow exactly once', {timeout:40000},async()=>{
 const x=await completedLocalOwner({autoReclaimWorktrees:true});try{
  await x.plugin.dispose(new AbortController().signal);await x.activate();
  let status;const end=Date.now()+15000;
  while(Date.now()<end){
   status=(await x.peer('auto.maintenance.preview',{workflowId:'wf'})).status;
   if(['completed','blocked','uncertain'].includes(status.phase))break;
   await new Promise(r=>setTimeout(r,25));
  }
  assert.equal(status?.phase,'completed');assert.equal(existsSync(x.plan.path),false);assert.equal(removals(x),1);
  const first=status.id;await x.plugin.dispose(new AbortController().signal);await x.activate();
  assert.equal((await x.peer('auto.maintenance.preview',{workflowId:'wf'})).status.id,first);
  assert.equal(removals(x),1);assert.equal(x.faux.state.callCount,4);
 }finally{await x.close();}
});
