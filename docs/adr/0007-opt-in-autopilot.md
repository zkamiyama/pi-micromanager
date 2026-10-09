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
with explicit Task dependencies, bounded descriptions, and testable per-Task
`acceptanceCriteria` that are passed unchanged to implementers and QC reviewers.
Alternatively a user goal may be submitted to a fresh read-only Sol Pi Session;
its model-facing `mm_workflow_proposal` tool creates a bounded DAG proposal
and checks its acyclicity and required acceptance criteria before the typed
result is emitted. Acceptance is a separate authenticated action calling
`WorkflowStore.create`; it is idempotent and linked to persisted evidence.
No prompt alone can enable Autopilot or create a modifying Worktree. After registering exact existing workspace
IDs and role model profiles, the operator explicitly selects **Start Autopilot**.
The scheduler does nothing to a workflow that has not opted in. **Pause
admission** prevents new Task/Run dispatch; it does not abort running Pi turns.

## Preflight and worktree authority

- Every implementation Task has a **different already linked Git worktree**,
  validated by PI WEB's public workspace resolver and provider metadata.
- Each launch re-resolves the actual workspace, rejects the main tree and
  dirty worktrees, and verifies Git's own repository root is the resolved
  worktree path. Git calls clear inherited `GIT_*` routing variables.
- A dependent implementation Run must prove, with `git merge-base --is-ancestor`,
  that its separate worktree contains every relevant upstream QC-passed Git SHA.
  A ready DAG node whose worktree lacks those commits is paused for explicit
  integration rather than silently implementing against stale source.
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
It replays the structured report separately. For a Run that has already
settled, an isolated read-only PI WEB session-events connection can inspect
the **same native Pi Session** and replay its one-shot structured report, with
no new model turn. This closes the gap where settlement reached the server
but the report event did not. A mismatched runId, missing report or unsettled
turn proof cannot satisfy the finalization gate. A missing Session, unknown
delivery, conflicting report or ambiguous idle state **pauses** rather than
restarting an attempt. Final interrupted/settled events are sticky, so
late buffered text/tools cannot reclassify an aborted QC as successful.
On server plugin shutdown, the executor refuses new ticks, drains
in-flight verification before SQLite disposal, and gates native Session
creation/configuration/prompt delivery on the host lifetime signal. Workflow transitions are idempotent under durable
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
it does not create/register or list new Workspace IDs. ADR-0008 now adds
an **explicit reviewed** Git Worktree provisioning operation under the
plugin's private data directory, with durable reservation before the
non-idempotent Git add and verification afterward. The operator still
selects the newly discovered Git Worktree in PI WEB and records its genuine
opaque Workspace ID; fully automatic Workspace registration and safe
worktree/session GC remain blocked pending upstream public capabilities.

ADR-0008 also adds separate **read-only integration preview** and
**human-confirmed Git ancestry proof** against sealed QC evidence. Only
the explicit confirmation changes the DAG to `integrated`; this is not
an automatic Git merge, cherry-pick or push.

Autopilot executes **validated, reviewed DAGs**. The Sol goal-proposal
workflow can turn a natural-language objective into an initial, read-only,
typed `mm_workflow_proposal` report (up to 16 implementation Tasks). That
proposal is persisted under a separate one-shot Pi Run and cannot start
implementation. The human explicitly approves it to create the authoritative
DAG; Worktrees, models, test commands and Autopilot start remain separate
operator decisions. Sol intervention planning **is also** wired for existing Tasks. The backend interval is not a
cluster-wide job coordinator: actual provider/auth/worktree restart E2E tests,
multiple-server leader election, user-attributed audit trails, fully attested
test logs/screenshots, Git merge policy, and autonomous ADR PR creation all
remain out of scope.

Do not label simulated workflow transitions as real execution or claim
production-ready unattended operation until the real-provider E2E and
worktree-lifecycle milestones are verified.
