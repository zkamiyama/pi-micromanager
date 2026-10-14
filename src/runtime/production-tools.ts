/** Production workers get no NodeExecutionEnv or arbitrary host file tools. */
import {Type} from "@earendil-works/pi-ai";
import {defineTool,type ToolRegistration} from "@earendil-works/pi-durable";
import {isAbsolute,relative} from "node:path";
import {isWithin} from "../security/policy.js";
import {sandboxExec,FILE_SERVICE,type SandboxLimits} from "../security/sandbox.js";
import {brokerGit} from "../security/git-broker.js";
export function productionTools(cwd:string,writable:boolean,allowedMergeShas:readonly string[],
  limits:SandboxLimits,assertActive:()=>void):ToolRegistration[]{
  const path=Type.String({minLength:1,maxLength:1024});
  const result=(r:{exitCode:number;stdout:string;stderr:string})=>({isError:r.exitCode!==0,
    output:[{type:"text" as const,text:(r.stdout+(r.stderr?"\n"+r.stderr:"")).slice(0,62000)}]});
  const normalized=(name:string)=>{
    if(!isAbsolute(name))return name;
    if(!isWithin(cwd,name))throw new Error("Path outside bound Workspace");return relative(cwd,name)||".";
  };
  const file=async(op:string,args:{path:string;[key:string]:unknown},signal?:AbortSignal)=>{
    assertActive();return result(await sandboxExec(cwd,["/runtime/node","-e",FILE_SERVICE],!writable,limits,signal,
      JSON.stringify({...args,path:normalized(args.path),op})));
  };
  const tools:ToolRegistration[]=[
    defineTool({name:"read",description:"Read a bounded text range inside the isolated Workspace.",replay:"safe",
      parameters:Type.Object({path,offset:Type.Optional(Type.Integer({minimum:1})),limit:Type.Optional(Type.Integer({minimum:1,maximum:500}))}),
      async execute(args,_api,ctx){return file("read",args,ctx.abortSignal);}}),
    defineTool({name:"mm_list_repo_files",description:"List one bounded Workspace directory. Use path to navigate.",replay:"safe",
      parameters:Type.Object({path:Type.Optional(path)}),
      async execute(args,_api,ctx){return file("list",{path:args.path??"."},ctx.abortSignal);}}),
  ];
  if(!writable)return tools;
  tools.push(
    defineTool({name:"write",description:"Write a bounded text file inside the isolated Workspace.",replay:"unsafe",
      parameters:Type.Object({path,content:Type.String({maxLength:1_000_000})}),
      async execute(args,_api,ctx){return file("write",args,ctx.abortSignal);}}),
    defineTool({name:"edit",description:"Replace exactly one text match inside the isolated Workspace.",replay:"unsafe",
      parameters:Type.Object({path,oldText:Type.String({minLength:1,maxLength:1_000_000}),content:Type.String({maxLength:1_000_000})}),
      async execute(args,_api,ctx){return file("edit",args,ctx.abortSignal);}}),
    defineTool({name:"bash",description:"Run in an isolated Workspace with no host home, network or Git metadata. Use mm_git_commit for commits.",replay:"unsafe",
      parameters:Type.Object({command:Type.String({minLength:1,maxLength:16000})}),
      async execute(args,_api,ctx){assertActive();return result(await sandboxExec(cwd,["/bin/bash","--noprofile","--norc","-c",args.command],false,limits,ctx.abortSignal));}}),
    defineTool({name:"mm_git_status",description:"Inspect the host-bound local Worktree's Git status.",replay:"safe",parameters:Type.Object({}),
      async execute(_args,_api,ctx){assertActive();return result(await brokerGit(cwd,"status",undefined,[],limits,ctx.abortSignal));}}),
    defineTool({name:"mm_git_diff",description:"Inspect local diff without external diff helpers.",replay:"safe",parameters:Type.Object({}),
      async execute(_args,_api,ctx){assertActive();return result(await brokerGit(cwd,"diff",undefined,[],limits,ctx.abortSignal));}}),
    defineTool({name:"mm_git_commit",description:"Stage and commit this Worktree through a fixed hook-free broker. Does not push.",replay:"unsafe",
      parameters:Type.Object({message:Type.String({minLength:1,maxLength:300})}),
      async execute(args,_api,ctx){assertActive();return result(await brokerGit(cwd,"commit",args.message,[],limits,ctx.abortSignal));}}),
  );
  if(allowedMergeShas.length)tools.push(defineTool({name:"mm_git_merge_source",description:"Merge one exact host-frozen final source QC SHA; resolve any conflicts and commit through the broker.",replay:"unsafe",
    parameters:Type.Object({sha:Type.String({minLength:40,maxLength:64})}),
    async execute(args,_api,ctx){assertActive();return result(await brokerGit(cwd,"merge",args.sha,allowedMergeShas,limits,ctx.abortSignal));}}));
  return tools;
}
