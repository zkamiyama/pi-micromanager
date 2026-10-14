import test from 'node:test';
import assert from 'node:assert/strict';
import {guardedHostExecution} from '../dist/security/host-execution.js';
const ok={exitCode:0,signal:null,stdout:'core.repositoryformatversion\n',stderr:'',stdoutTruncated:false,stderrTruncated:false};
for(const change of ['pause','owner-loss'])test(`#81: ${change} during Git security preflight prevents the underlying mutation`,async()=>{
 let release,entered,epoch=0,mutations=0;
 const signal=new AbortController();
 const waiting=new Promise(r=>{release=r;});
 const checking=new Promise(r=>{entered=r;});
 const exec=async r=>{
  if(r.args.includes('config')){entered();await waiting;return ok;}
  mutations++;return ok;
 };
 const policy={publication:[{repository:'acme/repo',baseBranch:'main'}]};
 const wrapped=guardedHostExecution(exec,policy,()=>{
  const start=epoch;return ()=>{if(start!==epoch)throw Error('Operator generation changed');};
 });
 const pending=wrapped({file:'git',args:['-C','/fixture','push','https://github.com/acme/repo.git','a:refs/heads/feature'],signal:signal.signal});
 const rejected=assert.rejects(pending,/Operator generation changed|ownership lost/);
 await checking;
 if(change==='pause')epoch++;else signal.abort(new Error('ownership lost'));
 release();await rejected;assert.equal(mutations,0);
});
