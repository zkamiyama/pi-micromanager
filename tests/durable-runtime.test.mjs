import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {tmpdir} from "node:os";
import {createModels} from "@earendil-works/pi-ai/models";
import {fauxProvider,fauxToolCall,fauxAssistantMessage,fauxText}
  from "@earendil-works/pi-ai/providers/faux";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger,parseAutopilotConfig} from "../dist/automation/ledger.js";
import {DurableRunHost,isDurableSession,durableActivity,isSafeBashCommand,createDurableModels} from "../dist/runtime/durable-runner.js";

function fixture(){
 const home=mkdtempSync(join(tmpdir(),"mm-durable-real-"));
 const project=join(home,"worktree"),data=join(home,"state");
 mkdirSync(project,{recursive:true});mkdirSync(data,{recursive:true});
 writeFileSync(join(project,"README.md"),"Durable fixture");
 const agents=new AgentRegistry(join(data,"agents.sqlite"));
 const ledger=new AutopilotLedger(join(data,"ledger.sqlite"));
 const faux=fauxProvider({tokensPerSecond:100000});
 const models=createModels();
 models.setProvider(faux.provider);
 const events=[],reports=[],wakes=[],transitions=[];
 const options={dataDirectory:data,agents,ledger,models,
   activity(binding,event){events.push({binding,event});agents.record(binding,event);},
   changed(binding){transitions.push(binding);},
   report(binding,report){reports.push(report);ledger.recordReport(binding,report);},
   wake(binding){wakes.push(binding);}};
 let durable=new DurableRunHost(options);
 const r={projectId:"p",orchestraWorkspaceId:"o",workflowId:"workflow",
   taskId:"alpha",runId:"qc-alpha-1",workspaceId:"wt-alpha",seat:"qc",
   requestId:"auto:qc-alpha-1"};
 const launch={reservation:r,cwd:project,kind:"qc",
   model:{provider:"faux",model:"faux-1"},prompt:"Check the code and submit QC verdict."};
 const current=()=>agents.getRun("p","o","workflow","qc-alpha-1");
 const waitFor=async(predicate,timeoutMs=8000)=>{
   const deadline=Date.now()+timeoutMs;
   while(Date.now()<deadline){
     const result=predicate();
     if(result)return result;
     await new Promise(resolve=>setTimeout(resolve,20));
   }
   throw Error("Durable harness condition not met before timeout");
 };
 return {home,project,data,agents,ledger,faux,options,events,reports,wakes,transitions,
   r,launch,current,waitFor,get durable(){return durable;},set durable(v){durable=v;},
   async close(){
     await durable.close();agents.close();ledger.close();
     rmSync(home,{recursive:true,force:true});
   }};
}
test("New workflows default to Durable; explicit native and legacy saved configurations remain native",()=>{
 const x=fixture();
 try{
   const cfg={models:Object.fromEntries(["planner","qc","architect","implementer"]
     .map(role=>[role,{provider:"faux",model:"faux-1"}])),
     workspaces:{alpha:"wt-alpha"},test:{file:"node",args:["--test"]},
     maxAttempts:3};
   assert.equal(parseAutopilotConfig(cfg).runtime,"durable");
   assert.equal(parseAutopilotConfig({...cfg,runtime:"pi-web"}).runtime,"pi-web");
   assert.throws(()=>parseAutopilotConfig({...cfg,runtime:"unknown"}),/Agent runtime/);
   x.ledger.save("p","o","workflow",cfg);
   assert.equal(x.ledger.get("p","o","workflow").config.runtime,"durable");
   // An older saved row without a runtime must not silently switch a
   // potentially active native Pi Session after a server upgrade.
   const legacy=new DatabaseSync(join(x.data,"ledger.sqlite"));
   legacy.prepare("UPDATE autopilots SET config_json=? WHERE scope=? AND workflow_id=?")
     .run(JSON.stringify(cfg),JSON.stringify(["p","o"]),"workflow");
   legacy.close();
   assert.equal(x.ledger.get("p","o","workflow").config.runtime,"pi-web");
   assert.equal(x.ledger.list()[0].config.runtime,"pi-web");
 }finally{void x.close();}
});
test("Real Pi Durable Harness commits a typed QC tool, emits public events and settles once",async()=>{
 const x=fixture();
 try{
   x.faux.setResponses([
     fauxAssistantMessage([fauxToolCall("mm_qc_report",
       {verdict:"pass",summary:"Read-only review and exact evidence passed"},
       {id:"report-a"})],{stopReason:"toolUse"}),
     fauxAssistantMessage([fauxText("QC report committed.")]),
   ]);
   const launched=await x.durable.launch(x.launch);
   assert.ok(isDurableSession(launched.sessionId));
   assert.equal(launched.provider,"faux");
   await x.waitFor(()=>x.current()?.phase==="settled");
   assert.equal(x.reports.length,1);
   assert.equal(x.reports[0].kind,"qc");
   assert.equal(x.reports[0].runId,x.r.runId);
   assert.equal(x.ledger.report(x.current()).kind,"qc");
   assert.ok(x.events.some(e=>e.event.kind==="tool_started"));
   assert.ok(x.events.some(e=>e.event.kind==="tool_finished"));
   assert.ok(x.events.some(e=>e.event.kind==="agent_settled"));
   assert.equal(x.wakes.length,1);
   await assert.rejects(x.durable.launch(x.launch),/already reserved/);
   assert.equal(x.faux.state.callCount,2,"No extra model request on duplicate launch");
 }finally{await x.close();}
});
test("A plain Durable model completion without QC report cannot forge PASS",async()=>{
 const x=fixture();
 try{
   x.faux.setResponses([fauxAssistantMessage("No structured report")]);
   await x.durable.launch(x.launch);
   await x.waitFor(()=>x.current()?.phase==="settled");
   assert.equal(x.ledger.report(x.current()),undefined);
   assert.equal(x.reports.length,0);
 }finally{await x.close();}
});
test("Pi Durable observation strips hidden thinking and never forwards tool arguments",()=>{
 const original="safe";
 const delta=durableActivity({type:"message_update",usage:{},
   changes:[{type:"thinking_delta",contentIndex:0,delta:"secret"},
     {type:"text_delta",contentIndex:1,delta:" public"}]},original,1);
 assert.equal(delta.event.kind,"message_delta");
 assert.equal(delta.event.text,"safe public");
 assert.equal(delta.event.text.includes("secret"),false);
 const tool=durableActivity({type:"tool_execution_start",toolCallId:"a",
   toolName:"bash",args:{command:"cat private.secret"}},original,2);
 assert.equal(tool.event.text,"bash");
 assert.ok(!JSON.stringify(tool).includes("private.secret"));
});
test("Durable real Harness rejects unsupported models without allocating Pi Session IDs",async()=>{
 const x=fixture();
 try{
   await assert.rejects(x.durable.launch({...x.launch,model:{
     provider:"faux",model:"nonexistent"} }),/not in the configured Pi catalog/);
   assert.equal(x.current(),undefined,
     "Invalid model must not strand an unreplayable Run reservation");
   assert.equal(x.faux.state.callCount,0);
 }finally{await x.close();}
});

