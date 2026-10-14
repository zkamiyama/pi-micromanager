# Production remediation acceptance audit: #72, #73, #74, #76, #77, #18

This document records code-level acceptance evidence on **disposable**
test hosts. It is **not** an operational readiness certificate.
Do not restart a live daemon, restore production state, use paid providers,
publish test code to a real repository, or weaken kernel/Bubblewrap isolation
to satisfy a check.

## #72 — S01 committed input outcomes

- **Primary and follow-up input accounting:** `RunSafetyLedger.trackInput`
  persists request identities. `DurableRunHost.supervise` reads exact
  `submissionByRequest()` results through the public Durable transaction
  API, and only terminal `done` for every tracked input counts as completion.
- **Failed and uncertain input:** `run-safety.ts` persists immutable
  completed/aborted/failed/uncertain outcomes. Provisional model reports
  cannot authorize a transition. `assertProvedCompleted()` also checks
  the authoritative outcome immediately before QC/implementation/diagnosis/
  synthesis/Plan transitions and human proposal acceptance.
- **Evidence:** `tests/production-runtime.test.mjs` exercises real
  Harness/faux-provider QC PASS-before-error, Plan-before-error,
  successful settlement/reconnect and budget exhaustion.
  `tests/production-server-isolation.required.mjs` proves that the
  public proposal API rejects a provisional report after provider failure,
  even if a stale settlement projection is injected.
- **Regression proof:** that stale-proposal test fails against
  `937337bcc09c424e560912c4fa13ddbe2c5b3ec3` with
  `true !== false` for `canAccept`. The new persisted-outcome fence
  makes it pass. No raw provider error or secret is committed.

## #73 — S02 host-mediated Git safety

- **Fixed process configuration:** `gitExecutionEnvironment` strips
  inherited Git redirecting variables and installs finite overrides for
  hooks, fsmonitor, signing and maintenance. The production wrapper executes
  `/usr/bin/git`, forbids unsafe repository-local configuration after its
  asynchronous preflight, and validates a canonical HTTPS allowlist for
  network operations. Fixed Git brokers reject executable config and allow
  only a narrowed set of local worktree actions.
- **Evidence:** `tests/production-safety.test.mjs` uses disposable local
  Git repos, a harmless hook sentinel, executable-filter settings, and
  the *real production wrapper* with injected local filter/merge/include/
  credential/url configurations. No actual remote push or live credentials
  are used. `tests/production-execution-fence.test.mjs` and
  `tests/production-server-integration.test.mjs` cover stale admissions.

## #74 — S03 persistent model/tool/time/fleet limits

- **Budget authority:** `RunSafetyLedger` stores immutable per-Run
  model/tool counters, a deadline, an input inventory and an atomic
  host-wide reservation. `withModelBudget` checks every SDK request
  entrypoint; tool executors consume budget before invocation. Terminal
  budget exhaustion cannot rescue an earlier provisional PASS.
- **Process/timeout cleanup:** sandbox process-group cancellation,
  bounded output and deadline tests are fail-closed.
- **Evidence:** `tests/production-safety.test.mjs` covers concurrent
  SQLite handles, reopen and elapsed deadlines, limited output/timeouts;
  `tests/model-boundary.test.mjs` covers model admission;
  `tests/production-runtime.test.mjs` covers real Harness exhaustion
  and reopening.
- **Not a monetary or machine quota:** cgroup CPU/RAM/PID, disk quota,
  SDK/network host limits and provider spending caps are deployment
  responsibilities; see #37 and SECURITY.md.

## #76 — S05 host-owned production security

- **Host authority:** `src/security/policy.ts` accepts only an explicit
  host-owned profile and freezes allowlists/budgets. The public PI WEB
  entrypoint rejects native sessions, wrong models/projects, unisolated
  runtime, trusted-host verification and permissive publication policy
  during configure/launch/restart/recovery.
- **Evidence:** `tests/production-server-integration.test.mjs` checks
  public policy refusal, model mismatch, actual startup refusal of
  persisted unsafe config and a bounded readiness projection with
  `pass`, `fail`, and `not-verified` evidence. Existing policy,
  publisher and integration tests cover permission/SHA/destination checks.
- **Readiness is not deployment approval:** readiness reports software-level
  checks and explicitly leaves ingress/TLS, patched host, namespace isolation
  on the *target* host, quotas, provider billing and recovery unverified.

## #77 — S06 pinned CI and required actual isolation

- **CI:** SHA-pinned checkout and setup-node actions, no persisted checkout
  credentials, read-only permissions, timeouts, concurrency and Dependabot.
  Full-SHA pins correspond to upstream verified releases (checkout v7.0.1
  and setup-node v7.1.0).
- **Required isolation:** Node 22 and Node 24 portable jobs are separate
  from `successful-isolation`. Only the latter certifies actual
  Bubblewrap namespace success with `MM_REQUIRE_SANDBOX=1`;
  sandbox refusal is a failure, not a silent skip.
- **Manual authenticated E2E:** opt-in workflow_dispatch, default-branch
  restriction, dedicated labeled self-hosted runner, environment approval,
  read-only token and no remote publication credentials/push.
- **Evidence:** `tests/production-release-gates.test.mjs` checks the
  repository's CI/release policy; GitHub Actions results must be verified
  against the **final exact PR head** before closing.

## #18 — F06 persisted abort and recovered Plan/QC

- **Sticky abort and outcome:** `AgentRegistry.requestAbort` persists
  `abort_requested`; `RunSafetyLedger.finish` persists immutable
  terminal outcomes. An interruption cannot turn an earlier report into
  accepted evidence, even when the event is lost or the host reopens.
- **Transition gate:** `DurableRunHost.assertProvedCompleted()` is
  connected to the real host executor, the deterministic Workflow
  engine (including intervention planning) and the public proposal
  accept/recovery path. It requires a proven `completed` outcome,
  not merely a model report or a possibly stale `settled` projection.
- **Evidence:** `tests/durable-runtime.test.mjs` tests QC and Plan
  abort/lost-event/restart with the real faux-model Harness, including
  no repeated provider call and rejection of provisional reports.
  `tests/production-server-isolation.required.mjs` tests public
  acceptance refusal despite an injected stale settlement record.
  This last test was reproduced failing on the prior main before
  the new gate was wired, then passed after correction.

## Required sign-off

Before an Issue is closed: record the exact change commit SHA, scoped test
outcomes, latest Node 22/24 + mandatory actual-isolation CI, any skips and
remaining deployment obligations in an Issue comment. Use no current
production daemon or state for acceptance. Keeping other broader Issues
such as #36, #37, and #38 open is intentional and does not imply production
deployment has been approved.
