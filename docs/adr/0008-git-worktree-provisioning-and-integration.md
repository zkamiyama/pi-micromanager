# ADR-0008: Managed Git worktree admission and verified integration proofs

- Status: Implemented experimentally (Git/PI WEB public API mocks; real-host E2E pending)
- Date: 2026-10-09
- Extends: ADR-0002, ADR-0006, ADR-0007

## Purpose

A deterministic Task DAG cannot assume that two agent worktrees share each
other's commits. A model's text saying "merged" or a QC PASS does **not**
establish integration. The system also needs a safe, opt-in way to prepare
isolated Git Worktrees, while preserving PI WEB's public host API boundary.

## Explicit managed Worktree provisioning

Micromanager's workspace tab exposes **Manage isolated Git Worktree**.
An operator selects an *unstarted* implementation Task and requests a
non-mutating preview. The preview requires a clean, exact project Git root,
captures its base HEAD, and proposes:

- a unique, deterministic branch `mm/<scope-digest>/<workflow>/<task>`;
- a path under the plugin's **owned data directory**;
- an expiry timestamp and the Workflow revision.

Only a separate **Create reviewed Git Worktree** action may execute
`git worktree add --no-track -b <branch> <path> <base-sha>`. This command is
passed as argv through the public PI WEB host executor, **never a shell**.
The provisioner refuses configured/started Tasks, active Autopilot, dirty
projects, path/symlink violations, existing target paths, existing Git refs,
and moved base HEAD.

It commits a durable `reserved` receipt to SQLite **before** executing Git.
If the external Git command times out or fails, it cannot simply replay
`git worktree add`. **Inspect reserved Worktree** rechecks Git's authoritative
worktree registry, branch identity, head SHA, exact Git root, and cleanliness.
A matching result transitions to `created`. An absent or conflicting result
remains unresolved for explicit operator reconciliation; nothing is deleted.

The PI WEB server-plugin `workspaces` v1 capability exposes only `resolve`,
not create or list. However, **PI WEB does not register Git Worktrees**: its
bundled Git provider automatically lists the linked Worktrees of a project,
and the browser HTTP `GET /api/projects/:projectId/workspaces` route returns
the current list. In this ADR's original **manual** workflow, the operator
may copy a real Workspace ID from PI WEB.

**Superseded/extended by ADR-0014 for explicitly opted-in automatic
provisioning:** the pinned Git provider's internal ID derivation is treated
only as a *candidate*. It must pass public host `workspaces.resolve` authority
validation with the exact new Worktree path, linked Git metadata and project
scope before a Pi Session. The implementation fails closed when PI WEB changes
the ID scheme or provider. Do not use an unverified hash as authority and
do not call private host internals.

## Git integration is an evidence-verified claim, not an automatic merge

When an implementation Task reaches QC `passed` (not `held`) and a matching
fresh QC Run is durably sealed with immutable evidence, the operator may
manually integrate its verified commit into a distinct target Git Workspace.
From **Task Lens → Verify completed Git integration**, they select the target
PI WEB Workspace ID and request a *read-only* preview.

The host confirms:

- target PI WEB workspace authority belongs to the same project;
- its root and HEAD are valid, and it has no dirty/untracked changes or
  active Pi Run that could race verification;
- source Task's `lastQc` verdict is PASS, with the exact SHA, Run ID and
  matching sealed Session evidence;
- the target is **not the source worker workspace**;
- Git `merge-base --is-ancestor <qc-sha> <target-head>` succeeds.

A 10-minute expiring, workspace-scoped preview persists the exact source and
target SHAs, Workflow Revision and evidence ID. **Confirm integration** repeats
all checks, rejects any revision/head/evidence drift, and only then applies
the existing authoritative `WorkflowAction.integrate` via durable CAS and an
idempotent command receipt. The proof row recovers safely after a crash
between the Workflow transaction and updating its own confirmed status.

This **integration-verification action** is strictly observational: it never
runs Git merge, cherry-pick, reset, push, branch removal, or deletes a Worktree.
ADR-0011 introduces a **separate, explicit** post-QC host publishing path
(`git.push` and Draft PR creation) subject to Workflow permissions. ADR-0012
additionally supports a different **automatic fast-forward-only** operation
into unstarted dependent Git Worktrees after sealed QC, never into protected
main or a remote Pull Request. It cannot resolve divergent branches. The operator
performs real Git integration with their own review policy first. A dependent
Task's implementation Run independently checks upstream Git ancestry in
its own worktree before launching, so an `integrated` DAG gate alone does not
falsely imply that other worktrees contain the code.

## Limitations and future integration

- Manual preview/confirm remains available. With explicit
  `managedWorktrees: true`, automatic creation and host-verified PI WEB ID
  resolution occur at Autopilot Start (ADR-0014). This relies on the current
  PI WEB Git provider's version-specific ID scheme, not an exposed public
  `workspaces.list` capability.
- No cleanup, automatic divergent branch merge or conflict resolution is
  performed by the integration verifier. ADR-0011 handles optional,
  exact-QC automated Git Push and Draft PR creation separately; ADR-0012
  allows bounded `merge --ff-only` into clean, unstarted dependent Worktrees
  as a separate real-Git ancestry propagation, not a GitHub PR merge.
- The source/session/evidence and target ancestry checks are automated, but
  do not prove all product-level acceptance criteria. Provider-authenticated
  Git host E2E and security review must precede production operation.
- A single server-plugin lifetime owns the preview ledgers and active engine.
  Multiple independent writers against the same Git repository would need an
  external leader/lock and serializable repo-wide validation.
