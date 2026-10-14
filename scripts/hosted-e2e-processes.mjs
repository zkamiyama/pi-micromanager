/** Linux test-process identity bookkeeping. A killed parent does not prove that
 * its detached/sandbox descendants exited. Never kill a PID reused by another
 * process; never count a kernel D-state descendant as joined. */
import {readFileSync,readdirSync} from 'node:fs';
export function processIdentity(pid){
 try{
  const raw=readFileSync('/proc/'+pid+'/stat','utf8'),parts=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
  return {pid,start:parts[19],state:parts[0]};
 }catch{return undefined;}
}
export function descendants(root){
 const found=new Map(),queue=[root];
 while(queue.length&&found.size<2048){
  const pid=queue.pop(),identity=processIdentity(pid);if(!identity||found.has(pid))continue;
  found.set(pid,identity);
  try{for(const tid of readdirSync('/proc/'+pid+'/task')){
   try{for(const child of readFileSync('/proc/'+pid+'/task/'+tid+'/children','utf8').trim().split(/\s+/))
    if(/^\d+$/.test(child))queue.push(Number(child));}catch{}
  }}catch{}
 }
 found.delete(root);return found;
}
export function isStillRunning(record,read=processIdentity){
 const actual=read(record.pid);return Boolean(actual&&actual.start===record.start&&!['Z','X'].includes(actual.state));
}
export function signalRecorded(records,signal,read=processIdentity,kill=(pid,sig)=>process.kill(pid,sig)){
 for(const record of records){if(isStillRunning(record,read))try{kill(record.pid,signal);}catch{}}
}
