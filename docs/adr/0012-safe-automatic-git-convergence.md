# ADR-0012: YOLO fast-forward Git convergence before dependent Task admission

- Status: Implemented for provably safe fast-forward Worktree propagation; non-fast-forward automation deferred
- Date: 2026-10-09
- Extends: ADR-0002, ADR-0007, ADR-0008, ADR-0011

## Motivation

A QC-PASSed Task was left at `passed` until a user manually integrated
its commit into each dependent Task's separate Git Worktree. This broke
the default autonomous development flow: a Task already marked `ready`
by a `qc_passed`/ `completed` dependency could launch in an outdated
branch even though the Orchestrator's later host ancestry gate would
reject its execution.

The Workflow engine must **never** equate a model assertion of integration
with Git commit inclusion. However, a clean, unstarted linked Worktree
whose current HEAD is an ancestor of the QC-approved source commit can
be advanced by Git's genuine `merge --ff-only` without conflict resolution,
history rewriting, force push, auto PR merge or a model-generated shell
command.

## Decision: fast-forward only, with the existing permission model

When an implementation Task becomes `passed` with `lastQc.verdict=pass`,
the scheduler checks whether it has direct implementation dependents.
**Before** admitting other Tasks, a host-owned convergence service:

1. Verifies the exact sealed automatic QC Run, immutable evidence reference
   and QC-passed SHA, with no held/post-QC human intervention.
2. Resolves each dependent's configured PI WEB Workspace ID through the
   public `workspaces` capability. Requires a different, non-main, linked
   Git checkout with an allowable non-protected branch.
3. Requires dependent Task `attempts===0` and status `blocked` or `ready`,
   with no active/unsealed Pi writer/QC/diagnosis lease, dirty files or
   Git root/branch mismatch.
4. Checks `git merge-base --is-ancestor`. If the source commit is already
   in the child Worktree's history, there is **no** Git mutation.
   Otherwise, the child's original HEAD must be an ancestor of the
   source SHA. If branches diverged or Git cannot prove ancestry,
   the Workflow pauses safely for operator-guided Git integration.
5. Evaluates `permissions.actions["git.integrate"]` (`allow`, `ask`,
   `deny`, with ordinary YOLO `allow` default). An `ask` decision
   creates a durable, one-way approval bound to Workflow/parent Task,
   QC Run/commit SHA, exact dependent Task/Workspace and current
   child HEAD SHA. An approval for another branch/head cannot be reused.
6. Revalidates the target and exact approval, writes a durable
   `reserved` receipt **before** `git merge --ff-only <qc-sha>`.
   It then verifies that target HEAD is the exact source SHA and its
   checkout is still clean, before marking the receipt `completed`.
   This is an actual Git fast-forward; it does not run a PR merge or
   change the protected project's main checkout.
7. If a Git response is lost after the command may have succeeded,
   the same reservation reconciles only when clean target HEAD
   exactly matches the reserved QC SHA. The process never blindly
   retries an uncertain merge. If the checkout remains divergent or
   stale, operator reconciliation is necessary.
8. Once **every direct dependent** Worktree has verified ancestry,
   revalidates the set and applies the authoritative
   `WorkflowAction.integrate` using a deterministic command ID,
   Revision CAS and durable command receipt.

This propagation happens **before** `planNext` admits a dependent Task.
A child with `gate=integrated` becomes eligible only after this
verified transition; one with `gate=qc_passed` is no longer allowed
to launch while its checkout lacks the passing ancestor.

## Precise semantics and exceptions

- An automatically `integrated` upstream Task means its QC SHA has
  reached **all of its direct dependent Worktrees**. It **does not**
  mean the source has been merged to `main`, auto-merged on GitHub,
  deployed, or accepted by a human code reviewer.
- Terminal Tasks with **no dependent implementation Tasks** remain
  `passed` under this fast-forward-only operation. ADR-0013 optionally
  creates a separate final integration Pi Run after the whole DAG settles,
  with independent final QC and a GitHub `MERGED` receipt before marking
  every Task integrated. Without that configuration, terminal branch review
  remains separate.
- Fan-out from one source to multiple clean branches is supported.
  Multiple divergent ancestors of one child may need a human-guided
  merge/rebase; the first safely fast-forwarded parent is retained,
  and **no** automatic `--no-ff` merge, cherry-pick, reset, force
  update or conflict resolver is attempted.
- A `deny` decision suspends autonomous propagation; a pending
  `ask` decision holds execution until human approval. Independent
  Task/QC state and evidence cannot be overridden by model prose.
- No automatic Worktree registration, GitHub PR merge or Pi Session
  deletion is added. Those API and lifecycle limits remain.
- All operations use PI WEB's host-owned bounded argv Git executor and
  official Workspaces resolver. The same restrictions as ADR-0011
  apply: the Workflow policy controls Micromanager's own executor,
  **not** arbitrary Pi shell subprocesses; strict permissions require
  a separate sandboxed runtime which is deliberately postponed.
- Multiple independent server-plugin data roots sharing a physical
  repository are not a supported distributed lock/leader-election
  topology. Real multi-server tests are outside this milestone.

## Verification

Disposable **real Git** tests cover successful `--ff-only`, fan-out,
actual SHA ancestry, an `ask` approval across server recreation,
`deny`, divergent branches and human reconciliation, dropped response
with durable recovery, unknown outcome without repeated mutation, and
unsealed Pi Worktree lease refusal. Mocked public PI WEB server
integration tests confirm Git convergence occurs **before** a child
implementation Pi Session is created. No authenticated Pi provider,
remote user repository or protected branch is touched by tests.
