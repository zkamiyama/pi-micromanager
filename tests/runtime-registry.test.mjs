import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry } from "../dist/runtime/registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function fixture(cb) {
 const dir=mkdtempSync(join(tmpdir(),"pi-mm-runtime-"));
 const db=new AgentRegistry(join(dir,"agents.sqlite"));
 try {return cb(db)} finally {db.close();rmSync(dir,{recursive:true,force:true});}
}
const reservation=(task="api",seat="implementer",requestId="req1")=>({
 projectId:"project",workspaceId:"worktree",workflowId:"auth",taskId:task,seat,requestId
});
test("seat reservation remains idempotent but blocks conflicting launches",()=>fixture(db=>{
 const key=reservation();assert.equal(db.reserve(key).phase,"reserved");
 assert.equal(db.reserve(key).requestId,"req1");
 assert.throws(()=>db.reserve(reservation("api","implementer","req2")),/already has/);
 assert.equal(db.assign(key,"session-1").sessionId,"session-1");
 assert.equal(db.get("project","worktree","session-1").taskId,"api");
 assert.throws(()=>db.get("project","different","session-1"),/not registered/);
}));
test("implementers require separate worktrees; QC can share a workspace",()=>fixture(db=>{
 db.reserve(reservation());
 assert.throws(()=>db.reserve(reservation("ui","implementer","req2")),/worktree/);
 db.reserve(reservation("api","qc","req3"));
 assert.equal(db.list("project","worktree").length,2);
}));
test("activity stores a bounded event history without token delta duplication",()=>fixture(db=>{
 const key=reservation();
 db.reserve(key);
 const binding=db.assign(key,"session-1");
 for(let i=0;i<100;i++) db.record(binding,{kind:"tool_started",text:"read",at:1700000000000+i,sequence:i+1});
 db.record(binding,{kind:"message_delta",text:"current text",at:1700000010000,sequence:101});
 assert.equal(db.activities("project","worktree","session-1").length,60);
 assert.equal(db.get("project","worktree","session-1").latestText,"current text");
}));
