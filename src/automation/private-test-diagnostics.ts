/** Host-owned disclosure policy and optional, finite PRIVATE raw failure storage.
 * No raw object has a model/browser read API. Disabled unless the operator opts
 * in, understanding that test output can contain sensitive material. */
import {createHash} from "node:crypto";
import {mkdirSync,lstatSync,realpathSync,opendirSync,openSync,writeFileSync,closeSync,constants} from "node:fs";
import {join,resolve} from "node:path";
export interface TestDiagnosticPolicy {
  labels:Readonly<Record<string,string>>;compilerCodes:boolean;
  retainPrivateRaw:boolean;maxRawBytes:number;maxRawArtifacts:number;
}
export const DEFAULT_TEST_DIAGNOSTICS:Readonly<TestDiagnosticPolicy>=Object.freeze({
  labels:Object.freeze({}),compilerCodes:true,retainPrivateRaw:false,maxRawBytes:32768,maxRawArtifacts:32,
});
export function parseTestDiagnosticPolicy(value:unknown):TestDiagnosticPolicy{
  if(value===undefined)return {...DEFAULT_TEST_DIAGNOSTICS,labels:{}};
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid test diagnostic policy");
  const raw=value as Record<string,unknown>;
  if(Object.keys(raw).some(key=>!Object.hasOwn(DEFAULT_TEST_DIAGNOSTICS,key)))throw new Error("Unknown diagnostic policy field");
  const policy={...DEFAULT_TEST_DIAGNOSTICS,...raw} as TestDiagnosticPolicy;
  if(!policy.labels||typeof policy.labels!=="object"||Array.isArray(policy.labels)||Object.keys(policy.labels).length>100||
    Object.entries(policy.labels).some(([name,label])=>!name||name.length>180||/[\r\n\0]/.test(name)||
      typeof label!=="string"||!/^[a-zA-Z][a-zA-Z0-9 _.,():-]{0,79}$/.test(label))||
    typeof policy.compilerCodes!=="boolean"||typeof policy.retainPrivateRaw!=="boolean"||
    !Number.isSafeInteger(policy.maxRawBytes)||policy.maxRawBytes<1024||policy.maxRawBytes>65536||
    !Number.isSafeInteger(policy.maxRawArtifacts)||policy.maxRawArtifacts<1||policy.maxRawArtifacts>128)
    throw new Error("Invalid bounded diagnostic policy");
  return {...policy,labels:Object.fromEntries(Object.entries(policy.labels))};
}
export interface PrivateDiagnosticReceipt {
  state:"disabled"|"retained"|"already-present"|"budget-full"|"unavailable";
  ref?:string;rawBytes?:number;truncated?:boolean;
}
/** This writes ONLY fresh immutable files, never deletes, overwrites, or follows
 * an alias. A full budget suppresses new raw capture instead of erasing evidence.
 * Retention is explicit: bounded keep-until-manually-reviewed; no automatic GC. */
export function capturePrivateFailure(root:string,identity:readonly string[],stdout:string,stderr:string,
  policy:TestDiagnosticPolicy):PrivateDiagnosticReceipt{
  if(!policy.retainPrivateRaw)return {state:"disabled"};
  try{
    const parent=lstatSync(root);
    if(!parent.isDirectory()||realpathSync(root)!==resolve(root)||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0)
      return {state:"unavailable"};
    const path=join(root,"private-test-failures");
    mkdirSync(path,{recursive:true,mode:0o700});
    const stat=lstatSync(path);
    if(!stat.isDirectory()||realpathSync(path)!==path||stat.uid!==parent.uid||(stat.mode&0o077)!==0)
      return {state:"unavailable"};
    const separator="\n--- stderr ---\n";
    const full=Buffer.concat([Buffer.from(stdout.slice(0,policy.maxRawBytes)),Buffer.from(separator),
      Buffer.from(stderr.slice(0,policy.maxRawBytes))]);
    const bytes=full.subarray(0,policy.maxRawBytes),truncated=Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+separator.length>bytes.length;
    const ref=createHash("sha256").update(JSON.stringify(identity)).update(stdout).update(separator).update(stderr).digest("hex");
    const directory=opendirSync(path);let count=0,existing=false;
    try{let entry;while((entry=directory.readSync())!==null){
      if(!/^[a-f0-9]{64}\.log$/.test(entry.name)||!entry.isFile())return {state:"unavailable"};
      const file=lstatSync(join(path,entry.name));
      if(!file.isFile()||file.nlink!==1||file.uid!==parent.uid||(file.mode&0o077)!==0)return {state:"unavailable"};
      if(entry.name===ref+".log")existing=true;
      if(++count>policy.maxRawArtifacts)return {state:"budget-full"};
    }}finally{directory.closeSync();}
    // Existing data is retained but is not silently asserted byte-verified.
    if(existing)return {state:"already-present",ref};
    if(count>=policy.maxRawArtifacts)return {state:"budget-full"};
    const fd=openSync(join(path,ref+".log"),constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_WRONLY,0o600);
    try{writeFileSync(fd,bytes);}finally{closeSync(fd);}
    return {state:"retained",ref,rawBytes:bytes.length,truncated};
  }catch{return {state:"unavailable"};}
}
