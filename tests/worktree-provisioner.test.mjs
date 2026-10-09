import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,existsSync,mkdirSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkflowStore} from "../dist/core/store.js";
import {AutopilotLedger} from "../dist/automation/ledger.js";
import {ManagedWorktreeProvisioner} from "../dist/automation/worktree-provisioner.js";

const SHA="b".repeat(40);
const wf={id:"flow",title:"Build API",maxQcRounds:3,
  maxParallelByRole:{implementer:2,reviewer:2,architect:2,planner:1},
  tasks:[{id:"api",title:"Build API",kind:"implementation",role:"implementer",
    description:"Implement one endpoint",acceptanceCriteria:["200 response"],dependsOn:[]}]};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"mm-owned-worktree-"));
  const store=new WorkflowStore(join(dir,"wf.sqlite"));
  const ledger=new AutopilotLedger(join(dir,"auto.sqlite"));
  store.create("project","orchestra",wf);
  const invocations=[],registered=new Map();
  let failCreate=false,baseSha=SHA,dirty=false;
  const controller=new AbortController();
  const host={lifetimeSignal:controller.signal,
    async execFile(req){
      invocations.push({file:req.file,args:[...(req.args??[])],
        env:req.env,unsetEnv:req.unsetEnv,signal:req.signal});
      assert.equal(req.file,"git");
      const [flag,cwd,...args]=req.args;
      assert.equal(flag,"-C");
      const verb=args.slice(0,3).join(" ");
      let exitCode=0,stdout="",stderr="";
      if(verb.startsWith("rev-parse --show-toplevel"))stdout=cwd+"\n";
      else if(verb.startsWith("rev-parse HEAD")){
        const target=[...registered].find(([p])=>p===cwd);
        stdout=(target?.[1].sha??baseSha)+"\n";
      }else if(verb.startsWith("status --porcelain"))stdout=dirty?"?? dirty.txt\n":"";
      else if(verb.startsWith("show-ref --verify --quiet")){
        exitCode=[...registered.values()].some(x=>"refs/heads/"+x.branch===args[3])?0:1;
      }else if(verb.startsWith("worktree add")){
        const path=args[args.length-2],sha=args[args.length-1],branch=args[4];
        if(failCreate){exitCode=1;stderr="uncertain mock create";}
        else{mkdirSync(path,{recursive:true,mode:0o700});registered.set(path,{sha,branch});}
      }else if(verb.startsWith("worktree list --porcelain")){
        stdout=[...registered].map(([path,r])=>
          "worktree "+path+"\0HEAD "+r.sha+"\0branch refs/heads/"+r.branch+"\0\0").join("");
      }else throw Error("Unexpected Git command: "+verb);
      return {exitCode,signal:null,stdout,stderr,stdoutTruncated:false,stderrTruncated:false};
    }};
  const options={path:join(dir,"plans.sqlite"),dataDirectory:dir,host,workflows:store,ledger};
  let manager=new ManagedWorktreeProvisioner(options);
  return {get manager(){return manager;},set manager(v){manager=v;},options,store,ledger,
    invocations,registered,setFail(v){failCreate=v;},setHead(v){baseSha=v;},
    setDirty(v){dirty=v;},controller,
    close(){manager.close();ledger.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test("Provisioning preview is non-mutating and creates an owned branch only after explicit confirmation",async()=>{
  const x=fixture();
  try{
    const plan=await x.manager.preview("project","orchestra","flow","api","/repo");
    assert.equal(plan.stage,"prepared");
    assert.equal(x.manager.find("project","orchestra","flow","api").id,plan.id);
    assert.equal(x.manager.find("other","orchestra","flow","api"),null);
    assert.match(plan.branch,/^mm\/[a-f0-9]{16}\/flow\/api$/);
    assert.match(plan.path,/managed-worktrees/);
    assert.equal(x.registered.size,0);
    const created=await x.manager.create("project","orchestra",plan.id);
    assert.equal(created.stage,"created");
    assert.equal(created.path,plan.path);
    assert.equal(created.baseSha,SHA);
    assert.ok(x.registered.has(plan.path));
    assert.equal((await x.manager.inspect("project","orchestra",plan.id)).stage,"created");
    x.manager.close();
    x.manager=new ManagedWorktreeProvisioner(x.options);
    assert.equal(x.manager.find("project","orchestra","flow","api").stage,"created");
    assert.equal((await x.manager.create("project","orchestra",plan.id)).stage,"created");
    assert.equal(x.invocations.filter(x=>x.args.includes("add")).length,1,
      "Never create a second Git worktree after a successful create");
    assert.ok(x.invocations.every(x=>x.file==="git"&&
      x.unsetEnv.includes("GIT_DIR")&&x.unsetEnv.includes("GIT_WORK_TREE")));
    assert.equal(x.ledger.get("project","orchestra","flow"),undefined,
      "Worktree creation cannot implicitly enable Autopilot");
  }finally{x.close();}
});
test("Uncertain native Git create is reserved durably; retry never launches a duplicate",async()=>{
  const x=fixture();
  try{
    const plan=await x.manager.preview("project","orchestra","flow","api","/repo");
    x.setFail(true);
    await assert.rejects(x.manager.create("project","orchestra",plan.id),/inspect reserved plan/);
    x.manager.close();
    x.manager=new ManagedWorktreeProvisioner(x.options);
    await assert.rejects(x.manager.create("project","orchestra",plan.id),/absent.*cannot be retried/);
    assert.equal(x.invocations.filter(x=>x.args.includes("add")).length,1);
  }finally{x.close();}
});
test("Managed Worktree refuses stale baseline, dirty project and unstarted Task mismatches",async()=>{
  const x=fixture();
  try{
    x.setDirty(true);
    await assert.rejects(x.manager.preview("project","orchestra","flow","api","/repo"),
      /uncommitted/);
    x.setDirty(false);
    const planned=await x.manager.preview("project","orchestra","flow","api","/repo");
    x.setHead("c".repeat(40));
    await assert.rejects(x.manager.create("project","orchestra",planned.id),
      /HEAD changed/);
    assert.equal(x.registered.size,0);
  }finally{x.close();}
});
test("Live or configured Workflows cannot be provisioned or mutated",async()=>{
  const x=fixture();
  try{
    const planned=await x.manager.preview("project","orchestra","flow","api","/repo");
    const cfg={workspaces:{api:"already-linked"},models:Object.fromEntries(
      ["planner","implementer","qc","architect"].map(s=>[s,{provider:"mock",model:"mock"}])),
      test:{file:"node",args:["--test"],timeoutMs:10000},maxAttempts:3};
    x.ledger.save("project","orchestra","flow",cfg);
    await assert.rejects(x.manager.create("project","orchestra",planned.id),
      /already has a configured PI WEB Workspace/);
    x.ledger.setStatus("project","orchestra","flow",true,"running");
    await assert.rejects(x.manager.preview("project","orchestra","flow","api","/repo"),
      /Pause Autopilot/);
  }finally{x.close();}
});

test("A Git worktree checkout swapped for a symlink is never treated as owned",async()=>{
  const x=fixture();
  try{
    const planned=await x.manager.preview("project","orchestra","flow","api","/repo");
    await x.manager.create("project","orchestra",planned.id);
    rmSync(planned.path,{recursive:true,force:true});
    symlinkSync(x.options.dataDirectory,planned.path,"dir");
    await assert.rejects(x.manager.inspect("project","orchestra",planned.id),
      /not a real owned directory/);
  }finally{x.close();}
});
