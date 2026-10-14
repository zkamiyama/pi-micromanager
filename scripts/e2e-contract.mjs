/** Test-only admission and receipt helpers. No SDK import or credential lookup. */
import {readFileSync,realpathSync,openSync,writeFileSync,closeSync,lstatSync,constants} from 'node:fs';
import {dirname,isAbsolute,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export const REPO_ROOT=fileURLToPath(new URL('../',import.meta.url));
export const COMPONENTS=Object.freeze(['@earendil-works/pi-ai','@earendil-works/pi-durable',
  '@earendil-works/pi-coding-agent','@earendil-works/chord','@jmfederico/pi-web']);
const CODES=new Set(['ok','invalid-arguments','approval-required','test-identity-required',
  'credential-required','source-unproved','sha-mismatch','dirty-checkout','version-mismatch',
  'unsupported-node','unsupported-provider','model-unavailable','runtime-failed',
  'request-budget','duplicate-report','missing-report','input-not-completed','replay-detected',
  'timed-out','interrupted','shutdown-unproved','receipt-refused']);
export class E2EFailure extends Error {
  constructor(code){super(CODES.has(code)?code:'runtime-failed');this.code=this.message;}
}
const fail=code=>{throw new E2EFailure(code);};
const text=(s,max,pattern)=>typeof s==='string'&&s.length<=max&&pattern.test(s);
const providerPattern=/^[a-z0-9][a-z0-9._-]*$/;
const modelPattern=/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

export function parseE2EArguments(args){
  const fields=new Map(),flags=new Set(['--approve-billed-test','--test-identity-only']);
  const valued=new Set(['--mode','--provider','--model','--expected-sha','--receipt','--scenario','--timeout-ms']);
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(fields.has(key)||(!flags.has(key)&&!valued.has(key)))fail('invalid-arguments');
    if(flags.has(key)){fields.set(key,true);continue;}
    const value=args[++i];
    if(typeof value!=='string'||!value||value.startsWith('--')||value.includes('\0'))fail('invalid-arguments');
    fields.set(key,value);
  }
  const mode=fields.get('--mode');
  if(mode!=='faux'&&mode!=='authenticated')fail('invalid-arguments');
  const provider=fields.get('--provider')??(mode==='faux'?'faux':undefined);
  const model=fields.get('--model')??(mode==='faux'?'faux-1':undefined);
  if(!text(provider,64,providerPattern)||!text(model,160,modelPattern)||model.includes('..'))fail('invalid-arguments');
  if(mode==='faux'&&(provider!=='faux'||model!=='faux-1'))fail('invalid-arguments');
  // Initial authenticated support is deliberately finite. No arbitrary endpoint,
  // custom models.json, cloud credential discovery or default model fallback.
  if(mode==='authenticated'&&!['openai','anthropic'].includes(provider))fail('unsupported-provider');
  const scenario=fields.get('--scenario')??'success';
  if(!['success','provider-error','missing-report','duplicate-report','request-budget','slow'].includes(scenario)||
    mode==='authenticated'&&scenario!=='success')fail('invalid-arguments');
  const rawTimeout=fields.get('--timeout-ms')??'60000';
  const timeoutMs=Number(rawTimeout);
  if(!/^\d+$/.test(rawTimeout)||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>60000||
    mode==='authenticated'&&timeoutMs<1000)fail('invalid-arguments');
  const expectedSha=fields.get('--expected-sha');
  if(expectedSha!==undefined&&!/^[a-f0-9]{40}$/.test(expectedSha))fail('invalid-arguments');
  const receipt=fields.get('--receipt');
  if(receipt!==undefined&&(!isAbsolute(receipt)||resolve(receipt)!==receipt||receipt.length>1024))fail('receipt-refused');
  if(mode==='authenticated'){
    if(fields.get('--approve-billed-test')!==true)fail('approval-required');
    if(fields.get('--test-identity-only')!==true)fail('test-identity-required');
    if(!expectedSha)fail('source-unproved');
  }
  return Object.freeze({mode,provider,model,scenario,timeoutMs,expectedSha,receipt});
}

