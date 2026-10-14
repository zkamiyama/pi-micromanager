# ADR-0018: Runtime, deployment and evidence ownership

Status: Accepted design; implementation and deployment evidence are tracked separately.
Date: 2026-10-14
Parents: ADR-0001, ADR-0003, ADR-0016, ADR-0017; Issues #36, #37, #38.

## Context

Micromanager is a small deterministic control plane on Pi and PI WEB, not a
replacement agent runtime, identity provider, container platform or universal
backup service. The original #36/#37/#38 findings mix product requirements,
execution-platform mechanisms and deployment acceptance. Leaving them combined
makes it unclear what code can satisfy and what requires operator evidence.
Splitting responsibility does not remove a risk or relax an existing gate.

## Decision: policy here, enforcement mechanisms below, evidence at the boundary

| Concern | Micromanager/product owner | Runtime/platform/operator owner |
| --- | --- | --- |
| Run authority | DAG/QC/approval, exact identity, generation, budgets, idempotency, persisted outcomes | Execute the admitted operation through a supported runtime |
| Isolation | Require an identified supported backend, exact Workspace, denied capabilities, cancellation and joined completion; refuse unsupported or unproved execution | OS process/files/network isolation, separate identities as needed, patched kernel/runtime, hard resource quotas |
| Credentials | Select a provider/model and approval scope; never replicate OAuth/token stores or expose publisher credentials to tools | Pi/PI WEB credential handling; test/production separation; rotation, revocation, ingress authentication/TLS |
| Resource limits | Concurrent Run/request/retry limits; storage accounting, warning/admission stop policy | cgroup CPU/RAM/PID controls, filesystem quotas, provider spend limits |
| Retention | Know why evidence is referenced; pin active, uncertain, approved or externally unreconciled data; produce bounded dry-run proposals | Physical reclamation by the data's owner through a supported API |
| E2E | Versioned harness, failure assertions, exact-commit evidence and documented support matrix | Approved disposable host, test-only identity, billing cap and any real external acceptance run |

### #36: execution backend contract, not a new execution platform

Current production scope remains the trusted Pi/PI WEB control process and
its supported Linux Bubblewrap tool/test boundary. The Pi model/provider loop
and publisher are trusted host components; sandboxed tools do not make that
whole process untrusted-code-safe. A generic remote/container backend is not
claimed implemented by this ADR.

The product must not accept a workflow's assertion that it is isolated. A
host-owned adapter must bind the exact workspace, tools, model and Run identity,
validate its supported capabilities, and propagate cancellation. No fallback
to native/unconfined execution, no lock release before joined shutdown, and no
successful outcome when completion is uncertain. Existing Bubblewrap, Git,
ownership, permissions and production-mode guards remain mandatory.

Operator hardening has its own checklist: low-privilege/dedicated identity,
credential separation, outbound policy, patched host, CPU/RAM/PID/disk quotas
and a real isolation probe on the target host. An approved workflow, label,
configuration flag or green CI run is not proof of these deployment facts.
Unsupported operating systems/backends remain explicitly unsupported rather
than silently weakening the contract. Missing upstream lifecycle APIs are
tracked as integration work, not replaced by private-route calls.

### #37: ownership-aware lifecycle, not arbitrary filesystem GC

The product owns Workflow/Run metadata, evidence references and its public
activity projections. It must retain the facts required to reconcile uncertain
operations. It may propose reclamation of its own unreferenced derived data,
with manifest/digest, lease/revision, dry-run and explicit confirmation checks.

Pi/PI WEB session stores and Git worktree administration belong to their
respective owners. No deletion of another owner's JSONL/SQLite directory and
no guessed private API. A managed Worktree may be retired only after checking
current Git registration/HEAD/branch, active and unsealed leases, dirty/unpublished
changes and external publication outcomes. If an owning API or proof is absent,
retain it and report unsupported/pending reconciliation.

Initial support may intentionally be usage reporting, bounded admission and
manual cleanup, not unattended destructive GC. Retaining everything is not a
capacity policy: storage thresholds must be visible and admission may stop
before depletion. Hard quotas are a platform responsibility; logical counters
do not replace them. The existing quarantined fresh-root restore stays separate
from GC, and no automatic unquarantine is introduced.

### #38: three assurance tiers, never relabel mocks as authenticated E2E

1. **Deterministic integration:** disposable Git/SQLite, public server/SDK calls,
   faux model and simulated GitHub transport; exercise failure/restart/abort and
   exact-publication gates without credentials or real external mutations.
