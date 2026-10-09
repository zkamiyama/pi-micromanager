# ADR-0013: Full-DAG final integration, independent QC and GitHub auto-merge

- Status: Implemented in the experimental orchestrator, mocked PI WEB and disposable real Git CI; real authenticated E2E deferred
- Date: 2026-10-09
- Extends: ADR-0002, ADR-0007, ADR-0011, ADR-0012

## Why finalization needs its own Task and QC

Passing QC for each independently built Task does **not** demonstrate that
their assembled code works. Independent Task branches can diverge and
conflict even when each passes its own tests. A separate final integration
Workspace must assemble every Task's **exact QC-approved Git commit**,
run full-project tests and obtain a new independently sealed Pi QC
result before the combined code can be merged into the target branch.

The earlier ff-only Worktree convergence (ADR-0012) remains useful for
source→dependent Task handoff, but it is not the final review of the
whole DAG. Crucially it must **exclude** the new final integration Task:
the final coding Pi Session, not the ff-only service, owns merging
independent leaves and resolving conflicts.

## Configured boundary

A new or consciously reconfigured Workflow must opt into the complete
pipeline by providing a distinct **existing linked PI WEB Git Worktree
ID** in the Autopilot configuration:

```json
{
  "publication":{"remote":"origin","baseBranch":"main","draft":true},
  "finalization":{"workspaceId":"existing-final-review-worktree-id","autoMerge":true}
}
```

This Worktree must be distinct from every implementation and independent
QC Worktree, non-main, on a separate review branch, Git-root exact and
clean before each Run. The public PI WEB `workspaces` v1 API has no
create/list/registration action, so the operator must still register/select
the Worktree explicitly. Configurations **without** `finalization`
retain the earlier Task-per-PR behavior and cannot unexpectedly begin
a new final merge.

## State machine

1. All original implementation Tasks must be QC-`passed` or
   `integrated` with `lastQc.verdict=pass`, every diagnosis/synthesis
   Task must be `done`, and all human amendments must be resolved.
   Every original QC must have a sealed native Pi Session and matching
   immutable host evidence receipt. The scheduler also bounds the
   number of source implementations.
2. An idempotent `prepare_final_integration` Workflow command
   atomically appends **one** system-marked `mm-final-integration`
   Task to the DAG, depending on every original implementation's
   QC PASS (and every other Task's completion).
3. The existing Autopilot engine opens a **fresh implementation Pi
   Session** in the dedicated final Worktree. Its prompt supplies the
   exact frozen QC source SHA list and requires Git merges, conflict
   resolution where needed, local test repairs and a clean committed
   result. This is a genuine Pi coding Run with the existing bounded
   `maxAttempts` retry budget, not a fabricated merge result.
4. Host verification rejects dirty Git state, mismatched Worktree,
   test failures, and any final HEAD that lacks **any** original
   QC-approved SHA as an ancestor. This happens both after final
   implementation and during independent final QC.
5. The engine creates a **fresh read-only QC Pi Session** for the
   final Task at the identical final SHA. The model submits an
   explicit `mm_qc_report`; the host reruns tests, compares the
   exact SHA and all source ancestor relationships, and seals
   QC evidence before final publication. A failed final QC
   starts a new integration/rework Session within existing bounds;
   exhausted/uncertain Runs pause safely without duplicate prompt delivery.
6. With `finalization` enabled, the existing host publisher **ignores
   original Task leaves**, pushing only the sealed, final QC-passed
   result branch. It creates a Draft PR for the combined SHA.
7. If `autoMerge=true`, the host consults
   `permissions.actions["github.pr.merge"]`: YOLO defaults to
   `allow`; `ask` creates an exact final QC Run/SHA/remote/base-bound
   approval, and `deny` leaves the PR as a Draft for human review.
   No Ready/merge action occurs before an explicit `ask` approval.
8. The host marks the PR **Ready**, then requests
   `gh pr merge --auto --merge`. This uses GitHub's own required
   status checks and branch protection (no admin override or
   forced merge). The host tracks `autoMergeRequest` as a
   *scheduled* receipt; this is **not** proof of a completed merge.
9. Only when the API confirms the exact PR's state `MERGED`
   with the final QC-approved source SHA does the deterministic
   `final_merge_confirmed` action atomically mark **all** original
   implementation Tasks and the final Task `integrated`. The
   GitHub PR URL and final QC SHA are recorded as authoritative
   Workflow event text. A scheduled merge, model output or CI
   status alone cannot trigger this transition.

## External operation receipts and recovery

Git Push, Draft PR creation, Ready promotion and PR merge scheduling
each write a scoped, exact-destination `reserved` receipt before
the non-atomic host API call. If a response is lost, the publisher
checks the remote SHA or the GitHub PR state before deciding whether
the operation already succeeded; it never blindly repeats an unknown
external mutation. A scheduled GitHub merge is re-inspected until it
actually completes, or fails closed if GitHub retracts the schedule.
Once `MERGED` is proven, the final DAG transition has its own
deterministic, idempotent Workflow command ID.

GitHub may reject auto-merge if repository auto-merge is disabled,
a mandatory reviewer has not approved, checks are red, or branch
protection disallows the operation. The orchestrator surfaces that
failure or remains in a pending state; it does not bypass repo policy
or claim to have merged.

## Limits and scope

- This is **not** a replacement for PI WEB Session sandboxing.
  `ask/deny` constrain Micromanager's own host executor, not
  arbitrary Pi tool subprocesses; stricter credential isolation
  is deliberately postponed by operator request.
- Already-started dependent Task branches still require the proven
  Git DAG conditions from ADR-0012. A divergent pre-task Worktree
  may pause before full-DAG finalization; final conflict repair
  currently applies once the original DAG is stable.
- The complete finalization path requires an explicitly configured
  existing Worktree and working Git/`gh` authentication. Remote
  branch policies and upstream repository configuration still apply.
- Original Workflows without finalization retain legacy semantics;
  no main checkout is rewritten by this feature.
- Multiple simultaneous control plane instances sharing checkout
  roots remain unsupported; per-process scheduling is not a
  distributed lock.
- Tests include actual divergent Git histories, a real merge
  conflict resolved within the disposable final checkout, host
  ancestry gating and final QC test invocation; mocked GitHub
  Draft→Ready→auto-merge→MERGED reconciliation; and mock PI WEB
  multi-Session Task/independent QC orchestration. No live
  authenticated provider or GitHub repository is modified by CI.
