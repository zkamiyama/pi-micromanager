import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { createHash } from "node:crypto";
import serverPlugin from "../dist/pi-web/server.js";
import { CONTROL_CHANNEL, RECEIPT_CHANNEL, ACTIVITY_CHANNEL } from "../dist/runtime/protocol.js";
import { REPORT_CHANNEL } from "../dist/automation/report.js";

const SHA = "a".repeat(40);
const FINAL = "f".repeat(40);
const BASE = "b".repeat(40);
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

function fakePluginHost(shared,options={}) {
  const dir = shared?.dir??mkdtempSync(join(tmpdir(),"pi-mm-server-"));
  const lifetime = new AbortController();
  const sessions = shared?.sessions??new Map();
  const calls = [];
  const publication={remoteSha:null,pr:null,pushCount:0,createCount:0,readyCount:0,mergeCount:0};
  const finalization={head:BASE,settled:false};
  const createdWorktrees=new Map();
  const convergence={head:BASE,merges:0};
  let serial = sessions.size;
  const managedId=path=>createHash("sha1").update("project:"+resolve(path))
    .digest("hex").slice(0,12);
  const managedPath=id=>[...createdWorktrees.keys()].find(path=>managedId(path)===id);
  const isManagedFinal=path=>[...createdWorktrees].some(([p,t])=>
    p===path&&t.branch.endsWith("/mm-final-integration"));
  const workspace = id => ({
    id,projectId:"project",path:managedPath(id)??(id==="orchestra"?"/repo":
      id==="wt-integrated"?"/repo/integrated":
      id==="worktree-consumer"?"/repo/consumer":
      id==="worktree-final"?"/repo/final":"/repo/api"),
    isMain:id==="orchestra",
    label:id,
    ...(id==="orchestra"?{}:{provider:{metadata:{isGitWorktree:true}}}),
  });
  const workspaces = {
    version:1,
    async resolve({projectId,workspaceId}) {
      const managed=managedPath(workspaceId);
      if(projectId!=="project"||
        (managed&&options.discovery?.allowed===false)||
        (!managed&&!["orchestra","worktree-api","wt-integrated","worktree-consumer","worktree-final"].includes(workspaceId)))
        throw new Error("Unknown linked workspace");
      return {project:{id:"project",name:"Project",path:"/repo"},
        workspace:workspace(workspaceId)};
    },
  };
  function createSession() {
    const id="pi-session-"+(++serial);
    const subscribers=new Set();
    const session={
      id,commands:[],afterConvergence:convergence.merges>0,
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
        if(session.commands.some(c=>c.type==="configure"&&
          c.job?.runId==="impl-mm-final-integration-1")){
          finalization.head=FINAL;finalization.settled=true;
        }
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
          return result(args[1]==="/repo/consumer"?convergence.head+"\n":
            args[1]==="/repo/final"?finalization.head+"\n":
            isManagedFinal(args[1])?(finalization.settled?finalization.head:
              createdWorktrees.get(args[1]).sha)+"\n":
            args[1]==="/repo/integrated"?"c".repeat(40)+"\n":SHA+"\n");
        if(command==="status --porcelain")
          return result("");
        if(command.startsWith("merge-base --is-ancestor ")){
          if(args[1]==="/repo/final"||isManagedFinal(args[1])){
            const [, ,source,head]=command.split(" ");
            const checked=head==="HEAD"?finalization.head:head;
            return {...result(""),exitCode:
              source===checked||(source===SHA&&checked===FINAL)?0:1};
          }
          if(args[1]==="/repo/consumer"){
            const [, ,source,target]=command.split(" ");
            const checked=target==="HEAD"?convergence.head:target;
            const ancestor=source===checked||
              (source===BASE&&checked===SHA)||
              (source===SHA&&checked===convergence.head&&convergence.head===SHA);
            return {...result(""),exitCode:ancestor?0:1};
          }
          return result("");
        }
        if(command==="symbolic-ref --quiet --short HEAD"&&args[1]==="/repo/consumer")
          return result("feature/consumer\n");
        if(command==="merge --ff-only "+SHA&&args[1]==="/repo/consumer"){
          if(convergence.head!==BASE)throw new Error("Repeated convergence merge");
          convergence.head=SHA;convergence.merges++;
          return result("Fast-forward\n");
        }
        if(command==="symbolic-ref --quiet --short HEAD")
          return result((createdWorktrees.get(args[1])?.branch??
            (args[1]==="/repo/final"?"feature/final":"feature/api"))+"\n");
        if(command==="remote get-url origin")
          return result("https://github.com/acme/repo.git\n");
        if(command.startsWith("ls-remote --heads origin refs/heads/")){
          const branch=command.split(" ").at(-1);
          return result(publication.remoteSha?
            publication.remoteSha+"\t"+branch+"\n":"");
        }
        if(command.startsWith("push --porcelain origin HEAD:refs/heads/")){
          publication.pushCount++;
          publication.remoteSha=args[1]==="/repo/final"||isManagedFinal(args[1])?FINAL:SHA;
          return result("Published mock Git branch\n");
        }
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
      if(request.file==="gh"){
        if(args[0]==="pr"&&args[1]==="list")
          return result(JSON.stringify(publication.pr?[publication.pr]:[]));
        if(args[0]==="pr"&&args[1]==="create"){
          publication.createCount++;
          publication.pr={number:7,url:"https://github.com/acme/repo/pull/7",
            headRefName:args[args.indexOf("--head")+1],
            baseRefName:"main",headRefOid:finalization.settled?FINAL:SHA,
            isDraft:true,state:"OPEN",autoMergeRequest:null};
          return result(publication.pr.url);
        }
        if(args[0]==="pr"&&args[1]==="view")
          return result(JSON.stringify(publication.pr));
        if(args[0]==="pr"&&args[1]==="ready"){
          publication.readyCount++;publication.pr.isDraft=false;
          return result("PR ready\n");
        }
        if(args[0]==="pr"&&args[1]==="checks")
          return result(JSON.stringify([{name:"build-and-test",bucket:"pass"}]));
        if(args[0]==="pr"&&args[1]==="merge"){
          if(!args.includes("--match-head-commit")||!args.includes("--auto")||
            args.includes("--admin"))
            throw new Error("Merge should be CI-gated, auto-scheduled and SHA-bound");
          publication.mergeCount++;
          publication.pr.state="MERGED";
          return result("GitHub merged verified final SHA\n");
        }
      }
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
  return {activate,request,cleanup,sessions,calls,createdWorktrees,publication,convergence,finalization,shared:{dir,sessions}};
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

test("PI WEB public server fully gates YOLO Git push and Draft PR on two exact approvals",async()=>{
  const host=fakePluginHost();
  try{
    await host.activate();
    await host.request("create",{...definition,id:"yolo",
      permissions:{actions:{"git.push":"ask","github.pr.create":"ask"}}});
    await host.request("auto.configure",{workflowId:"yolo",config:{
      ...config,publication:{remote:"origin",baseBranch:"main",draft:true},
    }});
    await host.request("auto.start",{workflowId:"yolo"});
    const impl=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="implementation")&&
      s.commands.some(c=>c.type==="message")));
    impl.finish();
    const qc=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="qc")&&
      s.commands.some(c=>c.type==="message")));
    qc.finish({kind:"qc",runId:"qc-api-1",verdict:"pass",
      summary:"Verified contract",at:Date.now()});
    await eventually(async()=>(await host.request("get","yolo")).tasks.api.status==="passed");
    const askPush=await eventually(async()=>{
      const approvals=await host.request("auto.permissions",{workflowId:"yolo"});
      return approvals.approvals.find(a=>a.action==="git.push");
    });
    assert.equal(askPush.state,"pending");
    assert.equal(host.publication.pushCount,0);
    assert.equal(host.publication.createCount,0);
    await host.request("auto.permission.decide",{
      approvalId:askPush.id,decision:"approved"});
    await eventually(()=>host.publication.pushCount===1);
    const askPr=await eventually(async()=>{
      const approvals=await host.request("auto.permissions",{workflowId:"yolo"});
      return approvals.approvals.find(a=>a.action==="github.pr.create");
    });
    assert.equal(askPr.state,"pending");
    assert.equal(host.publication.createCount,0);
    await host.request("auto.permission.decide",{
      approvalId:askPr.id,decision:"approved"});
    await eventually(()=>host.publication.createCount===1);
    const final=await host.request("auto.permissions",{workflowId:"yolo"});
    assert.equal(final.publication.length,2);
    assert.ok(final.publication.every(x=>x.state==="completed"));
    assert.equal(host.publication.pr.isDraft,true);
    assert.equal((await host.request("get","yolo")).tasks.api.status,"passed",
      "Host may not mark the Git change integrated or merged just because PR exists");
    assert.equal(host.sessions.size,2,"Human approvals must not replay previous Pi Sessions");
  }finally{await host.cleanup();}
});

