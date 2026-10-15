// Actual shipped PI WEB and sandboxed Chromium. Test-only adapter observes the
// public panel/peer; it neither inserts the missing UI nor fabricates QC success.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {launchHost} from '../scripts/hosted-e2e-host.mjs';

async function browserFixture(){
 // The disposable host must create owner-private state; preserve its strict check.
 const previousMask=process.umask(0o077);
 const root=mkdtempSync(join(tmpdir(),'mm-local-browser-ci-')),project=join(root,'project'),setup=join(root,'setup');
 mkdirSync(project,{mode:0o700});mkdirSync(setup,{mode:0o700});
 const env={PATH:'/usr/bin:/bin',HOME:setup,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
 const git=(...args)=>execFileSync('/usr/bin/git',['-C',project,...args],{env,encoding:'utf8',timeout:10000}).trim();
 git('init','-b','main');writeFileSync(join(project,'README.fixture'),'Local browser fixture\n');
 git('add','README.fixture');git('-c','user.name=Fixture','-c','user.email=fixture@invalid.local','commit','-m','Seed browser fixture');
 const nonce=randomBytes(8).toString('hex'),prefix='e2e/local-luna-'+nonce;
 const transport=join(root,'transport.json');writeFileSync(transport,JSON.stringify({pushCalls:0,mergeCalls:0,createCalls:0,readyCalls:0}),{mode:0o600});
 const trial={mode:'rehearsal',prefix,repository:'zkamiyama/pi-micromanager',base:prefix+'-base',head:prefix+'-final',
  seedSha:git('rev-parse','HEAD'),fixture:'examples/acceptance/'+nonce,bare:join(root,'unused-remote.git'),transport};
 let host;
 try{
  host=await launchHost(trial,{root,project,securityProfile:'local-owner'});
  const definition={id:'local-ui',title:'Local Journal acceptance',maxQcRounds:2,
   maxParallelByRole:{implementer:1,reviewer:1,architect:1,planner:1},permissions:{default:'deny'},
   tasks:[{id:'task',title:'Unstarted synthetic task',kind:'implementation',role:'implementer',dependsOn:[],description:'Do not launch a model',acceptanceCriteria:['Operator local image UI is available']}]};
  await host.importWorkflow(definition);
  return {...host,root,async close(){await host.close();rmSync(root,{recursive:true,force:true});}};
 }catch(error){if(host){await host.close();rmSync(root,{recursive:true,force:true});}throw error;}
 finally{process.umask(previousMask);}
}

test('local-owner actual browser: public peer enforces its request budget and never treats an unsealed upload as QC',
 {timeout:50000},async()=>{
 const x=await browserFixture();try{
  const ready=await x.peer('security.readiness',null);assert.equal(ready.mode,'local-owner');
  assert.equal(ready.workerTools,'sandbox-only-with-fixed-git-broker');
  const journal=await x.peer('auto.journal',{workflowId:'local-ui'});assert.ok(journal.local);
  await assert.rejects(x.peer('auto.journal.local.import',{workflowId:'local-ui',runId:'missing',sourceSha:'a'.repeat(40),
   requestId:'invalid-source',label:'Not QC evidence',base64:'AAAA'}));
  await assert.rejects(x.peer('auto.journal.local.import',{workflowId:'local-ui',runId:'missing',sourceSha:'a'.repeat(40),
   requestId:'too-large',label:'Synthetic oversized request',base64:'A'.repeat(300000)}),/large|max|limit|bytes/i);
  assert.equal((await x.peer('agents.list',{view:'all'})).length,0);
  assert.equal((await x.peer('auto.journal',{workflowId:'local-ui'})).local.artifacts.length,0);
 }finally{await x.close();}
});

test('local-owner actual browser: Journal exposes operator image, retained log, ADR link and maintenance controls',
 {timeout:50000},async()=>{
 const x=await browserFixture();try{
  await x.page.getByRole('button',{name:'JOURNAL',exact:true}).click();
  await x.page.getByRole('button',{name:'Load evidence-linked journal',exact:true}).click();
  const panel=x.page.locator('.mm-journal');
  await panel.getByRole('heading',{name:'Task and QC evidence',exact:true}).waitFor({state:'visible'});
  assert.ok(await panel.locator('input[type="file"]').count()>0,'Local operator image import is connected to the real Journal UI');
  assert.ok(await panel.getByRole('button',{name:/link.*ADR|ADR.*link/i}).count()>0,'Git ADR references have an explicit UI operation');
  assert.ok(await panel.getByText(/local.*storage|local.*usage|artifact.*quota/i).count()>0,'Local retention usage is visible');
 }finally{await x.close();}
});
