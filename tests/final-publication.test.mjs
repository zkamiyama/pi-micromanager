import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkflowStore} from "../dist/core/store.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {PermissionLedger} from "../dist/automation/permissions.js";
import {PublicationManager} from "../dist/automation/publication.js";
const SOURCE="a".repeat(40),FINAL="f".repeat(40);
const profile={provider:"mock",model:"mock"};
function fixture(override={}){
 const dir=mkdtempSync(join(tmpdir(),"mm-final-pr-"));
 const workflows=new WorkflowStore(join(dir,"wf.sqlite"));
 const agents=new AgentRegistry(join(dir,"agents.sqlite"));
 const ledger=new AutopilotLedger(join(dir,"ledger.sqlite"));
 const config={workspaces:{api:"wt-api"},
   models:{implementer:profile,qc:profile,architect:profile,planner:profile},
   finalization:{workspaceId:"wt-final",autoMerge:true},
   publication:{remote:"origin",baseBranch:"main",draft:true},
   test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:3};
 let wf=workflows.create("p","o",{id:"all-done",title:"QC-gated final merge",
   maxQcRounds:3,maxParallelByRole:{
     implementer:1,reviewer:1,architect:1,planner:1},
   ...(override.policy?{permissions:override.policy}:{}),
   tasks:[{id:"api",title:"API task",kind:"implementation",role:"implementer",
     dependsOn:[],description:"API contract",acceptanceCriteria:["Pass tests"]}],
 });
 wf=workflows.act("p","o","all-done",wf.revision,"start",{type:"start",taskId:"api"});
 wf=workflows.act("p","o","all-done",wf.revision,"finish",{
   type:"implementation_finished",taskId:"api",headSha:SOURCE,
   criteriaRevision:0,testsPassed:true});
 wf=workflows.act("p","o","all-done",wf.revision,"qc",{
   type:"qc_finalized",taskId:"api",runId:"qc-api-1",verdict:"pass",
   headSha:SOURCE,criteriaRevision:0,attempt:1});
 wf=workflows.act("p","o","all-done",wf.revision,"auto:prepare:final-integration",
   {type:"prepare_final_integration"});
 wf=workflows.act("p","o","all-done",wf.revision,"startfinal",{
   type:"start",taskId:"mm-final-integration"});
 wf=workflows.act("p","o","all-done",wf.revision,"finishfinal",{
   type:"implementation_finished",taskId:"mm-final-integration",
   headSha:FINAL,criteriaRevision:0,testsPassed:true});
 wf=workflows.act("p","o","all-done",wf.revision,"qcfinal",{
   type:"qc_finalized",taskId:"mm-final-integration",
   runId:"qc-mm-final-integration-1",verdict:"pass",headSha:FINAL,
   criteriaRevision:0,attempt:1});
 const reserve={projectId:"p",orchestraWorkspaceId:"o",
   workspaceId:"wt-final",workflowId:"all-done",taskId:"mm-final-integration",
   runId:"qc-mm-final-integration-1",seat:"qc",requestId:"auto:final-qc"};
 agents.reserve(reserve);const binding=agents.assign(reserve,"pi-qc-final");
 agents.record(binding,{kind:"agent_settled",text:"Agent settled",
   at:Date.now(),sequence:1});
 const proof=ledger.sealEvidence(binding,"qc","Final independent QC PASS "+FINAL);
 agents.seal("p","o","pi-qc-final",proof.ref);
 ledger.save("p","o","all-done",config);
 ledger.setStatus("p","o","all-done",true,"running");
 const approvals=new PermissionLedger(join(dir,"approvals.sqlite"),
   workflows,ledger);
 let remoteSha=null,pr=null;
 let pushes=0,creates=0,readyCount=0,mergeCount=0,loseMerge=false;
 let commit=FINAL,dirty=false,ancestry=true,ciState="pass";
 const commands=[];
 const output=(stdout="",exitCode=0)=>({stdout,exitCode,signal:null,
   stderr:"",stdoutTruncated:false,stderrTruncated:false});
 const host={lifetimeSignal:new AbortController().signal,
   async execFile(request){
     const args=request.args??[];
     commands.push([request.file,...args]);
     if(request.file==="git"){
       const command=args.slice(2).join(" ");
       if(command==="rev-parse --show-toplevel")return output("/repo/final\n");
       if(command==="rev-parse HEAD")return output(commit+"\n");
       if(command==="status --porcelain")return output(dirty?"??dirty.txt\n":"");
       if(command==="symbolic-ref --quiet --short HEAD")return output("feature/final\n");
       if(command==="remote get-url origin")
         return output("https://github.com/acme/final-project.git\n");
       if(command==="merge-base --is-ancestor "+SOURCE+" "+FINAL)
         return output("",ancestry?0:1);
       if(command==="ls-remote --heads origin refs/heads/feature/final")
         return output(remoteSha?remoteSha+"\trefs/heads/feature/final\n":"");
       if(command==="push --porcelain origin HEAD:refs/heads/feature/final"){
         pushes++;remoteSha=FINAL;return output("Pushed verified final commit\n");
       }
       throw new Error("Unexpected git "+command);
     }
     if(request.file==="gh"){
       const command=args.slice(0,2).join(" ");
       if(command==="pr list")return output(JSON.stringify(pr?[pr]:[]));
       if(command==="pr create"){
         creates++;pr={number:7,url:"https://github.com/acme/final-project/pull/7",
           headRefName:"feature/final",baseRefName:"main",headRefOid:FINAL,
           isDraft:true,state:"OPEN",autoMergeRequest:null};
         return output(pr.url);
       }
       if(command==="pr view")return output(JSON.stringify(pr));
       if(command==="pr ready"){
         readyCount++;if(!pr)throw Error("No PR");
         pr.isDraft=false;return output("Review requested\n");
       }
       if(command==="pr checks"){
         const bucket=ciState==="none"?[]:[{name:"build-and-test",bucket:ciState}];
         return output(JSON.stringify(bucket),ciState==="pending"?8:
           ciState==="fail"?1:0);
       }
       if(command==="pr merge"){
         mergeCount++;if(!pr||pr.isDraft)throw Error("Cannot merge draft");
         if(!args.includes("--match-head-commit")||
           args[args.indexOf("--match-head-commit")+1]!==FINAL||
           args.includes("--admin")||args.includes("--auto"))
           throw Error("Unsafe GitHub merge options");
         pr.state="MERGED";
         if(loseMerge){loseMerge=false;throw Error("Lost GitHub merge response");}
         return output("GitHub merged verified commit\n");
       }
       throw new Error("Unexpected gh "+args.join(" "));
     }
     throw new Error("Unexpected host binary "+request.file);
   }};
 const provider={version:1,async resolve({projectId,workspaceId}){
   if(projectId!=="p"||workspaceId!=="wt-final")throw Error("Wrong Workspace");
   return {project:{id:"p",name:"Fixture",path:"/repo"},
     workspace:{id:"wt-final",projectId:"p",path:"/repo/final",
       isMain:false,provider:{metadata:{isGitWorktree:true}},label:"Final"}};
 }};
 const options={path:join(dir,"publication.sqlite"),host,
   workflows,agents,ledger,permissions:approvals,workspaces:()=>provider};
 let publisher=new PublicationManager(options);
 return {workflows,agents,ledger,approvals,config,commands,proof,
   get publisher(){return publisher;},
   get pushes(){return pushes;},get creates(){return creates;},
   get readyCount(){return readyCount;},get mergeCount(){return mergeCount;},
   get pr(){return pr;},
   setDirty(v){dirty=v;},setCommit(v){commit=v;},setAncestry(v){ancestry=v;},
   markMerged(){pr.state="MERGED";pr.autoMergeRequest=null;},
   setCi(v){ciState=v;},
   loseMerge(){loseMerge=true;},
   reopen(){publisher.close();publisher=new PublicationManager(options);},
   tick(){return publisher.step(ledger.get("p","o","all-done"),
      workflows.get("p","o","all-done"));},
   close(){publisher.close();approvals.close();ledger.close();
     agents.close();workflows.close();rmSync(dir,{recursive:true,force:true});}};
}
test("Final QC publishes only the verified SHA and waits for CI before a protected merge",async()=>{
 const x=fixture();
 try{
   assert.equal(await x.tick(),"acted");assert.equal(x.pushes,1);
   assert.equal(await x.tick(),"acted");assert.equal(x.creates,1);
   assert.equal(x.pr.isDraft,true);
   assert.equal(await x.tick(),"acted");assert.equal(x.readyCount,1);
   assert.equal(x.pr.isDraft,false);
   assert.equal(await x.tick(),"acted");assert.equal(x.mergeCount,1);
   assert.equal(x.pr.state,"MERGED");
   assert.equal(await x.tick(),"acted");
   assert.equal(await x.tick(),"none");
   assert.equal(x.mergeCount,1,"Never repeat a confirmed GitHub merge");
   assert.ok(x.publisher.list("p","o","all-done")
     .some(r=>r.action==="github.pr.merge"&&r.state==="completed"));
   assert.ok(!x.commands.some(x=>x.some(arg=>
     arg==="--admin"||arg==="--delete-branch"||arg==="--force"||arg==="reset")));
   const done=x.workflows.get("p","o","all-done");
   assert.equal(done.tasks["mm-final-integration"].status,"integrated");
   assert.equal(done.tasks.api.status,"integrated");
   assert.equal(done.tasks["mm-final-integration"].lastQc.headSha,FINAL,
     "A remotely merged PR never replaces original QC evidence");
 }finally{x.close();}
});
test("Merge ask holds the Draft PR and never calls gh pr ready until exact final QC approved",async()=>{
 const x=fixture({policy:{actions:{"github.pr.merge":"ask"}}});
 try{
   await x.tick();await x.tick();
   assert.equal(await x.tick(),"waiting");
   assert.equal(x.readyCount,0);assert.equal(x.mergeCount,0);
   const request=x.approvals.list("p","o","all-done")[0];
   assert.equal(request.action,"github.pr.merge");
   assert.equal(request.headSha,FINAL);
   assert.equal(request.runId,"qc-mm-final-integration-1");
   x.reopen();assert.equal(await x.tick(),"waiting");
   x.approvals.decide("p","o",request.id,"approved");
   assert.equal(await x.tick(),"acted");
   assert.equal(x.readyCount,1);
   assert.equal(await x.tick(),"acted");
   assert.equal(x.mergeCount,1);
 }finally{x.close();}
});
test("Deny merge leaves Draft PR reviewable without making GitHub auto-merge requests",async()=>{
 const x=fixture({policy:{actions:{"github.pr.merge":"deny"}}});
 try{
   await x.tick();await x.tick();
   assert.equal(await x.tick(),"none");
   assert.equal(x.pr.isDraft,true);
   assert.equal(x.readyCount,0);
   assert.equal(x.mergeCount,0);
   assert.equal(x.approvals.list("p","o","all-done").length,0);
 }finally{x.close();}
});
test("Lost direct-merge response recovers only from exact GitHub MERGED state",async()=>{
 const x=fixture();
 try{
   await x.tick();await x.tick();await x.tick();
   x.loseMerge();
   await assert.rejects(x.tick(),/Lost GitHub merge response/);
   assert.equal(x.mergeCount,1);
   x.reopen();
   assert.equal(await x.tick(),"acted");
   assert.equal(x.mergeCount,1,"Do not duplicate ambiguous GitHub merge");
   assert.equal(await x.tick(),"none");
 }finally{x.close();}
});
test("Final publish requires actual ancestry of all original QC SHAs",async()=>{
 const x=fixture();
 try{
   x.setAncestry(false);
   await assert.rejects(x.tick(),/does not contain/);
   assert.equal(x.pushes,0);assert.equal(x.creates,0);
 }finally{x.close();}
});
test("A dirty or stale final checkout cannot be remotely published or merged",async()=>{
 const x=fixture();
 try{
   x.setDirty(true);await assert.rejects(x.tick(),/uncommitted/);
   x.setDirty(false);x.setCommit("e".repeat(40));
   await assert.rejects(x.tick(),/differs from QC/);
   assert.equal(x.pushes,0);
 }finally{x.close();}
});

test("Missing or pending CI never promotes a PR to MERGED",async()=>{
 const x=fixture();
 try{
   await x.tick();await x.tick();await x.tick();
   x.setCi("none");
   assert.equal(await x.tick(),"checks_pending");
   assert.equal(x.mergeCount,0);
   x.setCi("pending");
   assert.equal(await x.tick(),"checks_pending");
   assert.equal(x.mergeCount,0);
   x.reopen();
   x.setCi("pass");
   assert.equal(await x.tick(),"acted");
   assert.equal(x.mergeCount,1);
 }finally{x.close();}
});
test("Failing GitHub CI prevents merging even with host QC PASS",async()=>{
 const x=fixture();
 try{
   await x.tick();await x.tick();await x.tick();
   x.setCi("fail");
   await assert.rejects(x.tick(),/checks failed/);
   assert.equal(x.mergeCount,0);
   assert.equal(x.pr.state,"OPEN");
 }finally{x.close();}
});