test("PI WEB git.commit ask defers Session creation until human grants that exact attempt",async()=>{
  const host=fakePluginHost();
  try{
    await host.activate();
    await host.request("create",{...definition,id:"commit-gated",
      permissions:{default:"allow",actions:{"git.commit":"ask"}}});
    await host.request("auto.configure",{workflowId:"commit-gated",config});
    await host.request("auto.start",{workflowId:"commit-gated"});
    const approval=await eventually(async()=>{
      const saved=await host.request("auto.permissions",{workflowId:"commit-gated"});
      return saved.approvals.find(a=>a.action==="git.commit");
    });
    assert.equal(approval.state,"pending");
    assert.equal(approval.runId,"impl-api-1");
    assert.equal(approval.headSha,"pre-commit");
    assert.equal(host.sessions.size,0,
      "Without permission, no model-backed Pi Session may be admitted");
    assert.equal((await host.request("get","commit-gated")).tasks.api.status,"ready");
    await host.request("auto.permission.decide",{approvalId:approval.id,decision:"approved"});
    const launched=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.kind==="implementation")&&
      s.commands.some(c=>c.type==="message")));
    assert.ok(launched);
    assert.equal(host.sessions.size,1);
  }finally{await host.cleanup();}
});

test("PI WEB git.commit deny leaves the Task untouched and admits zero modifying Sessions",async()=>{
  const host=fakePluginHost();
  try{
    await host.activate();
    await host.request("create",{...definition,id:"commit-denied",
      permissions:{actions:{"git.commit":"deny"}}});
    await host.request("auto.configure",{workflowId:"commit-denied",config});
    await host.request("auto.start",{workflowId:"commit-denied"});
    const final=await eventually(async()=>{
      const status=await host.request("auto.status",{workflowId:"commit-denied"});
      return status?.enabled===false?status:null;
    });
    assert.match(final.status,/permission denied/);
    assert.equal(host.sessions.size,0);
    assert.equal((await host.request("get","commit-denied")).tasks.api.status,"ready");
    assert.equal((await host.request("auto.permissions",{
      workflowId:"commit-denied"})).approvals.length,0,
      "Deny is a Workflow policy decision, not a pending human prompt");
  }finally{await host.cleanup();}
});

