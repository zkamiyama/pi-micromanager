# Post-audit implementation and operational limits (2026-10-13)

Baseline: main at `325e7f0`. The fixes in PR #39 provide state/QC,
publication-target, deterministic ID, Durable reconnect and CAS-recovery
protections. The follow-on change adds the measures below.

## Fan-in Git dependencies: two explicit modes

- Default: **fast-forward only**, retaining independent concurrency. If two
  sibling implementations diverge, the dependent writer cannot acquire both
  lineages through fast-forward. The scheduler blocks safely and requires a
  separately reviewed human integration.
- One-command opt-in `convergenceMode: "linearized"`: the host topologically
  sorts the **unmodified proposal** and adds a predecessor QC dependency to
  each implementation Task before the Workflow is first stored. The saved DAG
  is sequential, so its commits can safely fast-forward through dependents
  without host-generated merge commits. This **sacrifices parallel feature
  execution**. All saved tasks and acceptance criteria remain unchanged; the
  added dependencies appear in the saved Workflow. Only proposal admission is
  modified; paused existing Workflows are not silently restructured.
- This is **not** automatic conflict resolution for arbitrarily divergent
  branches. That requires an independent integration Task and QC proof and
  remains unsupported without explicit manual reconciliation.

## Independent final QC with full original source contracts

For new Durable final QC sessions, the compact prompt requires invoking
`mm_final_qc_contract` for every original implementation Task. Each call
provides the full host-verified Task description, acceptance criteria and QC
SHA. `mm_qc_report(pass)` is rejected until all numbered source contracts
have been retrieved. The host still verifies the entire Git ancestry,
cleanliness and configured tests. Native PI WEB compatibility QC continues
to send full source contracts inline and fails closed if its prompt exceeds
the bounded input size. Neither runtime silently drops the final contracts.

## Read-only Durable discovery

QC, architecture review and planning Durable roles expose bounded shell-free
`mm_list_repo_files` and `mm_search_repo_text`. Scans exclude symlinks and
typical dependency/generated folders; time and result quotas are bounded.
This improves discovery, but the general `read` tool is still an SDK-level
tool, and these tools are NOT an OS sandbox.

## Resource and evidence policy

- `maxConcurrentRuns` (1–32, optional) limits new Task starts and QC
  dispatch per Workflow, counting active QC Run leases. New one-command
  setups request 8; legacy configurations keep their prior role limits.
- `maxManagedWorktrees` (1–64; default 32) is checked before **any** managed
  Git Worktree provisioning starts.
- Existing run storage is retained; there is **no automatic destructive GC**
  of native sessions, Durable SQLite, worktrees, or QC evidence. Existing
  operator-confirmed public-activity retention is the only deletion path.
- Operators need a separate archive/clean-up implementation with verified
  receipts, immutable SHA/branch and unsealed-Run checks before any physical
  deletion. Resource admission quotas alone do not reclaim disk space.

## Security boundary

Credentials are filtered from the host's test subprocess environment.
Model-controlled source code and host tests nevertheless execute with the
host process's OS privileges unless the **whole PI WEB/agent/test process**
is deployed inside an OS/container isolation boundary. These controls do
not prevent reading files via arbitrary binaries or network access. Never
give untrusted coding agents a token capable of writing to production repos,
and do not treat prompt instructions or regex shell guards as a sandbox.

## Reproducibility and E2E

**Current policy:** ADR-0018 and [E2E acceptance](E2E_ACCEPTANCE.md) supersede
the historical runner/authenticated-smoke description below. The previous
ambient-auth coding smoke is blocked; SDK-only test authentication is separate
from hosted PI WEB/browser and real remote acceptance (#91/#92).

`npm ci` now uses a committed lockfile. CI runs Node 22 and 24.
`.github/workflows/authenticated-e2e.yml` is **manually dispatched only**,
for a dedicated `pi-authenticated` runner with an environment approval
gate and a Pi profile already authenticated to the chosen provider/model.
It exercises a real model/tool turn, Durable resume and disposable-worktree
implementation/QC without any remote push. No real-provider E2E is claimed
until the authorized runner and credentials have been configured and the job
has completed successfully.
