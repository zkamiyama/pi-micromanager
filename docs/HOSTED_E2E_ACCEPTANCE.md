# Hosted PI WEB, parallel Runs, QC and publication recovery acceptance

**Accepted on 2026-10-15 for the approved local test profile:** the actual model/GitHub trial passed all 15 required receipt checks and merged test PR #100 into its test-only base. See the [exact-source acceptance record](HOSTED_E2E_LIVE_ACCEPTANCE_2026-10-15.md). Earlier draft failures are preserved in [the historical progress log](HOSTED_E2E_PROGRESS.md); they are not the current #92/#38 status.

This suite covers #92, under parent #38. It is not a rerun of #91's separately accepted owner-operated Luna Low SDK smoke. The runner combines the registered Micromanager plugin in actual PI WEB, an actual browser/public peer, Durable, isolated tools, QC, publication approvals, and reconciliation after lost replies.

A successful implementation build or faux rehearsal is not authenticated-provider or external-GitHub acceptance. Existing services, main/release branches and production state are not test targets. The accepted historical trial also does not validate the unfinished ADR-0020 `local-owner` profile or its new lifecycle draft.

## Three modes

| Mode | Actually exercised | Deliberately excluded |
| --- | --- | --- |
| `ui` | Separate PI WEB, sandboxed Chromium, loopback Basic-auth ingress, Workflow persistence and test-daemon restart | Models and GitHub |
| `rehearsal` | The above plus real product parallel Runs, isolated tools, QC, authorization, restart and local Git | Model responses are faux; GitHub is explicitly simulated using local bare Git and response fixtures |
| `live` | The product path plus existing Pi ChatGPT OAuth, Luna Low/Max QC and actual GitHub test-only refs | Main/release publication, existing daemons, arbitrary models and unlimited retries |

Basic authentication uses a random test-only value. HTTP and WebSocket browser traffic share that loopback ingress, and unauthenticated requests must return 401. This does not certify TLS, tenant isolation or deployment authentication. Provider and GitHub credentials are not sent to the browser.

## Preparation

Use Linux, Node 22 or 24, Bubblewrap, prlimit, flock and Git; live mode also requires gh and the approved existing login. Use pinned Playwright from the lockfile and keep Chromium sandboxing enabled. The operator provisions system libraries. Missing namespace support is not a reason to use `--no-sandbox`, elevate privileges or disable OS security.

```sh
npm ci --no-audit --no-fund
npm run build
npx --no-install playwright install --only-shell chromium
npm run test:e2e:hosted -- --mode ui
npm run test:e2e:hosted -- --mode rehearsal
```

`test:e2e:hosted` invokes `scripts/local-hosted-e2e.mjs`. The separate quartet runner uses `test:e2e:hosted-quartet` with `faux` or `oauth`; see [HOSTED_ACCEPTANCE.md](HOSTED_ACCEPTANCE.md). Their modes are not interchangeable.

CI's `hosted-acceptance-rehearsal` installs dependencies in a disposable runner and executes rehearsal only, without secrets or a write token. Existing Node 22/24 and mandatory successful-isolation jobs remain required.

## Owner-operated real authentication and publication

Use only the approved `openai/gpt-6-luna` Low/Max profiles and fresh `e2e/local-luna-*` source/base branches in this repository. Start from a reviewed clean main checkout, inspect its exact SHA, and pass that SHA explicitly. Live admission also verifies it against GitHub's main.

```sh
SHA=$(git rev-parse HEAD)
RESULTS=$(mktemp -d /tmp/mm-hosted-result-XXXXXX)
node scripts/local-hosted-e2e.mjs \
  --mode live --expected-sha "$SHA" \
  --approve-account-use --approve-test-publication \
  --receipt "$RESULTS/hosted.json"
RESULT=$?
printf 'exitCode=%s\n' "$RESULT"
cat "$RESULTS/hosted.json"
```

This uses more calls than the SDK smoke: two independent synthetic Tasks, independent QC, final integration/final QC and a deliberate interruption Task. Each Run has at most 12 model admissions, 50 tool admissions and 180 seconds; concurrency is four, and each Workflow has at most two attempts. An overall supervisor deadline also applies. These are not exact monetary limits. The scenario tests successful QC, not deliberately failing QC followed by rework.

The default sources are `~/.pi/agent/auth.json` and `~/.config/gh`. Use `--pi-auth-file` or `--gh-config-dir` only to name another explicitly approved absolute path. Do not copy or display credentials or mount them into model tools. The public Pi SDK owns normal OAuth refresh. There is no implicit API-key/provider fallback or automatic permission change to make an existing file acceptable.

