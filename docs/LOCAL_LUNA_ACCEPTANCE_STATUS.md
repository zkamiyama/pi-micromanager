# Local Luna acceptance status — 2026-10-14

Related: #38, #91, #92; [operator authorization](LOCAL_LUNA_ACCEPTANCE_AUTHORIZATION.md).
**Overall status: PARTIAL / BLOCKED. Real Luna inference and the complete
orchestrator model/QC/publication E2E are not verified.**

## Confirmed selection and authorization

The owner's local Pi auth metadata contains an `openai` OAuth login. The installed
public Pi SDK catalog contains `openai/gpt-6-luna`; its thinking-level map supports
`low` and `max`. Low is the ordinary test profile; Max is permitted for QC or the
explicit higher-effort behavior check. No other model was substituted.

A standard public `ModelRuntime.getAuth('openai')` operation resolved the selected
login, including its normal expired-token refresh under the SDK's original store.
Only metadata/success booleans were printed. Tokens, account identifiers, credential
files and model transcripts were not logged, copied into fixtures, or committed.
**Auth resolution is not a completed model request. No real Luna request was sent.**

## Tool refusal — respected, not bypassed

`Remote_Desktop_Commander.write_file` refused creation of
`scripts/local-pi-oauth-smoke.mjs` with a safety-check message. It supplied no
more specific reason. The rejected operation was not rephrased, reissued via a
shell/another tool, or replaced by an alternate OAuth execution path. The absent
script was confirmed absent and incomplete uncommitted auth-helper/SDK changes
were removed. No new OAuth test runner or production runtime modification is
included in this change.

Impact: the authenticated model/report/reopen proof in #91 and the real
Luna-driven Workflow/QC/steer/abort/publication sequence in #92 remain unexecuted.
The following independent **credential-free** host and GitHub branch checks are
not substitutes for those missing proofs. The prior lack of explicit account/model/
repository authorization has been resolved by the owner; the present blocker is
this tool refusal and the still-unimplemented/unexecuted acceptance cases.

## Actual local browser / host check (credential-free)

- Product runtime code: unchanged from main
  `bf5598e6ab88471fbd45fe8c1e1198bbb0059b36`.
  Local checkout `c2722876b465de76c896122dc24d505f6543034a` added the authorization
  document only; runtime `src/`, dependency lock and compiled inputs were unchanged.
  Documentation remained modified during the manual UI trial, so this is not
  mislabeled as a clean immutable full-checkout certification.
- Node 22.23.3; Pi coding-agent/AI/Durable/chord 1.2.0;
  PI WEB 1.202610.2; Playwright 1.64.0; Chromium 156.0.8078.4.
- A fresh temporary HOME, Pi agent/session roots, PI WEB data/config, private
  daemon socket, loopback web port and browser profile were used. No provider or
  GitHub credentials were passed to either test host process or browser. No
  existing PI WEB service was restarted or reconfigured.
- The real shipped PI WEB server and sessiond executables were launched.
  The documented local plugin-symlink mechanism registered Micromanager.
  Chromium launched with its sandbox **enabled**; no `--no-sandbox` fallback.
- Through browser controls: Add Project -> select its Workspace -> Micromanager
  -> Import a real Workflow DAG -> Validate and save Workflow. The fixture was
  `local-browser-proof`, with one explicitly unexecuted synthetic task.
- The test-owned daemon was stopped and re-created. A browser reload followed
  by Micromanager's Reload control recovered the persisted Workflow and task
  through the actual browser/server peer connection, not a mocked host object.
- The test browser and every spawned test web/daemon process joined at shutdown;
  their recorded PIDs were checked absent. Only temporary state/logs remain on the
  development machine; no model session was created.
- This is trusted loopback UI coverage, **not authenticated browser ingress,
  TLS, model invocation, simultaneous worker or remote-publisher acceptance**.

### Real integration finding: private plugin state requires umask 077

PI WEB initially created plugin-data directories with mode 0755 under its private
test root. Micromanager correctly rejected activation because production state
must be 0700. Only this newly created test state was tightened to 0700, and the
test supervisor set `umask 077` before relaunching the **test** daemon. The plugin
then activated and was visible in the real browser. Production permission checks
were not weakened. Provision a private state root/process umask before startup;
do not blindly chmod existing user or production data to make a test pass.

## Same-repository branch-only GitHub check

- Repository: `zkamiyama/pi-micromanager`.
- Base: `e2e/local-luna-20261014-wa0uyh-base`.
- Source: `e2e/local-luna-20261014-wa0uyh-source`.
- Source SHA: `0e028d777765a55a49bd132f930f049e9d55bc79`.
- [Trial PR #94](https://github.com/zkamiyama/pi-micromanager/pull/94)
  changed only `examples/acceptance/local-branch-probe.txt` (seven synthetic lines).
- [Associated CI 38509840509](https://github.com/zkamiyama/pi-micromanager/actions/runs/38509840509)
  completed successfully for Node 22, Node 24 and actual successful-isolation.
- After diff/base/source/head review, the draft was marked ready and merged with
  the exact expected source SHA **only into the test base**. Merge SHA:
  `f919874b582c9c26c74cfa41ff9335cc30e7c982`.
- Immediately after the trial, main was still
  `bf5598e6ab88471fbd45fe8c1e1198bbb0059b36`. A subsequent documentation-only
  maintenance PR is separate from this synthetic trial.
- Existing CI/security settings were unchanged. No force push, branch-protection
  override, deployment or release. The two test refs are retained for evidence.

This was performed through the connected GitHub tool. It proves the feasibility
of the owner's same-repository/two-branch arrangement and real PR/check/merge
mechanics. It is **not** a run of Micromanager's publication service, nor a
lost-response/restart reconciliation test. Those parts of #92 stay open.

## Remaining acceptance

#91 remains open for actual bounded Luna Low (and permitted Max when needed)
model execution, committed report/input and no-replay recovery evidence.
#92 remains open for authenticated/local-authorized model-backed hosted flows,
parallel Workspaces, steer/abort, restart and actual orchestrator-driven
publication with uncertain-result reconciliation. #38 remains their open parent.
No production-readiness, hard-quota or independent-review claim is made.
