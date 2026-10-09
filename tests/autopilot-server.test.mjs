import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import serverPlugin from "../dist/pi-web/server.js";
import { CONTROL_CHANNEL, RECEIPT_CHANNEL, ACTIVITY_CHANNEL } from "../dist/runtime/protocol.js";
import { REPORT_CHANNEL } from "../dist/automation/report.js";

const SHA = "a".repeat(40);
const definition = {
  id:"wf",title:"Build a verified endpoint",maxQcRounds:3,
  maxParallelByRole:{implementer:1,reviewer:1,architect:1,planner:1},
  tasks:[{id:"api",title:"Implement API",kind:"implementation",role:"implementer",
    description:"Create the endpoint",acceptanceCriteria:["HTTP 200"],dependsOn:[]}],
};
const profile = {provider:"local-provider",model:"exact-model"};
const config = {
  workspaces:{api:"worktree-api"},
  models:{implementer:profile,qc:profile,architect:profile,planner:profile},
  test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:3,
};

function fakePluginHost(shared) {
  const dir = shared?.dir??mkdtempSync(join(tmpdir(),"pi-mm-server-"));
  const lifetime = new AbortController();
  const sessions = shared?.sessions??new Map();
  const calls = [];
  const createdWorktrees=new Map();
  let serial = sessions.size;
  const workspace = id => ({
    id,projectId:"project",path:id==="orchestra"?"/repo":id==="wt-integrated"?"/repo/integrated":"/repo/api",
    isMain:id==="orchestra",
    label:id,
    ...(id==="orchestra"?{}:{provider:{metadata:{isGitWorktree:true}}}),
  });
  const workspaces = {
    version:1,
    async resolve({projectId,workspaceId}) {
      if(projectId!=="project"||!["orchestra","worktree-api","wt-integrated"].includes(workspaceId))
        throw new Error("Unknown linked workspace");
      return {project:{id:"project",name:"Project",path:"/repo"},
        workspace:workspace(workspaceId)};
    },
  };
  function createSession() {
    const id="pi-session-"+(++serial);
    const subscribers=new Set();
    const session={
      id,commands:[],
      publish(channel,data) {
        for(const listeners of subscribers)for(const h of listeners.get(channel)??[])h(data);
      },
      connect() {
        const listeners=new Map();
        subscribers.add(listeners);
        return {
          signal:new AbortController().signal,
          on(channel,handler) {
            const set=listeners.get(channel)??new Set();
            set.add(handler);listeners.set(channel,set);
            return ()=>set.delete(handler);
          },
          emit(channel,data) {
            if(channel!==CONTROL_CHANNEL)throw new Error("Unexpected channel");
            session.commands.push(data);
            const response={requestId:data.requestId,status:"ok"};
            if(data.type==="probe")Object.assign(response,{idle:true,fresh:true});
            if(data.type==="configure")Object.assign(response,{
              provider:data.provider,model:data.model,effort:data.effort??"off",
            });
            if(data.type==="inspect")Object.assign(response,{
              jobRunId:session.commands.find(c=>c.type==="configure")?.job?.runId,
              idle:session.completed===true,
              turnSettled:session.completed===true,turnInterrupted:false,
              hasReport:session.reported===true,
            });
            session.publish(RECEIPT_CHANNEL,response);
            if(data.type==="inspect"&&session.report)
              session.publish(REPORT_CHANNEL,session.report);
          },
          close(){subscribers.delete(listeners);},
        };
      },
      report:undefined,reported:false,completed:false,
      finish(report) {
        if(report){
          session.report=report;
          session.reported=true;
          session.publish(REPORT_CHANNEL,report);
        }
        session.completed=true;
        session.publish(ACTIVITY_CHANNEL,{
          kind:"agent_settled",at:Date.now(),sequence:1,text:"Agent settled",
        });
      },
    };
    sessions.set(id,session);
    return session;
  }
  const backend=serverPlugin.activate({
    apiVersion:3,pluginId:"micromanager",packageRoot:dir,dataDirectory:dir,
    lifetimeSignal:lifetime.signal,signal:new AbortController().signal,
    settings:{},
    logger:{debug(){},info(){},warn(){},error(){}},
    execFile:async request=>{
      calls.push({file:request.file,args:[...(request.args??[])],cwd:request.cwd});
      const args=request.args??[];
      if(request.file==="git"){
        const command=args.slice(2).join(" ");
        if(command==="rev-parse --show-toplevel")
          return result(args[1]+"\n");
        if(command==="rev-parse HEAD")
          return result(args[1]==="/repo/integrated"?"c".repeat(40)+"\n":SHA+"\n");
        if(command==="status --porcelain")
          return result("");
        if(command.startsWith("merge-base --is-ancestor "))
          return result("");
        if(command.startsWith("show-ref --verify --quiet "))
          return {...result(""),exitCode:1};
        if(command.startsWith("worktree add --no-track -b ")){
          const branch=args[6],path=args[args.length-2],sha=args[args.length-1];
          mkdirSync(path,{recursive:true,mode:0o700});
          createdWorktrees.set(path,{branch,sha});
          return result("");
        }
        if(command==="worktree list --porcelain -z"){
          return result([...createdWorktrees].map(([path,tree])=>
            "worktree "+path+"\0HEAD "+tree.sha+"\0branch refs/heads/"+tree.branch+"\0\0").join(""));
        }
        throw new Error("Unexpected git command: "+command);
      }
      if(request.file==="node"&&args.join(" ")==="--test")
        return result("mock test suite success\n");
      throw new Error("Unexpected host process request "+request.file);
    },
  });
  function result(stdout){return {exitCode:0,signal:null,stdout,stderr:"",
    stdoutTruncated:false,stderrTruncated:false};}
  const capabilities={
    resolve(capability){
      if(capability.id==="pi-sessions")
        return {version:1,create:async()=>({sessionId:createSession().id})};
      if(capability.id==="pi-session-events")
        return {version:1,connect:async({sessionId})=>{
          const s=sessions.get(sessionId);
          if(!s)throw new Error("Session not found");
          return s.connect();
        }};
      if(capability.id==="workspaces")return workspaces;
      throw new Error("Unknown public PI WEB capability "+capability.id);
    },
  };
  const activate=async()=>{
    const resolved=await backend;
    await resolved.start({capabilities,signal:new AbortController().signal});
    return resolved;
  };
  const request=async(operation,input)=>{
    const resolved=await backend;
    return resolved.peer.request({
      project:{id:"project",name:"Project",path:"/repo"},
      workspace:workspace("orchestra"),
      operation,input,signal:new AbortController().signal,
    });
  };
  const cleanup=async(preserve=false)=>{
    lifetime.abort();
    const resolved=await backend;
    await resolved.dispose(new AbortController().signal);
    if(!preserve)rmSync(dir,{recursive:true,force:true});
  };
  return {activate,request,cleanup,sessions,calls,createdWorktrees,shared:{dir,sessions}};
}
async function eventually(callback,timeout=6500){
  const started=Date.now();
  let last;
  while(Date.now()-started<timeout){
    try{
      const value=await callback();
      if(value)return value;
    }catch(error){last=error;}
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  throw last??new Error("Timed out waiting for server operation");
}
test("Public plugin bridge runs a real configured one-shot implementer and QC, never autointegrates",async()=>{
  const host=fakePluginHost();
  try{
    await host.activate();
    await host.request("create",definition);
    await host.request("auto.configure",{workflowId:"wf",config});
    await host.request("auto.start",{workflowId:"wf"});
    const first=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="implementation")&&
      s.commands.some(c=>c.type==="message"&&c.delivery==="newTurn")));
    assert.equal(first.commands.find(c=>c.type==="configure").job.runId,"impl-api-1");
    assert.equal(first.commands.find(c=>c.type==="configure").model,"exact-model");
    assert.match(first.commands.find(c=>c.type==="message").text,/HTTP 200/);
    first.finish();
    await eventually(async()=>((await host.request("get","wf")).tasks.api.status==="awaiting_qc"));
    const qc=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="qc")&&
      s.commands.some(c=>c.type==="message")));
    assert.notEqual(qc.id,first.id);
    // Simulate a native Pi report persisted while the server missed its event.
    // On settlement the host must inspect the SAME Session, never redo QC.
    qc.report={kind:"qc",runId:"qc-api-1",verdict:"pass",
      summary:"Read-only contract and host tests passed",at:Date.now()};
    qc.reported=true;
    qc.finish();
    await eventually(async()=>((await host.request("get","wf")).tasks.api.status==="passed"));
    const wf=await host.request("get","wf");
    assert.equal(wf.tasks.api.status,"passed");
    assert.equal(wf.tasks.api.lastQc.headSha,SHA);
    const all=await host.request("agents.list",{view:"all"});
    assert.equal(all.filter(b=>b.phase==="sealed").length,2);
    assert.ok(qc.commands.some(x=>x.type==="inspect"),
      "A lost native report is recovered with read-only inspection");
    assert.equal(host.sessions.size,2,"No duplicate hosted Sessions");
    assert.ok(host.calls.some(c=>c.file==="node"&&c.cwd==="/repo/api"));
    assert.ok(host.calls.some(c=>c.file==="git"&&c.args.includes("status")));
    assert.ok(!host.calls.some(c=>c.file==="git"&&c.args.includes("merge")),
      "No automatic Git merge is performed");
  }finally{await host.cleanup();}
});
test("Read-only Sol goal report does not create or execute a DAG before explicit acceptance",async()=>{
  const host=fakePluginHost();
  try{
    await host.activate();
    const goal=await host.request("auto.propose",{
      goal:"Build a health endpoint with tests",provider:"local-provider",model:"exact-model",
    });
    const session=host.sessions.get(goal.sessionId);
    assert.equal(session.commands.find(c=>c.type==="configure").job.kind,"workflow_plan");
    assert.deepEqual(await host.request("list",null),[]);
    const approval={id:"health",title:"Health feature",maxQcRounds:2,
      maxParallelByRole:{implementer:1,reviewer:1,architect:1,planner:1},
      tasks:[{id:"endpoint",title:"Health endpoint",kind:"implementation",role:"implementer",
        description:"Expose GET /health",acceptanceCriteria:["HTTP 200"],dependsOn:[]}]};
    const pending=await host.request("auto.proposal",{draftWorkflowId:goal.draftWorkflowId,runId:goal.runId});
    assert.equal(pending.canAccept,false,"A live planner without settled evidence is not approvable");
    session.report={kind:"workflow_plan",runId:goal.runId,summary:"Ready for human review",
      definition:approval,at:Date.now()};
    session.reported=true;
    session.finish(); // report notification was lost, but native Session retained it
    const draft=await host.request("auto.proposal",{draftWorkflowId:goal.draftWorkflowId,runId:goal.runId});
    assert.ok(session.commands.some(x=>x.type==="inspect"));
    assert.equal(draft.canAccept,true,"Missed native report must be restored by read-only inspection");
    assert.equal(draft.canAccept,true);
    assert.deepEqual(draft.proposal,approval);
    assert.deepEqual(await host.request("list",null),[]);
    const accepted=await host.request("auto.acceptProposal",{draftWorkflowId:goal.draftWorkflowId,runId:goal.runId});
    assert.equal(accepted.definition.id,"health");
    assert.equal((await host.request("list",null)).length,1);
    assert.equal(host.sessions.size,1);
    const status=await host.request("auto.status",{workflowId:"health"});
    assert.equal(status,null,"Acceptance does not start Autopilot");
  }finally{await host.cleanup();}
});
test("A mismatched replayed QC report pauses Autopilot instead of accepting fabricated completion",async()=>{
  const host=fakePluginHost();
  try{
    await host.activate();
    await host.request("create",definition);
    await host.request("auto.configure",{workflowId:"wf",config});
    await host.request("auto.start",{workflowId:"wf"});
    const impl=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="implementation")&&
      s.commands.some(c=>c.type==="message")));
    impl.finish();
    const qc=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="qc")&&
      s.commands.some(c=>c.type==="message")));
    // The exact Pi Session survived a notification loss but has an invalid,
    // foreign Run report. It must not pass QC or create a new implementation.
    qc.report={kind:"qc",runId:"qc-foreign-1",verdict:"pass",
      summary:"Spoofed completion",at:Date.now()};
    qc.reported=true;
    qc.finish();
    const paused=await eventually(async()=>{
      const status=await host.request("auto.status",{workflowId:"wf"});
      return !status?.enabled?status:undefined;
    });
    assert.match(paused.status,/Wrong Run identity|mismatched|report replay/i);
    assert.equal((await host.request("get","wf")).tasks.api.status,"awaiting_qc");
    assert.equal(host.sessions.size,2,"No duplicate Run after unsafe report replay");
  }finally{await host.cleanup();}
});

