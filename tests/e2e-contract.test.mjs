import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseE2EArguments,sourceEvidence,authorizeE2E,e2eReceipt,writeReceipt,
  COMPONENTS,REPO_ROOT} from '../scripts/e2e-contract.mjs';

const sha='a'.repeat(40);
const real=['--mode','authenticated','--provider','openai','--model','synthetic-model',
  '--expected-sha',sha,'--approve-billed-test','--test-identity-only'];
const temp=()=>mkdtempSync(join(tmpdir(),'mm-e2e-contract-'));
function command(args,extra={}){
  const home=temp();
  try{
    const result=spawnSync(process.execPath,['scripts/durable-auth-smoke.mjs',...args],{
      cwd:REPO_ROOT,encoding:'utf8',timeout:12000,maxBuffer:64*1024,
      env:{PATH:process.env.PATH,HOME:home,TMPDIR:home,LANG:'C.UTF-8',...extra}});
    assert.equal(result.error,undefined,'The disposable test process must terminate');
    assert.equal(result.signal,null);
    const lines=result.stdout.trim().split('\n');
    assert.equal(lines.length,1,'Only a bounded JSON receipt is printed');
    return {exit:result.status,receipt:JSON.parse(lines[0]),raw:result.stdout+result.stderr};
  }finally{rmSync(home,{recursive:true,force:true});}
}

test('#90 admission: faux requires explicit mode and never selects a real default provider',()=>{
  const x=parseE2EArguments(['--mode','faux']);
  assert.equal(x.provider,'faux');assert.equal(x.model,'faux-1');
  for(const args of [[],['openai','any-model'],['--mode','authenticated'],
    ['--mode','faux','--provider','openai'],['--mode','faux','--mode','faux'],
    ['--mode','faux','--unknown','anything'],['--mode','faux','--timeout-ms','0'],
    ['--mode','faux','--timeout-ms','60001'],['--mode','faux','--receipt','relative.json']]){
    assert.throws(()=>parseE2EArguments(args));
  }
});
test('#90 admission: billed usage, test identity and exact source must all be explicit',()=>{
  assert.throws(()=>parseE2EArguments(real.filter(x=>x!=='--approve-billed-test')),/approval-required/);
  assert.throws(()=>parseE2EArguments(real.filter(x=>x!=='--test-identity-only')),/test-identity-required/);
  assert.throws(()=>parseE2EArguments(real.filter(x=>x!=='--expected-sha'&&x!==sha)),/source-unproved/);
  const config=parseE2EArguments(real);
  assert.throws(()=>authorizeE2E(config,{commit:sha,workingTreeClean:true},undefined),/credential-required/);
  assert.throws(()=>authorizeE2E(config,{commit:'b'.repeat(40),workingTreeClean:true},'synthetic-key'),/sha-mismatch/);
  assert.throws(()=>authorizeE2E(config,{commit:sha,workingTreeClean:false},'synthetic-key'),/dirty-checkout/);
});
test('#90 version evidence reports installed and locked SDKs, exact SHA and lock digest',()=>{
  const source=sourceEvidence();
  assert.match(source.commit,/^[a-f0-9]{40}$/);
  assert.match(source.lockSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(source.versions),[...COMPONENTS]);
  assert.equal(typeof source.workingTreeClean,'boolean');
});
test('#90 real public SDK + faux provider stores one report and reopens without resubmission',()=>{
  const result=command(['--mode','faux'],{MM_E2E_API_KEY:'synthetic-unused-key',
    OPENAI_API_KEY:'SYNTHETIC-AMBIENT-CREDENTIAL',GH_TOKEN:'SYNTHETIC-GITHUB-TOKEN'});
  assert.equal(result.exit,0);assert.equal(result.receipt.status,'passed');
  assert.equal(result.receipt.requests,2);assert.equal(result.receipt.cleanup,'removed');
  assert.equal(result.receipt.checks.durableReopenNoReplay,'passed');
  assert.equal(result.receipt.checks.authentication,'not-verified');
  assert.equal(result.receipt.checks.remotePublication,'not-tested');
  assert.equal(result.receipt.productionSafetyGuaranteed,false);
  assert.doesNotMatch(result.raw,/SYNTHETIC-AMBIENT|SYNTHETIC-GITHUB|synthetic-unused-key/);
});
for(const [scenario,code] of [['provider-error','input-not-completed'],
  ['missing-report','missing-report'],['duplicate-report','duplicate-report'],['request-budget','request-budget']]){
  test('#90 '+scenario+' cannot produce a passing receipt',()=>{
    const result=command(['--mode','faux','--scenario',scenario]);
    assert.equal(result.exit,1);assert.equal(result.receipt.status,'failed');
    assert.equal(result.receipt.code,code);assert.equal(result.receipt.cleanup,'removed');
    assert.doesNotMatch(result.raw,/TEST-PRIVATE-PROVIDER-ERROR-MUST-NOT-LEAK/);
  });
}
test('#90 timeout aborts and joins the delayed disposable SDK call before cleanup',()=>{
  const result=command(['--mode','faux','--scenario','slow','--timeout-ms','1000']);
  assert.equal(result.exit,1);assert.equal(result.receipt.code,'timed-out');
  assert.equal(result.receipt.cleanup,'removed');
});
test('#90 real auth without consent is blocked before state allocation or credentials',()=>{
  const result=command(['--mode','authenticated','--provider','openai','--model','synthetic-model'],
    {MM_E2E_API_KEY:'SYNTHETIC-KEY-MUST-NEVER-BE-USED'});
  assert.equal(result.exit,2);assert.equal(result.receipt.status,'blocked');
  assert.equal(result.receipt.code,'approval-required');
  assert.equal(result.receipt.cleanup,'not-created');assert.equal(result.receipt.requests,0);
  assert.doesNotMatch(result.raw,/SYNTHETIC-KEY-MUST-NEVER-BE-USED/);
});
test('#90 receipts project allowed fields and never serialize arbitrary errors or transcripts',()=>{
  const receipt=e2eReceipt(parseE2EArguments(['--mode','faux']),null,
    {status:'failed',code:'SECRET-ERROR',requests:1,cleanup:'removed',error:'SECRET-ERROR',transcript:'SECRET-TEXT'});
  assert.equal(receipt.code,'runtime-failed');
  assert.doesNotMatch(JSON.stringify(receipt),/SECRET/);
});
test('#90 receipt file refuses overwrite and symlinked parent; only a fresh private file is written',()=>{
  const root=temp();
  try{
    const file=join(root,'result.json'),receipt=e2eReceipt(undefined,null,{status:'blocked',code:'approval-required'});
    writeReceipt(file,receipt);assert.equal(statSync(file).mode&0o777,0o600);
    const before=readFileSync(file,'utf8');
    assert.throws(()=>writeReceipt(file,receipt),/receipt-refused/);
    assert.equal(readFileSync(file,'utf8'),before);
    const target=join(root,'target'),alias=join(root,'alias');mkdirSync(target);symlinkSync(target,alias);
    assert.throws(()=>writeReceipt(join(alias,'result.json'),receipt),/receipt-refused/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('#92 obsolete unconfined model coding smoke fails closed rather than claiming replacement coverage',()=>{
  const r=spawnSync(process.execPath,['scripts/real-durable-autopilot-smoke.mjs'],{
    cwd:REPO_ROOT,encoding:'utf8',timeout:2000,env:{PATH:process.env.PATH}});
  assert.equal(r.status,2);
  assert.equal(JSON.parse(r.stdout).code,'legacy-autopilot-smoke-unqualified');
});
