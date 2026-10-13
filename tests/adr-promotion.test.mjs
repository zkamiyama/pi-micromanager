import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {WorkflowStore} from "../dist/core/store.js";
import {AgentRegistry} from "../dist/runtime/registry.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {AdrPromotion} from "../dist/automation/adr-promotion.js";

const fields={filename:"0010-feature-auth.md",title:"Safe API contract",
  context:"Token rotation must preserve compatible clients.",
  options:"Option A: preserve compatibility. Option B: reject older clients.",
  decision:"Keep compatibility and verify rejection paths in QC.",
  consequences:"Additional compatibility tests and migration documentation."};
const definition={id:"flow",title:"Integrate API",maxQcRounds:2,
  maxParallelByRole:{implementer:1,reviewer:1,architect:1,planner:1},
  tasks:[{id:"feature",title:"Implement API",kind:"implementation",
    role:"implementer",dependsOn:[],description:"New API",
    acceptanceCriteria:["Pass tests"]}]};
function cmd(cwd,...args){
  return execFileSync("git",["-C",cwd,...args],{encoding:"utf8",timeout:10000}).trim();
}
function commit(repo,file){
  cmd(repo,"add",file);
  cmd(repo,"-c","user.name=Test","-c","user.email=mm@example.invalid",
    "commit","-m","Git ADR test");
}
function fixture(){
  const home=mkdtempSync(join(tmpdir(),"mm-adr-proof-"));
  const main=join(home,"project"),target=join(home,"adr-branch"),data=join(home,"data");
  mkdirSync(main,{recursive:true});mkdirSync(data,{recursive:true});
  execFileSync("git",["init","-b","main",main],{encoding:"utf8",timeout:10000});
  writeFileSync(join(main,"README.md"),"Test project");
  commit(main,"README.md");
  cmd(main,"worktree","add","-b","docs/review",target);
  const baseline=cmd(target,"rev-parse","HEAD");
  const workflows=new WorkflowStore(join(data,"workflow.sqlite"));
  const agents=new AgentRegistry(join(data,"agents.sqlite"));
  const ledger=new AutopilotLedger(join(data,"ledger.sqlite"));
  let wf=workflows.create("p","o",definition);
  wf=workflows.act("p","o","flow",wf.revision,"start",{type:"start",taskId:"feature"});
  wf=workflows.act("p","o","flow",wf.revision,"finish",{type:"implementation_finished",
    taskId:"feature",headSha:baseline,criteriaRevision:0,testsPassed:true});
  wf=workflows.act("p","o","flow",wf.revision,"qc",{type:"qc_finalized",
    taskId:"feature",runId:"qc-feature-1",headSha:baseline,
    criteriaRevision:0,attempt:1,verdict:"pass"});
  wf=workflows.act("p","o","flow",wf.revision,"integrate",
    {type:"integrate",taskId:"feature"});
  const reservation={projectId:"p",orchestraWorkspaceId:"o",
    workspaceId:"review-worker",workflowId:"flow",taskId:"feature",
    runId:"qc-feature-1",seat:"qc",requestId:"auto:qc-feature"};
  agents.reserve(reservation);
  const b=agents.assign(reservation,"native-qc-1");
  agents.record(b,{kind:"agent_settled",text:"Agent settled",at:Date.now(),sequence:1});
  const evidence=ledger.sealEvidence(b,"qc","Verified "+baseline);
  agents.seal("p","o","native-qc-1",evidence.ref);
  const host={lifetimeSignal:new AbortController().signal,
    async execFile(input){
      try{
        const stdout=execFileSync(input.file,[...(input.args??[])],{
          cwd:input.cwd,encoding:"utf8",timeout:10000,maxBuffer:1024*1024,
        });
        return {exitCode:0,signal:null,stdout,stderr:"",
          stdoutTruncated:false,stderrTruncated:false};
      }catch(error){
        return {exitCode:error.status??null,signal:error.signal??null,
          stdout:String(error.stdout??""),stderr:String(error.stderr??""),
          stdoutTruncated:false,stderrTruncated:false};
      }
    },
  };
  const screenshotReferences=[{
    runId:"qc-feature-1",sourceSha:baseline,sha256:"d".repeat(64),
    bytes:1542,relativePath:"screenshots/contract.png",
  }];
  const opts={path:join(data,"adr.sqlite"),
    workflows,agents,ledger,host,screenshots:{
      list(){return screenshotReferences.map((s,i)=>({...s,id:"mock-"+i}));},
      preview(_p,_o,_w,id){
        if(id!=="mock-0")throw new Error("Wrong screenshot reference");
        return {artifact:screenshotReferences[0],dataUrl:null,inlineLimit:0};
      },
    },workspaces:()=>({version:1,async resolve({projectId,workspaceId}){
      if(projectId!=="p"||workspaceId!=="adr-review")
        throw new Error("Unknown linked project/workspace");
      return {project:{id:"p",name:"Test",path:main},
        workspace:{id:"adr-review",projectId:"p",path:target,
          label:"ADR review",isMain:false,
          provider:{metadata:{isGitWorktree:true}}}};
    }})};
  let promotion=new AdrPromotion(opts);
  return {home,main,target,data,baseline,ledger,workflows,agents,opts,fields,
    get promotion(){return promotion;},
    set promotion(v){promotion=v;},
    close(){
      promotion.close();ledger.close();agents.close();workflows.close();
      rmSync(home,{force:true,recursive:true});
    }};
}
test("Reviewed ADR captures real QC/evidence and stages exact bytes without commit/push",async()=>{
  const x=fixture();
  try{
    const plan=await x.promotion.preview("p","o","flow","adr-review",fields);
    assert.equal(plan.state,"prepared");
    assert.equal(plan.filename,fields.filename);
    assert.equal(plan.targetHead,x.baseline);
    assert.match(plan.content,/Token rotation must preserve/);
    assert.match(plan.content,/qc-feature-1/);
    assert.match(plan.content,/sealed evidence/);
    assert.match(plan.content,/screenshots\/contract.png/);
    assert.match(plan.content,/Status: Proposed/);
    assert.ok(!existsSync(join(x.target,"docs","adr",fields.filename)));
    const staged=await x.promotion.stage("p","o",plan.id);
    assert.equal(staged.state,"staged");
    const text=readFileSync(join(x.target,"docs","adr",fields.filename),"utf8");
    assert.equal(text,plan.content);
    assert.equal(createHash("sha256").update(text).digest("hex"),plan.sha256);
    assert.equal(x.promotion.inspect("p","o",plan.id).state,"staged");
    assert.equal((await x.promotion.stage("p","o",plan.id)).sha256,plan.sha256);
    assert.equal(cmd(x.target,"status","--porcelain").startsWith("?? docs/"),true,
      "User still needs to review, git add/commit and publish their own PR");
    assert.equal(cmd(x.target,"rev-parse","HEAD"),x.baseline,
      "Micromanager must not commit or change Git HEAD itself");
    x.promotion.close();
    x.promotion=new AdrPromotion(x.opts);
    assert.equal(x.promotion.latest("p","o","flow").id,plan.id);
    assert.equal(x.promotion.inspect("p","o",plan.id).state,"staged");
  }finally{x.close();}
});
test("ADR stage rejects dirty/moved targets and file overwrite",async()=>{
  const x=fixture();
  try{
    const plan=await x.promotion.preview("p","o","flow","adr-review",fields);
    writeFileSync(join(x.target,"untracked.txt"),"unreviewed");
    await assert.rejects(x.promotion.stage("p","o",plan.id),/uncommitted/);
    assert.equal(x.promotion.inspect("p","o",plan.id).state,"prepared");
    rmSync(join(x.target,"untracked.txt"));
    writeFileSync(join(x.target,"README.md"),"Different reviewed base");
    commit(x.target,"README.md");
    await assert.rejects(x.promotion.stage("p","o",plan.id),
      /target changed since review/);
  }finally{x.close();}
});
test("ADR candidate rejects arbitrary filename, unreviewed sections and cross-workspace access",async()=>{
  const x=fixture();
  try{
    for(const name of ["../oops.md","../0010-evil.md","../../secrets",
      "main.md","0010-unsafe.svg"]){
      await assert.rejects(x.promotion.preview("p","o","flow","adr-review",
        {...fields,filename:name}),/ADR filename/);
    }
    await assert.rejects(x.promotion.preview("p","o","flow","adr-review",
      {...fields,decision:""}),/ADR decision/);
    const plan=await x.promotion.preview("p","o","flow","adr-review",fields);
    assert.throws(()=>x.promotion.inspect("other","o",plan.id),/does not belong/);
    await assert.rejects(x.promotion.stage("other","o",plan.id),/does not belong/);
    assert.equal(x.promotion.latest("other","o","flow"),null);
  }finally{x.close();}
});
test("ADR source and target must be fully stable and have durable QC evidence",async()=>{
  const x=fixture();
  try{
    const plan=await x.promotion.preview("p","o","flow","adr-review",fields);
    x.ledger.save("p","o","flow",{workspaces:{feature:"writer"},
      models:Object.fromEntries(["implementer","qc","planner","architect"]
        .map(role=>[role,{provider:"mock",model:"mock"}])),
      test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:2});
    x.ledger.setStatus("p","o","flow",true,"running");
    await assert.rejects(x.promotion.stage("p","o",plan.id),/Pause Autopilot/);
    x.ledger.setStatus("p","o","flow",false,"paused");
    const reservation={projectId:"p",orchestraWorkspaceId:"o",
      workspaceId:"adr-review",workflowId:"other",taskId:"other",
      runId:"impl-other-1",seat:"implementer",requestId:"auto:other"};
    x.agents.reserve(reservation);
    await assert.rejects(x.promotion.stage("p","o",plan.id),
      /leased/);
  }finally{x.close();}
});
test("ADR review branch cannot reuse a previously sealed implementation Worktree",async()=>{
  const x=fixture();
  try{
    const run={projectId:"p",orchestraWorkspaceId:"o",workspaceId:"adr-review",
      workflowId:"flow",taskId:"feature",runId:"impl-feature-99",
      seat:"implementer",requestId:"auto:writer-history"};
    x.agents.reserve(run);
    const bound=x.agents.assign(run,"historical-writer");
    x.agents.record(bound,{kind:"agent_settled",text:"Agent settled",
      at:Date.now(),sequence:1});
    x.agents.seal("p","o","historical-writer","sha256:historical-only");
    await assert.rejects(x.promotion.preview("p","o","flow","adr-review",fields),
      /separate from implementation\/QC Worktrees/);
  }finally{x.close();}
});
test("Reserved ADR writing is recovered only from exact file bytes, never overwritten",async()=>{
  const x=fixture();
  try{
    const plan=await x.promotion.preview("p","o","flow","adr-review",fields);
    const db=new DatabaseSync(join(x.data,"adr.sqlite"));
    db.prepare("UPDATE adr_drafts SET state='reserved' WHERE id=?").run(plan.id);
    db.close();
    await assert.rejects(x.promotion.stage("p","o",plan.id),/missing/);
    const path=join(x.target,"docs","adr",fields.filename);
    mkdirSync(dirname(path),{recursive:true});
    writeFileSync(path,"a different document");
    assert.throws(()=>x.promotion.inspect("p","o",plan.id),/differ/);
    assert.equal(readFileSync(path,"utf8"),"a different document");
    writeFileSync(path,plan.content);
    assert.equal(x.promotion.inspect("p","o",plan.id).state,"staged");
  }finally{x.close();}
});
test("ADR preview quota bounds repeated proposals but does not mutate Git",async()=>{
  const x=fixture();
  try{
    for(let i=0;i<8;i++){
      const proposal=await x.promotion.preview("p","o","flow","adr-review",{
        ...fields,title:fields.title+" "+i,
      });
      assert.equal(proposal.state,"prepared");
    }
    await assert.rejects(x.promotion.preview("p","o","flow","adr-review",fields),
      /Too many pending ADR previews/);
    assert.equal(cmd(x.target,"status","--porcelain"),"",
      "Read-only ADR previews must not create files or change Git");
  }finally{x.close();}
});

