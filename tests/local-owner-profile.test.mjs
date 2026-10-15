import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseProductionPolicy,assertProductionConfig,assertProductionDestination} from '../dist/security/policy.js';
import {assertLocalOwnerState,persistProductionMode} from '../dist/security/state-mode.js';
import {guardedHostExecution} from '../dist/security/host-execution.js';
import {fixture,workflow,configuration} from './helpers/production-server-fixture.mjs';

test('ADR20 local-owner is an explicit fresh profile, never an implicit downgrade of strict/native state',()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-owner-profile-'));
 try{
  persistProductionMode(root);assert.throws(()=>assertLocalOwnerState(root,true),/fresh empty/);
  assert.doesNotThrow(()=>assertLocalOwnerState(root,false));
  rmSync(join(root,'.micromanager-production.json'));
  writeFileSync(join(root,'native.sqlite'),'synthetic');assert.throws(()=>assertLocalOwnerState(root,true),/fresh empty/);
  rmSync(join(root,'native.sqlite'));
  assertLocalOwnerState(root,true);persistProductionMode(root);assertLocalOwnerState(root,true);
  assert.throws(()=>assertLocalOwnerState(root,false),/original hardened/);
  writeFileSync(join(root,'.micromanager-local-owner.json'),'{}');assert.throws(()=>assertLocalOwnerState(root,true),/Invalid/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('ADR20 public local-owner server allows explicit YOLO but preserves native, model, test and state boundaries',async()=>{
 const x=fixture();x.host.settings.productionSecurity.mode='local-owner';
 x.host.settings.productionSecurity.publication=[{repository:'fixture/test',baseBranch:'trial-base'}];
 try{
  await x.activate();const ready=await x.peer('security.readiness',null);
  assert.equal(ready.mode,'local-owner');assert.equal(ready.workerTools,'sandbox-only-with-fixed-git-broker');
  assert.equal(ready.supportedAutomation,'durable-only');assert.equal(ready.universalSafetyGuarantee,false);
  assert.equal(ready.controlPlaneOwnership,'locked');
  await x.peer('create',{...workflow,permissions:{default:'deny',actions:{'git.commit':'allow','git.push':'allow','github.pr.create':'allow','github.pr.merge':'allow'}}});
  await x.peer('auto.configure',{workflowId:'wf',config:configuration});
  for(const cfg of [{...configuration,runtime:'pi-web'}, {...configuration,test:{execution:'trusted-host',file:'node',args:[]}}])
   await assert.rejects(x.peer('auto.configure',{workflowId:'wf',config:cfg}),/Production/);
  await assert.rejects(x.peer('agents.create',{}),/forbidden/);
  assert.ok(existsSync(join(x.state,'.micromanager-local-owner.json')));
 }finally{await x.close();}
});

test('ADR20 strict policy still rejects YOLO, local-owner still needs exact host publication authority and bounds',()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-owner-policy-'));
 try{
  const raw={mode:'production',projectRoots:[root],models:[{provider:'faux',model:'faux-1'}],publication:[{repository:'fixture/test',baseBranch:'trial-base'}]};
  const strict=parseProductionPolicy(raw),local=parseProductionPolicy({...raw,mode:'local-owner'});
  const wf={permissions:{default:'deny',actions:{'git.push':'allow','github.pr.create':'allow','github.pr.merge':'allow'}}};
  assert.throws(()=>assertProductionConfig(strict,configuration,wf),/approval/);
  assert.doesNotThrow(()=>assertProductionConfig(local,configuration,wf));
  for(const [repo,base] of [['fixture/else','trial-base'],['fixture/test','main']])assert.throws(()=>assertProductionDestination(local,repo,base),/allowlist/);
  assert.throws(()=>assertProductionConfig({...local,publication:[]},configuration,wf),/host-reviewed/);
  assert.throws(()=>parseProductionPolicy({...raw,localRetention:{maxBytes:1024}}),/requires explicit/);
  for(const localRetention of [{autoReclaimWorktrees:'yes'},{maxBytes:0},{maxAgeDays:0},{ignored:true}])
   assert.throws(()=>parseProductionPolicy({...raw,mode:'local-owner',localRetention}));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('ADR20 per-operation callback executes after async Git guard and is never sent to the native host',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-owner-fence-'));let valid=true,mutations=0;
 try{
  const policy=parseProductionPolicy({mode:'local-owner',projectRoots:[root],models:[{provider:'faux',model:'faux-1'}]});
  const exec=async request=>{
   assert.equal(Object.hasOwn(request,'assertOperation'),false);
   if(request.args.includes('config'))valid=false;else mutations++;
   return {exitCode:0,signal:null,stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false};
  };
  const guarded=guardedHostExecution(exec,policy);
  await assert.rejects(guarded({file:'git',args:['-C',root,'worktree','remove','/test-owned'],signal:new AbortController().signal,
   assertOperation:()=>{if(!valid)throw Error('stale operation');}}),/stale operation/);
  assert.equal(mutations,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
