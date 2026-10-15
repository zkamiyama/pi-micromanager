# ADR-0019: Bounded product capabilities and remaining-issue disposition

- Status: **Accepted design, effective when this ADR was merged to main.** Future contracts below are not claims that corresponding APIs exist or acceptance is complete.
- Date: 2026-10-15
- Scope: #2 / #3 / #4 / #5 / #36 / #37 / #86 / #89
- Research baseline: code and lockfile at `7f8ab4a2ca037496a36becab154bcb97ca20ef4b`, Issue requirements, existing ADRs and public SDK contracts.
- Relationship: supplements ADR-0001/0002/0003/0004/0009/0010/0016/0017/0018. Historical implementation-status statements are not current facts.
- Change scope: decisions, responsibilities and acceptance criteria only; no runtime permission, setting, existing data or Issue-state changes follow automatically.

> **Subsequent owner decision:** [ADR-0020](0020-local-owner-durable-product.md) narrows the release to one owner's Windows/WSL localhost tool with Durable-only supported automation, local artifacts and Git ADR links. It explicitly supersedes native-parity, dedicated ADR-publishing and generic deployment requirements where stated. The original reasoning below is retained, not silently rewritten into a claim of completed implementation. Later #3/#4 acceptance is recorded [separately](../ADR19_DIAGNOSTICS_AND_COCKPIT_ACCEPTANCE.md).

## 1. Decision summary

**Micromanager is a small control plane deciding who may do what next, on which evidence and authority, while giving a human direct observation and intervention. It does not reimplement Pi's execution loop, PI WEB host management, OS isolation or Git Worktree administration.**

Delegation is not abandonment of responsibility: Runs initiated, operations sent and evidence pinned by Micromanager still need exact identity, authorization, joined completion and reconciliation. When a public owner capability is missing, report unsupported behavior rather than weaken guarantees to make it look equivalent. [R1][R2][E1]

Flexibility means a small common mandatory contract, explicit additional capabilities, and support only for verified combinations. It does not mean pretending that every backend has identical semantics.

| Issue | Decision at this ADR's baseline | Outside this layer |
| --- | --- | --- |
| #2 | Use Pi Durable as the production path; keep native Pi as an explicit compatibility adapter with separate qualification | Universal runtime equivalence, custom OAuth/model loop, implicit fallback |
| #3 | Flat observation and direct intervention are core product value; implement them within PI WEB public panels | Host-DOM takeover, separate authentication/UI platform, implicit cross-scope aggregation |
| #4 | Finite opt-in deterministic diagnostic admission; separate automatic diagnosis from human resume | An LLM increasing its own privileges or QC budgets indefinitely |
| #5 | Own evidence manifests, references/pins, Journal and reviewed knowledge promotion; capture is an adapter | Continuous screen recording, general backup, GC of other owners' Sessions |
| #36 | Map #85 product controls to #86 target-host qualification | Another isolation engine or universal safe-environment flag |
| #37 | Track admission, owned retention, external lifecycle and hard quotas separately | One global cleanup operation or calling logical limits hard quotas |
| #86 | Operator qualifies one explicit target profile; product supplies contracts and diagnostics | Root-level OS reconfiguration, kernel repair or generic container orchestration |
| #89 | Separate Pi Session and Git Worktree adapters; invoke only supported owner operations with evidence | Raw native JSONL/SQLite deletion, private routes or age-only destructive GC |

Adopting this ADR does not close all eight Issues. Distinguish implemented slices, intentional non-support, deployment work and future capabilities.

## 2. Observed facts and rationale

### 2.1 Repository facts at the research baseline

| Observation | Evidence | Architectural consequence |
| --- | --- | --- |
| `src/core/` has no Pi/PI WEB dependency; `ExecutorPort` is the execution boundary | [R1][R3] | Do not duplicate state transitions per host/model |
| New Autopilot settings default to `durable`; production refuses native Sessions | [R3][R4] | Provider neutrality is not universal runtime qualification |
| Transition boundaries require persisted successful outcomes, not `settled` UI text or provisional reports | [R4] | An LLM explanation is not authority or completion proof |
| Retention currently reclaims owned derived public-activity rows | [R5] | Generic Session/Worktree deletion is not thereby complete |
| Existing screenshots are checked against the exact QC commit; ADRs are staged in a review Worktree | [R6] | Import, capture and PR publication are separate capabilities |
| A scoped actual Pi OAuth/Luna Low, QC Max, PI WEB and GitHub recovery trial passed | [R7] | Do not extrapolate #92 to native parity, four-Run direct QC intervention, general operations or GC |

