import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectStorage,parseStorageLimits} from '../dist/security/storage-admission.js';
import {RunSafetyLedger,DEFAULT_LIMITS} from '../dist/security/run-safety.js';
import {fixture,workflow,configuration} from './helpers/production-server-fixture.mjs';
const MB=1024*1024;
const bounds=parseStorageLimits({maxStateBytes:4*MB,warningStateBytes:2*MB,minAvailableBytes:MB,warningAvailableBytes:2*MB});
const system=(available=8*MB)=>({now:()=>100,available:()=>available});
const temporary=()=>mkdtempSync(join(tmpdir(),'mm-capacity-'));
test('#87 bounded metadata scan separates managed assets and reports warning/free-space without file content',()=>{
 const root=temporary();try{
  mkdirSync(join(root,'managed-worktrees'),{mode:0o700});
  writeFileSync(join(root,'managed-worktrees/file'),Buffer.alloc(MB));
  writeFileSync(join(root,'control'),Buffer.alloc(MB));
  const report=inspectStorage(root,bounds,system());
  assert.equal(report.status,'warning');assert.equal(report.stateBytes,2*MB);
  assert.equal(report.managedBytes,MB);assert.equal(report.complete,true);assert.equal(report.hardQuotaVerified,false);
  assert.equal(inspectStorage(root,bounds,system(MB)).reason,'available-limit');
  assert.equal(inspectStorage(root,bounds,system(2*MB-1)).status,'warning');
  assert.doesNotMatch(JSON.stringify(report),/managed-worktrees|\/tmp\/|control/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('#87 aliases, unavailable capacity and exceeded scan bounds fail closed without following entries',()=>{
 const root=temporary(),outside=temporary();try{
  writeFileSync(join(outside,'keep'),'synthetic-private-sentinel');
  symlinkSync(join(outside,'keep'),join(root,'alias'));
  assert.equal(inspectStorage(root,bounds,system()).reason,'unsafe-entry');
  rmSync(join(root,'alias'));
  linkSync(join(outside,'keep'),join(root,'link'));
  assert.equal(inspectStorage(root,bounds,system()).reason,'unsafe-entry');rmSync(join(root,'link'));
  assert.equal(inspectStorage(root,bounds,{...system(),available(){throw Error('synthetic');}}).reason,'unavailable');
  for(let i=0;i<101;i++)writeFileSync(join(root,'item-'+i),'data');
  assert.equal(inspectStorage(root,{...bounds,maxEntries:100},system()).reason,'scan-limit');
  let clock=0;assert.equal(inspectStorage(root,{...bounds,maxScanMs:10},{now:()=>clock+=20,available:()=>8*MB}).reason,'scan-limit');
  assert.equal(readFileSync(join(outside,'keep'),'utf8'),'synthetic-private-sentinel');
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('#87 invalid or contradictory operator limits are rejected instead of treated as unlimited',()=>{
 for(const input of [{unknown:1},{maxStateBytes:0},{maxEntries:Infinity},{maxScanMs:0},
  {warningStateBytes:8*1024**3},{warningAvailableBytes:1024}])assert.throws(()=>parseStorageLimits(input),/storage/);
});
test('#87 public server refuses new work under capacity pressure and admits again only after a fresh measurement',async()=>{
 const x=fixture();x.host.settings.productionSecurity.storage=bounds;
 try{
  await x.activate();await x.peer('create',workflow);await x.peer('auto.configure',{workflowId:'wf',config:configuration});
  const prepared=await x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'});
  writeFileSync(join(x.state,'synthetic-pressure'),Buffer.alloc(4*MB));
  const status=await x.peer('security.capacity',null);
  assert.equal(status.status,'blocked');assert.equal(status.reason,'state-limit');
  await assert.rejects(x.peer('auto.worktree.create',{planId:prepared.id}),/Storage admission blocked/);
  await assert.rejects(x.peer('auto.start',{workflowId:'wf'}),/Storage admission blocked/);
  await assert.rejects(x.peer('auto.propose',{goal:'No model call',provider:'faux',model:'faux-1',runtime:'durable'}),/Storage admission blocked/);
  assert.equal(x.calls.some(c=>c.args.includes('worktree')&&c.args.includes('add')),false);
  assert.ok(await x.peer('get','wf'),'Operator inspection must remain available');
  rmSync(join(x.state,'synthetic-pressure'));
  const cleared=await x.peer('security.capacity',null);assert.notEqual(cleared.status,'blocked');
  const created=await x.peer('auto.worktree.create',{planId:prepared.id});assert.equal(created.stage,'created');
 }finally{await x.close();}
});
test('#87 capacity limits survive activation while uncertain Run reservations and evidence are retained',async()=>{
 const x=fixture();x.host.settings.productionSecurity.storage=bounds;
 try{
  await x.activate();
  const path=join(x.state,'run-safety.sqlite'),key='a'.repeat(64);
  const ledger=new RunSafetyLedger(path);
  ledger.reserve(key,'synthetic',{...DEFAULT_LIMITS,maxConcurrentRuns:1},Date.now());
  ledger.finish(key,'uncertain');ledger.close();
  writeFileSync(join(x.state,'synthetic-pressure'),Buffer.alloc(4*MB));
  await x.plugin.dispose(new AbortController().signal);await x.activate();
  assert.equal((await x.peer('security.capacity',null)).reason,'state-limit');
  const reopened=new RunSafetyLedger(path);
  try{
   assert.equal(reopened.get(key).outcome,'uncertain');
   assert.throws(()=>reopened.reserve('b'.repeat(64),'other',{...DEFAULT_LIMITS,maxConcurrentRuns:1},Date.now()),/admission budget/);
  }finally{reopened.close();}
 }finally{await x.close();}
});
test('#87 public capacity status exposes uncertainty and never auto-deletes an unexpected link',async()=>{
 const x=fixture();try{
  await x.activate();writeFileSync(join(x.temp,'outside'),'private-synthetic');symlinkSync(join(x.temp,'outside'),join(x.state,'unknown'));
  assert.equal((await x.peer('security.capacity',null)).reason,'unsafe-entry');
  await assert.rejects(x.peer('auto.propose',{goal:'No execution',provider:'faux',model:'faux-1'}),/Storage admission blocked/);
  assert.equal(readFileSync(join(x.temp,'outside'),'utf8'),'private-synthetic');
 }finally{await x.close();}
});
test('#87 real public Git preflight rechecks capacity immediately before Worktree mutation',async()=>{
 const x=fixture();x.host.settings.productionSecurity.storage=bounds;
 try{
  await x.activate();await x.peer('create',workflow);await x.peer('auto.configure',{workflowId:'wf',config:configuration});
  const plan=await x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'});
  x.holdPreflight();const pending=x.peer('auto.worktree.create',{planId:plan.id});
  const stopped=assert.rejects(pending,/Storage admission blocked/);
  await x.waitPreflight;writeFileSync(join(x.state,'synthetic-pressure'),Buffer.alloc(4*MB));
  x.releasePreflight();await stopped;
  assert.equal(x.calls.some(c=>c.args.includes('worktree')&&c.args.includes('add')),false);
  assert.equal(readFileSync(join(x.state,'synthetic-pressure')).length,4*MB);
 }finally{await x.close();}
});

test('#87 internal dependency symlinks inside one exact managed leaf are counted, not traversed',()=>{
 const root=temporary();try{
  const leaf=join(root,'managed-worktrees','a'.repeat(16),'workflow','task');mkdirSync(join(leaf,'node_modules/.bin'),{recursive:true,mode:0o700});
  writeFileSync(join(leaf,'node_modules/tool.js'),'synthetic dependency');
  symlinkSync('../tool.js',join(leaf,'node_modules/.bin/tool'));
  const observed=inspectStorage(root,bounds,system());assert.equal(observed.status,'ok');assert.ok(observed.managedBytes>0);
  symlinkSync(root,join(leaf,'forbidden-control-alias'));
  assert.equal(inspectStorage(root,bounds,system()).reason,'unsafe-entry');
 }finally{rmSync(root,{recursive:true,force:true});}
});
