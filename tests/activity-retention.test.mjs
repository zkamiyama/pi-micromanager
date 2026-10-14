import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {WorkflowStore} from "../dist/core/store.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {ActivityRetention} from "../dist/automation/retention.js";
import {buildJournal} from "../dist/automation/journal.js";

const DAY=24*60*60*1000,sha="a".repeat(40);
const workflow={id:"flow",title:"A verified API",maxQcRounds:3,
  maxParallelByRole:{implementer:2,reviewer:2,architect:1,planner:1},
  tasks:[{id:"api",title:"Implement API",kind:"implementation",
    role:"implementer",description:"Implement HTTP API",
    acceptanceCriteria:["HTTP 200 for a valid request"],dependsOn:[]}]};
function fixture(extra={}){
  const dir=mkdtempSync(join(tmpdir(),"mm-retention-"));
  const wf=new WorkflowStore(join(dir,"workflow.sqlite"));
  const agents=new AgentRegistry(join(dir,"agents.sqlite"));
  const ledger=new AutopilotLedger(join(dir,"autopilot.sqlite"));
  const retirement=new ActivityRetention({path:join(dir,"retention.sqlite"),
    workflows:wf,agents,ledger,...extra});
  let state=wf.create("p","o",workflow);
  state=wf.act("p","o","flow",state.revision,"start",{type:"start",taskId:"api"});
  state=wf.act("p","o","flow",state.revision,"finish",{
    type:"implementation_finished",taskId:"api",
    headSha:sha,criteriaRevision:0,testsPassed:true});
  state=wf.act("p","o","flow",state.revision,"qc",{
    type:"qc_finalized",taskId:"api",runId:"qc-api-1",headSha:sha,
    criteriaRevision:0,attempt:1,verdict:"pass"});
  const input={projectId:"p",orchestraWorkspaceId:"o",workspaceId:"linked-qc",
    workflowId:"flow",taskId:"api",runId:"qc-api-1",seat:"qc",requestId:"auto:qc1"};
  agents.reserve(input);agents.assign(input,"pi-qc");
  const binding=agents.get("p","o","pi-qc");
  const old=Date.now()-48*DAY;
  agents.record(binding,{kind:"agent_started",text:"Started",at:old,sequence:1});
  agents.record(binding,{kind:"agent_settled",text:"Agent settled",at:old+1000,sequence:2});
  const evidence=ledger.sealEvidence(binding,"qc","PASS at "+sha);
  agents.seal("p","o","pi-qc",evidence.ref);
  const db=new DatabaseSync(join(dir,"agents.sqlite"));
  db.prepare("UPDATE execution_runs SET updated_at=? WHERE session_id='pi-qc'")
    .run(new Date(old+1000).toISOString());
  db.close();
  return {dir,wf,agents,ledger,retirement,evidence,
    integrate(){
      const current=wf.get("p","o","flow");
      return wf.act("p","o","flow",current.revision,"integrate",{type:"integrate",taskId:"api"});
    },
    close(){
      retirement.close();ledger.close();agents.close();wf.close();
      rmSync(dir,{recursive:true,force:true});
    }};
}
test("Journal links actual QC evidence and Task status without full Pi transcripts",()=>{
  const x=fixture();
  try{
    const instance=x.wf.get("p","o","flow");
    const runs=x.agents.list("p","o","all");
    const journal=buildJournal(instance,runs,x.ledger);
    assert.equal(journal.workflowId,"flow");
    assert.equal(journal.tasks[0].status,"passed");
    assert.equal(journal.tasks[0].lastQc.headSha,sha);
    assert.equal(journal.runs.length,1);
    assert.equal(journal.runs[0].evidence.ref,x.evidence.ref);
    assert.match(journal.runs[0].evidence.summary,/PASS/);
    assert.ok(journal.notes.some(x=>x.includes("integration")));
    assert.ok(journal.events.every(e=>!Object.hasOwn(e,"hiddenThinking")));
    assert.ok(!Object.hasOwn(journal.runs[0],"transcript"));
  }finally{x.close();}
});
test("Expired public activity is protected while a QC-passed Task awaits integration",()=>{
  const x=fixture();
  try{
    assert.equal(x.retirement.preview("p","o",30),null);
    assert.equal(x.agents.activities("p","o","pi-qc").length,2);
    assert.throws(()=>x.retirement.preview("p","o",29),/minimum 30 days/);
  }finally{x.close();}
});
test("Two-step retention prunes only sealed and old public projections, not evidence or Workflow",()=>{
  const x=fixture();
  try{
    x.integrate();
    const plan=x.retirement.preview("p","o",30);
    assert.equal(plan.state,"prepared");
    assert.equal(plan.rowCount,2);
    assert.equal(plan.affectedRuns,1);
    assert.ok(plan.estimatedBytes>0);
    assert.equal(x.agents.activities("p","o","pi-qc").length,2,
      "Preview must not delete a record");
    assert.throws(()=>x.retirement.confirm("different","o",plan.id),/different workspace|not found/);
    const done=x.retirement.confirm("p","o",plan.id);
    assert.equal(done.deletedRows,2);
    assert.equal(done.state,"completed");
    assert.equal(x.agents.activities("p","o","pi-qc").length,0);
    assert.equal(x.retirement.confirm("p","o",plan.id).deletedRows,2);
    assert.equal(x.agents.get("p","o","pi-qc").phase,"sealed");
    assert.equal(x.ledger.evidence(x.agents.get("p","o","pi-qc")).ref,x.evidence.ref);
    assert.equal(x.wf.get("p","o","flow").tasks.api.status,"integrated");
    assert.ok(x.wf.get("p","o","flow").events.length>0,
      "Authoritative Workflow event history is never touched");
    assert.equal(x.retirement.preview("p","o",30),null);
  }finally{x.close();}
});
test("A late event or renewed Run activity invalidates a retention preview",()=>{
  const x=fixture();
  try{
    x.integrate();
    const preview=x.retirement.preview("p","o",30);
    const binding=x.agents.get("p","o","pi-qc");
    x.agents.record(binding,{kind:"tool_finished",text:"Late event",
      at:Date.now(),sequence:3});
    assert.throws(()=>x.retirement.confirm("p","o",preview.id),
      /eligibility changed/);
    assert.equal(x.agents.activities("p","o","pi-qc").length,3);
    assert.equal(x.retirement.preview("p","o",30),null);
  }finally{x.close();}
});
test("Expired preview cannot be confirmed after deadline or for a new run",()=>{
  const x=fixture();
  try{
    x.integrate();
    const preview=x.retirement.preview("p","o",30);
    assert.throws(()=>x.retirement.confirm("p","o",preview.id,
      preview.expiresAt+1),/expired/);
    assert.equal(x.agents.activities("p","o","pi-qc").length,2);
  }finally{x.close();}
});
test("Unsealed Run activity is never pruned even when its event timestamp is old",()=>{
  const x=fixture();
  try{
    x.integrate();
    const input={projectId:"p",orchestraWorkspaceId:"o",workspaceId:"other",
      workflowId:"flow",taskId:"api",runId:"qc-api-2",seat:"qc",requestId:"manual:qc2"};
    x.agents.reserve(input);x.agents.assign(input,"pi-unsealed");
    const bound=x.agents.get("p","o","pi-unsealed");
    x.agents.record(bound,{kind:"agent_started",text:"Pending",
      at:Date.now()-70*DAY,sequence:1});
    const preview=x.retirement.preview("p","o",30);
    assert.equal(preview,null,"An unresolved sibling Run pins all Workflow activity");
    assert.equal(x.agents.activities("p","o","pi-qc").length,2);
    assert.equal(x.agents.activities("p","o","pi-unsealed").length,1);
  }finally{x.close();}
});

