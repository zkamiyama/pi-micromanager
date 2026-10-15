import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AgentRegistry} from '../dist/runtime/registry.js';
import {AutopilotLedger} from '../dist/automation/ledger.js';
import {completedLocalOwner} from './helpers/completed-local-owner.mjs';

const removals=x=>x.calls.filter(c=>c.args[2]==='worktree'&&c.args[3]==='remove').length;
const preview=x=>x.peer('auto.worktree.retire.preview',{workflowId:'wf',taskId:'task'});

test('local-owner public server: lost successful Git removal response stays uncertain across actual reactivation',
 {timeout:40000},async()=>{
 const x=await completedLocalOwner();try{
  const proposal=await preview(x);let lost=false;
  x.setFault(async(request,run)=>{
   const result=await run();
   if(request.args[2]==='worktree'&&request.args[3]==='remove'){
    assert.equal(result.exitCode,0);lost=true;throw new Error('Synthetic lost successful removal reply');
   }
   return result;
  });
  await assert.rejects(x.peer('auto.worktree.retire.confirm',{previewId:proposal.id}),/lost/);
  assert.equal(lost,true);assert.equal(existsSync(x.plan.path),false);assert.equal(removals(x),1);
  const persisted=await x.peer('auto.maintenance.preview',{workflowId:'wf'});
  assert.equal(persisted.worktrees.find(r=>r.id===proposal.id).state,'uncertain');
  x.setFault(undefined);await x.plugin.dispose(new AbortController().signal);await x.activate();
  await assert.rejects(x.peer('auto.worktree.retire.confirm',{previewId:proposal.id}),/unconfirmed|no replay/);
  assert.equal(removals(x),1);assert.equal(x.faux.state.callCount,4);
  const agents=new AgentRegistry(join(x.state,'agents.sqlite'));
  try{
   assert.throws(()=>agents.reserve({projectId:'p',orchestraWorkspaceId:'orchestra',workspaceId:'worker',workflowId:'another',
    taskId:'other',runId:'must-not-start',seat:'implementer',requestId:'auto:no-reuse'}),/leased/);
  }finally{agents.close();}
 }finally{await x.close();}
});

test('local-owner public server: generation change after asynchronous Git guard prevents removal',
 {timeout:35000},async()=>{
 const x=await completedLocalOwner();try{
  const proposal=await preview(x);let changed=false;
  x.setFault(async(request,run)=>{
   const result=await run();
   if(request.args[2]==='config'&&!changed){
    const path=join(x.state,'worktree-retirements.sqlite');
    const db=new DatabaseSync(path,{readOnly:true});
    const reserved=db.prepare("SELECT 1 FROM retirements WHERE state='reserved' LIMIT 1").get();db.close();
    if(reserved){
     changed=true;await Promise.resolve();
     const ledger=new AutopilotLedger(join(x.state,'autopilot.sqlite'));
     try{ledger.setStatus('p','orchestra','wf',false,'Synthetic configuration generation change');}finally{ledger.close();}
    }
   }
   return result;
  });
  await assert.rejects(x.peer('auto.worktree.retire.confirm',{previewId:proposal.id}),/generation|authority/i);
  assert.equal(changed,true);assert.equal(removals(x),0);assert.equal(existsSync(x.plan.path),true);
 }finally{await x.close();}
});

test('local-owner public server: an untracked file added after preview protects the real Worktree',
 {timeout:35000},async()=>{
 const x=await completedLocalOwner();try{
  const proposal=await preview(x);const marker=join(x.plan.path,'untracked.fixture');
  writeFileSync(marker,'Keep this temporary test file');
  await assert.rejects(x.peer('auto.worktree.retire.confirm',{previewId:proposal.id}),/uncommitted|untracked|changed/);
  assert.equal(readFileSync(marker,'utf8'),'Keep this temporary test file');assert.equal(removals(x),0);
 }finally{await x.close();}
});

test('local-owner public server: a caller cannot confirm another Orchestra retirement',
 {timeout:35000},async()=>{
 const x=await completedLocalOwner();try{
  const proposal=await preview(x);
  await assert.rejects(x.plugin.peer.request({operation:'auto.worktree.retire.confirm',input:{previewId:proposal.id},signal:new AbortController().signal,
   project:{id:'p',name:'Fixture',path:x.project},workspace:{id:'other-orchestra',projectId:'p',path:x.project,isMain:true}}),/scope/);
  assert.equal(removals(x),0);assert.equal(existsSync(x.plan.path),true);
 }finally{await x.close();}
});