### 2.2 Fixed-version public API inspection

The investigation used `npm ci` with locked PI WEB **1.202610.2** and Pi SDK **1.2.0**, inspected the shipped `.d.ts` files, and compared public source at PI WEB's published `gitHead`, `2d65b5f800f832f6f8b866bde493ba1b3763d960`. This is evidence about that version, not a guess about every future API. [R8][R9]

- `PiWebHostPiSessionsV1` provides `create` and `run`. The `run` input has no model/effort setting; its completion represents the initial input, not every later turn.
- `PiWebHostPiSessionEventsV1.connect` provides `on`, `emit` and `close`. Emit is fire-and-forget, not delivery or success proof. Closing the connection does not stop the Session.
- `PiWebHostWorkspacesV1.resolve` re-resolves opaque project/Workspace IDs as an authority boundary.
- `PluginRuntimeContext.archiveSession()` is a contextual, argument-free browser action, not an arbitrary exact-ID server GC contract carrying preconditions, operation identity and completion proof. Do not assume every panel has it.
- `WorkspaceProvider.prepareRemove()` belongs to the provider owning that Workspace and returns a plan for host-visible terminal execution. A returned plan is not completed removal or another plugin's authority to remove arbitrary Workspaces.
- Public Workspace/Application panels and navigation do not automatically grant a full-width host replacement or access to every Workspace.

An API's existence and the current caller's authority to use it on a particular resource are different questions. The following decisions address that gap without inventing private capabilities.

## 3. Cross-cutting contracts

### 3.1 Separate ownership from typed operations

Use `(machine, project, orchestra, workflow, task, attempt, run)` as the common business identity and bind it explicitly to `backendId` and the external Session ID. A UI selection or filesystem path alone is not authority. Thin adapters translate external identities/states without reimplementing DAG/QC rules. [R3][R8][E1]

Additional capabilities can be expressed per operation, such as `steer`, `followUp`, `cancelAndInspect`, `readCommittedOutcome` or `retirementPreview`. These are **proposed logical contract names**, not claims about existing SDK methods. Return backend version, verified scope and unsupported reasons, not just `supported=true`. Do not accept a model/Workflow's self-declared `isolated=true`.

Bind each side effect to current permissions, control generation, exact target, expected SHA or evidence fingerprint, expiration and stable operation ID. Recheck after slow preflight. Ownership loss stops new side effects; retain ownership until active processing has joined. [R2][R4]

### 3.2 Distinguish delivery, completion and atomicity

Represent `requested -> acknowledged -> completed/failed/uncertain` separately. A missing ACK after timeout is not proof of non-execution. Reject a different payload under the same operation ID. Restart must not invent a new identity and resend an old mutation. [R4][E2]

Keep related SQLite decisions, reservations and receipts in one transaction where possible. Do not promise a single ACID transaction across multiple databases, Git, browsers and external APIs. If a crash separates reservation, execution and recording, inspect external state and retain `uncertain` unless completion can be proved. A missing resource alone is not proof that this controller removed it. [R5][E2][E3]

Use “exactly once” only for an observed test scope, not as an unconditional guarantee under arbitrary partitions and external services.

### 3.3 Separate capability, authorization and measured evidence

Expose implementation, policy permission and target-profile verification independently: for example `implemented`, `allowed`, `verified-on-profile`, `unsupported` and `not-verified`. Re-evaluate evidence when configuration, dependency version, target root, permissions or validity period changes. A valid signature does not make old or inaccurate facts current.

A readiness `pass` is not a universal production certificate. While execution admission is blocked, retain authorized viewing, Pause, Abort, reconciliation and capacity inspection where safely possible. Preserve current fail-closed behavior and isolation. [R2][R4]

## 4. Issue decisions

<a id="issue-2"></a>
### 4.1 #2 — Execution adapter: common Run contract, backend-specific qualification

**Decision at the baseline:** use the public Pi Durable SDK with host-owned Linux isolation and fixed Git broker as the production path. Native `pi-web` is explicit compatibility only; do not remove production refusal or fall back to it after Durable fails. [R3][R4]

Provider/model/effort are data inside host allowlists. Display roles such as Luna, Sol or Astra are not runtime branches or authentication mechanisms. An observed Luna trial qualifies that combination, not every provider or native Session. [R7]

