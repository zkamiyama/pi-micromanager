import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {WorkflowStore} from '../../dist/core/store.js';
import {AgentRegistry} from '../../dist/runtime/registry.js';
import {AutopilotLedger} from '../../dist/automation/ledger.js';
import {fixture,workflow,configuration,runGit} from './production-server-fixture.mjs';

export const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3vVbcAAAAASUVORK5CYII=','base64');
// This fixture constructs persisted QC contracts via public repository classes.
// It does NOT claim a real model ran. Required Harness tests cover that separately.
export async function localJournalFixture({integrated=false}={}){
 const x=fixture();let store,agents,ledger;
 try{
  mkdirSync(join(x.project,'docs','adr'),{recursive:true});
  writeFileSync(join(x.project,'docs','adr','0001-fixture.md'),'# Retain the decision\n\nDecision: keep this Git-tracked explanation after disposable logs expire.\n');
  runGit(x.project,'add','docs/adr/0001-fixture.md');runGit(x.project,'commit','-m','Add synthetic ADR');
  runGit(x.project,'remote','add','origin','https://github.com/fixture/test.git');
  x.host.settings.productionSecurity.mode='local-owner';
  x.host.settings.productionSecurity.localRetention={autoReclaimWorktrees:false};
  await x.activate();await x.peer('create',workflow);
  await x.peer('auto.configure',{workflowId:'wf',config:configuration});
  const proposed=await x.peer('auto.worktree.preview',{workflowId:'wf',taskId:'task'});
  const plan=await x.peer('auto.worktree.create',{planId:proposed.id});
  x.setWorker(plan.path);
  await x.peer('auto.configure',{workflowId:'wf',config:{...configuration,workspaces:{task:'worker'}}});
  store=new WorkflowStore(join(x.state,'workflows.sqlite'));
  agents=new AgentRegistry(join(x.state,'agents.sqlite'));
  ledger=new AutopilotLedger(join(x.state,'autopilot.sqlite'));
  const act=(key,action)=>store.act('p','orchestra','wf',store.get('p','orchestra','wf').revision,key,action);
  act('fixture-start',{type:'start',taskId:'task'});
  act('fixture-finished',{type:'implementation_finished',taskId:'task',headSha:plan.baseSha,criteriaRevision:0,testsPassed:true});
  const reservation={projectId:'p',orchestraWorkspaceId:'orchestra',workflowId:'wf',taskId:'task',
   runId:'qc-task-1',workspaceId:'worker',seat:'qc',requestId:'auto:qc-task-1'};
  const sessionId='durable:'+createHash('sha256').update(JSON.stringify(['p','orchestra','wf','qc-task-1'])).digest('hex');
  agents.registerWorkspacePath('p','worker',plan.path);agents.reserve(reservation);
  const binding=agents.assign(reservation,sessionId);
  agents.record(binding,{kind:'agent_settled',text:'Synthetic contract fixture settled',at:Date.now(),sequence:1});
  const action={type:'qc_finalized',taskId:'task',runId:'qc-task-1',headSha:plan.baseSha,criteriaRevision:0,attempt:1,verdict:'pass'};
  ledger.prepareTransition(binding,'qc',action,'Synthetic QC contract');
  const evidence=ledger.sealEvidence(binding,'qc','Synthetic QC contract for '+plan.baseSha);
  const sealed=agents.seal('p','orchestra',sessionId,evidence.ref);act('fixture-qc',action);
  if(integrated)act('fixture-integrate',{type:'integrate',taskId:'task'});
  const image={workflowId:'wf',runId:sealed.runId,sourceSha:plan.baseSha,requestId:'one-image',label:'Operator-selected synthetic image',base64:PNG.toString('base64')};
  return {...x,store,agents,ledger,plan,sealed,image,act,
   async close(){ledger.close();agents.close();store.close();await x.close();}};
 }catch(error){ledger?.close();agents?.close();store?.close();await x.close();throw error;}
}
