import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync,symlinkSync,linkSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createServer,connect} from 'node:net';
import {createHash} from 'node:crypto';
import {RunSafetyLedger,DEFAULT_LIMITS,classifyInputOutcomes} from '../dist/security/run-safety.js';
import {parseProductionPolicy,assertProductionConfig,assertProductionDestination,assertProductionProject} from '../dist/security/policy.js';
import {acquireStateOwner,privateStateRoot} from '../dist/security/state-owner.js';
import {gitExecutionEnvironment,assertPassiveRepositoryConfig} from '../dist/security/git-guard.js';
import {brokerGit} from '../dist/security/git-broker.js';
import {sandboxExec,inspectSandboxWorkspace,boundedProcess,FILE_SERVICE} from '../dist/security/sandbox.js';
const temp=()=>mkdtempSync(join(tmpdir(),'mm-security-'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const limits={maxCommandMs:5000,maxWorkspaceBytes:20*1024*1024};
function git(root,...args){const r=spawnSync('git',['-C',root,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function repository(){const root=temp(),repo=join(root,'repo'),wt=join(root,'worker');mkdirSync(repo);git(repo,'init','-b','main');git(repo,'config','user.name','fixture');git(repo,'config','user.email','fixture@localhost');writeFileSync(join(repo,'source.txt'),'baseline\n');git(repo,'add','.');git(repo,'commit','-m','base');git(repo,'worktree','add','-b','feature/security',wt);return {root,repo,wt};}
async function sandboxAvailable(t){
 const root=temp();
 try{
  if(!existsSync('/usr/bin/bwrap')){
   if(process.env.MM_REQUIRE_SANDBOX==='1')assert.fail('Release security gate requires actual Bubblewrap');
   t.skip('No Bubblewrap here: successful isolation is not certified');return false;
  }
  try{const r=await sandboxExec(root,['/bin/true'],true,limits);assert.equal(r.exitCode,0,r.stderr);return true;}
  catch(error){
   if(process.env.MM_REQUIRE_SANDBOX!=='1'&&/Operation not permitted|No permissions to create|Creating new namespace failed|Failed RTM_NEWADDR/.test(String(error))){
    assert.match(String(error),/no host fallback/);
    t.skip('Host namespace policy refused sandbox; no successful-isolation certification');return false;
   }
   throw error;
  }
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('S01: runtime success requires every persisted input to be done, never merely idle',()=>{
 assert.equal(classifyInputOutcomes([{type:'input',status:'done'}],false),'completed');
 for(const entries of [[],[undefined],[{type:'input',status:'queued'}],[{type:'input',status:'placed'}],[{type:'write',status:'done'}]])assert.equal(classifyInputOutcomes(entries,false),'uncertain');
 assert.equal(classifyInputOutcomes([{type:'input',status:'done'},{type:'input',status:'unanswered'}],false),'failed');
 assert.equal(classifyInputOutcomes([{type:'input',status:'done'}],true),'aborted');
});
test('S03: counters, immutable outcomes and input receipts survive actual SQLite reopen',()=>{
 const root=temp(),file=join(root,'s.sqlite'),key=hash('run');let db=new RunSafetyLedger(file);
 try{db.reserve(key,'f',{...DEFAULT_LIMITS,maxModelRequests:1},Date.now());db.consume(key,'model');db.trackInput(key,'original');db.close();db=new RunSafetyLedger(file);
 assert.throws(()=>db.consume(key,'model'),/budget exhausted/);assert.deepEqual(db.inputs(key),['original']);
 assert.throws(()=>db.reserve(key,'different',DEFAULT_LIMITS,Date.now()),/changed/);
 db.finish(key,'failed');assert.throws(()=>db.finish(key,'completed'),/immutable/);assert.throws(()=>db.trackInput(key,'retry'),/terminal/);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('S03: aggregate reservations and uncertain effects never disappear behind per-Workflow limits',()=>{
 const root=temp(),a=new RunSafetyLedger(join(root,'s.sqlite')),b=new RunSafetyLedger(join(root,'s.sqlite'));
 try{a.reserve(hash('a'),'f',{...DEFAULT_LIMITS,maxConcurrentRuns:1},Date.now());assert.throws(()=>b.reserve(hash('b'),'g',{...DEFAULT_LIMITS,maxConcurrentRuns:1},Date.now()),/Host-wide/);
 a.finish(hash('a'),'uncertain');assert.throws(()=>b.reserve(hash('b'),'g',{...DEFAULT_LIMITS,maxConcurrentRuns:1},Date.now()),/Host-wide/);
 }finally{a.close();b.close();rmSync(root,{recursive:true,force:true});}
});
test('S03: a restarted expired run cannot renew its wall-clock deadline',()=>{
 const root=temp(),db=new RunSafetyLedger(join(root,'s.sqlite')),key=hash('expired');
 try{db.reserve(key,'f',{...DEFAULT_LIMITS,maxRunMs:1000},Date.now()-2000);db.reserve(key,'f',DEFAULT_LIMITS,Date.now());assert.throws(()=>db.consume(key,'tool'),/wall-clock/);}
 finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('S04: actual OS ownership excludes a second instance, then releases without lock stealing',async()=>{
 const root=temp();let a,b;
 try{a=await acquireStateOwner(root);await assert.rejects(acquireStateOwner(root),/owner|locking/);await a.release();b=await acquireStateOwner(root);assert.equal(b.lost.aborted,false);}
 finally{await a?.release();await b?.release();rmSync(root,{recursive:true,force:true});}
});
test('S04: state privacy, SQLite symlinks and restored-state quarantine fail closed',()=>{
 const root=temp();try{chmodSync(root,0o755);assert.throws(()=>privateStateRoot(root),/private/);chmodSync(root,0o700);
 const external=join(root,'data');writeFileSync(external,'x',{mode:0o600});symlinkSync(external,join(root,'test.sqlite'));assert.throws(()=>privateStateRoot(root),/SQLite/);rmSync(join(root,'test.sqlite'));
 writeFileSync(join(root,'RESTORE_REQUIRES_REVIEW'),'not reviewed');assert.throws(()=>privateStateRoot(root),/quarantined/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('S02: host configuration overrides are finite and inherited executable config cannot win',()=>{
 const {env,unsetEnv}=gitExecutionEnvironment({GIT_CONFIG_PARAMETERS:"'core.hooksPath=/tmp/unsafe'",GIT_CONFIG_COUNT:'99',GIT_CONFIG_KEY_50:'x'});
 assert.ok(unsetEnv.includes('GIT_CONFIG_PARAMETERS'));assert.ok(unsetEnv.includes('GIT_CONFIG_KEY_50'));assert.equal(env.GIT_CONFIG_COUNT,'6');assert.equal(env.GIT_NO_REPLACE_OBJECTS,'1');
 for(const config of ['filter.x.clean','merge.x.driver','diff.x.textconv','include.path','includeIf.gitdir:x.path','credential.helper','url.bad.insteadOf','core.sshCommand','extensions.worktreeConfig'])assert.throws(()=>assertPassiveRepositoryConfig(config),/forbidden/);
 assert.doesNotThrow(()=>assertPassiveRepositoryConfig('core.repositoryformatversion\nremote.origin.url\nuser.name'));
});
test('S02: real Git commit broker never executes an installed pre-commit hook',async()=>{
 const x=repository(),sentinel=join(x.root,'hook-ran');
 try{writeFileSync(join(x.repo,'.git','hooks','pre-commit'),`#!/bin/sh\nprintf bad > '${sentinel}'\n`,{mode:0o755});writeFileSync(join(x.wt,'source.txt'),'new\n');
 const r=await brokerGit(x.wt,'commit','broker commit',[],limits);assert.equal(r.exitCode,0,r.stderr);assert.equal(existsSync(sentinel),false);assert.equal(git(x.wt,'show','HEAD:source.txt'),'new');assert.equal(git(x.repo,'show','HEAD:source.txt'),'baseline');
 }finally{rmSync(x.root,{recursive:true,force:true});}
});
test('S02: executable filter config is refused before staging untrusted source',async()=>{
 const x=repository();try{git(x.repo,'config','filter.evil.clean','sh -c "exit 0"');writeFileSync(join(x.wt,'source.txt'),'new\n');await assert.rejects(brokerGit(x.wt,'commit','no',[],limits),/filter/);assert.equal(git(x.wt,'diff','--cached','--name-only'),'');}
 finally{rmSync(x.root,{recursive:true,force:true});}
});
test('S05: production policy is host-owned, exact and cannot inherit YOLO mutations',()=>{
 const root=temp();try{const p=parseProductionPolicy({mode:'production',projectRoots:[root],models:[{provider:'faux',model:'faux-1'}],publication:[{repository:'acme/repo',baseBranch:'main'}]});
 const config={runtime:'durable',test:{execution:'sandbox'},models:{qc:{provider:'faux',model:'faux-1'}}},definition={permissions:{default:'ask'}};
 assert.doesNotThrow(()=>assertProductionConfig(p,config,definition));
 for(const c of [{...config,runtime:'pi-web'},{...config,test:{execution:'trusted-host'}}])assert.throws(()=>assertProductionConfig(p,c,definition),/Production/);
 assert.throws(()=>assertProductionConfig(p,config,{permissions:{default:'allow'}}),/approval/);
 assert.throws(()=>assertProductionDestination(p,'acme/other','main'),/allowlist/);
 assert.throws(()=>assertProductionProject(p,tmpdir()),/allowlist/);
 assert.throws(()=>parseProductionPolicy({mode:'production',projectRoots:['/'],models:[]}),/root/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('S03: bounded command terminates excessive output and timeout rather than retaining unbounded logs',async()=>{
 const root=temp();try{const r=await boundedProcess(process.execPath,['-e',"process.stdout.write('x'.repeat(200000))"],{cwd:root,timeoutMs:2000});assert.equal(r.truncated,true);
 await assert.rejects(boundedProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,timeoutMs:60}),/timed out/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('S05: source symlinks, hardlinks and file quotas are rejected before any sandbox invocation',()=>{
 const root=temp(),source=join(root,'source'),external=join(root,'external');mkdirSync(source);writeFileSync(external,'private');
 try{symlinkSync(external,join(source,'alias'));assert.throws(()=>inspectSandboxWorkspace(source,1e6),/symlink/);rmSync(join(source,'alias'));
 linkSync(external,join(source,'alias'));assert.throws(()=>inspectSandboxWorkspace(source,1e6),/hardlink/);rmSync(join(source,'alias'));
 writeFileSync(join(source,'large'),'12345');assert.throws(()=>inspectSandboxWorkspace(source,1),/byte budget/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Production isolation success: host file, environment and Git metadata are absent',async t=>{
 if(!await sandboxAvailable(t))return;const x=repository(),secret=join(x.root,'host-private');writeFileSync(secret,'synthetic');
 try{const code=`const fs=require('node:fs');console.log(JSON.stringify({outside:fs.existsSync(${JSON.stringify(secret)}),git:fs.readFileSync('/workspace/.git','utf8'),home:process.env.HOME,token:process.env.MM_SYNTHETIC_TOKEN??null}));`;
 process.env.MM_SYNTHETIC_TOKEN='test-only';const r=await sandboxExec(x.wt,['/runtime/node','-e',code],true,limits);delete process.env.MM_SYNTHETIC_TOKEN;
 assert.equal(r.exitCode,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{outside:false,git:'',home:'/tmp',token:null});
 const write=await sandboxExec(x.wt,['/runtime/node','-e',FILE_SERVICE],true,limits,undefined,JSON.stringify({op:'write',path:'source.txt',content:'bad'}));assert.notEqual(write.exitCode,0);assert.equal(readFileSync(join(x.wt,'source.txt'),'utf8'),'baseline\n');
 }finally{delete process.env.MM_SYNTHETIC_TOKEN;rmSync(x.root,{recursive:true,force:true});}
});
test('Production isolation success: a reachable host-loopback service cannot be reached by the worker',async t=>{
 if(!await sandboxAvailable(t))return;const root=temp(),server=createServer(s=>s.end('fixture'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const port=server.address().port;await new Promise((resolve,reject)=>{const c=connect(port,'127.0.0.1',()=>{c.destroy();resolve();});c.on('error',reject);});
 const code=`const c=require('node:net').connect(${port},'127.0.0.1');c.on('connect',()=>process.exit(2));c.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),250);`;
 const r=await sandboxExec(root,['/runtime/node','-e',code],false,limits);assert.equal(r.exitCode,0,r.stderr);
 }finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
});
