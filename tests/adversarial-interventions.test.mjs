/** Permutation/property tests for QC barriers and operator decisions.
 * Deliberately vary model-plan/QC arrival order and unrelated-task progress.
 * No acceptance of a model's claims or bypass of immutable QC evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {newWorkflow,applyAction,WorkflowError} from "../dist/core/workflow.js";

const at="2026-10-10T00:00:00.000Z";
const roots=[
 {id:"root",title:"Shared API",kind:"implementation",role:"implementer",
  dependsOn:[],description:"Make a secure API",acceptanceCriteria:["API tests pass"]},
 {id:"child",title:"Dependent consumer",kind:"implementation",role:"implementer",
  dependsOn:[{taskId:"root",gate:"qc_passed"}]},
 {id:"unrelated",title:"Independent feature",kind:"implementation",role:"implementer",
  dependsOn:[]},
];
const def=(id="fuzz")=>({id,title:"QC barrier permutation",maxQcRounds:3,
 maxParallelByRole:{implementer:2,reviewer:1,architect:2,planner:1},
 tasks:roots});
const doAction=(w,op)=>applyAction(w,op,at);
const finish=(task,sha)=>({type:"implementation_finished",taskId:task,
  headSha:sha,criteriaRevision:0,testsPassed:true});
const qc=(task,sha,verdict,attempt=1)=>({type:"qc_finalized",taskId:task,
  headSha:sha,criteriaRevision:0,attempt,runId:"qc-"+task+"-"+attempt,verdict});
const plan=(id)=>({type:"plan_intervention",interventionId:id,
  rationale:"Compare risk and compatibility before proceeding",
  agents:[
    {id:"risk",title:"Analyze safety",role:"architect",model:"provider/model-a"},
    {id:"alternative",title:"Alternative",role:"reviewer",model:"provider/model-b"},
  ]});
function denied(fn,code){
 assert.throws(fn,err=>err instanceof WorkflowError&&err.code===code);
}
function completeInvestigation(w,id){
 for(const investigator of ["risk","alternative"]){
   const task="diag-"+id+"-"+investigator;
   w=doAction(w,{type:"start",taskId:task});
   w=doAction(w,{type:"complete",taskId:task});
 }
 const summary="synthesis-"+id;
 w=doAction(w,{type:"start",taskId:summary});
 return doAction(w,{type:"complete",taskId:summary});
}

test("96 permutations of QC verdict, plan ordering, timing and decision preserve human barriers",()=>{
 let permutations=0;
 for(const verdict of ["pass","fail"]){
  for(const planOrder of ["early","late"]){
   for(const phase of ["ready","running","awaiting_qc"]){
    for(const decision of ["cancel","accept_pass","rework","invalid_accept"]){
      for(const independent of [false,true]){
        // Every combination is a distinct, deterministic state transition
        // sequence. Failed transitions must leave the prior object immutable.
        const id="case-"+String(++permutations).padStart(3,"0");
        const sha=createHash("sha1").update(id).digest("hex");
        let w=newWorkflow(def("fuzz-"+id),at);
        if(phase!=="ready")w=doAction(w,{type:"start",taskId:"root"});
        if(phase==="awaiting_qc")w=doAction(w,finish("root",sha));
        // Reserve the human intervention at the requested actual stage:
        // ready vs running implementation vs awaiting independent QC.
        assert.equal(w.tasks.root.status,phase);
        w=doAction(w,{type:"request_intervention",interventionId:id,
          targetTaskId:"root",afterQcRunId:"next",
          instruction:"Compare independent safety and compatibility diagnoses"});
        if(independent){
          w=doAction(w,{type:"start",taskId:"unrelated"});
          w=doAction(w,finish("unrelated",sha));
          w=doAction(w,qc("unrelated",sha,"pass"));
          assert.equal(w.tasks.unrelated.status,"passed");
        }else assert.equal(w.tasks.unrelated.status,"ready");
        if(planOrder==="early")w=doAction(w,plan(id));
        if(phase==="ready")w=doAction(w,{type:"start",taskId:"root"});
        if(phase!=="awaiting_qc")w=doAction(w,finish("root",sha));
        assert.equal(w.tasks.child.status,"blocked");
        if(phase==="awaiting_qc")assert.equal(w.tasks.root.status,"awaiting_qc");
        w=doAction(w,qc("root",sha,verdict));
        assert.equal(w.tasks.root.status,"held");
        assert.equal(w.tasks.child.status,"blocked");
        denied(()=>doAction(w,{type:"start",taskId:"child"}),"not_ready");
        if(planOrder==="late")w=doAction(w,plan(id));
        assert.equal(w.amendments[0].status,"activated");
        denied(()=>doAction(w,{type:"resume_after_diagnosis",
          amendmentId:id,decision:"rework"}),"blocked");
        if(decision==="cancel"){
          // An activated investigation is irreversible until completed.
          denied(()=>doAction(w,{type:"cancel_amendment",amendmentId:id}),"invalid_transition");
        }
        w=completeInvestigation(w,id);
        if(decision==="invalid_accept"&&verdict==="fail"){
          const previous=w.revision;
          denied(()=>doAction(w,{type:"resume_after_diagnosis",
            amendmentId:id,decision:"accept_pass"}),"invalid_transition");
          assert.equal(w.revision,previous);
        }
        const requested=decision==="cancel"?"rework":
          decision==="invalid_accept"?"rework":decision;
        if(requested==="accept_pass"&&verdict==="fail"){
          denied(()=>doAction(w,{type:"resume_after_diagnosis",
            amendmentId:id,decision:"accept_pass"}),"invalid_transition");
          w=doAction(w,{type:"resume_after_diagnosis",amendmentId:id,decision:"rework"});
        }else{
          w=doAction(w,{type:"resume_after_diagnosis",amendmentId:id,decision:requested});
        }
        assert.equal(w.amendments[0].status,"completed");
        if(requested==="accept_pass"&&verdict==="pass"){
          assert.equal(w.tasks.root.status,"passed");
          assert.equal(w.tasks.child.status,"ready");
        }else{
          assert.equal(w.tasks.root.status,"ready");
          assert.equal(w.tasks.child.status,"blocked");
        }
        denied(()=>doAction(w,{type:"resume_after_diagnosis",
          amendmentId:id,decision:"rework"}),"invalid_transition");
      }
    }
   }
  }
 }
 assert.equal(permutations,96);
});

test("Cancel before or after QC safely releases barriers without overwriting frozen verdicts",()=>{
 for(const order of ["before","after"]){
  for(const verdict of ["pass","fail"]){
   let w=newWorkflow(def(),at);
   w=doAction(w,{type:"start",taskId:"root"});
   w=doAction(w,finish("root","a".repeat(40)));
   w=doAction(w,{type:"request_intervention",interventionId:"cancel-early",
     targetTaskId:"root",afterQcRunId:"next",instruction:"Review contract"});
   if(order==="before")w=doAction(w,{type:"cancel_amendment",amendmentId:"cancel-early"});
   w=doAction(w,qc("root","a".repeat(40),verdict));
   if(order==="after"){
     assert.equal(w.tasks.root.status,"held");
     w=doAction(w,{type:"cancel_amendment",amendmentId:"cancel-early"});
   }
   assert.equal(w.tasks.root.status,verdict==="pass"?"passed":"ready");
   assert.equal(w.tasks.child.status,verdict==="pass"?"ready":"blocked");
   assert.equal(w.tasks.root.lastQc.verdict,verdict);
   assert.equal(w.tasks.root.qcRounds,1);
   denied(()=>doAction(w,plan("cancel-early")),"invalid_transition");
  }
 }
});

test("Rejects stale/incorrect QC IDs and unauthorized releases without changing DAG revision",()=>{
 let w=newWorkflow(def(),at);
 w=doAction(w,{type:"start",taskId:"root"});
 w=doAction(w,finish("root","a".repeat(40)));
 w=doAction(w,{type:"request_intervention",interventionId:"specific",
   targetTaskId:"root",afterQcRunId:"qc-root-2",instruction:"Review exact QC round"});
 const before=w.revision;
 denied(()=>doAction(w,qc("root","a".repeat(40),"pass")),"qc_mismatch");
 assert.equal(w.revision,before);
 assert.equal(w.tasks.root.status,"awaiting_qc");
 w=doAction(w,{type:"cancel_amendment",amendmentId:"specific"});
 w=doAction(w,qc("root","a".repeat(40),"pass"));
 assert.equal(w.tasks.root.status,"passed");
 assert.equal(w.tasks.child.status,"ready");
});

test("Multiple independent interventions never release downstream tasks across another held branch",()=>{
 const input=def("two-barriers");
 input.maxParallelByRole.implementer=3;
 input.tasks=[
  {id:"left",title:"Left",kind:"implementation",role:"implementer",dependsOn:[]},
  {id:"right",title:"Right",kind:"implementation",role:"implementer",dependsOn:[]},
  {id:"join",title:"Join",kind:"implementation",role:"implementer",
   dependsOn:[{taskId:"left",gate:"qc_passed"},{taskId:"right",gate:"qc_passed"}]},
 ];
 let w=newWorkflow(input,at);
 for(const name of ["left","right"]){
  w=doAction(w,{type:"start",taskId:name});
  w=doAction(w,finish(name,"a".repeat(40)));
  w=doAction(w,{type:"request_intervention",
   interventionId:"review-"+name,targetTaskId:name,afterQcRunId:"next",
   instruction:"Independent review of "+name});
  w=doAction(w,qc(name,"a".repeat(40),"pass"));
 }
 assert.equal(w.tasks.join.status,"blocked");
 for(const name of ["left","right"])w=doAction(w,plan("review-"+name));
 w=completeInvestigation(w,"review-left");
 w=doAction(w,{type:"resume_after_diagnosis",
  amendmentId:"review-left",decision:"accept_pass"});
 assert.equal(w.tasks.left.status,"passed");
 assert.equal(w.tasks.right.status,"held");
 assert.equal(w.tasks.join.status,"blocked");
 w=completeInvestigation(w,"review-right");
 w=doAction(w,{type:"resume_after_diagnosis",
  amendmentId:"review-right",decision:"accept_pass"});
 assert.equal(w.tasks.join.status,"ready");
});

test("Intervention QC budget exhaustion refuses automatic rework but permits explicit valid pass",()=>{
 for(const verdict of ["pass","fail"]){
  const d=def("budget-"+verdict);
  d.maxQcRounds=1;
  let w=newWorkflow(d,at);
  w=doAction(w,{type:"start",taskId:"root"});
  w=doAction(w,finish("root","a".repeat(40)));
  w=doAction(w,{type:"arm_diagnosis",amendmentId:"bounded",
    targetTaskId:"root",afterQcRunId:"next",
    agents:[{id:"audit",title:"Audit",role:"architect",model:"provider/model"}]});
  w=doAction(w,qc("root","a".repeat(40),verdict));
  assert.equal(w.tasks.root.status,"held");
  w=doAction(w,{type:"start",taskId:"diag-bounded-audit"});
  w=doAction(w,{type:"complete",taskId:"diag-bounded-audit"});
  w=doAction(w,{type:"start",taskId:"synthesis-bounded"});
  w=doAction(w,{type:"complete",taskId:"synthesis-bounded"});
  denied(()=>doAction(w,{type:"resume_after_diagnosis",amendmentId:"bounded",
    decision:"rework"}),"budget_exhausted");
  if(verdict==="pass"){
   w=doAction(w,{type:"resume_after_diagnosis",amendmentId:"bounded",
     decision:"accept_pass"});
   assert.equal(w.tasks.root.status,"passed");
  }else{
   denied(()=>doAction(w,{type:"resume_after_diagnosis",amendmentId:"bounded",
     decision:"accept_pass"}),"invalid_transition");
   assert.equal(w.tasks.root.status,"held");
  }
 }
});
