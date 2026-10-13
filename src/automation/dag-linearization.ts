/** Optional no-merge implementation for fan-in graphs.
 * A stable topological chain makes every subsequent feature commit descend
 * from earlier QC-sealed commits. This trades parallelism for safe ff-only Git.
 * Do not silently rewrite already admitted Workflows. */
import {parseDefinition,type WorkflowDefinition,type TaskSpec} from "../core/workflow.js";
export function linearizeImplementationDag(input:unknown):WorkflowDefinition{
  const original=parseDefinition(input);
  if(original.tasks.some(t=>t.kind!=="implementation"))
    throw new Error("Linearized mode supports implementation-only original DAGs");
  const lookup=new Map(original.tasks.map(t=>[t.id,t]));
  const visited=new Set<string>();
  const ordered:TaskSpec[]=[];
  function visit(task:TaskSpec):void{
    if(visited.has(task.id))return;
    for(const dep of task.dependsOn)visit(lookup.get(dep.taskId)!);
    visited.add(task.id);ordered.push(task);
  }
  for(const task of original.tasks)visit(task);
  const result=structuredClone(original);
  const mapped=new Map(result.tasks.map(t=>[t.id,t]));
  let predecessor:TaskSpec|undefined;
  for(const originalTask of ordered){
    const task=mapped.get(originalTask.id)!;
    if(predecessor&&!task.dependsOn.some(d=>d.taskId===predecessor!.id))
      task.dependsOn.push({taskId:predecessor.id,gate:"qc_passed"});
    predecessor=task;
  }
  // Deterministic generated graph remains subject to the same schema,
  // role, identity and acyclicity validation as a user-authored DAG.
  return parseDefinition(result);
}