test("Only the final integration Durable worker may request local Git merges",()=>{
  assert.equal(isSafeBashCommand("git merge --no-ff deadbeef"),false);
  assert.equal(isSafeBashCommand("git merge --no-ff deadbeef",true),true);
  assert.equal(isSafeBashCommand("git merge --abort",true),true);
  assert.equal(isSafeBashCommand("git add . && git commit -m integrate",true),true);
  for(const blocked of [
    "git push origin main","git fetch origin","git pull origin main",
    "git remote add other https://github.com/example/repo",
    "git reset --hard HEAD~1","gh pr create --fill",
  ]){
    assert.equal(isSafeBashCommand(blocked,true),false,blocked);
    assert.equal(isSafeBashCommand(blocked),false,blocked);
  }
});

test("Durable SQLite conversation can be reopened without replaying an already settled turn",async()=>{
 const x=fixture();
 try{
   x.faux.setResponses([
     fauxAssistantMessage([fauxToolCall("mm_qc_report",
       {verdict:"pass",summary:"Persisted across host recreation"},
       {id:"report-restart"})],{stopReason:"toolUse"}),
     fauxAssistantMessage([fauxText("Done.")]),
   ]);
   await x.durable.launch(x.launch);
   await x.waitFor(()=>x.current()?.phase==="settled");
   assert.equal(x.faux.state.callCount,2);
   const oldSession=x.current().sessionId;
   await x.durable.close();
   x.durable=new DurableRunHost(x.options);
   const status=await x.durable.reconnect(x.current(),x.project,"qc");
   assert.equal(status,"settled");
   assert.equal(x.current().sessionId,oldSession);
   assert.equal(x.ledger.report(x.current())?.kind,"qc");
   assert.equal(x.faux.state.callCount,2,"Never duplicate model turns on settled recovery");
 }finally{await x.close();}
});

