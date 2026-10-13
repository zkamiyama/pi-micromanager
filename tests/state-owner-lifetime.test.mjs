import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {acquireStateOwner} from '../dist/security/state-owner.js';

test('#75 owner descriptor survives launcher exit and releases when its synthetic daemon exits', {timeout:8000}, async()=>{
 const root=mkdtempSync(join(tmpdir(),'mm-owner-exit-'));
 const moduleUrl=new URL('../dist/security/state-owner.js',import.meta.url).href;
 const script=`import {acquireStateOwner} from ${JSON.stringify(moduleUrl)};await acquireStateOwner(process.argv[1]);process.stdout.write('owned\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,root],{stdio:['ignore','pipe','ignore']});
 let acquired;
 try{
  const ready=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Synthetic owner exited before handshake');})]);
  assert.equal(String(ready[0]),'owned\n');
  await assert.rejects(acquireStateOwner(root),/owner|locking/);
  const exited=once(child,'exit');child.kill('SIGTERM');await exited;
  acquired=await acquireStateOwner(root);acquired.assertHeld();
  assert.equal(acquired.lost.aborted,false);
 }finally{
  if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  await acquired?.release();rmSync(root,{recursive:true,force:true});
 }
});