## Scenario sequence

1. Allocate fresh private HOME, agent/session/state roots, socket, loopback ports and browser state.
2. Launch the shipped PI WEB executables and use documented plugin registration plus public Browser API `context.peer.request`, not private routes.
3. Save a synthetic Workflow through the UI; restart only the test daemon and retrieve the same Workflow.
4. Observe implementations in two distinct Git Worktrees and send one public-peer Steer command.
5. Let product paths complete implementation, independent QC, final integration and final QC. Model changes are limited to the generated fixture's `a.txt` and `b.txt`; test or CI changes are refused before publication.
6. Check each `ask` approval's Task, QC SHA, repository, base and source, then approve only that test subject through the public peer. Do not change general permissions to `allow`.
7. A test-owned `Host.execFile` wrapper loses one successful Push reply and one successful Merge reply. It never fabricates success before the actual side effect.
8. Restart the test daemon. The product inspects actual remote state and completes without a second Push/Merge. Unproved outcomes stop rather than being blindly retried.
9. Abort a separate delayed Task; after restart, prove no extra Run or model request was admitted.
10. Verify browser and descendant-process completion. A stopped parent, reused PID or D-state child is not a joined process tree.

Actions run even for a PR targeting a non-main test base. Workflow definitions and branch protections remain unchanged; the product does not merge until real CI succeeds. Keep test refs as evidence. Failed trials retain local state rather than erase uncertain outcomes; receipt trial fields identify the external refs.

## Product fixes and compatibility

### Separate final merge authority from required ancestors

The earlier final-integration path confused QC-approved SHAs to be merged with `requiredAncestors`, leaving an empty broker merge allowlist. Because sandboxed workers do not receive Git administration data, this was a real integration-path omission.

`allowedMergeShas` now persists in the immutable launch record, is rechecked against current QC at the host boundary, and reaches the final Run's fixed Git broker. It is separate from ancestors that must already exist before an ordinary dependent Task starts. The regression failed before the fix and passed afterward. Old final Runs missing that proof are refused; do not inject authority into an uncertain legacy Run and replay it.

### Explicit host-only model credential source

`productionSecurity.modelAuthFile` is optional and host-owned. Omitting it preserves existing behavior. Selecting it requires a private owner file and canonical path outside projects, control state and executable packages. Workflow/model arguments cannot change it. The public `ModelRuntime` receives the selected source without implicitly loading custom models.json. Readiness responses do not disclose the path or credentials.

## Sharing results and assurance limits

Share only the final JSON and exit code, not authentication files, raw SDK logs, SQLite or model text. Do not relabel `live`, `rehearsal` and `ui` results. `productionSafetyGuaranteed` is always false. Platform hard quotas, kernel status, independent review and operational GC are not certified by this test; ADR-0020 separately narrows the intended product profile.

## Historical local environment failure

During development, a credential-free hosted rehearsal left test Bubblewrap children in Linux D-state, with `exp_funnel_lock` in their wait channel. Ordinary `/bin/true` and Workspace inspection completed, but the isolated invocation did not join. The precise kernel cause was not established. The attempt stopped without disabling OS protections or restarting an existing service; incomplete checks were not counted as success.

The process tracker was hardened so an exited parent cannot prove descendant completion. Child survival, PID reuse and reparenting are treated separately. After the owner's WSL restart, later accepted trials completed. CI on a fresh runner is independent code/isolation evidence, not proof that a particular local kernel was repaired or certified.

## Local gates when Actions capacity is unavailable

The owner authorized equivalent local validation rather than waiting for Actions capacity. That does not authorize skipped tests or weakened branch protection. Record the exact candidate SHA, clean-tree status, actual Node versions, exit codes, counts and exclusions.

Required gates are `npm run check` on Node 22 and 24, every file in the current CI `successful-isolation` step (including search, diagnostics and later required additions), `npm run test:e2e:hosted-quartet -- --mode faux`, and `npm run test:e2e:hosted -- --mode rehearsal`. Keep `MM_REQUIRE_SANDBOX=1` and browser sandboxing. A faux rehearsal is not real authentication/GitHub acceptance.

If the smallest disposable Bubblewrap probe cannot join, stop rather than repeat it or use `--no-sandbox`. Complete these gates only on a working isolation host. Existing service restarts and OS reconfiguration are outside the script. A candidate whose necessary gates are incomplete is not ready to merge.
