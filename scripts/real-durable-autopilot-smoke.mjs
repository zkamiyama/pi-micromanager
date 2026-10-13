// Disposable full Micromanager server-plugin Autopilot using Pi Durable OAuth.
// Real Git Worktree, real project tests and real model calls; no GitHub push.
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,execFileSync} from 'node:child_process';
import serverPlugin from '../dist/pi-web/server.js';
const root=mkdtempSync(join(tmpdir(),'mm-autopilot-live-'));
const repo=join(root,'repo'),worker=join(root,'wt-math'),state=join(root,'state');
mkdirSync(join(repo,'src'),{recursive:true});mkdirSync(join(repo,'test'),{recursive:true});mkdirSync(state,{recursive:true});
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
writeFileSync(join(repo,'src','math.mjs'),'export function add(a,b){return a+b;}\n');
writeFileSync(join(repo,'test','math.test.mjs'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from '../src/math.mjs';\ntest('add works',()=>assert.equal(add(1,2),3));\n");
writeFileSync(join(repo,'package.json'),JSON.stringify({name:'mm-live-autopilot',private:true,type:'module',scripts:{test:'node --test'}}));
git(repo,'init','-b','main');git(repo,'config','user.email','smoke@example.invalid');git(repo,'config','user.name','Durable Smoke');git(repo,'add','.');git(repo,'commit','-m','initial');
const baseline=git(repo,'rev-parse','HEAD');git(repo,'worktree','add','-b','feature/math',worker,'main');
const controller=new AbortController();
const sessionCtx={project:{id:'project',name:'Disposable project',path:repo},workspace:{id:'orchestra',projectId:'project',path:repo,isMain:true},signal:new AbortController().signal};
const workspaces={version:1,async resolve({projectId,workspaceId}){
 if(projectId!=='project'||!['orchestra','wt-math'].includes(workspaceId))throw Error('Unknown workspace');
 return {project:{id:'project',name:'Disposable project',path:repo},
 workspace:workspaceId==='orchestra'?sessionCtx.workspace:
 {id:'wt-math',projectId:'project',path:worker,isMain:false,provider:{metadata:{isGitWorktree:true}}}};
}};
const calls=[];
const host={
 apiVersion:3,pluginId:'micromanager',packageRoot:root,dataDirectory:state,
 lifetimeSignal:controller.signal,signal:controller.signal,settings:{},
 logger:{debug(){},info(){},warn(){},error(...v){console.log('HOST_ERROR',String(v[0]??'').slice(0,180));}},
 async execFile(req){
  calls.push(req.file);
  const env={...process.env};
  for(const k of req.unsetEnv??[])delete env[k];
  const out=spawnSync(req.file,req.args??[],{cwd:req.cwd,encoding:'utf8',env,
    signal:req.signal?.aborted?undefined:req.signal,timeout:req.timeoutMs??10000,maxBuffer:1024*1024});
  if(out.error&&!out.status&&out.status!==0)throw out.error;
  return {exitCode:out.status??1,signal:out.signal??null,
    stdout:out.stdout??'',stderr:out.stderr??'',
    stdoutTruncated:false,stderrTruncated:false};
 },
};
const providers={
 resolve(token){
  if(token.id==='workspaces')return workspaces;
  if(token.id==='pi-sessions')return {version:1,async create(){throw Error('Native Pi session should not be launched')}};
  if(token.id==='pi-session-events')return {version:1,async connect(){throw Error('Native Pi events should not be used')}};
  throw Error('Unexpected capability '+token.id);
 }
};
const definition={
 id:'smoke-math',title:'Add multiply export and tests',maxQcRounds:2,
 maxParallelByRole:{implementer:1,reviewer:1,architect:1,planner:1},
 tasks:[{id:'math',title:'Implement multiply',kind:'implementation',role:'implementer',
 description:'Add multiply(a,b) export in src/math.mjs without removing add. Add node:test cases for 2*3, -2*3, and 0*7, run tests, and commit on the current feature branch.',
 acceptanceCriteria:['multiply(2,3) is 6','multiply(-2,3) is -6','multiply(0,7) is 0','existing add test still passes','commit changes'],dependsOn:[]}]
};
const model={provider:'openai',model:'gpt-5.5'};
const config={runtime:'durable',workspaces:{math:'wt-math'},models:{implementer:model,qc:model,architect:model,planner:model},test:{file:'node',args:['--test'],timeoutMs:15000},maxAttempts:2};
let backend, lastStatus='';
const request=async(operation,input)=>backend.peer.request({...sessionCtx,operation,input});
try{
 backend=await serverPlugin.activate(host);
 await backend.start({capabilities:providers,signal:controller.signal});
 await request('create',definition);
 await request('auto.configure',{workflowId:'smoke-math',config});
 await request('auto.start',{workflowId:'smoke-math'});
 console.log('AUTOPILOT_STARTED');
 const started=Date.now();
 let workflow;
 while(Date.now()-started<185000){
  workflow=await request('get','smoke-math');
  const status=workflow.tasks.math.status;
  if(status!==lastStatus){console.log('TASK_STATUS',status);lastStatus=status;}
  if(status==='passed'||status==='integrated')break;
  if(status==='failed'||status==='held')throw Error('Autopilot task stopped at '+status);
  await new Promise(r=>setTimeout(r,900));
 }
 if(!workflow||!['passed','integrated'].includes(workflow.tasks.math.status))throw Error('Autopilot did not finish in time (last='+lastStatus+')');
 const finalSha=git(worker,'rev-parse','HEAD');
 if(finalSha===baseline||git(worker,'status','--porcelain'))throw Error('Committed clean final Git SHA missing');
 const t=spawnSync('node',['--test'],{cwd:worker,encoding:'utf8',timeout:15000});
 if(t.status!==0)throw Error('Host tests failed post QC');
 const runs=await request('agents.list',{view:'all'});
 if(runs.filter(x=>x.phase==='sealed'&&x.sessionId?.startsWith('durable:')).length!==2)
  throw Error('Expected two sealed Durable Runs; got '+JSON.stringify(runs.map(x=>({run:x.runId,phase:x.phase}))));
 console.log('FULL_AUTOPILOT_PASS',JSON.stringify({taskStatus:workflow.tasks.math.status,typedQcVerdict:workflow.tasks.math.lastQc?.verdict,
  durableRuns:runs.map(x=>({run:x.runId,phase:x.phase,kind:x.seat,connected:x.connected})),
  gitCommitted:true,clean:true,tests:true,hostGitCommands:calls.filter(x=>x==='git').length}));
}catch(error){console.log('AUTOPILOT_FAIL',String(error instanceof Error?error.message:error).slice(0,550));process.exitCode=1;
 if(backend){try{console.log('RUNS',JSON.stringify((await request('agents.list',{view:'all'})).map(x=>({run:x.runId,phase:x.phase,latest:x.latestKind,text:x.latestText?.slice(0,130)}))));}catch{}}
}finally{
 controller.abort();
 if(backend)await backend.dispose(new AbortController().signal).catch(e=>console.log('DISPOSE_FAIL',String(e).slice(0,170)));
 rmSync(root,{recursive:true,force:true});
}
