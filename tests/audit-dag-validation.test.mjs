import test from "node:test";
import assert from "node:assert/strict";
import {parseDefinition} from "../dist/core/workflow.js";
const base={id:"audit-dag",title:"DAG validation",maxQcRounds:2,
 maxParallelByRole:{planner:1,implementer:1,reviewer:1,architect:1},
 tasks:[{id:"api",title:"API",kind:"implementation",role:"implementer",dependsOn:[]}]};
test("F16: user tasks cannot collide with reserved final integration name",()=>{
 const task={...base.tasks[0],id:"mm-final-integration"};
 assert.throws(()=>parseDefinition({...base,tasks:[task]}),e=>e.code==="reserved_task_id");
});
test("F17: non-implementation tasks cannot satisfy QC or integrated gates",()=>{
 const task={id:"diagnose",title:"Diagnose",kind:"diagnosis",role:"reviewer",dependsOn:[]};
 for(const gate of ["qc_passed","qc_finalized","integrated"]){
  const consumer={id:"consumer",title:"Consumer",kind:"implementation",
    role:"implementer",dependsOn:[{taskId:"diagnose",gate}]};
  assert.throws(()=>parseDefinition({...base,tasks:[task,consumer]}),
    e=>e.code==="unreachable_gate");
 }
 const consumer={id:"consumer",title:"Consumer",kind:"implementation",
  role:"implementer",dependsOn:[{taskId:"diagnose",gate:"completed"}]};
 assert.doesNotThrow(()=>parseDefinition({...base,tasks:[task,consumer]}));
});