test("Default Durable Models load stored Pi provider auth through the public SDK",async()=>{
 const x=fixture();
 try{
   // An isolated synthetic credential store proves integration without reading
   // or logging a real user's ~/.pi/agent/auth.json in automated tests.
   const authFile=join(x.data,"synthetic-pi-auth.json");
   writeFileSync(authFile,JSON.stringify({openai:{
     type:"api_key",key:"unit-test-only-not-a-real-credential",
   }}),{mode:0o600});
   const models=await createDurableModels(authFile);
   assert.ok(models.getModel("openai","gpt-5.5"),
     "The installed Pi coding-agent catalog is available to Durable");
   const auth=await models.getAuth("openai");
   assert.ok(auth,"The same Pi credential store resolves model auth");
   assert.ok(auth.source,"Auth resolution has provenance, without exposing it to logs");
 }finally{await x.close();}
});

test("F12: unsupported effort fails before immutable Durable reservation",async()=>{
  const x=fixture();
  try{
    await assert.rejects(x.durable.launch({...x.launch,model:{
      ...x.launch.model,effort:"typo"}}),/Unsupported Pi Durable thinking/);
    assert.equal(x.current(),undefined);
    x.faux.setResponses([fauxAssistantMessage("No report")]);
    await x.durable.launch(x.launch);
    assert.ok(x.current().sessionId.startsWith("durable:"));
  }finally{await x.close();}
});
test("F06: abort intent survives lost event and Durable restart",async()=>{
  const x=fixture(),slow=fauxProvider({tokensPerSecond:100});
  const models=createModels();models.setProvider(slow.provider);
  x.options.models=models;
  const original=x.options.activity;let dropped;
  x.options.activity=(binding,event)=>{
    if(event.kind==="agent_settled"){dropped=event;return;}
    original(binding,event);
  };
  try{
    slow.setResponses([
      fauxAssistantMessage([fauxToolCall("mm_qc_report",{
        verdict:"pass",summary:"Provisional QC before abort"},{id:"pre-abort"})],
        {stopReason:"toolUse"}),
      fauxAssistantMessage([fauxText("Still reviewing. ".repeat(1000))]),
    ]);
    await x.durable.launch(x.launch);
    await x.waitFor(()=>x.reports.length===1);
    await x.durable.command(x.current(),x.project,"qc","abort","audit-abort");
    await x.waitFor(()=>dropped);
    assert.equal(dropped.text,"Agent interrupted");
    assert.equal(x.current().abortRequested,1);
    await x.durable.close();
    x.options.activity=original;
    x.durable=new DurableRunHost(x.options);
    await x.durable.reconnect(x.current(),x.project,"qc");
    await x.waitFor(()=>x.current().phase==="settled");
    assert.equal(x.current().latestText,"Agent interrupted");
    assert.equal(x.ledger.report(x.current()).verdict,"pass");
  }finally{await x.close();}
});