export function sourceEvidence(root=REPO_ROOT){
  const env={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'core.fsmonitor',GIT_CONFIG_VALUE_0:'false',
    GIT_CONFIG_KEY_1:'core.hooksPath',GIT_CONFIG_VALUE_1:'/dev/null'};
  const git=args=>spawnSync('/usr/bin/git',['-C',root,...args],{env,encoding:'utf8',timeout:10000,maxBuffer:1048576});
  const ref=git(['rev-parse','HEAD']),status=git(['status','--porcelain','--untracked-files=normal']);
  if(ref.status!==0||status.status!==0||ref.error||status.error||!(/^[a-f0-9]{40}\s*$/.test(ref.stdout)))fail('source-unproved');
  const bytes=readFileSync(join(root,'package-lock.json')),lock=JSON.parse(bytes.toString('utf8'));
  const versions={};
  for(const name of COMPONENTS){
    const locked=lock.packages?.['node_modules/'+name]?.version;
    const installed=JSON.parse(readFileSync(join(root,'node_modules',name,'package.json'),'utf8')).version;
    if(typeof installed!=='string'||!/^[0-9][a-zA-Z0-9.+-]{0,79}$/.test(installed)||installed!==locked)fail('version-mismatch');
    versions[name]=installed;
  }
  return Object.freeze({commit:ref.stdout.trim(),workingTreeClean:status.stdout==='',
    lockSha256:createHash('sha256').update(bytes).digest('hex'),versions:Object.freeze(versions),
    node:process.versions.node,platform:process.platform,arch:process.arch});
}

export function authorizeE2E(config,source,apiKey){
  if(![22,24].includes(Number(process.versions.node.split('.')[0])))fail('unsupported-node');
  if(config.expectedSha&&config.expectedSha!==source.commit)fail('sha-mismatch');
  if(config.mode==='authenticated'){
    if(!source.workingTreeClean)fail('dirty-checkout');
    if(typeof apiKey!=='string'||apiKey.length<8||apiKey.length>8192||/[\r\n\0]/.test(apiKey))fail('credential-required');
  }
}

/** Run in a standalone test process only. Never call in the production daemon.
 * Drop all ambient provider/Git/cloud/proxy/config variables; SDK auth is an
 * explicit in-memory test key and modelsPath:null, never the user's profile. */
export function isolateTestEnvironment(directory){
  for(const key of Object.keys(process.env))delete process.env[key];
  Object.assign(process.env,{PATH:'/usr/bin:/bin',HOME:directory,TMPDIR:directory,LANG:'C.UTF-8'});
}

/** Allowlisted projection only: neither exceptions nor raw model output enter it. */
export function e2eReceipt(config,source,result){
  const status=['passed','failed','blocked'].includes(result.status)?result.status:'failed';
  const code=CODES.has(result.code)?result.code:'runtime-failed';
  const passed=status==='passed';
  const count=Number.isSafeInteger(result.requests)&&result.requests>=0&&result.requests<=4?result.requests:0;
  return {schemaVersion:1,suite:'pi-durable-model-sdk',mode:config?.mode??'unselected',status,code,
    source:source??null,selection:config?{provider:config.provider,model:config.model}:null,
    checks:{typedReport:passed?'passed':'not-proved',committedInput:passed?'passed':'not-proved',
      durableReopenNoReplay:passed?'passed':'not-proved',
      authentication:config?.mode==='authenticated'&&passed?'passed':'not-verified',
      osIsolation:'not-tested-by-this-suite',hostedPiWebBrowser:'not-tested',remotePublication:'not-tested'},
    requests:count,maxRequests:4,maxOutputTokensPerRequest:256,
    cleanup:result.cleanup==='removed'?'removed':result.cleanup==='not-created'?'not-created':'retained',
    productionSafetyGuaranteed:false};
}

export function assertReceiptDestination(path){
  if(!path)return;
  try{
    if(!isAbsolute(path)||resolve(path)!==path||realpathSync(dirname(path))!==dirname(path))fail('receipt-refused');
    try{lstatSync(path);fail('receipt-refused');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }catch{fail('receipt-refused');}
}
export function writeReceipt(path,receipt){
  if(!path)return;
  assertReceiptDestination(path);
  const raw=JSON.stringify(receipt,null,2)+'\n';
  if(Buffer.byteLength(raw)>16384)fail('receipt-refused');
  let fd;
  try{
    fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    writeFileSync(fd,raw);
  }catch{fail('receipt-refused');}
  finally{if(fd!==undefined)closeSync(fd);}
}
