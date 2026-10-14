> Update 2026-10-15: The owner-approved real Pi/PI WEB/Luna/GitHub E2E completed successfully and #92/#38 are closed. See [2026-10-15 accepted real-host receipt](HOSTED_E2E_LIVE_ACCEPTANCE_2026-10-15.md). All earlier pending/blocked details below are historical development-stage evidence, not current status.

# Local continuation and remaining acceptance gate — 2026-10-14

**Status: implementation improved; complete isolated rehearsal and live acceptance remain unproved.**

The owner permits equivalent local verification while Actions capacity is unavailable.
No workflow/protection setting has been weakened and no failed/skipped status is
represented as a successful run. Exact candidate SHA and fresh test totals are
recorded in PR #98 after the final commit.

## Work completed in this continuation

- PR #97 was independently rechecked at its unchanged head
  `562a555a1ece3ba0fb3199af42189e3a1e968322`. Its complete existing CI
  38527448657 passed Node22/24, actual isolation and actual hosted-browser;
  fresh scoped local product tests passed 29/29 on each Node22.23.3/24.21.0.
  It is merged into main as `ac9ea014593e31e3b8061e8587f3ab1fadd57719`.
- This candidate now incorporates that main through an explicit merge, retaining
  all storage/diagnostic/retention protections and the full existing README.
  Both quartet-browser and publication-rehearsal jobs remain present; the
  older quartet runner has its own `test:e2e:hosted-quartet` command.
- The final-QC faux fixture consulted obsolete `context.tools`. Pi's actual
  normalized provider context advertises tools on system messages using
  `toolsAdded`/`toolsRemoved`. The recovered correction tracks those declarations
  and requires the advertised final-contract tool before emitting final QC.
  New tests reproduced **2 failures on original PR #98 head 1b85e640** and
  pass after the correction through the public Pi model API. This explains a
  real fixture defect; it is not yet a complete successful rehearsal receipt.
- Process inspection now distinguishes a missing PID from inaccessible/malformed
  `/proc` evidence. Unknown identity or exhausted descendant inventory cannot
  certify shutdown. Signals require positively matching process identity;
  unreadable/reused PIDs are not killed speculatively. The host supervisor
  latches incomplete inspection while still attempting normal owned-child stop,
  and retains temporary state rather than reporting successful cleanup.

## Current execution blockers

The approved local WSL kernel still contains old test Bubblewrap descendants in
D-state at `exp_funnel_lock`. One fresh bounded, credential-free `/bin/true`
namespace probe also timed out; its parent exited but a recorded descendant
remained blocked. No further namespace/browser/model acceptance was attempted
on that host. The kernel root cause is unknown; this is not a passing
sandbox-refusal test or successful joined cleanup. No existing service, OS
security setting or production data was changed, and uncertain test state was
not deleted.

A single SSH connection to a previously created dedicated validation VM was
refused by the tool safety check. It was not retried, rephrased, or rerouted
through a different access mechanism. Earlier VM files/processes remain
untouched. This is separate from the code-level regression results.

The most recent original PR CI runs failed without execution steps. The owner
reports an Actions capacity limit; no unsupported billing endpoint or account
settings were used to establish/change its cause. Existing green PR #97 results
apply only to PR #97, not to this newly merged candidate.

## Gate before this candidate can merge

Use a qualified local Linux host where actual namespaces and sandboxed Chromium
finish normally. Verify this exact candidate with Node22 and Node24 full checks,
the complete mandatory real-isolation suite, the actual hosted quartet and the
full credential-free publication rehearsal. Scoped native tests below do not
replace these gates. Follow with the separately approved live Luna/QC/GitHub
receipt for #92; #91's successful owner-run SDK receipt remains accepted.
No new account/model/repository authorization is required for that existing
profile. Platform/owner-lifecycle issues #86/#89 and their parents remain
separate unfulfilled requirements.

---
## Historical development record before the local continuation

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
