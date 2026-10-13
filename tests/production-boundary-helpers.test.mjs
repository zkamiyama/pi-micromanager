import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseProductionPolicy} from '../dist/security/policy.js';
import {assertWorkspaceBoundary} from '../dist/security/workspace-boundary.js';
import {assertStateActivation,persistProductionMode} from '../dist/security/state-mode.js';
const temp=()=>mkdtempSync(join(tmpdir(),'mm-boundary-'));
test('#79 helper: reject state/package ancestors and siblings from another allowlisted project',()=>{
 const root=temp();
 try{
  const project=join(root,'project'),other=join(root,'other'),state=join(root,'state'),code=join(root,'package');
  for(const p of [project,other,state,code])mkdirSync(p,{mode:0o700});
  const policy=parseProductionPolicy({mode:'production',projectRoots:[project,other,root],models:[{provider:'faux',model:'faux-1'}]});
  assert.equal(assertWorkspaceBoundary(policy,project,project,state,code),project);
  assert.throws(()=>assertWorkspaceBoundary(policy,project,other,state,code),/selected project/);
  assert.throws(()=>assertWorkspaceBoundary(policy,root,root,state,code),/overlaps/);
  assert.throws(()=>assertWorkspaceBoundary(policy,root,code,state,code),/overlaps/);
  assert.throws(()=>assertWorkspaceBoundary(policy,root,state,state,code),/overlaps/);
  const leaf=join(state,'managed-worktrees','a'.repeat(16),'workflow','task');mkdirSync(leaf,{recursive:true,mode:0o700});
  assert.equal(assertWorkspaceBoundary(policy,project,leaf,state,code),leaf);
  assert.throws(()=>assertWorkspaceBoundary(policy,project,join(state,'managed-worktrees'),state,code),/exact managed/);
  const alias=join(root,'alias');symlinkSync(project,alias);
  assert.throws(()=>assertWorkspaceBoundary(policy,project,alias,state,code),/canonical/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('#79 helper: persisted production marker refuses missing policy and corrupted metadata',()=>{
 const root=temp();try{
  assert.doesNotThrow(()=>assertStateActivation(root,false));persistProductionMode(root);persistProductionMode(root);
  assert.throws(()=>assertStateActivation(root,false),/implicit downgrade/);
  assert.doesNotThrow(()=>assertStateActivation(root,true));
  writeFileSync(join(root,'.micromanager-production.json'),'{}');
  assert.throws(()=>assertStateActivation(root,true),/contents/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('#79 helper: restore quarantine applies even to a compatibility request',()=>{
 const root=temp();try{
  writeFileSync(join(root,'RESTORE_REQUIRES_REVIEW'),'synthetic',{mode:0o600});
  assert.throws(()=>assertStateActivation(root,false),/quarantined/);
  assert.throws(()=>persistProductionMode(root),/quarantined/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
