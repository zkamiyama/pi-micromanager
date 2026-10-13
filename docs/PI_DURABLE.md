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

**PI WEB-native model authentication is not automatically shared with
Pi Durable.** Its `Models` provider runtime resolves credentials using
the PI WEB daemon's environment and available provider backends. Configure
a real authenticated model for every role using Pi Durable-compatible
provider/model IDs (not just a PI WEB UI display label). For example,
an OpenAI provider may use `OPENAI_API_KEY`, available to the daemon's
own process. Store the secret in your host's secret manager or
service configuration, never in the Workflow JSON, Git repo or browser.

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
byte-for-byte clone of every Pi Coding Agent extension. Provider OAuth
stored only in native `auth.json`, arbitrary third-party Pi extensions,
host-owned shell identities, and interactive approval UI are not
automatically carried across. The PI WEB service must be trusted and
configured deliberately. Initial provider-authenticated model/PI WEB
E2E, multi-agent throughput on the real daemon and crash-soak remain
to be verified.

## Test and acceptance

Run `npm run check`. The suite uses the **actual Durable 1.2.0**
Harness, SQLite-backed Conversations, `fauxProvider` replies and
host registry/ledger evidence, in addition to the native PI WEB mock
suite, git Worktree integration and 64-way scheduler capacity tests.
It verifies durable typed QC reports, missing-report fail-closed
behavior, identity uniqueness, event redaction, default config and
legacy compatibility. It does **not** claim real provider authentication.

For an authorized E2E, follow [Quickstart](QUICKSTART.md), use a
**disposable** GitHub repository, run one implementation and one QC
with a real Durable-compatible provider key on the daemon, inspect both
Orchestra Durable cards, send one steer/follow-up, test daemon restart
while idle and running, and verify GitHub exact merged SHA. Test native
fallback separately. Do not use production for the initial test.

Upstream API: [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).