A supported native path must implement `create -> subscribe/connect -> configure -> persisted ACK -> prompt`. Because the public bus has no delivery guarantee, correlated companion requests and persisted results belong in the adapter. Keep existing Runs' backend fixed. Migration needs new Runs or an explicit plan; lease expiry alone cannot establish that a process/Session never executed. [R8][E2]

**Rejected alternatives:** a Codex-only CLI loop, another model loop around Pi, an immediate generic framework for every backend, or disguising native semantics as Durable. Narrow adapters contain SDK-change impact and share the existing state machine. [R1][E1]

**Implementation/acceptance:** test explicit/mismatched/delayed/duplicate ACKs, Workspace authority, ownership loss and restart. For each supported backend, exercise two separate modifying Workspaces and an independent QC Run through actual PI WEB, including model setup and no-duplicate recovery. Unsupported native capabilities require explicit refusal/display, not a production claim. Physical lifecycle belongs to #89. ADR-0020 subsequently removes native parity from the release scope and accepts the independently verified Durable adapter; it does not certify untested native behavior.

<a id="issue-3"></a>
### 4.2 #3 — Cockpit: core product value, not a host replacement

**Decision:** invest in flat observation of actual Runs and direct human control. `compact/expanded/focused` are per-Run presentation preferences, not model context or authority. Start with a selected-Run inspector within public panels, not host-DOM takeover or a separate Web authentication platform. [R1][R9][R10]

Bind commands to the exact selected Session/Run, including direct QC Steer without planner mediation. The server rechecks current scope/generation immediately before execution. If the Run ended or the user changed scope, do not redirect to a “nearby” role. Disable unsupported actions with reasons. Display receipt, completion, refusal and uncertainty distinctly; disconnect is not automatic resend permission.

Views are derived, not replacements for Workflow/Run ledgers. On reconnect, reconcile snapshots and cursor/sequence; when the bus lacks replay, resubscribe and obtain a fresh authorized snapshot. Do not fill gaps with fabricated activity or invented transcripts. [R5][R8][R10]

Start multi-project support with public navigation and authorized read-only summaries. Resolve the selected Workspace again before action. Without a public authorized aggregate capability, do not use private endpoints or cross-scope caches. Revisit full-width/separate screens only for demonstrated user need and available public host support.

**Rejected alternatives:** fictional permanently running role cards, full token/image duplication, planner-mediated human commands, a PI WEB fork, and separate Workflow truth per view. These separate the display from actual capability. [R1][R10]

**Acceptance:** display four genuinely concurrent authenticated Runs, compact writers and expanded/focused QC, and an acknowledged UI Steer to **that running QC**. Test view switches, end-of-Run races, revocation, disconnect/reload, narrow screens, keyboard access and cross-project leakage. Four faux Runs plus a separate two-Run real-model test do not together prove this acceptance. The later actual result is [recorded separately](../ADR19_DIAGNOSTICS_AND_COCKPIT_ACCEPTANCE.md).

<a id="issue-4"></a>
### 4.3 #4 — Automatic diagnosis: policy in the core, inference in Pi

**Decision:** diagnosis admission is deterministic Workflow policy, off by default and finite when explicitly enabled. Use typed QC results, not free-form statements such as “try again,” as authority. Human hold, Pause and Abort always take priority. [R11]

| Dimension | Initial design |
| --- | --- |
| Trigger | A configured number of explicit `fail` verdicts from normally completed, committed QC matching current attempt/SHA/criteria |
| Never trigger for | Authentication errors, sandbox refusal, budget/capacity exhaustion, uncertain outcomes, disconnect, mere inconclusive verdicts or human hold |
| Count | At most one automatic episode per Task, with no implicit reset |
| Structure | Two separate read-only diagnostic Runs and one synthesis using allowed model profiles |
| Budget | Reserve episode request/time/output/Run bounds inside host/Workflow totals; diagnostic failure cannot spawn endless episodes |
| Resume | Synthesis proposes only; implementation/publication stay held until explicit `resume_after_diagnosis` |

These were design values when adopted, not declarations that a setting already existed. Identify reaction to a QC event by `(workflow, task, attempt, qcRun, policyRevision)`. Serialize QC finalization and diagnostic hold/reservation using Workflow revision. External Run submission is a separate step; failure after a persisted reservation does not justify blind resend. [E2][E3]