test("Real PI WEB scheduler fast-forwards dependent Git Worktree before launching its Pi implementer",async()=>{
  const host=fakePluginHost();
  try{
    await host.activate();
    const dag={...definition,id:"dependency-chain",
      tasks:[...definition.tasks,
        {id:"consumer",title:"Consume API",kind:"implementation",role:"implementer",
          description:"Add consumer code",acceptanceCriteria:["Depends on QC source"],
          dependsOn:[{taskId:"api",gate:"integrated"}]}],
    };
    await host.request("create",dag);
    await host.request("auto.configure",{workflowId:"dependency-chain",
      config:{...config,workspaces:{api:"worktree-api",consumer:"worktree-consumer"}}});
    await host.request("auto.start",{workflowId:"dependency-chain"});
    const impl=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.runId==="impl-api-1")&&
      s.commands.some(c=>c.type==="message")));
    impl.finish();
    const qc=await eventually(()=>[...host.sessions.values()].find(s=>
      s.commands.some(c=>c.type==="configure"&&c.job?.runId==="qc-api-1")&&
      s.commands.some(c=>c.type==="message")));
    qc.finish({kind:"qc",runId:"qc-api-1",verdict:"pass",
      summary:"Verified upstream API contract",at:Date.now()});
    let child;
    try{
      child=await eventually(()=>[...host.sessions.values()].find(s=>
        s.commands.some(c=>c.type==="configure"&&c.job?.runId==="impl-consumer-1")&&
        s.commands.some(c=>c.type==="message")),15000);
    }catch(error){
      const status=await host.request("auto.status",{workflowId:"dependency-chain"});
      const workflow=await host.request("get","dependency-chain");
      const approvals=await host.request("auto.permissions",{workflowId:"dependency-chain"});
      assert.fail("Child launch unavailable: "+String(error)+"; status="+
        JSON.stringify(status)+"; workflow="+JSON.stringify(workflow.tasks)+
        "; convergence="+JSON.stringify(host.convergence)+
        "; approvals="+JSON.stringify(approvals)+"; calls="+
        JSON.stringify(host.calls.slice(-30)));
    }
    assert.equal(host.convergence.merges,1);
    assert.equal(host.convergence.head,SHA);
    assert.equal(child.afterConvergence,true,
      "Child Pi Session cannot be created before Git contains its QC source");
    const current=await host.request("get","dependency-chain");
    assert.equal(current.tasks.api.status,"integrated");
    assert.equal(current.tasks.consumer.status,"running");
    const receipts=(await host.request("auto.permissions",{workflowId:"dependency-chain"})).convergence;
    assert.equal(receipts.length,1);
    assert.equal(receipts[0].state,"completed");
    assert.equal(receipts[0].sourceSha,SHA);
  }finally{await host.cleanup();}
});

