#!/usr/bin/env node
/** Explicit model-SDK acceptance only, not hosted PI WEB or OS isolation. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {E2EFailure,parseE2EArguments,sourceEvidence,authorizeE2E,
  isolateTestEnvironment,e2eReceipt,writeReceipt,assertReceiptDestination} from './e2e-contract.mjs';

export async function runCli(args,env=process.env){
  let config,source,directory,result={status:'blocked',code:'invalid-arguments',requests:0,cleanup:'not-created'};
  try{
    config=parseE2EArguments(args);
    assertReceiptDestination(config.receipt);
    source=sourceEvidence();
    const apiKey=config.mode==='authenticated'?env.MM_E2E_API_KEY:undefined;
    authorizeE2E(config,source,apiKey);
    directory=mkdtempSync(join(tmpdir(),'mm-e2e-model-'));
    isolateTestEnvironment(directory);
    // SDKs are loaded only AFTER all opt-in/source/identity checks.
    const {runSdkSmoke}=await import('./e2e-sdk-smoke.mjs');
    const run=await runSdkSmoke(config,{directory,apiKey});
    result={...run,cleanup:'retained'};
    if(run.joined){rmSync(directory,{recursive:true,force:true});directory=undefined;result.cleanup='removed';}
  }catch(error){
    result={status:directory?'failed':'blocked',code:error instanceof E2EFailure?error.code:'runtime-failed',
      requests:result.requests,cleanup:directory?'retained':'not-created'};
  }
  let receipt=e2eReceipt(config,source,result);
  try{writeReceipt(config?.receipt,receipt);}
  catch{
    receipt=e2eReceipt(config,source,{...result,status:'failed',code:'receipt-refused'});
  }
  // Fixed-schema facts only; no exception messages, transcripts, paths or auth.
  process.stdout.write(JSON.stringify(receipt)+'\n');
  return receipt.status==='passed'?0:receipt.status==='blocked'?2:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.exitCode=await runCli(process.argv.slice(2));
}
