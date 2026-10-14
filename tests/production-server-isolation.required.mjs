// Isolation tests are intentionally absent from the portable test glob.
 // They execute unconditionally, without skip or fallback, in the required
 // successful-isolation CI job on a host supporting real Linux namespaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {AgentRegistry} from '../dist/runtime/registry.js';
import {acquireStateOwner} from '../dist/security/state-owner.js';
import {fixture,runGit,workflow,configuration} from './helpers/production-server-fixture.mjs';

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

test('S01/F06 public proposal API refuses a provisional typed workflow after provider failure',
  {timeout:18000},async()=>{
  const old=ModelRuntime.create,models=createModels();
  const faux=fauxProvider({tokensPerSecond:100000});
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('mm_workflow_proposal',{
      id:'proposed-workflow',title:'Synthetic untrusted proposal',
      summary:'Provisional and not approved',maxQcRounds:2,
      tasks:[{id:'task',title:'Synthetic task',description:'No external action',
        acceptanceCriteria:['Never execute on a failed provider result'],dependsOn:[]}]},
      {id:'provisional-workflow'})],{stopReason:'toolUse'}),
    fauxAssistantMessage('Synthetic provider failed',
      {stopReason:'error',errorMessage:'Rejected after provisional report'}),
  ]);
  ModelRuntime.create=async()=>models;
  const x=fixture();
  try{
    await x.activate();
    const proposal=await x.peer('auto.propose',{
      goal:'Propose only, do not run',provider:'faux',model:'faux-1',runtime:'durable'});
    const agents=new AgentRegistry(join(x.state,'agents.sqlite'));
    try{
      let current;
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){
        current=agents.getRun('p','orchestra',proposal.draftWorkflowId,proposal.runId);
        if(current?.phase==='uncertain')break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.equal(current?.phase,'uncertain');
      const inspected=await x.peer('auto.proposal',{
        draftWorkflowId:proposal.draftWorkflowId,runId:proposal.runId});
      assert.equal(inspected.canAccept,false);
      // Fault injection: reproduce a stale/lost settlement projection while
      // the authoritative Durable input outcome remains failed. Before the
      // persisted-outcome fence this phase alone could accept the draft.
      agents.update(current,'settled');
      const stale=await x.peer('auto.proposal',{
        draftWorkflowId:proposal.draftWorkflowId,runId:proposal.runId});
      assert.equal(stale.phase,'settled');
      assert.equal(stale.canAccept,false);
      await assert.rejects(x.peer('auto.acceptProposal',{
        draftWorkflowId:proposal.draftWorkflowId,runId:proposal.runId}),
        /persisted successful input outcome/i);
    }finally{agents.close();}
  }finally{await x.close();ModelRuntime.create=old;}
});
