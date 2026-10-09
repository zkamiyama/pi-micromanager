import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry } from "../dist/runtime/registry.js";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),"pi-mm-runs-"));
 const db=new AgentRegistry(join(dir,"agents.sqlite"));
 try{return fn(db)}finally{db.close();rmSync(dir,{recursive:true,force:true});}
}
const reservation=(runId="impl-auth-1",seat="implementer",workspaceId="wt-1",requestId="request-1")=>({
 projectId:"project",orchestraWorkspaceId:"orchestra-main",workspaceId,
 workflowId:"auth-migration",taskId:"auth",runId,seat,requestId
});
const event=(kind,sequence)=>({kind,text:kind,at:1700000000000+sequence,sequence});

test("per-attempt run IDs create fresh sessions without replacing previous Luna history",()=>fixture(db=>{
 const first=reservation();
 db.reserve(first);db.assign(first,"session-impl-1");
 db.record(db.get("project","orchestra-main","session-impl-1"),event("agent_settled",1));
 const sealed=db.seal("project","orchestra-main","session-impl-1","sha256:first-result");
 assert.equal(sealed.phase,"sealed");
 const second=reservation("impl-auth-2","implementer","wt-1","request-2");
 db.reserve(second);db.assign(second,"session-impl-2");
 assert.equal(db.list("project","orchestra-main","active").length,1);
 assert.equal(db.list("project","orchestra-main","history").length,1);
 assert.notEqual(db.getRun("project","orchestra-main","auth-migration","impl-auth-1").sessionId,
   db.getRun("project","orchestra-main","auth-migration","impl-auth-2").sessionId);
 assert.throws(()=>db.update(sealed,"configured"),/cannot be reused/);
}));

test("each QC round gets a fresh Pi Session and immutable run identity",()=>fixture(db=>{
 const one=reservation("qc-auth-1","qc","wt-review","q1");
 const two=reservation("qc-auth-2","qc","wt-review","q2");
 db.reserve(one);db.assign(one,"qc-session-1");
 db.record(db.get("project","orchestra-main","qc-session-1"),event("agent_settled",1));
 db.reserve(two);db.assign(two,"qc-session-2");
 assert.equal(db.list("project","orchestra-main","all").length,2);
 assert.equal(db.list("project","orchestra-main","active").length,1);
 assert.equal(db.list("project","orchestra-main","history").length,1);
}));

test("one run request cannot duplicate a Session; new attempt needs distinct run and request IDs",()=>fixture(db=>{
 const first=reservation();
 assert.equal(db.reserve(first).phase,"reserved");
 assert.equal(db.reserve(first).phase,"reserved");
 assert.throws(()=>db.reserve(reservation("impl-auth-1","implementer","wt-1","other-request")),/different/);
 assert.throws(()=>db.reserve(reservation("impl-auth-2","implementer","wt-2","request-1")),/UNIQUE/);
 db.assign(first,"session-1");
 assert.equal(db.reserve(first).sessionId,"session-1");
}));

test("two concurrent implementers cannot share a worktree; independent worktrees can",()=>fixture(db=>{
 db.reserve(reservation());
 assert.throws(()=>db.reserve(reservation("impl-other-1","implementer","wt-1","req-other")),/leased/);
 db.reserve(reservation("impl-other-1","implementer","wt-2","req-other"));
 assert.equal(db.list("project","orchestra-main","active").length,2);
}));

test("run completion does not imply cleanup; sealing needs settled state and evidence",()=>fixture(db=>{
 const entry=reservation();db.reserve(entry);db.assign(entry,"session-1");
 assert.throws(()=>db.seal("project","orchestra-main","session-1","evidence"),/Only settled/);
 db.record(db.get("project","orchestra-main","session-1"),event("agent_settled",2));
 assert.equal(db.get("project","orchestra-main","session-1").phase,"settled");
 db.seal("project","orchestra-main","session-1","git-sha");
 assert.equal(db.get("project","orchestra-main","session-1").evidenceRef,"git-sha");
}));

test("streaming token deltas never create unlimited event history",()=>fixture(db=>{
 const entry=reservation();db.reserve(entry);const binding=db.assign(entry,"session-1");
 for(let i=0;i<99;i++)db.record(binding,event("tool_started",i+1));
 db.record(binding,{kind:"message_delta",text:"public progress",sequence:100,at:1700000010000});
 assert.equal(db.activities("project","orchestra-main","session-1").length,60);
 assert.equal(db.get("project","orchestra-main","session-1").latestText,"public progress");
}));

test("QC snapshot leases prevent writers until QC evidence is sealed",()=>fixture(db=>{
 const qc=reservation("qc-api-1","qc","linked-wt","review-1");
 db.reserve(qc);db.assign(qc,"qc-session");
 const impl=reservation("impl-api-2","implementer","linked-wt","write-2");
 assert.throws(()=>db.reserve(impl),/leased/);
 db.record(db.get("project","orchestra-main","qc-session"),event("agent_settled",3));
 assert.throws(()=>db.reserve(impl),/leased/);
 db.seal("project","orchestra-main","qc-session","sha256:verified-review");
 assert.equal(db.reserve(impl).phase,"reserved");
}));
test("A QC Run cannot begin before its active writer relinquishes the worktree",()=>fixture(db=>{
 const impl=reservation("impl-a-1","implementer","linked-wt","write-1");
 db.reserve(impl);
 assert.throws(()=>db.reserve(reservation("qc-a-1","qc","linked-wt","review-1")) ,/leased/);
}));