2. **Runtime/isolation:** real supported Pi Durable and Linux sandbox processes;
   require actual namespace success, shutdown and recovery; no skip as evidence.
3. **Approved authenticated acceptance:** reviewed default-branch commit, exact
   provider/model, explicit test-only authentication and billing authorization,
   private disposable state, bounded calls/time, no implicit default model/auth.
   A structured receipt identifies the tested commit/versions and which cases
   actually ran. Raw transcripts, paths, tokens, tool arguments and provider
   error bodies are not uploaded.

The harness belongs in this repository. Provisioning and executing with a
real test identity is separate operator acceptance, not an everyday application
feature and not a reason to reimplement authentication. A thin native SDK
adapter is preferable to a parallel agent loop. Fully hosted PI WEB/browser
and real remote publication acceptance are separate cases, not implied by an
SDK-only smoke test. They require their own disposable target and reviewed
least-privilege authorization; the model-only job has no repository-write scope.

Credential-bearing jobs must not execute unreviewed PR code. Environment review
is an authorization gate, not an OS sandbox. Self-hosted runners need independent
isolation/ephemerality evidence; no label alone certifies them. Test fixtures and
receipts have explicit owners and bounded cleanup, after all execution joins.

## Tracking and completion

Keep #36/#37/#38 as parent trackers and preserve their original acceptance text.
Create children by product/integration/deployment responsibility; link every
original requirement to a child or a previously verified change. A code child
may close after scoped regression and exact-head CI evidence. Deployment, real
authentication, browser and remote-publication children stay open until their
own evidence exists. Parent closure requires all retained acceptance items or
an explicit reviewed scope decision; a split itself is not completion.

### Split tracking map

- #36: product/backend contract #85; actual isolated host and hard quotas #86.
- #37: admission/capacity #87; owned-evidence retention #88; external owner-API lifecycle #89; platform quota dependency #86.
- #38: bounded test harness #90; real test-only authentication #91; hosted browser and remote-publication acceptance #92.

Original parent requirements remain visible. See [E2E acceptance](../E2E_ACCEPTANCE.md)
for tested tiers, exact source/lock versions and what remains unverified.

## Non-goals and consequences

No custom OAuth manager, general container scheduler, credential-provisioning
service, universal session GC, machine backup or multi-tenant security claim.
No production restarts, deploys, data migration or test billing are authorized
by this document. The benefit is a bounded product and auditable integration
contracts; the cost is deliberately narrower supported deployments and visible
operator prerequisites. Security obligations remain, with explicit owners.

## References

- GitHub Actions secure use: https://docs.github.com/en/actions/reference/security/secure-use
- GitHub environments: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- Local implementation and limitations: ../../SECURITY.md

## Local acceptance disposition (2026-10-14)

For the owner's current development trial, accept a documented local execution
record instead of GitHub Environment/job evidence. The owner expressly permits
reuse of the existing Pi ChatGPT OAuth identity, Luna Low for ordinary tests and
Luna Max for independent QC, and same-repository test-only source/base branches.
See [authorization](../LOCAL_LUNA_ACCEPTANCE_AUTHORIZATION.md).

This changes the **approved test profile**, not any runtime security setting:
main/release refs are never synthetic-test destinations, credentials remain
outside tools/logs/commits, no live services are restarted, and no result is
certified until actually executed. Existing-account/branch tests do not prove
separate tenant/credential isolation. A tool refusal is respected, not routed
around; [current results](../LOCAL_LUNA_ACCEPTANCE_STATUS.md) are partial and
#91/#92/#38 remain open. The automated API-key CI profile remains unchanged.

## Hosted acceptance adapters and final-integration authority

The product may accept an optional host-owned, metadata-validated credential
source path (`modelAuthFile`) so a separate test/runtime state root need not
mount or copy the operator's whole Pi profile. Authentication remains owned by
the public Pi SDK. A Workflow cannot grant this authority or expose it to tools.

Final Git integration's allowed source SHAs are a persisted broker capability,
not an already-integrated ancestry precondition. Capture them from exact accepted
source QC, recheck at the host executor and retain the same immutable list across
recovery. A legacy missing capability requires reconciliation, not a fallback.

Product E2E uses actual shipped host executables, registered plugin lifecycle,
public browser peer and a test-owned public host-execution wrapper for loss
injection. It does not call private PI WEB HTTP routes. A credential-free
rehearsal may substitute the model and remote transports only when its evidence
says so. Actual user-approved Luna and GitHub results remain a distinct acceptance
gate. See [hosted acceptance](../HOSTED_E2E_ACCEPTANCE.md).
