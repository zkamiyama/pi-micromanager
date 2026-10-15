# CI-first local-owner acceptance

Status: **acceptance candidate, not merge-ready**. This branch makes the retained
local-owner development draft reviewable and adds executable acceptance gates.
It does not label the unfinished Journal UI or failing safety assertions as done.
Related: #5, #89, #86, #36/#37 and [ADR-0020](adr/0020-local-owner-durable-product.md).

## Source and boundaries

The candidate starts at main `3398511c847c89ab243c145dac6f662b95f40d78`. The existing,
previously written local-owner draft was copied from its retained development
checkout; that original checkout remains untouched. No source patch is generated
or applied dynamically by CI. A newly reproduced SQLite error in the ADR-link
query was corrected by quoting the `commit` column alias.

Earlier tool-refused media/archive/pin/UI changes were not silently applied via
Actions. The unchanged unfinished behavior is exposed by failing regressions.
The CI pipeline itself, test fixtures, and quoted SQL alias are new work; successful
older documentation CI is not being reused as acceptance for this draft.

Tests create their own private directories, Git repositories, Worktrees, SQLite
files, and processes. Model responses use the official faux provider with the
actual Pi Durable Harness. There is no real model account, GitHub write token,
external publication, native Session deletion, or existing daemon operation.

## Reproducible gates

From a clean, reviewed checkout with lockfile-matched dependencies:

```sh
npm ci --no-audit --no-fund
npm run build
node scripts/local-owner-ci.mjs contracts
node scripts/local-owner-ci.mjs lifecycle
# Install the pinned browser into an explicit development/CI cache first.
export PLAYWRIGHT_BROWSERS_PATH="$(mktemp -d /tmp/mm-browser-cache-XXXXXX)"
npx --no-install playwright install --only-shell chromium
node scripts/local-owner-ci.mjs browser
```

`PLAYWRIGHT_BROWSERS_PATH` can select the explicit browser cache; the gate uses a
fresh HOME and does not load the operator's Pi or GitHub profile. The workflow
sets this path to a runner-temporary directory. Its matrix runs each of the three
gates on Node 22 and Node 24, using the **exact PR head SHA** on fresh GitHub-hosted
Ubuntu runners. The existing five CI jobs remain unchanged and required by the
project's release procedure. No branch-protection setting is changed here.

The runner rejects nonzero exit, missing or duplicate summaries, zero/fewer than
expected tests, skip, todo, cancellation, and timeout. Each job writes a bounded
JSON receipt to its log and a count/failure summary to the Actions job summary.
The receipt records source SHA, lock hash, actual component versions and Node
version. A failed acceptance gate remains a failed job: no `continue-on-error`,
expected-failure annotation, or disabled assertion masks the result.

## What the suites actually exercise

| Suite | Evidence |
| --- | --- |
| `contracts` | Explicit local-owner/strict-state policy; image integrity, scope, quotas, pins, age/retirement receipts, bounded Zstandard expansion; actual public server Journal/image/ADR-link requests; immutable archive reuse |
| `lifecycle` | Actual server-launched implementer and QC through the real Harness and real Bubblewrap; normal Git Worktree removal, retained result refs and minimal receipts; lost successful deletion reply, actual server reactivation, stale generation after asynchronous Git preflight, untracked-file and foreign-scope refusal; delayed provider stop/join |
| `browser` | Actual shipped PI WEB and sandboxed Chromium via the public plugin/peer API; real JSON request limit and unsealed-image refusal; actual Journal controls rather than a test-injected replacement UI |

The peer contract fixture deliberately constructs synthetic persisted QC records
for inexpensive data-boundary tests; those tests are not counted as real runtime
acceptance. The separate lifecycle suite obtains its completed records by running
the real server/engine/Harness, not by writing invented successful runtime rows.
Only the disposable host adapter is extended for local-owner browser rehearsal;
its existing production/live defaults are unchanged and its new local-owner path
refuses real credentials.

## Current failing requirements and acceptance limits

The initial regressions reproduced two JPEG-validation gaps, a Workflow pin that
does not fence Worktree-retirement preview, and repeated archive creation that
conflicts after late activity. The actual UI test requires the local image/log/
ADR/maintenance controls; the old tracked-image UI is not a substitute.
These failures must be fixed and the **new exact source** retested before merge.

The lifecycle tests cover concrete stop/restart and Git reply-loss cases, not all
power-loss/storage corruption cases. Additional review remains necessary for
archive resource/window bounds, verified archive reuse before data retirement,
request-deadline/operation receipt semantics, and manual reconciliation of
ambiguous filesystem changes. A green subset does not close #5 or #89.

## WSL remains a separate, small target check

GitHub's Ubuntu runner is not the operator's Windows/WSL machine. #86 retains only
the selected local-owner WSL prerequisites and actual profile smoke, including
localhost/auth assumptions, actual namespace behavior and approved external
integration. It does not require a SaaS/tenant platform. CI does not modify
`.wslconfig`, firewall, OS security, production services or restore quarantine.
All receipts keep `productionSafetyGuaranteed: false`.