test("Plugin restart recovers the same settled Pi Session and resumes QC without duplicate dispatch",async()=>{
  const before=fakePluginHost();
  let after, beforeClosed=false;
  try{
    await before.activate();
    await before.request("create",definition);
    await before.request("auto.configure",{workflowId:"wf",config});
    await before.request("auto.start",{workflowId:"wf"});
    const impl=await eventually(()=>[...before.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="implementation")&&
      s.commands.some(c=>c.type==="message")));
    assert.equal(impl.id,"pi-session-1");
    // Shutdown while a Pi turn is still running. Its hosted session remains
    // alive and settles while this server plugin is completely inactive.
    await before.cleanup(true);
    beforeClosed=true;
    impl.finish();
    after=fakePluginHost(before.shared);
    await after.activate();
    await eventually(async()=>{
      const wf=await after.request("get","wf");
      return wf.tasks.api.status==="awaiting_qc";
    });
    assert.equal(after.sessions.get("pi-session-1"),impl,
      "Recover the existing hosted Pi Session instead of spawning a duplicate");
    const qc=await eventually(()=>[...after.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="qc")&&
      s.commands.some(c=>c.type==="message")));
    assert.equal(qc.id,"pi-session-2");
    qc.finish({kind:"qc",runId:"qc-api-1",verdict:"pass",
      summary:"Independent QC completed",at:Date.now()});
    await eventually(async()=>((await after.request("get","wf")).tasks.api.status==="passed"));
    assert.equal(after.sessions.size,2);
    await eventually(async()=>{
      const status=await after.request("auto.status",{workflowId:"wf"});
      return status?.enabled===false?status:undefined;
    });
    assert.equal((await after.request("get","wf")).tasks.api.status,"passed",
      "All Tasks are stable and worktree integration stays explicit");
  }finally{
    if(after)await after.cleanup();
    else if(beforeClosed)rmSync(before.shared.dir,{recursive:true,force:true});
    else await before.cleanup();
  }
});