test('#88 same-length content modification invalidates the exact retention manifest',()=>{
 const x=fixture();try{
  x.integrate();const plan=x.retirement.preview('p','o',30);
  assert.match(plan.manifestSha256,/^[a-f0-9]{64}$/);
  const db=new DatabaseSync(join(x.dir,'agents.sqlite'));
  db.prepare("UPDATE execution_activity SET text='Altered' WHERE text='Started'").run();db.close();
  assert.throws(()=>x.retirement.confirm('p','o',plan.id),/eligibility changed/);
  assert.equal(x.agents.activities('p','o','pi-qc').length,2);
 }finally{x.close();}
});
test('#88 an atomic digest recheck refuses a writer between preview validation and DELETE',()=>{
 const x=fixture();try{
  x.integrate();const plan=x.retirement.preview('p','o',30),original=x.agents.deleteExpiredActivity.bind(x.agents);
  x.agents.deleteExpiredActivity=(...args)=>{
   const db=new DatabaseSync(join(x.dir,'agents.sqlite'));
   db.prepare("UPDATE execution_activity SET text='Changed' WHERE text='Started'").run();db.close();
   return original(...args);
  };
  assert.throws(()=>x.retirement.confirm('p','o',plan.id),/proof changed/);
  assert.equal(x.agents.activities('p','o','pi-qc').length,2);
 }finally{x.close();}
});
test('#88 missing rows are not proof that this deletion completed',()=>{
 const x=fixture();try{
  x.integrate();const plan=x.retirement.preview('p','o',30),db=new DatabaseSync(join(x.dir,'agents.sqlite'));
  db.exec('DELETE FROM execution_activity');db.close();
  assert.throws(()=>x.retirement.confirm('p','o',plan.id),/deletion unproved/);
  assert.equal(x.agents.activityRetentionCommit('p','o',plan.id),undefined);
 }finally{x.close();}
});
test('#88 interrupted response recovers the atomic deletion receipt on another SQLite connection without replay',()=>{
 const x=fixture();let recovered;
 try{
  x.integrate();const plan=x.retirement.preview('p','o',30),original=x.agents.deleteExpiredActivity.bind(x.agents);let calls=0;
  x.agents.deleteExpiredActivity=(...args)=>{calls++;original(...args);throw Error('synthetic lost completion');};
  assert.throws(()=>x.retirement.confirm('p','o',plan.id),/lost completion/);
  recovered=new ActivityRetention({path:join(x.dir,'retention.sqlite'),workflows:x.wf,agents:x.agents,ledger:x.ledger});
  const result=recovered.confirm('p','o',plan.id);
  assert.equal(result.state,'completed');assert.equal(result.deletedRows,2);assert.equal(calls,1);
  assert.equal(x.agents.activityRetentionCommit('p','o',plan.id).fingerprint,plan.manifestSha256);
  assert.equal(x.ledger.evidence(x.agents.get('p','o','pi-qc')).ref,x.evidence.ref);
 }finally{recovered?.close();x.close();}
});
test('#88 newly pending external approval or changed Workflow revision invalidates a retention preview',()=>{
 let pinned=false;const x=fixture({externallyPinned:()=>pinned});
 try{
  x.integrate();const plan=x.retirement.preview('p','o',30);pinned=true;
  assert.equal(x.retirement.preview('p','o',30),null);
  assert.throws(()=>x.retirement.confirm('p','o',plan.id),/eligibility changed/);
  assert.equal(x.agents.activities('p','o','pi-qc').length,2);
 }finally{x.close();}
});

