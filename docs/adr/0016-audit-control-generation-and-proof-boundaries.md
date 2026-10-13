# ADR-0016: control generations, execution leases and final proof boundaries

- Status: Accepted (supersedes conflicting admission/merge details in ADR-0007, ADR-0012, ADR-0013 and ADR-0015).
- Date: 2026-10-14
- Scope: Residual audit R01–R23; see [remediation matrix](../AUDIT_REMEDIATION_R01_R23.md).

## Context

Local integration, GitHub merge completion, operator admission and public progress are different facts. Treating one as another allowed misleading completion, late re-enabling after Pause and inconsistent recovery. Individually bounded IDs/prompts did not imply a bounded executable composed plan. A host executing mutable tests is not automatically a safe verifier.

## Decision

1. Use a monotone durable control generation for explicit Start/Pause/configuration. Every awaited admission validates that generation. Progress text cannot change the operator's control decision through an old snapshot. In-flight observations can preserve facts without authorizing a new side effect.
2. Use a shared SQLite lease for host convergence and agent admission, keyed by host-resolved physical Workspace identity. Hold affected leases through preflight, Git mutation and proof. Retain leases for unresolved reserved Git operations; never let an uncertain write silently release the checkout.
3. Generic local integration cannot advance the final system Task. Global upstream integration requires all configured dependent checkouts, while final completion requires exact GitHub MERGED observation. Observation is independent of automatic-merge consent.
4. Do not authorize future native auto-merge in new executions. Use synchronous GitHub REST merge with exact head SHA, ordinary protection and verified checks. Definite policy refusal is retryable waiting; ambiguous results are not blindly replayed. Cancel/re-read legacy owned deferred requests on Pause or a failing publication preflight.
5. Default mutable repository tests to a real Linux Bubblewrap namespace without host credentials/home/network. Retain an explicit trusted-host compatibility mode and document that worker-runtime OS isolation remains a separate requirement.
6. Validate the entire execution plan before creating Worktrees or running models: combined task/workspace quotas, dynamic/final slot budgets, executable DAG shapes and complete prompt contracts. Required source criteria are never silently truncated. Durable final QC pages complete source contracts and persists digest-bound retrieval receipts.
7. Provide explicit reasoned recovery actions. QC budget extensions preserve prior failed evidence. A configured automatic Run may resume only after zero-input proof, using the original frozen host-built job and original Session, never a reconstructed or replacement input after an uncertain send.
8. Keep scheduler inventories separate from bounded UI projections. Paused quick goals remain observable/resumable and journals select their Workflow before applying projection limits.

## Consequences

The default Linux sandbox may expose missing build dependencies/toolchains previously inherited from a daemon home. This is visible failure, not permission escalation; operators must deliberately prepare a suitable execution host or review trusted-host mode. A clean Git tree still does not fingerprint every ignored dependency or external system input, and no universal reproducibility guarantee is made.

Some expressible DAGs remain unsupported by automatic ff-only propagation. They now fail at admission, with deliberate optional linearization, rather than incurring implementation costs before stalling. Native prompt overflows also fail at admission; paged final contract retrieval is a Durable capability.

Legacy configured Runs without frozen inputs remain manual-reconciliation cases. Actual browser/production-daemon E2E, kernel hardening and cross-host deployment are not inferred from CI. Broad arbitrary worker-tool isolation remains tracked separately in issue #36.
