/** Real isolated Git tests of YOLO fast-forward convergence; no network or user repo. */
import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkflowStore} from "../dist/core/store.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {PermissionLedger} from "../dist/automation/permissions.js";
import {AutomaticIntegrator} from "../dist/automation/convergence.js";

function git(cwd,...args){
  return execFileSync("git",["-C",cwd,...args],{
    encoding:"utf8",timeout:10000,maxBuffer:1024*1024}).trim();
}
function commit(cwd,filename,message){
  git(cwd,"add",filename);
  return git(cwd,"-c","user.name=Convergence Test",
    "-c","user.email=test@example.invalid","commit","-m",message);
}
const models=Object.fromEntries(["planner","implementer","qc","architect"]
  .map(role=>[role,{provider:"mock",model:"mock"}]));
function fixture({policy,fanout=1}={}){
  const root=mkdtempSync(join(tmpdir(),"mm-yolo-convergence-"));
  const main=join(root,"project"),data=join(root,"plugin");
  const sourcePath=join(root,"source");
  const children=Array.from({length:fanout},(_,i)=>({
    id:"consumer"+i,workspaceId:"wt-consumer"+i,path:join(root,"consumer"+i),
  }));
  mkdirSync(main,{recursive:true});mkdirSync(data,{recursive:true});
  execFileSync("git",["init","-b","main",main],{encoding:"utf8"});
  writeFileSync(join(main,"README.md"),"Initial clean Git workspace\n");
  commit(main,"README.md","baseline");
  const baseline=git(main,"rev-parse","HEAD");
  git(main,"worktree","add","-b","feature/source",sourcePath,baseline);
  for(const child of children)
    git(main,"worktree","add","-b","feature/"+child.id,child.path,baseline);
  writeFileSync(join(sourcePath,"feature.txt"),"Implementation accepted by QC\n");
  commit(sourcePath,"feature.txt","Implement upstream");
  const sourceSha=git(sourcePath,"rev-parse","HEAD");
  const workflow={
    id:"flow",title:"Multi Task fast-forward test",maxQcRounds:3,
    maxParallelByRole:{implementer:2,reviewer:2,architect:1,planner:1},
    ...(policy?{permissions:policy}:{}),
    tasks:[
      {id:"source",title:"Source",kind:"implementation",role:"implementer",
        description:"Commit source code",acceptanceCriteria:["Source passes"],
        dependsOn:[]},
      ...children.map(child=>({id:child.id,title:child.id,kind:"implementation",
        role:"implementer",description:"Use upstream source",
        acceptanceCriteria:["Dependent version includes source"],
        dependsOn:[{taskId:"source",gate:"integrated"}]})),
    ],
  };
  const workflows=new WorkflowStore(join(data,"workflow.sqlite"));
  const agents=new AgentRegistry(join(data,"agents.sqlite"));
  const ledger=new AutopilotLedger(join(data,"ledger.sqlite"));
  let current=workflows.create("p","o",workflow);
  current=workflows.act("p","o","flow",current.revision,"start",
    {type:"start",taskId:"source"});
  current=workflows.act("p","o","flow",current.revision,"finish",
    {type:"implementation_finished",taskId:"source",headSha:sourceSha,
      criteriaRevision:0,testsPassed:true});
  current=workflows.act("p","o","flow",current.revision,"qc",
    {type:"qc_finalized",taskId:"source",runId:"qc-source-1",headSha:sourceSha,
      criteriaRevision:0,attempt:1,verdict:"pass"});
  const reservation={projectId:"p",orchestraWorkspaceId:"o",workspaceId:"wt-source",
    workflowId:"flow",taskId:"source",runId:"qc-source-1",
    seat:"qc",requestId:"auto:qc-source-1"};
  agents.reserve(reservation);
  const binding=agents.assign(reservation,"native-qc-source");
  agents.record(binding,{kind:"agent_settled",text:"Agent settled",
    sequence:1,at:Date.now()});
  const qcReceipt=ledger.sealEvidence(binding,"qc","Checked "+sourceSha);
  agents.seal("p","o","native-qc-source",qcReceipt.ref);
  const workspaces={source:"wt-source",...Object.fromEntries(
    children.map(child=>[child.id,child.workspaceId]))};
  ledger.save("p","o","flow",{
    workspaces,models,
    test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:3,
  });
  ledger.setStatus("p","o","flow",true,"Running YOLO");
  const paths=new Map([["wt-source",sourcePath],
    ...children.map(child=>[child.workspaceId,child.path])]);
  const calls=[];
  let lostMergeReply=false,mergeCount=0;
  const controller=new AbortController();
  const host={lifetimeSignal:controller.signal,
    async execFile(command){
      assert.equal(command.file,"git");
      calls.push(command.args.slice(2));
      const args=command.args;
      let stdout="",stderr="",exitCode=0;
      try{
        stdout=execFileSync(command.file,[...args],{
          encoding:"utf8",timeout:command.timeoutMs??10000,
          cwd:command.cwd,maxBuffer:1024*1024,
          env:Object.fromEntries(Object.entries(process.env)
            .filter(([key])=>!command.unsetEnv?.includes(key))),
        });
      }catch(error){
        exitCode=typeof error.status==="number"?error.status:null;
        stdout=String(error.stdout??"");stderr=String(error.stderr??"");
      }
      if(args[2]==="merge"&&args[3]==="--ff-only"){
        mergeCount++;
        if(lostMergeReply){
          lostMergeReply=false;
          throw new Error("Mock network lost response after Git completed");
        }
      }
      return {stdout,stderr,exitCode,signal:null,
        stdoutTruncated:false,stderrTruncated:false};
    }};
  const provider={version:1,async resolve({projectId,workspaceId}){
    if(projectId!=="p"||!paths.has(workspaceId))
      throw new Error("Unknown resolved PI WEB Workspace");
    return {project:{id:"p",name:"Disposable Git",path:main},
      workspace:{id:workspaceId,projectId:"p",path:paths.get(workspaceId),
        label:workspaceId,isMain:false,provider:{metadata:{isGitWorktree:true}}}};
  }};
  const permissions=new PermissionLedger(join(data,"permissions.sqlite"),
    workflows,ledger);
  const options={
    path:join(data,"convergence.sqlite"),host,workflows,agents,ledger,
    permissions,workspaces:()=>provider,
  };
  let integrator=new AutomaticIntegrator(options);
  return {root,main,data,sourcePath,sourceSha,baseline,
    children,paths,calls,workflows,agents,ledger,permissions,
    get integrator(){return integrator;},
    get mergeCount(){return mergeCount;},
    loseMergeOnce(){lostMergeReply=true;},
    reopen(){integrator.close();integrator=new AutomaticIntegrator(options);},
    async tick(){
      return integrator.step(ledger.get("p","o","flow"),
        workflows.get("p","o","flow"));
    },
    close(){
      integrator.close();permissions.close();ledger.close();
      agents.close();workflows.close();rmSync(root,{recursive:true,force:true});
    }};
}
test("Real Git ff-only propagates QC commit and unblocks an integrated DAG gate",async()=>{
  const x=fixture({});
  try{
    const consumer=x.children[0];
    assert.equal(x.workflows.get("p","o","flow").tasks[consumer.id].status,"blocked");
    assert.equal(git(consumer.path,"rev-parse","HEAD"),x.baseline);
    assert.equal(await x.tick(),"acted");
    assert.equal(x.mergeCount,1);
    assert.equal(git(consumer.path,"rev-parse","HEAD"),x.sourceSha);
    assert.equal(x.workflows.get("p","o","flow").tasks.source.status,"passed");
    assert.equal(await x.tick(),"acted");
    const current=x.workflows.get("p","o","flow");
    assert.equal(current.tasks.source.status,"integrated");
    assert.equal(current.tasks[consumer.id].status,"ready");
    assert.equal(await x.tick(),"none");
    assert.equal(x.mergeCount,1,"Never re-merge or rewrite a confirmed Git branch");
    assert.equal(x.integrator.list("p","o","flow")[0].state,"completed");
    assert.ok(!x.calls.some(args=>args.includes("--force")||
      args.includes("push")||args.includes("reset")||
      args.includes("cherry-pick")),"No Git remote/protected history actions");
    assert.equal(git(x.main,"rev-parse","HEAD"),x.baseline,
      "Protected main checkout is not modified");
  }finally{x.close();}
});
test("Fan-out convergence propagates one sealed SHA into every dependent checkout",async()=>{
  const x=fixture({fanout:3});
  try{
    for(let i=0;i<3;i++){
      assert.equal(await x.tick(),"acted");
      assert.equal(x.mergeCount,i+1);
      assert.equal(x.workflows.get("p","o","flow").tasks.source.status,"passed");
    }
    for(const child of x.children)
      assert.equal(git(child.path,"rev-parse","HEAD"),x.sourceSha);
    assert.equal(await x.tick(),"acted");
    assert.equal(x.workflows.get("p","o","flow").tasks.source.status,"integrated");
    assert.equal(x.integrator.list("p","o","flow").length,3);
  }finally{x.close();}
});
test("Ask gates exact QC SHA + dependent Worktree baseline and survives restart",async()=>{
  const x=fixture({policy:{actions:{"git.integrate":"ask"}}});
  try{
    const child=x.children[0];
    assert.equal(await x.tick(),"waiting");
    assert.equal(x.mergeCount,0);
    const approvals=x.permissions.list("p","o","flow");
    assert.equal(approvals.length,1);
    assert.equal(approvals[0].action,"git.integrate");
    assert.equal(approvals[0].headSha,x.sourceSha);
    assert.deepEqual(JSON.parse(approvals[0].target),
      [child.id,child.workspaceId,x.baseline]);
    x.reopen();
    assert.equal(await x.tick(),"waiting");
    assert.equal(x.permissions.list("p","o","flow")[0].id,approvals[0].id);
    assert.equal(x.permissions.decide("p","o",approvals[0].id,"approved").state,
      "approved");
    assert.equal(await x.tick(),"acted");
    assert.equal(x.mergeCount,1);
    assert.equal(await x.tick(),"acted");
    assert.equal(x.workflows.get("p","o","flow").tasks.source.status,"integrated");
  }finally{x.close();}
});
test("Deny does not touch a dependent checkout or create a human approval",async()=>{
  const x=fixture({policy:{actions:{"git.integrate":"deny"}}});
  try{
    assert.equal(await x.tick(),"denied");
    assert.equal(x.mergeCount,0);
    assert.equal(git(x.children[0].path,"rev-parse","HEAD"),x.baseline);
    assert.deepEqual(x.permissions.list("p","o","flow"),[]);
    assert.equal(x.workflows.get("p","o","flow").tasks.source.status,"passed");
  }finally{x.close();}
});
test("Divergent dependent Git branch never receives a forced merge or reset",async()=>{
  const x=fixture({});
  try{
    const child=x.children[0];
    writeFileSync(join(child.path,"separate.txt"),"Independent work\n");
    commit(child.path,"separate.txt","Existing independent commit");
    const divergentHead=git(child.path,"rev-parse","HEAD");
    await assert.rejects(x.tick(),/diverged.*safe fast-forward unavailable/);
    assert.equal(x.mergeCount,0);
    assert.equal(git(child.path,"rev-parse","HEAD"),divergentHead);
    assert.equal(x.integrator.list("p","o","flow").length,0);
    // The operator can review and complete a non-FF integration externally.
    git(child.path,"-c","user.name=Human",
      "-c","user.email=human@example.invalid","merge","--no-ff",
      "--no-edit",x.sourceSha);
    const manualHead=git(child.path,"rev-parse","HEAD");
    assert.notEqual(manualHead,x.sourceSha);
    assert.equal(await x.tick(),"acted",
      "Existing verified ancestry is recorded read-only, without another Git merge");
    assert.equal(x.mergeCount,0);
    assert.equal(await x.tick(),"acted");
    assert.equal(x.workflows.get("p","o","flow").tasks.source.status,"integrated");
    assert.equal(git(child.path,"rev-parse","HEAD"),manualHead);
  }finally{x.close();}
});
test("Lost response after real Git fast-forward is recovered, never blindly repeated",async()=>{
  const x=fixture({});
  try{
    const child=x.children[0];
    x.loseMergeOnce();
    await assert.rejects(x.tick(),/lost response/);
    assert.equal(x.mergeCount,1);
    assert.equal(git(child.path,"rev-parse","HEAD"),x.sourceSha);
    assert.equal(x.integrator.list("p","o","flow")[0].state,"reserved");
    x.reopen();
    assert.equal(await x.tick(),"acted","Exact expected HEAD reconciles the reserved result");
    assert.equal(x.mergeCount,1);
    assert.equal(x.integrator.list("p","o","flow")[0].state,"completed");
    assert.equal(await x.tick(),"acted");
    assert.equal(x.workflows.get("p","o","flow").tasks.source.status,"integrated");
  }finally{x.close();}
});
test("Uncertain Git merge without the expected result is never blindly repeated",async()=>{
  const x=fixture({});
  try{
    const child=x.children[0];
    x.loseMergeOnce();
    await assert.rejects(x.tick(),/lost response/);
    git(child.path,"reset","--hard",x.baseline);
    x.reopen();
    await assert.rejects(x.tick(),/Uncertain Git fast-forward/);
    assert.equal(x.mergeCount,1,"The interrupted native Git operation is never retried");
    assert.equal(x.workflows.get("p","o","flow").tasks.source.status,"passed");
  }finally{x.close();}
});
test("A dependent Worktree leased by a Pi Session is not mutated by convergence",async()=>{
  const x=fixture({});
  try{
    const child=x.children[0];
    x.agents.reserve({projectId:"p",orchestraWorkspaceId:"o",
      workspaceId:child.workspaceId,workflowId:"another",taskId:"a",
      runId:"impl-a-1",seat:"implementer",requestId:"auto:other"});
    await assert.rejects(x.tick(),/pending or active Pi Run/);
    assert.equal(x.mergeCount,0);
  }finally{x.close();}
});
