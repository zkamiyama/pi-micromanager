import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,chmodSync,existsSync,appendFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {snapshotState,verifySnapshot} from '../dist/security/offline-backup.js';
import {acquireStateOwner} from '../dist/security/state-owner.js';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'mm-offline-test-')),state=join(root,'state'),target=join(root,'snapshot');mkdirSync(state,{mode:0o700});
 const file=join(state,'sample.sqlite'),db=new DatabaseSync(file);chmodSync(file,0o600);
 db.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO evidence(body) VALUES('committed-wal-evidence')");
 writeFileSync(join(state,'artifact.txt'),'immutable artifact',{mode:0o600});
 return {root,state,target,db,close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
test('#75 snapshot: actual SQLite WAL data and artifact digests round-trip without changing source',async()=>{
 const x=fixture();try{
  const receipt=await snapshotState(x.state,x.target,'Synthetic offline verification');
  assert.equal(receipt.manifest.files.length,2);
  const verified=verifySnapshot(x.target,receipt.digest);
  assert.equal(verified.files.some(f=>f.path.endsWith('-wal')),false);
  const copy=new DatabaseSync(join(x.target,'payload/sample.sqlite'),{readOnly:true});
  try{assert.equal(copy.prepare('SELECT body FROM evidence').get().body,'committed-wal-evidence');}finally{copy.close();}
  assert.equal(x.db.prepare('SELECT count(*) AS n FROM evidence').get().n,1);
  assert.match(verified.external.requirements.join('\n'),/provider submissions/);
  assert.equal(readFileSync(join(x.target,'payload/artifact.txt'),'utf8'),'immutable artifact');
 }finally{x.close();}
});
test('#75 snapshot: active ownership and existing destinations are refused, never overwritten',async()=>{
 const x=fixture();let owner;
 try{
  owner=await acquireStateOwner(x.state);
  await assert.rejects(snapshotState(x.state,x.target,'Reject competing owner'),/owner|locking/);
  assert.equal(existsSync(x.target),false);await owner.release();
  mkdirSync(x.target);writeFileSync(join(x.target,'keep'),'keep');
  await assert.rejects(snapshotState(x.state,x.target,'Reject overwrite'),/EEXIST/);
  assert.equal(readFileSync(join(x.target,'keep'),'utf8'),'keep');
 }finally{await owner?.release();x.close();}
});
test('#75 verification: altered bytes, manifest and unmanifested files fail independently',async()=>{
 const x=fixture();try{
  const receipt=await snapshotState(x.state,x.target,'Tamper detection fixture');
  const artifact=join(x.target,'payload/artifact.txt');appendFileSync(artifact,'tampered');
  assert.throws(()=>verifySnapshot(x.target,receipt.digest),/file digest mismatch/);
  writeFileSync(artifact,'immutable artifact');writeFileSync(join(x.target,'payload/extra'),'extra');
  assert.throws(()=>verifySnapshot(x.target,receipt.digest),/inventory mismatch/);rmSync(join(x.target,'payload/extra'));
  appendFileSync(join(x.target,'MANIFEST.json'),' ');
  assert.throws(()=>verifySnapshot(x.target,receipt.digest),/manifest digest mismatch/);
 }finally{x.close();}
});
test('#75 verification: malicious path or symlink cannot redirect reads outside the snapshot',async()=>{
 const x=fixture();try{
  const receipt=await snapshotState(x.state,x.target,'Path validation fixture');
  const raw=JSON.parse(readFileSync(join(x.target,'MANIFEST.json'),'utf8'));raw.files[0].path='../outside';
  const content=JSON.stringify(raw);writeFileSync(join(x.target,'MANIFEST.json'),content);
  assert.throws(()=>verifySnapshot(x.target,createHash('sha256').update(content).digest('hex')),/file entry/);
  const original=JSON.stringify(receipt.manifest,null,2)+'\n';writeFileSync(join(x.target,'MANIFEST.json'),original);
  rmSync(join(x.target,'payload/artifact.txt'));symlinkSync(join(x.state,'artifact.txt'),join(x.target,'payload/artifact.txt'));
  assert.throws(()=>verifySnapshot(x.target,receipt.digest),/symlink/);
 }finally{x.close();}
});
test('#75 snapshot: linked Worktrees remain explicit external dependencies, never copied as control state',async()=>{
 const x=fixture();try{
  const work=join(x.state,'managed-worktrees','a'.repeat(16),'workflow','task');mkdirSync(work,{recursive:true});writeFileSync(join(work,'code'),'not part of plugin snapshot');
  const receipt=await snapshotState(x.state,x.target,'External dependency fixture');
  assert.equal(existsSync(join(x.target,'payload/managed-worktrees')),false);
  assert.equal(receipt.manifest.external.managedWorktrees,join(x.state,'managed-worktrees'));
  assert.equal(verifySnapshot(x.target,receipt.digest).files.length,2);
 }finally{x.close();}
});

test('#75 snapshot: a mistyped source path is not created as an empty successful backup',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-missing-source-'));
 try{
  const missing=join(root,'missing');await assert.rejects(snapshotState(missing,join(root,'snapshot'),'Missing fixture'),/ENOENT/);
  assert.equal(existsSync(missing),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
