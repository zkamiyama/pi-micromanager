import assert from 'node:assert/strict';
/** Observe one admitted operation; never resubmit a timed-out mutation. */
export async function waitMaintenance(x,receipt,timeout=20000){
 const end=Date.now()+timeout;
 while(receipt.phase==='running'&&Date.now()<end){
  await new Promise(r=>setTimeout(r,25));
  receipt=await x.peer('auto.maintenance.status',{operationId:receipt.id});
 }
 assert.notEqual(receipt.phase,'running','A finite maintenance operation must settle');
 return receipt;
}
export async function retire(x,preview){
 return waitMaintenance(x,await x.peer('auto.worktree.retire.confirm',{previewId:preview.id}));
}
