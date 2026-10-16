// Actual shipped PI WEB and sandboxed Chromium. Test-only adapter observes the
// public panel/peer; it neither inserts the missing UI nor fabricates QC success.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {launchHost} from '../scripts/hosted-e2e-host.mjs';

async function browserFixture({complete=false,withoutWorkflow=false}={}){
 // The disposable host must create owner-private state; preserve its strict check.
 const previousMask=process.umask(0o077);
 const root=mkdtempSync(join(tmpdir(),'mm-local-browser-ci-')),project=join(root,'project'),setup=join(root,'setup');
 mkdirSync(project,{mode:0o700});mkdirSync(setup,{mode:0o700});
 const env={PATH:'/usr/bin:/bin',HOME:setup,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
 const git=(...args)=>execFileSync('/usr/bin/git',['-C',project,...args],{env,encoding:'utf8',timeout:10000}).trim();
 const nonce=randomBytes(8).toString('hex'),prefix='e2e/local-luna-'+nonce,fixture='examples/acceptance/'+nonce;
 git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@invalid.local');
 writeFileSync(join(project,'README.fixture'),'Local browser fixture\n');
 mkdirSync(join(project,fixture),{recursive:true});writeFileSync(join(project,fixture,'verify.mjs'),"import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';assert.equal(readFileSync(new URL('./a.txt',import.meta.url),'utf8'),'A\\n');\n");
 mkdirSync(join(project,'docs/adr'),{recursive:true});writeFileSync(join(project,'docs/adr/0001-ui.md'),'# Local decision\n\nKeep ADRs in Git, not in the disposable Journal.\n');
 git('add','.');git('commit','-m','Seed browser fixture');git('remote','add','origin','https://github.com/fixture/test.git');
 const transport=join(root,'transport.json');writeFileSync(transport,JSON.stringify({pushCalls:0,mergeCalls:0,createCalls:0,readyCalls:0}),{mode:0o600});
 const trial={mode:'rehearsal',prefix,repository:'zkamiyama/pi-micromanager',base:prefix+'-base',head:prefix+'-final',
  seedSha:git('rev-parse','HEAD'),fixture,bare:join(root,'unused-remote.git'),transport};
 let host;
 try{
  host=await launchHost(trial,{root,project,securityProfile:'local-owner'});
  const definition={id:'local-ui',title:'Local Journal acceptance',maxQcRounds:2,
   maxParallelByRole:{implementer:1,reviewer:1,architect:1,planner:1},permissions:{default:'deny'},
   tasks:[{id:'task',title:'Unstarted synthetic task',kind:'implementation',role:'implementer',dependsOn:[],description:'Do not launch a model',acceptanceCriteria:['Operator local image UI is available']}]};
  if(complete){
   definition.permissions={default:'allow',actions:{'git.push':'deny','github.pr.create':'deny','github.pr.merge':'deny','deploy.production':'deny'}};
   definition.tasks=[{id:'a',title:'Create a synthetic marker',kind:'implementation',role:'implementer',dependsOn:[],
    description:'Write '+fixture+'/a.txt containing A followed by a newline.',acceptanceCriteria:['The isolated marker test passes']}];
  }
  if(!withoutWorkflow)await host.importWorkflow(definition);
  if(complete){
   const model={provider:'faux',model:'faux-1',effort:'low'};
   const config={runtime:'durable',managedWorktrees:true,workspaces:{},models:{implementer:model,qc:model,planner:model,architect:model},
    test:{execution:'sandbox',file:'node',args:[fixture+'/verify.mjs'],timeoutMs:10000},maxAttempts:1};
   await host.peer('auto.configure',{workflowId:'local-ui',config});
   const proposed=await host.peer('auto.worktree.preview',{workflowId:'local-ui',taskId:'a'});
   const plan=await host.peer('auto.worktree.create',{planId:proposed.id}),identity=await host.identity();
   const ws=createHash('sha1').update(identity.projectId+':'+plan.path).digest('hex').slice(0,12);
   await host.peer('auto.configure',{workflowId:'local-ui',config:{...config,workspaces:{a:ws}}});
   await host.peer('auto.start',{workflowId:'local-ui'});
   const end=Date.now()+35000;let done=false;
   while(Date.now()<end){
    const wf=await host.peer('get','local-ui'),runs=await host.peer('agents.list',{view:'all'});
    if(wf.tasks.a.status==='passed'&&runs.length===2&&runs.every(r=>r.phase==='sealed')){done=true;break;}
    await new Promise(r=>setTimeout(r,100));
   }
   assert.equal(done,true,'The real browser test requires actual Harness implementation/QC completion');
   await host.peer('auto.pause',{workflowId:'local-ui'});
   git('merge','--ff-only',plan.branch);
   const proof=await host.peer('auto.integration.preview',{workflowId:'local-ui',taskId:'a',targetWorkspaceId:identity.workspaceId});
   await host.peer('auto.integration.confirm',{previewId:proof.id});
  }
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

test('local-owner actual browser: import/view/pin local images, read archived activity and retain a Git ADR after restart',
 {timeout:85000},async()=>{
 const x=await browserFixture({complete:true});try{
  const page=x.page,identity=await x.identity();
  await page.getByRole('button',{name:'JOURNAL',exact:true}).click();
  await page.getByRole('button',{name:'Load evidence-linked journal',exact:true}).click();
  const panel=page.locator('.mm-local-journal');await panel.waitFor();
  let journal=await x.peer('auto.journal',{workflowId:'local-ui'});
  const qc=journal.runs.find(r=>r.seat==='qc'&&r.phase==='sealed');assert.ok(qc);
  await panel.getByLabel('Local image QC Run',{exact:true}).selectOption(qc.runId);
  // Genuine bounded JPEG bytes produced by this sandboxed browser itself.
  const bytes=await page.screenshot({type:'jpeg',quality:20});assert.ok(bytes.length<180*1024);
  await panel.getByLabel('Local image file',{exact:true}).setInputFiles({name:'synthetic.jpg',mimeType:'image/jpeg',buffer:bytes});
  await panel.getByRole('button',{name:'Import local image',exact:true}).click();
  await panel.getByRole('button',{name:'View local image',exact:true}).waitFor();
  assert.equal(await panel.locator('img').count(),0,'Image bytes are not fetched/rendered until explicit view');
  await panel.getByRole('button',{name:'View local image',exact:true}).click();
  await panel.locator('img').waitFor();
  assert.ok(await panel.locator('img').evaluate(async image=>{await image.decode();return image.naturalWidth;})>0,'The actual browser decodes the stored image inside the host panel');
  const image=panel.locator('.mm-local-artifact').filter({has:page.getByRole('button',{name:'View local image',exact:true})});
  await image.getByRole('button',{name:'Pin local artifact',exact:true}).click();
  await image.getByRole('button',{name:'Unpin local artifact',exact:true}).waitFor();
  journal=await x.peer('auto.journal',{workflowId:'local-ui'});assert.equal(journal.local.artifacts.find(a=>a.kind==='image').pinned,true);
  await panel.getByLabel('ADR Workspace ID',{exact:true}).fill(identity.workspaceId);
  await panel.getByLabel('ADR tracked path',{exact:true}).fill('docs/adr/0001-ui.md');
  await panel.getByRole('button',{name:'Link Git ADR',exact:true}).click();
  const adr=panel.getByRole('link',{name:'Local decision',exact:true});await adr.waitFor();
  const href=await adr.getAttribute('href');assert.match(href,/^https:\/\/github.com\/fixture\/test\/blob\/[a-f0-9]{40}\/docs\/adr\/0001-ui.md$/);
  await image.getByRole('button',{name:'Unpin local artifact',exact:true}).click();
  await image.getByRole('button',{name:'Pin local artifact',exact:true}).waitFor();
  await panel.getByRole('button',{name:'Run local maintenance',exact:true}).click();
  const end=Date.now()+15000;let archived=false;
  while(Date.now()<end){
   journal=await x.peer('auto.journal',{workflowId:'local-ui'});
   if(journal.local.artifacts.some(a=>a.kind==='run-log'&&a.state==='ready')){archived=true;break;}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(archived,true);await panel.getByRole('button',{name:'Refresh local Journal',exact:true}).click();
  await panel.getByRole('button',{name:'Read compressed activity',exact:true}).first().click();
  await panel.locator('pre.mm-local-log').waitFor();assert.match(await panel.locator('pre.mm-local-log').innerText(),/public-run-projection/);
  await x.restart();await page.getByRole('button',{name:'JOURNAL',exact:true}).click();
  await page.getByRole('button',{name:'Load evidence-linked journal',exact:true}).click();
  await page.locator('.mm-local-journal').getByRole('link',{name:'Local decision',exact:true}).waitFor();
  assert.equal(await page.locator('.mm-local-journal').getByRole('link',{name:'Local decision',exact:true}).getAttribute('href'),href);
 }finally{await x.close();}
});


test('local-owner actual browser: Journal without a selected Workflow shows an actionable state',
 {timeout:50000},async()=>{
 const x=await browserFixture({withoutWorkflow:true});try{
  const tab=x.page.getByRole('button',{name:'JOURNAL',exact:true});
  assert.match(await x.page.locator('.mm > aside').innerText(),/can publish\/merge approved work or reclaim/);
  await tab.click();
  await x.page.getByRole('heading',{name:'Journal needs a selected Workflow',exact:true}).waitFor();
  assert.equal(await tab.getAttribute('aria-pressed'),'true');
  await x.page.getByRole('button',{name:'Create/load demo DAG',exact:true}).click();
  await x.page.getByRole('button',{name:'Load evidence-linked journal',exact:true}).waitFor();
  await x.page.getByRole('button',{name:'Load evidence-linked journal',exact:true}).click();
  await x.page.getByRole('heading',{name:'Task and QC evidence',exact:true}).waitFor();
 }finally{await x.close();}
});
