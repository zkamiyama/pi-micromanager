# Hosted acceptance progress — 2026-10-14

Scope: #92 and parent #38. #91 remains accepted from the owner's successful
manual Luna Low OAuth SDK receipt. **Overall status: incomplete, PR #98 DRAFT;
no new live-model/remote acceptance result and no main merge.**

## Implemented and locally reviewed

- Separate immutable final `allowedMergeShas` from pre-launch
  `requiredAncestors`; revalidate exact passed source QCs at the real host
  executor and feed the actual Durable Git broker. The engine regression was
  reproduced failing before the fix (missing array), then passed with it.
  Legacy final Runs without the capability are refused, not replayed.
- Optional host-only private/canonical `modelAuthFile`, outside any project,
  control state or package. Public Pi SDK owns auth/refresh; no token copying
  or Workflow-supplied auth path. Explicit path disables ambient models.json.
- Actual shipped PI WEB/browser/public-peer harness, authenticated test-only
  loopback proxy, parallel Worktrees, Steer, independent QC, final broker,
  exact approval, push/merge reply loss, restart reconciliation, Abort/reopen
  and descendant-aware cleanup. This is a candidate implementation, not a
  declaration that every case passed.
- A credential-free rehearsal transport uses real local bare Git, explicitly
  synthetic GitHub responses and a faux provider. Added async inspection has
  its own post-await signal/generation check, so it cannot reopen a stale
  mutation window after the product's fence.
- Fixed shallow-checkout rehearsal initialization using an actual bare clone;
  no receive-policy or isolation weakening. A regression covers shallow
  history plus a later test-branch push.

## Evidence achieved

- TypeScript and `git diff --check` succeeded, with local exit codes captured
  independently rather than inferred from a truncated tool process status.
- Scoped engine/auth/transport/process/CI-policy tests: **39 passed, 0 failed,
  0 skipped**, independent subprocess exit 0. These are not the incomplete full
  local suite or the failing actual-hosted rehearsal; the PR records exact refs.
- Credential-free actual `ui` mode passed: sandbox-enabled Chromium,
  unauthenticated HTTP 401, actual registered Micromanager, real UI Workflow
  save, test-daemon restart and restored Workflow. This local UI trial used
  a modified development checkout and is not called immutable live acceptance.
- CI 38553658942 for head `7eee382a7de98c13b69d0d9ee8ab79778b0cb98a`:
  `build-and-test (22)`, `build-and-test (24)` and `successful-isolation`
  succeeded. **`hosted-acceptance-rehearsal` failed.** Its receipt proved
  actual hosted/browser/UI restart, parallel Workspaces and Steer, but stopped
  with `workflow-stopped-before-publication`; QC/publication/recovery/Abort
  completion remains unproved. The status diagnostic was added afterwards;
  the cause must still be resolved, not assumed fixed.

## Blocking conditions — not waived

1. **Local kernel wait:** a test-created Bubblewrap descendant (observed PID
   992907) remained in `D` state with wait channel `exp_funnel_lock` after its
   parent had exited. Its presence was confirmed again after the CI failures.
   Workspace scan and native `/bin/true` worked, real isolation did not join.
   The root kernel cause is unknown. No host OS setting, existing service or
   production daemon was changed or restarted. Further local sandbox launches
   were stopped, and affected temporary state was retained. Do not delete
   that state while process/mount completion is uncertain.
2. **Unresolved hosted rehearsal halt:** the fresh CI host gets past isolation
   and parallel execution, but the full product path has not yet passed. This
   is a separate unresolved test/product diagnosis from the local kernel wait.
3. **Latest CI did not execute steps:** run 38554050535 for diagnostic head
   `e050c60b24700d890c2ab69dfd43b1cc3dda698d` completed failure with all four
   jobs exposing no execution steps or logs. Its create/finish metadata spans
   only a few seconds. The detailed platform reason was not available through
   the connected endpoints; do not claim a billing cause, outage, test failure
   or successful execution without evidence. Unsupported endpoint access was
   not worked around, and no account billing/security settings were modified.

## Required continuation and merge conditions

Inspect the failed CI's platform explanation and restore a usable approved
execution host without weakening OS isolation. Then run the diagnostic
rehearsal, fix its observed halt, rerun exact-commit Node 22/24 and both mandatory
actual-isolation and actual-hosted-rehearsal jobs. The latest SHA must pass;
old successful jobs are not substitutes. Only then consider merging the
reviewed maintenance PR. The owner-authorized `live` mode still needs its own
actual Luna/QC/GitHub result before #92/#38 can be accepted.

The candidate live mode is deliberately bound to a clean reviewed current main
SHA and explicit account/publication approvals; it is not an instruction to
run an unreviewed draft or bypass its merge/CI gate. No new synthetic remote
branch/PR, OAuth inference, provider billing or live service operation was
performed by this task. Existing same-repository trial authorization remains
valid; no renewed model/account/repository permission is being requested.
