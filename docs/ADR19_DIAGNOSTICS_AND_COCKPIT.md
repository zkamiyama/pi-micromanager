# ADR-0019 implementation: bounded diagnosis and exact Run controls

Related: [ADR-0019](adr/0019-bounded-product-capabilities-and-issue-disposition.md), Issues #3 and #4. This page describes implemented product behavior. An authenticated acceptance result must still be recorded against the exact reviewed commit; a faux-provider test does not certify real provider behavior or a production deployment.

## Opt-in automatic diagnostic episodes

The default remains **off**. In the existing Autopilot configuration JSON editor, an operator may add the following to a **Durable** Workflow while it is paused and has no unsealed automated Run:

```json
{
  "automaticDiagnosis": {
    "afterFailures": 2,
    "maxModelRequests": 36,
    "maxToolCalls": 90,
    "maxDurationMs": 180000,
    "maxOutputTokens": 2048
  }
}
```

This is an addition to a complete valid Autopilot profile, not a standalone configuration. Remove the key to disable future automatic admission. `null`, `false`, unknown keys, missing limits, infinite limits and the native `pi-web` runtime are rejected. Reconfiguration cannot reset or reinterpret an already-created episode.

A qualifying trigger is a **normally completed, explicit model QC `fail`** bound to the current attempt, source SHA and criteria revision. The host test process must also have a definite non-truncated terminal outcome. A nonzero test result can corroborate an explicit model failure; an infrastructure/namespace failure, timeout, interrupted or unproved input, truncated verification, a model `pass` overridden by a host failure, or mere `inconclusive` cannot create automatic diagnosis authority. Eligible consecutive failures count only within the same frozen policy/model fingerprint.

The same WorkflowStore CAS transaction that finalizes the qualifying QC changes the parent to `held`, records a permanent per-Task episode identity, and adds **exactly two readonly diagnosis Tasks and one synthesis Task**. A human barrier wins and is never overwritten. If graph capacity or identity validation fails, the whole transition is refused; no partial hold/QC completion is persisted.

The two investigators use the operator's configured architect and QC profiles; synthesis uses the planner profile. Provider/model/effort are frozen into the episode and remain subject to host allowlists. The investigators read the same source-bound QC evidence without being given one another's conclusions. This is independent execution/input isolation, not a statistical independence guarantee for two runs of the same model.

## Finite and persistent authority

- At most **one automatic episode per Task**. Changing policy, restarting the daemon, human rework or extending a QC round limit does not reset this fact. The feature has no automatic episode reset/retry operation.
- The episode's maximum request/tool allowances are divided into three fixed shares by integer division. Unused shares are **not borrowed or reassigned**; total admitted work cannot exceed the configured episode allowance. Each share is further intersected with the host's existing per-Run limits.
- Every child receives the same absolute deadline fixed at QC finalization. Queueing counts against that deadline. Starting late cannot extend it, and restart preserves it.
- The Pi SDK text-request boundary clamps `maxTokens` before each call, preserves smaller caller limits, and refuses other unbounded request types for this episode. Existing model/tool counters, terminal outcome latches, workspace isolation and joined cancellation remain in force.
- The host executor revalidates the exact automatic amendment, current held Task/QC, Run kind, profile, budget and deadline after asynchronous inspection. The persisted initial launch and runtime fingerprints include diagnostic authority; removing/changing a budget cannot turn the same Run into an unlimited one.
- Synthesis is a proposal only. The Task stays held until an explicit `resume_after_diagnosis` decision. Repeating the same approved command ID has no second effect. A failing, aborted, timed-out or uncertain diagnosis never authorizes synthesis or automatic implementation rework.

Workflow and host-wide Run capacity include human planners. A planner waits when the Workflow limit is occupied, and the actual runtime still performs atomic host-wide reservation. A read-only capacity hint avoids opening a fifth Run while four slots are occupied; it is not a substitute for the final capacity check and cannot grant execution authority.

Request and token ceilings bound admitted work, not a precise monetary bill or total OS resource usage. Hard quotas, provider billing limits and deployment qualification remain #86.

## Cockpit behavior and command safety

The existing PI WEB public Workspace panel remains the UI boundary. A compact Run card shows identity/status without rendering its activity and composer; expanded cards expose bounded activity and direct commands. An explicit **Inspect** button opens the selected Run's scoped detailed inspector. Keyboard Enter activates it; Escape/Close dismiss it without changing the Workflow or spawning another agent. The inspector remains within the host panel and displays the current machine/project/Workspace scope.

Before sending a queued UI command, the client re-resolves the exact current project, orchestra, Workflow, Task, Workspace, Run, session and seat. A disconnected, ended, duplicate or other-scope target is refused, never substituted with a nearby QC or planner. The server continues to enforce its own current authority and receipt rules. ACK means acknowledgement, not task completion; unknown delivery is not silently retried.

The hosted test now requires **QC itself** to be running when the human barrier is armed and when the QC's own UI Steer is acknowledged. It also tests four live cards, compact/expanded/focused states, keyboard operation, a narrow viewport, public navigation to a second authorized project with no leaked Workflow/Run history, return to the original scope, independent diagnoses/synthesis, explicit single resume and restart/Abort.

Cross-project support is explicit public scope navigation, not implicit privileged cross-project mutations or private host aggregation. The feature does not promise an app-wide fullscreen override.

## Regression map and evidence boundaries

| Layer | Regression |
| --- | --- |
| Pure Workflow and SQLite CAS | `tests/automatic-diagnosis.test.mjs`: threshold/off, human priority, one episode, exact budgets, capacity rollback, tampering, restart and duplicate commands |
| Real deterministic engine | `tests/autopilot-engine.test.mjs`: actual QC-to-hold/diagnosis/synthesis, manual resume, paused generation, failed diagnosis and planner total-capacity regression |
| Actual Pi Harness | `tests/production-runtime.test.mjs`: persisted diagnostic request/tool exhaustion, no provisional success, deadlines and reopen |
| Public production server + real Bubblewrap | `tests/automatic-diagnosis.required.mjs`: two actual readonly model/tool Runs plus synthesis; shared deadline and bounded recorded counters; held state survives server restart |
| Model invocation | `tests/model-boundary.test.mjs`: bounded SDK output, smaller limit preserved, cancellation allowed |
| Exact UI targeting | `tests/run-command-target.test.mjs`: stopped, replaced, cross-scope, disconnected and ambiguous targets |
| Shipped PI WEB + Chromium | `scripts/hosted-acceptance.mjs --mode faux`: actual host/engine/browser/tool/SQLite, scripted provider responses only; no OAuth or remote publication |
| Owner-approved authenticated quartet | same runner with `--mode oauth`, exact clean source SHA and explicit account approval; real result is a separate acceptance receipt |

The planner capacity regression was observed failing before the fix (3 launches instead of the allowed 2 while QC occupied the single slot), then passing without raising the limit. Initial short-lived faux QC observation races were corrected by exact runtime observation followed by a real browser snapshot refresh, not by fabricating events or weakening acceptance.

## Deliberate exclusions

No production daemon, OS policy, credential scope, arbitrary model choice or other system's native Session/Worktree deletion is changed. #2's native-runtime-specific qualification, #5's screenshot/knowledge promotion work, #86 deployment qualification, #89 ownership-aware physical lifecycle and parent trackers remain independently scoped. Passing these regressions is not a universal safety guarantee.