test("Explicit reviewed ADR publication commits exact file, pushes only new branch and opens Draft PR",async()=>{
 const x=fixture();
 try{
   const bare=join(x.home,"remote.git");
   execFileSync("git",["init","--bare",bare],{encoding:"utf8"});
   cmd(x.main,"remote","add","origin",bare);
   const cfg={models:Object.fromEntries(["planner","implementer","qc","architect"]
       .map(role=>[role,{provider:"mock",model:"exact"}])),
     workspaces:{feature:"review-worker"},
     publication:{remote:"origin",baseBranch:"main",draft:true},
     test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:3};
   x.ledger.save("p","o","flow",cfg);
   const original=x.opts.host.execFile.bind(x.opts.host),gh=[];
   x.opts.host.execFile=async input=>{
     if(input.file==="gh"){
       gh.push([...input.args]);
       return {exitCode:0,signal:null,stdout:"https://github.com/acme/adr-repo/pull/7\n",
         stderr:"",stdoutTruncated:false,stderrTruncated:false};
     }
     if(input.file==="git"&&input.args.slice(-3).join(" ")==="remote get-url origin")
       return {exitCode:0,signal:null,stdout:"https://github.com/acme/adr-repo.git\n",
         stderr:"",stdoutTruncated:false,stderrTruncated:false};
     return original(input);
   };
   const plan=await x.promotion.preview("p","o","flow","adr-review",fields);
   await x.promotion.stage("p","o",plan.id);
   const before=cmd(x.target,"rev-parse","HEAD");
   const published=await x.promotion.publish("p","o",plan.id);
   assert.equal(published.state,"published");
   assert.equal(published.url,"https://github.com/acme/adr-repo/pull/7");
   const after=cmd(x.target,"rev-parse","HEAD");
   assert.notEqual(after,before);
   assert.equal(cmd(x.target,"rev-parse","HEAD^"),before);
   assert.equal(cmd(x.target,"show","--pretty=format:","--name-only","HEAD"),
     "docs/adr/"+fields.filename);
   assert.equal(readFileSync(join(x.target,"docs","adr",fields.filename),"utf8"),plan.content);
   assert.equal(cmd(x.target,"status","--porcelain"),"");
   assert.equal(cmd(x.target,"ls-remote","--heads","origin","refs/heads/docs/review")
     .split(/\s+/)[0],after);
   assert.equal(gh.length,1);
   assert.ok(gh[0].includes("--draft"));
   assert.ok(!gh[0].includes("--admin")&&!gh[0].includes("--auto"));
   assert.equal((await x.promotion.publish("p","o",plan.id)).url,published.url);
   assert.equal(gh.length,1,"Repeated Publish must never create a duplicate PR");
 }finally{x.close();}
});

