# ADR-0005: Task-scoped human interventions and Sol planner boundaries

- Status: Accepted; deterministic foundation and PI WEB simulation implemented
- Date: 2026-10-09
- Extends: [ADR-0002](0002-deterministic-dag-and-live-interventions.md)

## Problem

A swarm can run many concurrent Luna implementers and Sol QC reviewers. Requiring a human to explain
which Luna, QC run, and worktree they mean **to the orchestrator** before changing a task is cumbersome
and error-prone. Yet letting an agent rewrite the active DAG file is nondeterministic and can race QC
finalization. Human control must remain flat, without eliminating Sol's responsibility for planning.

## Decision

**Tasks are the default target of human intervention. Agents may be steered directly, but humans
never have to manually route task-level instructions through the orchestrator.**

### Target selection and UI

- Task Lens opens from a Cockpit card, DAG node, or Kanban card. The UI supplies scoped
  `(machine, project, workspace, workflowId, taskId)` rather than making the human type IDs.
- Future live bindings shall resolve `Task -> Attempt -> Pi Session -> QC Run`. A name such as
  "Luna #2" is **not** an identity; reassignment must not redirect a previous instruction.
- With no selected task, disambiguate explicit candidates rather than guessing.
- Structural interventions and direct agent interventions are **different commands** with
  distinct affordances and independently testable outcomes.

### Structural intervention: Sol proposes, engine commits

1. The selected Task Lens submits `request_intervention` with a unique intervention/command ID,
   target Task, next or exact QC Run, and the human's instruction.
2. The Workflow Store commits the `planning` amendment **before** any Sol/model call. This
   reserves the next QC transition, even if Sol is busy or disconnected.
3. Sol receives only a bounded snapshot of the selected Task (DAG neighborhood, active attempt,
   frozen evidence references, relevant QC history), not every agent's transcript.
4. Sol proposes `plan_intervention` with typed independent diagnostic agents and a rationale.
   The deterministic engine checks plan schema, IDs, DAG acyclicity, revision and capacity.
5. If planning finishes before QC, the amendment becomes `armed`. If QC already finalized,
   the Task remains `held` and the diagnostics are inserted immediately after plan admission.
   Other independent Tasks continue.
6. QC finalization and normal next-step admission must be serialized by the same workflow
   transaction. `held` blocks downstream Task dependency gates, with an intentional exception
   for diagnostic nodes owned by that amendment.
7. The independent diagnoses join at Sol synthesis; an explicit resume decision releases the
   Task. Existing QC budget and history are not reset.

The engine, not Sol, owns the authoritative Workflow Instance. Sol must not overwrite the
running template or directly edit DB rows. A human can cancel an unactivated amendment.
After QC finalization, cancelling a still-unplanned amendment restores the ordinary
QC-derived state and preserves the QC evidence and round count. An already-activated
diagnosis requires a separate explicit resolution workflow.

### Direct intervention: no Sol relay

"Tell the Luna implementing this Task..." and "QC, check this case..." should route
to the *bound* Pi Session via a capability-aware native steer/follow-up adapter, without Sol.
The action and task binding are still journaled so Sol can later observe what changed.
A changed acceptance criterion requires a criteria revision and may invalidate a QC verdict.

An actual native steer requires a live, authenticated Pi Session binding. **The v0.1 Task Lens
shows these controls disabled rather than claiming to deliver messages**. The currently shipped
Task Lens also labels the Sol plan action **simulation**. The Sol planner process, model
handshake, and live session bindings remain follow-up work.

## Failure modes and invariants

- Human requests are admitted before the Sol planner round trip. Never wait for Sol to set
  the QC barrier; fail closed when QC completes while `planning`.
- A new structural intervention cannot replace a `planning`, `armed` or `activated`
  intervention on the same Task. Concurrent independent Tasks are not blocked.
- An exact QC Run target cannot be silently redirected to another run.
- Workflow Store compares expected revision and persists idempotent command receipts.
- Sol's proposed model identifiers are validation inputs, not implicit permissions.
  The actual dispatcher later confirms login/model/effort and read-only diagnosis workspace.
- A `qc_finalized` dependency must **not** bypass a human hold; only its own
  versioned diagnosis Task can proceed while the parent is held.
- Do not treat user-origin text submitted from a browser as cryptographic proof of author.
  The live product must use PI WEB host authorization and immutable actor attribution.
- Until live Pi integration ships, the UI remains a truthful workflow simulator.

## Implemented slice

- Pure state-machine actions `request_intervention`, `plan_intervention`,
  and extension of `cancel_amendment`.
- Durable `planning` barrier using the existing SQLite revision-CAS/idempotency store.
- QC finalization holds the target Task even if Sol has not replied.
- Typed diagnosis plan may arrive before or after QC.
- Cross-task separation and hold-respecting dependency gates.
- PI WEB Task Lens from Cockpit, DAG and Kanban. Direct-agent tabs visibly disabled.
- Tests for QC-before-plan, plan-before-QC, unaffected parallel Tasks, hold/graph safety,
  cancellation and SQLite restart/replayed commands.

## Follow-up deliverables

- Live `(Task, Attempt, Session, QC Run)` registry and an authenticated Pi-session adapter.
- Start/read/steer/interrupt/recover for individual workers and QC Sessions.
- Actual Sol planning bridge with result receipts, retries and human approval boundaries.
- Session-owner fencing for task reassignment and QC Run SHA/criteria revision validity.
- Human Intervention timeline + evidence-linked Live Journal + eventual ADR promotion.
