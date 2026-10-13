# One command: natural language → verified Pi DAG execution

From **main**, install Micromanager using
[Quickstart](QUICKSTART.md) in the PI WEB host's Pi environment.
Use a **disposable GitHub repository** for the first run.

## Setup once per selected PI WEB project/workspace

In **Micromanager**, the first section is **Tell Sol what to build**.
Expand **First-time project setup**. The normal setup is a small form:
choose **Pi Durable (default)** or **PI WEB native Pi (compatibility)**,
then an authenticated provider and model (the same model can serve all
four roles). Enter a test executable and its arguments **one per line**,
the Git remote and branch, and a merge policy. Pi Durable uses Pi's
official `ModelRuntime`: its existing OAuth login in the **daemon user's**
`~/.pi/agent/auth.json` can be reused, or configure a provider API key
in that daemon's environment. Native Pi auth held by another OS user or
browser-only login is not implicitly shared. Verify with
`pi auth check --provider openai` as the daemon user. See
[Pi Durable setup](PI_DURABLE.md).
Then click **Save project setup**. You can use different models for
planner/implementer/QC/architect by enabling **Advanced** and editing
the complete JSON instead.

An optional [copyable advanced profile](../examples/trial.one-command.json)
contains all the fields. Replace `REPLACE_WITH_PI_PROVIDER` and
`REPLACE_WITH_PI_MODEL` with exact IDs available in the target
chosen runtime on the PI WEB session daemon. Pi Durable uses the Pi
SDK model catalog and daemon-user Pi OAuth/API-key credentials; switch
the advanced `config.runtime` to `"pi-web"` only if you
want the original native Pi Session backend. The test command must be
appropriate for your actual repository.

Review the GitHub `publication.remote` / `baseBranch`, since this
configuration permits authenticated code changes. The default
`github.pr.merge: "ask"` means code will run and a Draft PR can be
created, but the final Ready/merge request requires explicit approval
inside Micromanager. To opt in to a truly unattended PR merge, change
it to `"allow"` **deliberately**, after checking the destination.
GitHub CI and branch protection remain authoritative. Production
deployment remains `deny`.

Click **Save project setup** once. No Pi Session or Git change occurs.

## Everyday use: one action

In **Development goal**, write a concrete task, for example:

> Add a multiply(a,b) export to src/math.mjs and tests for negative,
> positive, and zero inputs. Preserve add(). Run all tests and
> commit the implementation.

Click **Plan & run** once. The operation itself is the explicit
authorization to start implementation as soon as Sol's typed DAG
passes deterministic validation; **you do not need to approve a
second DAG or re-enter Worktree IDs**. Sol's proposed authorization
is ignored in favor of your saved policy.

The status card progresses through **Planning → Preparing Worktrees →
Running → Complete**. Click **Open DAG** to inspect tasks and QC;
open **Journal** for evidence, Git SHAs and policy decisions. The
status survives browser reloads and a PI WEB backend restart because
the server keeps durable request receipts. **Refresh progress** only
reads state and does not send a second model prompt.

**Cancel before code starts** is available while Sol is planning.
Once implementation begins, use Autopilot's **Pause admission** for
new work (already-running Pi sessions continue unless aborted).
Failed or uncertain results stop safely and require intervention.

## Alternative: preview before executing

Under **Ask Sol to plan a new goal**, the existing read-only proposal
flow remains unchanged. Choose this for sensitive repositories or
when you want to inspect every DAG before admitting Pi coding.

## Important limits

This is an opt-in experimental orchestration system, not an OS sandbox
for untrusted Pi shell commands. Save credentials only in the PI WEB
host's Pi/GitHub environment, not in the goal or configuration.
It still requires an authenticated real-host E2E test and assumes a
single control-plane writer per Git checkout root. Never run your
first hands-free goal against production code.

Architecture/recovery details: [ADR-0015](adr/0015-one-command-goal-launch.md).

## Conservative fan-in support

The new simple one-command setup explicitly includes
`convergenceMode: "linearized"`. When the planner proposes parallel
implementations that must be merged before a dependent Task, the host adds
a deterministic QC dependency chain **before admission**. Every subsequent
Task can then start from a fast-forward-compatible QC commit; no unreviewed
host-side non-fast-forward merge is performed. This also means independent
implementation Tasks run sequentially rather than in parallel. Advanced
setups may omit the option to retain the original parallel DAG, but divergent
dependencies may require manual Git integration. See
[AUDIT_REMEDIATION](AUDIT_REMEDIATION.md) for exact limits.

New one-command setup profiles explicitly select `maxConcurrentRuns: 8`
and `maxManagedWorktrees: 32` to bound expensive execution and
pre-provisioned checkouts. Legacy runtime settings are not silently capped. No destructive
automatic Worktree/Session cleanup is implied by these quotas.
