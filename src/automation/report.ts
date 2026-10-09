/** One-shot structured Pi Run result. A model report is evidence input, NOT a QC gate itself. */
import { parseDefinition, type WorkflowDefinition } from "../core/workflow.js";
export const REPORT_CHANNEL = "pi-micromanager:run-report:v1";
export interface PlanInvestigator {
  id:string; title:string; role:"architect"|"reviewer";model:string;
}
export type RunReport =
  | { kind:"qc"; runId:string; verdict:"pass"|"fail"|"inconclusive"; summary:string; at:number }
  | { kind:"task"; runId:string; summary:string; at:number }
  | { kind:"plan"; runId:string; summary:string;agents:PlanInvestigator[];at:number }
  | { kind:"workflow_plan"; runId:string; summary:string;
      definition:WorkflowDefinition;at:number };
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
  if(v.kind==="workflow_plan"){
    try{
      if(JSON.stringify(v.definition).length>12000)return;
      const definition=parseDefinition(v.definition);
      if(definition.tasks.length>16||definition.tasks.some(t=>
        t.kind!=="implementation"||t.role!=="implementer"||
        !t.description||!t.acceptanceCriteria?.length))return;
      return {kind:"workflow_plan",runId:v.runId,summary:v.summary,definition,at:v.at};
    }catch{return;}
  }
  if(v.kind==="plan"){
    if(!Array.isArray(v.agents)||v.agents.length<1||v.agents.length>4)return;
    const agents:PlanInvestigator[]=[];
    const ids=new Set<string>();
    for(const item of v.agents){
      if(!item||typeof item!=="object"||Array.isArray(item))return;
      const a=item as Record<string,unknown>;
      if(typeof a.id!=="string"||!/^[a-z][a-z0-9-]{0,31}$/.test(a.id)||
        ids.has(a.id)||typeof a.title!=="string"||!a.title.trim()||a.title.length>200||
        (a.role!=="architect"&&a.role!=="reviewer")||
        typeof a.model!=="string"||!a.model.trim()||a.model.length>160)return;
      ids.add(a.id);
      agents.push({id:a.id,title:a.title,role:a.role,model:a.model});
    }
    return {kind:"plan",runId:v.runId,summary:v.summary,agents,at:v.at};
  }
  return;
}
