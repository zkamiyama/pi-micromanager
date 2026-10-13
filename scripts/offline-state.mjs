#!/usr/bin/env node
/** Offline snapshot/verification only. No restore, unquarantine or daemon controls. */
import {snapshotState,verifySnapshot} from '../dist/security/offline-backup.js';
const usage='Usage:\n  node scripts/offline-state.mjs snapshot --source /state --destination /new-snapshot --reason "offline maintenance" --offline-confirmed\n  node scripts/offline-state.mjs verify --source /snapshot --digest <trusted-manifest-sha256>\n';
async function main(){
 const args=process.argv.slice(2),operation=args.shift();
 if(operation==='--help'||operation===undefined){console.log(usage);return;}
 if(operation!=='snapshot'&&operation!=='verify')throw Error('Only snapshot and verify are supported; no restore/unquarantine command exists');
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
 if(values.size!==4||values.get('--offline-confirmed')!==true||
   typeof values.get('--destination')!=='string'||typeof values.get('--reason')!=='string')
  throw Error('Stop every state writer first; snapshot needs source, new destination, reason and offline-confirmed');
 const result=await snapshotState(source,values.get('--destination'),values.get('--reason'));
 console.log(JSON.stringify({root:result.root,manifestDigest:result.digest,files:result.manifest.files.length,
  scope:'plugin-state snapshot only',restoreImplemented:false,externalResumeAuthorized:false},null,2));
}
main().catch(error=>{console.error(String(error));process.exitCode=1;});
