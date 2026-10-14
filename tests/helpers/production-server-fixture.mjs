import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import serverPlugin from '../../dist/pi-web/server.js';

export const model={provider:'faux',model:'faux-1'};
export const workflow={
  id:'wf',title:'Synthetic security boundary',maxQcRounds:3,
  maxParallelByRole:{implementer:1,reviewer:1,architect:1,planner:1},
  permissions:{default:'ask'},
  tasks:[{id:'task',title:'Local worktree test',kind:'implementation',role:'implementer',
    description:'No external effects',acceptanceCriteria:['Boundaries enforced'],dependsOn:[]}],
};
export const configuration={
  runtime:'durable',managedWorktrees:true,workspaces:{},
  models:{implementer:model,qc:model,architect:model,planner:model},
  test:{execution:'sandbox',file:'node',args:['--test'],timeoutMs:10000},maxAttempts:3,
};
const output=(r)=>({exitCode:r.status,signal:r.signal??null,
  stdout:r.stdout??'',stderr:r.stderr??'',stdoutTruncated:false,stderrTruncated:false});
export function runGit(root,...args){
  const r=spawnSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  assert.equal(r.status,0,r.stderr);
}
export function fixture(options={}){
  const temp=mkdtempSync(join(tmpdir(),'mm-production-server-'));
  const project=join(temp,'project'),other=options.nestedOther?join(project,'foreign-project'):join(temp,'other');
  const state=options.stateNested?join(project,'private-state'):join(temp,'state');
  const packageRoot=options.packageNested?join(project,'package'):join(temp,'package');
  for(const dir of [project,other,packageRoot])mkdirSync(dir,{recursive:true,mode:0o700});
  mkdirSync(state,{recursive:true,mode:0o700});
  runGit(project,'init','-b','main');
  runGit(project,'config','user.name','fixture');
  runGit(project,'config','user.email','fixture@invalid.local');
  // Keep the test's Git source entirely inside a newly allocated tmp tree.
  writeFileSync(join(project,'README.fixture'),'synthetic\n');
  runGit(project,'add','README.fixture');runGit(project,'commit','-m','fixture');
  const lifetime=new AbortController(),calls=[];
  let selected=project,workerPath,closed=false;
  let blockPreflight,preflightEntered,preflightRelease,blocked=false;
  const waitPreflight=new Promise(resolve=>{preflightEntered=resolve;});
  const preflightGate=new Promise(resolve=>{preflightRelease=resolve;});
  const producer={
    async execFile(request){
      const args=request.args??[];
      if(request.file==='/usr/bin/git'&&args.includes('config')&&blockPreflight&&!blocked){
        let reserved=false;
        const path=join(state,'worktree-provisions.sqlite');
        if(existsSync(path)){
          const db=new DatabaseSync(path,{readOnly:true,allowExtension:false});
          try{reserved=Boolean(db.prepare("SELECT 1 FROM worktree_plans WHERE stage='reserved' LIMIT 1").get());}
          finally{db.close();}
        }
        if(reserved){blocked=true;preflightEntered();await preflightGate;}
      }
      // A synthetic uncooperative Git config preflight may complete even
      // after cancellation; the SERVER's final fence must still reject it.
      if(!args.includes('config'))request.signal.throwIfAborted();
      calls.push({file:request.file,args:[...args]});
      if(request.file!=='/usr/bin/git')throw Error('Unexpected external process in disposable test');
      const r=spawnSync(request.file,args,{encoding:'utf8',cwd:request.cwd??project,
        env:{...process.env,...request.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},
        timeout:request.timeoutMs??10000});
      return output(r);
    }
  };
  const capabilities={
    resolve(cap){
      if(cap.id==='workspaces')return {version:1,async resolve(selection){
        if(selection.projectId!=='p')throw Error('Unknown synthetic project');
        return {project:{id:'p',name:'Test project',path:project},
          workspace:{id:selection.workspaceId,projectId:'p',
            path:selection.workspaceId==='worker'&&workerPath?workerPath:selected,
            isMain:selection.workspaceId==='orchestra',
            provider:{metadata:{isGitWorktree:true}}}};
      }};
      // Production wrapper never exposes native Pi operations.
      return {version:1};
    }
  };
  const host={
    apiVersion:3,pluginId:'micromanager',packageRoot,dataDirectory:state,
    lifetimeSignal:lifetime.signal,signal:new AbortController().signal,
    settings:{productionSecurity:{mode:'production',projectRoots:[project,other],
      models:[model]}},logger:{debug(){},info(){},warn(){},error(){}},
    ...producer,
  };
  let plugin;
  async function activate(){
    plugin=await serverPlugin.activate(host);
    await plugin.start({capabilities,signal:new AbortController().signal});
    return plugin;
  }
  const peer=(operation,input)=>plugin.peer.request({
    project:{id:'p',name:'Test project',path:project},
    workspace:{id:'orchestra',projectId:'p',path:project,isMain:true},
    operation,input,signal:new AbortController().signal,
  });
  async function close(){
    if(closed)return;closed=true;preflightRelease();lifetime.abort(new Error('Disposable host shutting down'));
    try{await plugin?.dispose(new AbortController().signal);}finally{rmSync(temp,{recursive:true,force:true});}
  }
  return {temp,project,other,state,packageRoot,lifetime,calls,host,
    activate,peer,close,waitPreflight,releasePreflight:()=>preflightRelease(),
    holdPreflight:()=>{blockPreflight=true;},setWorkspace:path=>{selected=path;},
    setWorker:path=>{workerPath=path;},
    get plugin(){return plugin;}};
}
