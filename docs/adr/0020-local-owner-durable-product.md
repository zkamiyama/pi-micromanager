# ADR-0020: Single-owner WSL/Durable product and local resource lifecycle

- Date: 2026-10-15
- Status: **Accepted product scope. The new capabilities described below are not declarations of completed implementation or verification.**
- Decision maker: the repository owner, who explicitly selected Durable without native parity, a local Journal, Git-owned ADR documents, reclamation of owned Worktrees, and Windows/WSL YOLO as the primary use case.
- Code baseline: `6dcb050aa3bdbb0e4fd28ed2173a8d64589596ec`.
- Relationship: retain the responsibility boundaries in ADR-0018/0019 while narrowing the supported environment and required capabilities.

## 1. Supported product scope

**A PI WEB development tool using Pi Durable, accessed through localhost by one owner on Windows with WSL 2.** Publishing the GitHub repository does not mean operating a public, multi-user Web service.

Durable is the only officially supported automation runtime. Native Pi parity, automatic fallback to native execution when Durable refuses, and cleanup of human-created native Sessions are not requirements. A documentation change must not silently run, migrate, or delete existing native compatibility code or state.

The OS, owner, Pi/PI WEB SDKs, Git/gh, Bubblewrap, and Windows/WSL kernel are trusted components. This release does not certify resistance to a malicious same-UID process, administrator or compromised kernel, nor tenant isolation or public SaaS authentication/TLS infrastructure.

## 2. Separate YOLO authority from isolation

YOLO means executing without repeated approval **inside the project, model, repository, base branch, and operation scope authorized by the owner in advance**. It does not authorize scope expansion, resending uncertain operations, skipping QC, or bypassing GitHub checks.

Preserve the existing `ask`/`deny` requirement for external mutations under `productionSecurity.mode="production"`. The proposed `local-owner` profile requires explicit owner settings and a fresh, dedicated state root. No implicit downgrade or migration of old production/native state is allowed. Adoption of this ADR does not itself make the new setting available.

Both profiles require Bubblewrap, control-data/Workspace separation, the fixed Git broker, host allowlists, the ownership lock, cancellation and joined completion, operation generations, finite budgets, persisted outcomes, exact-SHA merge, and GitHub protections. A Workflow or model cannot self-certify isolation or disable it to obtain a passing result.

## 3. Local Journal and Git-owned ADRs

| Data | Source of truth | Journal responsibility |
| --- | --- | --- |
| Short execution history, public decision summaries and test results | Local managed state | Display a derived view |
| Images | A bounded local object store | Read on demand |
| Accepted ADRs | `docs/adr/*.md` in the target Git repository | Link to the verified file and commit |
| Minimum no-replay, QC and external-operation receipts | Authoritative control-plane records | Reference outcomes and provenance |

Do not build a Journal cloud-publishing/synchronization service, a separate ADR commit/push/PR engine, or a second canonical copy of ADR text. ADR editing, review and commit use ordinary Git operations. Existing reviewed staging may remain, but staging is not adoption or completed publication.

Verify project/Workspace authority, a tracked regular file, and its source commit when linking an ADR. Distinguish a mutable branch's latest version from the immutable commit used as evidence. The decision, rationale and alternatives must remain understandable from the ADR itself after short-lived Journal details expire.

Images need not be stored in Git. Local ingestion records Run/QC identity, source SHA, content hash and producer/selection provenance. An operator-selected image is `operator-upload`, not automatically captured or independently attested QC evidence. Recording a source SHA does not establish that the image truthfully depicts that execution. Keep the existing strict tracked-Git-image ingestion as a separate supported path.

OS users able to read the files are within the trusted local boundary. Localhost alone is not authentication against arbitrary local processes or malicious Web pages. Preserve the host's authentication and authorization. External exposure needs a separately reviewed profile.

## 4. Bound detailed logs

Store completed Runs' public activity and short decision summaries as per-Run JSONL compressed with Zstandard, initially using a total capacity of 256 MiB and a 30-day retention default. Compression format and level are internal storage choices, not a protocol. Bound read time, decoder resources and decompressed size.

Exclude secrets, hidden chain-of-thought and unlimited copies of native transcripts. Reclaim older image/detail artifacts only after completion, with no pin or recovery dependency. Reclaim disposable details before admitting new storage; if only protected data remains, safely refuse new detail storage or new execution rather than deleting protected evidence.

Authoritative Workflow state, success/failure, Run/input/operation IDs, QC SHA, completion proof, external reconciliation and reclamation receipts are separate from detailed logs. Deleting logs must never make an old Run appear unexecuted. Active or uncertain Durable SQLite is not an ordinary compression/archive target.

## 5. Reclaim only owned Worktrees and Durable data

A Worktree is an expendable working copy, not the durable evidence itself. Automatic reclamation is permitted only for a **Micromanager-created Worktree** for which all of the following are proved:

