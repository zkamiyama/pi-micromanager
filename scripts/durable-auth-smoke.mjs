#!/usr/bin/env node
/**
 * Explicit, opt-in real-provider acceptance test.
 * Uses the daemon OS user's Pi credential store (including OAuth); NEVER
 * copies/logs tokens. Writes only to a disposable SQLite under os.tmpdir().
 * The model receives no coding/shell/file tools or repository contents.
 */
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {Type} from "@earendil-works/pi-ai";
import {Harness,createRegistry,defineExtension,defineTool}
  from "@earendil-works/pi-durable";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import {BACKGROUND_CONTEXT} from "@earendil-works/chord/context";

const [provider,model]=process.argv.slice(2);
if(!provider||!model||process.argv.length!==4||
   !/^[a-z0-9][a-z0-9._-]*$/i.test(provider)||
   !/^[a-z0-9][a-z0-9._-]*$/i.test(model)){
  console.error("Usage: npm run smoke:durable-auth -- <provider> <model>");
  console.error("Example: npm run smoke:durable-auth -- openai gpt-5.5");
  console.error("This performs one authenticated model/tool call (usage may be billed).");
  process.exit(2);
}

const context=BACKGROUND_CONTEXT;
const directory=mkdtempSync(join(tmpdir(),"mm-durable-auth-smoke-"));
const db=join(directory,"harness.sqlite");
let first,second,deadline;
let reports=0;
try{
  const models=await ModelRuntime.create({
    allowModelNetwork:false,refreshOnCreate:false,
  });
  if(!models.getModel(provider,model))
    throw new Error("Model not in this Pi user's configured catalog");
  const report=defineTool({
    name:"mm_auth_smoke_report",
    description:"Acknowledge one Pi Durable authenticated model and tool turn.",
    parameters:Type.Object({ok:Type.Literal(true)}),
    replay:"safe",
    async execute(){
      reports++;
      return {output:[{type:"text",text:"Local smoke report committed."}]};
    },
  });
  const registry=createRegistry();
  registry.install(defineExtension({name:"mm-auth-smoke",tools:[report]}));
  const options={models,registry};
  const agent={
    model:{provider,modelId:model},cwd:directory,
    tools:[report],modelTools:[report],
    instructions:"Call mm_auth_smoke_report with ok=true exactly once. Do not execute code or request files. Then finish.",
  };
  first=await Harness.open(await openNodeSqliteStorage(db),options,context);
  const root=await first.root(context,{agent});
  const sent=await root.submit({
    type:"input",
    content:"Call mm_auth_smoke_report exactly once with ok=true.",
    requestId:"mm-smoke-single-turn",
  },context);
  const settled=await Promise.race([
    sent.wait(context),
    new Promise((_,reject)=>{
      deadline=setTimeout(()=>reject(new Error("Model/tool turn timed out")),60000);
    }),
  ]);
  if(settled.status!=="done"||reports!==1)
    throw new Error("Expected exactly one successful model/tool report");
  await first.close(context);first=undefined;
  second=await Harness.open(await openNodeSqliteStorage(db),options,context);
  const reopened=await second.root(context,{agent});
  if(reopened.id!==root.id||reports!==1)
    throw new Error("SQLite reopen changed Conversation ID or replayed a tool");
  console.log("PASS: authenticated Pi Durable model + typed tool");
  console.log("PASS: SQLite Conversation ID persisted; no duplicate tool call");
  console.log("Backend: "+provider+"/"+model+" (credentials never printed)");
}catch(error){
  console.error("FAIL: "+String(error instanceof Error?error.message:error).slice(0,220));
  process.exitCode=1;
}finally{
  if(deadline!==undefined)clearTimeout(deadline);
  if(first)await first.close(context).catch(()=>{});
  if(second)await second.close(context).catch(()=>{});
  rmSync(directory,{recursive:true,force:true});
}