Both diagnostics read the same frozen evidence without consuming each other's answers first. Independence describes execution/input separation, not statistically independent errors from the same model. A failed or exhausted investigator leads to human attention, not a substituted majority vote. Models cannot directly change permissions, criteria, QC budgets or the Workflow.

**Rejected alternatives:** escalating on every failure, automatic resume after synthesis, model-authored privilege/Task/attempt increases, or a general rule language. These increase complexity and spend and undermine human precedence. Keep automatic diagnosis while preserving deterministic admission and explicit human resume.

**Acceptance:** unchanged behavior when off; finite behavior under thresholds, duplicate/delayed QC, Pause races, restart, one failed investigator and budget exhaustion. Actual browser/authenticated Pi must show intervention during QC, hold, two diagnoses, synthesis and one explicit resume. Successful final QC in #92 is not deliberate-failure escalation evidence. Later implementation and its separate real/faux proof scopes are documented in the [feature](../ADR19_DIAGNOSTICS_AND_COCKPIT.md) and [acceptance](../ADR19_DIAGNOSTICS_AND_COCKPIT_ACCEPTANCE.md) records.

<a id="issue-5"></a>
### 4.4 #5 — Journal and knowledge: own evidence meaning, separate generation and deletion

**Baseline decision:** Journal projects bounded facts; artifacts have integrity-checked references; durable architecture knowledge belongs in the **target project's Git repository**. Do not continuously copy native Pi transcripts or the user's entire screen. [R6][R12]

Separate four contracts, not necessarily four services:

1. **Evidence ingestion:** producer ID/version, source SHA, test/build ID, time, content hash/size, scope, disclosure and retention class. Distinguish observed facts from producer assertions.
2. **Capture adapter:** optional test-browser/Playwright capture on an allowed origin/scope, without personal browser cookies or HOME. Bind a capture request to its result.
3. **Projection/retention:** small Journal and on-demand images. Thumbnails carry their own digest, original reference and transformation version; retain source scope and never automatically send images to models.
4. **Knowledge promotion:** human input or finite candidate rules do not grant authority. Under this ADR's original proposal, pin reviewed content/target and separately stage/commit/push/create Draft PR/reconcile. **ADR-0020 subsequently replaces a dedicated publisher requirement with ordinary Git-managed ADRs and verified Journal links.**

Preserve existing exact-QC-commit tracked-image import. Future capture need not put every image in Git, but it needs a separate capture-manifest contract and regressions for source SHA, test, producer and digest. Do not weaken the existing importer to accept arbitrary untracked files. A hash proves byte identity, not a truthful capture or secret removal. [R6]

Optional capture may be suppressed under capacity pressure. Missing mandatory image evidence cannot be ignored to produce PASS. Best-effort redaction is not a secrecy guarantee; retain operator review and scope controls. Private raw diagnostics remain under their separate policy, not automatically exposed in Journal. [R5]

Treat hot/warm/permanent as retention reasons, not mechanical TTL alone. Prioritize running/held/uncertain work, unresolved publication, ADR review, audit and manual pins. When required evidence fills storage, stop new admission/optional capture rather than erase it. Provide pin inventory and human attention instead of choosing between unbounded retention and unconditional deletion.

ADRs must not rely solely on disappearing logs. Keep conclusions, alternatives, constraints, verification and residual assumptions self-contained, with stable commits/PRs and minimum evidence references. The original publication proposal required separate approval bound to repository/base/path/content hash, not reuse of code QC approval. Stage, PR open, adoption/merge and rejection are distinct facts. ADR-0020 preserves that distinction while using normal reviewed Git rather than a dedicated publishing engine. [R6][R13][E2]

**Rejected alternatives:** per-token LLM Journal rewrites, continuous screen recording, general blob/backup infrastructure and mixing native Session deletion into artifact TTL. These add disclosure, storage and irreversible authority without matching product value.

**Original acceptance:** show a synthetic application's image with test/source links; reject tampering, cross-scope reads and oversized images; protect active/pinned data; match preview to confirmed deletion; reconcile lost receipts; record an actual reviewed target-repository ADR PR and retain its meaning after short-lived detail expires. Native lifecycle is separate in #89. **The owner-approved ADR-0020 scope replaces the dedicated ADR-PR/native-lifecycle portions; local images/log budgets and verified Git links still require implementation and tests.**

