#!/usr/bin/env node
/** Actual PI WEB/browser/Durable lifecycle acceptance in a fresh local fixture.
 * Faux mode is credential-free. OAuth mode is an explicit owner-operated test,
 * never an automatic CI credential lookup or a production daemon restart. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {sourceEvidence,assertReceiptDestination,writeReceipt} from './e2e-contract.mjs';
import {validateAuthFile} from './local-pi-oauth-smoke.mjs';
import {createPublicationSetup,publicationServerWrapper,runPublicationTrial} from './hosted-publication-trial.mjs';

export function parseHostedArguments(args){
 const flags=new Set(['--approve-account-use','--approve-test-publication']),valued=new Set(['--mode','--expected-sha','--receipt','--pi-auth-file']);
 const values=new Map();
 for(let i=0;i<args.length;i++){
  const key=args[i];if(values.has(key)||!flags.has(key)&&!valued.has(key))throw Error('invalid-arguments');
  const value=flags.has(key)?true:args[++i];
  if(value===undefined||typeof value==='string'&&(!value||value.startsWith('--')||value.includes('\0')))throw Error('invalid-arguments');
  values.set(key,value);
 }
 const mode=values.get('--mode'),sha=values.get('--expected-sha');
 if(!['faux','oauth'].includes(mode)||sha!==undefined&&!/^[a-f0-9]{40}$/.test(sha))throw Error('invalid-arguments');
 if(mode==='oauth'&&(!values.get('--approve-account-use')||!sha))throw Error('approval-required');
 if(mode==='faux'&&values.has('--pi-auth-file'))throw Error('invalid-arguments');
 if(values.get('--approve-test-publication')&&!sha)throw Error('reviewed-source-required');
 return {mode,sha,receipt:values.get('--receipt'),authFile:values.get('--pi-auth-file'),publish:values.get('--approve-test-publication')===true};
}
/** Verify observed execution metadata, not a model's claim of independence. */
export function verifyHostedDiagnosis(workflow,runs,jobs,expectedModel){
 const amendment=workflow.amendments.find(a=>a.id==='review');
 const parent=workflow.tasks.alpha;
 const diagnosis=Object.values(workflow.tasks).filter(t=>t.parentTaskId==='alpha'&&t.spec.kind==='diagnosis');
 if(!amendment||amendment.status!=='activated'||amendment.agents.length!==2||
   parent?.status!=='held'||!parent.lastQc||!['pass','fail','inconclusive'].includes(parent.lastQc.verdict)||
   !/^[a-f0-9]{40}$/.test(parent.lastQc.headSha)||diagnosis.length!==2||
   workflow.tasks[amendment.synthesisTaskId]?.status!=='done')throw Error('two-independent-diagnoses-unproved');
 const sessions=new Set();
 for(const task of diagnosis){
  const observed=runs.filter(r=>r.workflowId===workflow.definition.id&&r.taskId===task.spec.id);
  if(task.status!=='done'||observed.length!==1||observed[0].phase!=='sealed'||!observed[0].sessionId)
   throw Error('diagnostic-outcome-unproved');
  const run=observed[0],launches=jobs.filter(j=>j.runId===run.runId);
  if(launches.length!==1)throw Error('diagnostic-launch-unproved');
  const job=launches[0];
  if(job.kind!=='diagnosis'||job.taskId!==task.spec.id||job.workflowId!==workflow.definition.id||
   job.headSha!==parent.lastQc.headSha||job.projectId!==run.projectId||job.orchestraWorkspaceId!==run.orchestraWorkspaceId||
   job.model.provider!==expectedModel.provider||job.model.model!==expectedModel.model||job.model.effort!==expectedModel.effort||
   run.provider!==job.model.provider||run.model!==job.model.model||
   expectedModel.effort!==undefined&&run.effort!==expectedModel.effort)throw Error('frozen-diagnostic-evidence-mismatch');
  sessions.add(run.sessionId);
 }
 if(sessions.size!==2)throw Error('diagnostic-sessions-not-independent');
 return {investigators:2,sourceSha:parent.lastQc.headSha,humanResumeRequired:true};
}
export const shouldRemoveHostedFixture=(joined,status)=>joined===true&&status==='passed';
const HERE=fileURLToPath(new URL('../',import.meta.url));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function runHosted(args){
 let options,source,stage='admission',root,browser,daemon,web,project,home,env,fixturePackage;
 const children=[],checks={},receipt={schemaVersion:1,suite:'hosted-pi-web-lifecycle',status:'blocked',code:'admission',
  mode:'unselected',source:null,checks,productionSafetyGuaranteed:false,remotePublication:'not-tested',qcHigherEffort:'not-tested'};
 let exit=2,hardTimer,joined=true,page,publication;
 const stop=async child=>{
  if(!child||child.spawnFailed||child.exitCode!==null||child.signalCode!==null)return;
  const closed=new Promise(r=>child.once('close',r));child.kill('SIGTERM');
  let timer;await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(resolve,12000);})]);
  clearTimeout(timer);
  if(child.exitCode===null&&child.signalCode===null){
   child.kill('SIGKILL');await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);clearTimeout(timer);
  }
  if(child.exitCode===null&&child.signalCode===null){joined=false;throw Error('shutdown-unproved');}
 };
 const cleanup=async()=>{
  try{await browser?.close();}catch{joined=false;}
  for(const child of [...children].reverse())try{await stop(child);}catch{joined=false;}
 };
 const launch=(file)=>{
  const child=spawn(process.execPath,[file],{cwd:root,env,stdio:['ignore','ignore','ignore']});
  child.once('error',()=>{child.spawnFailed=true;});children.push(child);return child;
 };
 const onSignal=()=>{void cleanup().finally(()=>process.exit(1));};
 try{
  options=parseHostedArguments(args);receipt.mode=options.mode;
  if(process.platform!=='linux'||![22,24].includes(Number(process.versions.node.split('.')[0])))throw Error('unsupported-platform');
  assertReceiptDestination(options.receipt);source=sourceEvidence();receipt.source=source;
  if(options.sha&&source.commit!==options.sha)throw Error('sha-mismatch');
  if((options.mode==='oauth'||options.publish)&&!source.workingTreeClean)throw Error('dirty-checkout');
  const authFile=options.mode==='oauth'?validateAuthFile(options.authFile??join(homedir(),'.pi/agent/auth.json')):undefined;
  if(!existsSync(join(HERE,'dist/pi-web/server.js')))throw Error('build-required');
  const {chromium}=await import('playwright');
  receipt.playwright=JSON.parse(readFileSync(join(HERE,'node_modules/playwright/package.json'),'utf8')).version;
  assert.equal(receipt.playwright,JSON.parse(readFileSync(join(HERE,'package-lock.json'),'utf8')).packages['node_modules/playwright'].version);
  process.umask(0o077);root=mkdtempSync(join(tmpdir(),'mm-hosted-acceptance-'));
  const dir=name=>{const p=join(root,name);mkdirSync(p,{recursive:true,mode:0o700});return p;};
  home=dir('home');const state=dir('state'),agent=dir('agent'),sessions=dir('sessions'),otherProject=dir('other-project');project=join(root,'project');
  writeFileSync(join(otherProject,'README.md'),'Separate synthetic authorized project.\n');
  const otherInit=spawnSync('/usr/bin/git',['-C',otherProject,'init','-b','main'],{env:{PATH:'/usr/bin:/bin',HOME:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8',timeout:10000});
  if(otherInit.status!==0)throw Error('other-project-fixture-failed');
  if(options.publish){stage='publication-setup';publication=createPublicationSetup({checkout:HERE,project,home,root,sourceSha:source.commit});}
  else mkdirSync(project,{mode:0o700});
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  const git=(...argv)=>{
   const r=spawnSync('/usr/bin/git',['-C',project,...argv],{env:{PATH:'/usr/bin:/bin',HOME:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8',timeout:15000});
   if(r.status!==0)throw Error('fixture-git-failed');return r.stdout.trim();
  };
  if(!publication)writeFileSync(join(project,'README.md'),'Synthetic hosted acceptance only.\n');
  if(existsSync(join(project,'acceptance.test.mjs')))throw Error('test-fixture-path-conflict');
  writeFileSync(join(project,'acceptance.test.mjs'),"import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(readFileSync('acceptance.txt','utf8'),'synthetic acceptance confirmed\\n');\n");
  if(publication){receipt.publicationBase=publication.base;receipt.publicationSource=publication.source;receipt.fixtureBaseSha=publication.finishSetup();}
  else{
   git('init','-b','main');git('config','user.name','Acceptance Fixture');git('config','user.email','fixture@invalid.local');
   git('add','.');git('commit','-m','test-only synthetic fixture');
  }
  fixturePackage=dir('plugin');cpSync(join(HERE,'dist'),join(fixturePackage,'dist'),{recursive:true});
  symlinkSync(join(HERE,'node_modules'),join(fixturePackage,'node_modules'));
  cpSync(join(HERE,'scripts/hosted-fixture-models.mjs'),join(fixturePackage,'fixture-models.mjs'));
  const manifest=JSON.parse(readFileSync(join(HERE,'package.json'),'utf8'));
  Object.assign(manifest.piWeb.plugins[0],{module:'dist/pi-web/browser-acceptance.js',serverModule:'dist/pi-web/server-acceptance.js'});
  writeFileSync(join(fixturePackage,'package.json'),JSON.stringify(manifest));
  // Test-only wrapper captures the PUBLIC WorkspacePanelContext. All requests
  // still cross the shipped browser's actual paired transport into the real
  // server/engine. There is no private route, fake backend or production export.
  writeFileSync(join(fixturePackage,'dist/pi-web/browser-acceptance.js'),
   `import actual from './browser.js';export default {...actual,async activate(host){const value=await actual.activate(host);return {...value,contributions:{...value.contributions,workspacePanels:value.contributions.workspacePanels.map(panel=>({...panel,render(ctx){globalThis.__mmAcceptanceContext=ctx;return panel.render(ctx);}}))}};}};`);
  writeFileSync(join(fixturePackage,'dist/pi-web/server-acceptance.js'),
   options.mode==='faux'?
    `import actual from './server.js';import {ModelRuntime} from '@earendil-works/pi-coding-agent';import {hostedFixtureModels} from '../../fixture-models.mjs';const original=ModelRuntime.create.bind(ModelRuntime);const models=hostedFixtureModels(await original({modelsPath:null,allowModelNetwork:false,refreshOnCreate:false}));ModelRuntime.create=async()=>models;export default actual;`:
    `import actual from './server.js';import {ModelRuntime,readStoredCredential} from '@earendil-works/pi-coding-agent';const file=process.env.MM_ACCEPTANCE_AUTH_FILE;if(readStoredCredential('openai',file)?.type!=='oauth')throw Error('Selected OAuth profile unavailable');const original=ModelRuntime.create.bind(ModelRuntime);ModelRuntime.create=async options=>{const models=await original({...options,authPath:file,modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});const requests=new Set(['stream','streamSimple','complete','completeSimple','streamDeferred','fetchDeferred','generateImages','classify']);return new Proxy(models,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return(...args)=>{if(requests.has(key)){if(args[0]?.provider!=='openai'||args[0]?.id!=='gpt-6-luna')throw Error('Unexpected test model');args[2]={...args[2],maxTokens:4096};}return Reflect.apply(value,target,args);};}});};export default actual;`);
  if(publication){
   const wrapper=join(fixturePackage,'dist/pi-web/server-acceptance.js');
   const content=readFileSync(wrapper,'utf8').replace('export default actual;','');
   writeFileSync(wrapper,content+'\n'+publicationServerWrapper('actual',publication.lossMarker,publication.audit));
  }
  const model=options.mode==='faux'?{provider:'faux',model:'faux-1'}:{provider:'openai',model:'gpt-6-luna',effort:'low'};
  const qcModel=options.mode==='faux'?model:{...model,effort:'max'};
  receipt.selection={implementer:model,qc:qcModel};receipt.maxOutputTokensPerRequest=4096;
  const config=join(root,'config.json');
  writeFileSync(config,JSON.stringify({host:'127.0.0.1',port,spawnSessions:false,subsessions:false,
   plugins:{micromanager:{enabled:true,settings:{productionSecurity:{mode:'production',projectRoots:[project,otherProject],
    models:[{provider:model.provider,model:model.model}],
    ...(publication?{publication:[{repository:publication.repository,baseBranch:publication.base}]}:{}),limits:{maxConcurrentRuns:4,maxModelRequests:24,maxToolCalls:64,maxRunMs:300000}}}}}}));
  mkdirSync(join(state,'plugins'));symlinkSync(fixturePackage,join(state,'plugins/micromanager'));
  writeFileSync(join(agent,'settings.json'),JSON.stringify({defaultProjectTrust:'never',packages:[]}));
  env={PATH:'/usr/bin:/bin',HOME:home,TMPDIR:root,LANG:'C.UTF-8',PI_WEB_CONFIG:config,PI_WEB_DATA_DIR:state,
   PI_CODING_AGENT_DIR:agent,PI_CODING_AGENT_SESSION_DIR:sessions,PI_WEB_SESSIOND_SOCKET:join(root,'daemon.sock'),
   PI_WEB_HOST:'127.0.0.1',PI_WEB_PORT:String(port),PI_WEB_OFFLINE:'1',PI_OFFLINE:'1',PI_WEB_SKIP_VERSION_CHECK:'1',PI_SKIP_VERSION_CHECK:'1',
   ...(authFile?{MM_ACCEPTANCE_AUTH_FILE:authFile}:{}),...(publication?{GH_CONFIG_DIR:publication.ghConfig}:{}),GH_PROMPT_DISABLED:'1'};
  const bin=join(HERE,'node_modules/@jmfederico/pi-web/dist/server');
  hardTimer=setTimeout(()=>{void cleanup().finally(()=>process.exit(1));},publication?1200000:options.mode==='faux'?240000:900000);
  process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  stage='host-start';daemon=launch(join(bin,'sessiond.js'));web=launch(join(bin,'index.js'));
  const until=Date.now()+30000;
  while(Date.now()<until){
   if(children.some(c=>c.spawnFailed||c.exitCode!==null))throw Error('host-start-failed');
   try{if((await fetch('http://127.0.0.1:'+port)).ok&&existsSync(env.PI_WEB_SESSIOND_SOCKET))break;}catch{}
   await pause(150);
  }
  stage='browser-start';browser=await chromium.launch({headless:true,chromiumSandbox:true,env:{PATH:'/usr/bin:/bin',HOME:home,LANG:'C.UTF-8'}});
  receipt.chromium=browser.version();checks.chromiumSandbox='enabled';
  page=await browser.newPage();page.setDefaultTimeout(15000);
  await page.goto('http://127.0.0.1:'+port);
  await page.getByRole('button',{name:'Show Actions',exact:true}).click();
  await page.locator('button[title="Add Project"]').click();
  await page.getByPlaceholder('/path/to/project or ~/code/project').fill(project);
  await page.getByRole('button',{name:'Add project',exact:true}).click();
  await page.getByRole('button',{name:'Micromanager',exact:true}).first().click();
  await page.waitForFunction(()=>Boolean(globalThis.__mmAcceptanceContext?.peer?.request));
  const call=(operation,input)=>page.evaluate(async({operation,input})=>globalThis.__mmAcceptanceContext.peer.request(operation,input),{operation,input});
  const wait=async(check,milliseconds=90000)=>{
   const end=Date.now()+milliseconds;while(Date.now()<end){const result=await check();if(result)return result;await pause(200);}throw Error('condition-timeout');
  };
  const profile={runtime:'durable',managedWorktrees:true,workspaces:{},maxConcurrentRuns:4,
   models:{implementer:model,qc:qcModel,architect:qcModel,planner:model},
   test:{execution:'sandbox',file:'node',args:['--test','acceptance.test.mjs'],timeoutMs:10000},maxAttempts:2};
  const definition=(id,tasks)=>({id,title:'Hosted acceptance '+id,maxQcRounds:2,
   maxParallelByRole:{implementer:4,reviewer:2,architect:2,planner:1},permissions:{default:'deny',actions:{'git.commit':'allow','git.integrate':'allow'}},
   tasks:tasks.map(name=>({id:name,title:'Synthetic '+name,kind:'implementation',role:'implementer',dependsOn:[],
    description:(name==='abort-probe'?'ACCEPTANCE_ABORT_HOLD: First call bash with sleep 20; this tests cancellation. ':'Concurrency acceptance: first call bash with sleep 10 so simultaneous test Runs can be observed. ')+
     'Write only acceptance.txt with exactly synthetic acceptance confirmed followed by a newline. Commit it using mm_git_commit. Do not modify any other file or publish.',
    acceptanceCriteria:['acceptance.txt is exactly synthetic acceptance confirmed followed by one newline.','Existing acceptance.test.mjs passes without edits.']}))});
  stage='workflow-create';await call('create',definition('pair',['alpha','beta','gamma','delta']));await call('auto.configure',{workflowId:'pair',config:profile});
  let wf;
  await call('auto.start',{workflowId:'pair'});
  await page.getByRole('button',{name:'Orchestra',exact:true}).first().click();
  stage='parallel-and-steer';let peak=0,steered=false,qcSteered=false,humanRequested=false;
  await wait(async()=>{
   const runs=(await call('agents.list',{view:'all'})).filter(r=>r.workflowId==='pair');
   peak=Math.max(peak,runs.filter(r=>r.phase==='running').length);receipt.peakRunning=peak;
   const visible=await page.locator('article.mm-f-node').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')?.replace(/^Pi Run /,'')));
   const active=runs.find(r=>r.seat==='implementer'&&r.phase==='running'&&visible.includes(r.runId));
   if(active&&!steered&&peak>=4&&visible.length>=4){
    checks.fourVisibleLiveCards='passed';
    const node=page.locator('article[aria-label="Pi Run '+active.runId+'"]');
    stage='cockpit-expand';await node.getByRole('button',{name:'Expand '+active.runId,exact:true}).click();
    stage='cockpit-collapse';await node.getByRole('button',{name:'Collapse '+active.runId,exact:true}).click();
    assert.equal(await node.getAttribute('data-density'),'compact');
    assert.equal(await node.locator('.mm-f-node-compose').isVisible(),false);
    await node.getByRole('button',{name:'Expand '+active.runId,exact:true}).click();
    stage='cockpit-message';await node.getByLabel('Delivery mode for '+active.runId,{exact:true}).selectOption('steer');
    await node.getByLabel('Message '+active.runId,{exact:true}).fill('Keep the exact synthetic task contract and avoid any external operation.');
    await node.getByRole('button',{name:'Send to '+active.runId,exact:true}).click();
    await node.locator('.mm-f-receipt').filter({hasText:/Command acknowledged/}).waitFor();
    checks.cockpitExpandCollapse='passed';checks.browserSteerButton='passed';steered=true;
   }
   const qc=runs.find(r=>r.taskId==='alpha'&&r.seat==='qc'&&r.phase==='running');
   if(qc&&!humanRequested){
    stage='intervention-during-qc';const live=await call('get','pair');
    assert.equal(live.tasks.alpha.status,'awaiting_qc');
    await call('act',{workflowId:'pair',expectedRevision:live.revision,commandId:'acceptance-intervention',
     action:{type:'request_intervention',interventionId:'review',targetTaskId:'alpha',afterQcRunId:qc.runId,
      instruction:'Use exactly two independent read-only reviewers on committed acceptance.txt. Compare safety and compatibility, synthesize findings, then hold for human resume. Use only '+model.provider+'/'+model.model+'.'}});
    checks.humanBarrierDuringQc='passed';humanRequested=true;
    await page.getByRole('button',{name:'Refresh runs',exact:true}).click();
    const node=page.locator('article[aria-label="Pi Run '+qc.runId+'"]');
    await node.waitFor();
    if(await node.getAttribute('data-density')!=='expanded')await node.getByRole('button',{name:'Expand '+qc.runId,exact:true}).click();
    stage='qc-inspector';await node.getByRole('button',{name:'Inspect '+qc.runId,exact:true}).focus();
    await page.keyboard.press('Enter');
    const inspector=page.getByRole('region',{name:'Focused Run '+qc.runId,exact:true});
    await inspector.waitFor();assert.equal(await inspector.getByLabel('Current Orchestra scope').isVisible(),true);
    stage='qc-direct-steer';await node.getByLabel('Delivery mode for '+qc.runId,{exact:true}).selectOption('steer');
    await node.getByLabel('Message '+qc.runId,{exact:true}).fill('Continue independent QC of the same frozen source. Do not edit, publish, or waive a failed check; the human hold remains authoritative.');
    await node.getByRole('button',{name:'Send to '+qc.runId,exact:true}).click();
    await node.locator('.mm-f-receipt').filter({hasText:'Command acknowledged by '+qc.runId+'.'}).waitFor();
    qcSteered=true;checks.directQcSteer='passed';checks.focusedQcInspector='passed';
    // Presentational changes must not change execution authority or spawn Runs.
    const width=page.viewportSize();await page.setViewportSize({width:720,height:960});
    assert.equal(await inspector.isVisible(),true);await page.setViewportSize(width);
    checks.narrowViewportInspector='passed';
    await inspector.focus();await page.keyboard.press('Escape');
    await inspector.waitFor({state:'detached'});
    checks.inspectorKeyboardDismiss='passed';
   }
   const state=await call('get','pair'),amendment=state.amendments.find(a=>a.id==='review');
   return amendment?.synthesisTaskId&&state.tasks[amendment.synthesisTaskId]?.status==='done'&&state;
  },options.mode==='faux'?120000:480000);
  assert.ok(peak>=4);assert.ok(steered);assert.ok(qcSteered);assert.ok(humanRequested);
  checks.parallelRuns='passed';checks.steerReceipt='passed';receipt.peakRunning=peak;
  wf=await call('get','pair');assert.equal(wf.tasks.alpha.status,'held');
  stage='frozen-independent-diagnosis';
  const observed=await call('agents.list',{view:'all'});
  const launchDb=new DatabaseSync(join(state,'plugin-data/micromanager/autopilot.sqlite'),{readOnly:true,allowExtension:false});
  let launches;
  try{const rows=launchDb.prepare('SELECT job_json FROM autopilot_launches WHERE workflow_id=? LIMIT 65').all('pair');
   if(rows.length>64)throw Error('unexpected-launch-cardinality');launches=rows.map(r=>JSON.parse(r.job_json));}
  finally{launchDb.close();}
  receipt.diagnosis=verifyHostedDiagnosis(wf,observed,launches,qcModel);
  checks.twoIndependentDiagnoses='passed';checks.frozenDiagnosisSnapshot='passed';checks.humanResumeRequired='passed';
  const decision=wf.tasks.alpha.lastQc.verdict==='pass'?'accept_pass':'rework';
  const resume={workflowId:'pair',expectedRevision:wf.revision,commandId:'acceptance-resume',action:{type:'resume_after_diagnosis',amendmentId:'review',decision}};
  const resumed=await call('act',resume),repeated=await call('act',resume);assert.equal(resumed.revision,repeated.revision);
  checks.interventionHoldAndResumeOnce='passed';
  await call('auto.start',{workflowId:'pair'});
  await wait(async()=>{const w=await call('get','pair');return ['alpha','beta','gamma','delta'].every(t=>w.tasks[t].lastQc?.verdict==='pass'&&w.tasks[t].status==='passed');},options.mode==='faux'?90000:240000);
  await call('auto.pause',{workflowId:'pair'});const stable=(await call('agents.list',{view:'all'})).filter(r=>r.workflowId==='pair');
  assert.ok(stable.filter(r=>r.seat==='qc').length>=2);assert.ok(stable.every(r=>r.phase==='sealed'));
  assert.equal(new Set(stable.filter(r=>r.seat==='implementer').map(r=>r.workspaceId)).size,4);
  checks.independentQc='passed';receipt.qcHigherEffort=options.mode==='oauth'?'max':'faux';receipt.workflowRunCount=stable.length;
  const metrics=()=>{const db=new DatabaseSync(join(state,'plugin-data/micromanager/run-safety.sqlite'),{readOnly:true});
   try{return db.prepare('SELECT COALESCE(SUM(requests),0) AS requests,COALESCE(SUM(tools),0) AS tools FROM safety_runs').get();}finally{db.close();}};
  const before=metrics();
  stage='scope-isolation';
  const originalScope=await page.evaluate(()=>({projectId:globalThis.__mmAcceptanceContext.workspace.projectId,
    workspaceId:globalThis.__mmAcceptanceContext.workspace.id,machineId:globalThis.__mmAcceptanceContext.machine.id}));
  await page.getByRole('button',{name:'Show Actions',exact:true}).click();
  await page.locator('button[title="Add Project"]').click();
  await page.getByPlaceholder('/path/to/project or ~/code/project').fill(otherProject);
  await page.getByRole('button',{name:'Add project',exact:true}).click();
  await page.getByRole('button',{name:'Micromanager',exact:true}).first().click();
  await page.waitForFunction(project=>globalThis.__mmAcceptanceContext?.workspace.projectId!==project,originalScope.projectId);
  assert.deepEqual(await call('list',null),[]);
  assert.deepEqual(await call('agents.list',{view:'all'}),[]);
  let foreignDenied=false;try{await call('get','pair');}catch{foreignDenied=true;}
  assert.ok(foreignDenied,'Another authorized project cannot read the original Workflow');
  await page.getByRole('button',{name:'Orchestra',exact:true}).first().click();
  assert.equal(await page.locator('article.mm-f-node').count(),0);
  assert.equal(await page.locator('.mm-f-inspector').count(),0);
  await page.evaluate(scope=>globalThis.__mmAcceptanceContext.navigate({...scope,view:'workspace'}),originalScope);
  await page.getByRole('button',{name:'Micromanager',exact:true}).first().click();
  await page.waitForFunction(scope=>globalThis.__mmAcceptanceContext?.workspace.projectId===scope.projectId&&
    globalThis.__mmAcceptanceContext?.workspace.id===scope.workspaceId,originalScope);
  assert.equal((await call('get','pair')).definition.id,'pair');
  assert.deepEqual(metrics(),before);
  checks.crossProjectReadIsolation='passed';checks.publicScopeNavigation='passed';
  const restart=async()=>{
   await stop(daemon);daemon=launch(join(bin,'sessiond.js'));
   // The gateway may cache an unavailable plugin while sessiond is booting.
   // Reload browser discovery only; never replay any Run or mutation request.
   const until=Date.now()+30000;
   while(Date.now()<until){
    if(daemon.spawnFailed||daemon.exitCode!==null)throw Error('test-daemon-restart-failed');
    await pause(1500);await page.reload();
    const tab=page.getByRole('button',{name:'Micromanager',exact:true}).first();
    try{await tab.waitFor({timeout:1500});await tab.click();
     await page.waitForFunction(()=>Boolean(globalThis.__mmAcceptanceContext?.peer?.request),{},{timeout:1500});return;
    }catch{/* Bounded read-only browser rediscovery until the new daemon is ready. */}
   }
   throw Error('test-plugin-not-ready-after-restart');
  };
  stage='settled-restart';await restart();await pause(1200);
  assert.deepEqual(metrics(),before);assert.deepEqual((await call('agents.list',{view:'all'})).filter(r=>r.workflowId==='pair').map(r=>r.runId).sort(),stable.map(r=>r.runId).sort());
  checks.settledDaemonRestartNoReplay='passed';
  stage='abort';await call('create',definition('abort-case',['abort-probe']));await call('auto.configure',{workflowId:'abort-case',config:profile});await call('auto.start',{workflowId:'abort-case'});
  const active=await wait(async()=>{
   const run=(await call('agents.list',{view:'all'})).find(r=>r.workflowId==='abort-case'&&r.phase==='running');
   if(!run)return false;const events=await call('agents.history',{sessionId:run.sessionId});return events.some(e=>e.kind==='tool_started'&&e.text==='bash')&&run;
  },options.mode==='faux'?30000:180000);
  const aborted=await call('agents.command',{sessionId:active.sessionId,action:'abort',requestId:'acceptance-abort'});assert.equal(aborted.status,'ok');
  await wait(async()=>{const run=(await call('agents.list',{view:'all'})).find(r=>r.sessionId===active.sessionId);return run.abortRequested===1&&run.phase!=='running';});
  await call('auto.pause',{workflowId:'abort-case'});const interrupted=metrics();stage='abort-restart';await restart();await pause(1500);
  const afterAbort=(await call('agents.list',{view:'all'})).filter(r=>r.workflowId==='abort-case');assert.equal(afterAbort.length,1);
  assert.equal(afterAbort[0].sessionId,active.sessionId);assert.equal(afterAbort[0].abortRequested,1);assert.notEqual(afterAbort[0].phase,'sealed');assert.deepEqual(metrics(),interrupted);
  checks.abortAndRestartNoReplay='passed';receipt.modelAdmissions=interrupted.requests;receipt.toolAdmissions=interrupted.tools;
  checks.browserPeerTransport='passed';checks.realModelAuthentication=options.mode==='oauth'?'passed':'not-verified';
  if(publication){
   stage='product-publication';receipt.remotePublication=await runPublicationTrial({setup:publication,call,wait,restart,profile,definition,onStage:s=>{stage='publication-'+s;}});
  }
  receipt.status='passed';receipt.code='ok';exit=0;
 }catch(error){if(options?.mode==='faux')process.stderr.write('[credential-free fixture] '+String(error).slice(0,1200)+'\n');receipt.status=root?'failed':'blocked';receipt.code=stage;exit=root?1:2;}
 finally{
  clearTimeout(hardTimer);await cleanup();process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);
  if(!joined){receipt.status='failed';receipt.code='shutdown-unproved';exit=1;}
  if(options?.publish&&root&&existsSync(join(root,'remote-trial.json'))){
   const trial=JSON.parse(readFileSync(join(root,'remote-trial.json'),'utf8'));
   receipt.trialReferences={repository:trial.repository,base:trial.base,source:trial.source,mainBefore:trial.mainBefore};
  }
  const remove=root&&shouldRemoveHostedFixture(joined,receipt.status);
  receipt.cleanup=remove?'removed':root?'retained':'not-created';
  if(remove)rmSync(root,{recursive:true,force:true});
  else if(root)receipt.retainedFixture=root.split('/').at(-1);
 }
 try{writeReceipt(options?.receipt,receipt);}catch{receipt.status='failed';receipt.code='receipt-refused';exit=1;}
 process.stdout.write(JSON.stringify(receipt)+'\n');return exit;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runHosted(process.argv.slice(2));
