# Pi Durable as the default Micromanager execution engine

- Status: Experimental, verified with the **real** Pi Durable 1.2.0
  `Harness` and scripted Pi AI provider; authenticated provider/PI WEB host
  acceptance remains outstanding
- Applies to new Workflow configurations. Existing saved Workflow and
  one-command profiles without an explicit `runtime` retain their original
  `pi-web` session backend, even when a daemon restarts.

## Overview

New Micromanager Autopilot configurations use `runtime:"durable"` by
default. The One-command setup form offers **Pi Durable (default)** and
**PI WEB native Pi (compatibility)**, with Advanced JSON support.

```json
{
  "runtime": "durable",
  "managedWorktrees": true,
  "workspaces": {},
  "finalization": {"workspaceId":"auto","autoMerge":true},
  "publication": {"remote":"origin","baseBranch":"main","draft":true},
  "models": {
    "planner":{"provider":"openai","model":"REPLACE_WITH_AUTHENTICATED_MODEL"},
    "implementer":{"provider":"openai","model":"REPLACE_WITH_AUTHENTICATED_MODEL"},
    "qc":{"provider":"openai","model":"REPLACE_WITH_AUTHENTICATED_MODEL"},
    "architect":{"provider":"openai","model":"REPLACE_WITH_AUTHENTICATED_MODEL"}
  },
  "test":{"file":"node","args":["--test"],"timeoutMs":60000},
  "maxAttempts":3
}
```

The rest of the permissions and test settings stay unchanged. The operator
still explicitly approves or starts every Workflow. Existing final QC,
Git ancestry, mandatory host-run tests, Workflow permissions, GitHub PR
checks and exact `MERGED` confirmation are unchanged.

## Runtime and PI WEB visibility

- Each implementation/QC/diagnosis/planner Run is a real
  `@earendil-works/pi-durable` **1.2.0** Harness/Conversation with its
  own SQLite database under PI WEB's plugin-specific data directory.
  A scoped, deterministic `durable:<sha256>` Run identity binds the
  conversation to the registered Workflow/Task/attempt; no native Pi
  Session is impersonated.
- Each original Task executes in its own PI WEB-discovered linked Git
  Worktree, validated **before** launching the Durable Harness.
  QC and diagnosis have only the read tool plus their typed,
  bounded reporting tool; implementation has bounded coding tools.
  Typed `mm_qc_report`, `mm_task_report`,
  `mm_plan_intervention`, and `mm_workflow_proposal` are validated by
  Micromanager and never bypass independent host Git/test authority.
- The Durable process uses `watchEvents()`; the Micromanager server
  maps public text/tool status to the existing PI WEB package peer
  `agents.events` channel. **Orchestra / Live Runs** shows the
  Durable label, streamed progress, activity history, and exact
  task/role/Run identity beside normal Pi Runs.
- **Steer**, **Follow-up** and **Interrupt** in Orchestra map to
  Durable `conversation.submit({whenBusy:"steer"|"followUp"})` and
  `conversation.abort()`. The server validates Workspace/Run scope and
  uses idempotent request IDs. Acknowledgements are not proof of task
  completion. After a browser reload, history and current Run status
  are reconstructed from server receipts.
- The normal PI WEB **Chat Session list** does **not** display a Durable
  Conversation; that is a separate host abstraction. Use Micromanager's
  Orchestra and Journal for monitoring.

## Credentials: important difference

**Pi Durable now uses Pi's official `ModelRuntime` from
`@earendil-works/pi-coding-agent`.** It reads the authenticated Pi CLI
profile (normally `~/.pi/agent/auth.json`) of the **PI WEB daemon's
operating-system user**, including subscription OAuth, and uses Pi's
lock-aware refresh flow. An already logged-in `pi` account can therefore
power Durable without copying an access token or adding an API key.
Provider credentials never enter Micromanager's Run SQLite registry,
Git repository, browser profile or events.