test("F14: shutdown joins an opening Harness and never leaves a live Run",async()=>{
  const x=fixture();let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const inside=new Promise(resolve=>{entered=resolve;});
  const original=x.durable.validatedModels.bind(x.durable);
  let calls=0;
  x.durable.validatedModels=async model=>{
    calls++;
    if(calls===2){entered();await gate;}
    return original(model);
  };
  try{
    const launching=x.durable.launch(x.launch);
    await inside;
    const closing=x.durable.close();
    release();
    await assert.rejects(launching,/shutting down|closed/);
    await closing;
    assert.equal(x.durable.connected("durable:unused"),false);
    assert.equal(x.current()?.phase,"reserved");
  }finally{release();await x.close();}
});
test("F13: failed input proof cannot be bypassed by a second reconnect",async()=>{
  const x=fixture(),original=x.durable.open.bind(x.durable);
  x.durable.open=async(...args)=>{
    const live=await original(...args);
    live.root.submit=async()=>{throw Error("Synthetic failure before input commit");};
    return live;
  };
  try{
    await assert.rejects(x.durable.launch(x.launch),/Synthetic failure/);
    await x.durable.close();
    x.durable=new DurableRunHost(x.options);
    await assert.rejects(x.durable.reconnect(x.current(),x.project,"qc"),
      /input receipt missing/);
    await assert.rejects(x.durable.reconnect(x.current(),x.project,"qc"),
      /input receipt missing/);
    assert.equal(x.faux.state.callCount,0);
  }finally{await x.close();}
});

test("Audit F18: Durable final QC must fetch every full source contract before PASS",async()=>{
 const x=fixture();
 const r={...x.r,taskId:"mm-final-integration",runId:"qc-mm-final-integration-1"};
 const contracts=[
  {taskId:"a",title:"Source A",description:"A".repeat(3900),
   acceptanceCriteria:["A contract"],qcSha:"a".repeat(40)},
  {taskId:"b",title:"Source B",description:"B".repeat(3900),
   acceptanceCriteria:["B contract"],qcSha:"b".repeat(40)},
 ];
 x.options.finalContracts=()=>contracts;
 try{
  x.faux.setResponses([
   fauxAssistantMessage([fauxToolCall("mm_final_qc_contract",{index:0},{id:"page-0"})],{stopReason:"toolUse"}),
   fauxAssistantMessage([fauxToolCall("mm_final_qc_contract",{index:1},{id:"page-1"})],{stopReason:"toolUse"}),
   fauxAssistantMessage([fauxToolCall("mm_qc_report",{verdict:"pass",summary:"Reviewed A and B"},{id:"qc-final"})],{stopReason:"toolUse"}),
   fauxAssistantMessage([fauxText("Final review done.")]),
  ]);
  const binding=await x.durable.launch({...x.launch,reservation:r,
    prompt:"Use mm_final_qc_contract for every index; then report PASS."});
  await x.waitFor(()=>x.agents.getRun("p","o","workflow",r.runId)?.phase==="settled");
  assert.equal(x.ledger.report(binding)?.kind,"qc",JSON.stringify({calls:x.faux.state.callCount,events:x.events.map(x=>x.event.kind+":"+x.event.text),reports:x.reports}));
  assert.equal(x.ledger.report(binding)?.verdict,"pass");
  assert.equal(x.reports.length,1);
 }finally{await x.close();}
});
test("Audit F18: missing source pages make a final-QC PASS invalid",async()=>{
 const x=fixture();
 const r={...x.r,taskId:"mm-final-integration",runId:"qc-mm-final-integration-1"};
 x.options.finalContracts=()=>[
  {taskId:"a",title:"A",qcSha:"a".repeat(40)},
  {taskId:"b",title:"B",qcSha:"b".repeat(40)},
 ];
 try{
  x.faux.setResponses([
   fauxAssistantMessage([fauxToolCall("mm_qc_report",{verdict:"pass",summary:"Not checked"},{id:"early-qc"})],{stopReason:"toolUse"}),
   fauxAssistantMessage([fauxText("Terminated.")]),
  ]);
  const binding=await x.durable.launch({...x.launch,reservation:r});
  await x.waitFor(()=>x.agents.getRun("p","o","workflow",r.runId)?.phase==="settled");
  assert.equal(x.ledger.report(binding),undefined);
 }finally{await x.close();}
});
