import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,symlinkSync,linkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {validateModelAuthFile} from '../dist/security/auth-source.js';
import {parseProductionPolicy,installProductionPolicy,productionPolicy} from '../dist/security/policy.js';
import {createDurableModels} from '../dist/runtime/durable-runner.js';
import server from '../dist/pi-web/server.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'mm-auth-source-test-'));
 const project=join(root,'project'),state=join(root,'state'),pkg=join(root,'package');
 for(const p of [project,state,pkg])mkdirSync(p,{mode:0o700});
 const auth=join(root,'selected.json');
 writeFileSync(auth,'{}\n',{mode:0o600});
 const policy={mode:'production',projectRoots:[project],models:[{provider:'faux',model:'faux-1'}],modelAuthFile:auth};
 const host={apiVersion:3,pluginId:'micromanager',packageRoot:pkg,dataDirectory:state,
   lifetimeSignal:new AbortController().signal,signal:new AbortController().signal,
   settings:{productionSecurity:policy},logger:{debug(){},info(){},warn(){},error(){}},
   execFile:async()=>{throw Error('Metadata validation must not execute a process');}};
 return {root,project,state,pkg,auth,policy,host,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('#92 explicit host credential source is metadata-only, private and immutable',()=>{
 const x=fixture();let remove;
 try{
  assert.equal(validateModelAuthFile(x.auth,[x.project,x.state,x.pkg]),x.auth);
  const policy=parseProductionPolicy(x.policy);
  assert.equal(policy.modelAuthFile,x.auth);
  remove=installProductionPolicy(x.state,policy);
  policy.modelAuthFile='changed-after-install';
  assert.equal(productionPolicy(x.state).modelAuthFile,x.auth);
 }finally{remove?.();x.close();}
});
test('#92 host credential source refuses aliases, hardlinks, shared modes and workspace containment',()=>{
 const x=fixture();try{
  const alias=join(x.root,'alias');symlinkSync(x.auth,alias);
  assert.throws(()=>validateModelAuthFile(alias,[]),/credential source/);
  const hard=join(x.root,'hard');linkSync(x.auth,hard);
  assert.throws(()=>validateModelAuthFile(x.auth,[]),/credential source/);
  rmSync(hard);chmodSync(x.auth,0o644);
  assert.throws(()=>validateModelAuthFile(x.auth,[]),/credential source/);
  chmodSync(x.auth,0o600);
  assert.throws(()=>validateModelAuthFile(x.auth,[x.root]),/credential source/);
  assert.throws(()=>validateModelAuthFile('relative.json',[]),/credential source/);
  assert.throws(()=>validateModelAuthFile(join(x.root,'absent'),[]),/credential source/);
 }finally{x.close();}
});
test('#92 public server refuses credential source inside its code or control-state roots',async()=>{
 for(const folder of ['project','state','pkg']){
  const x=fixture();try{
   const misplaced=join(x[folder],'selected.json');writeFileSync(misplaced,'{}',{mode:0o600});
   x.host.settings.productionSecurity.modelAuthFile=misplaced;
   await assert.rejects(server.activate(x.host),/credential source/);
  }finally{x.close();}
 }
});
test('#92 explicit public ModelRuntime selection never loads ambient custom model settings',async()=>{
 const original=ModelRuntime.create,calls=[];
 ModelRuntime.create=async options=>{calls.push(options);return {synthetic:true};};
 try{
  await createDurableModels('/synthetic/owner-selected-auth.json');
  assert.deepEqual(calls[0],{allowModelNetwork:false,refreshOnCreate:false,
    authPath:'/synthetic/owner-selected-auth.json',modelsPath:null});
  await createDurableModels();
  assert.equal(calls[1].authPath,undefined,'Existing default remains unchanged without an explicit host source');
 }finally{ModelRuntime.create=original;}
});
