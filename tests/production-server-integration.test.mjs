import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,symlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import serverPlugin from '../dist/pi-web/server.js';
import {acquireStateOwner} from '../dist/security/state-owner.js';
import {fixture,workflow,configuration} from './helpers/production-server-fixture.mjs';

test('#79 public server: reject state ancestor, package overlap, foreign project and symlink',async()=>{
  for(const mode of ['state-ancestor','package-ancestor','foreign','contains-foreign','symlink']){
    const x=fixture({stateNested:mode==='state-ancestor',packageNested:mode==='package-ancestor',
      nestedOther:mode==='contains-foreign'});
    try{
      await x.activate();
      if(mode==='foreign')x.setWorkspace(x.other);
      if(mode==='symlink'){
        const alias=join(x.temp,'alias');symlinkSync(x.project,alias);x.setWorkspace(alias);
      }
      await x.peer('create',workflow);
      await x.peer('auto.configure',{workflowId:'wf',config:configuration});
      if(mode==='state-ancestor'||mode==='package-ancestor')x.setWorkspace(x.project);
      await assert.rejects(x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'}),
        /overlaps|selected project|canonical|outside|different authorized/i,mode);
    }finally{await x.close();}
  }
});
test('#79 public server: reject managed parent; allow only an exact managed leaf',async()=>{
  const x=fixture();try{
    await x.activate();await x.peer('create',workflow);
    await x.peer('auto.configure',{workflowId:'wf',config:configuration});
    const parent=join(x.state,'managed-worktrees');
    mkdirSync(parent,{recursive:true});
    x.setWorkspace(parent);
    await assert.rejects(x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'}),
      /exact managed Worktree leaf/);
    const leaf=join(parent,'a'.repeat(16),'workflow','task');
    mkdirSync(leaf,{recursive:true});x.setWorkspace(leaf);
    // Preview consults the verified selected Workspace and performs Git read
    // checks on the separately authorized source project, never on the leaf.
    const plan=await x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'});
    assert.ok(plan.id);
  }finally{await x.close();}
});
test('#79 public activation: persisted production marker cannot be opened in compatibility mode',async()=>{
  const x=fixture();try{
    await x.activate();await x.plugin.dispose(new AbortController().signal);
    await assert.rejects(serverPlugin.activate({...x.host,settings:{}}),/implicit downgrade/);
  }finally{await x.close();}
});
for(const scenario of ['pause','reconfigure','owner-loss']){
  test('#81 public API: '+scenario+' during asynchronous Git preflight prevents worktree add',
    {timeout:15000},async()=>{
      const x=fixture();
      try{
        await x.activate();
        await x.peer('create',workflow);
        await x.peer('auto.configure',{workflowId:'wf',config:configuration});
        const plan=await x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'});
        x.holdPreflight();
        const active=x.peer('auto.worktree.create',{planId:plan.id});
        const rejected=assert.rejects(active,/generation|abort|loss|stopp|control|owner/i);
        await x.waitPreflight;
        if(scenario==='pause')await x.peer('auto.pause',{workflowId:'wf'});
        else if(scenario==='reconfigure')
          await x.peer('auto.configure',{workflowId:'wf',config:{...configuration,maxAttempts:2}});
        else {
          x.lifetime.abort(new Error('Synthetic ownership loss'));
          await assert.rejects(acquireStateOwner(x.state),/owner|locking/,
            'An in-flight Git operation must retain the original owner lock');
        }
        x.releasePreflight();
        await rejected;
        if(scenario==='owner-loss'){
          await x.plugin.dispose(new AbortController().signal);
          const successor=await acquireStateOwner(x.state);
          try{successor.assertHeld();}finally{await successor.release();}
        }
        assert.equal(x.calls.some(c=>c.args.includes('worktree')&&c.args.includes('add')),false,
          'No Git worktree mutation may escape an obsolete operation generation');
        assert.equal(existsSync(plan.path),false);
      }finally{await x.close();}
    });
}
