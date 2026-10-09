# Quick start: test the full DAG → Pi → GitHub merge path

After installing Micromanager, the shortest alternative to importing a DAG
manually is **Tell Sol what to build → Plan & run**, which plans and
automatically starts using a reusable project profile. See
[One-command launch](ONE_COMMAND.md). The manual DAG route below remains
useful for a first, step-by-step acceptance test.

This guide is for the **opt-in experimental** `pi-micromanager` integration
with Pi and PI WEB. The first trial uses a disposable repository, not your
production code. Nothing runs autonomously until you approve the Workflow,
save configuration **and explicitly Start Autopilot**.

## 1. Prerequisites on the PI WEB session daemon machine

- Node.js **22.19+**, `npm`, `git`, and a recent GitHub CLI (`gh`
  supporting `gh pr checks --json name,bucket` and
  `gh pr merge --match-head-commit`).
- PI WEB compatible with Browser API v4 and Server Plugin API v3,
  whose Git Workspace provider is enabled. Sources for
  `v1.202610.1` were reviewed in [ADR-0014](adr/0014-automatic-worktree-discovery.md).
- Pi installed with an authenticated **provider/model** usable by the
  session daemon's own Pi profile. The model used for QC must be able to
  call the `mm_qc_report` extension tool. Pi extension resources must be
  loaded for the spawned sessions.
- Working `gh auth login` and Git remote push credentials **for the
  session daemon OS user**, not only for a different shell, container or
  browser user. The disposable target repository must allow pull requests,
  push and ordinary merges.
- A project with a clean checked-out `main` and an `origin` GitHub remote.
  Its GitHub Actions PR workflow must run and pass; otherwise automatic
  merging waits. Enable GitHub repository setting **Allow auto-merge** for
  this trial. The host verifies real PR CI and then requests GitHub-native
  SHA-bound auto-merge; GitHub itself waits for required approvals/checks
  if configured. Required reviews/branch protections still apply.

For the first run, use a dedicated machine/user with narrowly scoped GitHub
permissions and no production secrets: the Pi coding worker can invoke shell
commands and is **not an OS security sandbox**. Workflow `allow/ask/deny`
controls Micromanager host operations, not arbitrary untrusted agent subprocesses.

## 2. Build and install Micromanager

On the *target PI WEB machine* (not just the browser machine). The
following shell blocks use a POSIX shell (Linux/macOS/WSL/Git Bash). If
PI WEB runs natively on Windows, use PowerShell equivalents on that
**same** machine and restart PI WEB's session daemon/service according
to that host's installation method:

```sh
gh repo clone zkamiyama/pi-micromanager
cd pi-micromanager
npm install --no-audit --no-fund
npm run check
npm run doctor
pwd
```

Use **PI WEB → Settings → Pi packages → Install** with the resulting
absolute `pi-micromanager` directory as the *local package source*.
Then enable **pi-micromanager** under **Settings → PI WEB plugins**.

Restart the **target machine's PI WEB Session Daemon** from outside any
session that it hosts; this can interrupt running agents. For the native
Linux systemd user installation (other hosts must use their own process
manager or PI WEB service controls):

```sh
systemctl --user restart pi-web-sessiond
```

Reload the browser after the daemon restarts. A browser reload alone
does not activate a new server-plugin entry. The package declares both
a PI WEB browser/server entry and the Pi-native companion in
`package.json`; make sure the installed Pi profile has the latter
enabled (not filtered out). Check **Settings → PI WEB plugins** for an
active, non-error state and `pi-web logs` if activation fails.

## 3. Create a disposable target GitHub repository

Run this on the **same machine** as PI WEB. The trial repository must be
different from the Micromanager plugin source checkout:

```sh
cd /path/to/pi-micromanager
mkdir -p "$HOME/pi-mm-trial"
cp -R examples/trial-repo/. "$HOME/pi-mm-trial/"
cd "$HOME/pi-mm-trial"
git init -b main
git add .
git commit -m "chore: initialize disposable Micromanager trial"
npm test
gh repo create YOUR_GITHUB_LOGIN/pi-mm-trial --private --source=. --remote=origin --push
```

For native Windows PowerShell, use `New-Item -ItemType Directory -Force
"$HOME\\pi-mm-trial"`, then
`Get-ChildItem examples/trial-repo -Force | Copy-Item -Destination
"$HOME\\pi-mm-trial" -Recurse -Force` from the Micromanager checkout;
run the same Git, npm and gh commands from `$HOME\\pi-mm-trial`.
Preserve the hidden `.github` directory and use the checkout accessible
to your PI WEB daemon.

Replace `YOUR_GITHUB_LOGIN` with your account name and choose a **fresh
repository name**. `gh repo create` requires authorization to create a
repository. Your GitHub token/SSH credentials may need permission to
push the workflow under `.github/workflows/ci.yml`. Verify that the
`Trial CI` run on `main` succeeds in GitHub Actions.

From the Micromanager plugin checkout, run:

```sh
npm run doctor -- --target "$HOME/pi-mm-trial"
```

This read-only preflight checks Node, Git, GitHub CLI authentication,
clean root, origin remote, Git author identity, built plugin, and the
committed CI workflow without exposing tokens.

In PI WEB, **add `$HOME/pi-mm-trial` as a Git project** and open its
main workspace. PI WEB discovers linked Git Worktrees via Git; do not
register Task Worktrees manually.

