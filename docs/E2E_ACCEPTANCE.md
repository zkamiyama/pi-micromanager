# E2E acceptance: product harness versus operational evidence

Design: [ADR-0018](adr/0018-runtime-deployment-and-evidence-ownership.md).
Parent #38 stays open until its independent acceptance cases have evidence.
The harness is product work (#90); provisioning/running a real test identity
is #91; hosted PI WEB/browser and real remote publication is #92.

## What this suite does and does not prove

| Tier | Execution | Evidence | Not implied |
| --- | --- | --- | --- |
| Deterministic integration | `npm run check`, including actual SDK with faux model; disposable Git/SQLite and mocked GitHub transport | State transitions, abort/restart/refusal and exact-SHA publication semantics | Real authentication, browser transport, live remote state |
| Mandatory real isolation | `successful-isolation` CI, `MM_REQUIRE_SANDBOX=1` | Actual supported Bubblewrap namespace and file/network denial, delayed provider/tool cancellation and joined shutdown | Isolation of the full provider loop or of a different deployment host |
| Approved model-SDK authentication | Manual `authenticated-e2e.yml`, explicitly selected provider/model and test-only API key | Successful typed report, persisted input completion, reopen without new request/report; exact source/version receipt | Hosted PI WEB/browser, real remote publication, production readiness |

All tiers must be named honestly. A faux-mode success always reports
`authentication: not-verified`. Missing credentials or missing approval is
blocked, not a passing/skipped authentication test. The manual workflow has
**not been executed with a real test credential as part of implementing this
harness**. #91 and #92 therefore remain open.

## Supported harness matrix

This is a tested-code scope, not a claim that all provider/model combinations
have passed real authentication. The lockfile remains the reproducibility
source; receipts compare actual installed versions against it.

| Component | Locked baseline for this change |
| --- | --- |
| Node | 22 and 24 portable CI; manual SDK authentication uses 22 |
| Pi AI / Durable / coding-agent / chord | 1.2.0 each |
| PI WEB | 1.202610.2 (recorded, not hosted by this SDK-only suite) |
| Initial real-auth adapter | Built-in `openai` or `anthropic` API-key provider, exact catalog model selected explicitly |
| Credential-free adapter | Built-in `faux/faux-1`, no auth or model-network discovery |

OAuth, arbitrary provider endpoints/custom `models.json`, cloud credential
chains, native hosted sessions, UI/browser and remote-publishing acceptance
are **not silently substituted**. Track additional support explicitly rather
than falling back to the daemon user's profile or default model. This harness
uses Pi's public `InMemoryCredentialStore` and `ModelRuntime` API; it is not a
new authentication service and never provisions or refreshes production auth.

## Credential-free tests

From a development checkout:

```sh
npm ci --no-audit --no-fund
npm run check
npm run test:e2e:faux
npm run test:e2e:contracts
```

The faux CLI writes only a new private temporary SQLite directory and removes
it after both Harness instances are joined. It offers no coding/file/shell
tools to the model. The typed boolean acknowledgment is the sole tool. The
receipt contains actual checked-out SHA, working-tree cleanliness, component
versions, lockfile SHA-256, logical request count, proof statuses and cleanup
status. A dirty faux checkout is visible in the receipt, not represented as
proof of an immutable revision.

Negative scenarios are deterministic and credential-free:

```sh
node scripts/durable-auth-smoke.mjs --mode faux --scenario provider-error
node scripts/durable-auth-smoke.mjs --mode faux --scenario missing-report
node scripts/durable-auth-smoke.mjs --mode faux --scenario duplicate-report
node scripts/durable-auth-smoke.mjs --mode faux --scenario request-budget
node scripts/durable-auth-smoke.mjs --mode faux --scenario slow --timeout-ms 1000
```

Those commands must fail. Regression tests assert nonzero status, no fabricated
success, no leaked provider error marker, and joined cleanup. Timeout cancels
execution; failure to prove shutdown retains the temporary state and cannot
produce a successful receipt. The workflow also enforces a process-level wall
clock deadline for SDK behavior that does not cooperate with cancellation.

## Approved real-provider run — operator preparation (#91)

Before using the manual workflow, the operator must independently configure
and verify the `authenticated-pi-e2e` Environment: required reviewers,
default-branch restrictions and a **test-only** `MM_E2E_API_KEY` secret. The
presence of an Environment name in YAML is not proof that these protections
are enabled. Use a provider account/project with a separately approved spend
limit, not the production key. No secret value is entered into Issue comments,
workflow inputs, commands, receipts or model prompts.

The workflow uses a fresh GitHub-hosted Linux runner, not a persistent daemon
user's home. Only the real SDK step receives the Environment secret. Code is
checked out at the run SHA and compared with the full reviewed default-branch
SHA **before dependency execution**. The manual dispatch requires both
`approve_billed_test` and `test_identity_only` to be true and exact provider/model
inputs. No auth workflow runs automatically on a pull request.

The CLI interface is now identical to the workflow invocation:

```sh
node scripts/durable-auth-smoke.mjs \
  --mode authenticated --provider "$PI_PROVIDER" --model "$PI_MODEL" \
  --expected-sha "$REVIEWED_SHA" --approve-billed-test --test-identity-only \
  --receipt "$NEW_RECEIPT_PATH"
```

`MM_E2E_API_KEY` must already be supplied by the approved test-secret mechanism;
there is no ambient API-key/OAuth fallback. The CLI requires a clean checkout,
matched full SHA, supported Node/provider, a fresh receipt destination and both
explicit approvals before loading the SDK. It drops ambient cloud/provider/Git/
proxy configuration and uses an in-memory credential plus `modelsPath:null`.

Bounds are four **SDK request admissions**, 256 output tokens per request and
60 seconds for the SDK phase; the CI supervisor terminates a non-cooperating
process. These are not exact billable-network-attempt or monetary guarantees;
provider/network retries and already admitted work still need operator spend
controls. No repository-write token, custom endpoint or automatic remote
publication is provided to this test.

## Receipts and safe interpretation

Exit status: `0 = passed`, `1 = failed`, `2 = blocked`. The only CLI result is
a bounded JSON projection with enumerated failure codes. Raw exceptions,
provider response bodies, transcripts, tool arguments, auth data, SQLite files
and temporary paths are not attached as artifacts. The receipt file uses
exclusive creation and mode 0600; existing destinations and symlink parents
are refused. The manual job copies only that receipt into its job summary.

The source SHA in a pull-request CI checkout can be GitHub's synthetic merge
commit. Record it as the executed source; separately retain the PR head SHA and
Actions run association. A default-branch manual run must match the explicitly
reviewed source SHA. Never substitute a green result from an earlier revision.

The fixed receipt marks hosted PI WEB/browser and remote publication as
`not-tested` and OS isolation as `not-tested-by-this-suite`. A real key lookup
alone is not authentication evidence: only a successful provider result,
exact persisted input and no-replay reopen can pass that field. A missing
receipt, terminated process or failed CI step is not certification, even if
an earlier intermediate step printed success.

## Existing integration and failure coverage

- `tests/durable-runtime.test.mjs` and `tests/production-runtime.test.mjs`:
  real Harness/faux provider, report-before-error, abort/lost event/restart,
  budgets and no replay.
- `tests/production-server-integration.test.mjs` and
  `tests/production-server-isolation.required.mjs`: public interface fixtures,
  real server activation/dispose and real isolated tool shutdown. These are
  not a hosted PI WEB browser acceptance run.
- `tests/final-publication.test.mjs`, `tests/yolo-publication.test.mjs`,
  `tests/publication-actions-fallback.test.mjs`: simulated GitHub receipts,
  exact SHA and lost-response/failed-CI policy; no real remote certification.
- `tests/e2e-contract.test.mjs` and `tests/production-release-gates.test.mjs`:
  admission, receipt privacy/refusal, SDK smoke and credential workflow guards.

## Retired compatibility coding smoke

`real-durable-autopilot-smoke.mjs` now exits **blocked (2)**. Its old default
provider/model, ambient daemon auth, unconfined model coding tools and direct
host tests are not a qualified credential-bearing acceptance path. It is no
longer called by the authenticated workflow. This is **not** a passing test
replacement or removal of production isolation: product runtime and all
mandatory production-isolation regressions remain unchanged. Its real hosted
Autopilot/GUI acceptance obligations are explicitly retained in #92.

## Issue ownership map

| Parent | Product/integration work | Operator/acceptance work |
| --- | --- | --- |
| #36 | #85 supported execution-backend contract | #86 actual isolated host and hard quotas |
| #37 | #87 capacity/admission; #88 owned-evidence retention; #89 owner-API lifecycle | #86 hard machine quotas, external reconciliation |
| #38 | #90 bounded E2E harness and evidence | #91 real test authentication; #92 hosted browser/remote publication |

Original parent acceptance text is retained in each Issue. Children and
parents stay open until their own requirements have evidence; completing #90
alone does not close #38 or authorize any production operation.
