/** Disposable real Git demonstration of model-repairable final merge conflicts.
 * The test represents a Pi conflict-fix with deterministic file commands;
 * no authenticated model, remote GitHub or user branch is touched. */
import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkflowStore} from "../dist/core/store.js";
import {createHostExecutor} from "../dist/automation/host-port.js";
function git(path,...args){
  return execFileSync("git",["-C",path,...args],{encoding:"utf8",
    timeout:12000,maxBuffer:1024*1024}).trim();
}
function commit(path,name){
  git(path,"add","component.txt");
  git(path,"-c","user.name=Final Test","-c","user.email=final@example.invalid",
    "commit","-m",name);
}
test("Real divergent leaf commits can be merge-conflicted, repaired, committed and independently QC verified",async()=>{
 const root=mkdtempSync(join(tmpdir(),"mm-final-merge-"));
 const base=join(root,"main"),srcA=join(root,"api"),
   srcB=join(root,"frontend"),combined=join(root,"final");
 mkdirSync(base,{recursive:true});
 const wfFile=join(root,"wf.sqlite");
 let workflows;
 try{
   execFileSync("git",["init","-b","main",base],{encoding:"utf8"});
   writeFileSync(join(base,"component.txt"),"baseline\n");
   commit(base,"baseline");
   const baseline=git(base,"rev-parse","HEAD");
   git(base,"worktree","add","-b","feature/api",srcA,baseline);
   git(base,"worktree","add","-b","feature/frontend",srcB,baseline);
   git(base,"worktree","add","-b","feature/final",combined,baseline);
   writeFileSync(join(srcA,"component.txt"),"api implementation\n");
   commit(srcA,"api source");
   const apiSha=git(srcA,"rev-parse","HEAD");
   writeFileSync(join(srcB,"component.txt"),"frontend implementation\n");
   commit(srcB,"frontend source");
   const uiSha=git(srcB,"rev-parse","HEAD");
   assert.notEqual(apiSha,uiSha);
   workflows=new WorkflowStore(wfFile);
   const spec={id:"combined",title:"Combine independent changes",
     maxQcRounds:2,maxParallelByRole:{
       implementer:2,reviewer:1,planner:1,architect:1},
     tasks:[
       {id:"api",title:"API",kind:"implementation",role:"implementer",
         dependsOn:[],description:"API change",acceptanceCriteria:["API works"]},
       {id:"ui",title:"Frontend",kind:"implementation",role:"implementer",
         dependsOn:[],description:"Frontend change",acceptanceCriteria:["UI works"]},
     ]};
   let state=workflows.create("p","o",spec);
   for(const [id,sha] of [["api",apiSha],["ui",uiSha]]){
     state=workflows.act("p","o","combined",state.revision,"start-"+id,
       {type:"start",taskId:id});
     state=workflows.act("p","o","combined",state.revision,"finish-"+id,
       {type:"implementation_finished",taskId:id,headSha:sha,
         criteriaRevision:0,testsPassed:true});
     state=workflows.act("p","o","combined",state.revision,"qc-"+id,
       {type:"qc_finalized",taskId:id,runId:"qc-"+id+"-1",headSha:sha,
         criteriaRevision:0,attempt:1,verdict:"pass"});
   }
   state=workflows.act("p","o","combined",state.revision,"prepare",
     {type:"prepare_final_integration"});
   const host={lifetimeSignal:new AbortController().signal,
     async execFile(command){
       try{
         const stdout=execFileSync(command.file,[...(command.args??[])],{
           encoding:"utf8",cwd:command.cwd,timeout:12000,maxBuffer:1024*1024});
         return {stdout,stderr:"",exitCode:0,signal:null,
           stdoutTruncated:false,stderrTruncated:false};
       }catch(error){
         return {stdout:String(error.stdout??""),stderr:String(error.stderr??""),
           exitCode:typeof error.status==="number"?error.status:null,
           signal:error.signal??null,stdoutTruncated:false,stderrTruncated:false};
       }
     }};
   const port=createHostExecutor({
     host,workflows,agents:{},
     getSessions:()=>undefined,
     getWorkspaces:()=>({version:1,async resolve({projectId,workspaceId}){
       assert.equal(projectId,"p");assert.equal(workspaceId,"wt-final");
       return {project:{id:"p",name:"Private test",path:base},
         workspace:{id:"wt-final",projectId:"p",path:combined,
           label:"Final test",isMain:false,
           provider:{metadata:{isGitWorktree:true}}}};
     }}),
     probe:async()=>{throw Error("Unneeded");},validateRun:()=>"",
     replaySettledReport:async()=>{},notify(){},
   });
   const cfg={finalization:{workspaceId:"wt-final",autoMerge:true},
     test:{execution:"trusted-host",file:"node",args:["--version"],timeoutMs:8000}};
   const binding={projectId:"p",orchestraWorkspaceId:"o",
     workflowId:"combined",workspaceId:"wt-final",taskId:"mm-final-integration"};
   await assert.rejects(port.verify(binding,cfg),
     /missing QC-approved source commit/);
   // First no-ff merge keeps the other independent branch unmerged.
   git(combined,"-c","user.name=Final Test",
     "-c","user.email=final@example.invalid",
     "merge","--no-ff","--no-edit",apiSha);
   await assert.rejects(port.verify(binding,cfg),
     /missing QC-approved source commit/);
   // The second independent branch conflicts in the same file.
   assert.throws(()=>git(combined,"-c","user.name=Final Test",
     "-c","user.email=final@example.invalid",
     "merge","--no-ff","--no-edit",uiSha));
   assert.match(git(combined,"status","--porcelain"),/UU component.txt/);
   // The repair step is what a final-integration Pi implementation Run can do.
   writeFileSync(join(combined,"component.txt"),
     "api implementation\nfrontend implementation\n");
   commit(combined,"Resolve independent branches");
   const finalSha=git(combined,"rev-parse","HEAD");
   assert.notEqual(finalSha,apiSha);
   assert.notEqual(finalSha,uiSha);
   git(combined,"merge-base","--is-ancestor",apiSha,finalSha);
   git(combined,"merge-base","--is-ancestor",uiSha,finalSha);
   const result=await port.verify(binding,cfg);
   assert.equal(result.headSha,finalSha);
   assert.equal(result.clean,true);
   assert.equal(result.testsPassed,true);
   assert.match(readFileSync(join(combined,"component.txt"),"utf8"),
     /api implementation\nfrontend implementation/);
   assert.equal(git(base,"rev-parse","HEAD"),baseline,
     "The project main checkout is untouched before GitHub PR review");
 }finally{
   workflows?.close();
   rmSync(root,{recursive:true,force:true});
 }
});
