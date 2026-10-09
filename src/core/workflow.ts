/** Pure, deterministic workflow state machine. No model or filesystem I/O. */
import {validatePermissions,type WorkflowPermissions} from "./permissions.js";
export type Role = "planner" | "implementer" | "reviewer" | "architect";
export type TaskKind = "implementation" | "diagnosis" | "synthesis";
export type Gate = "completed" | "qc_passed" | "integrated" | "qc_finalized";
export type TaskStatus = "blocked" | "ready" | "running" | "awaiting_qc" | "held" | "passed" | "integrated" | "done" | "needs_human";
export type QCResult = "pass" | "fail" | "inconclusive";

export interface Dependency { taskId: string; gate: Gate }
export interface TaskSpec {
  id: string;
  title: string;
  /** Bounded instructions and acceptance criteria shared by implementation and QC. */
  description?: string;
  acceptanceCriteria?: string[];
  kind: TaskKind;
  role: Role;
  dependsOn: Dependency[];
  /** A provider model ID, not a CLI or API credential. */
  model?: string;
  /** Only the Workflow engine may generate this internal, post-DAG Task. */
  systemPurpose?:"final-integration";
}
export interface WorkflowDefinition {
  id: string;
  title: string;
  maxQcRounds: number;
  maxParallelByRole: Record<Role, number>;
  tasks: TaskSpec[];
  /** Absent policy is YOLO (allow) for supported operations; merge defaults to ask. */
  permissions?:WorkflowPermissions;
}
export interface QCRecord {
  runId: string;
  verdict: QCResult;
  headSha: string;
  criteriaRevision: number;
  attempt: number;
}
export interface TaskState {
  spec: TaskSpec;
  status: TaskStatus;
  attempts: number;
  qcRounds: number;
  lastQc?: QCRecord;
  pendingWork?: { headSha: string; criteriaRevision: number; attempt: number };
  parentTaskId?: string;
}
export interface DiagnosticAgent {
  id: string;
  title: string;
  role: "architect" | "reviewer";
  model: string;
}
export interface Amendment {
  id: string;
  targetTaskId: string;
  afterQcRunId: string;
  status: "planning" | "armed" | "activated" | "completed" | "cancelled";
  instruction?: string;
  planRationale?: string;
  agents: DiagnosticAgent[];
  synthesisTaskId?: string;
}
export interface WorkflowEvent {
  revision: number;
  type: string;
  message: string;
  at: string;
}
export interface WorkflowInstance {
  definition: WorkflowDefinition;
  revision: number;
  tasks: Record<string, TaskState>;
  amendments: Amendment[];
  events: WorkflowEvent[];
  createdAt: string;
  updatedAt: string;
}
export type WorkflowAction =
  | { type: "start"; taskId: string }
  | { type: "implementation_finished"; taskId: string; headSha: string; criteriaRevision: number; testsPassed: boolean }
  | { type: "qc_finalized"; taskId: string; runId: string; headSha: string; criteriaRevision: number; attempt: number; verdict: QCResult }
  | { type: "arm_diagnosis"; amendmentId: string; targetTaskId: string; afterQcRunId: string; agents: DiagnosticAgent[] }
  | { type: "request_intervention"; interventionId: string; targetTaskId: string; afterQcRunId: string; instruction: string }
  | { type: "plan_intervention"; interventionId: string; agents: DiagnosticAgent[]; rationale: string }
  | { type: "cancel_amendment"; amendmentId: string }
  | { type: "complete"; taskId: string }
  | { type: "resume_after_diagnosis"; amendmentId: string; decision: "rework" | "accept_pass" }
  | { type: "integrate"; taskId: string }
  | { type: "prepare_final_integration" }
  | { type: "final_merge_confirmed"; taskId:string; headSha:string; prUrl:string };

