import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";

test("F05: automated workflow ownership remains visible after >200 later runs",()=>{
 const dir=mkdtempSync(join(tmpdir(),"mm-audit-history-"));
 const agents=new AgentRegistry(join(dir,"agents.sqlite"));
 try{
  agents.reserve({projectId:"p",orchestraWorkspaceId:"o",workflowId:"original",
    taskId:"api",runId:"impl-api-1",seat:"implementer",workspaceId:"old-worktree",requestId:"auto:original"});
  for(let i=0;i<205;i++){
   const w="other-"+i;
   agents.reserve({projectId:"p",orchestraWorkspaceId:"o",workflowId:w,
     taskId:"api",runId:"impl-api-1",seat:"implementer",
     workspaceId:"wt-"+i,requestId:"manual-"+i});
  }
  assert.equal(agents.list("p","o","all").some(x=>x.workflowId==="original"),false);
  assert.equal(agents.hasAutomatedRun("p","o","original"),true);
  assert.equal(agents.hasAutomatedRun("p","o","other-0"),false);
 }finally{agents.close();rmSync(dir,{recursive:true,force:true});}
});
test("F09: enabled workflow discovery is unbounded independently of UI history",()=>{
 const dir=mkdtempSync(join(tmpdir(),"mm-audit-config-"));
 const ledger=new AutopilotLedger(join(dir,"ledger.sqlite"));
 const models=Object.fromEntries(["planner","implementer","qc","architect"]
  .map(x=>[x,{provider:"test",model:"test"}]));
 const config={workspaces:{},models,test:{file:"node",args:["--test"]},maxAttempts:2};
 try{
  ledger.save("p","o","old-enabled",config);
  ledger.setStatus("p","o","old-enabled",true,"running");
  for(let i=0;i<205;i++)ledger.save("p","o","new-"+i,config);
  assert.equal(ledger.list().some(x=>x.workflowId==="old-enabled"),false);
  assert.equal(ledger.listEnabled().some(x=>x.workflowId==="old-enabled"),true);
 }finally{ledger.close();rmSync(dir,{recursive:true,force:true});}
});