Check readiness **as the daemon user** with
`pi auth check --provider openai`. For a subscription-authorized model,
use its exact provider/model ID (for example `openai/gpt-5.5` when
available in that user's installed Pi catalog). Other providers can
use their Pi auth.json entries or daemon-environment API keys.
Browser-only ChatGPT login, a different Linux user's Pi profile, or
PI WEB-managed credentials outside the daemon's Pi profile are **not**
automatically shared. Authentication failure stops a new Run instead of
silently choosing another provider or exposing credentials.

The worker tool execution environment removes inherited
provider/CI/GitHub token variables. This is **not an OS sandbox**:
workers may have access to readable files, credentials on disk and
network interfaces. Use an isolated host/user without production
credentials for any untrusted model/code and keep merge permission
`ask` until trial verification.

## Restart and uncertain side effects

Durable's own task graph, transcript and tool checkpoints persist in a
separate SQLite file for each Run. On PI WEB daemon restart,
Micromanager locates exactly the original session ID, validates the
PI WEB Workspace path and the previously acknowledged model identity,
reopens that database and resumes eligible Durable work.

A tool that might have made non-idempotent Git/shell changes while its
result was lost is **not replayed blindly**. If the saved intent is
uncertain, Micromanager pauses Autopilot and requires reconciliation
rather than risk a second code-writing tool call or a false QC PASS.
Durable itself notes its API is experimental and does not guarantee
exactly-once external side effects for arbitrary tools.

Earlier persisted configurations without `runtime` are interpreted as
`pi-web` when loaded, **not silently upgraded**. To move an existing
Workflow to Pi Durable, first finish/seal its live native sessions,
then explicitly save a new configuration with
`"runtime":"durable"`; do not replace a running native Session.

## Native compatibility and current limits

Set `"runtime":"pi-web"` for the original PI WEB hosted coding-agent
path (including its existing native Pi companion/toolset), or choose
PI WEB native Pi in the first-time setup form. Manually created
`agents.create` sessions stay PI WEB-native for now.

The Durable backend uses its own tool registry; it is not a
byte-for-byte clone of every Pi Coding Agent extension. Native Pi
`auth.json` credentials **are** reused through `ModelRuntime`, but
arbitrary third-party Pi extensions, host-owned shell identities and
interactive approval UI are not automatically carried across. The PI WEB service must be trusted and
configured deliberately. Initial provider-authenticated model/PI WEB
E2E, multi-agent throughput on the real daemon and crash-soak remain
to be verified.

## Test and acceptance

For a direct, **opt-in authenticated smoke test** on the intended PI WEB
daemon OS account, first verify `pi auth check --provider openai`, then run:

```sh
npm install --no-audit --no-fund
node scripts/durable-auth-smoke.mjs openai gpt-5.5
```

Replace the provider/model IDs with exact entries from `pi --list-models`.
This performs a real model request using the daemon user's Pi OAuth/API
key. It gives the model **only one inert test reporting tool**: no
shell, repo, edit, filesystem or GitHub tools. It then closes/reopens a
disposable SQLite database and verifies the Conversation ID is unchanged
and the tool executed once. The temporary database is deleted, and
no credentials are logged or stored in Micromanager's state.
It does **not** exercise the PI WEB browser, Worktrees, Git publication or
host service restart; those still require the separately documented
disposable-repository acceptance trial.

### Authenticated Autopilot and Git Worktree acceptance (no GitHub access needed)

For a wider **opt-in** acceptance test that includes Micromanager's server
plugin, run:

```sh
node scripts/real-durable-autopilot-smoke.mjs
```

This creates an isolated Git repository and a separate linked Worktree under
the OS temporary directory. It runs a real `openai/gpt-5.5` Pi Durable
implementer using the current user's Pi OAuth, verifies the commit and tests,
starts an independent real Durable QC turn through the Autopilot scheduler,
and checks the QC PASS evidence, both sealed Run records, clean Git HEAD,
and released Worktree leases. The host-side PI WEB v3 capability interface
is simulated; model requests, durable conversations, SQLite, Git and host
tests are real. It **does not** install/alter PI WEB services, use the
browser, create remote repositories, Push, merge PRs or touch production
worktrees. Tests can consume provider/subscription quota. Use the exact
documented workflow to test the actual daemon, UI and GitHub permissions
separately on a disposable repository.

Run `npm run check`. The suite uses the **actual Durable 1.2.0**
Harness, SQLite-backed Conversations, `fauxProvider` replies and
host registry/ledger evidence, in addition to the native PI WEB mock
suite, git Worktree integration and 64-way scheduler capacity tests.
It verifies durable typed QC reports, missing-report fail-closed
behavior, identity uniqueness, event redaction, default config and
legacy compatibility. It does **not** claim real provider authentication.

For an authorized E2E, follow [Quickstart](QUICKSTART.md), use a
**disposable** GitHub repository, run one implementation and one QC
with the daemon user's authenticated Pi profile, inspect both
Orchestra Durable cards, send one steer/follow-up, test daemon restart
while idle and running, and verify GitHub exact merged SHA. Test native
fallback separately. Do not use production for the initial test.

Upstream API: [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
