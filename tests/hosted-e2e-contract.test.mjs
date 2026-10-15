import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHostedArguments,assertTrialIdentity,assertFixtureChanges,assertApproval,hostedReceipt,REQUIRED,REPOSITORY} from '../scripts/hosted-e2e-contract.mjs';
import {wrapAcceptanceExec} from '../scripts/hosted-e2e-transport.mjs';
import {assertFinalMergeSources} from '../dist/automation/host-port.js';
const sha='a'.repeat(40),prefix='e2e/local-luna-abc01234';
const trial={repository:REPOSITORY,prefix,base:prefix+'-base',head:prefix+'-final',seedSha:sha,fixture:'examples/acceptance/abc01234'};
const output=stdout=>({stdout,stderr:'',exitCode:0,signal:null,stdoutTruncated:false,stderrTruncated:false});
test('#92 live hosted admission requires two explicit authorizations and exact source',()=>{
 assert.equal(parseHostedArguments(['--mode','ui']).mode,'ui');
 assert.equal(parseHostedArguments(['--mode','rehearsal']).mode,'rehearsal');
 for(const args of [[],['--mode','live'],['--mode','live','--approve-account-use'],
  ['--mode','live','--approve-account-use','--approve-test-publication'],
  ['--mode','rehearsal','--pi-auth-file','/synthetic/auth'],['--mode','ui','--gh-config-dir','/synthetic/gh']])
  assert.throws(()=>parseHostedArguments(args));
 assert.equal(parseHostedArguments(['--mode','live','--approve-account-use','--approve-test-publication','--expected-sha',sha]).expectedSha,sha);
});
test('#92 same-repository trial never accepts main, arbitrary branch, other repository or unsafe fixture',()=>{
 assert.doesNotThrow(()=>assertTrialIdentity(trial));
 for(const change of [{base:'main'},{head:'main'},{repository:'other/repo'},
  {prefix:'e2e/local-luna-../../main'},{seedSha:'HEAD'},{fixture:'examples/acceptance/../escape'}])
  assert.throws(()=>assertTrialIdentity({...trial,...change}));
 assert.doesNotThrow(()=>assertFixtureChanges([trial.fixture+'/a.txt',trial.fixture+'/b.txt'],trial.fixture));
 for(const paths of [[],['.github/workflows/ci.yml'],['package.json'],[trial.fixture+'/../outside'],[trial.fixture+'/verify.mjs']])
  assert.throws(()=>assertFixtureChanges(paths,trial.fixture));
});
test('#92 automatic test approval remains bound to the actual final QC SHA and exact source/repository',()=>{
 const a={action:'git.push',taskId:'mm-final-integration',headSha:sha,state:'pending',
  target:JSON.stringify({repository:trial.repository,sourceBranch:trial.head,pushUrl:'https://github.com/'+trial.repository+'.git'})};
 assert.doesNotThrow(()=>assertApproval(a,trial,sha));
 for(const change of [{headSha:'b'.repeat(40)},{taskId:'a'},{state:'approved'},{action:'deploy.production'},
  {target:JSON.stringify({repository:trial.repository,sourceBranch:'main',pushUrl:'https://github.com/'+trial.repository+'.git'})}])
  assert.throws(()=>assertApproval({...a,...change},trial,sha));
});
test('#92 result distinguishes a UI/rehearsal run from model authentication and actual remote evidence',()=>{
 const facts={status:'passed',code:'ok',checks:Object.fromEntries(REQUIRED.map(k=>[k,true])),cleanup:'removed'};
 const simulated=hostedReceipt({mode:'rehearsal'},null,facts);
 assert.equal(simulated.status,'passed');assert.equal(simulated.assurance.modelAuthentication,'not-verified');
 assert.equal(simulated.assurance.remoteTransport,'simulated-local-bare-git');
 assert.equal(simulated.productionSafetyGuaranteed,false);
 assert.equal(hostedReceipt({mode:'live'},null,{...facts,checks:{...facts.checks,mergeResponseRecovery:false}}).status,'failed');
 const redacted=hostedReceipt({mode:'live'},null,{...facts,code:'PRIVATE-TOKEN',raw:'PRIVATE-TOKEN',token:'PRIVATE-TOKEN'});
 assert.doesNotMatch(JSON.stringify(redacted),/PRIVATE-TOKEN/);
});
test('#92 real-host exec wrapper injects reply loss only after one verified test push and refuses replay',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-hosted-transport-')),path=join(root,'audit.json');
 writeFileSync(path,JSON.stringify({pushCalls:0}),{mode:0o600});let pushes=0;
 try{
  const exec=wrapAcceptanceExec(async r=>{
   if(r.args.includes('diff'))return output(trial.fixture+'/a.txt\n');
   if(r.args.includes('push')){pushes++;return output('Synthetic successful write');}
   throw Error('Unexpected command');
  },{...trial,mode:'live',transport:path});
  const r={file:'/usr/bin/git',cwd:'/synthetic/worktree',args:['-C','/synthetic/worktree','push','--porcelain',
    'https://github.com/'+trial.repository+'.git',sha+':refs/heads/'+trial.head],signal:new AbortController().signal};
  await assert.rejects(exec(r),/lost pushReplyLost/);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).pushCalls,1);assert.equal(pushes,1);
  await assert.rejects(exec(r),/duplicate-remote-mutation/);assert.equal(pushes,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('#92 real-host exec wrapper refuses wrong branch before executing any mutation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-hosted-transport-')),path=join(root,'audit.json');writeFileSync(path,'{}');let calls=0;
 try{
  const exec=wrapAcceptanceExec(async()=>{calls++;return output('');},{...trial,mode:'live',transport:path});
  await assert.rejects(exec({file:'/usr/bin/git',cwd:'/synthetic',args:['-C','/synthetic','push','--porcelain',
    'https://github.com/'+trial.repository+'.git',sha+':refs/heads/main'],signal:new AbortController().signal}),/remote-identity-refused/);
  assert.equal(calls,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('#92 final merge authority rechecks QC sources and excludes ordinary workers',()=>{
 const current={tasks:{a:{spec:{kind:'implementation'},status:'passed',lastQc:{verdict:'pass',headSha:sha}},
  final:{spec:{systemPurpose:'final-integration',dependsOn:[{taskId:'a'}]}}}};
 const job={kind:'implementation',taskId:'final',allowedMergeShas:[sha]};
 assert.doesNotThrow(()=>assertFinalMergeSources(job,current));
 for(const j of [{...job,allowedMergeShas:[]},{...job,allowedMergeShas:['b'.repeat(40)]},{...job,taskId:'a'}])
  assert.throws(()=>assertFinalMergeSources(j,current));
 current.tasks.a.lastQc.verdict='fail';assert.throws(()=>assertFinalMergeSources(job,current));
});

import {isStillRunning,signalRecorded} from '../scripts/hosted-e2e-processes.mjs';
test('#92 supervisor does not confuse a dead parent, kernel-blocked descendant or reused PID with joined cleanup',()=>{
 const record={pid:999999,start:'123',state:'S'},signals=[];
 assert.equal(isStillRunning(record,()=>({pid:record.pid,start:'123',state:'D'})),true);
 assert.equal(isStillRunning(record,()=>({pid:record.pid,start:'456',state:'R'})),false);
 assert.equal(isStillRunning(record,()=>({pid:record.pid,start:'123',state:'Z'})),false);
 assert.equal(isStillRunning(record,()=>undefined),false);
 signalRecorded([record],'SIGTERM',()=>({pid:record.pid,start:'456',state:'R'}),(pid,sig)=>signals.push([pid,sig]));
 assert.equal(signals.length,0,'Never signal a reused PID');
 signalRecorded([record],'SIGTERM',()=>({pid:record.pid,start:'123',state:'D'}),(pid,sig)=>signals.push([pid,sig]));
 assert.deepEqual(signals,[[999999,'SIGTERM']]);
});

import {DatabaseSync} from 'node:sqlite';
test('#92 test-owned async source inspection cannot open a new stale-generation mutation window',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-hosted-fence-')),path=join(root,'audit.json');writeFileSync(path,'{}');
 const db=new DatabaseSync(join(root,'autopilot.sqlite'));
 db.exec("CREATE TABLE autopilots(scope TEXT,workflow_id TEXT,enabled INTEGER,generation INTEGER);INSERT INTO autopilots VALUES('synthetic','wf',1,1)");
 let entered,release,calls=0;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 try{
  const exec=wrapAcceptanceExec(async r=>{
   if(r.args.includes('diff')){entered();await gate;return output(trial.fixture+'/a.txt\n');}
   calls++;return output('');
  },{...trial,mode:'live',transport:path,controlDataDirectory:root});
  const pending=exec({file:'/usr/bin/git',cwd:'/synthetic',args:['-C','/synthetic','push','--porcelain',
   'https://github.com/'+trial.repository+'.git',sha+':refs/heads/'+trial.head],signal:new AbortController().signal});
  const refused=assert.rejects(pending,/operator-generation-changed/);
  await ready;db.exec('UPDATE autopilots SET enabled=0,generation=2');release();await refused;
  assert.equal(calls,0,'The wrapper may not mutate after its added inspection becomes stale');
 }finally{release();db.close();rmSync(root,{recursive:true,force:true});}
});

import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {seedRehearsalRemote} from '../scripts/local-hosted-e2e.mjs';
test('#92 rehearsal remote initializes correctly from a shallow CI checkout without weakening receive policy',()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-shallow-trial-')),source=join(root,'source'),shallow=join(root,'shallow'),bare=join(root,'remote.git');
 const env={PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_AUTHOR_NAME:'synthetic',GIT_AUTHOR_EMAIL:'test@invalid.local',GIT_COMMITTER_NAME:'synthetic',GIT_COMMITTER_EMAIL:'test@invalid.local'};
 const git=(cwd,args)=>{const r=spawnSync('/usr/bin/git',args,{cwd,env,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 try{
  git(root,['init',source]);git(source,['commit','--allow-empty','-m','first']);git(source,['commit','--allow-empty','-m','second']);
  git(root,['clone','--depth','1',pathToFileURL(source).href,shallow]);
  assert.equal(git(shallow,['rev-parse','--is-shallow-repository']),'true');
  git(shallow,['switch','-c',trial.base]);git(shallow,['commit','--allow-empty','-m','fixture']);
  const seed=git(shallow,['rev-parse','HEAD']);seedRehearsalRemote(shallow,bare,env);
  assert.equal(git(root,['--git-dir='+bare,'rev-parse','refs/heads/'+trial.base]),seed);
  git(shallow,['commit','--allow-empty','-m','synthetic-next']);const next=git(shallow,['rev-parse','HEAD']);
  git(shallow,['push',bare,next+':refs/heads/'+trial.head]);
  assert.equal(git(root,['--git-dir='+bare,'rev-parse','refs/heads/'+trial.head]),next);
 }finally{rmSync(root,{recursive:true,force:true});}
});

import {processIdentity,descendants} from '../scripts/hosted-e2e-processes.mjs';
test('#92 process inspection failure is unknown, not proof of exit or permission to signal',()=>{
 const denied=()=>{throw Object.assign(new Error('synthetic-private-inspection-error'),{code:'EACCES'});};
 const absent=()=>{throw Object.assign(new Error('gone'),{code:'ENOENT'});};
 assert.equal(processIdentity(999999,absent),undefined);
 assert.throws(()=>processIdentity(999999,denied),/^Error: process-inspection-unproved$/);
 assert.throws(()=>processIdentity(999999,()=> 'incomplete stat'),/process-inspection-unproved/);
 const recorded={pid:999999,start:'123',state:'S'},signals=[];
 assert.equal(isStillRunning(recorded,denied),true,'Unknown inspection pins temporary state');
 signalRecorded([recorded],'SIGKILL',denied,(...args)=>signals.push(args));
 assert.equal(signals.length,0,'An unreadable identity may belong to a reused PID');
});
test('#92 descendant enumeration cannot silently discard permission failures',()=>{
 const identity=pid=>({pid,start:String(pid),state:'S'});
 const denied=()=>{throw Object.assign(new Error('no permission'),{code:'EPERM'});};
 assert.throws(()=>descendants(1,{identity,tasks:denied,children:()=>''}),/process-inspection-unproved/);
 assert.throws(()=>descendants(1,{identity,tasks:()=>['1'],children:denied}),/process-inspection-unproved/);
 const gone=()=>{throw Object.assign(new Error('exited task'),{code:'ENOENT'});};
 assert.equal(descendants(1,{identity,tasks:()=>['1'],children:gone}).size,0);
});
test('#92 bounded process inventory exhaustion is unproved rather than a truncated success',()=>{
 const system={identity:pid=>({pid,start:String(pid),state:'S'}),tasks:()=>['1'],children:pid=>String(pid+1)};
 assert.throws(()=>descendants(1,system),/process-inspection-unproved/);
});
