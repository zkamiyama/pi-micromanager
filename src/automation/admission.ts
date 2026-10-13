/** Validate executable contracts as a whole, before provisioning or launching. */
import {internalRunId} from "../core/identifiers.js";
import {WorkflowError,applyAction,type WorkflowInstance} from "../core/workflow.js";
import {buildJobPrompt} from "./engine.js";
import type {AutopilotConfig} from "./ledger.js";
export function validateExecutionPlan(workflow:WorkflowInstance,config:AutopilotConfig):void {
  const tasks=Object.values(workflow.tasks);
  const sources=tasks.filter(t=>t.spec.kind==="implementation"&&t.spec.systemPurpose!=="final-integration");
  const fail=(code:string,message:string):never=>{throw new WorkflowError(code,message);};
  if(sources.length>100)fail("workspace_capacity","At most 100 original implementation Workspaces are supported");
  if(config.finalization){
    if(sources.length<1||sources.length>64)fail("finalization_capacity","Final integration needs 1..64 source Tasks");
    if(!workflow.tasks["mm-final-integration"]&&tasks.length>=512)
      fail("finalization_capacity","Reserve a free Task slot for final integration");
  }
  if(config.managedWorktrees&&sources.length+(config.finalization?1:0)>(config.maxManagedWorktrees??32))
    fail("worktree_capacity","Managed Worktree budget exceeded before Git mutation");
  // ff-only can consume multiple predecessors only when their approved
  // histories already form one chain. Independent fan-in requires an explicit
  // reviewed integration or opt-in linearization BEFORE this Workflow is saved.
  const ancestors=new Map<string,Set<string>>();
  const visit=(id:string):Set<string>=>{
    const cached=ancestors.get(id);if(cached)return cached;
    const found=new Set<string>();ancestors.set(id,found);
    for(const dep of workflow.tasks[id]!.spec.dependsOn){
      found.add(dep.taskId);for(const ancestor of visit(dep.taskId))found.add(ancestor);
    }
    return found;
  };
  for(const task of sources){
    const parents=[...new Set(task.spec.dependsOn.filter(d=>
      workflow.tasks[d.taskId]?.spec.kind==="implementation").map(d=>d.taskId))];
    for(let i=0;i<parents.length;i++)for(let j=i+1;j<parents.length;j++){
      const a=parents[i]!,b=parents[j]!;
      if(!visit(a).has(b)&&!visit(b).has(a))
        fail("unsupported_fan_in","Independent fan-in at "+task.spec.id+
          " cannot use ff-only convergence; explicitly linearize the proposal or add a reviewed integration plan before Start");
    }
  }
  const runOwners=new Map<string,string>();
  for(const task of tasks){
    const prefixes=task.spec.kind==="implementation"?["impl","qc"] as const:["task"] as const;
    for(const prefix of prefixes)for(let attempt=1;attempt<=(task.spec.kind==="implementation"?config.maxAttempts:1);attempt++){
      const run=internalRunId(prefix,task.spec.id,attempt),owner=task.spec.id+":"+prefix+":"+attempt;
      if(runOwners.has(run)&&runOwners.get(run)!==owner)
        fail("run_id_collision","Task identifiers compose the same Run identity: "+run);
      runOwners.set(run,owner);
    }
  }
  for(const task of tasks){
    if(task.spec.systemPurpose==="final-integration")continue;
    buildJobPrompt(workflow,task,task.spec.kind);
    if(task.spec.kind==="implementation"){
      buildJobPrompt(workflow,task,"qc");
      buildJobPrompt(workflow,{...task,attempts:10},"implementation",["x".repeat(4000)]);
    }
  }
  if(config.finalization){
    // Build the largest final contract now, not after source work has incurred cost.
    let sample=structuredClone(workflow);
    for(const task of Object.values(sample.tasks)){
      if(task.spec.kind==="implementation"){
        task.status="passed";task.lastQc={runId:"qc-preflight",verdict:"pass",
          headSha:"a".repeat(64),criteriaRevision:0,attempt:10};
      }else task.status="done";
    }
    sample.amendments=[];
    if(!sample.tasks["mm-final-integration"])
      sample=applyAction(sample,{type:"prepare_final_integration"},sample.updatedAt);
    const final=sample.tasks["mm-final-integration"]!;
    buildJobPrompt(sample,final,"implementation");
    buildJobPrompt(sample,final,"qc",[],config.runtime==="durable");
  }
}