test("PI WEB full-DAG YOLO creates a fresh final merge Pi Session, final QC, then GitHub auto-merge",async()=>{
 const host=fakePluginHost();
 try{
   await host.activate();
   await host.request("create",{...definition,id:"final-merge-flow"});
   await host.request("auto.configure",{workflowId:"final-merge-flow",config:{
     ...config,finalization:{workspaceId:"worktree-final",autoMerge:true},
     publication:{remote:"origin",baseBranch:"main",draft:true},
   }});
   await host.request("auto.start",{workflowId:"final-merge-flow"});
   const code=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="impl-api-1")&&
     s.commands.some(c=>c.type==="message")));
   code.finish();
   const originalQC=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="qc-api-1")&&
     s.commands.some(c=>c.type==="message")));
   originalQC.finish({kind:"qc",runId:"qc-api-1",verdict:"pass",
     summary:"Code and test evidence verified",at:Date.now()});
   const finalCode=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&
       c.job?.runId==="impl-mm-final-integration-1")&&
     s.commands.some(c=>c.type==="message")),15000);
   assert.equal(host.publication.pushCount,0,
     "Intermediate Task cannot publish in a finalization-enabled Workflow");
   const prompt=finalCode.commands.find(c=>c.type==="message").text;
   assert.match(prompt,/FINAL integration run/);
   assert.match(prompt,/Merge ALL source Git commits/);
   assert.match(prompt,/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
   finalCode.finish();
   const finalQC=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&
       c.job?.runId==="qc-mm-final-integration-1")&&
     s.commands.some(c=>c.type==="message")),15000);
   assert.notEqual(finalQC.id,finalCode.id);
   finalQC.finish({kind:"qc",runId:"qc-mm-final-integration-1",
     verdict:"pass",summary:"Entire combined code independently checked",
     at:Date.now()});
   await eventually(async()=>{
     const state=await host.request("get","final-merge-flow");
     return state.tasks["mm-final-integration"]?.status==="passed";
   },15000);
   await eventually(()=>host.publication.mergeCount===1,15000);
   assert.equal(host.publication.pushCount,1);
   assert.equal(host.publication.createCount,1);
   assert.equal(host.publication.readyCount,1);
   assert.equal(host.publication.pr.headRefOid,FINAL);
   assert.equal(host.publication.pr.isDraft,false);
   assert.equal(host.publication.pr.state,"MERGED");
   const status=await eventually(async()=>{
     const current=await host.request("auto.status",{workflowId:"final-merge-flow"});
     return current?.enabled===false?current:null;
   },15000);
   assert.match(status.status,/finalized|stable|publication/i);
   const receipts=await host.request("auto.permissions",{workflowId:"final-merge-flow"});
   assert.ok(receipts.publication.some(r=>
     r.action==="github.pr.merge"&&r.state==="completed"));
   assert.equal(host.sessions.size,4,
     "Original implementation, original QC, final implementation and final QC each own one Pi Session");
   const state=await host.request("get","final-merge-flow");
   assert.equal(state.tasks.api.status,"integrated");
   assert.equal(state.tasks["mm-final-integration"].status,"integrated");
   assert.equal(state.tasks["mm-final-integration"].lastQc.headSha,FINAL);
   assert.ok(!host.calls.some(x=>x.args.includes("--admin")||
     x.args.includes("--force")||x.args.includes("--delete-branch")));
 }finally{await host.cleanup();}
});

