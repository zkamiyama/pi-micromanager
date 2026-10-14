import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseHostedArguments} from '../scripts/hosted-acceptance.mjs';
import {publicationServerWrapper,manualPublicationConfig,TRIAL_REPOSITORY} from '../scripts/hosted-publication-trial.mjs';

test('#92 hosted runner requires explicit real-account and exact-source publication authority',()=>{
 assert.equal(parseHostedArguments(['--mode','faux']).publish,false);
 for(const args of [[],['--mode','unknown'],['--mode','oauth'],['--mode','oauth','--expected-sha','a'.repeat(40)],
  ['--mode','faux','--approve-test-publication'],['--mode','faux','--pi-auth-file','/selected/auth'],
  ['--mode','faux','--unknown'],['--mode','faux','--mode','faux']])assert.throws(()=>parseHostedArguments(args));
 assert.equal(parseHostedArguments(['--mode','oauth','--approve-account-use','--expected-sha','a'.repeat(40)]).mode,'oauth');
 assert.equal(TRIAL_REPOSITORY,'zkamiyama/pi-micromanager');
});
test('#92 missing opt-in is rejected without starting a host or reading any credential',()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-hosted-cli-test-'));
 try{
  const result=spawnSync(process.execPath,['scripts/hosted-acceptance.mjs','--mode','oauth'],{
   encoding:'utf8',timeout:4000,env:{PATH:'/usr/bin:/bin',HOME:root,MM_E2E_API_KEY:'SYNTHETIC-MUST-NOT-APPEAR'}});
  assert.equal(result.status,2);const receipt=JSON.parse(result.stdout.trim());
  assert.equal(receipt.status,'blocked');assert.equal(receipt.cleanup,'not-created');
  assert.doesNotMatch(result.stdout+result.stderr,/SYNTHETIC-MUST/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('#92 fault adapter discards only one confirmed merge response and refuses any repeated mutation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-merge-fault-test-'));
 try{
  const loss=join(root,'lost.json'),audit=join(root,'audit.jsonl'),script=join(root,'wrapper.mjs');
  writeFileSync(script,"const actual={async activate(host){return host;}};\n"+publicationServerWrapper('actual',loss,audit));
  const wrapper=await import(pathToFileURL(script).href);let requests=0;
  const host=await wrapper.default.activate({execFile:async()=>{requests++;return {exitCode:0,stdout:'HTTP/2.0 200 OK\r\n\r\n{\n  "merged": true\n}',stderr:''};}});
  const request={file:'gh',args:['api','--method','PUT','repos/zkamiyama/pi-micromanager/pulls/123/merge']};
  await assert.rejects(host.execFile(request),/Synthetic lost merge/);
  assert.equal(JSON.parse(readFileSync(loss,'utf8')).responseDiscarded,true);
  await assert.rejects(host.execFile(request),/Second merge request refused/);
  assert.equal(requests,1);assert.equal(readFileSync(audit,'utf8').trim().split('\n').length,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('#92 manual Worktree configuration is valid public JSON, not an undefined-valued property',()=>{
 const input={managedWorktrees:true,workspaces:{source:'real-id'},finalization:{workspaceId:'final-id',autoMerge:true}};
 const result=manualPublicationConfig(input);
 assert.equal(Object.hasOwn(result,'managedWorktrees'),false);
 assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
 assert.equal(input.managedWorktrees,true);
});
