import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readonlyDiscoveryTools} from "../dist/runtime/repository-discovery.js";
test("Read-only repo navigation shows bounded source and ignores symlinks/private directories",async()=>{
 const root=mkdtempSync(join(tmpdir(),"mm-repo-read-"));
 const outside=mkdtempSync(join(tmpdir(),"mm-repo-out-"));
 try{
  mkdirSync(join(root,"src"));mkdirSync(join(root,".git"));mkdirSync(join(root,"node_modules"));
  writeFileSync(join(root,"src","service.ts"),"export const safeContract = true;\n");
  writeFileSync(join(root,".git","secret.txt"),"outside secret");
  writeFileSync(join(root,"node_modules","key.txt"),"outside secret");
  writeFileSync(join(outside,"secret"),"outside secret");
  symlinkSync(join(outside,"secret"),join(root,"src","external.ts"));
  const [list,search]=readonlyDiscoveryTools(root);
  const files=JSON.parse((await list.execute({})).output[0].text);
  assert.deepEqual(files.files,["src/service.ts"]);
  const result=JSON.parse((await search.execute({text:"safeContract"})).output[0].text);
  assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].path,"src/service.ts");
  const excluded=JSON.parse((await search.execute({text:"outside secret"})).output[0].text);
  assert.deepEqual(excluded.matches,[]);
  await assert.rejects(()=>list.execute({pathPrefix:"../../etc"}),/Invalid/);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