test("Opt-in managed DAG start creates and resolves Task/final Worktrees before any Pi Run",async()=>{
 const host=fakePluginHost();
 try{
   await host.activate();
   await host.request("create",{...definition,id:"managed-flow"});
   const configured=await host.request("auto.configure",{workflowId:"managed-flow",config:{
     ...config,workspaces:{},managedWorktrees:true,
     finalization:{workspaceId:"auto",autoMerge:true},
     publication:{remote:"origin",baseBranch:"main",draft:true},
   }});
   assert.equal(configured.enabled,false);
   assert.equal(host.createdWorktrees.size,0,"Configuration alone never runs Git worktree add");
   assert.equal(host.sessions.size,0);
   const started=await host.request("auto.start",{workflowId:"managed-flow"});
   assert.equal(started.enabled,true);
   assert.equal(host.createdWorktrees.size,2);
   assert.notEqual(started.config.workspaces.api,"auto");
   assert.notEqual(started.config.finalization.workspaceId,"auto");
   assert.notEqual(started.config.workspaces.api,started.config.finalization.workspaceId);
   const expected=[...host.createdWorktrees.keys()].map(path=>
     createHash("sha1").update("project:"+resolve(path)).digest("hex").slice(0,12));
   assert.ok(expected.includes(started.config.workspaces.api));
   assert.ok(expected.includes(started.config.finalization.workspaceId));
   await host.request("auto.start",{workflowId:"managed-flow"});
   assert.equal(host.createdWorktrees.size,2,"Repeated Start never creates duplicate Worktrees");
   await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="impl-api-1")));
 }finally{await host.cleanup();}
});

test("Undiscoverable PI WEB Workspace fails closed and resumes from exact Git receipt",async()=>{
 const discovery={allowed:false},host=fakePluginHost(undefined,{discovery});
 try{
   await host.activate();
   await host.request("create",{...definition,id:"discovery-flow"});
   await host.request("auto.configure",{workflowId:"discovery-flow",config:{
     ...config,workspaces:{},managedWorktrees:true,
   }});
   await assert.rejects(host.request("auto.start",{workflowId:"discovery-flow"}),
     /did not discover/);
   assert.equal(host.createdWorktrees.size,1);
   assert.equal(host.sessions.size,0,"Never launch Pi with an unverified Workspace identity");
   discovery.allowed=true;
   const started=await host.request("auto.start",{workflowId:"discovery-flow"});
   assert.equal(started.enabled,true);
   assert.equal(host.createdWorktrees.size,1,
     "Inspect the existing reserved Git Worktree, do not duplicate git add");
   assert.equal(host.calls.filter(c=>c.file==="git"&&c.args.includes("add")).length,1);
 }finally{await host.cleanup();}
});

test("Auto-provisioned final Worktree completes QC-gated GitHub MERGED flow",async()=>{
 const host=fakePluginHost();
 try{
   await host.activate();
   await host.request("create",{...definition,id:"auto-final-flow"});
   await host.request("auto.configure",{workflowId:"auto-final-flow",config:{
     ...config,workspaces:{},managedWorktrees:true,
     finalization:{workspaceId:"auto",autoMerge:true},
     publication:{remote:"origin",baseBranch:"main",draft:true},
   }});
   await host.request("auto.start",{workflowId:"auto-final-flow"});
   const implementation=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="impl-api-1")&&
     s.commands.some(c=>c.type==="message")));
   implementation.finish();
   const qc=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="qc-api-1")&&
     s.commands.some(c=>c.type==="message")));
   qc.finish({kind:"qc",runId:"qc-api-1",verdict:"pass",
     summary:"Task checked",at:Date.now()});
   const finalRun=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="impl-mm-final-integration-1")&&
     s.commands.some(c=>c.type==="message")),15000);
   assert.equal(host.publication.pushCount,0);
   finalRun.finish();
   const finalQC=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="qc-mm-final-integration-1")&&
     s.commands.some(c=>c.type==="message")),15000);
   finalQC.finish({kind:"qc",runId:"qc-mm-final-integration-1",verdict:"pass",
     summary:"Integrated commit checked",at:Date.now()});
   await eventually(()=>host.publication.mergeCount===1,15000);
   assert.equal(host.publication.pr.state,"MERGED",
     "A completed merge must be confirmed by GitHub, not only host QC");
   assert.equal(host.publication.pushCount,1);
   await eventually(async()=>(await host.request("get","auto-final-flow"))
     .tasks["mm-final-integration"]?.status==="integrated",15000);
   const wf=await host.request("get","auto-final-flow");
   assert.equal(wf.tasks.api.status,"integrated");
   assert.equal(host.createdWorktrees.size,2);
   assert.equal(host.sessions.size,4);
 }finally{await host.cleanup();}
});

