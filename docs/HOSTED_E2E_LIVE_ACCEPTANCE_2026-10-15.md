# Real Pi / PI WEB / GitHub hosted E2E — accepted local trial

Status: **ACCEPTED for the owner-approved, local single-tenant #92 / #38 profile**, 2026-10-15 JST. This is not a production deployment or multi-tenant security certificate.

## Source and components

- Reviewed clean `main`: `86b30c4d865aaf289767d1415a47943c3f1a4243` (PR #98), with source lockfile SHA-256 `ae37d6b21b1e933f0975d8dbfb9c82b614b224f55327dc6d67cc4911717bf841`.
- Local Node.js `22.23.3`; Pi AI, Pi Durable, Pi coding-agent and Chord `1.2.0`; PI WEB `1.202610.2`; Chromium `156.0.8078.4`; Playwright `1.64.0`.
- Existing Pi ChatGPT OAuth login, fixed `openai/gpt-6-luna` implementer effort `low`; independent QC effort `max`. No alternative provider/model or silent fallback.
- Actual bounded trial: `mode=live`, `status=passed`, `code=ok`, exit `0`; 9 sealed/processed Runs, 56 model request admissions, 95 tool admissions. These are observed counts, **not a guaranteed monetary ceiling**.

## Product-path assertions

All 15 required receipt checks returned **passed**, against the shipped PI WEB server/browser plugin and Durable runtime, not a mocked host:

1. Browser sandbox enabled; unauthenticated loopback ingress denied.
2. Registered hosted plugin/public browser peer; UI Workflow save and daemon restart/reopen.
3. Two parallel distinct Workspaces; per-session Steer command acknowledged.
4. Independent source-bound QC and final integration after exact approvals.
5. One real GitHub Push, with a deliberately lost successful response; reconcile remote SHA without a second Push.
6. One real exact-SHA GitHub Merge, with a deliberately lost successful response; reconcile external merged state without a second Merge.
7. Explicit Abort and restart without duplicate agent admission; joined shutdown proof.

The **only** external publication target was this repository's fresh synthetic test base, not main or a release branch:

| Fact | Verified value |
| --- | --- |
| Repository | `zkamiyama/pi-micromanager` |
| Source | `e2e/local-luna-acc67e9a3afc0d71-final` |
| Base | `e2e/local-luna-acc67e9a3afc0d71-base` |
| Real PR | [#100](https://github.com/zkamiyama/pi-micromanager/pull/100), **MERGED** |
| Head SHA | `e5afe5ef907b11de0fedb671acf503ef6933db16` |
| Merge SHA | `f5a9566ebc118ae4dbd8b105cdb2cf00c7f35b6a` |
| GitHub checks | [38594230825](https://github.com/zkamiyama/pi-micromanager/actions/runs/38594230825), **success** |
| Host final state | `cleanup=removed`, `mainUnchanged=true` |
| External refs | Retained as limited test-only evidence, not treated as product state |

Actual remote PR and exact-head checks were independently queried after receipt generation. The local test-only processes joined, filesystem state was reclaimed after proof, and the WSL host reported no D-state Bubblewrap descendants.

A **separate earlier, stopped trial** produced [PR #99](https://github.com/zkamiyama/pi-micromanager/pull/99). At the time, Actions jobs could not start and the product safely paused before merge. The owner later made the repository public; rerun [38590106197](https://github.com/zkamiyama/pi-micromanager/actions/runs/38590106197) succeeded. Rather than blindly repeat that previous external operation, the successful trial above used fresh disjoint refs. PR #99 and associated uncertain/historical test state were intentionally retained and **not** replayed, force-merged, silently deleted or called a passing receipt.

## Qualification limits and outstanding separate work

The emitted receipt explicitly states `tls=not-tested-loopback-only`, `qcRework=not-tested`, and `productionSafetyGuaranteed=false`. It is not evidence of: real deployment ingress/TLS, tenant separation, hard cgroup CPU/RAM/PID or disk quotas, exact provider spend, complete backup/restore, deliberate QC-failure escalation, hosted native Pi session/Worktree garbage collection, automatic ADR PR promotion, or independent production security review. These are tracked in #86, #89, #5 and #2–#4 as appropriate; parent #36/#37 remain open.

The acceptance boundary follows [ADR-0018](adr/0018-runtime-deployment-and-evidence-ownership.md). Source implementation and the credential-free release checks are in [PR #98](https://github.com/zkamiyama/pi-micromanager/pull/98); primary evidence and the original acceptance text are in [#92](https://github.com/zkamiyama/pi-micromanager/issues/92) and [#38](https://github.com/zkamiyama/pi-micromanager/issues/38).

**Never re-run the same external side effect because a local receipt is absent.** Inspect the external PR/branch/CI state and the persisted operation ledger first.
