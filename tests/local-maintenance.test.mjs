import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {LocalMaintenance} from '../dist/automation/local-maintenance.js';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'mm-maintenance-contract-')),path=join(root,'operations.sqlite');
 const stop=new AbortController();let manager=new LocalMaintenance(path,stop.signal);
 return {root,path,stop,get manager(){return manager;},
  async reopen(){await manager.close();manager=new LocalMaintenance(path,stop.signal);},
  async close(){await manager.close();rmSync(root,{recursive:true,force:true});}};
}
test('maintenance admission returns before a long operation and duplicate intent cannot execute twice',async()=>{
 const x=fixture();let finish,calls=0;
 const gate=new Promise(r=>finish=r);
 try{
  const start=Date.now();const a=x.manager.admit('p','o','w','same','collect',{workflowId:'w'},async()=>{calls++;await gate;});
  assert.equal(a.phase,'running');assert.ok(Date.now()-start<500);
  const b=x.manager.admit('p','o','w','same','collect',{workflowId:'w'},async()=>{calls++;});
  assert.equal(a.id,b.id);await tick();assert.equal(calls,1);
  assert.throws(()=>x.manager.admit('p','o','w','same','retire',{},async()=>{}),/different intent/);
  assert.throws(()=>x.manager.admit('p','o','w','different','collect',{},async()=>{}),/running or uncertain/);
  assert.throws(()=>x.manager.get('other','o',a.id),/scope/);
  finish();await tick();assert.equal(x.manager.get('p','o',a.id).phase,'completed');
  await x.reopen();assert.equal(x.manager.admit('p','o','w','same','collect',{workflowId:'w'},async()=>{calls++;}).phase,'completed');
  assert.equal(calls,1);
 }finally{finish();await x.close();}
});
test('maintenance close joins admitted work and lifetime loss never produces a completed receipt',async()=>{
 const x=fixture();let finish,finished=false;
 const gate=new Promise(r=>finish=r);
 try{
  const a=x.manager.admit('p','o','w','stop','collect',{},async check=>{await gate;finished=true;check();});
  await tick();x.stop.abort(new Error('Synthetic owner loss'));
  const closing=x.manager.close();let joined=false;void closing.then(()=>joined=true);await tick();
  assert.equal(joined,false);finish();await closing;assert.equal(finished,true);
  const db=new DatabaseSync(x.path,{readOnly:true});
  try{assert.equal(db.prepare('SELECT phase FROM local_maintenance WHERE id=?').get(a.id).phase,'uncertain');}finally{db.close();}
 }finally{rmSync(x.root,{recursive:true,force:true});}
});
test('maintenance reopen latches an interrupted intent and refuses new IDs instead of replay',async()=>{
 const x=fixture();
 try{
  const a=x.manager.admit('p','o','w','interrupted','collect',{},async()=>{});await tick();
  const db=new DatabaseSync(x.path);db.prepare("UPDATE local_maintenance SET phase='running' WHERE id=?").run(a.id);db.close();
  await x.reopen();assert.equal(x.manager.get('p','o',a.id).phase,'uncertain');
  assert.throws(()=>x.manager.admit('p','o','w','new-id','collect',{},async()=>assert.fail('No replay')),/uncertain/);
 }finally{await x.close();}
});
test('maintenance rejects an aborted admission and caps concurrent work without dropping receipts',async()=>{
 const x=fixture();let finish;
 const gate=new Promise(r=>finish=r);
 try{
  for(let i=0;i<4;i++)x.manager.admit('p','o','w'+i,'work','collect',{},async()=>gate);
  assert.throws(()=>x.manager.admit('p','o','overflow','work','collect',{},async()=>{}),/capacity/);
  x.stop.abort();assert.throws(()=>x.manager.admit('p','o','stopped','work','collect',{},async()=>{}));
 }finally{finish();await x.close();}
});