const quickProfile=(merge="allow")=>({
  config:{
    ...config,managedWorktrees:true,workspaces:{},
    finalization:{workspaceId:"auto",autoMerge:true},
    publication:{remote:"origin",baseBranch:"main",draft:true},
  },
  permissions:{default:"allow",
    actions:{"github.pr.merge":merge,"deploy.production":"deny"}},
});
const quickRequestId="a22bb553-9309-492f-8cc2-22fd00444cb0";

test("One command automatically turns a settled Sol plan into an isolated, QC-gated merged DAG",async()=>{
 const host=fakePluginHost();
 try{
   await host.activate();
   const setup=await host.request("auto.quick.configure",quickProfile());
   assert.equal(setup.profile.config.managedWorktrees,true);
   assert.equal(host.sessions.size,0,"Configuration does not create any Pi Session");
   assert.equal(host.createdWorktrees.size,0);
   const goal=await host.request("auto.quick.start",{
     requestId:quickRequestId,goal:"Add a verified endpoint to the repository and merge it",
   });
   assert.match(goal.workflowId,/^quick-[0-9a-f]{16}$/);
   assert.equal((await host.request("auto.quick.start",{
     requestId:quickRequestId,goal:"Add a verified endpoint to the repository and merge it",
   })).workflowId,goal.workflowId);
   const planner=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId===goal.runId)&&
     s.commands.some(c=>c.type==="message")),15000);
   const prompt=planner.commands.find(c=>c.type==="message").text;
   assert.match(prompt,/preauthorized automatic execution/);
   const malicious={...definition,id:"model-chosen-id",
     permissions:{default:"deny",actions:{"github.pr.merge":"deny"}}};
   planner.finish({kind:"workflow_plan",runId:goal.runId,summary:"One endpoint Task",
     definition:malicious,at:Date.now()});
   const started=await eventually(async()=>{
     const status=await host.request("auto.quick.status",null);
     return status.goals[0]?.phase==="running"?status.goals[0]:null;
   },20000);
   const saved=await host.request("get",goal.workflowId);
   assert.equal(saved.definition.id,goal.workflowId);
   assert.deepEqual(saved.definition.permissions,quickProfile().permissions,
     "Sol-suggested permissions cannot override the preauthorized project policy");
   assert.equal(host.createdWorktrees.size,2);
   const first=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="impl-api-1")&&
     s.commands.some(c=>c.type==="message")),15000);
   assert.ok(host.sessions.size>=2);
   first.finish();
   const qc=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="qc-api-1")&&
     s.commands.some(c=>c.type==="message")),15000);
   qc.finish({kind:"qc",runId:"qc-api-1",verdict:"pass",
     summary:"Independent API QC pass",at:Date.now()});
   const integration=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="impl-mm-final-integration-1")&&
     s.commands.some(c=>c.type==="message")),15000);
   integration.finish();
   const finalQC=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="qc-mm-final-integration-1")&&
     s.commands.some(c=>c.type==="message")),15000);
   finalQC.finish({kind:"qc",runId:"qc-mm-final-integration-1",verdict:"pass",
     summary:"All combined code checked",at:Date.now()});
   await eventually(async()=>{
     const state=await host.request("get",goal.workflowId);
     return state.tasks["mm-final-integration"]?.status==="integrated";
   },20000);
   const done=await eventually(async()=>{
     const row=(await host.request("auto.quick.status",null)).goals[0];
     return row?.phase==="finished"?row:null;
   },12000);
   assert.equal(done.workflowId,goal.workflowId);
   assert.equal(host.publication.mergeCount,1);
   assert.equal(host.publication.pr.state,"MERGED");
   assert.equal(host.sessions.size,5,
     "One planner, original implementation/QC and final implementation/QC");
   assert.equal(started.profile.config.publication.baseBranch,"main");
 }finally{await host.cleanup();}
});

