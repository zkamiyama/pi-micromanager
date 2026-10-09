# ADR-0011: YOLO by default, explicit Workflow permissions and QC-gated Draft PR publication

- Status: Implemented experimentally (Git/GitHub CLI mock-host CI; real authenticated Pi host E2E deferred)
- Date: 2026-10-09
- Extends: ADR-0007, ADR-0008 and ADR-0010

## Product decision

Micromanager does not ask a human to approve every edit or tool call.
**YOLO is the default** for supported actions inside an explicitly started
Autopilot Workflow. A Workflow may optionally define a durable policy:

```json
{
  "permissions": {
    "default": "allow",
    "actions": {
      "git.commit": "allow",
      "git.integrate": "allow",
      "git.push": "ask",
      "github.pr.create": "allow",
      "github.pr.merge": "ask",
      "deploy.production": "ask"
    }
  }
}
```

Every action accepts `allow`, `ask` or `deny`. Unknown actions and
decisions are rejected, not silently accepted. Merge and production
deployment are **reserved** action names, defaulting to `ask`, but there
are currently **no Micromanager execution paths** for them. An
`allow` setting cannot create capabilities the host does not implement.

Existing saved Workflows with no `permissions` field remain compatible.
New Workflows are YOLO for implementation and hosted Draft PR publication
unless overridden.

## Explicit publication destination

The independent Autopilot execution configuration may include:

```json
{
  "publication": {
    "remote": "origin",
    "baseBranch": "main",
    "draft": true
  }
}
```

When the operator separately configures and starts Autopilot, this
destination enables automatic publication after a successful QC and sealed
Run. Historic Autopilot configurations **without** `publication` never
unexpectedly acquire outbound Git/GitHub effects. The UI provides
`publication` by default for **new** configurations; the operator must
verify its remote and base branch before saving.

The publication implementation is **host-owned**: it re-resolves the
authentic PI WEB Worktree, checks an exact clean Git SHA matching the
latest QC PASS and the sealed native Run/evidence receipt, verifies
that no other Run leases the checkout, reads its real branch and validated
github.com remote, and performs bounded argv-only `git push --porcelain`
(no force), then `gh pr create --draft` for the configured target branch.

The GitHub CLI `gh` must already be installed and authenticated in the
host environment; credentials are never stored in Micromanager's SQLite
configuration. GitHub CLI listings independently check that an existing
PR belongs to the exact head SHA, head branch, repository, base branch and
is open. A PR created by the tool must still be Draft. **No GitHub PR merge,
auto-merge, conflict-resolving Git merge, release, PR ready conversion,
push of a protected branch or
destructive Worktree cleanup** is implemented.

## `ask` is a durable approval, not a blocking model popup

`git.commit` with `ask` holds admission **before** starting a new
modifying Pi Session. A persisted approval binds the Task, intended
attempt, Workflow revision and selected implementation Workspace ID.
If the DAG revision changes before approval, the old request is stale.

`git.push` and `github.pr.create` with `ask` hold **only** their
respective host-side external operation. The persisted request binds the
Workflow and Task ID, exact QC Run and commit SHA, plus the configured
remote/base/draft destination. Human decisions are one-way and scoped to
one Orchestra; no approval can be reused for another commit/target. A
`deny` decision skips publication and cannot be overridden by model text.
Other independent Task work can continue while a publication approval waits.

The PI WEB panel exposes saved requests, exact subjects and Approve/Deny
buttons. Approving resumes scheduler eligibility: it does not replay the
last Pi Session turn or bypass an existing QC hold.

## Durable, uncertain external side effects

A `publication_operations` receipt reserves the exact destination and
QC SHA **before** a non-idempotent Git or GitHub call. If the process dies
after a successful Push but before recording its result, recovery checks
`git ls-remote` for the same branch and SHA; it never blindly pushes
again. If the PR creation response was lost, recovery checks `gh pr list`
for an open PR with the exact source SHA and base branch; if it cannot
prove a match it refuses to create a possible duplicate.

Moved/dirty Worktrees, mismatched remote branches, invalid GitHub remote,
unavailable/auth-failing `gh`, conflicting PRs and uncertain results
fail closed. The Workflow may be paused for operator reconciliation.
The current release is a **single-server-plugin** scheduler, not a
distributed leader-election service. Reconciliation is limited to the
observable Git/GitHub state: network outage or remote rebases may still
need human intervention.

## Dependent Git convergence (ADR-0012)

YOLO now supports an additional host-managed `git.integrate` action. After
sealed QC, the scheduler first tries to fast-forward the exact QC commit into
each clean, never-started **dependent** Git Worktree. Git itself must prove
ancestry; `merge --ff-only` is the only automatic branch integration allowed
and cannot merge diverged branches or protected main. An `ask` approval binds
both the upstream QC SHA and the exact dependent Task/Worktree HEAD. An
ambiguous native Git result is persisted and reconciled, never replayed
unconditionally. Only after every dependent checkout contains the source
commit does the DAG's `integrated` gate open.

This is a real but limited Git Worktree fast-forward, **not** a GitHub PR
merge, main branch merge, auto conflict resolver or code review. Terminal
Tasks still need a separate integration/review decision. See
[ADR-0012](0012-safe-automatic-git-convergence.md).

## Security boundary of Pi `tool_call`

Pi normally executes shell tools without individual confirmation, and its
extensions support `tool_call` interception. Micromanager's Pi companion
blocks **obvious direct `git push` / `gh pr create`** attempts so that
normal model behavior delegates Git publication to the authoritative host
after QC and approval.

**This interception is not a security boundary.** Arbitrary shell
commands can invoke nested binaries/scripts, other extensions or direct
network APIs. Pi retains the OS permissions, credentials and network
access of the process that hosts it. A Workflow `deny` or `ask`
enforces the **Micromanager host publication path**, but cannot
physically prevent an untrusted model process from accessing GitHub
with credentials already present in that process.

For a strong organization-level policy, run Pi in a container or restricted
OS account **without** GitHub publish/deployment credentials and network
access to protected endpoints. Use a separately authorized host publisher
with narrowly scoped credentials. Public PI WEB `pi-sessions` v1 currently
does not expose a per-Session sandbox/credential-injection policy, so
Micromanager cannot claim such host isolation is active. Merely changing
a prompt or adding a `tool_call` regex cannot replace sandboxing.

The screenshot capture tool remains an evidence verifier, not a new
browser screenshot generator. Use existing Pi/Playwright/browser tools
inside the coding Worktree for screenshots when required.

## Validation and constraints

CI uses strict TypeScript and native tests for default decisions, invalid
policies, immutable request receipts, stale Workflow versions, approval
refusals, source SHA checks, non-force host Push, Draft PR creation and
lost-response reconciliation. The PI WEB server mock tests full
implementation → QC → human `ask` approvals → Push → Draft PR without
creating a second Pi Session.

Real authenticated Pi / PI WEB GUI E2E remains deferred per the operator's
request; these tests do not assert production-ready unattended operation.
