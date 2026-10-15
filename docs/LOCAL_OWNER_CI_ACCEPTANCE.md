# CI-first local-owner acceptance

Scope: #5, #89, #86 and parent trackers #36/#37 under [ADR-0020](adr/0020-local-owner-durable-product.md).

The source implements a local Journal, bounded public-activity archives, exact Git ADR links, and conservative retirement of controller-owned completed resources. The original failing candidate was `18e9edc1d49f36b16a4ef25b9a8d390afa491da5`. Its JPEG, pin, archive-reuse and missing-UI failures remain historical evidence in PR #108; they are not accepted behavior. Fixes and additional adversarial tests must pass on the final reviewed commit before merge.

The owner explicitly selected **GitHub-hosted CI for software acceptance and post-merge verification for their particular Windows/WSL host**. A merge is not a successful WSL qualification. #86 retains that separate obligation. No production daemon, native Session or existing user Worktree is operated by these tests.

## Reproduce the gates

Use a clean reviewed checkout, Node 22 or 24, Linux namespaces and Bubblewrap:

```sh
npm ci --no-audit --no-fund
npm run build
node scripts/local-owner-ci.mjs contracts
node scripts/local-owner-ci.mjs lifecycle
export PLAYWRIGHT_BROWSERS_PATH="$(mktemp -d /tmp/mm-browser-cache-XXXXXX)"
npx --no-install playwright install --only-shell chromium
node scripts/local-owner-ci.mjs browser
```

The browser cache is outside the repository. The gate creates a fresh HOME, supplies only allowlisted environment variables, and never loads the operator's Pi or GitHub credentials. Missing Linux namespace support is a failure, not a sandbox fallback. Use an appropriate test host; do not weaken OS policy to pass a test.

The six-job matrix is Node 22/24 multiplied by `contracts`, `lifecycle` and `browser`. It checks out the **exact PR head SHA**, with read-only GitHub permissions and `persist-credentials: false`. Existing five-job CI remains required. Neither workflow dispatches a real provider request, writes an external repository, or deploys anything.

| Gate | Minimum tests per Node | What is real |
| --- | ---: | --- |
| contracts | 27 | SQLite, immutable local artifact bytes, quota/pin/decoder bounds, actual server peer requests, Git ADR inspection, durable maintenance admission |
| lifecycle | 17 | Actual product server/engine, Pi Durable Harness, Bubblewrap, temporary Git Worktrees and Run DBs, disposal/reactivation, concrete deletion and fault injection |
| browser | 3 | Shipped PI WEB, sandbox-enabled Chromium, scoped public peer, actual model-backed faux implementation/QC, UI image upload/decode/pin, archived text, Git ADR links and daemon restart |

The small Journal peer fixture constructs synthetic sealed records using public repository classes for inexpensive contract tests. It is not claimed as actual model execution. The lifecycle and final browser tests obtain their sealed records from the real Harness with the official deterministic faux provider. The test adapter does not inject a replacement Journal UI.

Every gate rejects failed exit, missing/duplicate summary, zero or too few tests, skip, todo, cancellation and timeout. A bounded `LOCAL_OWNER_CI_RECEIPT` records source SHA, clean-tree status, lockfile digest, component versions, exact Node version, test counts and failure names. Success is an observation about that source/environment, not a general security certificate.

## Implemented protections

- New `local-owner` requires an empty private state root and explicit allowlisted projects/models/publication targets. It preserves the old strict-production `ask`/`deny` contract and never falls back to native/unconfined execution.
- Images are operator-uploaded annotations, not automatically attested QC screenshots. They are limited to 180 KiB encoded bytes before base64 expansion, legal bounded PNG/JPEG frame dimensions, and a current sealed QC source. The bound fits the existing PI WEB 256 KiB request limit; the host limit is unchanged.
- Public Run JSONL is limited to 128 KiB and compressed with Zstandard level 3/checksum. Both compressor and decoder have a 128 KiB window budget; the decoder also has a separate output limit. Original archive identity and bytes are verified and reused despite late activity. Removed detail is never reconstructed by a repeated old request.
- A pin protects the owning Workflow's local artifacts and resources. Unconfirmed Worktree/Run retirements also protect associated archives from expiry. Pins are queried without display-pagination limits.
- Original Worktree creation records include directory identity. Legacy rows without that evidence are not automatically promoted to deletion authority. Current scope, root, Git common directory, registration, branch/HEAD, retained ref, clean/ignored/untracked/submodule state, leases, current generation and final filesystem inventory are checked. No `--force` or recursive-delete substitute is used.
- Actual Harness shutdown and successful persisted input/evidence precede Run DB reclamation. SQLite aliases are refused before opening/checkpointing. A busy WAL reader, failed integrity check, expired/unverified archive or changed authority retains original data. Separate no-replay tombstones remain after removal.
- Maintenance is admitted through a small persistent operation receipt, not a long blocking peer request. The same request ID returns the original outcome, never a second invocation. An interrupted operation is marked uncertain after reopen. New side effects are bounded by a 120-second deadline, four concurrent maintenance operations and per-command limits. Shutdown drains admitted operations before state ownership is released.
- The Journal UI uses the public scoped peer. Images/log text are loaded only on explicit selection; image bytes are not automatically passed to models or Git. Git ADR links retain immutable commit provenance and survive daemon restart/detail expiry.

## Fault evidence and limitations

The lifecycle gate covers real successful removal, lost successful Git reply, restart, duplicate confirmation, late generation changes, untracked/ignored files, pins arriving during async Git preflight, corrupt/expired archive, a DB alias, active SQLite WAL readers, missing legacy ownership evidence, unresolved-retirement archive protection, no-replay tombstones, a delayed operation whose status remains observable, and exactly-once startup reclamation of an eligible completed Workflow.

Tests simulate specific interruption boundaries. They do not certify every power-loss/storage-device failure, a hostile same-UID process, all Windows/WSL kernels, a multi-tenant service, an exact provider billing cap or hard aggregate OS quotas. Unknown deletion results stay retained/uncertain; no automatic reset/unquarantine/retry tool is supplied.

## Target WSL verification after merge

The operator may run the same credential-free gates on the merged commit in their development WSL environment. Record the exact commit, kernel/Node versions, namespace outcome and public-host browser results. Run only on disposable state; do not point tests at an existing daemon's state root. The fresh local-owner launch configuration is documented in [Local-owner operation](LOCAL_OWNER_OPERATION.md).

Those observations are still separate from the explicitly approved real OAuth/provider/GitHub test-target acceptance for that profile. Prior strict-profile live receipts are historical evidence, not a new local-owner live result. Keep #86 and its parent qualification trackers open until the selected target evidence is supplied. All receipts keep `productionSafetyGuaranteed: false`.
