/** One-shot structured Pi Run result. A model report is evidence input, NOT a QC gate itself. */
export const REPORT_CHANNEL = "pi-micromanager:run-report:v1";
export type RunReport =
  | { kind:"qc"; runId:string; verdict:"pass"|"fail"|"inconclusive"; summary:string; at:number }
  | { kind:"task"; runId:string; summary:string; at:number };
const runPattern = /^[a-z][a-z0-9-]{0,127}$/;
export function parseRunReport(value:unknown):RunReport|undefined {
  if(!value||typeof value!=="object"||Array.isArray(value))return;
  const v=value as Record<string,unknown>;
  if(typeof v.runId!=="string"||!runPattern.test(v.runId)||
    typeof v.summary!=="string"||!v.summary.trim()||v.summary.length>2000||
    !Number.isSafeInteger(v.at)||typeof v.at!=="number"||v.at<0)return;
  if(v.kind==="qc"){
    if(v.verdict!=="pass"&&v.verdict!=="fail"&&v.verdict!=="inconclusive")return;
    return {kind:"qc",runId:v.runId,verdict:v.verdict,summary:v.summary,at:v.at};
  }
  if(v.kind==="task")return {kind:"task",runId:v.runId,summary:v.summary,at:v.at};
  return;
}
