/** Real Git-process integration tests in disposable temp repositories.
 * No user workspace, Pi authentication or remote repository is touched. */
import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkflowStore} from "../dist/core/store.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {ManagedWorktreeProvisioner} from "../dist/automation/worktree-provisioner.js";
import {IntegrationVerifier} from "../dist/automation/integration.js";

const definition={id:"flow",title:"Real Git test feature",maxQcRounds:3,
  maxParallelByRole:{implementer:1,reviewer:1,architect:1,planner:1},
  tasks:[{id:"feature",title:"Add a feature file",kind:"implementation",role:"implementer",
    description:"Write the example feature",acceptanceCriteria:["Feature file exists"],
    dependsOn:[]}]};
const models=Object.fromEntries(["implementer","qc","architect","planner"]
  .map(seat=>[seat,{provider:"mock",model:"mock"}]));
const config={workspaces:{feature:"wt-feature"},models,
  test:{execution:"trusted-host",file:"node",args:["--test"],timeoutMs:15000},maxAttempts:2};
function cmd(cwd,...args){
  return execFileSync("git",["-C",cwd,...args],{encoding:"utf8",timeout:10000});
}
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),"mm-real-git-"));
  const repo=join(directory,"project"),data=join(directory,"plugin-owned");
  const integrated=join(directory,"integrated");
  mkdirSync(repo,{recursive:true});mkdirSync(data,{recursive:true});
  execFileSync("git",["init","-b","main",repo],{encoding:"utf8",timeout:10000});
  writeFileSync(join(repo,"README.md"),"Disposable integration test project\n");
  cmd(repo,"add","README.md");
  cmd(repo,"-c","user.name=Micromanager Test",
    "-c","user.email=mm-test@example.invalid","commit","-m","Initial baseline");
  const baseline=cmd(repo,"rev-parse","HEAD").trim();
  const host={lifetimeSignal:new AbortController().signal,
    async execFile(input){
      const environment={...process.env};
      for(const key of input.unsetEnv??[])delete environment[key];
      try{
        const stdout=execFileSync(input.file,[...(input.args??[])],{
          encoding:"utf8",timeout:input.timeoutMs??10000,
          cwd:input.cwd,env:environment,signal:input.signal,maxBuffer:1024*1024,
        });
        return {exitCode:0,signal:null,stdout,stderr:"",
          stdoutTruncated:false,stderrTruncated:false};
      }catch(error){
        const e=error;
        return {exitCode:typeof e.status==="number"?e.status:null,
          signal:e.signal??null,
          stdout:String(e.stdout??""),stderr:String(e.stderr??""),
          stdoutTruncated:false,stderrTruncated:false};
      }
    }};
  const wf=new WorkflowStore(join(data,"wf.sqlite"));
  const registry=new AgentRegistry(join(data,"runs.sqlite"));
  const ledger=new AutopilotLedger(join(data,"auto.sqlite"));
  wf.create("p","o",definition);
  const provisioner=new ManagedWorktreeProvisioner({
    path:join(data,"plans.sqlite"),dataDirectory:data,host,workflows:wf,ledger,
  });
  const integration=new IntegrationVerifier({
    path:join(data,"integration.sqlite"),host,workflows:wf,agents:registry,
    ledger,workspaces:()=>({version:1,async resolve({projectId,workspaceId}){
      if(projectId!=="p"||workspaceId!=="wt-integrated")
        throw new Error("Unknown linked target Workspace");
      return {project:{id:"p",name:"Disposable project",path:repo},
        workspace:{id:workspaceId,projectId:"p",isMain:false,
          label:"Integrated target",path:integrated,
          provider:{metadata:{isGitWorktree:true}}}};
    }}),
  });
  return {directory,repo,data,integrated,baseline,host,wf,registry,ledger,
    provisioner,integration,
    close(){
      integration.close();provisioner.close();ledger.close();registry.close();wf.close();
      rmSync(directory,{recursive:true,force:true});
    }};
}
test("Actual Git worktree add, QC ancestry and reviewed integration work end to end",async()=>{
  const x=fixture();
  try{
    const planned=await x.provisioner.preview("p","o","flow","feature",x.repo);
    assert.equal(planned.baseSha,x.baseline);
    assert.match(planned.branch,/^mm\/[0-9a-f]{16}\/flow\/feature$/);
    assert.equal(cmd(x.repo,"worktree","list","--porcelain").includes(planned.path),false);
    const created=await x.provisioner.create("p","o",planned.id,x.repo);
    assert.equal(created.stage,"created");
    assert.equal(cmd(created.path,"rev-parse","HEAD").trim(),x.baseline);
    assert.equal(cmd(created.path,"branch","--show-current").trim(),planned.branch);
    assert.equal((await x.provisioner.inspect("p","o",planned.id)).stage,"created");
    assert.equal(cmd(x.repo,"worktree","list","--porcelain").includes(created.path),true);

    // A real coding Agent could make this exact commit, but the test uses Git
    // directly rather than an authenticated model on a user machine.
    writeFileSync(join(created.path,"feature.txt"),"feature result\n");
    cmd(created.path,"add","feature.txt");
    cmd(created.path,"-c","user.name=Micromanager Test",
      "-c","user.email=mm-test@example.invalid","commit","-m","Implement feature");
    const featureSha=cmd(created.path,"rev-parse","HEAD").trim();
    assert.notEqual(featureSha,x.baseline);
    let current=x.wf.get("p","o","flow");
    current=x.wf.act("p","o","flow",current.revision,"start",{
      type:"start",taskId:"feature"});
    current=x.wf.act("p","o","flow",current.revision,"done",{
      type:"implementation_finished",taskId:"feature",
      headSha:featureSha,criteriaRevision:0,testsPassed:true});
    current=x.wf.act("p","o","flow",current.revision,"qc",{
      type:"qc_finalized",taskId:"feature",runId:"qc-feature-1",
      headSha:featureSha,criteriaRevision:0,attempt:1,verdict:"pass"});
    assert.equal(current.tasks.feature.status,"passed");
    const reservation={projectId:"p",orchestraWorkspaceId:"o",workspaceId:"wt-feature",
      workflowId:"flow",taskId:"feature",runId:"qc-feature-1",
      seat:"qc",requestId:"auto:qc-feature"};
    x.registry.reserve(reservation);
    x.registry.assign(reservation,"qc-session-1");
    const binding=x.registry.get("p","o","qc-session-1");
    x.registry.record(binding,{kind:"agent_settled",sequence:1,at:Date.now(),
      text:"Agent settled"});
    const evidence=x.ledger.sealEvidence(binding,"qc","Verified feature at "+featureSha);
    x.registry.seal("p","o","qc-session-1",evidence.ref);
    x.ledger.save("p","o","flow",config);

    // Before external operator integration the target is on the old baseline.
    cmd(x.repo,"worktree","add","-b","integration",x.integrated,x.baseline);
    await assert.rejects(x.integration.preview("p","o","flow","feature","wt-integrated"),
      /does not contain/);
    // This Git mutation is owned by the test operator, NOT Micromanager.
    cmd(x.integrated,"merge","--ff-only",planned.branch);
    assert.equal(cmd(x.integrated,"rev-parse","HEAD").trim(),featureSha);
    const approval=await x.integration.preview("p","o","flow","feature","wt-integrated");
    assert.equal(approval.sourceSha,featureSha);
    assert.equal(approval.targetHead,featureSha);
    const saved=await x.integration.confirm("p","o",approval.id);
    assert.equal(saved.tasks.feature.status,"integrated");
    assert.equal(await x.integration.confirm("p","o",approval.id).then(r=>r.revision),
      saved.revision);
  }finally{x.close();}
});