## 4. Start one real DAG

1. In the project's **Micromanager** tab choose **Import a real Workflow DAG**
   and paste [`examples/trial.workflow.json`](../examples/trial.workflow.json).
   Save and select the new `trial-multiply` Workflow. This is a
   **real Workflow**, not the simulation/demo DAG.
2. Under **Autopilot → configuration (JSON)** paste
   [`examples/trial.autopilot.json`](../examples/trial.autopilot.json).
   Replace all `REPLACE_WITH_PI_PROVIDER` and `REPLACE_WITH_PI_MODEL`
   placeholders with **exact provider/model IDs actually authenticated in
   Pi on the PI WEB machine**. All four roles are required.
3. Inspect `publication.remote="origin"`, `baseBranch="main"`,
   `finalization.autoMerge=true`, `managedWorktrees=true`,
   `workspaces={}`, and `test.file="node"` with `args=["--test"]`.
   Using the Node executable directly avoids OS-specific npm shell wrappers.
   Save configuration.
4. Click **Start Autopilot** exactly once. That explicit action
   provisions one implementation and one distinct final Worktree
   beneath Micromanager's owned data directory, resolves their IDs
   against PI WEB's current host Workspace authority, and saves those
   actual IDs before launching any Pi Session.
5. Observe the real **Orchestra** Pi Sessions and the **Journal**. An
   implementation Run writes/commits code; a separate QC Session calls
   `mm_qc_report`. Only after QC PASS does the final integration Pi
   Session merge the frozen source SHA, commit, and enter separate final
   QC.
6. After final QC PASS the host pushes only the integrated branch and
   creates a Draft PR. Workflow `github.pr.merge` permission gates
   Draft→Ready. The host polls **real GitHub PR checks**. An absent,
   pending or failed check cannot trigger merge. With successful checks,
   it requests GitHub-native `gh pr merge --auto --merge --match-head-commit`.
   GitHub may complete immediately or schedule the merge until required
   reviews pass. The host records `integrated` only after exact `MERGED`.
   Only GitHub's confirmed **MERGED** state changes the DAG to
   `integrated`.

If desired, change `permissions.actions["github.pr.merge"]` in the
**Workflow JSON before importing** from the YOLO `allow` default to
`ask` (human review) or `deny` (leave Draft). Do this for any project
other than your disposable trial.

## 5. How to tell whether it worked

Confirm all of the following in the disposable GitHub repository:

- The final PR's diff contains `multiply(a,b)` and its tests.
- `Trial CI` passed on the PR. The PR is actually **MERGED**, not merely
  marked Ready or scheduled.
- The `main` branch now exports `multiply` and `npm test` passes.
- In Micromanager, the Task and `mm-final-integration` statuses are
  `integrated` with final QC evidence/commit SHAs in Journal.
- There are no separate Task-by-Task PRs when finalization is enabled.

Do not expect automatic Worktree/Session deletion. It is deliberately
not implemented; do not `rm -rf` the PI WEB host's own state directories.

## Troubleshooting

| Symptom | Likely cause / action |
| --- | --- |
| Plugin not visible or inactive | Install as a Pi package, enable its PI WEB plugin, restart the **session daemon** and reload the browser. Check `pi-web logs`. |
| New Worktree ID cannot resolve | PI WEB's Git provider, project ID or version-specific ID derivation differs. Autopilot stops before any Pi Run. Inspect `git worktree list`; don't manually fake the ID. See ADR-0014. |
| Pi Session lacks `mm_qc_report` | The native Pi companion was not loaded in the session daemon's Pi profile; check package installation, resource filters and trust policy. Reload idle sessions or restart the daemon safely. |
| Provider/model handshake failed | Check the exact provider/model IDs and Pi authentication **on the daemon machine**; don't substitute browser model labels. |
| Project-local `.pi/` tools unexpectedly absent | PI WEB enforces Pi project trust per Workspace. Review the trusted project decision in PI WEB. Do **not** globally enable trust for untrusted code just to make a test pass. |
| PR created but not merged | Wait for checks; inspect `gh pr checks <number> --repo OWNER/REPO`, Workflow merge permission, required reviewers and branch protection. Failed checks stop merging; an absent check is not treated as success. |
| GitHub CLI unauthorized in agent runs | `gh auth status` in the **daemon's OS environment**, and `git remote -v`; a different interactive shell's credentials may not be available to PI WEB. |
| Crashed/uncertain Worktree provisioning | Existing `reserved` receipt is inspected on the next explicit Start; if Git didn't create the exact Worktree, reconcile manually rather than rerunning unknown Git mutations. |
| No native Pi/PI WEB E2E proof | CI runs strict TypeScript tests, mocked host and real disposable Git checks; this walkthrough is the real authenticated E2E acceptance test on *your* machine. The project must not claim that CI alone proves provider readiness. |

References: [ADR-0014](adr/0014-automatic-worktree-discovery.md),
[ADR-0013](adr/0013-final-integration-and-github-automerge.md),
[PI WEB package installation](https://github.com/jmfederico/pi-web/blob/v1.202610.1/docs/plugins.md),
[PI WEB trust configuration](https://github.com/jmfederico/pi-web/blob/v1.202610.1/docs/config.md).
