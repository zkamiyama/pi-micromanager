import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {zstdCompressSync} from 'node:zlib';
import {LocalArtifacts,localImageMime} from '../dist/automation/local-artifacts.js';

// Every fixture owns a new directory; no native Session, existing project, or
// credential file is read. These are persistence contracts, not browser E2E.
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3vVbcAAAAASUVORK5CYII=','base64');
const digest=b=>createHash('sha256').update(b).digest('hex');
function fixture(maxBytes=1024*1024){
 const root=mkdtempSync(join(tmpdir(),'mm-artifact-ci-'));
 const abort=new AbortController();let protectedWorkflow=false;
 const options={directory:root,policy:{maxBytes,maxAgeDays:1},signal:abort.signal,protected:()=>protectedWorkflow};
 let store=new LocalArtifacts(options);
 const input={key:'first',workflowId:'wf',runId:'qc-task-1',kind:'image',sourceSha:'a'.repeat(40),mime:'image/png',label:'Synthetic one-pixel image'};
 return {root,abort,input,get store(){return store;},protect(v){protectedWorkflow=v;},
  reopen(){store.close();store=new LocalArtifacts(options);},
  close(){store.close();rmSync(root,{recursive:true,force:true});}};
}

test('local artifact: immutable scoped image survives actual SQLite reopen',()=>{
 const x=fixture();try{
  const a=x.store.put('p','o',x.input,PNG);
  assert.equal(a.provenance,'operator-upload');assert.equal(a.sha256,digest(PNG));
  assert.equal(x.store.put('p','o',x.input,PNG).id,a.id);
  assert.throws(()=>x.store.put('p','o',{...x.input,label:'Changed intent'},PNG),/identity reused/);
  assert.throws(()=>x.store.read('other','o',a.id),/scope/);
  assert.throws(()=>x.store.read('p','other',a.id),/scope/);
  x.reopen();assert.equal(x.store.read('p','o',a.id).dataUrl,'data:image/png;base64,'+PNG.toString('base64'));
 }finally{x.close();}
});
test('local artifact: age preview predicts reclaimed bytes and pinned or active images survive',()=>{
 const x=fixture();try{
  const a=x.store.put('p','o',x.input,PNG),future=Date.now()+2*86400000;
  x.store.pin('p','o',a.id,true);assert.deepEqual(x.store.preview('p','o',0,future).ids,[]);
  x.store.pin('p','o',a.id,false);x.protect(true);assert.equal(x.store.collect('p','o',0,future).removed,0);
  x.protect(false);const preview=x.store.preview('p','o',0,future);
  assert.deepEqual(preview.ids,[a.id]);assert.equal(preview.bytes,a.storedBytes);
  assert.deepEqual(x.store.collect('p','o',0,future),{removed:1,bytes:preview.bytes});
  x.reopen();assert.equal(x.store.list('p','o','wf')[0].state,'removed');
  assert.equal(x.store.put('p','o',x.input,PNG).state,'removed','An old request cannot recreate expired content');
  assert.throws(()=>x.store.read('p','o',a.id),/unavailable/i);
 }finally{x.close();}
});
test('local artifact: full quota does not evict pinned content',()=>{
 const x=fixture(1024);try{
  const bytes=Buffer.concat([PNG,Buffer.alloc(600)]);
  const a=x.store.put('p','o',x.input,bytes);x.store.pin('p','o',a.id,true);
  assert.throws(()=>x.store.put('p','o',{...x.input,key:'second'},bytes),/quota full/);
  assert.equal(x.store.read('p','o',a.id).artifact.state,'ready');
 }finally{x.close();}
});
test('local artifact: corrupt, growing, and aliased files are refused without deleting the target',()=>{
 for(const scenario of ['changed','grown','alias']){
  const x=fixture();try{
   const a=x.store.put('p','o',x.input,PNG),path=join(x.root,'objects',a.id+'.blob');
   const unrelated=join(x.root,'unrelated.fixture');writeFileSync(unrelated,'Keep this fixture');
   if(scenario==='changed'){const b=Buffer.from(PNG);b[32]^=1;writeFileSync(path,b);}
   if(scenario==='grown')writeFileSync(path,Buffer.concat([PNG,Buffer.from('extra')]));
   if(scenario==='alias'){unlinkSync(path);symlinkSync(unrelated,path);}
   assert.throws(()=>x.store.read('p','o',a.id));
   assert.throws(()=>x.store.collect('p','o',0,Date.now()+2*86400000));
   assert.equal(readFileSync(unrelated,'utf8'),'Keep this fixture');
  }finally{x.close();}
 }
});
test('local artifact: interrupted write or retirement is never retried after reopen',()=>{
 for(const state of ['writing','retiring','uncertain']){
  const x=fixture();try{
   const a=x.store.put('p','o',x.input,PNG);
   const db=new DatabaseSync(join(x.root,'index.sqlite'));
   db.prepare('UPDATE artifacts SET state=? WHERE id=?').run(state,a.id);db.close();
   x.reopen();assert.throws(()=>x.store.put('p','o',x.input,PNG),/uncertain/);
   assert.throws(()=>x.store.read('p','o',a.id),/unavailable/i);
   assert.equal(x.store.collect('p','o',0,Date.now()+2*86400000).removed,0);
   assert.equal(x.store.usage().unresolved,1);
  }finally{x.close();}
 }
});
test('local artifact: Zstandard public log round-trips with an independent raw bound',()=>{
 const x=fixture();try{
  const input={...x.input,kind:'run-log',mime:'application/x-ndjson'},raw=Buffer.from('{"summary":"bounded public result"}\n');
  const a=x.store.put('p','o',input,raw);x.reopen();assert.equal(x.store.read('p','o',a.id).text,raw.toString());
  assert.throws(()=>x.store.put('p','o',{...input,key:'oversize'},Buffer.alloc(128*1024+1)),/bound/);
  // Tamper only this synthetic archive and its fixture metadata. Exercise the
  // decoder's own output limit even when stored length/hash agree with input.
  const bomb=Buffer.alloc(128*1024+1,65),packed=zstdCompressSync(bomb);
  writeFileSync(join(x.root,'objects',a.id+'.blob'),packed,{mode:0o600});
  const db=new DatabaseSync(join(x.root,'index.sqlite'));
  db.prepare('UPDATE artifacts SET storedBytes=?,storedHash=?,bytes=?,sha256=? WHERE id=?')
   .run(packed.length,digest(packed),bomb.length,digest(bomb),a.id);db.close();
  assert.throws(()=>x.store.read('p','o',a.id),/buffer|length|large|size|limit/i);
 }finally{x.close();}
});
test('local artifact: oversized JPEG frame dimensions are rejected before browser decoding',()=>{
 // Tiny, non-decoded frame metadata: no large image allocation or execution.
 const jpeg=Buffer.from([255,216,255,192,0,11,8,255,255,255,255,1,1,17,0,255,217]);
 assert.throws(()=>localImageMime(jpeg),/dimension|JPEG|image|frame|unsupported/i);
});
test('local artifact: a JPEG signature without a supported frame is not a valid image',()=>{
 const jpeg=Buffer.from([255,216,1,2,3,4,5,6,7,8,9,10,11,12,255,217]);
 assert.throws(()=>localImageMime(jpeg),/JPEG|image|frame|unsupported/i);
});
test('local artifact: a stopped lifetime denies new writes and pin changes',()=>{
 const x=fixture();try{
  const a=x.store.put('p','o',x.input,PNG);x.abort.abort(new Error('Synthetic stopped owner'));
  assert.throws(()=>x.store.put('p','o',{...x.input,key:'later'},PNG),/stopped/);
  assert.throws(()=>x.store.pin('p','o',a.id,true),/stopped/);
 }finally{x.close();}
});

