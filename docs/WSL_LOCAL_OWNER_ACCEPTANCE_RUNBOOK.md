# Windows/WSL local-owner acceptance: operator runbook

Status: **operator verification in progress**, 2026-10-15. Scope: [ADR-0020](adr/0020-local-owner-durable-product.md), [#86](https://github.com/zkamiyama/pi-micromanager/issues/86), and parent trackers #36/#37. This is the **single trusted owner / Windows + WSL2 / localhost / Durable** profile, not a public web-service certification.

## 0. Evidence already accepted — do not repeat unnecessarily

The operator ran the **merged** commit `1597f7e781bab9355f5c2552043bd9c05e03edb4` from the separate clean checkout `/tmp/mm-wsl-verify-cVemDA/repo` on their target WSL:

| Fact | Observed |
| --- | --- |
| Kernel | `6.18.33.1-microsoft-standard-WSL2` |
| Node | `v22.23.3` |
| Bubblewrap | `/usr/bin/bwrap` |
| Contracts | **27 passed / 0 failed / 0 skipped** |
| Lifecycle | **17 passed / 0 failed / 0 skipped** |
| Shipped PI WEB / Chromium browser | **3 passed / 0 failed / 0 skipped** |
| Stuck D-state Bubblewrap processes | **0 before and 0 after** |
| Overall | `WSL_TESTS_FINISHED` |

The three `LOCAL_OWNER_CI_RECEIPT` objects report `passed: true`, a clean checkout, exit 0, no interrupted runs, and the expected lockfile hash. Evidence is recorded in [#86](https://github.com/zkamiyama/pi-micromanager/issues/86#issuecomment-6191924080).

**This completes the credential-free WSL software smoke, not the entire host qualification.** The faux-provider tests do not authenticate the owner's Luna model account or publish to a real GitHub test branch. Their receipt therefore correctly leaves `targetWsl: not-verified` and `productionSafetyGuaranteed: false`.

## 1. Safety rules for every remaining step

- **Do not** modify an existing `~/.pi-web` instance, native Pi Session, existing Micromanager state root, production daemon, `.wslconfig`, Windows Firewall, Linux security settings, or GitHub branch protection.
- Never switch an existing state directory from `production` or native compatibility to `local-owner`. New-profile activation requires a **new private state root**.
- Never use `--no-sandbox`, force/remove arbitrary Worktrees, clear ownership markers, or retry an ambiguous Push/Merge/delete. A failed join or unknown external effect requires inspection, not repetition.
- Do not display, copy, upload, or paste Pi OAuth credentials, GitHub credentials, raw private transcripts, or native Session databases. Share only status, commit/version metadata, counts, and redacted errors.
- Synthetic live publication, if separately enabled, may target only fresh `e2e/local-luna-*-base` / `-final` references **in this repository**. Never publish test data to `main` or release branches.
- If an isolated test cannot be distinguished from a live service, **stop**. Leave ambiguous test state for review; do not guess which process or directory is disposable.

## 2. Verify access from Windows to the existing PI WEB

This is a **connectivity/authentication observation**, not proof that the existing instance has been migrated to `local-owner`.

1. In WSL, identify the localhost URL/port from the PI WEB instance you already use. Do not assume port 8504 if your installation is configured differently.
2. Inspect the listening address without editing any settings. In a WSL terminal, replace the port:

   ~~~sh
   PORT=8504  # Replace with the actual existing PI WEB port.
   ss -ltn "( sport = :$PORT )"
   ~~~

3. In **Windows Edge or Chrome**, open `http://localhost:PORT` using that actual port. Verify the normal PI WEB page loads, you can select the expected Git project, and the **Micromanager** panel can load. Do not start a modifying Workflow for this test.
4. If your existing PI WEB configuration requires authentication, check in a fresh private browser window that an unauthenticated client cannot perform authenticated operations. If no authentication is configured, record **"loopback-trusted; no independent login"** rather than claiming an auth-negative test passed. Localhost is not a defense against every local process or hostile browser page.
5. Verify the service is not deliberately bound to every network interface (for example `0.0.0.0`). If it is, record the fact and **do not enable YOLO publication** until the ingress boundary has been reviewed. Do not fix this by changing the firewall in this acceptance test.

Record: **Windows page loaded** (yes/no), **WSL listening address** (loopback/other/unknown), **effective auth assumption** (authenticated/loopback-trusted/unknown), and **Micromanager panel loaded** (yes/no). Do not share cookies, URLs containing secrets, or auth headers.

## 3. Fresh isolated `local-owner` UI smoke (no model calls or publication)

This optional hands-on check completes the **new-profile GUI/loopback observation** without changing the normal PI WEB service. It uses the already built, verified source and entirely disposable Git/PI WEB state. Its configuration has **no publication targets** and does **not** start a model Run.

**Run these commands in one WSL terminal; keep that terminal open for shutdown.** The explicitly chosen port 18504 must be unused. The commands do not install/restart systemd services.

~~~sh
set -euo pipefail
umask 077

SRC=/tmp/mm-wsl-verify-cVemDA/repo
SHA=1597f7e781bab9355f5c2552043bd9c05e03edb4
PORT=18504

test "$(git -C "$SRC" rev-parse HEAD)" = "$SHA"
test -f "$SRC/dist/pi-web/server.js"
test -f "$SRC/node_modules/@jmfederico/pi-web/dist/server/sessiond.js"

if ss -H -ltn "( sport = :$PORT )" | grep -q .; then
  echo "STOP: the isolated test port is occupied"
else
  ROOT=$(mktemp -d /tmp/mm-local-owner-ui-XXXXXX)
  mkdir -p "$ROOT/state/plugins" "$ROOT/agent" "$ROOT/sessions"
  git clone -q --no-local --no-hardlinks "$SRC" "$ROOT/project"
  git -C "$ROOT/project" switch -q --detach "$SHA"
  ln -s "$SRC" "$ROOT/state/plugins/micromanager"
  printf '{"defaultProjectTrust":"never","packages":[]}\n' > "$ROOT/agent/settings.json"

  node - "$ROOT" "$PORT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, port] = process.argv.slice(2);
const config = {
  host: '127.0.0.1', port: Number(port),
  spawnSessions: false, subsessions: false,
  plugins: {
    micromanager: {
      enabled: true,
      settings: {
        productionSecurity: {
          mode: 'local-owner',
          projectRoots: [path.join(root, 'project')],
          models: [{provider: 'openai', model: 'gpt-6-luna'}],
          publication: [],
          limits: {maxConcurrentRuns: 1, maxModelRequests: 8,
                   maxToolCalls: 25, maxRunMs: 120000},
          maxCommandMs: 20000,
          localRetention: {maxBytes: 10485760, maxAgeDays: 1,
                           autoReclaimWorktrees: false}
        }
      }
    }
  }
};
fs.writeFileSync(path.join(root, 'pi-web.json'),
  JSON.stringify(config, null, 2) + '\n', {mode: 0o600});
NODE

  export PI_WEB_CONFIG="$ROOT/pi-web.json"
  export PI_WEB_DATA_DIR="$ROOT/state"
  export PI_WEB_SESSIOND_SOCKET="$ROOT/sessiond.sock"
  export PI_WEB_HOST=127.0.0.1
  export PI_WEB_PORT="$PORT"
  export PI_CODING_AGENT_DIR="$ROOT/agent"
  export PI_CODING_AGENT_SESSION_DIR="$ROOT/sessions"
  export PI_WEB_OFFLINE=1
  export PI_OFFLINE=1
  export PI_WEB_SKIP_VERSION_CHECK=1
  export PI_SKIP_VERSION_CHECK=1

  node "$SRC/node_modules/@jmfederico/pi-web/dist/server/sessiond.js" \
    > "$ROOT/sessiond.log" 2>&1 &
  DAEMON_PID=$!
  node "$SRC/node_modules/@jmfederico/pi-web/dist/server/index.js" \
    > "$ROOT/web.log" 2>&1 &
  WEB_PID=$!

  echo "TEST_URL=http://localhost:$PORT"
  echo "TEST_PROJECT=$ROOT/project"
  echo "TEST_ROOT=$ROOT"
  echo "TEST_WEB_PID=$WEB_PID TEST_DAEMON_PID=$DAEMON_PID"
fi
~~~

This start-up sequence uses the **public PI WEB 1.202610.2 executable paths and documented `PI_WEB_CONFIG`/`PI_WEB_DATA_DIR`/socket overrides**. It is a manual recipe, **not** an already recorded passing new-profile live trial. If a subprocess exits, inspect only `$ROOT/web.log` and `$ROOT/sessiond.log` after excluding secrets; do not fall back to the installed PI WEB state.

In Windows Edge/Chrome, open the printed `TEST_URL`. Add the printed `TEST_PROJECT` as a Git project and open **Micromanager**. For a non-executing UI record, import the following harmless Workflow definition via **Import a real Workflow DAG** and **do not click Start Autopilot**:

~~~json
{
  "id": "wsl-ui-smoke",
  "title": "Disposable WSL UI inspection — do not execute",
  "maxQcRounds": 2,
  "maxParallelByRole": {"implementer": 1, "reviewer": 1, "planner": 1, "architect": 1},
  "permissions": {
    "default": "deny",
    "actions": {"git.push": "deny", "github.pr.create": "deny", "github.pr.merge": "deny"}
  },
  "tasks": [{
    "id": "inspect",
    "title": "No agent launch required",
    "kind": "implementation",
    "role": "implementer",
    "dependsOn": [],
    "description": "UI-only inspection; do not start the task",
    "acceptanceCriteria": ["The Journal and local storage sections render"]
  }]
}
~~~

Open **JOURNAL → Load evidence-linked journal**. The **Local storage usage** section should be visible for the selected Workflow. No sealed QC exists in this smoke, so image import should **not** be accepted. The isolated instance is deliberately offline, has no GitHub publication allowlist, and is **not a live authentication test**.

Stop **only these test-owned PIDs in the same WSL terminal** when finished:

~~~sh
kill -TERM "$WEB_PID" "$DAEMON_PID"
wait "$WEB_PID" "$DAEMON_PID" || true
ss -ltn "( sport = :$PORT )"
~~~

Keep the printed `TEST_ROOT` until the test processes have demonstrably exited. Never delete a running or uncertain test root. This procedure does **not** stop or restart the installed `pi-web` service.

Record: **isolated page loads**, **Micromanager active**, **Journal/local usage visible**, **no model or publication**, **test daemon stopped**, and **D-state Bubblewrap count**. A failure does not invalidate the previously accepted 47/47 software smoke; it identifies a distinct host setup issue.

## 4. Actual OAuth + test-only GitHub publication — remaining separate acceptance

**There is not yet a valid one-command `local-owner` live runner at the merged SHA.** The existing `scripts/local-hosted-e2e.mjs --mode live` selects the older **strict `production`** host profile. Its test adapter explicitly refuses `local-owner` together with real credentials/live mode. **Do not use it to claim `local-owner` acceptance, and do not remove this guard.**

Do **not** enable GitHub writes on the offline UI-smoke host from section 3. A separate reviewed *local-owner live* runner or a fully supervised, equivalently constrained test setup must first demonstrate all of these conditions:

1. Fresh private state/config/agent/session roots, actual authenticated local-owner PI WEB, loopback ingress and browser access, and actual successful Bubblewrap isolation. No existing daemon is restarted.
2. Approved Pi ChatGPT OAuth source used **host-side only**, without copying tokens to Workers, Git, logs or CI. Model `openai/gpt-6-luna`: implementer `low`, QC `max`; no provider fallback.
3. Exact main SHA recorded **before** the trial and verified unchanged **after**. In repository `zkamiyama/pi-micromanager`, provision fresh disjoint `e2e/local-luna-<nonce>-base` and `e2e/local-luna-<nonce>-final` references. Pin publication allowlist **only to that new test base**, never `main` or a release branch. Stop if a branch already exists or a destination cannot be proved.
4. Bounded requests/tools/runtime, explicit source/target/action permissions, sandboxed test execution, distinct modifying Worktrees, independent QC, and exact input/result receipts. All GitHub protection checks remain authoritative.
5. Real test-only Push/PR/Merge evidence, with controlled loss of a successful response and external-state reconciliation **without repeating the side effect**. Separate Abort, joined shutdown and restart/no-replay checks.
6. Record the final source SHA, source/base branch names, test PR and Actions URLs, signed-off receipts and any unverified protections. Never infer successful deletion/Push/Merge from missing local state.
7. If a live outcome or shutdown is uncertain, **stop and preserve the trial**. Do not blindly rerun the same test refs, force-merge, delete branches, or clear data until reconciled.

This phase is **not** authorized to merge test fixtures to main or expose the service publicly. It may incur real model usage. A successful earlier *strict-profile* OAuth/GitHub trial cannot be relabeled as success for the new profile.

## 5. Record resource assumptions (observation only)

In the WSL terminal, collect nonsecret host metadata:

~~~sh
printf 'kernel='; uname -r
printf 'node='; node -v
printf 'bubblewrap='; command -v bwrap
printf 'D-state bubblewrap='
ps -eo stat=,comm= | awk '$1 ~ /^D/ && $2 == "bwrap" {n++} END {print n+0}'
free -h
df -h /
~~~

Record effective memory/storage availability and whether WSL-wide limits have **independently** been configured. Do not modify them for this test. Application request/byte/time limits and per-process restrictions are **not** proof of hard aggregate cgroup/disk quotas or exact spending limits. Same-UID processes and the host/Windows kernel remain trusted under ADR-0020.

## 6. Acceptance record template

Copy the following **metadata only** into the English #86 acceptance record:

~~~text
Date/time (JST):
Source SHA: 1597f7e781bab9355f5c2552043bd9c05e03edb4
WSL kernel: 6.18.33.1-microsoft-standard-WSL2
Node: 22.23.3
Credential-free gates: contracts 27/27, lifecycle 17/17, browser 3/3
D-state bwrap before/after: 0/0
Windows browser -> existing WSL PI WEB: PASS / FAIL / NOT RUN
Existing ingress bind/auth assumptions:
Disposable local-owner UI smoke: PASS / FAIL / NOT RUN
Test-owned processes all joined: YES / NO / UNKNOWN
Real local-owner OAuth + test-only GitHub trial: PASS / FAIL / NOT RUN
Test-only PR + Actions refs (if actually executed):
Main SHA unchanged after real trial: YES / NO / NOT RUN
Memory/disk/cgroup assumptions reviewed:
Remaining uncertainty:
No existing service/OS/native data touched: YES / NO
Production safety guaranteed: NO
~~~

## 7. Close/stop decision

- The **47/47 WSL credential-free suite is passed**, already documented in #86.
- Mark the **Windows ingress** and **isolated local-owner UI** stages passed only after observing them on the operator host.
- Keep **#86 open** until the approved new-profile real-account/test-branch trial and resource assumptions are recorded. Keep parent **#36/#37** open while #86 is open.
- Do not claim general SaaS security, tenant isolation, TLS, hard OS quotas or monetary billing guarantees. Those are explicitly outside this single-owner scope, not silently proven.
- Record every incomplete or refused check as `NOT RUN` / `UNKNOWN` rather than substituting an earlier strict-profile result.

Related documents: [Local-owner operation](LOCAL_OWNER_OPERATION.md), [CI-first acceptance](LOCAL_OWNER_CI_ACCEPTANCE.md), [previous strict-profile authenticated E2E](HOSTED_E2E_LIVE_ACCEPTANCE_2026-10-15.md).