<a id="issue-86"></a>
### 4.5 #86 — Host qualification: one explicit profile

**Decision:** platform/operator responsibility, with product contracts, read-only diagnostics, finite harmless probes and an evidence schema. Do not acquire root, reconfigure cgroups/firewalls, repair kernels or restart existing OS/services automatically. Keep OS-specific enforcement out of the deterministic core. [R2]

The original proposal qualified one explicit single-tenant Linux profile, distinguishing trusted control/provider/publisher components from restricted worker file/shell/test execution. A shared trusted process is not separate credential isolation merely because documentation calls it so. A deployment requiring separate processes remains unqualified until that boundary exists and is tested. [R4]

Process-group limits such as `cpu.max`, `memory.max` and `pids.max` belong to OS controllers; capacity scans and single-process rlimits do not replace them. Cgroups are not file-access isolation or disk-capacity quotas, so mounts, identities, networks and filesystem limits require distinct evidence. [E4]

Bind observations to host/image identity, software/lock SHA, kernel/runtime, effective limits, ingress/auth scope, time and expiry/change conditions. Product settings and measured target facts are separate. Do not label unknown, stale or drifted evidence as verified or describe a future attestation verifier as already implemented.

Do not automatically pass developer credentials to self-hosted CI on public repositories. Repository visibility and Environment approval are not execution isolation. Credential-bearing acceptance requires reviewed SHA, explicit authorization, limited targets and a clean test environment. [E5]

**Rejected alternatives:** universal Linux/WSL/container certification, a `production=true` safety flag, `--no-sandbox`, or a root-level repair-everything doctor. A narrow target is reproducible.

**Original acceptance:** prove worker exclusion from credential file/env/network paths, resource-exhaustion behavior, descendant stop, ownership recovery, ingress/TLS responsibilities, updates and independent review on the selected target. A development WSL restart or #92 loopback trial did not qualify every eventual deployment. **ADR-0020 now selects the owner's Windows/WSL localhost profile and explicitly excludes generic SaaS/tenant/TLS qualification.** Its retained isolation, authority, stop/restart and finite-resource tests remain necessary; unknown universal deployment requirements should not indefinitely block unrelated source/documentation work.

<a id="issue-89"></a>
### 4.6 #89 — Lifecycle: independent Session and Worktree ownership

**Decision:** requesting creation and owning physical lifecycle are not the same. Micromanager manages references, pins, retirement candidates and authority; physical changes use the appropriate public owner contract. Sessions and Worktrees must not become one arbitrary `delete(path)`. [R2][R8][R9]

**Native Pi/PI WEB Sessions, original scope:** the fixed public server capability lacked general archive/delete/status-with-receipt. Inventory, hold reasons and navigation to the exact human-managed Session could precede an upstream contract for opaque ID, generation/lease, stop state, archive hash, operation ID and inspect/receipt. Do not use argument-free browser `archiveSession()` as arbitrary background cleanup or invent unavailable SDK methods. **ADR-0020 removes human native Session lifecycle from this product's release scope; it is no longer a blocker for owned resources.**

**Managed Git Worktrees:** Git already exposes list/remove/lock, so all Worktree work need not wait for a native Session API. Limit operations to exact controller-created, recorded Worktrees. Check Git registration, canonical root, branch/HEAD, dirty/untracked/ignored data, submodules, unpublished commits, PR outcome, other Run references and authority. Initial automatic reclamation excludes `--force`, main, unrelated Worktrees, unproved orphan candidates and remote-ref deletion. [E6]

Git cleanliness does not establish that no valuable or unpublished data exists. A Micromanager lock does not automatically exclude arbitrary manual Git users. Require final rechecks and an appropriate exclusive maintenance boundary; otherwise remain preview/manual-only. Do not rename registered Worktrees into a quarantine directory outside the owner's lifecycle contract.

The proposed protocol is `inventoried -> proposed -> approved -> reserved -> applied -> reconciled`, with `uncertain/retained` available on failure. Archive required evidence and verify hashes first; persist deletion intent before mutation; recheck exact target last. Keep receipts long enough to reconcile delayed responses. Absence alone is not success and restart does not replay an ambiguous deletion. [E2][E3]

Own derived public activity continues to use #88's atomic deletion/receipt, separate from external lifecycle. Orphan discovery means investigation is needed, not deletion is allowed. Quarantine should initially be metadata-only, without moving another system's resources. [R5]

