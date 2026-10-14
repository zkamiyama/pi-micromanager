/** Bounded metadata-only admission for plugin-owned state. Not an OS disk quota.
 * Never follows links, removes data or reads credential/session contents. */
import {lstatSync,realpathSync,opendirSync,statfsSync} from "node:fs";
import {join,resolve,relative,sep} from "node:path";
export interface StorageLimits {
  maxStateBytes:number;warningStateBytes:number;minAvailableBytes:number;
  warningAvailableBytes:number;maxEntries:number;maxScanMs:number;
}
export const DEFAULT_STORAGE_LIMITS:Readonly<StorageLimits>=Object.freeze({
  maxStateBytes:8*1024**3,warningStateBytes:6*1024**3,
  minAvailableBytes:256*1024**2,warningAvailableBytes:512*1024**2,
  maxEntries:100000,maxScanMs:2000,
});
export type StorageReason="within-bounds"|"warning-threshold"|"state-limit"|"available-limit"|
  "unsafe-entry"|"scan-limit"|"changed-during-scan"|"unavailable";
export interface StorageStatus {
  status:"ok"|"warning"|"blocked";reason:StorageReason;observedAt:number;
  stateBytes:number;managedBytes:number;entries:number;availableBytes:number|null;
  complete:boolean;hardQuotaVerified:false;limits:StorageLimits;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
export function parseStorageLimits(value:unknown):StorageLimits{
  if(value!==undefined&&(!object(value)||Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_STORAGE_LIMITS,k))))
    throw new Error("Unknown host storage admission field");
  const limits={...DEFAULT_STORAGE_LIMITS,...(value as Partial<StorageLimits>|undefined)};
  for(const key of ["maxStateBytes","warningStateBytes","minAvailableBytes","warningAvailableBytes"] as const){
    if(!Number.isSafeInteger(limits[key])||limits[key]<1024*1024||limits[key]>1024**5)
      throw new Error("Invalid host storage byte limit");
  }
  if(limits.warningStateBytes>=limits.maxStateBytes||limits.warningAvailableBytes<=limits.minAvailableBytes||
    !Number.isSafeInteger(limits.maxEntries)||limits.maxEntries<100||limits.maxEntries>250000||
    !Number.isSafeInteger(limits.maxScanMs)||limits.maxScanMs<10||limits.maxScanMs>5000)
    throw new Error("Invalid host storage warning/scan limits");
  return limits;
}
/** Optional system adapter is used only by deterministic fault tests. The server
 * always calls with native metadata/statfs; Workflow input cannot replace it. */
export function inspectStorage(root:string,limits:StorageLimits,
  system:{available:(root:string)=>number;now:()=>number}={
    available:path=>{const s=statfsSync(path,{bigint:true});
      const n=s.bavail*s.bsize;if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("Unproved filesystem capacity");return Number(n);},
    now:()=>Date.now(),
  }):StorageStatus{
  const result:StorageStatus={status:"blocked",reason:"unavailable",observedAt:Date.now(),
    stateBytes:0,managedBytes:0,entries:0,availableBytes:null,complete:false,hardQuotaVerified:false,limits:{...limits}};
  const fail=(reason:StorageReason)=>{result.reason=reason;return result;};
  const start=system.now();
  try{
    const initial=lstatSync(root);
    if(resolve(root)!==root||root===sep||realpathSync(root)!==root||!initial.isDirectory()||
      initial.isSymbolicLink()||initial.uid!==process.getuid?.()||(initial.mode&0o077)!==0)
      return fail("unsafe-entry");
    const pending=[{path:root,managed:false,ino:initial.ino,dev:initial.dev}];
    while(pending.length){
      const item=pending.pop()!;
      if(system.now()-start>limits.maxScanMs)return fail("scan-limit");
      const before=lstatSync(item.path);
      if(!before.isDirectory()||before.ino!==item.ino||before.dev!==item.dev||realpathSync(item.path)!==item.path)
        return fail("changed-during-scan");
      const dir=opendirSync(item.path);
      try{let entry;
        while((entry=dir.readSync())!==null){
          if(++result.entries>limits.maxEntries||system.now()-start>limits.maxScanMs)return fail("scan-limit");
          const path=join(item.path,entry.name),s=lstatSync(path);
          const managed=item.managed||item.path===root&&entry.name==="managed-worktrees";
          if(s.isSymbolicLink()){
            // Installed dependencies may contain internal .bin aliases. Count
            // link metadata but never traverse it; only an exact managed leaf
            // may refer back inside that same leaf. Control aliases are refused.
            const parts=relative(root,path).split(sep),leaf=join(root,...parts.slice(0,4));
            if(parts[0]!=="managed-worktrees"||parts.length<5||!/^[a-f0-9]{16}$/.test(parts[1]??""))
              return fail("unsafe-entry");
            const target=realpathSync(path);
            if(target!==leaf&&!target.startsWith(leaf+sep))return fail("unsafe-entry");
            result.stateBytes+=s.size;result.managedBytes+=s.size;continue;
          }
          if(s.uid!==initial.uid||s.dev!==initial.dev||!s.isDirectory()&&!s.isFile()||
            s.isFile()&&s.nlink!==1)return fail("unsafe-entry");
          if(s.isDirectory())pending.push({path,managed,ino:s.ino,dev:s.dev});
          else{
            if(!Number.isSafeInteger(s.size)||s.size<0)return fail("unavailable");
            result.stateBytes+=s.size;if(managed)result.managedBytes+=s.size;
            if(!Number.isSafeInteger(result.stateBytes))return fail("unavailable");
          }
        }
      }finally{dir.closeSync();}
      const after=lstatSync(item.path);
      if(after.ino!==before.ino||after.dev!==before.dev||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)
        return fail("changed-during-scan");
    }
    const final=lstatSync(root);
    if(final.ino!==initial.ino||final.dev!==initial.dev||realpathSync(root)!==root)return fail("changed-during-scan");
    result.availableBytes=system.available(root);
    if(!Number.isSafeInteger(result.availableBytes)||result.availableBytes<0)return fail("unavailable");
    result.complete=true;
    if(result.stateBytes>=limits.maxStateBytes)return fail("state-limit");
    if(result.availableBytes<=limits.minAvailableBytes)return fail("available-limit");
    const warning=result.stateBytes>=limits.warningStateBytes||result.availableBytes<=limits.warningAvailableBytes;
    result.status=warning?"warning":"ok";result.reason=warning?"warning-threshold":"within-bounds";
    return result;
  }catch{return fail("unavailable");}
}
export function assertStorageAdmission(root:string,limits:StorageLimits):StorageStatus{
  const status=inspectStorage(root,limits);
  if(status.status==="blocked")throw new Error("Storage admission blocked: "+status.reason+
    "; inspect security.capacity. Existing Runs/evidence were not removed.");
  return status;
}