test("Public Worktree API creates one reviewed linked Git branch without starting Pi Sessions",async()=>{
  const host=fakePluginHost();
  try{
    await host.activate();
    await host.request("create",definition);
    const preview=await host.request("auto.worktree.preview",{workflowId:"wf",taskId:"api"});
    assert.equal(preview.stage,"prepared");
    const persisted=await host.request("auto.worktree.status",{workflowId:"wf",taskId:"api"});
    assert.equal(persisted.id,preview.id);
    assert.equal(host.createdWorktrees.size,0);
    const created=await host.request("auto.worktree.create",{planId:preview.id});
    assert.equal(created.stage,"created");
    assert.match(created.branch,/^mm\/[a-f0-9]{16}\/wf\/api$/);
    assert.equal((await host.request("auto.worktree.inspect",{planId:preview.id})).stage,"created");
    assert.equal(host.createdWorktrees.size,1);
    assert.equal(host.sessions.size,0,"Creating a Worktree never creates a Pi Session");
    const status=await host.request("auto.status",{workflowId:"wf"});
    assert.equal(status,null,"The operator must still configure the linked PI WEB workspace ID");
  }finally{await host.cleanup();}
});
test("Public integration API advances a QC-passed DAG only after reviewed target SHA proof",async()=>{
  const host=fakePluginHost();
  try{
    await host.activate();
    await host.request("create",definition);
    await host.request("auto.configure",{workflowId:"wf",config});
    await host.request("auto.start",{workflowId:"wf"});
    const impl=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="implementation")&&
      s.commands.some(c=>c.type==="message")));
    impl.finish();
    const qc=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="qc")&&
      s.commands.some(c=>c.type==="message")));
    qc.finish({kind:"qc",runId:"qc-api-1",verdict:"pass",
      summary:"Validated API and tests",at:Date.now()});
    await eventually(async()=>((await host.request("get","wf")).tasks.api.status==="passed"));
    await eventually(async()=>(await host.request("auto.status",{workflowId:"wf"}))?.enabled===false);
    assert.equal((await host.request("get","wf")).tasks.api.status,"passed");
    const preview=await host.request("auto.integration.preview",{
      workflowId:"wf",taskId:"api",targetWorkspaceId:"wt-integrated"});
    assert.equal(preview.sourceSha,SHA);
    assert.equal(preview.targetHead,"c".repeat(40));
    assert.equal((await host.request("get","wf")).tasks.api.status,"passed",
      "Preview never mutates the authoritative Task DAG");
    const integrated=await host.request("auto.integration.confirm",{previewId:preview.id});
    assert.equal(integrated.tasks.api.status,"integrated");
    assert.equal(host.sessions.size,2);
    assert.ok(!host.calls.some(call=>call.file==="git"&&
      ["merge","push","cherry-pick","reset"].includes(call.args[2])),
      "The verification API must not perform a Git mutation");
  }finally{await host.cleanup();}
});
