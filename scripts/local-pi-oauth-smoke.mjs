#!/usr/bin/env node
/** Owner-operated Pi OAuth smoke. No shell/file/model-selected tools, publication,
 * token copying or custom OAuth requests. Only Pi's public SDK owns authentication.
 * The supervising process prints a bounded receipt, never worker diagnostics.
 */
import {fork} from 'node:child_process';
import {mkdtempSync,lstatSync,realpathSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {E2EFailure,sourceEvidence,assertReceiptDestination,writeReceipt,COMPONENTS} from './e2e-contract.mjs';

const SELF=fileURLToPath(import.meta.url);
const failure=code=>{throw new E2EFailure(code);};
const resultCodes=new Set(['ok','invalid-arguments','approval-required','credential-required',
  'source-unproved','sha-mismatch','dirty-checkout','version-mismatch','unsupported-node',
  'model-unavailable','runtime-failed','request-budget','duplicate-report','missing-report',
  'input-not-completed','replay-detected','timed-out','interrupted','shutdown-unproved','receipt-refused']);

export function parseLocalArguments(args){
  const values=new Map(),flags=new Set(['--approve-account-use']);
  const valued=new Set(['--mode','--effort','--expected-sha','--pi-auth-file','--receipt','--timeout-ms','--scenario']);
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(values.has(key)||!flags.has(key)&&!valued.has(key))failure('invalid-arguments');
    if(flags.has(key)){values.set(key,true);continue;}
    const value=args[++i];
    if(typeof value!=='string'||!value||value.startsWith('--')||value.includes('\0'))failure('invalid-arguments');
    values.set(key,value);
  }
  const mode=values.get('--mode'),effort=values.get('--effort')??'low';
  if(!['oauth','faux'].includes(mode)||!['low','max'].includes(effort))failure('invalid-arguments');
  const expectedSha=values.get('--expected-sha');
  if(expectedSha!==undefined&&!/^[a-f0-9]{40}$/.test(expectedSha))failure('invalid-arguments');
  if(mode==='oauth'){
    if(values.get('--approve-account-use')!==true)failure('approval-required');
    if(!expectedSha)failure('source-unproved');
  }
  const raw=values.get('--timeout-ms')??(effort==='max'?'120000':'60000');
  const timeoutMs=Number(raw);
  if(!/^\d+$/.test(raw)||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)
    failure('invalid-arguments');
  const scenario=values.get('--scenario')??'success';
  if(!['success','provider-error','missing-report','duplicate-report','request-budget','slow'].includes(scenario)||
    mode==='oauth'&&scenario!=='success')failure('invalid-arguments');
  const authFile=values.get('--pi-auth-file'),receipt=values.get('--receipt');
  for(const path of [authFile,receipt]){
    if(path!==undefined&&(!isAbsolute(path)||resolve(path)!==path||path.length>1024))failure('invalid-arguments');
  }
  if(mode==='faux'&&authFile!==undefined)failure('invalid-arguments');
  return Object.freeze({mode,effort,expectedSha,authFile,receipt,timeoutMs,scenario,
    maxOutputTokens:effort==='max'?4096:1024});
}

/** Metadata only. Credential contents remain inside the SDK process. */
export function validateAuthFile(path){
  try{
    const stat=lstatSync(path),parent=lstatSync(dirname(path));
    if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path||
      !stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0||
      stat.uid!==process.getuid()||!parent.isDirectory()||(parent.mode&0o022)!==0)
      failure('credential-required');
    return path;
  }catch{failure('credential-required');}
}