test("ADR PR fails closed before any Git write on a changed or dirty review target",async()=>{
 const x=fixture();
 try{
   x.ledger.save("p","o","flow",{models:Object.fromEntries(
     ["planner","implementer","qc","architect"].map(role=>[role,{
       provider:"mock",model:"exact"}])),
     workspaces:{feature:"review-worker"},
     publication:{remote:"origin",baseBranch:"main",draft:true},
     test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:3});
   const plan=await x.promotion.preview("p","o","flow","adr-review",fields);
   await x.promotion.stage("p","o",plan.id);
   writeFileSync(join(x.target,"unrelated.txt"),"unauthorized change");
   await assert.rejects(x.promotion.publish("p","o",plan.id),/only the exact new untracked ADR/);
   assert.equal(cmd(x.target,"rev-parse","HEAD"),x.baseline);
   assert.equal(x.promotion.publication("p","o",plan.id),null);
 }finally{x.close();}
});

test("Uncertain Git commit stops rather than repeating it or creating a PR",async()=>{
 const x=fixture();
 try{
   const bare=join(x.home,"remote.git");
   execFileSync("git",["init","--bare",bare],{encoding:"utf8"});
   cmd(x.main,"remote","add","origin",bare);
   x.ledger.save("p","o","flow",{models:Object.fromEntries(
     ["planner","implementer","qc","architect"].map(role=>[role,{
       provider:"mock",model:"exact"}])),
     workspaces:{feature:"review-worker"},
     publication:{remote:"origin",baseBranch:"main",draft:true},
     test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:3});
   const plan=await x.promotion.preview("p","o","flow","adr-review",fields);
   await x.promotion.stage("p","o",plan.id);
   const original=x.opts.host.execFile.bind(x.opts.host);
   let commitCalls=0;
   x.opts.host.execFile=async input=>{
     if(input.file==="git"&&input.args.includes("commit")){
       commitCalls++;
       await original(input); // Git may have succeeded before the response was lost
       throw new Error("lost commit response");
     }
     if(input.file==="git"&&input.args.slice(-3).join(" ")==="remote get-url origin")
       return {exitCode:0,signal:null,stdout:"https://github.com/acme/adr-repo.git\n",
         stderr:"",stdoutTruncated:false,stderrTruncated:false};
     if(input.file==="gh")throw new Error("PR must never be created");
     return original(input);
   };
   await assert.rejects(x.promotion.publish("p","o",plan.id),/lost commit response/);
   const state=x.promotion.publication("p","o",plan.id);
   assert.equal(state.state,"reserved_commit");
   assert.equal(cmd(x.target,"rev-parse","HEAD^"),x.baseline);
   assert.equal((await x.promotion.publish("p","o",plan.id)).state,"reserved_commit");
   assert.equal(commitCalls,1,"No reexecution of uncertain commit");
 }finally{x.close();}
});