1. Original creation receipt, Git registration, canonical path and project/Workspace identity match.
2. Related Runs have finished and are sealed, with no uncertain external operation, human hold or unfinished dependency.
3. Required images/detail logs have been collected and minimum evidence is preserved.
4. Necessary commits are reachable through retained Git refs. A SHA stored as plain text is not a Git retention root.
5. There are no dirty, untracked or unclassified ignored files, submodules, unrelated ownership or active leases.
6. Generation, authority and target are rechecked after asynchronous preflight, immediately before mutation.

Use Git's Worktree management operation. Do not substitute `--force` or recursive deletion of arbitrary paths. Worktree directories, Git branches/refs, and image/log artifacts have distinct lifecycles. Reclaiming a working copy must not also remove the refs preserving its result.

Persist intent before deletion. Do not automatically repeat an operation with an unknown outcome. Absence alone is not proof that this controller completed its deletion. Retain failure leases/tombstones for reconciliation.

Owned Durable Run database reclamation similarly requires actual runtime shutdown, persisted successful completion, required records, and a tombstone refusing recreation of the same Run. This authority excludes native Pi/PI WEB Session files, native JSONL/SQLite, and user-created Worktrees. Humans and PI WEB manage human-created native Sessions.

## 6. WSL acceptance boundary

Qualify the owner's specific Windows/WSL environment, not all WSL/Linux/SaaS deployments. Measure localhost access with existing authentication, actual worker file/network isolation, process completion, input/operation deduplication, capacity/time/request limits, and reconciliation following WSL restart.

Tests must not change `.wslconfig`, Windows Firewall, AppArmor, OS permissions or existing production daemons. WSL-wide memory/CPU settings affect other workloads and are operator-managed, not automatically rewritten by this product. Clearly distinguish logical limits, capacity scans and per-process rlimits from hard aggregate quotas or exact billing ceilings.

## 7. Explicit Issue and old-PR disposition

| Item | Disposition under this decision |
| --- | --- |
| #2 | Accept the already measured Durable adapter for the supported scope; native parity is an explicit non-goal, not a verified implementation |
| #5 | Limit to local images, bounded detailed logs and Git ADR links; remain open until UI, persistence, reclamation and tamper tests pass |
| #89 | Reclaim only owned Worktrees/Durable data; arbitrary native-Session APIs are no longer a prerequisite, but owned-resource lifecycle tests remain required |
| #86 | Verify `local-owner` on the selected single-owner WSL host; generic SaaS/tenant/TLS certification is out of scope |
| #36/#37 | Track the scoped contracts and evidence above; design adoption is not implementation completion |
| PR #40–#47 | Close without merge as superseded after mapping current-main replacements and tests; retain branches/history |
| PR #10 | Diagnostics/Cockpit are replaced by #103/#104; do not adopt old native parity or dedicated ADR publication design; retain unfinished local work in #5/#89 |
| PR #99 | Close the earlier stopped trial without merge; do not confuse it with successful trial #100 or delete its refs/state |
| PR #82/#83 | Node-26-only types are unnecessary for current Node 22/24 support; evaluate the TypeScript major separately, with its own exact-head evidence |

## 8. Keep implementation state distinct from acceptance

The baseline main has scoped acceptance for Durable, actual OAuth/PI WEB, direct QC intervention, committed outcomes and real GitHub lost-response recovery. None of that alone validates the proposed local-owner profile, local image/compressed-log store, Git document links or automatic owned-resource reclamation.

During development on 2026-10-15, 26 focused public-server, strict-profile and operation-fence tests passed. Later backend code built successfully with TypeScript. However, a Journal UI editing command and a subsequent diff/build command were refused by the tool safety check without a detailed reason. Refused operations were not rephrased or rerouted.

The runtime/UI/reclamation draft therefore remained uncommitted and was **not included in the original documentation-only PR #106**. Its full regression, actual host/isolation and destructive-boundary acceptance remained incomplete. #5/#89/#86 and their parents stayed open; a documentation PR's green CI is not evidence that the local draft passed. Owner authorization and model selection were not missing.

Follow-up on 2026-10-15: after the owner restarted Desktop Commander, source reads worked, but a proposed runtime patch addressing media limits and archive/pin handling was again tool-safety refused. The patch was not applied through another route. Independent documentation translation and compiler maintenance are separate work, not acceptance of that runtime draft. Consult the current Issue evidence for later status rather than treating this historical account as a permanent implementation claim.

For the follow-up source-review findings and exact unfinished gates, see [Local product review status](../LOCAL_PRODUCT_REVIEW_STATUS.md).

## References

- [ADR-0018: responsibility boundaries](0018-runtime-deployment-and-evidence-ownership.md)
- [ADR-0019: capabilities and acceptance](0019-bounded-product-capabilities-and-issue-disposition.md)
- [Actual OAuth quartet acceptance](../ADR19_DIAGNOSTICS_AND_COCKPIT_ACCEPTANCE.md)
- [Actual GitHub publication/recovery acceptance](../HOSTED_E2E_LIVE_ACCEPTANCE_2026-10-15.md)
- [Git Worktree specification](https://git-scm.com/docs/git-worktree)
- [Node 22 Zstandard API](https://nodejs.org/download/release/v22.23.3/docs/api/zlib.html)
- [Microsoft WSL networking](https://learn.microsoft.com/windows/wsl/networking)
