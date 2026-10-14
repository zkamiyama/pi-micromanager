import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import serverPlugin from '../dist/pi-web/server.js';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {AgentRegistry} from '../dist/runtime/registry.js';
import {acquireStateOwner} from '../dist/security/state-owner.js';

const model={provider:'faux',model:'faux-1'};
const workflow={
  id:'wf',title:'Synthetic security boundary',maxQcRounds:3,
  maxParallelByRole:{implementer:1,reviewer:1,architect:1,planner:1},
  permissions:{default:'ask'},
  tasks:[{id:'task',title:'Local worktree test',kind:'implementation',role:'implementer',
    description:'No external effects',acceptanceCriteria:['Boundaries enforced'],dependsOn:[]}],
};
const configuration={
  runtime:'durable',managedWorktrees:true,workspaces:{},
  models:{implementer:model,qc:model,architect:model,planner:model},
  test:{execution:'sandbox',file:'node',args:['--test'],timeoutMs:10000},maxAttempts:3,
};
const output=(r)=>({exitCode:r.status,signal:r.signal??null,
  stdout:r.stdout??'',stderr:r.stderr??'',stdoutTruncated:false,stderrTruncated:false});
function runGit(root,...args){
  const r=spawnSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  assert.equal(r.status,0,r.stderr);
}
function fixture(options={}){
  const temp=mkdtempSync(join(tmpdir(),'mm-production-server-'));
  const project=join(temp,'project'),other=join(temp,'other');
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

test('#79 public server: reject state ancestor, package overlap, foreign project and symlink',async()=>{
  for(const mode of ['state-ancestor','package-ancestor','foreign','symlink']){
    const x=fixture({stateNested:mode==='state-ancestor',packageNested:mode==='package-ancestor'});
    try{
      await x.activate();
      if(mode==='foreign')x.setWorkspace(x.other);
      if(mode==='symlink'){
        const alias=join(x.temp,'alias');symlinkSync(x.project,alias);x.setWorkspace(alias);
      }
      await x.peer('create',workflow);
      await x.peer('auto.configure',{workflowId:'wf',config:configuration});
      if(mode==='state-ancestor'||mode==='package-ancestor')x.setWorkspace(x.project);
      await assert.rejects(x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'}),
        /overlaps|selected project|canonical|outside/i,mode);
    }finally{await x.close();}
  }
});
test('#79 public server: reject managed parent; allow only an exact managed leaf',async()=>{
  const x=fixture();try{
    await x.activate();await x.peer('create',workflow);
    await x.peer('auto.configure',{workflowId:'wf',config:configuration});
    const parent=join(x.state,'managed-worktrees');
    mkdirSync(parent,{recursive:true});
    x.setWorkspace(parent);
    await assert.rejects(x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'}),
      /exact managed Worktree leaf/);
    const leaf=join(parent,'a'.repeat(16),'workflow','task');
    mkdirSync(leaf,{recursive:true});x.setWorkspace(leaf);
    // Preview consults the verified selected Workspace and performs Git read
    // checks on the separately authorized source project, never on the leaf.
    const plan=await x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'});
    assert.ok(plan.id);
  }finally{await x.close();}
});
test('#79 public activation: persisted production marker cannot be opened in compatibility mode',async()=>{
  const x=fixture();try{
    await x.activate();await x.plugin.dispose(new AbortController().signal);
    await assert.rejects(serverPlugin.activate({...x.host,settings:{}}),/implicit downgrade/);
  }finally{await x.close();}
});
for(const scenario of ['pause','reconfigure','owner-loss']){
  test('#81 public API: '+scenario+' during asynchronous Git preflight prevents worktree add',
    {timeout:15000},async()=>{
      const x=fixture();
      try{
        await x.activate();
        await x.peer('create',workflow);
        await x.peer('auto.configure',{workflowId:'wf',config:configuration});
        const plan=await x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'});
        x.holdPreflight();
        const active=x.peer('auto.worktree.create',{planId:plan.id});
        const rejected=assert.rejects(active,/generation|abort|loss|stopp|control|owner/i);
        await x.waitPreflight;
        if(scenario==='pause')await x.peer('auto.pause',{workflowId:'wf'});
        else if(scenario==='reconfigure')
          await x.peer('auto.configure',{workflowId:'wf',config:{...configuration,maxAttempts:2}});
        else {
          x.lifetime.abort(new Error('Synthetic ownership loss'));
          await assert.rejects(acquireStateOwner(x.state),/owner|locking/,
            'An in-flight Git operation must retain the original owner lock');
        }
        x.releasePreflight();
        await rejected;
        if(scenario==='owner-loss'){
          await x.plugin.dispose(new AbortController().signal);
          const successor=await acquireStateOwner(x.state);
          try{successor.assertHeld();}finally{await successor.release();}
        }
        assert.equal(x.calls.some(c=>c.args.includes('worktree')&&c.args.includes('add')),false,
          'No Git worktree mutation may escape an obsolete operation generation');
        assert.equal(existsSync(plan.path),false);
      }finally{await x.close();}
    });
}

test('#80 public server: owner loss joins delayed real Durable Harness and persists uncertainty',
  {timeout:20000},async()=>{
    const previous=ModelRuntime.create;
    const models=createModels(),faux=fauxProvider({tokensPerSecond:10});
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Synthetic delayed provider message '.repeat(500))]);
    // Test-process-only override; production API still owns exact model choice
    // and never accepts models/credentials from its settings or a caller.
    ModelRuntime.create=async()=>models;
    const x=fixture();
    try{
      await x.activate();
      const proposal=await x.peer('auto.propose',
        {goal:'Propose a local-only workflow',provider:'faux',model:'faux-1',runtime:'durable'});
      assert.ok(proposal.sessionId);
      const until=Date.now()+10000;
      while(faux.state.callCount<1&&Date.now()<until)
        await new Promise(r=>setTimeout(r,20));
      assert.equal(faux.state.callCount,1,'The real Harness must reach the faux provider');
      x.lifetime.abort(new Error('Synthetic control-plane ownership lost'));
      await x.plugin.dispose(new AbortController().signal);
      await assert.rejects(x.peer('auto.propose',
        {goal:'Must not run',provider:'faux',model:'faux-1'}),/abort|stopp|loss|owner/i);
      const db=new AgentRegistry(join(x.state,'agents.sqlite'));
      try{
        const entry=db.getRun('p','orchestra',proposal.draftWorkflowId,proposal.runId);
        assert.ok(entry);
        assert.equal(entry.abortRequested,1);
        assert.equal(entry.phase,'uncertain');
      }finally{db.close();}
      assert.equal(faux.state.callCount,1,'No model replay after ownership loss');
    }finally{
      await x.close();
      ModelRuntime.create=previous;
    }
  });

test('#80 public server: ownership loss aborts an executing isolated shell tool, then joins',
  {timeout:22000},async()=>{
    const previous=ModelRuntime.create;
    const models=createModels(),faux=fauxProvider({tokensPerSecond:100000});
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([
      fauxToolCall('bash',{command:'sleep 12; printf escaped > after-lifetime.txt'},
        {id:'synthetic-delayed-tool'})],{stopReason:'toolUse'}),
      fauxAssistantMessage('Must not follow an owner loss')]);
    ModelRuntime.create=async()=>models;
    const x=fixture();
    const events=[],channelAbort=new AbortController();
    try{
      // The only checkout and child process involved are under the test's
      // freshly created synthetic repository. No external push or provider.
      const worker=join(x.project,'worker');
      runGit(x.project,'worktree','add','-b','fixture-tool',worker);
      x.setWorker(worker);
      await x.activate();
      const channel=x.plugin.peer.openChannel({
        project:{id:'p',path:x.project,name:'Test project'},
        workspace:{id:'orchestra',projectId:'p',path:x.project,isMain:true},
        operation:'agents.events',input:null,signal:channelAbort.signal,
        send:event=>events.push(event)});
      await x.peer('create',{...workflow,
        permissions:{default:'ask',actions:{'git.commit':'allow'}}});
      await x.peer('auto.configure',{workflowId:'wf',config:{
        ...configuration,managedWorktrees:undefined,workspaces:{task:'worker'}}});
      await x.peer('auto.start',{workflowId:'wf'});
      const deadline=Date.now()+12000;
      while(!events.some(e=>e.type==='agent_activity'&&e.event?.kind==='tool_started')&&
        Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));
      assert.ok(events.some(e=>e.type==='agent_activity'&&e.event?.kind==='tool_started'),
        'A real Durable Harness must enter an isolated tool');
      await new Promise(resolve=>setTimeout(resolve,150));
      x.lifetime.abort(new Error('Synthetic state ownership lost during shell execution'));
      await x.plugin.dispose(new AbortController().signal);
      assert.equal(existsSync(join(worker,'after-lifetime.txt')),false,
        'The aborted isolated tool must not reach its delayed filesystem mutation');
      const db=new AgentRegistry(join(x.state,'agents.sqlite'));
      try{
        const entries=db.list('p','orchestra','all').filter(e=>e.runId.startsWith('impl-'));
        assert.ok(entries.length,'Expected a Durable implementation worker');
        assert.equal(entries.some(e=>e.phase==='settled'),false);
        assert.equal(entries.some(e=>e.abortRequested===1),true);
      }finally{db.close();}
      channel.close();
    }finally{
      channelAbort.abort();
      await x.close();
      ModelRuntime.create=previous;
    }
  });

