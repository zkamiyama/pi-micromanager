import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AgentRegistry} from "../dist/runtime/registry.js";

test("F10: settled automated Run remains unsealed and prevents reconfiguration",()=>{
 const dir=mkdtempSync(join(tmpdir(),"mm-audit-unsealed-"));
 const agents=new AgentRegistry(join(dir,"runs.sqlite"));
 const reservation={projectId:"p",orchestraWorkspaceId:"o",
   workspaceId:"wt",workflowId:"workflow",taskId:"api",runId:"impl-api-1",
   seat:"implementer",requestId:"auto:test"};
 try{
  agents.reserve(reservation);
  const b=agents.assign(reservation,"session-1");
  agents.record(b,{kind:"agent_settled",at:Date.now(),sequence:1,text:"Agent settled"});
  assert.equal(agents.list("p","o","active").length,0);
  assert.equal(agents.hasUnsealedAutomatedRun("p","o","workflow"),true);
  agents.seal("p","o","session-1","evidence");
  assert.equal(agents.hasUnsealedAutomatedRun("p","o","workflow"),false);
 }finally{agents.close();rmSync(dir,{recursive:true,force:true});}
});
