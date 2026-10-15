import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {evaluateTap,SUITES} from '../scripts/local-owner-ci.mjs';
const tap=({tests=2,pass=2,fail=0,cancelled=0,skipped=0,todo=0}={})=>
 `TAP version 13\n1..${tests}\n# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped ${skipped}\n# todo ${todo}\n`;
test('local CI gate accepts only complete nonempty zero-skip successful evidence',()=>{
 assert.equal(evaluateTap(tap(),0,2).passed,true);
 for(const [text,code,min] of [[tap(),1,2],[tap(),null,2],['',0,2],[tap({tests:0,pass:0}),0,1],
  [tap({pass:1,fail:1}),0,2],[tap({pass:1,skipped:1}),0,2],[tap({pass:1,todo:1}),0,2],
  [tap({pass:1,cancelled:1}),0,2],[tap(),0,3],[tap()+tap(),0,2]])
  assert.equal(evaluateTap(text,code,min).passed,false);
});
test('local CI gate records failed test names without losing failed exit status',()=>{
 const result=evaluateTap('not ok 2 - synthetic rejection\n'+tap({pass:1,fail:1}),1,2);
 assert.equal(result.passed,false);assert.deepEqual(result.failures,['synthetic rejection']);
});
test('local CI gate manifests refer to explicit existing suites and cannot silently match zero files',()=>{
 assert.deepEqual(Object.keys(SUITES),['contracts','lifecycle','browser']);
 for(const suite of Object.values(SUITES)){
  assert.ok(suite.minimum>0);assert.ok(suite.files.length>0);
  for(const file of suite.files)assert.equal(existsSync(new URL('../'+file,import.meta.url)),true,file);
 }
});
