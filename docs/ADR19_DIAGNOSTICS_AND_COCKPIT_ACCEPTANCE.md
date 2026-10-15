# ADR-0019 diagnosis and cockpit: implementation and actual OAuth acceptance

Date: 2026-10-15. Issues **#3 and #4 accepted** for the reviewed ADR-0019 public-panel, single-tenant product scope. No production deployment or generic native-Pi/host resource qualification is claimed.

## Changes and exact source

- Product PR [#103](https://github.com/zkamiyama/pi-micromanager/pull/103): head `70d415ea932a5d505752934ee3a1634d7f000b9a`, merge `cf7b42fb12ad452174a94f48ce89eae643679c37`. Bounded opt-in automatic diagnosis, immutable budgets, human priority, exact command targets and scoped focused inspector; planner total-capacity regression fixed without raising limits.
- Test proof PR [#104](https://github.com/zkamiyama/pi-micromanager/pull/104): head `d7ab79a6727ffabcec85b50464dc4730f9e4b692`, merge `324283c42c1256adec7ac936bb41df0c868dbcf9`. The two diagnostic Sessions must be distinct, sealed and bound to the same parent QC source and exact configured provider/model/effort.
- The owner-approved authenticated run used **clean main `324283c42c1256adec7ac936bb41df0c868dbcf9`**, not an uncommitted development checkout. Lockfile SHA-256: `ae37d6b21b1e933f0975d8dbfb9c82b614b224f55327dc6d67cc4911717bf841`.

## Actual observed result

The existing Pi ChatGPT OAuth was used through the public SDK with `openai/gpt-6-luna` implementer effort **low**, independent QC effort **max**. Node 22.23.3, Pi AI/Durable/coding-agent/Chord 1.2.0, PI WEB 1.202610.2, Chromium 156.0.8078.4 with sandbox enabled, Playwright 1.64.0.

The emitted allowlisted receipt was `suite=hosted-pi-web-lifecycle`, `mode=oauth`, **`status=passed`, `code=ok`, exit 0**. This was not a faux-provider receipt.

| Observed property | Result |
| --- | --- |
| Four genuinely running model-backed sessions and visible cards | Passed; `peakRunning=4` |
| Compact/expanded cards, focused QC inspector, narrow viewport, keyboard Enter/Escape | Passed |
| Human hold registered while the exact QC was running | Passed |
| Direct UI Steer acknowledged by that same QC, not a planner/nearby session | Passed |
| Two independent sealed diagnosis Sessions reading the same frozen QC source | Passed |
| Parent held through synthesis; one explicit human resume, repeated command idempotent | Passed |
| Second authorized project has no first-project Workflow/Run leakage; public navigation returns correctly | Passed |
| Daemon restart/reopen and Abort/restart without duplicate admission | Passed |
| Private test state removed after shutdown | Passed; `cleanup=removed`, D-state Bubblewrap count 0 |

Observed diagnostic source SHA: `a1d3313d25064ecba8535da24ddef92342458a4d`, two investigators, human resume required. The workflow recorded 12 Runs, 49 model request admissions and 51 tool admissions. Per-request output remained capped at 4096 tokens. Counts are observed usage, not a monetary guarantee.

No GitHub publication was requested in this experiment: `remotePublication=not-tested`. The separate previously accepted #92 real publication/recovery receipt is documented [here](HOSTED_E2E_LIVE_ACCEPTANCE_2026-10-15.md), not inferred from this quartet. Raw tokens, provider errors, transcripts and native database files are not stored in this document.

## Deliberate failure branch and exact-head CI

The automatic-policy explicit-QC-failure branch is tested independently with actual public production server, SQLite, Git, Bubblewrap and Pi Harness using deterministic faux responses. That suite checks atomic hold, two bounded readonly diagnostics, synthesis, unchanged deadline/counters after reopen and explicit human resume. Unit/adversarial tests additionally cover off/defaults, duplicate/delayed results, human races, failed diagnostic, graph capacity, paused generations, output/request/tool exhaustion and no second automatic episode. Do not mislabel the deliberate-failure experiment as a real OAuth failing-QC trial.

[PR103 CI 38666574561](https://github.com/zkamiyama/pi-micromanager/actions/runs/38666574561) and [PR104 CI 38667898283](https://github.com/zkamiyama/pi-micromanager/actions/runs/38667898283) passed all five required jobs. PR103 exact-head local full check: **403/403**. PR104 exact-head local full check: **404/404**, both with zero failures/skips. Mandatory actual isolation: **54/54 with zero skips**. Ordinary Node22/24 CI has two explicit namespace-unavailability skips; those are not isolation evidence. Hosted-browser and publication-rehearsal CI remain explicitly credential-free.

## Remaining boundaries

This establishes the ADR-0019 scoped #3/#4 product acceptance, not public deployment TLS/authz, hard cgroup/filesystem quotas, statistical independence of two runs of the same model, universal model support, native Pi lifecycle or cross-tenant safety. No fallback to native unconfined execution or protection bypass was introduced. #2's native-specific qualification, #5's broader artifact/knowledge work, #86 target host qualification and #89 external owner-API lifecycle remain separate, with parent trackers #36/#37.

Feature/configuration reference: [bounded diagnosis and cockpit](ADR19_DIAGNOSTICS_AND_COCKPIT.md). The automatic policy is **off by default** and synthesis never unilaterally resumes coding.