/** Project known fields explicitly; provider exceptions/paths never enter a receipt. */
export function localReceipt(config,source,result){
  const passed=result.status==='passed'&&result.code==='ok'&&result.joined===true&&result.cleanup==='removed'&&
    Number.isInteger(result.requests)&&result.requests>0&&result.requests<=4;
  const status=passed?'passed':result.status==='blocked'?'blocked':'failed';
  const code=passed?'ok':resultCodes.has(result.code)&&result.code!=='ok'?result.code:'runtime-failed';
  let safeSource=null;
  if(source&&/^[a-f0-9]{40}$/.test(source.commit)&&/^[a-f0-9]{64}$/.test(source.lockSha256)){
    safeSource={commit:source.commit,workingTreeClean:source.workingTreeClean===true,
      lockSha256:source.lockSha256,node:/^[\d.]+$/.test(source.node)?source.node:'unknown',
      versions:Object.fromEntries(COMPONENTS.map(name=>[name,
        /^[0-9][a-zA-Z0-9.+-]{0,79}$/.test(source.versions?.[name]??'')?source.versions[name]:'unknown']))};
  }
  return {schemaVersion:1,suite:'local-pi-oauth-smoke',status,code,
    mode:['oauth','faux'].includes(config?.mode)?config.mode:'unselected',source:safeSource,
    selection:config?{provider:config.mode==='oauth'?'openai':'faux',
      model:config.mode==='oauth'?'gpt-6-luna':'faux-1',effort:config.effort}:null,
    requests:Number.isInteger(result.requests)&&result.requests>=0&&result.requests<=4?result.requests:null,
    maxRequests:4,maxOutputTokensPerRequest:config?.maxOutputTokens??1024,
    checks:{typedReport:passed?'passed':'not-proved',committedInput:passed?'passed':'not-proved',
      durableReopenNoReplay:passed?'passed':'not-proved',
      authentication:passed&&config?.mode==='oauth'?'passed':'not-verified',
      qcLoop:'not-tested',hostedPiWebBrowser:'not-tested',remotePublication:'not-tested',
      osIsolation:'not-tested-by-this-suite'},
    cleanup:result.cleanup==='removed'?'removed':result.cleanup==='not-created'?'not-created':'retained',
    productionSafetyGuaranteed:false};
}

/** Single disposable SDK process. No parent environment or raw worker output forwarded. */
export function supervise(config,directory,authFile,launch=fork){
  return new Promise(resolveResult=>{
    let evidence,reason,killTimer,totalMessages=0;
    const child=launch(SELF,['--worker'],{cwd:directory,execArgv:[],
      env:{PATH:'/usr/bin:/bin',HOME:directory,TMPDIR:directory,LANG:'C.UTF-8'},
      stdio:['ignore','ignore','ignore','ipc']});
    const stop=code=>{
      if(reason)return;reason=code;
      child.kill('SIGTERM');
      killTimer=setTimeout(()=>child.kill('SIGKILL'),5000);
    };
    const onInterrupt=()=>stop('interrupted');
    process.once('SIGINT',onInterrupt);process.once('SIGTERM',onInterrupt);
    const timer=setTimeout(()=>stop('timed-out'),config.timeoutMs+10000);
    child.on('error',()=>stop('runtime-failed'));
    child.on('message',message=>{
      if(++totalMessages!==1||!message||typeof message!=='object'||
        !resultCodes.has(message.code)||!['passed','failed'].includes(message.status)||
        typeof message.joined!=='boolean'||!Number.isInteger(message.requests)||
        message.requests<0||message.requests>4){stop('runtime-failed');return;}
      evidence={status:message.status,code:message.code,requests:message.requests,joined:message.joined};
    });
    child.on('close',(code,signal)=>{
      clearTimeout(timer);clearTimeout(killTimer);
      process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onInterrupt);
      if(reason||signal||code!==0||!evidence)
        resolveResult({status:'failed',code:reason??'runtime-failed',requests:evidence?.requests,joined:false});
      else resolveResult(evidence);
    });
    child.send({config,directory,authFile},error=>{if(error)stop('runtime-failed');});
  });
}

