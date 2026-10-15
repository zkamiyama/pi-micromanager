import {COMPONENTS} from './e2e-contract.mjs';
/** Admission and bounded evidence for the operator-owned hosted test. */
import {isAbsolute,resolve} from 'node:path';
export const REPOSITORY='zkamiyama/pi-micromanager';
export const MODEL='gpt-6-luna';
export const SHA=/^[a-f0-9]{40}$/;
export class HostedFailure extends Error{constructor(code){super(code);this.code=code;}}
export const fail=code=>{throw new HostedFailure(code);};
export function parseHostedArguments(args){
 const values=new Map(),flags=new Set(['--approve-account-use','--approve-test-publication']);
 const fields=new Set(['--mode','--expected-sha','--pi-auth-file','--gh-config-dir','--receipt']);
 for(let i=0;i<args.length;i++){
  const k=args[i];if(values.has(k)||!flags.has(k)&&!fields.has(k))fail('invalid-arguments');
  if(flags.has(k)){values.set(k,true);continue;}
  const v=args[++i];if(typeof v!=='string'||!v||v.startsWith('--')||v.includes('\0'))fail('invalid-arguments');
  values.set(k,v);
 }
 const mode=values.get('--mode');
 if(!['ui','rehearsal','live'].includes(mode))fail('invalid-arguments');
 const expectedSha=values.get('--expected-sha');
 if(expectedSha!==undefined&&!SHA.test(expectedSha))fail('invalid-arguments');
 if(mode==='live'&&(!values.get('--approve-account-use')||!values.get('--approve-test-publication')))
  fail('approval-required');
 if(mode==='live'&&!expectedSha)fail('source-unproved');
 for(const key of ['--pi-auth-file','--gh-config-dir','--receipt']){
  const p=values.get(key);if(p!==undefined&&(!isAbsolute(p)||resolve(p)!==p||p.length>1024))fail('invalid-arguments');
  if(mode!=='live'&&key!=='--receipt'&&p!==undefined)fail('invalid-arguments');
 }
 return Object.freeze({mode,expectedSha,authFile:values.get('--pi-auth-file'),
  ghConfig:values.get('--gh-config-dir'),receipt:values.get('--receipt')});
}
export function validTrialPrefix(prefix){return /^e2e\/local-luna-[a-z0-9]{8,40}$/.test(prefix);}
export function assertTrialIdentity(config){
 if(config.repository!==REPOSITORY||!validTrialPrefix(config.prefix)||
   config.base!==config.prefix+'-base'||config.head!==config.prefix+'-final'||
   !SHA.test(config.seedSha)||!/^examples\/acceptance\/[a-z0-9]{8,40}$/.test(config.fixture))fail('trial-scope-refused');
}
export function assertFixtureChanges(paths,fixture){
 const allowed=new Set([fixture+'/a.txt',fixture+'/b.txt']);
 if(paths.length<1||paths.length>2||paths.some(p=>!allowed.has(p)))fail('unexpected-source-change');
}
export function assertApproval(a,trial,expectedSha){
 if(!['git.push','github.pr.create','github.pr.merge'].includes(a.action)||a.taskId!=='mm-final-integration'||
   !SHA.test(a.headSha)||a.headSha!==expectedSha||a.state!=='pending')fail('approval-subject-refused');
 let t;try{t=JSON.parse(a.target);}catch{fail('approval-subject-refused');}
 // PermissionLedger persists the exact destination tuple, not merely an alias.
 if(!t||t.repository!==trial.repository||t.sourceBranch!==trial.head||
   t.pushUrl!=='https://github.com/'+trial.repository+'.git')fail('approval-subject-refused');
}
export const REQUIRED=['browserSandbox','ingressDeniedWithoutAuth','hostedPlugin','uiWorkflowSave','uiWorkflowRestart',
 'parallelWorkspaces','steerReceipt','independentQc','publicationApproved','pushResponseRecovery','mergeResponseRecovery',
 'singleRemoteMutations','abortReceipt','abortRestartNoReplay','joinedShutdown'];
export function hostedReceipt(config,source,facts){
 const keys=REQUIRED;
 const checks=Object.fromEntries(keys.map(k=>[k,facts.checks?.[k]===true?'passed':'not-proved']));
 const core=config?.mode==='ui'?keys.slice(0,5).concat('joinedShutdown'):keys;
 const passed=facts.status==='passed'&&core.every(k=>checks[k]==='passed');
 const boundInt=n=>Number.isSafeInteger(n)&&n>=0&&n<100000?n:null;
 const safeSha=s=>SHA.test(s??'')?s:null;
 return {schemaVersion:1,suite:'micromanager-hosted-acceptance',mode:config?.mode??'unselected',
  status:passed?'passed':facts.status==='blocked'?'blocked':'failed',
  code:passed?'ok':/^[a-z][a-z0-9-]{0,80}$/.test(facts.code??'')?facts.code:'not-proved',
  source:source?{commit:safeSha(source.commit),workingTreeClean:source.workingTreeClean===true,
    lockSha256:/^[a-f0-9]{64}$/.test(source.lockSha256??'')?source.lockSha256:null,
    node:/^[0-9.]{1,32}$/.test(source.node??'')?source.node:'unknown',
    versions:Object.fromEntries(COMPONENTS.map(k=>[k,/^[0-9][A-Za-z0-9.+-]{0,79}$/.test(source.versions?.[k]??'')?source.versions[k]:'unknown']))}:null,
  browserVersion:/^[0-9.]{1,64}$/.test(facts.browserVersion??'')?facts.browserVersion:null,
  playwrightVersion:'1.64.0',
  checks,model:config?.mode==='live'?{provider:'openai',model:MODEL,implementerEffort:'low',qcEffort:'max'}:
    config?.mode==='rehearsal'?{provider:'faux',model:'faux-1'}:null,
  assurance:{modelAuthentication:passed&&config?.mode==='live'?'passed':'not-verified',
    remoteTransport:config?.mode==='live'?'github':config?.mode==='rehearsal'?'simulated-local-bare-git':'not-tested',
    browser:checks.hostedPlugin==='passed'?'actual-pi-web-public-peer':'not-tested',
    faultInjection:config?.mode==='ui'?'not-tested':'test-owned-public-host-exec-wrapper',
    tls:'not-tested-loopback-only',qcRework:'not-tested',productionSafetyGuaranteed:false},
  runCount:boundInt(facts.runCount),modelRequests:boundInt(facts.modelRequests),toolCalls:boundInt(facts.toolCalls),
  publication:facts.publication?{repository:REPOSITORY,
    base:validTrialPrefix(facts.prefix??'')?facts.prefix+'-base':null,
    head:validTrialPrefix(facts.prefix??'')?facts.prefix+'-final':null,
    headSha:safeSha(facts.publication.headSha),mergeSha:safeSha(facts.publication.mergeSha),
    prNumber:boundInt(facts.publication.prNumber),pushCalls:boundInt(facts.publication.pushCalls),
    mergeCalls:boundInt(facts.publication.mergeCalls),mainUnchanged:facts.publication.mainUnchanged===true}:null,
  trial:facts.trial&&validTrialPrefix(facts.prefix??'')?{repository:REPOSITORY,base:facts.prefix+'-base',head:facts.prefix+'-final',seedSha:safeSha(facts.trial.seedSha)}:null,
  cleanup:facts.cleanup==='removed'?'removed':'retained',remoteRefsRetained:facts.remoteCreated===true||facts.remoteMutationAttempted===true,
  productionSafetyGuaranteed:false};
}