test('local artifact: Zstandard window budget rejects a tiny-output frame declaring a large window',()=>{
 const x=fixture();try{
  const input={...x.input,kind:'run-log',mime:'application/x-ndjson'},raw=Buffer.from('A');
  const a=x.store.put('p','o',input,raw);
  // A one-byte raw block with a 1 MiB declared window, not a large allocation.
  const packed=Buffer.from('28b52ffd005009000041','hex');
  writeFileSync(join(x.root,'objects',a.id+'.blob'),packed,{mode:0o600});
  const db=new DatabaseSync(join(x.root,'index.sqlite'));
  db.prepare('UPDATE artifacts SET storedBytes=?,storedHash=? WHERE id=?').run(packed.length,digest(packed),a.id);db.close();
  assert.throws(()=>x.store.read('p','o',a.id),/decoding resource limit/);
 }finally{x.close();}
});
test('local artifact: image size leaves JSON transport headroom and rejects animated or malformed headers',()=>{
 assert.throws(()=>localImageMime(Buffer.concat([PNG,Buffer.alloc(180*1024)])),/180 KiB|limit/);
 for(const change of [b=>b.writeUInt32BE(4097,16),b=>b[25]=7,b=>b[28]=2,b=>b.writeUInt32BE(12,8)]){
  const b=Buffer.from(PNG);change(b);assert.throws(()=>localImageMime(b),/dimension|PNG/);
 }
 const chunk=Buffer.alloc(12);chunk.write('acTL',4,'ascii');
 assert.throws(()=>localImageMime(Buffer.concat([PNG.subarray(0,33),chunk,PNG.subarray(33)])),/animated/);
});
test('local artifact: pin lookup is not truncated by the Journal display limit',()=>{
 const x=fixture();try{
  const first=x.store.put('p','o',x.input,PNG);x.store.pin('p','o',first.id,true);
  for(let i=0;i<105;i++)x.store.put('p','o',{...x.input,key:'page-'+i},PNG);
  assert.equal(x.store.hasPins('p','o','wf'),true);assert.equal(x.store.hasPins('other','o','wf'),false);
 }finally{x.close();}
});
