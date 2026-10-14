#!/usr/bin/env node
/** Owner-operated full product-path acceptance. No live mode without explicit
 * account/publication approval. Rehearsal uses an actual host/browser/Harness,
 * but labels its faux model and local simulated remote honestly. */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,lstatSync,realpathSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {sourceEvidence,REPO_ROOT,assertReceiptDestination,writeReceipt} from './e2e-contract.mjs';
import {validateAuthFile} from './local-pi-oauth-smoke.mjs';
import {REPOSITORY,MODEL,HostedFailure,fail,parseHostedArguments,assertApproval,hostedReceipt,SHA} from './hosted-e2e-contract.mjs';
import {launchHost} from './hosted-e2e-host.mjs';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
const safeGitEnv=home=>({PATH:'/usr/bin:/bin',HOME:home,LANG:'C.UTF-8',
 GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',
 GIT_CONFIG_COUNT:'4',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/dev/null',
 GIT_CONFIG_KEY_1:'core.fsmonitor',GIT_CONFIG_VALUE_1:'false',
 GIT_CONFIG_KEY_2:'commit.gpgsign',GIT_CONFIG_VALUE_2:'false',
 GIT_CONFIG_KEY_3:'gc.auto',GIT_CONFIG_VALUE_3:'0'});
function git(cwd,args,env,acceptable=[0]){
 const r=spawnSync('/usr/bin/git',['-C',cwd,...args],{cwd,env,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
 if(r.error||r.signal||!acceptable.includes(r.status))fail('fixture-git-failed');return r.stdout.trim();
}
function boundedStats(dir){
 const p=join(dir,'run-safety.sqlite');if(!existsSync(p))return {count:0,requests:0,tools:0};
 const db=new DatabaseSync(p,{readOnly:true,allowExtension:false});
 try{const s=db.prepare('SELECT count(*) AS count,coalesce(sum(requests),0) AS requests,coalesce(sum(tools),0) AS tools FROM safety_runs').get();
  return {count:s.count,requests:s.requests,tools:s.tools};}finally{db.close();}
}
function makeWorkflow(id,fixture,aborting=false){
 return {id,title:aborting?'Bounded interruption acceptance':'Hosted synthetic publication acceptance',maxQcRounds:2,
  maxParallelByRole:{implementer:2,reviewer:2,architect:1,planner:1},
  permissions:{default:'deny',actions:{'git.commit':'allow','git.integrate':'allow',
    'git.push':aborting?'deny':'ask','github.pr.create':aborting?'deny':'ask','github.pr.merge':aborting?'deny':'ask'}},
  tasks:(aborting?['abort']:['a','b']).map(id=>({id,title:'Synthetic marker '+id,kind:'implementation',role:'implementer',dependsOn:[],
   description:aborting?'This is a controlled Abort drill. First run bash sleep 20; only afterwards create '+fixture+'/abort.txt. Stop promptly if interrupted.':
     'This is a synthetic acceptance fixture. First run bash sleep 2, then write exactly '+JSON.stringify(id.toUpperCase()+'\n')+' to '+fixture+'/'+id+'.txt. Change no other file. Commit using mm_git_commit. Do not modify tests, package, workflows or permissions. Do not push.',
   acceptanceCriteria:aborting?['The operator will interrupt this deliberately slow task; no delayed marker may appear.']:
     [fixture+'/'+id+'.txt contains exactly '+JSON.stringify(id.toUpperCase()+'\n')+'.','No other source change except the independent sibling marker during final integration.']}))};
}
export async function runHosted(args){
 let config,source,root,host,trial,ghConfig;
 const facts={status:'blocked',code:'invalid-arguments',checks:{},cleanup:'retained'};
 let stopped=false,timer;const interrupt=()=>{stopped=true;void host?.close();};
 try{
  config=parseHostedArguments(args);assertReceiptDestination(config.receipt);source=sourceEvidence();
  if(process.platform!=='linux'||![22,24].includes(Number(process.versions.node.split('.')[0])))fail('unsupported-platform');
  if(config.expectedSha&&config.expectedSha!==source.commit)fail('sha-mismatch');
  if(config.mode==='live'&&!source.workingTreeClean)fail('dirty-checkout');
  let authFile;
  if(config.mode==='live'){
   authFile=validateAuthFile(config.authFile??join(homedir(),'.pi/agent/auth.json'));
   const {readStoredCredential}=await import('@earendil-works/pi-coding-agent');
   if(readStoredCredential('openai',authFile)?.type!=='oauth')fail('oauth-profile-required');
   ghConfig=config.ghConfig??join(homedir(),'.config/gh');
   const d=lstatSync(ghConfig),f=lstatSync(join(ghConfig,'hosts.yml'));
   if(realpathSync(ghConfig)!==ghConfig||!d.isDirectory()||(d.mode&0o022)||d.uid!==process.getuid()||
     !f.isFile()||f.isSymbolicLink()||f.nlink!==1||(f.mode&0o077)||f.uid!==process.getuid())fail('github-auth-source-refused');
  }
  process.umask(0o077);root=mkdtempSync(join(tmpdir(),'mm-hosted-e2e-'));
  const make=n=>{const p=join(root,n);mkdirSync(p,{recursive:true,mode:0o700});return p;};
  const setupHome=make('setup-home'),project=join(root,'project'),env=safeGitEnv(setupHome);
  if(ghConfig)env.GH_CONFIG_DIR=ghConfig;
  const nonce=randomBytes(8).toString('hex'),prefix='e2e/local-luna-'+nonce,fixture='examples/acceptance/'+nonce;
  facts.prefix=prefix;
  git(root,['clone','--no-local','--no-hardlinks',REPO_ROOT,project],env);
  git(project,['switch','-c',prefix+'-base',source.commit],env);
  git(project,['config','user.name','Micromanager acceptance'],env);
  git(project,['config','user.email','acceptance@invalid.local'],env);
  git(project,['remote','set-url','origin','https://github.com/'+REPOSITORY+'.git'],env);
  mkdirSync(join(project,fixture),{recursive:true,mode:0o700});
  writeFileSync(join(project,fixture,'verify.mjs'),
   "import {readFileSync,existsSync} from 'node:fs';\nimport assert from 'node:assert/strict';\n"+
   "for(const id of ['a','b']){const p=new URL('./'+id+'.txt',import.meta.url);if(existsSync(p))assert.equal(readFileSync(p,'utf8'),id.toUpperCase()+'\\n');}\n",{mode:0o600});
  git(project,['add','--',fixture+'/verify.mjs'],env);git(project,['commit','-m','test-only: bounded acceptance fixture'],env);
  const seedSha=git(project,['rev-parse','HEAD'],env),bare=join(root,'remote.git'),transport=join(root,'transport.json');
  trial={mode:config.mode,prefix,repository:REPOSITORY,base:prefix+'-base',head:prefix+'-final',seedSha,fixture,bare,transport};
  facts.trial={base:trial.base,head:trial.head,seedSha};
  writeFileSync(transport,JSON.stringify({pushCalls:0,mergeCalls:0,createCalls:0,readyCalls:0}),{mode:0o600});
  writeFileSync(join(root,'owner-manifest.json'),JSON.stringify({schemaVersion:1,sourceSha:source.commit,mode:config.mode,
    prefix,fixture,repository:REPOSITORY,model:MODEL,productionSafetyGuaranteed:false}),{mode:0o600});
  // Only fixed read/mutation commands target this brand-new test base. Never main.
  if(config.mode==='live'){
   env.GIT_CONFIG_COUNT='5';env.GIT_CONFIG_KEY_4='credential.helper';env.GIT_CONFIG_VALUE_4='!/usr/bin/gh auth git-credential';
   const remote='https://github.com/'+REPOSITORY+'.git';
   const main=git(project,['ls-remote','--heads',remote,'refs/heads/main'],env).split(/\s/)[0];
   if(!SHA.test(main))fail('main-observation-failed');
   if(main!==source.commit)fail('source-not-current-main');facts.mainBefore=main;
   if(git(project,['ls-remote','--heads',remote,'refs/heads/'+trial.base,'refs/heads/'+trial.head],env))fail('test-ref-exists');
   git(project,['push','--porcelain',remote,seedSha+':refs/heads/'+trial.base],env);facts.remoteCreated=true;
  }else{
   git(root,['init','--bare',bare],env);git(project,['push',bare,seedSha+':refs/heads/'+trial.base],env);
  }
  const worktrees=make('project/acceptance-worktrees');
  writeFileSync(join(project,'.git/info/exclude'),'\n/acceptance-worktrees/\n',{flag:'a'});
  for(const id of ['a','b','final','abort'])git(project,['worktree','add','-b',prefix+'-'+id,join(worktrees,id),seedSha],env);
  facts.status='failed';facts.code='host-not-started';
  timer=setTimeout(interrupt,config.mode==='live'?900000:180000);process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  host=await launchHost(trial,{root,project,authFile,ghConfig});
  for(const k of ['browserSandbox','ingressDeniedWithoutAuth','hostedPlugin'])facts.checks[k]=true;
  facts.browserVersion=host.browserVersion;
  const workflowId='acceptance-'+nonce,definition=makeWorkflow(workflowId,fixture);
  await host.importWorkflow(definition);facts.checks.uiWorkflowSave=true;
  await host.restart();
  const saved=await host.peer('get',workflowId);if(saved.definition.id!==workflowId)fail('ui-persistence-unproved');
  facts.checks.uiWorkflowRestart=true;
  if(config.mode==='ui'){facts.status='passed';facts.code='ok';}
  else{
   const identity=await host.identity();
   // Matches the product's version-checked Git bridge. Actual public host
   // resolve on launch must confirm each candidate; no failure fallback.
   const ws=id=>createHash('sha1').update(identity.projectId+':'+join(worktrees,id)).digest('hex').slice(0,12);
   const model={provider:config.mode==='live'?'openai':'faux',model:config.mode==='live'?MODEL:'faux-1',effort:'low'};
   const settings={runtime:'durable',workspaces:{a:ws('a'),b:ws('b')},
    finalization:{workspaceId:ws('final'),autoMerge:true},publication:{remote:'origin',baseBranch:trial.base,draft:true},
    models:{implementer:model,qc:{...model,effort:'max'},architect:model,planner:model},
    test:{execution:'sandbox',file:'node',args:[fixture+'/verify.mjs'],timeoutMs:15000},maxAttempts:2};
   await host.peer('auto.configure',{workflowId,config:settings});
   await host.peer('auto.start',{workflowId});
   let steered=false,pushRecovered=false,mergeRecovered=false,finished=false,observedFinalSha;
   const deadline=Date.now()+(config.mode==='live'?720000:120000);
   while(Date.now()<deadline&&!stopped){
    const runs=(await host.peer('agents.list',{view:'all'})).filter(r=>r.workflowId===workflowId);
    const running=runs.filter(r=>r.seat==='implementer'&&r.phase==='running'&&['a','b'].includes(r.taskId));
    if(running.length===2&&new Set(running.map(r=>r.workspaceId)).size===2)facts.checks.parallelWorkspaces=true;
    if(!steered&&running.length){
     const r=await host.peer('agents.command',{sessionId:running[0].sessionId,action:'steer',
      requestId:'acceptance-steer-'+nonce,text:'Keep the original single-marker contract. Do not change any other file or publish.'});
     if(r.status!=='ok')fail('steer-receipt-unproved');steered=true;facts.checks.steerReceipt=true;
    }
    const wf=await host.peer('get',workflowId),status=await host.peer('auto.status',{workflowId});
    const audit=JSON.parse(readFileSync(transport,'utf8'));
    if(audit.pushReplyLost&&!pushRecovered){
     if(status.enabled){await pause(200);continue;}
     await host.restart();await host.peer('auto.start',{workflowId});pushRecovered=true;continue;
    }
    if(audit.mergeReplyLost&&!mergeRecovered){
     if(status.enabled){await pause(200);continue;}
     await host.restart();await host.peer('auto.start',{workflowId});mergeRecovered=true;continue;
    }
    const qcRuns=runs.filter(r=>r.seat==='qc'&&r.phase==='sealed');
    if(['a','b','mm-final-integration'].every(id=>qcRuns.some(r=>r.taskId===id&&r.effort==='max'&&r.provider===model.provider&&r.model===model.model)))
      facts.checks.independentQc=true;
    const permissions=await host.peer('auto.permissions',{workflowId});
    for(const a of permissions.approvals.filter(a=>a.state==='pending')){
     const final=wf.tasks['mm-final-integration'];
     if(!final?.lastQc||final.lastQc.verdict!=='pass')fail('publication-qc-unproved');
     if(status.config.publication.baseBranch!==trial.base||status.config.publication.remote!=='origin')fail('publication-config-changed');
     assertApproval(a,trial,final.lastQc.headSha);observedFinalSha=a.headSha;
     await host.peer('auto.permission.decide',{approvalId:a.id,decision:'approved'});
     facts.checks.publicationApproved=true;
    }
    if(Object.values(wf.tasks).every(t=>t.status==='integrated')){finished=true;break;}
    if(!status.enabled)fail('workflow-stopped-before-publication');
    if(runs.some(r=>['failed','uncertain','blocked'].includes(r.phase)))fail('workflow-run-unproved');
    await pause(200);
   }
   if(!finished)fail(stopped?'interrupted':'workflow-deadline');
   const audit=JSON.parse(readFileSync(transport,'utf8'));
   facts.checks.pushResponseRecovery=pushRecovered&&audit.pushCalls===1;
   facts.checks.mergeResponseRecovery=mergeRecovered&&audit.mergeCalls===1;
   facts.checks.singleRemoteMutations=audit.pushCalls===1&&audit.createCalls===1&&audit.mergeCalls===1;
   facts.publication={headSha:audit.headSha,mergeSha:audit.mergeSha,prNumber:audit.prNumber,
     pushCalls:audit.pushCalls,mergeCalls:audit.mergeCalls,mainUnchanged:false};
   if(audit.headSha!==observedFinalSha)fail('publication-sha-changed');
   if(config.mode==='live'){
    const main=git(project,['ls-remote','--heads','https://github.com/'+REPOSITORY+'.git','refs/heads/main'],env).split(/\s/)[0];
    facts.publication.mainUnchanged=main===facts.mainBefore;
    if(!facts.publication.mainUnchanged)fail('main-changed-during-trial');
   }else facts.publication.mainUnchanged=true;
   // A separate controlled long tool is interrupted after the successful DAG.
   const abortId='interruption-'+nonce,abortDef=makeWorkflow(abortId,fixture,true);
   await host.importWorkflow(abortDef);
   const {finalization,publication,...abortSettings}=settings;
   await host.peer('auto.configure',{workflowId:abortId,config:{...abortSettings,workspaces:{abort:ws('abort')}}});
   await host.peer('auto.start',{workflowId:abortId});
   let interrupted;for(let i=0;i<150&&!stopped;i++){
    const runs=await host.peer('agents.list',{view:'all'});interrupted=runs.find(r=>r.workflowId===abortId&&r.phase==='running');
    if(interrupted)break;await pause(100);
   }
   if(!interrupted)fail('abort-target-unavailable');
   await pause(300);
   const receipt=await host.peer('agents.command',{sessionId:interrupted.sessionId,action:'abort',requestId:'acceptance-abort-'+nonce});
   if(receipt.status!=='ok')fail('abort-receipt-unproved');facts.checks.abortReceipt=true;
   for(let i=0;i<100;i++){
    const r=(await host.peer('agents.list',{view:'all'})).find(r=>r.sessionId===interrupted.sessionId);
    if(r?.abortRequested===1&&['uncertain','settled','failed','sealed'].includes(r.phase))break;await pause(100);
   }
   const before=boundedStats(host.pluginState);
   await host.restart();await pause(1200);
   const after=boundedStats(host.pluginState),runs=await host.peer('agents.list',{view:'all'});
   const original=runs.filter(r=>r.workflowId===abortId);
   if(before.count!==after.count||before.requests!==after.requests||original.length!==1||original[0].abortRequested!==1||
     existsSync(join(worktrees,'abort',fixture,'abort.txt')))fail('abort-replay-detected');
   facts.checks.abortRestartNoReplay=true;
   facts.runCount=after.count;facts.modelRequests=after.requests;facts.toolCalls=after.tools;
   facts.status='passed';facts.code='ok';
  }
 }catch(error){
  if(config?.mode==='rehearsal')process.stderr.write('[credential-free rehearsal] '+String(error).slice(0,1200)+'\n');
  facts.status=root?'failed':'blocked';facts.code=error instanceof HostedFailure?error.code:'hosted-execution-failed';
 }
 finally{
  clearTimeout(timer);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
  try{await host?.close();facts.checks.joinedShutdown=facts.code!=='shutdown-unproved';}catch{facts.status='failed';facts.code='shutdown-unproved';}
  if(root&&facts.checks.joinedShutdown&&facts.status==='passed'){
   try{rmSync(root,{recursive:true,force:true});facts.cleanup='removed';}
   catch{facts.status='failed';facts.code='cleanup-failed';}
  }
 }
 const receipt=hostedReceipt(config,source,facts);
 try{writeReceipt(config?.receipt,receipt);}catch{receipt.status='failed';receipt.code='receipt-refused';}
 console.log(JSON.stringify(receipt));return receipt.status==='passed'?0:receipt.status==='blocked'?2:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--help'))console.log('Hosted acceptance: --mode ui|rehearsal|live. Live requires --expected-sha <SHA> --approve-account-use --approve-test-publication. Optional --pi-auth-file <file> --gh-config-dir <dir> --receipt <fresh-file>. Never targets main; live trial refs remain for evidence.');
 else process.exitCode=await runHosted(process.argv.slice(2));
}
