import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {createHostExecutor} from "../dist/automation/host-port.js";

const SHA="a".repeat(40);
const secret="SECRET_TOKEN_THAT_MUST_NOT_BE_RETAINED";
test("Host test evidence records output hashes and exit code, not raw potentially secret log text",async(t)=>{
  const state=mkdtempSync(join(tmpdir(),"mm-host-evidence-"));t.after(()=>rmSync(state,{recursive:true,force:true}));
  const invocations=[];
  const host={dataDirectory:state,
    lifetimeSignal:new AbortController().signal,
    async execFile(request){
      invocations.push(request);
      let stdout="",stderr="",exitCode=0;
      if(request.file==="git"){
        const args=request.args?.slice(2).join(" ");
        if(args==="rev-parse --show-toplevel")stdout="/safe/worktree\n";
        else if(args==="rev-parse HEAD")stdout=SHA+"\n";
        else if(args==="status --porcelain --untracked-files=all --ignore-submodules=none"||
          args==="ls-files -v -z"||args==="diff-files --quiet --ignore-submodules=none")stdout="";
        else throw new Error("Unexpected mock Git request: "+args);
      }else if(request.file==="node"){
        stdout="stdout contains "+secret;
        stderr="stderr contains "+secret;
        exitCode=1;
      }else throw new Error("Unexpected binary");
      return {stdout,stderr,exitCode,signal:null,
        stdoutTruncated:false,stderrTruncated:false};
    },
  };
  const port=createHostExecutor({
    host,workflows:{get(){return {tasks:{}};}},agents:{},getSessions:()=>undefined,
    getWorkspaces:()=>({version:1,async resolve({projectId,workspaceId}){
      assert.equal(projectId,"p");
      assert.equal(workspaceId,"wt-1");
      return {project:{id:"p",path:"/safe",name:"Safe"},
        workspace:{id:"wt-1",projectId:"p",path:"/safe/worktree",
          isMain:false,provider:{metadata:{isGitWorktree:true}},label:"Test"}};
    }}),
    probe:async()=>{throw new Error("not used");},
    validateRun:()=>"",
    replaySettledReport:async()=>{},notify(){},
  });
  const previousTestKey=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY="synthetic-test-placeholder";
  const result=await port.verify({projectId:"p",workspaceId:"wt-1"},{
    test:{execution:"trusted-host",file:"node",args:["--test"],timeoutMs:5000},
  },SHA);
  assert.equal(result.clean,true);
  assert.equal(result.testsPassed,false);
  assert.equal(result.headSha,SHA);
  assert.match(result.details,/exit=1/);
  assert.match(result.details,/stdoutSha256=/);
  assert.match(result.details,/stderrSha256=/);
  assert.ok(result.details.includes(createHash("sha256")
    .update("stderr contains "+secret).digest("hex")));
  assert.ok(!result.details.includes(secret));
  assert.ok(!result.details.includes("stdout contains"));
  assert.ok(invocations.filter(c=>c.file==="git").every(c=>
    c.unsetEnv.includes("GIT_DIR")&&c.unsetEnv.includes("GIT_WORK_TREE")));
  assert.ok(invocations.find(c=>c.file==="node")?.unsetEnv.includes("OPENAI_API_KEY"));
  if(previousTestKey===undefined)delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY=previousTestKey;
});
