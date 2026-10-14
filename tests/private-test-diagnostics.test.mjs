import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,statSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {boundedFailureDiagnostics} from '../dist/automation/test-diagnostics.js';
import {parseTestDiagnosticPolicy,capturePrivateFailure} from '../dist/automation/private-test-diagnostics.js';
import {assertTestEnvironment} from '../dist/automation/test-execution.js';
const secret='SYNTHETIC-DO-NOT-EXPOSE';
const output='not ok 1 - ordinary customer fixture\nnot ok 2 - known contract case\n'+secret+'\n';
const policy=()=>parseTestDiagnosticPolicy({labels:{'known contract case':'Contract regression'},retainPrivateRaw:true,maxRawBytes:1024,maxRawArtifacts:1});
test('#35 host allowlist exposes only approved public test labels, never arbitrary names or assertion bodies',()=>{
 const result=boundedFailureDiagnostics(output,'error TS2322: '+secret,policy());
 assert.doesNotMatch(result,/ordinary customer fixture|known contract case|SYNTHETIC/);
 const projected=JSON.parse(result);assert.equal(projected.failedTests[0].name,'[withheld: not allowlisted]');
 assert.equal(projected.failedTests[1].name,'Contract regression');assert.deepEqual(projected.compilerCodes,['TS2322']);
 const hidden=boundedFailureDiagnostics(output,'error TS2322',parseTestDiagnosticPolicy({compilerCodes:false}));
 assert.deepEqual(JSON.parse(hidden).compilerCodes,[]);
});
test('#35 raw capture defaults off and explicit local capture is private, bounded and immutable',()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-private-diagnostic-'));
 try{
  assert.equal(capturePrivateFailure(root,['run'],output,'',parseTestDiagnosticPolicy()).state,'disabled');
  assert.deepEqual(readdirSync(root),[]);
  const result=capturePrivateFailure(root,['run'],output+secret.repeat(100),'',policy());
  assert.equal(result.state,'retained');assert.equal(result.rawBytes,1024);assert.equal(result.truncated,true);
  assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC|customer/);
  const dir=join(root,'private-test-failures'),file=join(dir,result.ref+'.log');
  assert.equal(statSync(dir).mode&0o777,0o700);assert.equal(statSync(file).mode&0o777,0o600);
  assert.match(readFileSync(file,'utf8'),/SYNTHETIC-DO-NOT-EXPOSE/);
  const before=readFileSync(file);
  assert.equal(capturePrivateFailure(root,['run'],output+secret.repeat(100),'',policy()).state,'already-present');
  assert.equal(capturePrivateFailure(root,['second'],output,'',policy()).state,'budget-full');
  assert.deepEqual(readFileSync(file),before);assert.equal(readdirSync(dir).length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('#35 aliases never redirect optional raw capture outside new test state',()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-diagnostic-links-')),outside=mkdtempSync(join(tmpdir(),'mm-diagnostic-outside-'));
 try{
  writeFileSync(join(outside,'keep'),'sentinel');symlinkSync(outside,join(root,'private-test-failures'));
  assert.equal(capturePrivateFailure(root,['run'],output,'',policy()).state,'unavailable');
  assert.deepEqual(readdirSync(outside),['keep']);assert.equal(readFileSync(join(outside,'keep'),'utf8'),'sentinel');
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('#35 unsafe disclosure policy cannot silently expand unbounded raw retention',()=>{
 for(const value of [{labels:[]},{labels:{example:'http://private.invalid/token'}},{maxRawBytes:0},
  {maxRawArtifacts:Infinity},{retainPrivateRaw:'yes'},{unknown:true}])assert.throws(()=>parseTestDiagnosticPolicy(value),/diagnostic/);
});
test('#35 untrusted test output spoofing a bwrap failure is never copied into the error',()=>{
 assert.throws(()=>assertTestEnvironment({execution:'sandbox'},{exitCode:1,stderr:'bwrap: '+secret}),e=>{
  assert.doesNotMatch(e.message,/SYNTHETIC/);return /sandbox could not start/.test(e.message);
 });
});
