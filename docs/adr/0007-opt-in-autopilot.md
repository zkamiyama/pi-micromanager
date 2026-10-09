# ADR-0007: Opt-in durable Autopilot and fail-closed Pi execution

- Status: Accepted implementation; authenticated real-provider E2E remains pending
- Date: 2026-10-09
- Related: ADR-0001, ADR-0002, ADR-0005, ADR-0006

## Decision

Autopilot is **not** a second LLM or an unrestricted shell daemon. The
authoritative Task DAG and QC gates remain in `src/core/workflow.ts` and
workspace-scoped `WorkflowStore`. An opt-in server-side runner polls persisted
workflows and dispatches admitted Runs via PI WEB's documented `pi-sessions`,
`pi-session-events` and `workspaces` capabilities. A fresh Pi Session is
created for **each** implementation attempt, QC, diagnosis, synthesis, and
Sol intervention planning Run. Never recycle a previous QC or Luna context.

The PI WEB Micromanager tab can validate and save a Workflow Definition JSON
with explicit Task dependencies. After registering exact existing workspace
IDs and role model profiles, the operator explicitly selects **Start Autopilot**.
The scheduler does nothing to a workflow that has not opted in. **Pause
admission** prevents new Task/Run dispatch; it does not abort running Pi turns.

## Preflight and worktree authority

- Every implementation Task has a **different already linked Git worktree**,
  validated by PI WEB's public workspace resolver and provider metadata.
- Each launch re-resolves the actual workspace, rejects the main tree and
  dirty worktrees, and verifies Git's own repository root is the resolved
  worktree path. Git calls clear inherited `GIT_*` routing variables.
- An immutable Run reservation precedes `pi-sessions.create`. A creation
  timeout must **not** be retried as another Session.
- Worktree writer and QC/diagnosis reader reservations cannot overlap.
  QC and diagnosis are granted read-only Pi tools and have explicit source
  commit verification before, and again after, review.
- The exact requested provider, model and effort must be acknowledged **before**
  the initial prompt. No silent fallback to an available substitute.
- Configured test commands are argv-based host-executed processes (no shell
  interpolation), bounded by the PI WEB host and a per-workflow time limit.

## Automatic transition admission

For an implementation attempt:

1. Engine atomically claims the next ready Task and admits a fresh Run.
2. Pi implements and commits in its isolated worktree.
3. On confirmed settlement, the host verifies clean Git state, records the
   actual SHA and executes the configured tests.
4. Passing implementation tests create an `awaiting_qc` gate; failures re-enter
   `ready` under the configured attempt budget with bounded prior evidence.
5. A **fresh** read-only QC Pi Run calls `mm_qc_report` with a typed verdict.
   The host checks that its source SHA did not change and reruns the tests.
   Host test failure overrides a model's PASS. A missing/contradictory QC
   report pauses Autopilot, never fabricates a PASS.
6. The deterministic engine finalizes the matching
   `(runId, headSha, criteriaRevision, attempt)` and honors every armed
   human barrier before admitting a new rework attempt.
7. `integrated` remains an explicit Git/repository authority decision:
   a QC PASS alone **never** merges, pushes, or deletes worktrees.

A human `request_intervention` reserves the post-QC hold immediately.
A fresh read-only Sol planning Run proposes an independent investigator list
via `mm_plan_intervention`. The proposal is strictly validated (including
model allow-list) before it is applied. Once the held QC closes, read-only
diagnosis Runs receive the frozen commit and evidence, and synthesis receives
the independent summaries. The engine does **not** release the held Task
without `resume_after_diagnosis` from the human.

## Durable results and recovery

`AutopilotLedger` persists scoped opt-in configuration, immutable per-Run
structured model reports and hashed finite evidence receipts in SQLite.
These are evidence *references*, not a complete image/artifact store.

The Pi companion writes a bound job envelope, structured report, and each
turn-start/settlement marker as Pi Session custom entries **before** notifying
the host. After a server restart, the host reconnects to the *existing*
Session and requests a read-only `inspect` receipt; it may restore a running
or settled Run **only** when idle state, runId, and persisted turn marker agree.
It replays the structured report separately. A missing Session, unknown
delivery, conflicting report or ambiguous idle state **pauses** rather than
restarting an attempt. Workflow transitions are idempotent under durable
command IDs; a Run can be sealed after crash recovery only if its specific
workflow transition and evidence were committed.

## Operator boundaries

- Configuration changes require Autopilot to be paused, with no unsealed
  automatic Run. Simulation commands cannot overwrite real Run history.
- Direct user steering/follow-ups target the current bound Session; users
  cannot hijack an Autopilot-configured Session's initial prompt or Seal it
  before the evidence-linked Workflow transition.
- No automatic merge/push, destructive workspace cleanup or provider auth
  copying. Public text/tool projections only, never hidden model reasoning.
- No unbounded replay of raw Pi JSONL transcripts.

## Explicit limitations

The public PI WEB `workspaces` v1 capability resolves **existing** workspaces;
it does not create/register fresh linked worktrees. Automatic provisioner/GC
therefore remains blocked pending a public host capability or a separately
supervised provisioner with safe ownership and discovery.

Autopilot executes **validated, imported DAGs**. Initial natural-language
goal-to-DAG proposal/approval is a separate milestone; Sol intervention
planning **is** wired for existing Tasks. The backend interval is not a
cluster-wide job coordinator: actual provider/auth/worktree restart E2E tests,
multiple-server leader election, user-attributed audit trails, fully attested
test logs/screenshots, Git merge policy, and autonomous ADR PR creation all
remain out of scope.

Do not label simulated workflow transitions as real execution or claim
production-ready unattended operation until the real-provider E2E and
worktree-lifecycle milestones are verified.