export class WorkflowError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WorkflowError"; }
}
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const roles: Role[] = ["planner", "implementer", "reviewer", "architect"];
const gates: Gate[] = ["completed", "qc_passed", "integrated", "qc_finalized"];
function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new WorkflowError(code, message);
}
function validId(value: unknown): value is string { return typeof value === "string" && identifier.test(value); }

/** Reject cycles and impossible references before any work can start. */
export function validateDefinition(def: WorkflowDefinition): void {
  try{validatePermissions(def.permissions);}
  catch(error){throw new WorkflowError("invalid_permissions",String(error));}
  invariant(validId(def.id), "invalid_id", "Workflow ID must be lowercase kebab-case");
  invariant(typeof def.title === "string" && !!def.title.trim(), "invalid_title", "Workflow title is required");
  invariant(Number.isSafeInteger(def.maxQcRounds) && def.maxQcRounds >= 1 && def.maxQcRounds <= 100, "invalid_budget", "maxQcRounds must be 1..100");
  invariant(def.maxParallelByRole !== null && typeof def.maxParallelByRole === "object", "invalid_parallelism", "Parallelism configuration is required");
  for (const role of roles) {
    const limit = def.maxParallelByRole[role];
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 128, "invalid_parallelism", `Invalid parallelism for ${role}`);
  }
  invariant(Array.isArray(def.tasks) && def.tasks.length > 0 && def.tasks.length <= 512, "invalid_tasks", "Workflow must have 1..512 tasks");
  const tasks = new Map<string, TaskSpec>();
  for (const task of def.tasks) {
    invariant(task !== null && validId(task.id) && !tasks.has(task.id), "duplicate_task", "Task IDs must be unique lowercase kebab-case");
    invariant(typeof task.title === "string" && !!task.title.trim() && task.title.length <= 200,
      "invalid_task", `Title must be 1..200 characters for ${task.id}`);
    if(task.description!==undefined)
      invariant(typeof task.description==="string"&&!!task.description.trim()&&
        task.description.length<=4000,"invalid_description",
        `Description must be 1..4000 characters for ${task.id}`);
    if(task.acceptanceCriteria!==undefined)
      invariant(Array.isArray(task.acceptanceCriteria)&&task.acceptanceCriteria.length>=1&&
        task.acceptanceCriteria.length<=20&&task.acceptanceCriteria.every(x=>
          typeof x==="string"&&!!x.trim()&&x.length<=500),
        "invalid_acceptance","Acceptance criteria must be 1..20 nonempty lines <=500 characters");
    invariant(roles.includes(task.role) && ["implementation", "diagnosis", "synthesis"].includes(task.kind), "invalid_task", `Invalid kind or role for ${task.id}`);
    invariant(Array.isArray(task.dependsOn), "invalid_dependencies", `dependsOn required for ${task.id}`);
    if (task.model !== undefined) invariant(typeof task.model === "string" && task.model.length <= 160, "invalid_model", "Invalid model ID");
    tasks.set(task.id, task);
  }
  for (const task of def.tasks) for (const dep of task.dependsOn) {
    invariant(dep !== null && validId(dep.taskId) && tasks.has(dep.taskId), "unknown_dependency", `${task.id} depends on missing task ${dep?.taskId}`);
    invariant(gates.includes(dep.gate), "invalid_gate", `${task.id}: invalid dependency gate`);
    invariant(dep.taskId !== task.id, "cycle", `${task.id} depends on itself`);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    invariant(!visiting.has(id), "cycle", `DAG contains a cycle through ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of tasks.get(id)!.dependsOn) visit(dep.taskId);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of def.tasks) visit(task.id);
}

function satisfies(task: TaskState, gate: Gate): boolean {
  if (gate === "qc_finalized") return task.lastQc !== undefined;
  if (gate === "integrated") return task.status === "integrated";
  if (gate === "qc_passed") return task.status === "passed" || task.status === "integrated";
  return ["done", "passed", "integrated"].includes(task.status);
}
/** A human hold blocks downstream work; only its own diagnostic nodes may read the finalized QC. */
function dependencySatisfied(instance: WorkflowInstance, downstream: TaskState, dep: Dependency): boolean {
  const upstream = instance.tasks[dep.taskId];
  if (!upstream) return false;
  if (upstream.status !== "held") return satisfies(upstream, dep.gate);
  return downstream.spec.kind === "diagnosis" && downstream.parentTaskId === dep.taskId &&
    dep.gate === "qc_finalized" && upstream.lastQc !== undefined;
}
function releaseReady(instance: WorkflowInstance): void {
  // Previously ready nodes must be re-blocked when a new human hold invalidates
  // a QC dependency. Merely rejecting start() would leave a misleading Kanban card.
  for (const t of Object.values(instance.tasks)) {
    if (t.status === "ready" && !t.spec.dependsOn.every(d => dependencySatisfied(instance, t, d))) {
      t.status = "blocked";
    }
  }
  for (const t of Object.values(instance.tasks)) {
    if (t.status !== "blocked") continue;
    if (t.spec.dependsOn.every(d => dependencySatisfied(instance, t, d))) t.status = "ready";
  }
}
export function newWorkflow(input: WorkflowDefinition, at: string): WorkflowInstance {
  validateDefinition(input);
  const definition = structuredClone(input);
  const tasks: Record<string, TaskState> = Object.create(null) as Record<string, TaskState>;
  for (const spec of definition.tasks) tasks[spec.id] = { spec, status: "blocked", attempts: 0, qcRounds: 0 };
  const instance: WorkflowInstance = { definition, revision: 0, tasks, amendments: [], events: [], createdAt: at, updatedAt: at };
  releaseReady(instance);
  return instance;
}
function taskById(instance: WorkflowInstance, id: string): TaskState {
  const task = Object.hasOwn(instance.tasks, id) ? instance.tasks[id] : undefined;
  invariant(task, "not_found", `No task ${id}`);
  return task;
}
function activeRuns(instance: WorkflowInstance, role: Role): number {
  return Object.values(instance.tasks).filter(t => t.status === "running" && t.spec.role === role).length;
}
function installDiagnosis(instance: WorkflowInstance, amendment: Amendment): void {
  const target = taskById(instance, amendment.targetTaskId);
  for (const agent of amendment.agents) {
    const id = `diag-${amendment.id}-${agent.id}`;
    const spec: TaskSpec = {
      id, title: agent.title, kind: "diagnosis", role: agent.role, model: agent.model,
      dependsOn: [{ taskId: target.spec.id, gate: "qc_finalized" }],
    };
    instance.definition.tasks.push(spec);
    instance.tasks[id] = { spec, status: "blocked", attempts: 0, qcRounds: 0, parentTaskId: target.spec.id };
  }
  const id = `synthesis-${amendment.id}`;
  amendment.synthesisTaskId = id;
  const spec: TaskSpec = { id, title: "Synthesize independent diagnoses", kind: "synthesis", role: "planner",
    dependsOn: amendment.agents.map(a => ({ taskId: `diag-${amendment.id}-${a.id}`, gate: "completed" })) };
  instance.definition.tasks.push(spec);
  instance.tasks[id] = { spec, status: "blocked", attempts: 0, qcRounds: 0, parentTaskId: target.spec.id };
  validateDefinition(instance.definition);
}


/** Validate proposed independent investigators before touching the graph. */
function checkInvestigators(instance: WorkflowInstance, amendmentId: string, agents: DiagnosticAgent[]): void {
  invariant(Array.isArray(agents) && agents.length >= 1 && agents.length <= 4,
    "invalid_agents", "1..4 diagnosis agents required");
  const seen = new Set<string>();
  for (const agent of agents) {
    invariant(agent !== null && validId(agent.id) && !seen.has(agent.id) &&
      (agent.role === "architect" || agent.role === "reviewer") &&
      typeof agent.title === "string" && agent.title.trim().length > 0 && agent.title.length <= 200 &&
      typeof agent.model === "string" && agent.model.trim().length > 0 && agent.model.length <= 160,
      "invalid_agents", "Each investigator requires a unique id, allowed role, model and title");
    seen.add(agent.id);
  }
  for (const id of [...agents.map(a => "diag-" + amendmentId + "-" + a.id), "synthesis-" + amendmentId]) {
    invariant(validId(id) && !Object.hasOwn(instance.tasks, id), "invalid_id",
      "Dynamic task id collision: " + id);
  }
}
function noOtherPendingIntervention(instance: WorkflowInstance, taskId: string): void {
  invariant(!instance.amendments.some(a => a.targetTaskId === taskId &&
    ["planning", "armed", "activated"].includes(a.status)),
    "barrier_exists", "Task already has an active or pending intervention");
}
function normalPostQcStatus(instance: WorkflowInstance, task: TaskState): TaskStatus {
  invariant(task.lastQc, "invalid_transition", "No finalized QC to release");
  return task.lastQc.verdict === "pass" ? "passed" :
    task.qcRounds >= instance.definition.maxQcRounds ? "needs_human" : "ready";
}

/** One command = one immutable revision; storage enforces CAS and command idempotency. */
export function applyAction(current: WorkflowInstance, action: WorkflowAction, at: string): WorkflowInstance {
  const instance = structuredClone(current);
  let message = "";
  switch (action.type) {
    case "start": {
      const t = taskById(instance, action.taskId);
      invariant(t.status === "ready", "not_ready", `${t.spec.id} is not ready`);
      invariant(t.spec.dependsOn.every(d => dependencySatisfied(instance, t, d)), "blocked", "Dependencies not satisfied");
      invariant(activeRuns(instance, t.spec.role) < instance.definition.maxParallelByRole[t.spec.role], "capacity", "Role capacity exhausted");
      t.status = "running"; t.attempts += 1;
      message = `Started ${t.spec.id} attempt ${t.attempts}`;
      break;
    }
    case "implementation_finished": {
      const t = taskById(instance, action.taskId);
      invariant(t.spec.kind === "implementation" && t.status === "running", "invalid_transition", "Not a running implementation");
      invariant(!!action.headSha.trim() && Number.isSafeInteger(action.criteriaRevision) && action.criteriaRevision >= 0, "invalid_evidence", "Commit SHA and criteria revision are required");
      if (action.testsPassed) {
        t.status = "awaiting_qc";
        t.pendingWork = { headSha: action.headSha, criteriaRevision: action.criteriaRevision, attempt: t.attempts };
      } else {
        t.status = "ready";
      }
      message = `${t.spec.id} tests ${action.testsPassed ? "passed; QC required" : "failed; rework required"}`;
      break;
    }

    case "arm_diagnosis": {
      const t = taskById(instance, action.targetTaskId);
      invariant(t.spec.kind === "implementation" && ["ready", "running", "awaiting_qc"].includes(t.status),
        "invalid_transition", "Can only arm before QC finalization");
      invariant(validId(action.amendmentId) && validId(action.afterQcRunId), "invalid_id", "Invalid amendment or QC ID");
      invariant(instance.amendments.every(a => a.id !== action.amendmentId), "duplicate_amendment", "Amendment already exists");
      noOtherPendingIntervention(instance, t.spec.id);
      checkInvestigators(instance, action.amendmentId, action.agents);
      instance.amendments.push({
        id: action.amendmentId, targetTaskId: action.targetTaskId, afterQcRunId: action.afterQcRunId,
        status: "armed", agents: structuredClone(action.agents),
      });
      message = "Armed " + action.amendmentId + "; suspend normal path after QC " + action.afterQcRunId;
      break;
    }
    case "request_intervention": {
      const t = taskById(instance, action.targetTaskId);
      invariant(t.spec.kind === "implementation" && ["ready", "running", "awaiting_qc"].includes(t.status),
        "invalid_transition", "A task-scoped QC barrier needs an active or upcoming implementation");
      invariant(validId(action.interventionId) && validId(action.afterQcRunId),
        "invalid_id", "Invalid intervention/QC run ID");
      invariant(typeof action.instruction === "string" && action.instruction.trim().length > 0 &&
        action.instruction.length <= 4000, "invalid_instruction", "Instruction must be 1..4000 characters");
      invariant(instance.amendments.every(a => a.id !== action.interventionId),
        "duplicate_amendment", "Intervention ID already exists");
      noOtherPendingIntervention(instance, t.spec.id);
      instance.amendments.push({
        id: action.interventionId, targetTaskId: t.spec.id, afterQcRunId: action.afterQcRunId,
        status: "planning", instruction: action.instruction.trim(), agents: [],
      });
      message = "Intervention " + action.interventionId + " requested on " + t.spec.id + "; QC transition reserved pending Sol plan";
      break;
    }
    case "plan_intervention": {
      const a = instance.amendments.find(a => a.id === action.interventionId);
      invariant(a && a.status === "planning", "invalid_transition", "Intervention is not waiting for a plan");
      const t = taskById(instance, a.targetTaskId);
      invariant(typeof action.rationale === "string" && action.rationale.trim().length > 0 &&
        action.rationale.length <= 4000, "invalid_plan", "Planner rationale is required");
      checkInvestigators(instance, a.id, action.agents);
      a.agents = structuredClone(action.agents);
      a.planRationale = action.rationale.trim();
      if (t.status === "held") {
        invariant(t.lastQc && (a.afterQcRunId === "next" || a.afterQcRunId === t.lastQc.runId),
          "qc_mismatch", "Held QC run differs from intervention");
        a.status = "activated";
        installDiagnosis(instance, a);
        message = "Sol plan registered for " + a.id + "; diagnosis ready after QC barrier";
      } else {
        invariant(["ready", "running", "awaiting_qc"].includes(t.status),
          "invalid_transition", "Intervention target is no longer active");
        a.status = "armed";
        message = "Sol plan registered for " + a.id + "; awaiting QC " + a.afterQcRunId;
      }
      break;
    }
    case "cancel_amendment": {
      const a = instance.amendments.find(a => a.id === action.amendmentId);
      invariant(a && (a.status === "planning" || a.status === "armed"),
        "invalid_transition", "Only an unactivated intervention can be cancelled");
      const t = taskById(instance, a.targetTaskId);
      if (t.status === "held") t.status = normalPostQcStatus(instance, t);
      a.status = "cancelled";
      message = "Cancelled amendment " + a.id + "; restored " + t.spec.id + " -> " + t.status;
      break;
    }
    case "qc_finalized": {
      const t = taskById(instance, action.taskId);
      invariant(t.status === "awaiting_qc" && t.pendingWork, "invalid_transition", "Task is not awaiting QC");
      const evidence = t.pendingWork;
      invariant(evidence.headSha === action.headSha && evidence.criteriaRevision === action.criteriaRevision && evidence.attempt === action.attempt, "stale_qc", "QC result does not match current implementation evidence");
      invariant(validId(action.runId) && ["pass", "fail", "inconclusive"].includes(action.verdict), "invalid_qc", "Invalid QC result");
      const barrier = instance.amendments.find(a => a.targetTaskId === t.spec.id && (a.status === "planning" || a.status === "armed"));
      if (barrier) invariant(barrier.afterQcRunId === "next" || barrier.afterQcRunId === action.runId, "qc_mismatch", "Barrier targets a different QC run; no auto-transition permitted");
      t.qcRounds += 1;
      t.lastQc = { runId: action.runId, verdict: action.verdict, headSha: action.headSha, criteriaRevision: action.criteriaRevision, attempt: action.attempt };
      delete t.pendingWork;
      if (barrier) {
        t.status = "held";
        if (barrier.status === "armed") {
          barrier.status = "activated";
          installDiagnosis(instance, barrier);
        }
        message = `QC ${action.runId} finalized (${action.verdict}); barrier ${barrier.id} ${barrier.status === "planning" ? "waiting for Sol plan" : "activated"}`;
      } else {
        t.status = action.verdict === "pass" ? "passed" : t.qcRounds >= instance.definition.maxQcRounds ? "needs_human" : "ready";
        message = `QC ${action.runId} finalized (${action.verdict}); status=${t.status}`;
      }
      break;
    }
    case "complete": {
      const t = taskById(instance, action.taskId);
      invariant(t.status === "running" && t.spec.kind !== "implementation", "invalid_transition", "Only a running diagnosis/synthesis may complete");
      t.status = "done";
      message = `Completed ${t.spec.id}`;
      break;
    }
    case "resume_after_diagnosis": {
      const a = instance.amendments.find(a => a.id === action.amendmentId);
      invariant(a && a.status === "activated" && a.synthesisTaskId, "invalid_transition", "Diagnosis has not activated");
      const synth = taskById(instance, a.synthesisTaskId);
      invariant(synth.status === "done", "blocked", "Synthesis must complete before resuming work");
      const t = taskById(instance, a.targetTaskId);
      invariant(t.status === "held", "invalid_transition", "Target not held");
      if (action.decision === "accept_pass") invariant(t.lastQc?.verdict === "pass", "invalid_transition", "Cannot accept a failing QC");
      if (action.decision === "rework") invariant(t.qcRounds < instance.definition.maxQcRounds, "budget_exhausted", "QC budget exhausted; explicit budget amendment required");
      t.status = action.decision === "rework" ? "ready" : "passed";
      a.status = "completed";
      message = `Resolved ${a.id}; ${t.spec.id} -> ${t.status}`;
      break;
    }
    case "prepare_final_integration": {
      const id="mm-final-integration";
      invariant(!Object.hasOwn(instance.tasks,id),"finalization_exists",
        "Final integration Task already exists");
      invariant(instance.definition.tasks.length<512,"finalization_capacity",
        "Final integration needs a free Workflow Task slot");
      invariant(!instance.amendments.some(a=>
        a.status!=="cancelled"&&a.status!=="completed"),"finalization_held",
        "Resolve all human interventions before final integration");
      const original=Object.values(instance.tasks);
      invariant(original.every(t=>t.spec.kind==="implementation"?
        (["passed","integrated"].includes(t.status)&&
          t.lastQc?.verdict==="pass"):
        t.status==="done"),"finalization_blocked",
        "All original implementation Tasks need QC PASS, and other Tasks must finish");
      const sources=original.filter(t=>t.spec.kind==="implementation");
      invariant(sources.length>0,"finalization_blocked",
        "Final integration needs QC-passed source commits");
      const spec:TaskSpec={
        id,title:"Integrate all approved code and run final QC",
        kind:"implementation",role:"implementer",
        systemPurpose:"final-integration",
        description:"Combine every original Task's QC-approved Git commit in "+
          "a separate final integration Worktree. Resolve any Git merge conflicts, "+
          "commit the full integration result, and preserve all source commits.",
        acceptanceCriteria:[
          "Final Git HEAD contains every original Task's sealed QC-approved commit as an ancestor",
          "Final Git Worktree is clean and configured integration tests pass",
          "Independent final QC confirms the complete combined implementation",
        ],
        dependsOn:original.map(t=>({taskId:t.spec.id,
          gate:t.spec.kind==="implementation"?"qc_passed":"completed"})),
      };
      instance.definition.tasks.push(spec);
      instance.tasks[id]={spec,status:"blocked",attempts:0,qcRounds:0};
      validateDefinition(instance.definition);
      message="Prepared final-integration Task for "+sources.length+
        " QC-approved source commit(s)";
      break;
    }
    case "final_merge_confirmed": {
      const final=taskById(instance,action.taskId);
      invariant(final.spec.systemPurpose==="final-integration"&&
        final.status==="passed"&&final.lastQc?.verdict==="pass"&&
        final.lastQc.headSha===action.headSha,"final_not_approved",
        "Only exact QC-passed final integration result may complete the Workflow");
      invariant(/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/pull\/[1-9][0-9]{0,8}$/.test(action.prUrl),
        "final_merge_proof","Final GitHub Pull Request URL required");
      invariant(instance.amendments.every(a=>
        a.status==="cancelled"||a.status==="completed"),
        "finalization_held","Pending human intervention prevents finalization");
      const sources=Object.values(instance.tasks).filter(t=>
        t.spec.systemPurpose!=="final-integration");
      invariant(sources.every(t=>t.spec.kind==="implementation"?
        (["passed","integrated"].includes(t.status)&&t.lastQc?.verdict==="pass"):
        t.status==="done"),"final_source_changed",
        "Final merge cannot overwrite unfinished or unverified original Tasks");
      for(const task of sources){
        if(task.spec.kind==="implementation")task.status="integrated";
      }
      final.status="integrated";
      message="GitHub confirmed merged "+action.prUrl+" at final QC Git SHA "+
        action.headSha.slice(0,12)+"; all Task integration gates completed";
      break;
    }
    case "integrate": {
      const t = taskById(instance, action.taskId);
      invariant(t.status === "passed", "invalid_transition", "Only QC-passed tasks can integrate");
      t.status = "integrated";
      message = `Integrated ${t.spec.id}`;
      break;
    }
    default: {
      const never: never = action;
      throw new WorkflowError("unknown_action", `Unsupported action: ${String(never)}`);
    }
  }
  instance.revision += 1;
  instance.updatedAt = at;
  instance.events.push({ revision: instance.revision, type: action.type, message, at });
  if (instance.events.length > 200) instance.events.splice(0, instance.events.length - 200);
  releaseReady(instance);
  return instance;
}

/** Parse untrusted JSON at the workflow admission boundary. */
export function parseDefinition(input: unknown): WorkflowDefinition {
  invariant(input !== null && typeof input === "object" && !Array.isArray(input), "invalid_definition", "Definition must be an object");
  const raw = input as Record<string, unknown>;
  invariant(Array.isArray(raw.tasks), "invalid_tasks", "Definition tasks must be an array");
  invariant(raw.maxParallelByRole !== null && typeof raw.maxParallelByRole === "object", "invalid_parallelism", "Parallelism limits required");
  const tasks: TaskSpec[] = raw.tasks.map((item: unknown) => {
    invariant(item !== null && typeof item === "object" && !Array.isArray(item), "invalid_task", "Every task must be an object");
    const t = item as Record<string, unknown>;
    invariant(Array.isArray(t.dependsOn), "invalid_dependencies", "Task dependsOn must be an array");
    const deps: Dependency[] = t.dependsOn.map((d: unknown) => {
      invariant(d !== null && typeof d === "object" && !Array.isArray(d), "invalid_dependency", "Dependency must be an object");
      const dep = d as Record<string, unknown>;
      return { taskId: dep.taskId as string, gate: dep.gate as Gate };
    });
    return { id: t.id as string, title: t.title as string, kind: t.kind as TaskKind, role: t.role as Role, dependsOn: deps,
      ...(t.model === undefined ? {} : { model: t.model as string }),
      ...(t.description===undefined?{}:{description:t.description as string}),
      ...(t.acceptanceCriteria===undefined?{}:{acceptanceCriteria:t.acceptanceCriteria as string[]}) };
  });
  const def = { id: raw.id as string, title: raw.title as string, maxQcRounds: raw.maxQcRounds as number,
    maxParallelByRole: raw.maxParallelByRole as Record<Role, number>, tasks,
    ...(raw.permissions===undefined?{}:{permissions:raw.permissions as WorkflowPermissions}) };
  validateDefinition(def);
  return def;
}