**Rejected alternatives:** raw native JSONL/SQLite removal, private host routes, age-only TTL, treating an empty lookup as completed deletion and forced Git removal. The evidence/recovery loss outweighs convenience.

**Acceptance:** separately test unsupported owner operations, wrong IDs, dirty/ignored data, active/unsealed/uncertain/pinned resources, concurrent edits, archive tampering, interruption, lost replies, restart and unrelated-resource preservation, using only newly created disposable resources. Under the later owner decision, native deletion is excluded, but actual owned Worktree/Durable retirement still needs its own proof; merely declaring an API unsupported does not complete that remaining implementation.

<a id="issue-36"></a>
### 4.7 #36 — Isolation parent: connect product and target evidence

**Decision:** do not introduce a third isolation implementation in #36. Map #85 product enforcement to #86 target qualification, recording required control, code location, test/target host, remaining trust and expiry. [R2][R4]

Completed product controls do not independently prove every process/credential/tenant/resource boundary. Conversely, an operator checklist cannot replace Workspace/generation/stop checks. Compatibility execution is not a safe fallback when required Linux capabilities are missing.

**Rejected alternatives:** another container scheduler, immediate parent closure from green CI, or duplicating the same enforcement across Issues.

**Acceptance:** map all retained #85/#86 requirements to evidence for the selected profile and state unsupported scope. Parent closure is profile-specific, not certification of every user's machine. ADR-0020 narrows that profile but does not make an untested local-owner implementation complete.

<a id="issue-37"></a>
### 4.8 #37 — Resource/retention parent: no fictional “complete GC” flag

**Decision:** separately track #87 logical/storage admission, #88 owned derived retention, #89 owner-specific lifecycle and #86 platform limits. Show data ownership and deletion authority; do not confuse a capacity display with permission to erase. [R2][R5]

Finite admission, selective optional capture and explicit scoped manual maintenance are valid initial support even without full GC. Document stop thresholds, hold reasons and procedure; do not store forever until exhaustion or offer “clear everything” as recovery.

Retain Run/request/deadline budgets. Cost estimates are monitoring information, not strict provider billing ceilings, and Abort cannot guarantee cancellation of charges for already admitted requests. Recovered capacity permits admission re-evaluation, not removal of uncertain Runs or reserved operations.

**Rejected alternatives:** one TTL for every data class, expanding raw filesystem authority for native GC, or replacing cgroups with logical counters. Resource owners and failure modes differ.

**Acceptance:** finish the retained dimensions independently and show implemented, operated and unsupported status instead of `storageSafe=true`. #87/#88 evidence remains valid. Apply ADR-0020's explicit scope exclusions without pretending that pending local artifacts or owned-resource retirement passed.

## 5. Alternatives considered across the product

| Approach | Benefit | Decision and reason |
| --- | --- | --- |
| Delegate everything to Pi/PI WEB | Smallest Micromanager | Reject: DAG, human holds, QC, exact authority and evidence semantics are product-specific |
| Own all UI/runtime/auth/container/GC mechanisms | Superficially self-contained | Reject: expands attack surface, maintenance and destructive authority and conflicts with upstream ownership |
| Treat all backends as equivalent through a minimum API | Easy portability narrative | Reject: hides cancellation, committed-outcome, isolation and ownership differences |
| **Small business core, explicit thin adapters and measured operator evidence** | Replace components without hiding differences; focus on control and observation | **Adopt**: accept contract-test/support-matrix maintenance and explicit unsupported behavior |

## 6. Implementation order and migration

| Priority | Unit | Minimum deliverable | Relationship to other work |
| --- | --- | --- | --- |
| 1 | #2 Run contract and #3 exact command targets | Contract tests and backend/capability/state visibility, correct-scope direct control | Contain upstream API changes outside the core |
| 2 | #3 four-Run/QC UI and #4 bounded diagnosis | Actual UI acceptance, opt-in policy and stop/restart regressions | Qualify explicit provider combinations, not every model |
| 3 | #5 evidence and durable architecture knowledge | Optional capture/manifest/thumbnail and reviewed knowledge references | Original dedicated PR proposal is superseded by ADR-0020's ordinary Git/Journal-link scope |
| 4 | #89 per-owner retirement | Inventory/preview, exact Worktree ownership and supported resource completion | Do not block #88; native Session lifecycle is later excluded by ADR-0020 |
| Parallel | #86 selected-host qualification | Operator-selected profile and actual authority/limit/recovery facts | An operational gate, not a reason to stop unrelated source/documentation improvements |

