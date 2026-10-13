# Residual audit remediation — R01–R23

Baseline: `ff6750fe07cf838d18a776815247dd183d7c89b6`. This change incorporates the independently prepared PR #48 additions and fixes residual cross-layer boundaries. It does not claim authenticated production/browser E2E or universal sandboxing.

| Finding | Issue | Implemented behavior | Regression coverage |
|---|---|---|---|
| R01 | [#49](https://github.com/zkamiyama/pi-micromanager/issues/49) | Final GitHub proof is separate from local integration; every dependent checkout must contain the source before its global gate advances. | `final-publication; integration-verifier; residual-audit` |
| R02 | [#50](https://github.com/zkamiyama/pi-micromanager/issues/50) | Durable control generation/CAS fences progress, Start/configuration, every new launch and Worktree creation. | `residual-audit; autopilot-server` |
| R03 | [#51](https://github.com/zkamiyama/pi-micromanager/issues/51) | Convergence and Run admission share SQLite Workspace leases and canonical checkout aliases; uncertain Git receipts retain the lease. | `residual-audit; yolo-convergence` |
| R04 | [#52](https://github.com/zkamiyama/pi-micromanager/issues/52) | Git inspections force full untracked enumeration, reject hidden index flags and recheck tracked bytes and HEAD. Ignored dependencies/environment are not claimed hermetic. | `residual-audit real Git probes` |
| R05 | [#53](https://github.com/zkamiyama/pi-micromanager/issues/53) | Native live delivery requires an already admitted running job at both server and companion; initial automatic delivery is not a follow-up. | `residual-audit native companion` |
| R06 | [#70](https://github.com/zkamiyama/pi-micromanager/issues/70) | Host tests default to Linux Bubblewrap without host home/network/credentials; trusted-host is an explicit compatibility decision. Worker-runtime isolation remains #36. | `residual-audit actual Bubblewrap; host-evidence-fingerprint` |
| R07 | [#54](https://github.com/zkamiyama/pi-micromanager/issues/54) | New merges use synchronous exact-SHA GitHub REST requests, never deferred auto-merge; legacy owned queues can be explicitly cancelled and verified. | `final-publication; autopilot-server` |
| R08 | [#55](https://github.com/zkamiyama/pi-micromanager/issues/55) | Native display names use one 120-character formatter, separately from immutable Run identity. | `residual-audit all 1..64 Task ID lengths` |
| R09 | [#56](https://github.com/zkamiyama/pi-micromanager/issues/56) | Plan, diagnostic and synthesis identities share stable bounded generators at production and validation; dynamic capacity is checked before planning. | `residual-audit; autopilot-engine` |
| R10 | [#57](https://github.com/zkamiyama/pi-micromanager/issues/57) | Managed branch names fit the common 119-character downstream contract and preserve short historical names. | `residual-audit actual git check-ref-format` |
| R11 | [#58](https://github.com/zkamiyama/pi-micromanager/issues/58) | Diagnosis resolves its final-integration parent through finalization.workspaceId. | `residual-audit` |
| R12 | [#59](https://github.com/zkamiyama/pi-micromanager/issues/59) | Exact human intervention instruction and planner rationale are included for both diagnosis and synthesis. | `residual-audit` |
| R13 | [#60](https://github.com/zkamiyama/pi-micromanager/issues/60) | Paused human-controlled QC budget extension has reason/CAS/bounds and no forced PASS; exhausted snapshots accept diagnosis. | `residual-audit; browser controls` |
| R14 | [#61](https://github.com/zkamiyama/pi-micromanager/issues/61) | Frozen original launch input plus explicit zero-input inspection resumes only the same attached Session; accepted/unknown input remains fenced. | `autopilot-server native recovery; durable-runtime real Harness reopen` |
| R15 | [#30](https://github.com/zkamiyama/pi-micromanager/issues/30) | Plan admission checks total prompt budgets; Durable final QC retrieves full per-source contracts with durable manifest-bound read receipts. Native oversized plans fail before execution. | `residual-audit; final-qc-contracts` |
| R16 | [#62](https://github.com/zkamiyama/pi-micromanager/issues/62) | Combined config/DAG admission checks Workspace, final source, managed quota and dynamic/final Task slots before side effects. | `residual-audit` |
| R17 | [#63](https://github.com/zkamiyama/pi-micromanager/issues/63) | Scheduler inventory includes every pending quick goal; bounded UI inventory is separate. | `residual-audit 105 scopes` |
| R18 | [#64](https://github.com/zkamiyama/pi-micromanager/issues/64) | Pause is nonterminal and quick status follows subsequent resume/completion; cancellation can fence pending Worktree preparation before code admission. | `residual-audit; autopilot-server; browser controls` |
| R19 | [#65](https://github.com/zkamiyama/pi-micromanager/issues/65) | Journal selects the Workflow inventory before bounded projection, not after an unrelated Workspace-wide limit. | `residual-audit 205 unrelated Runs` |
| R20 | [#66](https://github.com/zkamiyama/pi-micromanager/issues/66) | Every native report validates before appendEntry/one-shot claim; invalid input remains correctable. | `residual-audit native invalid-then-valid reports` |
| R21 | [#32](https://github.com/zkamiyama/pi-micromanager/issues/32) | Unsupported independent fan-in is rejected at executable plan admission; reviewed opt-in linearization is retained. No implicit conflict merge is introduced. | `residual-audit; dag-linearization; yolo-convergence` |
| R22 | [#67](https://github.com/zkamiyama/pi-micromanager/issues/67) | Actions fallback reads every exact-PR/SHA page within an explicit 10000-run bound; later-page failures cannot be skipped. | `final-publication 101-run two-page cases` |
| R23 | [#68](https://github.com/zkamiyama/pi-micromanager/issues/68) | Previously published final PRs are observed even with autoMerge=false or merge deny; only external mutations depend on consent. | `final-publication` |

## Verification meaning

Run `npm ci --no-audit --no-fund && npm run check`. Tests include real local Git repositories, SQLite, the real Pi Durable Harness with a deterministic faux provider, native companion handlers, mocked public PI WEB/GitHub transports, and actual Bubblewrap file/environment/network boundary probes. No paid model, real GitHub publication, host daemon restart or browser-driven production trial is run by this suite.

The default test sandbox is enforced, not a regex claim. When `/usr/bin/bwrap` is unavailable or namespaces are prohibited, verification fails closed. On non-Linux hosts, use a dedicated disposable execution host or explicitly select `test.execution:"trusted-host"` under the documented trust assumptions. Merely using that name does not isolate the worker or a test.

The broader worker-tool isolation design remains in #36. Arbitrary native extensions and the Durable coding worker are not OS-sandboxed by the verification wrapper. Neither Git cleanliness nor host verification establishes protection against a malicious process already running as the control-plane OS user.

## Safe failure versus new capability

Independent divergent fan-in is now rejected **before execution**, not silently merged. Native final-QC plans whose complete contracts exceed the prompt limit are similarly rejected before model or Git effects. These are intentional supported-plan restrictions, not claims to have added unrestricted fan-in or unlimited native context. Durable supports paged final contracts for at most 64 original implementation Tasks.

## Operational migration

Persisted configurations without a `test.execution` field get the secure sandbox default, not a silent privileged fallback. Install Bubblewrap on the daemon host or explicitly review the compatibility setting before resuming existing workflows. The sandbox only exposes system binaries/libraries, the exact daemon Node executable, a disposable home/tmp, and the selected test Workspace. It deliberately does not expose the daemon's home, linked Git common directory, arbitrary toolchains under home, or outbound network.

New final PR merges use GitHub's synchronous REST `PUT /repos/{owner}/{repo}/pulls/{number}/merge` with the exact reviewed `sha`. A definite HTTP 405 refusal waits for repository policy/reviews without creating future authorization; uncertain responses remain reserved until actual remote proof. Protected merge-queue-only repositories require explicit external handling. Normal branch protection is never bypassed.

Operator Pause prevents new admission through a monotone generation; it does not pretend to kill already admitted agents or retract an already completed synchronous merge. Legacy owned GitHub auto-merge reservations are cancelled and re-read. A cancellation failure is displayed distinctly as local Pause plus external attention required.

`auto.recover.unstarted` is available in Orchestra for attached created/connected/configured automatic Runs. Pause first and supply a reason. The operation uses the frozen original input and exact model/Task/Workspace contract, checks no accepted input or queued work exists, and uses the original Session/Harness only. Old Runs without a frozen launch contract and genuinely uncertain side effects are not replayed. This API does not recover an unassigned `reserved` Session or arbitrary old goal proposals.

`extend_qc_budget` is a human, revision-checked action for held/exhausted implementation Tasks. It increases only the Task's QC budget (up to 100), requires a reason, and cannot turn failed QC into PASS. The separate configured implementation-attempt budget remains enforced and must be reviewed separately.
