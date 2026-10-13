import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {validateDefinition} from "../dist/core/workflow.js";
import {permissionDecision} from "../dist/core/permissions.js";
import {WorkflowStore} from "../dist/core/store.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {PermissionLedger} from "../dist/automation/permissions.js";

const HEAD="a".repeat(40);
const TARGET={repository:"acme/repo",sourceBranch:"feature/code",
  pushUrl:"https://github.com/acme/repo.git"};
const workflow={id:"feature",title:"YOLO feature",maxQcRounds:3,
  maxParallelByRole:{planner:1,implementer:1,reviewer:1,architect:1},
  tasks:[{id:"code",title:"Code",role:"implementer",kind:"implementation",
    dependsOn:[],description:"Implement feature",acceptanceCriteria:["Passing test"]}],
};
const profile={provider:"local",model:"exact"};
const config={workspaces:{code:"worker"},publication:{
  remote:"origin",baseBranch:"main",draft:true},
  models:{implementer:profile,qc:profile,architect:profile,planner:profile},
  test:{file:"node",args:["--test"],timeoutMs:5000},maxAttempts:2};
function fixture(permissions){
  const dir=mkdtempSync(join(tmpdir(),"mm-permissions-"));
  const workflows=new WorkflowStore(join(dir,"workflow.sqlite"));
  const ledger=new AutopilotLedger(join(dir,"ledger.sqlite"));
  let wf=workflows.create("p","o",{...workflow,permissions});
  wf=workflows.act("p","o","feature",wf.revision,"start",{type:"start",taskId:"code"});
  wf=workflows.act("p","o","feature",wf.revision,"finish",{
    type:"implementation_finished",taskId:"code",headSha:HEAD,criteriaRevision:0,
    testsPassed:true});
  wf=workflows.act("p","o","feature",wf.revision,"qc",{
    type:"qc_finalized",taskId:"code",runId:"qc-code-1",headSha:HEAD,
    criteriaRevision:0,attempt:1,verdict:"pass"});
  ledger.save("p","o","feature",config);
  let permissionsDB=new PermissionLedger(join(dir,"permissions.sqlite"),workflows,ledger);
  return {dir,workflows,ledger,
    get permission(){return permissionsDB;},
    reopen(){permissionsDB.close();permissionsDB=new PermissionLedger(
      join(dir,"permissions.sqlite"),workflows,ledger);},
    close(){permissionsDB.close();ledger.close();workflows.close();
      rmSync(dir,{recursive:true,force:true});}};
}
test("Default Workflow is YOLO for PR merge; production deployment still asks",()=>{
  validateDefinition(workflow);
  assert.equal(permissionDecision(undefined,"git.commit"),"allow");
  assert.equal(permissionDecision(undefined,"git.push"),"allow");
  assert.equal(permissionDecision(undefined,"github.pr.create"),"allow");
  assert.equal(permissionDecision(undefined,"github.pr.merge"),"allow");
  assert.equal(permissionDecision(undefined,"deploy.production"),"ask");
  assert.equal(permissionDecision({default:"deny",actions:{"git.push":"ask"}},"git.push"),"ask");
  assert.equal(permissionDecision({default:"deny"},"git.commit"),"deny");
  assert.equal(permissionDecision({default:"deny"},"github.pr.merge"),"deny");
});
test("Workflow policy rejects unknown keys, invalid actions and invalid decisions",()=>{
  for(const policy of [
    null,[],{default:"autonomous"},{default:"allow",unknown:true},
    {actions:{"git.push":"yes"}},{actions:{"github.repo.delete":"allow"}},
    {actions:{"git.push":null}},
  ]){
    assert.throws(()=>validateDefinition({...workflow,permissions:policy}),
      error=>error.code==="invalid_permissions");
  }
  validateDefinition({...workflow,permissions:{
    default:"allow",actions:{"git.push":"ask","github.pr.create":"deny"},
  }});
});
test("Ask creates one durable exact QC permission request; approval is idempotent",()=>{
  const x=fixture({actions:{"git.push":"ask"}});
  try{
    const pub=x.ledger.get("p","o","feature").config.publication;
    const q=()=>x.permission.ensure("p","o","feature","code","git.push",
      "qc-code-1",HEAD,pub,TARGET);
    const first=q();assert.equal(first.decision,"ask");
    assert.equal(first.approval.state,"pending");
    assert.equal(q().approval.id,first.approval.id);
    x.reopen();
    assert.equal(q().approval.id,first.approval.id,
      "Same Task/SHA/destination approval must persist after restart");
    const approved=x.permission.decide("p","o",first.approval.id,"approved");
    assert.equal(approved.state,"approved");
    assert.equal(q().decision,"allow");
    assert.equal(x.permission.decide("p","o",first.approval.id,"approved").state,"approved");
    assert.throws(()=>x.permission.decide("p","o",first.approval.id,"rejected"),
      /cannot be changed/);
    assert.equal(x.permission.list("p","o","feature").length,1);
  }finally{x.close();}
});
test("No decision is transferable across Workflows, publication targets or changed QC",()=>{
  const x=fixture({actions:{"git.push":"ask"}});
  try{
    const pub=x.ledger.get("p","o","feature").config.publication;
    const a=x.permission.ensure("p","o","feature","code","git.push",
      "qc-code-1",HEAD,pub,TARGET).approval;
    assert.throws(()=>x.permission.decide("different","o",a.id,"approved"),
      /does not belong/);
    assert.throws(()=>x.permission.ensure("p","o","feature","code","git.push",
      "qc-code-1","b".repeat(40),pub,TARGET),/QC-passed/);
    x.ledger.save("p","o","feature",{
      ...config,publication:{...pub,baseBranch:"release"},
    });
    assert.throws(()=>x.permission.decide("p","o",a.id,"approved"),
      /no longer matches/);
    const changed=x.permission.ensure("p","o","feature","code","git.push",
      "qc-code-1",HEAD,{...pub,baseBranch:"release"},TARGET);
    assert.equal(changed.decision,"ask");
    assert.notEqual(changed.approval.id,a.id);
  }finally{x.close();}
});
test("Deny never creates approval or authorizes a later operation",()=>{
  const x=fixture({actions:{"git.push":"deny","github.pr.create":"ask"}});
  try{
    const pub=x.ledger.get("p","o","feature").config.publication;
    assert.deepEqual(x.permission.ensure("p","o","feature","code","git.push",
      "qc-code-1",HEAD,pub,TARGET),{decision:"deny"});
    assert.equal(x.permission.list("p","o","feature").length,0);
    const q=x.permission.ensure("p","o","feature","code","github.pr.create",
      "qc-code-1",HEAD,pub,TARGET);
    assert.equal(q.decision,"ask");
    assert.equal(x.permission.decide("p","o",q.approval.id,"rejected").state,"rejected");
    assert.equal(x.permission.ensure("p","o","feature","code","github.pr.create",
      "qc-code-1",HEAD,pub,TARGET).decision,"deny");
  }finally{x.close();}
});

