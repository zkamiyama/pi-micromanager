import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, newWorkflow, WorkflowError, parseDefinition } from '../dist/core/workflow.js';

const definition = () => ({
  id: 'auth-migration', title: 'Auth migration', maxQcRounds: 5,
  maxParallelByRole: { planner: 1, implementer: 2, reviewer: 2, architect: 2 },
  tasks: [
    { id: 'schema', title: 'Schema', kind: 'implementation', role: 'implementer', dependsOn: [] },
    { id: 'api', title: 'API', kind: 'implementation', role: 'implementer', dependsOn: [{ taskId: 'schema', gate: 'qc_passed' }] },
    { id: 'ui', title: 'UI', kind: 'implementation', role: 'implementer', dependsOn: [{ taskId: 'schema', gate: 'qc_passed' }] },
    { id: 'integration', title: 'Integration', kind: 'implementation', role: 'implementer', dependsOn: [
      { taskId: 'api', gate: 'integrated' }, { taskId: 'ui', gate: 'integrated' }] },
  ],
});
const now = '2026-10-09T00:00:00.000Z';
const advance = (state, action) => applyAction(state, action, now);
const qc = (taskId, attempt, verdict, headSha = '1234abcd') => ({ type: 'qc_finalized', taskId, runId: `qc-${taskId}-${attempt}`, headSha, criteriaRevision: 0, attempt, verdict });
const finish = taskId => ({ type: 'implementation_finished', taskId, headSha: '1234abcd', criteriaRevision: 0, testsPassed: true });
function completeInitial(state, taskId = 'schema') {
  state = advance(state, { type: 'start', taskId });
  state = advance(state, finish(taskId));
  return advance(state, qc(taskId, state.tasks[taskId].attempts, 'pass'));
}
function expectCode(fn, code) {
  assert.throws(fn, err => err instanceof WorkflowError && err.code === code);
}

test('strict DAG rejects cycles, dangling references and invalid gates', () => {
  const a = definition(); a.tasks[0].dependsOn = [{ taskId: 'integration', gate: 'completed' }];
  expectCode(() => newWorkflow(a, now), 'cycle');
  const b = definition(); b.tasks[0].dependsOn = [{ taskId: 'missing', gate: 'completed' }];
  expectCode(() => newWorkflow(b, now), 'unknown_dependency');
  const c = definition(); c.tasks[0].dependsOn = [{ taskId: 'api', gate: 'almost' }];
  expectCode(() => parseDefinition(c), 'invalid_gate');
});

test('DAG enforces QC and integration gates, not an agent claim of completion', () => {
  let w = newWorkflow(definition(), now);
  assert.equal(w.tasks.api.status, 'blocked');
  expectCode(() => advance(w, { type: 'start', taskId: 'api' }), 'not_ready');
  w = advance(w, { type: 'start', taskId: 'schema' });
  w = advance(w, finish('schema'));
  assert.equal(w.tasks.api.status, 'blocked');
  w = advance(w, qc('schema', 1, 'pass'));
  assert.equal(w.tasks.api.status, 'ready');
  w = completeInitial(w, 'api');
  assert.equal(w.tasks.integration.status, 'blocked');
  w = advance(w, { type: 'integrate', taskId: 'api' });
  assert.equal(w.tasks.integration.status, 'blocked');
  w = completeInitial(w, 'ui');
  w = advance(w, { type: 'integrate', taskId: 'ui' });
  assert.equal(w.tasks.integration.status, 'ready');
});

test('QC failure consumes budget, requires fresh attempt and evidence', () => {
  let w = newWorkflow(definition(), now);
  for (let round = 1; round <= 5; round++) {
    w = advance(w, { type: 'start', taskId: 'schema' });
    w = advance(w, finish('schema'));
    expectCode(() => advance(w, qc('schema', round, 'pass', 'changedhead')), 'stale_qc');
    w = advance(w, qc('schema', round, 'fail'));
  }
  assert.equal(w.tasks.schema.status, 'needs_human');
  assert.equal(w.tasks.schema.qcRounds, 5);
  expectCode(() => advance(w, { type: 'start', taskId: 'schema' }), 'not_ready');
});

