# Adversarial orchestration and intervention verification

- Status: In CI on PR #9; no authenticated real Pi/PI WEB performance certification
- Scope: Deterministic Task DAG transitions, one-shot Pi Session reservations,
  shared per-Workflow concurrency limits, QC barriers, bounded retries,
  cancellation/restart behavior and Git evidence gates.
- Run on the checked-out branch: `npm run test:adversarial`.
  The regular `npm run check` includes the same tests plus all existing
  Worktree, real-Git, GitHub publication, and server-plugin integration tests.

## Model of concurrency

`maxParallelByRole` limits *logical parallel occupied seats within one
Workflow*, not the aggregate number of sessions across multiple projects.
Implementation Tasks occupy the implementer role from authoritative
`start` until their implementation settles and transitions to QC.
Review capacity is shared by implementation-QC Pi Sessions and
reviewer-role diagnosis Tasks, including a diagnosis Task reserved as
`running` before its host Session exists. Planner capacity is shared by
Sol intervention-planning Pi Sessions and synthesis Tasks. Architect
diagnoses independently obey the architect cap.

For reproducibility, deterministic mock hosts and actual
`WorkflowStore`, `AgentRegistry`, `AutopilotLedger`, and
`AutopilotEngine` are used for admission, SQLite, evidence, Run identity
and scheduler ticks. Tests use seeded pseudo-random event order, not wall
clock sleeps. A provider's stream timing, model quality, live browser or
repository remote policy are **not** measured by these tests.

## Adversarial matrix

| Scenario | Invariant asserted |
| --- | --- |
| 96 QC barrier permutations | QC pass/fail × planner completion before/after QC × intervention requested in ready/running/awaiting-QC × decision × independent unrelated Task; dependent branch is held until correct human release |
| 4 before/after QC cancellations | A cancelled unactivated barrier restores the proper QC state, never alters immutable SHA/evidence; late planner output cannot reactivate it |
| Wrong QC Run / stale evidence | Reject mismatched frozen QC ID and block downstream mutation without incrementing revision |
| Two independent human interventions | Releasing one target never releases another held branch or common join prematurely |
| Exhausted QC budget | `rework` rejected after the last allowed QC; failing QC cannot become a pass via human `accept_pass` |
| Reviewer / QC contention | A running QC uses the reviewer quota; a ready reviewer diagnosis may not start, and vice versa |
| Sol / synthesis contention | A live `plan-*` session consumes planner quota before a synthesis Task may start |
| Two simultaneously requested Sol plans | Planner limit=1 admits at most one live plan; second is admitted after first settles |
| Four independent investigators | Max two architects and one reviewer are fully utilized; no fourth is admitted prematurely; synthesis/human hold remain gated |
| 32 independent implementation branches | Reach 8 concurrent implementation Sessions and 4 independent QC Sessions without exceeding either limit |
| Eight seeded 16-Task workloads | Randomized completion orders, bounded first-QC failures and rework; all complete; no duplicate Run IDs or shared concurrent code Worktrees |
| 120 simultaneous scheduler ticks | One authoritative start CAS and one host launch per unique Pi Run, despite reentrant triggers |
| Malformed Task kind/role | Wrong modifying/review/planning seat assignments are rejected at DAG validation |
| Existing real Git convergence suites | Fan-out ff-only, divergent checkout refusal, uncertain merge recovery, readonly QC evidence, no unproved GitHub merge |
| Existing restart/public plugin suites | Same-session recovery, report replay, no blind Pi turn retry, held human decisions and publication approvals |

## How to interpret results

The saturation assertions prove the system can **reach the configured
parallel seat limits without exceeding them**, under deterministic
mocked Agent completion. They do **not** benchmark wall-clock optimality:
the current PI WEB scheduler still advances a bounded number of
authoritative actions per tick and Pi startup/model latency is
provider-dependent. The mock host has no real provider/API rate limits,
GPU limits, browser rendering, OS scheduling, or GitHub/CI latency.
For actual throughput measurements, record active Pi Sessions over time
on the target machine with representative models, then compare to
configured role capacities and quota/rate-limit responses.

The tests cover a single PI WEB server-plugin owner for each Workflow.
They do **not** prove multi-daemon distributed exclusion, protection
against malicious Pi shell subprocesses, or production readiness.
An authenticated real Pi/PI WEB/GitHub E2E and resource-constrained
host soak test remain necessary for those claims.

If any invariant fails, the CI job is red; the test name and the seed
of randomized workloads identify the reproduction. Do not override
or merge a failing branch because older CI on main passed.