test('#88 pin queries cover approvals and publication reservations older than the UI page',async()=>{
 const {PermissionLedger}=await import('../dist/automation/permissions.js');
 const {PublicationManager}=await import('../dist/automation/publication-service.js');
 let permissions,publisher;
 const x=fixture({externallyPinned:(p,o,w)=>permissions.hasPending(p,o,w)||publisher.hasIncomplete(p,o,w)});
 try{
  permissions=new PermissionLedger(join(x.dir,'permissions.sqlite'),x.wf,x.ledger);
  publisher=new PublicationManager({path:join(x.dir,'publication.sqlite'),workflows:x.wf,agents:x.agents,
   ledger:x.ledger,permissions,host:{lifetimeSignal:new AbortController().signal,execFile:async()=>{throw Error('no external request');}},workspaces:()=>undefined});
  x.integrate();
  const approvalDb=new DatabaseSync(join(x.dir,'permissions.sqlite'));
  const insert=approvalDb.prepare('INSERT INTO workflow_approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<102;i++)insert.run('synthetic-'+i,JSON.stringify(['p','o']),'flow','api','git.push','qc-api-1',sha,'synthetic','mark-'+i,i===0?'pending':'approved',String(i).padStart(4,'0'),String(i));
  assert.equal(permissions.list('p','o','flow').some(a=>a.state==='pending'),false);
  assert.equal(permissions.hasPending('p','o','flow'),true);
  assert.equal(x.retirement.preview('p','o',30),null);
  approvalDb.exec("UPDATE workflow_approvals SET state='approved'");approvalDb.close();
  const publicationDb=new DatabaseSync(join(x.dir,'publication.sqlite'));
  const publish=publicationDb.prepare('INSERT INTO publication_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<102;i++)publish.run('op-'+i,JSON.stringify(['p','o']),'flow','api','git.push','qc-'+i,sha,'synthetic','test only','fingerprint-'+i,i===0?'reserved':'completed','',String(i).padStart(4,'0'),String(i));
  assert.equal(publisher.list('p','o','flow').some(a=>a.state!=='completed'),false);
  assert.equal(publisher.hasIncomplete('p','o','flow'),true);
  assert.equal(x.retirement.preview('p','o',30),null);publicationDb.close();
 }finally{publisher?.close();permissions?.close();x.close();}
});
