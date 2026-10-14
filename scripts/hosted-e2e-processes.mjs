/** Linux test-process identity bookkeeping. Unknown inspection is not exit.
 * Never signal a reused/unproved PID or treat a D-state descendant as joined. */
import {readFileSync,readdirSync} from 'node:fs';
const missing=error=>error?.code==='ENOENT'||error?.code==='ESRCH';
const unproved=()=>{throw new Error('process-inspection-unproved');};
export function processIdentity(pid,read=readFileSync){
 if(!Number.isSafeInteger(pid)||pid<=0)unproved();
 try{
  const raw=read('/proc/'+pid+'/stat','utf8'),end=raw.lastIndexOf(')');
  const parts=raw.slice(end+2).trim().split(/\s+/);
  if(end<2||!/^\d+$/.test(parts[19]??'')||! /^[A-Za-z]$/.test(parts[0]??''))unproved();
  return {pid,start:parts[19],state:parts[0]};
 }catch(error){if(missing(error))return undefined;return unproved();}
}
export function descendants(root,system={identity:processIdentity,
 tasks:pid=>readdirSync('/proc/'+pid+'/task'),
 children:(pid,tid)=>readFileSync('/proc/'+pid+'/task/'+tid+'/children','utf8')}){
 const found=new Map(),queue=[root];
 while(queue.length){
  if(found.size>=2048)unproved();
  const pid=queue.pop(),identity=system.identity(pid);if(!identity||found.has(pid))continue;
  found.set(pid,identity);
  try{for(const tid of system.tasks(pid)){
   try{for(const child of system.children(pid,tid).trim().split(/\s+/)){
    if(!child)continue;
    if(!/^\d+$/.test(child)||!Number.isSafeInteger(Number(child))||Number(child)<=0)unproved();
    if(queue.length>=4096)unproved();
    queue.push(Number(child));
   }}catch(error){if(!missing(error))unproved();}
  }}catch(error){if(!missing(error))unproved();}
 }
 found.delete(root);return found;
}
export function isStillRunning(record,read=processIdentity){
 try{
  const actual=read(record.pid);
  return Boolean(actual&&actual.start===record.start&&!['Z','X'].includes(actual.state));
 }catch{return true;}// Permission/parse/transient errors cannot certify exit.
}
export function signalRecorded(records,signal,read=processIdentity,kill=(pid,sig)=>process.kill(pid,sig)){
 for(const record of records){
  try{
   const actual=read(record.pid);
   if(actual&&actual.start===record.start&&!['Z','X'].includes(actual.state))kill(record.pid,signal);
  }catch{/* Unknown identity is retained as unjoined, never signalled speculatively. */}
 }
}
