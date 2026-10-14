# Local Luna acceptance: explicit operator authorization

Date: 2026-10-14. Scope: issues #38, #91 and #92, under ADR-0018.
This records the repository owner's instructions in the maintenance conversation,
not a standing authorization to deploy or access arbitrary accounts.

## Authorized decisions

- Execute the remaining acceptance tests through Desktop Commander on the owner's
  development machine. GitHub Actions remains a regression gate, not a prerequisite
  execution location for the real OAuth/hosted acceptance run.
- Reuse the local Pi **ChatGPT OAuth login** explicitly selected by the owner.
  This is an approved existing-account test, not a new disposable identity and
  not proof of separate provider billing/accounts. Never print or commit tokens,
  refresh tokens, account identifiers, raw transcripts or credential files.
- Exact ordinary model: `openai/gpt-6-luna`, thinking effort `low` (Luna Low).
  Independent QC or a higher-effort behavior check may use the **same model**
  with effort `max` (Luna Max). No Astra, Sol, different vendor, API key fallback
  or silently substituted model is authorized. The installed Pi catalog must
  confirm the model and requested effort before the first request.
- Use repository `zkamiyama/pi-micromanager` itself, but with distinct newly created
  test-only base and source branches under `e2e/local-luna-*`. Test commits contain
  only synthetic fixtures. A test PR merges **only into its test base**, never
  into `main`, a release branch or a pre-existing user branch. No force pushes,
  protection bypass, deployment, release or production-data migration.
- A normal reviewed maintenance PR may merge the documentation, reusable test
  harness and fixes into main after exact-head regression/real-isolation CI.
  That is separate from the synthetic publication trial.

## Guardrails and implementation choices

The existing Pi credential is read only through the public `readStoredCredential`
API into an in-memory scoped credential store, using an explicit canonical owner-only
file. No daemon home is mounted into model tools. Expired or imminently expiring
credentials stop the trial rather than silently refreshing or rewriting the user's
login. OAuth SDK operations remain the authentication authority; no endpoint or
originator spoofing, custom OAuth implementation or authentication bypass.

Every new test state, host configuration, socket, browser profile and Worktree is
under a freshly created temporary root. Never restart or reconfigure existing
PI WEB services. A second test instance uses distinct data/agent/session roots,
loopback port and daemon socket. Browser/proxy credentials are generated for this
local trial only and never printed. Kernel/browser sandbox restrictions stay on.

Start with at most four SDK admissions for a model smoke, with bounded output and
wall clock. A hosted synthetic coding/QC trial has at most two attempts, finite
per-Run request/tool/deadline budgets, and no tool-accessible publication secrets.
No unbounded retry of a model or uncertain external Git operation. Any actual
request counts and effort selections must be recorded separately from configured
limits; these are not a guaranteed monetary ceiling for a subscription account.

Before any same-repository publication: inspect its Actions/deployment triggers,
use fresh synthetic test branches, preserve repository protections, check exact
remote repository/base/source identity and SHA, and require explicit operation
approval through the orchestrator. Preserve uncertain publication receipts and
reconcile with real remote state instead of pushing/merging again blindly.

## Evidence and completion

Record exact source/fixture SHA, component versions, selected model/effort,
actual completed input, no-replay reconnect, host/browser interactions, abort and
restart outcomes, PR/base/merge identity, and cleanup/remaining resources. Local
process receipts replace workflow/job IDs for local acceptance; they do not
pretend to be Actions evidence. Mocked transports, SDK-only smoke and actual
hosted/browser/remote tests must remain separately named.

The earlier #91 test-only identity / GitHub Environment requirements are retained
as the automated-runner profile, not an obstacle to the owner's explicitly
approved local existing-login profile. The earlier separate-repository condition
in #92 is replaced **for this trial** by two isolated test branches in this repository.
Original risks remain: branch isolation is not tenant/credential isolation, OAuth
usage consumes the selected account's allowance, and full production-host
qualification remains #86. Unexecuted cases stay unverified and open.

Model reference: https://developers.openai.com/api/docs/models/gpt-6-luna
The published effort values include low and max. The **installed SDK catalog and
actual successful request**, not a display label alone, determine test support.