test('#80 public server: explicit dispose fences a delayed provider without a prior lifetime abort',
  {timeout:20000},async()=>{
    const previous=ModelRuntime.create,models=createModels();
    const faux=fauxProvider({tokensPerSecond:10});
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Disposable provider in flight '.repeat(500))]);
    ModelRuntime.create=async()=>models;
    const x=fixture();
    try{
      await x.activate();
      const proposal=await x.peer('auto.propose',
        {goal:'Local disposal drill',provider:'faux',model:'faux-1',runtime:'durable'});
      const deadline=Date.now()+10000;
      while(faux.state.callCount<1&&Date.now()<deadline)
        await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(faux.state.callCount,1);
      await x.plugin.dispose(new AbortController().signal);
      // The lifetime was never externally aborted. Shutdown itself must
      // invalidate outstanding input and release only after the Harness joins.
      assert.equal(x.lifetime.signal.aborted,false);
      const db=new AgentRegistry(join(x.state,'agents.sqlite'));
      try{
        const entry=db.getRun('p','orchestra',proposal.draftWorkflowId,proposal.runId);
        assert.equal(entry.phase,'uncertain');
        assert.equal(entry.abortRequested,1);
      }finally{db.close();}
      await assert.rejects(x.peer('security.readiness',null),/stopp|ownership released|abort|owner/i);
      const successor=await acquireStateOwner(x.state);
      try{successor.assertHeld();}finally{await successor.release();}
    }finally{await x.close();ModelRuntime.create=previous;}
  });
