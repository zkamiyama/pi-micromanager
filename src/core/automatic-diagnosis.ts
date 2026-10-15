/** ADR-0019: deterministic, opt-in and finite diagnostic episode contracts.
 * No Pi, host, clock or I/O dependency: callers supply verified QC and time. */
import {createHash} from "node:crypto";
export interface DiagnosticModel {provider:string;model:string;effort?:string}
export interface AutomaticDiagnosisPolicy {
  afterFailures:number;maxModelRequests:number;maxToolCalls:number;
  maxDurationMs:number;maxOutputTokens:number;
}
export interface AutomaticDiagnosisDirective {
  policy:AutomaticDiagnosisPolicy;
  profiles:{architect:DiagnosticModel;reviewer:DiagnosticModel;synthesis:DiagnosticModel};
  fingerprint:string;
}
export interface DiagnosticRunBudget {
  episodeId:string;maxModelRequests:number;maxToolCalls:number;
  deadline:number;maxOutputTokens:number;
}
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);
function bounded(x:unknown,min:number,max:number,name:string):number{
  if(typeof x!=="number"||!Number.isSafeInteger(x)||x<min||x>max)
    throw new Error("Invalid automatic diagnosis "+name);
  return x;
}
export function parseAutomaticDiagnosisPolicy(value:unknown):AutomaticDiagnosisPolicy|undefined{
  if(value===undefined)return;
  if(!object(value)||Object.keys(value).some(k=>!["afterFailures","maxModelRequests","maxToolCalls","maxDurationMs","maxOutputTokens"].includes(k)))
    throw new Error("Explicit bounded automatic diagnosis policy required");
  return {afterFailures:bounded(value.afterFailures,1,5,"failure threshold"),
    maxModelRequests:bounded(value.maxModelRequests,3,120,"request budget"),
    maxToolCalls:bounded(value.maxToolCalls,3,300,"tool budget"),
    maxDurationMs:bounded(value.maxDurationMs,3000,900000,"deadline"),
    maxOutputTokens:bounded(value.maxOutputTokens,256,8192,"output budget")};
}
function model(x:unknown):DiagnosticModel{
  if(!object(x)||Object.keys(x).some(k=>!["provider","model","effort"].includes(k))||
    typeof x.provider!=="string"||!x.provider.trim()||typeof x.model!=="string"||!x.model.trim()||
    (x.provider+"/"+x.model).length>160||/[\x00-\x1f]/.test(x.provider+x.model)||
    x.effort!==undefined&&(typeof x.effort!=="string"||!['off','minimal','low','medium','high','xhigh','max'].includes(x.effort)))
    throw new Error("Invalid automatic diagnosis model profile");
  return {provider:x.provider,model:x.model,...(x.effort===undefined?{}:{effort:String(x.effort)})};
}
export function automaticDiagnosisDirective(policy:AutomaticDiagnosisPolicy,
  profiles:AutomaticDiagnosisDirective['profiles']):AutomaticDiagnosisDirective{
  const parsed=parseAutomaticDiagnosisPolicy(policy)!;
  const exact={architect:model(profiles.architect),reviewer:model(profiles.reviewer),synthesis:model(profiles.synthesis)};
  return {policy:parsed,profiles:exact,
    fingerprint:createHash('sha256').update(JSON.stringify([parsed,exact])).digest('hex')};
}
export function validateAutomaticDirective(value:AutomaticDiagnosisDirective):AutomaticDiagnosisDirective{
  if(!object(value)||!object(value.profiles))throw new Error("Missing automatic diagnosis directive");
  const parsed=automaticDiagnosisDirective(value.policy,value.profiles);
  if(parsed.fingerprint!==value.fingerprint)throw new Error("Automatic diagnosis directive changed");
  return parsed;
}
export function automaticEpisodeId(taskId:string):string{
  return 'auto-diag-'+createHash('sha256').update(taskId).digest('hex').slice(0,32);
}
/** Three disjoint immutable shares: unused capacity is never reassigned. */
export function diagnosticBudget(episodeId:string,policy:AutomaticDiagnosisPolicy,deadline:number):DiagnosticRunBudget{
  if(!/^auto-diag-[a-f0-9]{32}$/.test(episodeId)||!Number.isSafeInteger(deadline)||deadline<0)
    throw new Error("Invalid diagnostic episode identity/time");
  const p=parseAutomaticDiagnosisPolicy(policy)!;
  return {episodeId,maxModelRequests:Math.floor(p.maxModelRequests/3),
    maxToolCalls:Math.floor(p.maxToolCalls/3),deadline,maxOutputTokens:p.maxOutputTokens};
}
export function validateDiagnosticBudget(b:DiagnosticRunBudget):DiagnosticRunBudget{
  if(!object(b)||!/^auto-diag-[a-f0-9]{32}$/.test(b.episodeId)||
    Object.keys(b).some(k=>!["episodeId","maxModelRequests","maxToolCalls","deadline","maxOutputTokens"].includes(k)))
    throw new Error("Invalid diagnostic Run budget");
  return {episodeId:b.episodeId,maxModelRequests:bounded(b.maxModelRequests,1,40,"Run requests"),
    maxToolCalls:bounded(b.maxToolCalls,1,100,"Run tools"),deadline:bounded(b.deadline,0,Number.MAX_SAFE_INTEGER,"Run deadline"),
    maxOutputTokens:bounded(b.maxOutputTokens,256,8192,"Run output")};
}
