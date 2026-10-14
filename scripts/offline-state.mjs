#!/usr/bin/env node
/** Offline snapshot, verification and fresh-root quarantine restore. No daemon or unlock controls. */
import {snapshotState,verifySnapshot,restoreSnapshotToFreshRoot} from '../dist/security/offline-backup.js';
const usage='Usage:\n  node scripts/offline-state.mjs snapshot --source /state --destination /new-snapshot --reason "offline maintenance" --offline-confirmed\n  node scripts/offline-state.mjs verify --source /snapshot --digest <trusted-manifest-sha256>\n  node scripts/offline-state.mjs restore --source /snapshot --destination /new-empty-state --digest <trusted-manifest-sha256> --reason "quarantined drill" --offline-confirmed\n';
async function main(){
 const args=process.argv.slice(2),operation=args.shift();
 if(operation==='--help'||operation===undefined){console.log(usage);return;}
 if(!['snapshot','verify','restore'].includes(operation))throw Error('Unknown operation; no unquarantine command exists');
 const values=new Map();
 while(args.length){
  const key=args.shift();if(values.has(key))throw Error('Duplicate option');
  if(key==='--offline-confirmed'){values.set(key,true);continue;}
  if(!['--source','--destination','--reason','--digest'].includes(key)||!args.length)throw Error('Unknown or incomplete option');
  const value=args.shift();if(value.startsWith('--'))throw Error('Option value required');values.set(key,value);
 }
 const source=values.get('--source');if(typeof source!=='string')throw Error('Source required');
 if(operation==='verify'){
  if(values.size!==2||typeof values.get('--digest')!=='string')throw Error('Verify requires only source and trusted digest');
  const manifest=verifySnapshot(source,values.get('--digest'));
  console.log(JSON.stringify({verified:true,files:manifest.files.length,scope:'plugin-state snapshot only',externalDependencies:manifest.external.requirements}));return;
 }
 if(operation==='restore'){
  if(values.size!==5||values.get('--offline-confirmed')!==true||
    typeof values.get('--destination')!=='string'||typeof values.get('--digest')!=='string'||
    typeof values.get('--reason')!=='string')
    throw Error('Restore requires snapshot source, fresh destination, trusted digest, reason and offline-confirmed');
  const result=await restoreSnapshotToFreshRoot(source,values.get('--digest'),
    values.get('--destination'),values.get('--reason'));
  console.log(JSON.stringify({restored:true,quarantined:true,root:result.root,files:result.files,
    externalResumeAuthorized:false,externalDependencies:result.externalDependencies},null,2));return;
 }
 if(values.size!==4||values.get('--offline-confirmed')!==true||
   typeof values.get('--destination')!=='string'||typeof values.get('--reason')!=='string')
  throw Error('Stop every state writer first; snapshot needs source, new destination, reason and offline-confirmed');
 const result=await snapshotState(source,values.get('--destination'),values.get('--reason'));
 console.log(JSON.stringify({root:result.root,manifestDigest:result.digest,files:result.manifest.files.length,
  scope:'plugin-state snapshot only',restoreImplemented:true,externalResumeAuthorized:false},null,2));
}
main().catch(error=>{console.error(String(error));process.exitCode=1;});
