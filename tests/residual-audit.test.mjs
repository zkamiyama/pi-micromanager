import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {newWorkflow,applyAction} from '../dist/core/workflow.js';
import {internalRunId,diagnosisTaskId,synthesisTaskId,sessionDisplayName,managedBranch} from '../dist/core/identifiers.js';
import {AutopilotLedger,parseAutopilotConfig,StaleControlError} from '../dist/automation/ledger.js';
import {WorkflowStore} from '../dist/core/store.js';
import {AgentRegistry} from '../dist/runtime/registry.js';
import {AutopilotEngine,buildJobPrompt,workspaceFor} from '../dist/automation/engine.js';
import {validateExecutionPlan} from '../dist/automation/admission.js';
import {linearizeImplementationDag} from '../dist/automation/dag-linearization.js';
import {QuickLaunchLedger} from '../dist/automation/quick-launch.js';
import {requireCleanGit} from '../dist/automation/git.js';
import {testInvocation} from '../dist/automation/test-execution.js';
import {parseRuntimeControl,CONTROL_CHANNEL,RECEIPT_CHANNEL} from '../dist/runtime/protocol.js';
import companion from '../dist/runtime/companion.js';
import {buildJournal} from '../dist/automation/journal.js';
const SHA='a'.repeat(40),at='2026-10-14T00:00:00.000Z';
const models=Object.fromEntries(['implementer','qc','planner','architect'].map(s=>[s,{provider:'faux',model:'faux-1'}]));
const task=(id,dependsOn=[])=>({id,title:id,kind:'implementation',role:'implementer',dependsOn});
const definition=(tasks=[task('api')])=>({id:'audit',title:'Residual audit',maxQcRounds:1,
 maxParallelByRole:{implementer:2,reviewer:2,planner:1,architect:1},tasks});