Do not rewrite existing Runs' backend, budgets or external receipt meanings during migration. Introduce versioned capabilities without silently changing old permissions/refusals. Missing APIs are not private-route invitations. Host upgrades require lockfile/contract checks and any affected actual-host acceptance.

#5/#89 may track incremental child completion, but preserve original requirements, explicit disposition and reasons for non-adoption. Do not move work indefinitely to another Issue and call the parent complete. Changes to original scope require a separately reviewed owner decision; ADR-0020 is that subsequent decision for the local product.

## 7. ADR completion versus Issue completion

**This ADR is complete** when all eight Issues have a decision, owner, rationale, alternatives, acceptance method and remaining assumptions consistent with code/public contracts, and documentation checks and normal regressions pass.

**An Issue is complete** only when its retained acceptance is implemented and measured, with exact SHA, API/backend version, target, failure/skip counts, external state and exclusions. Design adoption, #92 success or a readiness view alone is insufficient. A dropped original requirement needs an explicit approved scope disposition, not silent omission.

| Issue | What this ADR decided | What adoption alone did not prove |
| --- | --- | --- |
| #2 | Durable-first, explicit compatibility and common Run contract | Native authenticated parity or untested backend safety |
| #3 | Core UX, public panels and precise scope/target | Actual four-Run/QC direct-Steer behavior |
| #4 | Finite opt-in diagnosis, human resume | Policy implementation and failure/restart safety |
| #5 | Evidence/capture/knowledge/retention boundaries | Capture/thumbnail, publication or physical lifecycle completion |
| #36 | Target-specific #85/#86 evidence mapping | Pending target qualification |
| #37 | Separate #87/#88/#89/#86 responsibilities | External cleanup or hard-quota completion |
| #86 | One selected target and no automatic OS changes | Actual settings, measurements or independent review |
| #89 | Owner-specific contracts and staged Worktree support | Availability of future APIs or deletion/recovery correctness |

This table describes what the design alone established. Consult later implementation receipts and ADR-0020 instead of interpreting historical gaps as current Issue states.

## 8. Reconsideration triggers

Revisit when PI WEB publishes exact-ID archive/retire/status receipts or authorized aggregate panels, another isolated backend proves mandatory contracts, multi-tenancy/separate publisher identity becomes a real requirement, or measured database contention warrants another design. Do not add distributed schedulers or a second auth/evidence service speculatively. If an SDK/provider update removes required semantics, refuse rather than silently downgrade.

## 9. Evidence sources

Separate target-code facts, public upstream contracts and primary explanations of general mechanisms. External references justify design choices; they are not product-test or deployment certificates. Original reference date: 2026-10-15.

### Repository primary sources

