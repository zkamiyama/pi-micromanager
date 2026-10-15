import type {LocalArtifact} from "./local-artifacts.js";
import type {AdrLink} from "./local-journal.js";
import type {WorktreeRetirement} from "./owned-worktree-retention.js";
/** Derived, finite workflow journal: no Pi reasoning, credentials, tool args or transcript copies. */
import type {WorkflowInstance} from "../core/workflow.js";
import type {AgentBinding} from "../runtime/registry.js";
import type {AutopilotLedger} from "./ledger.js";
import type {ScreenshotArtifact} from "./screenshots.js";

export interface JournalTask {
  id:string;title:string;kind:string;role:string;status:string;
  attempts:number;qcRounds:number;
  lastQc?:{runId:string;verdict:string;headSha:string};
}
export interface JournalRun {
  runId:string;taskId:string;seat:string;phase:string;sessionId:string|null;
  latestKind:string|null;createdAt:string;updatedAt:string;
  evidence?:{ref:string;kind:string;summary:string;createdAt:string};
}
export interface WorkflowJournal {
  local?:{artifacts:LocalArtifact[];adrLinks:AdrLink[];usage:{storedBytes:number;maxBytes:number;maxAgeDays:number;unresolved:number};
    retirements:WorktreeRetirement[];status:{phase:string;message:string}};
  workflowId:string;revision:number;updatedAt:string;title:string;
  tasks:JournalTask[];runs:JournalRun[];
  screenshots:ScreenshotArtifact[];
  events:{revision:number;type:string;message:string;at:string}[];
  notes:string[];
}
export function buildJournal(workflow:WorkflowInstance,
  allRuns:readonly AgentBinding[],ledger:Pick<AutopilotLedger,"evidence">,
  screenshots:readonly ScreenshotArtifact[]=[]):WorkflowJournal {
  const matching=allRuns.filter(run=>run.workflowId===workflow.definition.id)
    .slice(0,120);
  const runs:JournalRun[]=matching.map(binding=>{
    const evidence=ledger.evidence(binding);
    return {runId:binding.runId,taskId:binding.taskId,
      seat:binding.seat,phase:binding.phase,sessionId:binding.sessionId,
      latestKind:binding.latestKind,
      createdAt:binding.createdAt,updatedAt:binding.updatedAt,
      ...(evidence?.ref===binding.evidenceRef?{
        evidence:{ref:evidence.ref,kind:evidence.kind,
          // Summary is a finite host-approved projection, not Pi JSONL.
          summary:evidence.text.slice(0,1200),createdAt:evidence.createdAt},
      }:{})};
  });
  const tasks=Object.values(workflow.tasks).slice(0,512).map(task=>({
    id:task.spec.id,title:task.spec.title,kind:task.spec.kind,
    role:task.spec.role,status:task.status,attempts:task.attempts,
    qcRounds:task.qcRounds,
    ...(task.lastQc?{lastQc:{runId:task.lastQc.runId,
      verdict:task.lastQc.verdict,headSha:task.lastQc.headSha}}:{}),
  }));
  const pending=workflow.amendments
    .filter(a=>a.status==="planning"||a.status==="armed"||a.status==="activated");
  const notes:string[]=[];
  if(pending.length)notes.push(pending.length+" active human QC intervention(s) still pending");
  if(tasks.some(t=>t.status==="passed"))
    notes.push("QC-passed work still requires a verified Git integration decision");
  if(tasks.some(t=>t.status==="needs_human"))
    notes.push("At least one Task requires explicit human intervention");
  return {workflowId:workflow.definition.id,
    revision:workflow.revision,updatedAt:workflow.updatedAt,
    title:workflow.definition.title,
    tasks,runs,screenshots:screenshots.slice(0,32),
    events:workflow.events.slice(-120).reverse(),notes};
}