const rawConfig={runtime:'pi-web',models,workspaces:{api:'wt-api'},test:{file:'node',args:['--test'],timeoutMs:10000,execution:'trusted-host'},maxAttempts:5};
const temp=()=>mkdtempSync(join(tmpdir(),'mm-residual-test-'));
function passed(w,id='api'){
 for(const a of [{type:'start',taskId:id},{type:'implementation_finished',taskId:id,headSha:SHA,criteriaRevision:0,testsPassed:true},
  {type:'qc_finalized',taskId:id,runId:internalRunId('qc',id,1),headSha:SHA,criteriaRevision:0,attempt:1,verdict:'pass'}])w=applyAction(w,a,at);
 return w;
}
function git(root,...args){return execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
const gitHost={lifetimeSignal:new AbortController().signal,async execFile({file,args,cwd,unsetEnv}){
 const env={...process.env};for(const key of unsetEnv??[])delete env[key];
 const p=spawnSync(file,args,{cwd,env,encoding:'utf8',timeout:10000});
 return {exitCode:p.status,signal:p.signal,stdout:p.stdout??'',stderr:p.stderr??'',stdoutTruncated:false,stderrTruncated:false};
}};
function repository(){const root=temp();git(root,'init','-b','main');git(root,'config','user.name','Audit');git(root,'config','user.email','audit@example.invalid');
 writeFileSync(join(root,'source.txt'),'reviewed');git(root,'add','.');git(root,'commit','-m','initial');return root;}
test('R01: local integrate cannot complete the final Task; exact remote proof does',()=>{
 let w=passed(newWorkflow(definition(),at));w=applyAction(w,{type:'prepare_final_integration'},at);w=passed(w,'mm-final-integration');
 assert.throws(()=>applyAction(w,{type:'integrate',taskId:'mm-final-integration'},at),/GitHub MERGED/);
 w=applyAction(w,{type:'final_merge_confirmed',taskId:'mm-final-integration',headSha:SHA,prUrl:'https://github.com/example/repo/pull/1'},at);
 assert.equal(w.tasks.api.status,'integrated');assert.equal(w.tasks['mm-final-integration'].status,'integrated');
});
test('R02: stale progress and stale provisioned configuration never undo operator Pause',()=>{
 const root=temp(),ledger=new AutopilotLedger(join(root,'a.sqlite'));
 try{ledger.save('p','o','audit',rawConfig);ledger.setStatus('p','o','audit',true,'running');const old=ledger.get('p','o','audit');
 ledger.setStatus('p','o','audit',false,'operator Pause');assert.equal(ledger.setProgress(old,true,'waiting for checks'),false);
 assert.throws(()=>ledger.save('p','o','audit',{...rawConfig,maxAttempts:2},old.generation),StaleControlError);
 assert.throws(()=>ledger.assertCurrent(old),StaleControlError);assert.equal(ledger.get('p','o','audit').enabled,false);
 assert.equal(ledger.get('p','o','audit').status,'operator Pause');
 }finally{ledger.close();rmSync(root,{recursive:true,force:true});}
});
test('R02: Pause during awaited publisher result wins over the old scheduler flight',async()=>{
 const root=temp(),store=new WorkflowStore(join(root,'w.sqlite')),agents=new AgentRegistry(join(root,'r.sqlite')),ledger=new AutopilotLedger(join(root,'a.sqlite'));
 let release,entered;const started=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
 const engine=new AutopilotEngine(store,agents,ledger,{launch:async()=>{throw Error('no launch')},verify:async()=>{throw Error('no verify')},publish:async()=>{entered();await pending;return 'checks_pending';}});
 try{store.create('p','o',definition());let w=store.get('p','o','audit');
 for(const a of [{type:'start',taskId:'api'},{type:'implementation_finished',taskId:'api',headSha:SHA,criteriaRevision:0,testsPassed:true},{type:'qc_finalized',taskId:'api',runId:'qc-api-1',headSha:SHA,criteriaRevision:0,attempt:1,verdict:'pass'}])w=store.act('p','o','audit',w.revision,randomUUID(),a);
 ledger.save('p','o','audit',{...rawConfig,publication:{remote:'origin',baseBranch:'main',draft:true}});ledger.setStatus('p','o','audit',true,'running');
 const flight=engine.tick(ledger.get('p','o','audit'));await started;ledger.setStatus('p','o','audit',false,'Pause wins');release();await flight;
 assert.equal(ledger.get('p','o','audit').enabled,false);assert.equal(ledger.get('p','o','audit').status,'Pause wins');
 }finally{release?.();await engine.stop();store.close();agents.close();ledger.close();rmSync(root,{recursive:true,force:true});}
});
test('R03: durable host leases exclude writers and read leases across Workspace aliases',()=>{
 const root=temp(),path=join(root,'a.sqlite');let agents=new AgentRegistry(path);
 const r={projectId:'p',orchestraWorkspaceId:'o',workflowId:'audit',taskId:'api',runId:'impl-api-1',workspaceId:'one',seat:'implementer',requestId:'auto:one'};
 try{agents.registerWorkspacePath('p','one',root);agents.registerWorkspacePath('p','alias',root);agents.acquireWorkspaceOperation('p','one','integration-owner');
 assert.throws(()=>agents.reserve({...r,workspaceId:'alias'}),/host Git operation/);
 agents.close();agents=new AgentRegistry(path);assert.throws(()=>agents.reserve(r),/host Git operation/);
 agents.acquireWorkspaceOperation('p','one','integration-owner');agents.releaseWorkspaceOperation('p','one','wrong-owner');assert.throws(()=>agents.reserve(r),/host Git operation/);
 agents.releaseWorkspaceOperation('p','one','integration-owner');agents.reserve(r);
 assert.throws(()=>agents.acquireWorkspaceOperation('p','alias','other'),/active or unsealed/);
 assert.throws(()=>agents.reserve({...r,workspaceId:'alias',runId:'qc-api-1',requestId:'auto:qc',seat:'qc'}),/leased/);
 }finally{agents.close();rmSync(root,{recursive:true,force:true});}
});
for(const flag of ['--assume-unchanged','--skip-worktree'])test('R04 real Git: reject hidden changed index bytes '+flag,async()=>{
 const root=repository();try{const sha=git(root,'rev-parse','HEAD');git(root,'update-index',flag,'source.txt');writeFileSync(join(root,'source.txt'),'unreviewed');
 assert.equal(git(root,'status','--porcelain'),'');assert.equal(git(root,'rev-parse','HEAD'),sha);
 await assert.rejects(()=>requireCleanGit(gitHost,root),/index contains/);
 assert.equal(git(root,'show','HEAD:source.txt'),'reviewed');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('R04 real Git: explicitly enumerate untracked files despite local status configuration',async()=>{
 const root=repository();try{git(root,'config','status.showUntrackedFiles','no');writeFileSync(join(root,'untracked-input.txt'),'not in commit');assert.equal(git(root,'status','--porcelain'),'');
 await assert.rejects(()=>requireCleanGit(gitHost,root),/uncommitted\/untracked/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('R06: new test configuration defaults to sandbox and trusted-host is explicit',()=>{
 const config={...rawConfig,test:{file:'node',args:['--test']}};assert.equal(parseAutopilotConfig(config).test.execution,'sandbox');
 assert.equal(parseAutopilotConfig(rawConfig).test.execution,'trusted-host');
 assert.throws(()=>parseAutopilotConfig({...config,test:{...config.test,execution:'typo'}}),/execution/);
});
test('R06 real Bubblewrap: no host-only file, inherited dummy secret, or host loopback interfaces',t=>{
 if(process.platform!=='linux'||!existsSync('/usr/bin/bwrap'))return t.skip('Bubblewrap unavailable on this OS; no fallback is used by production');
 const root=temp(),workspace=join(root,'repo');mkdirSync(workspace);const outside=join(root,'host-only.txt');writeFileSync(outside,'DUMMY-NOT-A-REAL-SECRET');
 try{const code=`const fs=require('fs'),os=require('os');if(process.env.AUDIT_DUMMY_SECRET)throw Error('environment leaked');if(fs.existsSync(${JSON.stringify(outside)}))throw Error('host file leaked');if(Object.keys(os.networkInterfaces()).some(k=>k!=='lo'))throw Error('host network interfaces leaked');fs.writeFileSync('/workspace/result.txt','sandbox-pass');`;
 const invocation=testInvocation({file:process.execPath,args:['-e',code],execution:'sandbox',timeoutMs:10000},workspace);
 const p=spawnSync(invocation.file,invocation.args,{cwd:invocation.cwd,encoding:'utf8',timeout:10000,env:{...process.env,AUDIT_DUMMY_SECRET:'INERT'}});
 assert.equal(p.status,0,p.stderr);assert.equal(existsSync(join(workspace,'result.txt')),true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
function native(){const handlers={},controls={},tools={},entries=[],receipts=[],sent=[];let idle=true,thinking='off';
 const context={isIdle:()=>idle,hasPendingMessages:()=>false,model:{provider:'faux',id:'faux-1'},modelRegistry:{find:()=>({provider:'faux',id:'faux-1'})},sessionManager:{getEntries:()=>entries}};
 companion({on:(name,f)=>handlers[name]=f,registerTool:t=>tools[t.name]=t,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),
 events:{on:(name,f)=>controls[name]=f,emit:(name,value)=>{if(name===RECEIPT_CHANNEL)receipts.push(value)}},setModel:async()=>true,
 getThinkingLevel:()=>thinking,setThinkingLevel:x=>thinking=x,getActiveTools:()=>['read',...Object.keys(tools)],setActiveTools:()=>{},setSessionName:()=>{},
 sendUserMessage:(text)=>{sent.push(text);idle=false;handlers.agent_start({});}});
 handlers.session_start({},context);
 async function control(value){const cmd={...value,requestId:randomUUID()};controls[CONTROL_CHANNEL](cmd);for(let i=0;i<100;i++){const x=receipts.find(r=>r.requestId===cmd.requestId);if(x)return x;await new Promise(r=>setTimeout(r,1));}throw Error('no native receipt');}
 return {tools,entries,control,sent};
}
test('R05 native companion: no live message before bound initial admission',async()=>{
 const n=native();assert.equal((await n.control({type:'message',delivery:'followUp',text:'not admitted'})).status,'failed');
 await n.control({type:'configure',provider:'faux',model:'faux-1',job:{kind:'implementation',runId:'impl-api-1'}});
 assert.equal((await n.control({type:'message',delivery:'followUp',text:'still idle'})).status,'failed');assert.equal(n.sent.length,0);
 assert.equal((await n.control({type:'inspect'})).inputAccepted,false);
 assert.equal((await n.control({type:'message',delivery:'newTurn',text:'approved initial'})).status,'ok');
 assert.equal((await n.control({type:'message',delivery:'followUp',text:'authorized live'})).status,'ok');assert.equal(n.sent.length,2);
 assert.equal((await n.control({type:'inspect'})).inputAccepted,true);
});
for(const kind of ['qc','diagnosis','planning'])test('R20 native '+kind+': invalid report does not consume submission',async()=>{
 const n=native();await n.control({type:'configure',provider:'faux',model:'faux-1',job:{kind,runId:'task-test-1'}});
 const tool=n.tools[kind==='qc'?'mm_qc_report':kind==='planning'?'mm_plan_intervention':'mm_task_report'];
 const valid={summary:'Verified findings',...(kind==='qc'?{verdict:'pass'}:{}),...(kind==='planning'?{agents:[{id:'r',title:'Review',role:'reviewer',model:'faux/faux-1'}]}:{})};
 await assert.rejects(()=>tool.execute('call-bad',{...valid,summary:'   '}),/Invalid structured report/);
 if(kind==='planning')await assert.rejects(()=>tool.execute('bad-id',{...valid,agents:[{...valid.agents[0],id:'bad space'}]}),/Invalid structured/);
 assert.equal(n.entries.filter(e=>e.customType==='pi-micromanager:report:v1').length,0);
 await tool.execute('call-good',valid);assert.equal(n.entries.filter(e=>e.customType==='pi-micromanager:report:v1').length,1);
});
test('R08/R09/R10: all admitted ID lengths compose valid stable wire and Git identities',()=>{
 const root=repository();try{for(let n=1;n<=64;n++){
 const id='a'.repeat(n),run=internalRunId('impl',id,10),session=sessionDisplayName('AUTO','implementer',id,run);
 assert.ok(session.length<=120);assert.ok(parseRuntimeControl({type:'configure',requestId:'safe',provider:'faux',model:'faux-1',sessionName:session,job:{runId:run,kind:'implementation'}}));
 assert.match(diagnosisTaskId(id,'r'.repeat(32)),/^[a-z][a-z0-9-]{0,63}$/);assert.match(synthesisTaskId(id),/^[a-z][a-z0-9-]{0,63}$/);
 const branch=managedBranch('a'.repeat(16),id,id);assert.ok(branch.length<=119);git(root,'check-ref-format','--branch',branch);
 }assert.equal(diagnosisTaskId('stop','r'),'diag-stop-r');assert.equal(synthesisTaskId('stop'),'synthesis-stop');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('R09/R12: maximal intervention and full human contract survive diagnosis and synthesis',()=>{
 const id='i'.repeat(64),agentId='r'.repeat(32);let w=newWorkflow(definition(),at);
 w=applyAction(w,{type:'request_intervention',interventionId:id,targetTaskId:'api',afterQcRunId:'next',instruction:'Check cancellation exactly; preserve every condition.'},at);
 w=applyAction(w,{type:'plan_intervention',interventionId:id,rationale:'Compare both event orderings.',agents:[{id:agentId,title:'Independent reviewer',role:'reviewer',model:'faux/faux-1'}]},at);
 w=passed(w);const diagnostic=w.tasks[diagnosisTaskId(id,agentId)];assert.ok(diagnostic);
 for(const [taskId,kind] of [[diagnostic.spec.id,'diagnosis'],[synthesisTaskId(id),'synthesis']]){
 const prompt=buildJobPrompt(w,w.tasks[taskId],kind);assert.match(prompt,/Check cancellation exactly; preserve every condition\./);assert.match(prompt,/Compare both event orderings\./);
 }
});
test('R11: final QC diagnosis resolves the dedicated integration Workspace',()=>{
 const diagnostic={spec:{kind:'diagnosis'},parentTaskId:'mm-final-integration'};
 assert.equal(workspaceFor(diagnostic,'diagnosis',{...rawConfig,finalization:{workspaceId:'wt-final',autoMerge:true}},'orchestra'),'wt-final');
});
test('R13: QC exhausted state has audited bounded recovery, never forced PASS',()=>{
 let w=newWorkflow(definition(),at);w=applyAction(w,{type:'start',taskId:'api'},at);w=applyAction(w,{type:'implementation_finished',taskId:'api',headSha:SHA,criteriaRevision:0,testsPassed:true},at);
 w=applyAction(w,{type:'qc_finalized',taskId:'api',runId:'qc-api-1',headSha:SHA,criteriaRevision:0,attempt:1,verdict:'fail'},at);assert.equal(w.tasks.api.status,'needs_human');
 assert.throws(()=>applyAction(w,{type:'extend_qc_budget',taskId:'api',maxRounds:1,reason:'no increase'},at),/increase/);
 const rework=applyAction(w,{type:'extend_qc_budget',taskId:'api',maxRounds:3,reason:'Reviewed failing test and authorized two more rounds'},at);
 assert.equal(rework.tasks.api.status,'ready');assert.equal(rework.tasks.api.qcBudget,3);assert.equal(rework.tasks.api.lastQc.verdict,'fail');assert.match(rework.events.at(-1).message,/Reviewed failing test/);
 const held=applyAction(w,{type:'request_intervention',interventionId:'inspect',targetTaskId:'api',afterQcRunId:'next',instruction:'Inspect the exhausted evidence'},at);
 assert.equal(held.tasks.api.status,'held');assert.equal(held.amendments[0].afterQcRunId,'qc-api-1');
});
test('R14: original input is durable and immutable across control generations',()=>{
 const root=temp(),ledger=new AutopilotLedger(join(root,'a.sqlite'));
 const job={projectId:'p',orchestraWorkspaceId:'o',workflowId:'audit',taskId:'api',workspaceId:'wt-api',runId:'impl-api-1',seat:'implementer',kind:'implementation',model:models.implementer,prompt:'Exact initial instructions',controlGeneration:1};
 try{ledger.recordLaunch(job);ledger.recordLaunch({...job,controlGeneration:20});assert.equal(ledger.launchFor(job).prompt,job.prompt);
 assert.throws(()=>ledger.recordLaunch({...job,prompt:'changed'}),/changed after reservation/);assert.throws(()=>ledger.launchFor({...job,runId:'legacy'}),/No frozen/);
 }finally{ledger.close();rmSync(root,{recursive:true,force:true});}
});
test('R15/R16: validate combined final contract and capacity before execution',()=>{
 const large=definition(['a','b'].map(id=>({...task(id),description:'x'.repeat(4000),acceptanceCriteria:Array(20).fill('z'.repeat(500))})));
 const finalConfig={...rawConfig,workspaces:{a:'wt-a',b:'wt-b'},publication:{remote:'origin',baseBranch:'main',draft:true},finalization:{workspaceId:'wt-final',autoMerge:false}};
 assert.throws(()=>validateExecutionPlan(newWorkflow(large,at),finalConfig),/prompt length/);
 assert.doesNotThrow(()=>validateExecutionPlan(newWorkflow(large,at),{...finalConfig,runtime:'durable'}));
 for(const n of [65,101]){const w=newWorkflow(definition(Array.from({length:n},(_,i)=>task('t-'+i))),at);assert.throws(()=>validateExecutionPlan(w,{...finalConfig,runtime:'durable'}),/source Tasks|100 original/);}
 const accepted=newWorkflow(definition(Array.from({length:64},(_,i)=>task('t-'+i))),at);assert.doesNotThrow(()=>validateExecutionPlan(accepted,{...finalConfig,runtime:'durable'}));
});
test('R17/R18: every active quick goal is scheduled and paused goals resume',()=>{
 const root=temp(),q=new QuickLaunchLedger(join(root,'q.sqlite'));
 const profile={config:{...rawConfig,managedWorktrees:true,workspaces:{},finalization:{workspaceId:'auto',autoMerge:false},publication:{remote:'origin',baseBranch:'main',draft:true}},permissions:{default:'ask'}};
 try{for(let i=0;i<105;i++){q.saveProfile('p','o-'+i,profile);const id=randomUUID();q.begin('p','o-'+i,'Develop test '+i,id);q.phase('p','o-'+i,id,'running','Started');}
 assert.equal(q.pending().length,105);const last=q.pending().at(-1);q.phase(last.projectId,last.orchestraWorkspaceId,last.requestId,'paused','Operator Pause');assert.equal(q.pending().length,105);
 q.phase(last.projectId,last.orchestraWorkspaceId,last.requestId,'running','Resumed');q.phase(last.projectId,last.orchestraWorkspaceId,last.requestId,'finished','Confirmed');assert.equal(q.pending().length,104);
 }finally{q.close();rmSync(root,{recursive:true,force:true});}
});
test('R19: old Workflow Journal survives 205 newer unrelated Runs',()=>{
 const root=temp(),agents=new AgentRegistry(join(root,'a.sqlite'));
 try{const r={projectId:'p',orchestraWorkspaceId:'o',workflowId:'audit',taskId:'api',runId:'plan-older',workspaceId:'orchestra',seat:'planner',requestId:'auto:old'};agents.reserve(r,'2020-01-01T00:00:00Z');
 for(let i=0;i<205;i++)agents.reserve({...r,workflowId:'other',runId:'plan-'+i,requestId:'auto:'+i},'2026-01-01T00:00:00Z');
 assert.equal(agents.list('p','o','all').some(b=>b.workflowId==='audit'),false);const journal=buildJournal(newWorkflow(definition(),at),agents.listWorkflow('p','o','audit'),{evidence:()=>undefined});assert.equal(journal.runs.length,1);
 }finally{agents.close();rmSync(root,{recursive:true,force:true});}
});
test('R21: independent fan-in is rejected at admission; explicit linearization is executable',()=>{
 const def=definition([task('a'),task('b'),task('c',[{taskId:'a',gate:'qc_passed'},{taskId:'b',gate:'qc_passed'}])]);
 assert.throws(()=>validateExecutionPlan(newWorkflow(def,at),rawConfig),/Independent fan-in/);
 const normalized=linearizeImplementationDag(def);assert.doesNotThrow(()=>validateExecutionPlan(newWorkflow(normalized,at),rawConfig));
});

test('R15: retrieved final-QC contract receipts survive ledger reopen and cannot authorize a changed manifest',()=>{
 const root=temp(),path=join(root,'a.sqlite');let ledger=new AutopilotLedger(path);
 const b={projectId:'p',orchestraWorkspaceId:'o',workflowId:'audit',runId:'qc-final-1',sessionId:'durable:final'},digest='a'.repeat(64);
 try{ledger.recordContractRead(b,digest,0);ledger.recordContractRead(b,digest,1);ledger.close();ledger=new AutopilotLedger(path);
  assert.deepEqual(ledger.contractReads(b,digest),[0,1]);assert.deepEqual(ledger.contractReads(b,'b'.repeat(64)),[]);
  assert.throws(()=>ledger.recordContractRead(b,digest,64),/index/);
 }finally{ledger.close();rmSync(root,{recursive:true,force:true});}
});
