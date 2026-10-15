# Local Luna smoke test using the existing Pi ChatGPT login

Scope: #91 under parent #38. [Owner authorization](LOCAL_LUNA_ACCEPTANCE_AUTHORIZATION.md) is already recorded. This CLI lets the owner execute the same bounded procedure locally and share only its result JSON.

**Current acceptance:** #91 was completed from the owner's successful OAuth/Luna Low receipt at `6c1454215679c0cb79dc886ee3ea47c96e5956b4`. The separately accepted hosted/browser/GitHub test is documented in [the #92 receipt](HOSTED_E2E_LIVE_ACCEPTANCE_2026-10-15.md). The original tool-refused attempt below is historical, not a claim that these later successful runs never happened.

## What this suite verifies

The public Pi `ModelRuntime` and Durable SDK use the existing OpenAI OAuth login to call `openai/gpt-6-luna`, obtain one typed confirmation-tool result, and finish successfully. The suite verifies committed input completion and closes/reopens SQLite without replaying model requests or tool responses.

Use `low` normally. `max` runs only when explicitly selected with `--effort max`; that demonstrates connectivity at the higher setting, not an independent QC loop. Real PI WEB/browser interaction, parallel agents, PR publication and external-state recovery are separate hosted assertions. This script does not push, create a PR or manipulate an existing daemon.

## Preparation

Use Linux, Node 22 or 24, and a clean reviewed checkout. Run as the OS user logged into ChatGPT through Pi. Inspect `git status --short` and `git rev-parse HEAD`; do not reset unrelated changes or copy an authentication file just to run this test.

```sh
npm ci --no-audit --no-fund
npm run test:e2e:local-luna -- --mode faux
```

Faux mode reads no credentials. It verifies supervision, SDK persistence and reopen using a synthetic model and always reports `authentication: "not-verified"`.

## Run Luna Low once

Pass the reviewed commit and explicitly approve account use and normal OAuth refresh. The call may consume account allowance. Do not paste secrets into a command or chat.

```sh
SHA=$(git rev-parse HEAD)
RECEIPTS=$(mktemp -d /tmp/mm-luna-result-XXXXXX)
npm run test:e2e:local-luna -- \
  --mode oauth --effort low \
  --expected-sha "$SHA" --approve-account-use \
  --receipt "$RECEIPTS/luna-low.json"
RESULT=$?
printf 'exitCode=%s\n' "$RESULT"
cat "$RECEIPTS/luna-low.json"
```

The equivalent documented CLI is `node scripts/local-pi-oauth-smoke.mjs` with the same arguments. Calling it directly omits npm's headings; it does not bypass source, authentication, authority or isolation checks. Do not change routes to evade a refused operation.

The default auth file is `~/.pi/agent/auth.json`. Only for another owner-selected Pi profile, provide `--pi-auth-file /absolute/path/auth.json`. There is no implicit fallback through `PI_CODING_AGENT_DIR`, API keys, models.json or proxy settings. Missing, non-OAuth, symlinked or shared-readable credential sources are refused. The script does not change their permissions, copy credentials or manually rewrite tokens. Pi's standard credential store handles ordinary refresh.

## Optional Luna Max check

After reviewing the Low result, use `--effort max` and a new `luna-max.json` destination when a Max connectivity check is needed. Do not overwrite existing receipts. The script does not automatically retry or switch to Max.

## Limits and state handling

| Setting | Low | Max |
| --- | --- | --- |
| Model | `openai/gpt-6-luna` | `openai/gpt-6-luna` |
| SDK request admissions | At most 4 | At most 4 |
| Requested output-token ceiling per request | 1024 | 4096 |
| SDK deadline | 60 seconds | 120 seconds |

SDK retries are disabled. A supervisor requests termination on timeout and, if necessary, terminates only the test child it created. The model receives only a confirmation tool, not shell, file, Git or arbitrary extension tools. This is an SDK integration test, not an OS-isolation test of all provider network processing.

SQLite is created in a new private directory and removed only after SDK and child-process completion are confirmed. Unproved shutdown fails and retains temporary state. The suite neither restores nor deletes existing Sessions or production data. Output-token and SDK-request limits are not exact monetary guarantees.

## Share only the final receipt

Share **the final JSON and exit code**. The receipt identifies source commit, versions, lockfile digest, request count and each assertion. Do not share tokens, account identifiers, auth files, SQLite, model text or raw SDK errors. The parent does not forward child stdout/stderr.

| Exit code / status | Meaning |
| --- | --- |
| `0 / passed` | Typed response, committed completion and reopen checks passed for this run |
| `1 / failed` | Execution or evidence persistence failed; do not count as success |
| `2 / blocked` | An approval, source, credential or other prerequisite was not met |

`approval-required` means explicit approval is absent; `sha-mismatch` means the checkout differs from the selected SHA; `dirty-checkout` means local source changes; `credential-required` means the credential source is unsuitable. `model-unavailable` means the fixed model/effort could not be validated. `input-not-completed` or `runtime-failed` means successful completion was not proved. Do not retry `timed-out` or `shutdown-unproved` indefinitely; inspect the receipt first.

## Historical tool refusal and later owner acceptance

[The historical status record](LOCAL_LUNA_ACCEPTANCE_STATUS.md) preserves the earlier refusal and missing assertions. The owner's later request to retry/provide a manual test resulted in successful creation of this bounded script, with no tool/security-setting change. A refused execution must be recorded, not automatically retried through another tool or command.

On 2026-10-14, after 25 credential-free old/new-runner regressions passed without failure or skip, a single Low execution was requested at `e41c536252dccc0570803ae314c047dcb93b0cfe`. OpenAI's tool-safety check blocked the execution itself without a detailed reason, so that attempt produced no model-result JSON. No alternate-path rerun was made.

The original PR therefore delivered an owner-runnable script, not an observed real-model success. The owner subsequently executed the merged script and supplied a passing receipt at `6c1454215679c0cb79dc886ee3ea47c96e5956b4`, with two requests, successful authentication/typed report/committed input/reopen checks and `cleanup: removed`. That later evidence completed #91. Keep the failed tool attempt, the later owner-run SDK pass and the separate hosted #92 acceptance distinct.
