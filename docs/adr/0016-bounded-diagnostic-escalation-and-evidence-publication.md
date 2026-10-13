# ADR-0016: Bounded QC escalation, tracked screenshot collection and reviewed ADR Draft PR

- Date: 2026-10-13
- Status: Implemented experimentally; authenticated Pi/PI WEB and GitHub E2E pending
- Extends: ADR-0007, ADR-0009, ADR-0010, ADR-0011, ADR-0015
- Addresses slices of Issues #4 and #5; does **not** close their complete acceptance scope

## Bounded QC failure escalation

By default no diagnostic escalation happens. To opt in, save this alongside
the existing per-Workflow Autopilot configuration:

```json
"diagnosticEscalation": {"afterFailures": 2, "maxPerTask": 1}
```

Both values are strict integers: `afterFailures` must fit the configured
implementation attempt budget, and `maxPerTask` is 1..3. Under this explicit
configuration, the host **verifies the sealed QC snapshot** (model verdict,
host test result, exact SHA, revision and attempt). When an original
implementation's QC **fails**, it reaches the configured round threshold,
and no human or other active intervention exists for that Task, the host:

1. Derives a deterministic `auto-diag-*` amendment from exact scoped
   Workflow, Task and QC Run IDs.
2. Atomically persists `request_intervention` with an exact failed QC
   Run ID **before** the authoritative `qc_finalized` transition.
   Crash/retry replays neither the barrier nor the Run; durable receipts
   and revision checks reconcile it.
3. Finalizes QC as `held`, not `ready`; all dependent Tasks remain blocked.
4. Starts the existing read-only Sol proposal and independently configured
   reviewer/architect diagnoses. They share the same capacity limits as QC
   and planner/synthesis sessions (ADR-0015's adversarial suite).
5. Holds the Task after synthesis for **explicit human** `rework` or
   `accept_pass`. A failed QC cannot be promoted by `accept_pass`.

A real human-requested QC barrier always wins. No escalation runs for the
synthetic final integration Task, no new model provider is accepted, and no
CI/merge authorization is granted by diagnostics. If planning, Run identity,
Git provenance or a report is uncertain, Autopilot pauses safely. No
unbounded auto-retry or automatic human-approval simulation is added.

## Opt-in collection of committed QC images

`captureQcScreenshots: true` optionally schedules an import immediately
after the host seals a valid QC Run. This **does not take screenshots** from
a remote browser. It uses PI WEB's verified linked Worktree, exact clean
QC SHA, then `git ls-tree -r --name-only <SHA> -- screenshots/` to discover
up to eight canonical `screenshots/*.png/.jpg/.jpeg` files per Run.
Each is independently checked using the normal private screenshot capture
path: Git blob identity, file SHA, non-symlink, size/dimensions, and
object-store quotas. Errors are logged and **cannot change a QC verdict**.

The Journal displays only artifact metadata until an operator explicitly
requests the image; image rendering is lazy. The stored bytes remain
private and are never embedded in model context or event fan-out. This
is not automatic visual browser testing or screen recording.

## Private orphan cleanup (confirmed, conservative)

The operator can preview orphan screenshot blob cleanup in Journal.
Only a completed, inactive Workflow qualifies. A plugin-owned file is
eligible when it has a valid content-addressed filename, is not referenced
by `screenshot_evidence`, and is more than **24 hours old**. A preview is
persisted with a fingerprint of the exact blob manifest and expires after
ten minutes. Confirmation re-checks Workflow/Run state and every digest,
reserves the operation, and unlinks **only** the reviewed orphan objects.
A crash after reservation requires manual inspection; no blind retry.
It never deletes referenced QC evidence, staged ADRs, Pi JSONL,
host sessions, Git branches or Worktrees.

The implementation is **not** comprehensive hot/warm/permanent retention.
Referenced evidence remains pinned indefinitely. Native PI WEB Pi Session
archival and Worktree GC are intentionally untouched until the host
publishes lifecycle-safe APIs.

## Editable ADR candidates from verified human decisions

The Journal may suggest ADR fields **only** when a QC intervention has a
completed human-authorized resolution, an immutable last QC record and a
source-verified, fully resolved Workflow. It derives bounded Context,
Alternatives, Decision placeholder and Consequences from the recorded
human instruction, Sol's labeled *proposal* and the exact QC receipt.
It never pretends that model text is an accepted architecture decision.
The operator must inspect and edit the suggested fields before
Preview/Stage. A routine Task completion without completed human review
does not produce a suggested ADR.

## Explicit GitHub ADR Draft PR publication

Once a human previews a source-attributed ADR, reviews every section,
and confirms Stage in a separate clean, non-main linked Git Worktree,
the Journal offers **Publish reviewed ADR as GitHub Draft PR**. This
requires an explicit saved GitHub `publication.remote/baseBranch`,
a Git identity and `gh` authentication in the PI WEB daemon.

Before any Git write, the publisher verifies the exact source QC
and screenshot evidence, immutable staged bytes, project Workspace
authority and branch HEAD, and that the **only** local untracked change
is the reviewed `docs/adr/<safe-file>.md`. A SQLite reservation precedes
each irreversible action. It commits **only** that path, verifies
the resulting commit's exact parent, changed filename, and Git blob
digest, refuses overwriting any remote branch, pushes without force,
then creates an explicitly Draft GitHub PR. `gh pr view` must confirm
the exact remote PR URL, head SHA, head branch, base branch and Draft status.
The operation does **not** merge, make the PR Ready, delete a branch,
or bypass reviews/branch protections.

An uncertain Git commit, remote push or GitHub PR creation leaves a
durable `reserved_*` state and requires manual inspection. The host
does not replay uncertain non-idempotent operations. Repeat Publish on
a confirmed `published` state is strictly read-only.

## Verification and outstanding acceptance

The regular Node.js 22/24 CI includes real disposable Git commit/push
ADR tests, mock `gh` identity proof, lost response, private blob cleanup,
screenshot Git provenance and bounded escalation tests. Existing DAG
integration and concurrency adversarial suites remain enabled.

Still unverified without an authorized Pi/PI WEB host:

- Real authenticated multi-Agent completion of auto diagnosis and
  resumption, and four live sessions with direct steer in a browser.
- Real GitHub ADR PR creation using the intended target repository
  credentials, and completed host-native media capture from a GUI.
- Pi-owned Session archive/delete and safe Worktree cleanup API,
  cross-machine concurrency / distributed locks and 24h+ retention soak.

See [Remaining acceptance plan](../ISSUE_ACCEPTANCE.md) and issue threads
[#2](https://github.com/zkamiyama/pi-micromanager/issues/2),
[#3](https://github.com/zkamiyama/pi-micromanager/issues/3),
[#4](https://github.com/zkamiyama/pi-micromanager/issues/4),
[#5](https://github.com/zkamiyama/pi-micromanager/issues/5).
