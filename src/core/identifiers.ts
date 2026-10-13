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
