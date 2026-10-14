/** Explicit same-repository test-branch publication, never main/release.
 * Setup uses ordinary Git/GitHub, but every tested push/PR/merge is dispatched by
 * the actual Micromanager publisher through the actual hosted browser peer.
 */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
export const TRIAL_REPOSITORY='zkamiyama/pi-micromanager';
export const TRIAL_REMOTE='https://github.com/'+TRIAL_REPOSITORY;
const token=()=>Date.now().toString(36)+'-'+randomBytes(4).toString('hex');
export function createPublicationSetup({checkout,project,home,root,sourceSha}){
 const ghConfig=join(homedir(),'.config/gh');
 const stat=lstatSync(ghConfig);
 if(!stat.isDirectory()||realpathSync(ghConfig)!==ghConfig||stat.uid!==process.getuid()||(stat.mode&0o022)!==0)
  throw Error('private-gh-profile-required');
 const env={PATH:'/usr/bin:/bin',HOME:home,GH_CONFIG_DIR:ghConfig,GH_PROMPT_DISABLED:'1',
  GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
 const command=(file,args,cwd=project)=>{
  const r=spawnSync(file,args,{cwd,env,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
  if(r.status!==0||r.error||r.signal)throw Error('test-remote-operation-unproved');
  return r.stdout.trim();
 };
 const gh=args=>command('/usr/bin/gh',args,root);
 const mainBefore=gh(['api','repos/'+TRIAL_REPOSITORY+'/git/ref/heads/main','--jq','.object.sha']);
 assert.match(mainBefore,/^[a-f0-9]{40}$/);
 // Clone only a reviewed existing local Git object database. No source checkout
 // containing credentials or shared working files is exposed to model tools.
 command('/usr/bin/git',['clone','--no-hardlinks','--no-checkout',checkout,project],root);
 const git=(args,path=project)=>command('/usr/bin/git',['-C',path,...args]);
 const prefix='e2e/local-luna-'+token(),base=prefix+'-base',source=prefix+'-source';
 git(['checkout','-b',base,mainBefore]);git(['remote','set-url','origin',TRIAL_REMOTE]);
 const workflows=git(['ls-tree','-r','--name-only',mainBefore,'--','.github/workflows']).split('\n').filter(Boolean).sort();
 assert.deepEqual(workflows,['.github/workflows/authenticated-e2e.yml','.github/workflows/ci.yml']);
 for(const file of workflows){
  const policy=git(['show',mainBefore+':'+file]);
  assert.doesNotMatch(policy,/pull_request_target|workflow_run|contents:\s*write|id-token:\s*write/);
  if(file.endsWith('authenticated-e2e.yml')){
   assert.match(policy,/workflow_dispatch:/);assert.doesNotMatch(policy,/^  (push|pull_request):/m);
  }
 }

 git(['config','user.name','Acceptance Fixture']);git(['config','user.email','fixture@invalid.local']);
 const initial={repository:TRIAL_REPOSITORY,mainBefore,base,source,sourceCodeSha:sourceSha,
  status:'setup-pending',lossMarker:join(root,'merge-reply-lost.json'),audit:join(root,'remote-audit.jsonl')};
 writeFileSync(join(root,'remote-trial.json'),JSON.stringify(initial),{mode:0o600,flag:'wx'});
 // A new ref only. HTTP conflict fails; no existing ref or branch is overwritten.
 gh(['api','--method','POST','repos/'+TRIAL_REPOSITORY+'/git/refs','-f','ref=refs/heads/'+base,'-f','sha='+mainBefore]);
 return {...initial,localRoot:root,project,ghConfig,git,gh,finishSetup(){
  git(['add','acceptance.test.mjs']);git(['commit','-m','test-only: synthetic hosted acceptance contract']);
  const fixtureSha=git(['rev-parse','HEAD']);
  assert.equal(gh(['api','repos/'+TRIAL_REPOSITORY+'/git/ref/heads/'+base,'--jq','.object.sha']),mainBefore);
  command('/usr/bin/git',['-c','credential.helper=!/usr/bin/gh auth git-credential','-C',project,
    'push',TRIAL_REMOTE,'HEAD:refs/heads/'+base]);
  initial.status='fixture-base-created';initial.fixtureSha=fixtureSha;
  writeFileSync(join(root,'remote-trial.json'),JSON.stringify(initial),{mode:0o600});
  return fixtureSha;
 }};
}
/** Appended to the test-only server entry; never installed in production source.
 * A real successful merge response is discarded exactly once. The durable
 * product reservation must be reconciled by observing GitHub after restart.
 * A second merge request is refused before another external side effect. */
export function publicationServerWrapper(actualExport,lossMarker,audit){
 return `import {appendFileSync,writeFileSync,existsSync} from 'node:fs';
const loss=${JSON.stringify(lossMarker)},audit=${JSON.stringify(audit)};
export default {...${actualExport},async activate(host){
 const original=host.execFile;
 return ${actualExport}.activate({...host,execFile:async request=>{
  const args=request.args??[],merge=['gh','/usr/bin/gh'].includes(request.file)&&args[0]==='api'&&args.includes('PUT')&&args.some(a=>/^repos\\/zkamiyama\\/pi-micromanager\\/pulls\\/[0-9]+\\/merge$/.test(a));
  if(merge){appendFileSync(audit,JSON.stringify({operation:'merge-request'})+'\\n',{mode:0o600});if(existsSync(loss))throw Error('Second merge request refused by test supervisor');}
  const result=await original(request);
  if(merge&&result.exitCode===0&&/^HTTP\\/[0-9.]+\\s+200\\b/m.test(result.stdout)&& /"merged"\\s*:\\s*true/.test(result.stdout)){
   writeFileSync(loss,JSON.stringify({responseDiscarded:true}),{mode:0o600,flag:'wx'});
   throw Error('Synthetic lost merge response; reconcile actual GitHub state');
  }
  return result;
 }});
}};`;
}
export function manualPublicationConfig(config){
 const {managedWorktrees,...manual}=config;return manual;
}
export async function runPublicationTrial({setup,call,wait,restart,profile,definition,onStage=()=>{}}){
 onStage('provision');const workflowId='publication';
 const spec=definition(workflowId,['source']);
 spec.permissions={default:'deny',actions:{'git.commit':'ask','git.integrate':'allow','git.push':'ask',
  'github.pr.create':'ask','github.pr.merge':'ask'}};
 const config={...profile,finalization:{workspaceId:'auto',autoMerge:true},
  publication:{remote:'origin',baseBranch:setup.base,draft:true}};
 await call('create',spec);await call('auto.configure',{workflowId,config});await call('auto.start',{workflowId});
 await call('auto.pause',{workflowId});
 let state=await call('auto.status',{workflowId});
 assert.equal((await call('agents.list',{view:'all'})).some(r=>r.workflowId===workflowId),false);
 const allowed=new Set([state.config.workspaces.source,state.config.finalization.workspaceId]);
 onStage('rename-idle-test-branches');
 for(const taskId of ['source','mm-final-integration']){
  const plan=await call('auto.worktree.status',{workflowId,taskId});assert.ok(plan?.path);assert.equal(plan.stage,'created');
  assert.equal(realpathSync(plan.path),plan.path);assert.ok(plan.path.startsWith(join(setup.localRoot,'state','plugin-data','micromanager','managed-worktrees')+'/'));assert.equal(plan.repoRoot,setup.project);
  const target=taskId==='source'?setup.source+'-task':setup.source;
  const branch=setup.git(['symbolic-ref','--short','HEAD'],plan.path);assert.equal(branch,plan.branch);
  setup.git(['branch','-m',target],plan.path);
 }
 // Only new idle test worktrees are renamed. Keep host-verified physical IDs;
 // no production plan is altered, and no Run has yet been launched.
 onStage('admit-configured-workflow');
 const configured=manualPublicationConfig(state.config);
 await call('auto.configure',{workflowId,config:configured});await call('auto.start',{workflowId});
 onStage('await-approved-publisher');
 let reconciled=false,prUrl,finalSha;
 await wait(async()=>{
  if(existsSync(setup.lossMarker)&&!reconciled){
   onStage('lost-response-restart');const proof=JSON.parse(readFileSync(setup.lossMarker,'utf8'));assert.equal(proof.responseDiscarded,true);
   await call('auto.pause',{workflowId});await restart();await call('auto.start',{workflowId});reconciled=true;
  }
  const current=await call('get',workflowId),status=await call('auto.permissions',{workflowId});
  for(const approval of status.approvals.filter(a=>a.state==='pending')){
   if(approval.action==='git.commit')assert.ok(allowed.has(approval.target));
   else{
    assert.ok(['git.push','github.pr.create','github.pr.merge'].includes(approval.action));
    const target=JSON.parse(approval.target);
    assert.equal(target.repository,TRIAL_REPOSITORY);assert.equal(target.sourceBranch,setup.source);
    assert.equal(target.pushUrl,TRIAL_REMOTE);
    const plan=await call('auto.worktree.status',{workflowId,taskId:'mm-final-integration'});
    const actual=setup.git(['rev-parse','HEAD'],plan.path);assert.equal(actual,approval.headSha);finalSha=actual;
    assert.deepEqual(setup.git(['diff','--name-only',setup.base+'...HEAD'],plan.path).split('\n').filter(Boolean),['acceptance.txt']);
    assert.equal(setup.git(['show','HEAD:acceptance.txt'],plan.path),'synthetic acceptance confirmed');
   }
   await call('auto.permission.decide',{approvalId:approval.id,decision:'approved'});
  }
  for(const operation of status.publication){
   if(/^https:\/\/github.com\/zkamiyama\/pi-micromanager\/pull\/\d+$/.test(operation.result??''))prUrl=operation.result;
  }
  return reconciled&&Object.values(current.tasks).filter(t=>t.spec.kind==='implementation').every(t=>t.status==='integrated');
 },600000);
 onStage('verify-actual-remote');assert.ok(prUrl);assert.ok(finalSha);
 const remote=JSON.parse(setup.gh(['pr','view',prUrl,'--repo',TRIAL_REPOSITORY,'--json','state,headRefOid,headRefName,baseRefName,mergeCommit,url']));
 assert.equal(remote.state,'MERGED');assert.equal(remote.headRefOid,finalSha);assert.equal(remote.headRefName,setup.source);assert.equal(remote.baseRefName,setup.base);
 assert.equal(setup.gh(['api','repos/'+TRIAL_REPOSITORY+'/git/ref/heads/main','--jq','.object.sha']),setup.mainBefore);
 const requests=readFileSync(setup.audit,'utf8').trim().split('\n').map(s=>JSON.parse(s));
 assert.equal(requests.filter(r=>r.operation==='merge-request').length,1);
 await call('auto.pause',{workflowId});
 return {status:'passed',repository:TRIAL_REPOSITORY,base:setup.base,source:setup.source,
  prUrl,headSha:finalSha,mergeSha:remote.mergeCommit.oid,mainUnchanged:true,
  discardedSuccessfulMergeReply:true,recoveredByObservation:true,mergeRequests:1,testRefsRetained:true};
}