test('arm a mid-run QC barrier; launch diagnoses in parallel; require synthesis before resuming', () => {
  let w = newWorkflow(definition(), now);
  w = advance(w, { type: 'start', taskId: 'schema' });
  w = advance(w, finish('schema'));
  w = advance(w, { type: 'arm_diagnosis', targetTaskId: 'schema', amendmentId: 'investigate', afterQcRunId: 'next', agents: [
    { id: 'astra', title: 'Architecture', role: 'architect', model: 'astra-max' },
    { id: 'opus', title: 'Alternative design', role: 'architect', model: 'claude-opus' },
  ] });
  assert.equal(w.tasks.schema.status, 'awaiting_qc');
  w = advance(w, qc('schema', 1, 'fail'));
  assert.equal(w.tasks.schema.status, 'held');
  assert.equal(w.tasks.api.status, 'blocked');
  assert.equal(w.tasks['diag-investigate-astra'].status, 'ready');
  assert.equal(w.tasks['diag-investigate-opus'].status, 'ready');
  assert.equal(w.tasks['synthesis-investigate'].status, 'blocked');
  expectCode(() => advance(w, { type: 'resume_after_diagnosis', amendmentId: 'investigate', decision: 'rework' }), 'blocked');
  w = advance(w, { type: 'start', taskId: 'diag-investigate-astra' });
  w = advance(w, { type: 'start', taskId: 'diag-investigate-opus' });
  w = advance(w, { type: 'complete', taskId: 'diag-investigate-astra' });
  assert.equal(w.tasks['synthesis-investigate'].status, 'blocked');
  w = advance(w, { type: 'complete', taskId: 'diag-investigate-opus' });
  assert.equal(w.tasks['synthesis-investigate'].status, 'ready');
  w = advance(w, { type: 'start', taskId: 'synthesis-investigate' });
  w = advance(w, { type: 'complete', taskId: 'synthesis-investigate' });
  w = advance(w, { type: 'resume_after_diagnosis', amendmentId: 'investigate', decision: 'rework' });
  assert.equal(w.tasks.schema.status, 'ready');
  assert.equal(w.tasks.schema.qcRounds, 1);
  assert.equal(w.amendments[0].status, 'completed');
  assert.equal(w.tasks.api.status, 'blocked');
});

test('an armed intervention stops normal QC PASS release until the synthesis is accepted', () => {
  let w = newWorkflow(definition(), now);
  w = advance(w, { type: 'start', taskId: 'schema' });
  w = advance(w, finish('schema'));
  w = advance(w, { type: 'arm_diagnosis', targetTaskId: 'schema', amendmentId: 'reviewextra', afterQcRunId: 'next', agents: [
    { id: 'astra', title: 'Root cause', role: 'architect', model: 'astra-max' },
  ] });
  w = advance(w, qc('schema', 1, 'pass'));
  assert.equal(w.tasks.schema.status, 'held');
  assert.equal(w.tasks.api.status, 'blocked');
  expectCode(() => advance(w, { type: 'resume_after_diagnosis', amendmentId: 'reviewextra', decision: 'accept_pass' }), 'blocked');
  w = advance(w, { type: 'start', taskId: 'diag-reviewextra-astra' });
  w = advance(w, { type: 'complete', taskId: 'diag-reviewextra-astra' });
  w = advance(w, { type: 'start', taskId: 'synthesis-reviewextra' });
  w = advance(w, { type: 'complete', taskId: 'synthesis-reviewextra' });
  w = advance(w, { type: 'resume_after_diagnosis', amendmentId: 'reviewextra', decision: 'accept_pass' });
  assert.equal(w.tasks.api.status, 'ready');
});

test('capacity is enforced inside the state machine', () => {
  const def = definition();
  def.maxParallelByRole.implementer = 1;
  def.tasks[1].dependsOn = [];
  let w = newWorkflow(def, now);
  w = advance(w, { type: 'start', taskId: 'schema' });
  expectCode(() => advance(w, { type: 'start', taskId: 'api' }), 'capacity');
});

test('cancelling an unactivated amendment resumes the original QC loop', () => {
  let w = newWorkflow(definition(), now);
  w = advance(w, { type: 'start', taskId: 'schema' });
  w = advance(w, finish('schema'));
  w = advance(w, { type: 'arm_diagnosis', targetTaskId: 'schema', amendmentId: 'investigate', afterQcRunId: 'next', agents: [
    { id: 'a', title: 'Audit', role: 'architect', model: 'astra' },
  ] });
  w = advance(w, { type: 'cancel_amendment', amendmentId: 'investigate' });
  w = advance(w, qc('schema', 1, 'fail'));
  assert.equal(w.tasks.schema.status, 'ready');
  assert.equal(w.tasks['diag-investigate-a'], undefined);
});