test("One-command project profile is frozen and auto-start can be cancelled during planning",async()=>{
 const host=fakePluginHost();
 try{
   await host.activate();
   await host.request("auto.quick.configure",quickProfile("ask"));
   const goal=await host.request("auto.quick.start",{
     requestId:quickRequestId,goal:"Only plan this goal unless I cancel",
   });
   const planner=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId===goal.runId)&&
     s.commands.some(c=>c.type==="message")),15000);
   await host.request("auto.quick.configure",quickProfile("allow"));
   const frozen=(await host.request("auto.quick.status",null)).goals[0];
   assert.equal(frozen.profile.permissions.actions["github.pr.merge"],"ask");
   const cancelled=await host.request("auto.quick.cancel",{requestId:quickRequestId});
   assert.equal(cancelled.phase,"cancelled");
   planner.finish({kind:"workflow_plan",runId:goal.runId,summary:"Not executable after cancel",
     definition,at:Date.now()});
   await new Promise(resolve=>setTimeout(resolve,1750));
   assert.equal((await host.request("auto.quick.status",null)).goals[0].phase,"cancelled");
   assert.equal((await host.request("list",null)).length,0);
   assert.equal(host.createdWorktrees.size,0);
   assert.equal(host.sessions.size,1);
 }finally{await host.cleanup();}
});

test("One-command restores the same Pi planning Session after daemon restart",async()=>{
 const before=fakePluginHost();
 let after;
 let closed=false;
 try{
   await before.activate();
   await before.request("auto.quick.configure",quickProfile("ask"));
   const goal=await before.request("auto.quick.start",{
     requestId:quickRequestId,goal:"Implement a small tested endpoint",
   });
   const planner=await eventually(()=>[...before.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId===goal.runId)&&
     s.commands.some(c=>c.type==="message")),15000);
   await before.cleanup(true);closed=true;
   after=fakePluginHost(before.shared);
   await after.activate();
   planner.finish({kind:"workflow_plan",runId:goal.runId,summary:"Prepared",
     definition,at:Date.now()});
   const started=await eventually(async()=>
     (await after.request("auto.quick.status",null)).goals.find(g=>
       g.requestId===quickRequestId&&g.phase==="running"),20000);
   assert.equal(started.workflowId,goal.workflowId);
   assert.ok(planner.commands.some(c=>c.type==="inspect"),
     "Recovery inspects the same Pi Session instead of resending the planner prompt");
   assert.equal(planner.commands.filter(c=>c.type==="message").length,1);
   await eventually(()=>[...after.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId==="impl-api-1")&&
     s.commands.some(c=>c.type==="message")),15000);
   assert.equal(after.sessions.size,2,"Only one new implementation Pi Session was admitted");
 }finally{
   if(after)await after.cleanup();
   else if(closed)rmSync(before.shared.dir,{recursive:true,force:true});
   else await before.cleanup();
 }
});

test("A missing structured plan stops before any code or Git mutation",async()=>{
 const host=fakePluginHost();
 try{
   await host.activate();
   await host.request("auto.quick.configure",quickProfile());
   const goal=await host.request("auto.quick.start",{
     requestId:quickRequestId,goal:"Build a task",
   });
   const planner=await eventually(()=>[...host.sessions.values()].find(s=>
     s.commands.some(c=>c.type==="configure"&&c.job?.runId===goal.runId)&&
     s.commands.some(c=>c.type==="message")),15000);
   planner.finish();
   const row=await eventually(async()=>{
     const r=(await host.request("auto.quick.status",null)).goals[0];
     return r?.phase==="needs_attention"?r:null;
   },15000);
   assert.match(row.message,/report|structured|replay/i);
   assert.equal(host.createdWorktrees.size,0);
   assert.equal(host.sessions.size,1);
   assert.deepEqual(await host.request("list",null),[]);
 }finally{await host.cleanup();}
});
