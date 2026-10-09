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

The PI WEB `workspaces` v1 public capability **does not create, register, or
list** newly linked workspaces. Its bundled Git provider will discover linked
Git Worktrees, but the operator must select the new workspace in PI WEB, copy
its actual PI WEB Workspace ID, and insert/save that ID in the Autopilot
configuration. **Never derive PI WEB's opaque Workspace IDs from internal
hashing algorithms or call private routes.**

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
(`git.push` and Draft PR creation) subject to Workflow permissions. The operator
performs real Git integration with their own review policy first. A dependent
Task's implementation Run independently checks upstream Git ancestry in
its own worktree before launching, so an `integrated` DAG gate alone does not
falsely imply that other worktrees contain the code.

## Limitations and future integration

- Worktree **creation** now has an explicit supported workflow, but it is not
  fully automatic provisioning into PI WEB's workspace registry. The actual
  PI WEB Workspace ID is still supplied by the operator.
- No cleanup, automatic Git merge or conflict resolution is performed by
  the integration verifier. ADR-0011 handles optional, exact-QC automated
  Git Push and Draft PR creation separately, not as an integration verdict.
- The source/session/evidence and target ancestry checks are automated, but
  do not prove all product-level acceptance criteria. Provider-authenticated
  Git host E2E and security review must precede production operation.
- A single server-plugin lifetime owns the preview ledgers and active engine.
  Multiple independent writers against the same Git repository would need an
  external leader/lock and serializable repo-wide validation.
