#!/usr/bin/env node
/** Credential-free acceptance gate. An unfinished, missing, skipped, cancelled,
 * or failing suite is a failure, never an accepted local-owner capability. */
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceEvidence,REPO_ROOT} from './e2e-contract.mjs';

export const SUITES=Object.freeze({
 contracts:{minimum:32,files:['tests/ui-locale.test.mjs','tests/local-maintenance.test.mjs','tests/local-owner-profile.test.mjs','tests/local-artifact-acceptance.test.mjs','tests/local-journal-peer.test.mjs']},
 lifecycle:{minimum:17,files:['tests/local-owner-retirement-safety.required.mjs','tests/local-owner-lifecycle.required.mjs','tests/local-owner-faults.required.mjs']},
 browser:{minimum:7,files:['tests/local-owner-browser.required.mjs']},
});
export function evaluateTap(tap,exitCode,minimum){
 const value=name=>{
  const matches=[...tap.matchAll(new RegExp('^# '+name+' ([0-9]+)\\r?$','gm'))];
  return matches.length===1?Number(matches[0][1]):null;
 };
 const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>[k,value(k)]));
 const failures=[...tap.matchAll(/^not ok [0-9]+ - (.+)$/gm)].map(m=>m[1].slice(0,200));
 const complete=Object.values(counts).every(n=>Number.isSafeInteger(n)&&n>=0);
 const passed=exitCode===0&&complete&&counts.tests>=minimum&&counts.pass===counts.tests&&
  counts.fail===0&&counts.cancelled===0&&counts.skipped===0&&counts.todo===0;
 return {passed,counts,failures};
}
export function runGate(args){
 const selected=args.length===1?args[0]:undefined,definition=Object.hasOwn(SUITES,selected)?SUITES[selected]:undefined;
 if(!definition){console.error('Usage: node scripts/local-owner-ci.mjs contracts|lifecycle|browser');return 2;}
 let source;
 try{source=sourceEvidence();if(!source.workingTreeClean)throw Error('dirty source');}
 catch{console.error('Gate requires a clean, built, lockfile-matched source checkout.');return 2;}
 const root=mkdtempSync(join(tmpdir(),'mm-local-ci-gate-')),home=join(root,'home');mkdirSync(home,{mode:0o700});
 const env={PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:home,TMPDIR:root,LANG:'C.UTF-8',TZ:'UTC',
  MM_REQUIRE_SANDBOX:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
 if(process.env.PLAYWRIGHT_BROWSERS_PATH)env.PLAYWRIGHT_BROWSERS_PATH=process.env.PLAYWRIGHT_BROWSERS_PATH;
 const result=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1',...definition.files],
  {cwd:REPO_ROOT,env,encoding:'utf8',timeout:9*60000,maxBuffer:8*1024*1024});
 const tap=result.stdout??'',assessment=evaluateTap(tap,result.error||result.signal?null:result.status,definition.minimum);
 // Test fixtures have synthetic data only. Never forward actual provider or
 // server transcripts; these are Node's assertion results and bounded stacks.
 process.stdout.write(tap);if(result.stderr)process.stderr.write(result.stderr.slice(0,16384));
 const receipt={schemaVersion:1,suite:'local-owner-ci',selection:selected,status:assessment.passed?'passed':'failed',
  source,files:definition.files,minimum:definition.minimum,exitCode:result.status,
  interrupted:Boolean(result.error||result.signal),...assessment,
  assurance:{model:'faux-only',remotePublication:'not-executed',targetWsl:'not-verified',productionSafetyGuaranteed:false}};
 writeFileSync(join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 console.log('LOCAL_OWNER_CI_RECEIPT '+JSON.stringify(receipt));
 if(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_STEP_SUMMARY){
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,'## Local-owner '+selected+'\n\n'+
   '**'+receipt.status.toUpperCase()+'** at `'+source.commit+'` (Node '+source.node+').\n\n'+
   '```json\n'+JSON.stringify({counts:assessment.counts,failures:assessment.failures,assurance:receipt.assurance},null,2)+'\n```\n');
 }
 return assessment.passed?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=runGate(process.argv.slice(2));
