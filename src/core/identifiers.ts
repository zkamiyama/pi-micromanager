/** Deterministic bounded internal identifiers. Public Task IDs may be 64 chars,
 * but composed Run and command IDs have smaller independent protocol limits. */
import {createHash} from "node:crypto";
const digest=(value:string)=>createHash("sha256").update(value).digest("hex").slice(0,20);
export function internalRunId(prefix:"impl"|"qc"|"task"|"plan",
  id:string,attempt?:number):string{
  const raw=prefix+"-"+id+(attempt===undefined?"":"-"+attempt);
  if(raw.length<=64)return raw;
  const suffix="-"+digest(raw)+(attempt===undefined?"":"-"+attempt);
  return prefix+"-"+id.slice(0,64-prefix.length-1-suffix.length)+suffix;
}
export function internalCommandId(raw:string):string{
  if(raw.length<=128)return raw;
  return "auto:"+createHash("sha256").update(raw).digest("hex");
}

/** Display names are independent of identity and must fit native Pi's wire limit. */
export function sessionDisplayName(prefix:string,seat:string,taskId:string,runId:string):string{
  const raw=[prefix,seat,taskId,runId].join(" ");
  return raw.length<=120?raw:raw.slice(0,99)+"-"+digest(raw);
}
/** Keep dynamic Task IDs valid for every accepted intervention/investigator ID. */
export function diagnosisTaskId(amendmentId:string,agentId:string):string{
  const raw="diag-"+amendmentId+"-"+agentId;
  return raw.length<=64?raw:raw.slice(0,43)+"-"+digest(raw);
}
export function synthesisTaskId(amendmentId:string):string{
  const raw="synthesis-"+amendmentId;
  return raw.length<=64?raw:raw.slice(0,43)+"-"+digest(raw);
}
export function managedBranch(scopeHash:string,workflowId:string,taskId:string):string{
  const raw="mm/"+scopeHash+"/"+workflowId+"/"+taskId;
  return raw.length<=119?raw:raw.slice(0,98).replace(/\/+$/,"")+"-"+digest(raw);
}
