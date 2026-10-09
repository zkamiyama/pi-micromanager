# ADR-0015: One-command natural-language goal to checked execution

- Status: Implemented experimentally; local mocked host + disposable Git CI
- Date: 2026-10-10
- Extends: ADR-0007, ADR-0011, ADR-0013, ADR-0014
- Scope: PI WEB browser plugin + server plugin orchestration, no Pi/PI WEB private APIs

## Problem

The existing Sol planner can already emit a validated typed DAG; the
existing Autopilot can already admit real Pi implementation/QC sessions,
create Worktrees, publish reviewed commits and request a GitHub merge.
But requiring the user to manually fetch the proposal, approve/save it,
copy configuration and press Start for every goal hides the core workflow.

We need one **explicit** action after one-time project setup. This is
not a promise of automatic, unconditional changes from arbitrary chat:
clicking **Plan & run** is the operator's specific admission decision.
The read-only manual **Ask Sol** path remains available for preview-first
workflows.

## One-time project setup

A project Workspace stores a reusable bounded profile in private
`quick-launch.sqlite`. The profile is validated by the existing
`parseAutopilotConfig` and `validatePermissions` contracts. It requires:

- `managedWorktrees: true` and empty `workspaces` (never silently
  reuse a prior code/QC checkout)
- separate `finalization.workspaceId: "auto"` and an explicit publication
  remote and base branch (never infer where to push)
- four exact Pi provider/model profiles, bounded executable host test
  argv and finite attempt budget
- **explicit** Workflow `permissions` (not model-authored permissions)

The default UI profile uses `github.pr.merge: "ask"` and
`deploy.production: "deny"`. The user may deliberately choose
`github.pr.merge: "allow"` once for unattended merge.
No Git or Pi session starts when merely saving settings.

## Durable one-command state machine

Each click generates a browser UUID, and the server **reserves it in SQLite
before any Pi Session**. A duplicate UUID and same goal returns the exact
existing request; reusing the UUID with a different goal is rejected. A
project Workspace admits only one active one-command run at a time.

1. `reserved`: snapshot goal and exact **current project profile**,
   derive stable unique `draft-*` / `goal-*` / `quick-*` IDs.
2. `planning`: launch a fresh native Pi planner in the selected PI WEB
   Workspace using the exact configured model. One session only; a
   reserved/uncertain session can never be replayed blindly.
3. `starting`: require native settled structured
   `mm_workflow_proposal`, `parseRunReport` DAG contract,
   noninterrupted Session and immutable host evidence. Copy the validated
   definition into the authoritative Workflow Store **with a new
   request-derived Workflow ID** and **the operator's snapshotted permission
   policy**. Never trust the model's suggested permission decisions.
   Save the snapshotted Autopilot configuration with
   `managedWorktrees: true`; call the existing Start path once.
4. `running`: the existing Autopilot launches Task Pi Sessions, verifies
   Git SHA/tests, seals independent QC, integrates through the final
   worktree and GitHub policy. The quick profile is not reloaded while
   this Workflow runs.
5. `finished`: only after its Workflow is fully integrated/completed.
   Any blocked, uncertain, failed or manually paused stage becomes
   `needs_attention` and **does not silently retry**.

The server drives transitions on its scheduler, not browser availability.
On restart it reads persisted request state, checks the already-reserved
Pi Session and reuses stored Workflow/evidence/Autopilot receipts.
The model's read-only proposal is never accepted after a user cancels
auto-start. Once code admission begins, operator intervention uses the
existing Autopilot Pause mechanism; already-running Pi Sessions may
continue and host publisher permissions remain authoritative.

## UX

The default PI WEB Micromanager panel leads with one goal text area and
**Plan & run**. Beside it: verified publish destination, effective
GitHub merge permission, and the current status. A collapsed first-time project setup offers a small, accessible form
for provider/model, test argv, Git remote/base and merge policy.
An opt-in Advanced toggle preserves full JSON and distinct role models
without requiring JSON editing for the usual case.
The progress card shows plan / prepare / execute / complete, lets users
cancel *before* code starts, open the actual DAG when ready, and refresh
the durable status. Polling only reads state; it cannot trigger
additional side effects. The older preview-first manual Sol UI stays
available under an expandable section.

## Security and reliability

- Goal text and preset are stored in plugin-private SQLite, not exposed
  as credentials. Pi authentication remains in the installed Pi profile.
- The operator opts in to code changes once per goal via **Plan & run**.
  No LLM-created DAG may add new actions or authorize merge rights.
- The existing Workflow `allow/ask/deny`, GitHub required checks/reviews,
  exact sealed QC SHA, Worktree isolation and no-force rules still apply.
- A UUID receipt covers uncertain browser replies and double clicks.
  Server Pi Run reservations and WorkflowStore idempotency cover lost
  host replies/crashes. Any unknown state stops for operator inspection.
- Concurrent control-plane instances against the same Git repository are
  still unsupported; one-command scope does not provide a distributed
  repo-wide lock.
- A real authenticated Pi/PI WEB/browser/GitHub-host E2E is still
  necessary to validate the installed environment. Mock CI is not
  production certification.

## Verification

- `tests/quick-launch.test.mjs`: profile validation, frozen policy,
  UUID conflict/idempotency, cancellation and SQLite restart.
- `tests/autopilot-server.test.mjs`: native mocked Pi goal planning
  → DAG → managed Worktrees → implementation/QC → final QC →
  GitHub-confirmed merge, refusal of unreported plans, cancellation,
  and recovery of the **same** planner Session after restart.

See [one-command guide](../ONE_COMMAND.md) and
[PI WEB quickstart](../QUICKSTART.md).
