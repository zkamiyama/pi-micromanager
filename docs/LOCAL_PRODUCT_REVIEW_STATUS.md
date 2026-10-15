# Local-owner product review: fixes and remaining target qualification

Scope: #5, #89, #86 and parent trackers #36/#37 under [ADR-0020](adr/0020-local-owner-durable-product.md). Repository documentation, comments and acceptance records are in English.

## Current software implementation

PR #108 replaces the initial known-failing local-owner candidate with bounded image validation, verified stable archives, propagated pins, durable nonblocking maintenance receipts, original creation-identity checks and a real Journal UI. [CI acceptance](LOCAL_OWNER_CI_ACCEPTANCE.md) maps the executable tests; [operator guidance](LOCAL_OWNER_OPERATION.md) describes the implemented public behavior. The exact final-source job results belong in PR #108 rather than being inferred from this document.

| Original finding | Implemented resolution | Executable evidence |
| --- | --- | --- |
| Image input exceeded public request capacity | Raw images limited to 180 KiB before bounded base64 encoding, below the unchanged 256 KiB JSON request budget | Public-peer limits and actual browser upload |
| JPEG signatures did not bound decoded dimensions | Supported single-frame JPEG/PNG headers and dimensions checked before browser decoding; animated PNG/frame changes refused | Invalid/oversized frame tests and genuine browser-produced JPEG round trip |
| Decoder had only an output-size cap | Zstandard window log capped at 17, plus independent 128 KiB output and stored-input bounds | Tiny-output excessive-window frame and oversized-output regressions |
| Archive reuse rebuilt a different payload after late activity | Exact per-Run archive lookup verifies and reuses the first immutable snapshot; expired detail remains expired | Late activity, expiry and SQLite reopen tests |
| Artifact pin did not fence resource retirement | Any live pin protects the owning Workflow, without display pagination; unresolved resource retirement protects archives | Actual server preview and pin arriving during asynchronous Git inspection |
| Long maintenance blocked the public request | Persisted operation admission/ID, bounded background work, status lookup, same-ID deduplication and joined drain | Concurrent/stop/reopen contracts and delayed actual Git operation |
| Original archive was not checked before DB reclamation | Verify archive content/evidence before first destruction; old completed tombstone permits expired detail but no new deletion | Corrupt and expired archive retention tests |
| Physical ownership could be inferred from current path | Persist original creation directory identity; refuse legacy missing proof, aliases, wrong scope and changed inventory | Original-identity, ignored/untracked races, file alias and retained-ref tests |
| Worktree/DB deletion lacked comprehensive negative coverage | Reserve before mutation, retain uncertain receipts/leases, no force, original refs and minimal tombstones preserved; inspect SQLite before writable open | Real Harness/Worktree deletion, WAL-reader refusal, lost reply, actual reactivation and no recreation |
| Journal controls were absent | Scoped public UI for local images/pins, explicit log/image reads, quota/status and exact Git ADR links | Shipped PI WEB/Chromium with real faux Harness completion and UI/restart assertions |

The contract fixture that constructs sealed records is deliberately labeled synthetic. Separate lifecycle and complete browser scenarios obtain their outcomes by actually running the product engine/Harness and Bubblewrap. No real provider account or repository-write credential is passed to CI.

## Historical development record

The original uncommitted draft was retained at `/tmp/mm-local-product-1T9MUw/repo`. Earlier editing calls were tool-safety refused without a detailed reason; independent documentation/compiler PRs did not certify it. The initial reviewable PR #108 candidate `18e9edc1d49f36b16a4ef25b9a8d390afa491da5` reproduced four contract failures and one missing-UI failure in GitHub Actions; both old lifecycle jobs passed six tests. Those failures were ordinary failing tests, not masked expected outcomes or merge evidence.

In this follow-up, source edits and isolated tests executed through the connected development tool. Corrections are committed as ordinary source, not injected at CI runtime. Original assertions remain and additional fault cases are required. No old production services, Windows/WSL settings, native Session data or user Worktrees are changed.

## Remaining qualification, not an unresolved CI code failure

The owner explicitly selected **post-merge verification of the particular Windows/WSL installation** after software CI passes. #86 therefore retains the effective localhost/auth boundary, kernel/namespace behavior and approved real-account/test-target acceptance on that host. #36/#37 track the remaining target evidence. A previous strict-profile OAuth test, a GitHub-hosted Ubuntu run or this review document is not a new local-owner WSL qualification.

No result guarantees all storage hardware failures, hostile same-UID activity, exact provider charges, multi-tenant isolation or every WSL version. Uncertain resource outcomes stay retained and non-replayable; absent files do not prove a successful operation. The product does not reset uncertain state, automatically remove quarantine, or modify OS security to make tests pass.
