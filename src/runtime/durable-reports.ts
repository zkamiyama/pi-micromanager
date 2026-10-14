/** Runtime-independent report schemas, validated before the one-shot claim. */
import {Type} from "@earendil-works/pi-ai";
import {defineTool} from "@earendil-works/pi-durable";
import {parseRunReport,type RunReport} from "../automation/report.js";
export function reportTools(kind:string,runId:string,emit:(report:RunReport)=>void,
  at:number,canPassFinalQc?:()=>boolean){
  let submitted=false;
  function record(value:unknown){
    const r=parseRunReport(value);
    if(!r||r.runId!==runId)throw new Error("Invalid Durable Run report");
    if(submitted)throw new Error("Run report already submitted");
    emit(r);submitted=true;
    return {output:[{type:"text" as const,text:"Structured report stored. Host Git/QC gates still apply."}]};
  }
  const summary=Type.String({minLength:1,maxLength:2000});
  const qc=defineTool({name:"mm_qc_report",
    description:"Submit an independent QC verdict exactly once. This does not authorize merging.",
    parameters:Type.Object({verdict:Type.Union([Type.Literal("pass"),Type.Literal("fail"),Type.Literal("inconclusive")]),summary}),replay:"safe",
    async execute(args){
      if(kind!=="qc")throw new Error("Not a QC Run");
      if(args.verdict==="pass"&&canPassFinalQc&&!canPassFinalQc())
        throw new Error("All final QC source contracts must be retrieved before PASS");
      return record({kind:"qc",runId,verdict:args.verdict,summary:args.summary,at});
    }});
  const task=defineTool({name:"mm_task_report",
    description:"Submit an evidence-backed read-only investigation or synthesis summary.",
    parameters:Type.Object({summary}),replay:"safe",
    async execute(args){
      if(kind!=="diagnosis"&&kind!=="synthesis")throw new Error("Not an investigation Run");
      return record({kind:"task",runId,summary:args.summary,at});
    }});
  const plan=defineTool({name:"mm_plan_intervention",
    description:"Propose 1–4 independent investigators. The host validates models, roles and DAG gates.",
    parameters:Type.Object({summary,agents:Type.Array(Type.Object({
      id:Type.String({minLength:1,maxLength:32}),title:Type.String({minLength:1,maxLength:200}),
      role:Type.Union([Type.Literal("architect"),Type.Literal("reviewer")]),
      model:Type.String({minLength:1,maxLength:160}),}),{minItems:1,maxItems:4})}),replay:"safe",
    async execute(args){
      if(kind!=="planning")throw new Error("Not a planning Run");
      return record({kind:"plan",runId,summary:args.summary,agents:args.agents,at});
    }});
  const proposal=defineTool({name:"mm_workflow_proposal",
    description:"Submit a valid DAG for host-side verification. Never start code automatically from this tool.",
    parameters:Type.Object({id:Type.String({minLength:1,maxLength:64}),
      title:Type.String({minLength:1,maxLength:200}),summary,
      maxQcRounds:Type.Integer({minimum:1,maximum:10}),
      tasks:Type.Array(Type.Object({id:Type.String({minLength:1,maxLength:64}),
        title:Type.String({minLength:1,maxLength:200}),description:Type.String({minLength:1,maxLength:4000}),
        acceptanceCriteria:Type.Array(Type.String({minLength:1,maxLength:500}),{minItems:1,maxItems:20}),
        dependsOn:Type.Array(Type.Object({taskId:Type.String({minLength:1,maxLength:64}),
          gate:Type.Union([Type.Literal("qc_passed"),Type.Literal("integrated")])}),{maxItems:16})}),
        {minItems:1,maxItems:16})}),replay:"safe",
    async execute(args){
      if(kind!=="workflow_plan")throw new Error("Not a goal proposal Run");
      const definition={id:args.id,title:args.title,maxQcRounds:args.maxQcRounds,
        maxParallelByRole:{planner:1,implementer:2,reviewer:2,architect:2},
        tasks:args.tasks.map(t=>({...t,kind:"implementation" as const,role:"implementer" as const}))};
      return record({kind:"workflow_plan",runId,summary:args.summary,definition,at});
    }});
  return {qc,task,plan,proposal};
}