test("Git commit ask is admitted before the modifying Pi Run, bound to Task attempt and revision",()=>{
  const x=fixture({actions:{"git.commit":"ask"}});
  try{
    // The fixture Task is already QC-passed. Rework is the only way to have
    // another ready attempt; create an independent fresh workflow here.
    let other=x.workflows.create("p","o",{...workflow,id:"new-attempt",
      permissions:{actions:{"git.commit":"ask"}}});
    x.ledger.save("p","o","new-attempt",config);
    const proof=x.permission.ensureCommit("p","o","new-attempt","code",1,"worker");
    assert.equal(proof.decision,"ask");
    assert.equal(proof.approval.headSha,"pre-commit");
    assert.equal(proof.approval.runId,"impl-code-1");
    assert.equal(proof.approval.target,"worker");
    assert.equal(x.permission.ensureCommit("p","o","new-attempt","code",1,"worker")
      .approval.id,proof.approval.id);
    assert.equal(x.permission.decide("p","o",proof.approval.id,"approved").state,"approved");
    assert.equal(x.permission.ensureCommit("p","o","new-attempt","code",1,"worker")
      .decision,"allow");
    other=x.workflows.act("p","o","new-attempt",other.revision,"start",
      {type:"start",taskId:"code"});
    assert.throws(()=>x.permission.decide("p","o",proof.approval.id,"approved"),
      /Commit approval no longer matches/);
  }finally{x.close();}
});
