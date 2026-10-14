import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {parseLocalArguments,validateAuthFile,localReceipt,supervise} from '../scripts/local-pi-oauth-smoke.mjs';
import {REPO_ROOT} from '../scripts/e2e-contract.mjs';

const sha='a'.repeat(40);
const approved=['--mode','oauth','--expected-sha',sha,'--approve-account-use'];
function command(args,extras={}){
  const root=mkdtempSync(join(tmpdir(),'mm-local-runner-test-'));
  try{
    const result=spawnSync(process.execPath,['scripts/local-pi-oauth-smoke.mjs',...args],{
      cwd:REPO_ROOT,encoding:'utf8',timeout:20000,maxBuffer:65536,
      env:{PATH:process.env.PATH,HOME:root,TMPDIR:root,LANG:'C.UTF-8',...extras}});
    assert.equal(result.error,undefined,'Disposable supervisor must terminate');
    assert.equal(result.signal,null);
    const lines=result.stdout.trim().split('\n');
    assert.equal(lines.length,1,'Only a bounded result is printed');
    return {exit:result.status,receipt:JSON.parse(lines[0]),raw:result.stdout+result.stderr};
  }finally{rmSync(root,{force:true,recursive:true});}
}

test('Local OAuth runner: requires explicit consent/source, fixes Luna model and accepts only Low or Max',()=>{
  assert.equal(parseLocalArguments(approved).effort,'low');
  const max=parseLocalArguments([...approved,'--effort','max']);
  assert.equal(max.maxOutputTokens,4096);assert.equal(max.timeoutMs,120000);
  for(const args of [[],['--mode','oauth'],['--mode','oauth','--approve-account-use'],
    [...approved,'--effort','high'],[...approved,'--model','another-model'],
    [...approved,'--provider','another-provider'],[...approved,'--timeout-ms','120001'],
    [...approved,'--scenario','provider-error'],[...approved,'--pi-auth-file','relative'],
    ['--mode','faux','--pi-auth-file','/synthetic/auth.json']])
    assert.throws(()=>parseLocalArguments(args));
});

test('Local OAuth runner: missing consent and stale SHA block before credentials or model calls',()=>{
  const refused=command(['--mode','oauth'],{OPENAI_API_KEY:'SYNTHETIC-SECRET'});
  assert.equal(refused.exit,2);assert.equal(refused.receipt.code,'approval-required');
  assert.equal(refused.receipt.requests,0);assert.equal(refused.receipt.cleanup,'not-created');
  const stale=command(approved);
  assert.equal(stale.exit,2);assert.equal(stale.receipt.code,'sha-mismatch');
  assert.equal(stale.receipt.cleanup,'not-created');
  assert.doesNotMatch(refused.raw,/SYNTHETIC-SECRET/);
});

test('Local OAuth runner: private canonical ordinary auth file required, no chmod/creation/copy side effects',()=>{
  const root=mkdtempSync(join(tmpdir(),'mm-auth-metadata-'));
  try{
    const auth=join(root,'auth.json');writeFileSync(auth,'SYNTHETIC NON-CREDENTIAL',{mode:0o600});
    assert.equal(validateAuthFile(auth),auth);
    assert.equal(readFileSync(auth,'utf8'),'SYNTHETIC NON-CREDENTIAL');
    assert.throws(()=>validateAuthFile(join(root,'missing')),/credential-required/);
    const alias=join(root,'alias');symlinkSync(auth,alias);
    assert.throws(()=>validateAuthFile(alias),/credential-required/);
    chmodSync(auth,0o644);assert.throws(()=>validateAuthFile(auth),/credential-required/);
    chmodSync(auth,0o600);linkSync(auth,join(root,'linked'));
    assert.throws(()=>validateAuthFile(auth),/credential-required/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

for(const effort of ['low','max'])test('Local supervisor with real Pi SDK/faux '+effort+': report and no replay, never real-auth certification',()=>{
  const result=command(['--mode','faux','--effort',effort],{
    OPENAI_API_KEY:'SYNTHETIC-API-SECRET',GH_TOKEN:'SYNTHETIC-GH-SECRET',
    MM_E2E_API_KEY:'SYNTHETIC-OTHER-SECRET',PI_CODING_AGENT_DIR:'/unavailable/ambient'});
  assert.equal(result.exit,0);assert.equal(result.receipt.status,'passed');
  assert.equal(result.receipt.requests,2);assert.equal(result.receipt.cleanup,'removed');
  assert.equal(result.receipt.selection.effort,effort);
  assert.equal(result.receipt.checks.durableReopenNoReplay,'passed');
  assert.equal(result.receipt.checks.authentication,'not-verified');
  assert.equal(result.receipt.checks.qcLoop,'not-tested');
  assert.equal(result.receipt.checks.remotePublication,'not-tested');
  assert.doesNotMatch(result.raw,/SYNTHETIC-|unavailable\/ambient/);
});

for(const [scenario,code] of [['provider-error','input-not-completed'],['missing-report','missing-report'],
  ['duplicate-report','duplicate-report'],['request-budget','request-budget'],['slow','timed-out']]){
  test('Local supervisor '+scenario+': no fabricated success and joined disposable cleanup',()=>{
    const args=['--mode','faux','--scenario',scenario];
    if(scenario==='slow')args.push('--timeout-ms','500');
    const result=command(args);
    assert.equal(result.exit,1);assert.equal(result.receipt.code,code);
    assert.equal(result.receipt.status,'failed');assert.equal(result.receipt.cleanup,'removed');
    assert.equal(result.receipt.checks.authentication,'not-verified');
    assert.doesNotMatch(result.raw,/TEST-PRIVATE-PROVIDER-ERROR/);
  });
}

test('Local receipt never accepts unjoined success or emits arbitrary error/credential fields',()=>{
  const c=parseLocalArguments(approved);
  const r=localReceipt(c,null,{status:'passed',code:'ok',joined:false,requests:2,
    error:'SECRET',credential:{access:'SECRET'},transcript:'SECRET'});
  assert.equal(r.status,'failed');assert.equal(r.checks.authentication,'not-verified');
  assert.doesNotMatch(JSON.stringify(r),/SECRET|access|transcript/);
});

test('Local receipt output refuses existing destination before starting an SDK process',()=>{
  const root=mkdtempSync(join(tmpdir(),'mm-receipt-existing-'));
  try{
    const target=join(root,'result.json');writeFileSync(target,'preserve');
    const result=command(['--mode','faux','--receipt',target]);
    assert.notEqual(result.exit,0);assert.equal(result.receipt.code,'receipt-refused');
    assert.equal(result.receipt.requests,0);assert.equal(result.receipt.cleanup,'not-created');
    assert.equal(readFileSync(target,'utf8'),'preserve');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Local supervisor process error actively stops the child instead of disabling its timeout',async()=>{
  const child=new EventEmitter(),signals=[];
  child.kill=signal=>{signals.push(signal);return true;};
  child.send=(_message,callback)=>callback();
  const flight=supervise({timeoutMs:100},'/synthetic',undefined,()=>child);
  child.emit('error',new Error('SYNTHETIC PROCESS ERROR'));
  // Always close our synthetic child to release supervisor timers/listeners,
  // including when testing an implementation with the original faulty branch.
  child.emit('close',1,null);
  const result=await flight;
  assert.deepEqual(signals,['SIGTERM']);
  assert.equal(result.code,'runtime-failed');
  assert.equal(result.joined,false);
});