- [R1] [ADR-0001](0001-control-plane-and-product-boundaries.md), [AGENTS.md](../../AGENTS.md): deterministic core, direct human control, public Pi/PI WEB contracts and no duplicated credentials.
- [R2] [ADR-0018](0018-runtime-deployment-and-evidence-ownership.md), [ADR-0017](0017-production-trust-boundaries.md): product/platform/operator responsibilities and trust boundaries.
- [R3] Fixed research SHA: [ExecutorPort/engine](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/automation/engine.ts), [runtime configuration](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/automation/ledger.ts), [native companion](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/runtime/companion.ts).
- [R4] Fixed research SHA: [server](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/pi-web/server.ts), [DurableRunHost](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/runtime/durable-runner.ts), [SECURITY](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/SECURITY.md).
- [R5] [Residual acceptance map](../RESIDUAL_ACCEPTANCE.md), fixed [retention](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/automation/retention.ts), [registry](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/runtime/registry.ts). Later #88 atomic receipts supersede old ADR-0009 absence-only recovery descriptions.
- [R6] [ADR-0010](0010-screenshot-artifacts-and-reviewed-adr-staging.md): exact-QC-Git-blob image import, lazy preview and reviewed staging in a separate Worktree, not automatic capture/publication.
- [R7] [Actual authenticated E2E](../HOSTED_E2E_LIVE_ACCEPTANCE_2026-10-15.md), [test PR #100](https://github.com/zkamiyama/pi-micromanager/pull/100), [run 38594230825](https://github.com/zkamiyama/pi-micromanager/actions/runs/38594230825). No new model request was made solely to author this ADR.
- [R10] [ADR-0004](0004-cockpit-provider-adapters-and-delivery-order.md), fixed [fleet](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/pi-web/fleet.ts), [browser](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/pi-web/browser.ts).
- [R11] [ADR-0002](0002-deterministic-dag-and-live-interventions.md), [ADR-0005](0005-task-scoped-interventions.md), fixed [Workflow state machine](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/core/workflow.ts).
- [R12] [ADR-0003](0003-evidence-journal-retention-and-knowledge.md), [ADR-0009](0009-journal-and-conservative-retention.md). Historical unimplemented/unverified labels must be read against their dates and later evidence.
- [R13] Fixed [publication service](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/src/automation/publication-service.ts), [ADR-0016](0016-audit-control-generation-and-proof-boundaries.md): exact SHA/target authority, generation fences and uncertain-side-effect reconciliation.

### Fixed upstream APIs

- [R8] PI WEB 1.202610.2 [public server-plugin API](https://github.com/jmfederico/pi-web/blob/2d65b5f800f832f6f8b866bde493ba1b3763d960/src/server-plugin-api.ts): Session/Workspace capabilities and `WorkspaceProvider.prepareRemove`; distributed `dist/server-plugin-api.d.ts` was also inspected.
- [R9] Same-version [public browser plugin API](https://github.com/jmfederico/pi-web/blob/2d65b5f800f832f6f8b866bde493ba1b3763d960/src/plugin-api.ts): scope/navigation/panels and contextual `archiveSession`; distributed `dist/plugin-api.d.ts` was also inspected.
- Provenance: PI WEB integrity in the [research lockfile](https://github.com/zkamiyama/pi-micromanager/blob/7f8ab4a2ca037496a36becab154bcb97ca20ef4b/package-lock.json) was `sha512-UZ329wWuOzccx3QD+JCyVrGwKFXF6Ss9I2xAEgZMvwHPFTpmirNyBdmoDJD65XeYWQIbNFDkhfjuOqSnOmTcqg==`, matching the then-observed `npm view @jmfederico/pi-web@1.202610.2 gitHead dist.integrity --json`.

### Primary references for general mechanisms

- [E1] Microsoft, [Anti-Corruption Layer pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer): isolate semantic translation; not a mandate to move business rules into adapters or adopt a cloud platform.
- [E2] AWS Builders' Library, [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/): caller identity, intent, atomic receipts and delayed requests; external operations in this product do not automatically inherit every guarantee.
- [E3] SQLite, [Transactions](https://sqlite.org/lang_transaction.html): reader snapshots, one writer and write conflicts; a SQLite transaction is not a distributed transaction across Git/APIs.
- [E4] Linux Kernel, [Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html): process hierarchy and resource controllers, distinct from application counters.
- [E5] GitHub, [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use): untrusted code/self-hosted runners and the difference between Environment approval and isolation.
- [E6] Git, [git-worktree](https://git-scm.com/docs/git-worktree): administration, list/remove/lock, dirty/locked protection and remove versus prune; not automatic protection of application pins, leases or unpublished evidence.

### Original Issue set

[#2](https://github.com/zkamiyama/pi-micromanager/issues/2), [#3](https://github.com/zkamiyama/pi-micromanager/issues/3), [#4](https://github.com/zkamiyama/pi-micromanager/issues/4), [#5](https://github.com/zkamiyama/pi-micromanager/issues/5), [#36](https://github.com/zkamiyama/pi-micromanager/issues/36), [#37](https://github.com/zkamiyama/pi-micromanager/issues/37), [#86](https://github.com/zkamiyama/pi-micromanager/issues/86), [#89](https://github.com/zkamiyama/pi-micromanager/issues/89). Issue bodies are mutable, so the design also records fixed code/API revisions and observation dates.

## Implementation follow-up: bounded diagnostics and scoped cockpit

The [feature/test map](../ADR19_DIAGNOSTICS_AND_COCKPIT.md) describes implemented optional episodes, immutable budget shares and exact inspector/command scope. The [actual OAuth quartet record](../ADR19_DIAGNOSTICS_AND_COCKPIT_ACCEPTANCE.md) separately establishes the later #3/#4 acceptance. [ADR-0020](0020-local-owner-durable-product.md) defines the current owner's narrower release scope. Neither those successes nor this English translation validate the still-uncommitted local artifact/reclamation draft.
