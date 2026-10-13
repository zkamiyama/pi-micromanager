import test from "node:test";
import assert from "node:assert/strict";
import {linearizeImplementationDag} from "../dist/automation/dag-linearization.js";
import {newWorkflow,applyAction} from "../dist/core/workflow.js";

const spec=id=>({id,title:id,kind:"implementation",role:"implementer",dependsOn:[]});
test("G01: linearized fan-in makes every preceding source a QC dependency",()=>{
 const a=spec("a"),b=spec("b"),c=spec("c"),join=spec("join");
 join.dependsOn=[{taskId:"a",gate:"qc_passed"},{taskId:"b",gate:"qc_passed"},{taskId:"c",gate:"qc_passed"}];
 const source={id:"fan-in",title:"Fan in",maxQcRounds:3,
   maxParallelByRole:{planner:1,implementer:3,reviewer:3,architect:1},
   tasks:[a,b,c,join]};
 const original=structuredClone(source);
 const transformed=linearizeImplementationDag(source);
 assert.deepEqual(source,original,"The model proposal must remain unchanged");
 assert.ok(transformed.tasks.find(t=>t.id==="b").dependsOn.some(d=>d.taskId==="a"));
 assert.ok(transformed.tasks.find(t=>t.id==="c").dependsOn.some(d=>d.taskId==="b"));
 const final=transformed.tasks.find(t=>t.id==="join");
 assert.ok(final.dependsOn.some(d=>d.taskId==="c"));
 let state=newWorkflow(transformed,"2026-10-13T00:00:00Z");
 assert.deepEqual(Object.values(state.tasks).filter(t=>t.status==="ready").map(t=>t.spec.id),["a"]);
 state=applyAction(state,{type:"start",taskId:"a"},"2026-10-13T00:00:00Z");
 assert.equal(state.tasks.b.status,"blocked");
});
test("G01: invalid cycles are rejected rather than silently linearized",()=>{
 const a=spec("a"),b=spec("b");
 a.dependsOn=[{taskId:"b",gate:"qc_passed"}];
 b.dependsOn=[{taskId:"a",gate:"qc_passed"}];
 assert.throws(()=>linearizeImplementationDag({
   id:"cyclic",title:"Cyclic",maxQcRounds:2,
   maxParallelByRole:{planner:1,implementer:1,reviewer:1,architect:1},
   tasks:[a,b],
 }),/cycle/i);
});