async function worker({config,directory,authFile}){
  // The child revalidates the fixed profile before loading any credentials.
  if(!['oauth','faux'].includes(config?.mode)||!['low','max'].includes(config.effort)||
    !Number.isInteger(config.timeoutMs)||config.timeoutMs<100||config.timeoutMs>120000||
    config.maxOutputTokens!==(config.effort==='max'?4096:1024))failure('invalid-arguments');
  const {runSdkSmoke}=await import('./e2e-sdk-smoke.mjs');
  const createAuthenticatedModels=config.mode==='oauth'?async signal=>{
    validateAuthFile(authFile);
    const {ModelRuntime,readStoredCredential}=await import('@earendil-works/pi-coding-agent');
    // Check type only. No file copying, alternate account, custom endpoint or token output.
    if(readStoredCredential('openai',authFile)?.type!=='oauth')failure('credential-required');
    const models=await ModelRuntime.create({authPath:authFile,modelsPath:null,
      allowModelNetwork:false,refreshOnCreate:false,signal});
    const selected=models.getModel('openai','gpt-6-luna');
    if(!selected||selected.thinkingLevelMap?.[config.effort]!==config.effort)failure('model-unavailable');
    // Normal serialized OAuth refresh, if required, is owned by Pi's SDK.
    // No manual token transport, provider spoofing, or alternative credentials.
    return models;
  }:undefined;
  return runSdkSmoke({mode:config.mode==='oauth'?'authenticated':'faux',
    provider:config.mode==='oauth'?'openai':'faux',model:config.mode==='oauth'?'gpt-6-luna':'faux-1',
    effort:config.effort,scenario:config.scenario,timeoutMs:config.timeoutMs,
    maxOutputTokens:config.maxOutputTokens},{directory,createAuthenticatedModels});
}

export async function runLocalCli(args){
  let config,source,directory,result={status:'blocked',code:'invalid-arguments',requests:0,cleanup:'not-created'};
  try{
    config=parseLocalArguments(args);
    if(process.platform!=='linux'||![22,24].includes(Number(process.versions.node.split('.')[0])))
      failure('unsupported-node');
    assertReceiptDestination(config.receipt);
    source=sourceEvidence();
    if(config.expectedSha&&config.expectedSha!==source.commit)failure('sha-mismatch');
    if(config.mode==='oauth'&&!source.workingTreeClean)failure('dirty-checkout');
    const authFile=config.mode==='oauth'?validateAuthFile(config.authFile??join(homedir(),'.pi','agent','auth.json')):undefined;
    directory=mkdtempSync(join(tmpdir(),'mm-local-luna-smoke-'));
    const run=await supervise(config,directory,authFile);
    result={...run,cleanup:'retained'};
    if(run.joined){rmSync(directory,{recursive:true,force:true});directory=undefined;result.cleanup='removed';}
  }catch(error){
    result={status:directory?'failed':'blocked',code:error instanceof E2EFailure?error.code:'runtime-failed',
      requests:directory?result.requests:0,cleanup:directory?'retained':'not-created',joined:false};
  }
  let receipt=localReceipt(config,source,result);
  try{writeReceipt(config?.receipt,receipt);}
  catch{receipt=localReceipt(config,source,{...result,status:'failed',code:'receipt-refused',joined:false});}
  process.stdout.write(JSON.stringify(receipt)+'\n');
  return receipt.status==='passed'?0:receipt.status==='blocked'?2:1;
}

if(process.argv[1]&&resolve(process.argv[1])===SELF){
  if(process.argv.length===3&&process.argv[2]==='--worker'&&process.send){
    process.once('message',async input=>{
      let result;
      try{result=await worker(input);}
      catch(error){result={status:'failed',code:error instanceof E2EFailure?error.code:'runtime-failed',requests:0,joined:false};}
      process.send(result,()=>process.disconnect());
    });
  }else if(process.argv.length===3&&process.argv[2]==='--help'){
    console.log('Local Luna smoke (no GitHub writes, no coding tools).\n'+
      'Real: node scripts/local-pi-oauth-smoke.mjs --mode oauth --effort low --expected-sha <40-hex> --approve-account-use\n'+
      'Optional: --pi-auth-file <absolute-selected-Pi-auth-file> --receipt <new-absolute-file> --effort max\n'+
      'No credentials: --mode faux\nExit: 0 passed; 1 failed; 2 blocked. Only the JSON receipt should be shared.');
  }else process.exitCode=await runLocalCli(process.argv.slice(2));
}
