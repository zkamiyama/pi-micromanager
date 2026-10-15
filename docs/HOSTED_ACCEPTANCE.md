# Local acceptance: actual PI WEB, browser and Workflow lifecycle

Scope: #92 and #2–#4, separate from the SDK-only #91 smoke test. Use a new temporary state root and separate test processes; do not stop or change an existing service. Model use and same-repository test branches follow the [owner authorization](LOCAL_LUNA_ACCEPTANCE_AUTHORIZATION.md).

**Recorded acceptance:** the [actual OAuth quartet receipt](ADR19_DIAGNOSTICS_AND_COCKPIT_ACCEPTANCE.md) covers the reviewed #3/#4 scope. The separate [real publication/recovery receipt](HOSTED_E2E_LIVE_ACCEPTANCE_2026-10-15.md) covers #92. Neither receipt certifies the unfinished local-owner artifact/lifecycle profile in ADR-0020.

## Preparation

Use Linux, Node 22 or 24, working Bubblewrap and Git, and a clean reviewed development checkout.

```sh
npm ci --no-audit --no-fund
npm run build
npx --no-install playwright install chromium
```

An administrator provisions missing browser libraries using the development or CI host's normal process. Do not disable Chromium sandboxing to pass this test.

## Credential-free actual host with a faux model

```sh
npm run test:e2e:hosted-quartet -- --mode faux
```

The `test:e2e:hosted-quartet` alias runs `scripts/hosted-acceptance.mjs`. Do not substitute `test:e2e:hosted`: that is the distinct `local-hosted-e2e.mjs` runner, with `ui`, `rehearsal` and `live` modes documented in [HOSTED_E2E_ACCEPTANCE.md](HOSTED_E2E_ACCEPTANCE.md).

The quartet uses actual PI WEB, sessiond, Chromium, Micromanager, Durable, Git and Bubblewrap. Only model responses are replaced by bounded synthetic responses. The product's `src/` execution and authorization paths are not replaced. A thin test-only plugin wrapper receives a public `WorkspacePanelContext` and exercises the actual browser's public peer transport, not private host routes or fabricated Workflow transitions.

The scenario checks four simultaneous Runs and visible cards, compact/expanded/focused views, direct UI Steer to the exact QC, independent QC, two independent frozen-source diagnoses, synthesis, one explicit human resume, cross-project scope isolation, keyboard/narrow-viewport interaction, daemon restart, Abort/restart without duplicate dispatch, and test-process cleanup. Faux mode reports `realModelAuthentication: not-verified`; it is not authenticated-model acceptance.

## Owner-operated Luna execution

This consumes the authorized Pi ChatGPT account's allowance. Implementer/planner use `openai/gpt-6-luna` with `low`; QC/investigation use `max`. No API-key, alternative model, account or implicit-default fallback is permitted.

```sh
SHA=$(git rev-parse HEAD)
RESULTS=$(mktemp -d /tmp/mm-hosted-result-XXXXXX)
npm run test:e2e:hosted-quartet -- \
  --mode oauth --expected-sha "$SHA" --approve-account-use \
  --receipt "$RESULTS/hosted-luna.json"
STATUS=$?
printf 'exitCode=%s\n' "$STATUS"
cat "$RESULTS/hosted-luna.json"
```

Run as the OS user authenticated with Pi. Only select `--pi-auth-file /absolute/path/auth.json` for a different explicitly approved profile; otherwise the source is `~/.pi/agent/auth.json`. The public Pi SDK manages credentials and ordinary refresh. Do not copy tokens or embed them in command arguments.

The test has separate HOME and Pi state. Model file/shell tools use the existing isolation boundary and cannot access the original HOME, credentials, Git administration data or host network. It allows at most four concurrent Runs, 24 model admissions and 64 tool admissions per Run, five minutes per Run and two implementation attempts, under a finite overall supervisor deadline. These limits are not an exact billing or network-retry guarantee. Failure does not automatically raise the model tier or add attempts.

## Optional real test-branch publication

Only `--approve-test-publication` authorizes GitHub writes from this runner. Targets are fixed to new `e2e/local-luna-*` test base/source branches in `zkamiyama/pi-micromanager`, never main, release or existing user branches. The host uses its ordinary approved GitHub CLI login; credentials are not passed to model tools. GitHub branch protections and CI remain active.

```sh
SHA=$(git rev-parse HEAD)
RESULTS=$(mktemp -d /tmp/mm-publication-result-XXXXXX)
npm run test:e2e:hosted-quartet -- \
  --mode faux --expected-sha "$SHA" --approve-test-publication \
  --receipt "$RESULTS/hosted-publication.json"
STATUS=$?
printf 'exitCode=%s\n' "$STATUS"
cat "$RESULTS/hosted-publication.json"
```

This optional combination uses a faux model but actual product QC, approval, Git push, Draft PR, checks, exact-SHA merge and reconciliation. For a real model too, use `--mode oauth --approve-account-use` with the publication flag. The accepted full publication/recovery procedure, including lost Push and Merge replies, is separately documented in [HOSTED_E2E_ACCEPTANCE.md](HOSTED_E2E_ACCEPTANCE.md).

Preparation creates only a synthetic fixture on a new test base. Product paths perform the publication. The supervisor checks repository, base, source, QC SHA and the precise allowed marker diff before approval. A test-owned wrapper loses a successful merge reply once; after a test-daemon restart, the product must inspect actual GitHub state rather than issue a duplicate merge. The supervisor also refuses a second external merge. No force push or unconditional retry is used.

Remote test refs remain as evidence even after success, and receipt fields identify PR and SHAs. Failed or interrupted trials retain local state because external outcomes may be uncertain. `retainedFixture` identifies a test-root basename under `/tmp`; inspect the ledger and remote facts before deletion or rerun.

## Interpreting and sharing results

Share only the final JSON and exit code. Do not share tokens, authentication files, SQLite, raw server/SDK logs or model text. Test-process stdout/stderr is not an acceptance artifact for publication.

`status: passed` applies only to the selected mode and completed assertions. A faux-model pass, use of an existing account, or separate branches in one repository does not certify independent tenants, public TLS, deployment isolation, hard aggregate resource limits or exact spend. Production startup, shutdown and deployment are outside this runner's scope. Credential-free CI uses faux mode without publication permission.
