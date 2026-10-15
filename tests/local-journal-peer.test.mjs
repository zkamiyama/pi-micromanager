import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {LocalJournal} from '../dist/automation/local-journal.js';
import {localJournalFixture,PNG} from './helpers/local-journal-ci-fixture.mjs';

test('local Journal public server: image source, metadata-only listing and explicit byte read',async()=>{
 const x=await localJournalFixture();try{
  const artifact=await x.peer('auto.journal.local.import',x.image);
  assert.equal(artifact.provenance,'operator-upload');assert.equal(artifact.sourceSha,x.plan.baseSha);
  const journal=await x.peer('auto.journal',{workflowId:'wf'});
  assert.equal(journal.local.artifacts[0].id,artifact.id);
  assert.equal(JSON.stringify(journal).includes(PNG.toString('base64')),false,'Journal listing must not eagerly include image bytes');
  const read=await x.peer('auto.journal.local.read',{artifactId:artifact.id});
  assert.equal(read.dataUrl,'data:image/png;base64,'+PNG.toString('base64'));
  for(const input of [{...x.image,sourceSha:'b'.repeat(40)},{...x.image,runId:'wrong-run'},
   {...x.image,workflowId:'foreign'},{...x.image,base64:'not base64!'}])
   await assert.rejects(x.peer('auto.journal.local.import',input));
  const controller=new AbortController();
  await assert.rejects(x.plugin.peer.request({operation:'auto.journal.local.read',input:{artifactId:artifact.id},signal:controller.signal,
   project:{id:'p',path:x.project,name:'Fixture'},workspace:{id:'other-orchestra',projectId:'p',path:x.project,isMain:true}}),/scope/);
 }finally{await x.close();}
});
test('local Journal public server: a pin must protect the owning Workflow from Worktree retirement',async()=>{
 const x=await localJournalFixture({integrated:true});try{
  const a=await x.peer('auto.journal.local.import',x.image);
  await x.peer('auto.journal.local.pin',{artifactId:a.id,pinned:true});
  assert.equal((await x.peer('auto.journal',{workflowId:'wf'})).local.artifacts[0].pinned,true);
  await assert.rejects(x.peer('auto.worktree.retire.preview',{workflowId:'wf',taskId:'task'}),/pin|retain|protected/i);
 }finally{await x.close();}
});
test('local Journal public server: active or unsealed Runs and an aborted request forbid collection',async()=>{
 const x=await localJournalFixture();try{
  await assert.rejects(x.peer('auto.worktree.retire.preview',{workflowId:'wf',taskId:'task'}),/retained|unfinished/i);
  const stop=new AbortController();stop.abort(new Error('Synthetic cancelled request'));
  await assert.rejects(x.plugin.peer.request({operation:'auto.maintenance.run',input:{workflowId:'wf'},signal:stop.signal,
   project:{id:'p',name:'Fixture',path:x.project},workspace:{id:'orchestra',projectId:'p',path:x.project,isMain:true}}));
 }finally{await x.close();}
});
test('local Journal public server: Git ADR links are exact regular-file references, not a publisher',async()=>{
 const x=await localJournalFixture();try{
  const link=await x.peer('auto.journal.adr.link',{workflowId:'wf',workspaceId:'orchestra',path:'docs/adr/0001-fixture.md'});
  assert.equal(link.commit,x.plan.baseSha);assert.equal(link.repository,'fixture/test');
  assert.equal(link.url,'https://github.com/fixture/test/blob/'+x.plan.baseSha+'/docs/adr/0001-fixture.md');
  assert.equal((await x.peer('auto.journal',{workflowId:'wf'})).local.adrLinks[0].id,link.id);
  assert.equal(x.calls.some(c=>c.file.endsWith('/gh')||c.args.includes('push')),false);
  for(const path of ['../outside.md','docs/adr/../private.md','docs/adr/missing.md','README.fixture'])
   await assert.rejects(x.peer('auto.journal.adr.link',{workflowId:'wf',workspaceId:'orchestra',path}));
 }finally{await x.close();}
});
test('local Journal archive: repeated maintenance reuses the original snapshot after late activity',async()=>{
 const x=await localJournalFixture({integrated:true});let journal;
 try{
  journal=new LocalJournal({dataDirectory:x.state,workflows:x.store,agents:x.agents,ledger:x.ledger,
   host:x.host,policy:{maxBytes:1024*1024,maxAgeDays:1},workspaces:()=>undefined,externallyPinned:()=>false});
  const first=journal.archiveRun(x.sealed);
  x.agents.record(x.sealed,{kind:'tool_finished',text:'Late synthetic activity, not a new run',at:Date.now(),sequence:2});
  const again=journal.archiveRun(x.sealed);
  assert.equal(again.id,first.id);assert.equal(again.sha256,first.sha256);
 }finally{journal?.close();await x.close();}
});
test('local Journal archive: authoritative ADR reference survives disposable detail expiry',async()=>{
 const x=await localJournalFixture({integrated:true});let journal;
 try{
  const link=await x.peer('auto.journal.adr.link',{workflowId:'wf',workspaceId:'orchestra',path:'docs/adr/0001-fixture.md'});
  journal=new LocalJournal({dataDirectory:x.state,workflows:x.store,agents:x.agents,ledger:x.ledger,
   host:x.host,policy:{maxBytes:1024*1024,maxAgeDays:1},workspaces:()=>undefined,externallyPinned:()=>false});
  const archive=journal.archiveRun(x.sealed);
  assert.equal(journal.artifacts.collect('p','orchestra',0,Date.now()+2*86400000).removed,1);
  assert.equal(journal.artifacts.list('p','orchestra','wf')[0].state,'removed');
  assert.equal((await x.peer('auto.journal',{workflowId:'wf'})).local.adrLinks[0].url,link.url);
  assert.equal(x.agents.getRun('p','orchestra','wf',x.sealed.runId).evidenceRef,x.sealed.evidenceRef);
  assert.equal(journal.artifacts.list('p','orchestra','wf')[0].id,archive.id);
 }finally{journal?.close();await x.close();}
});
