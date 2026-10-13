# Remaining real-host issue acceptance (#2–#5)

This is the **truthful first-run checklist** for an authorized PI WEB
installation. The CI uses mocked hosted Pi Sessions and disposable real Git;
it cannot authenticate to the user's Pi providers or GitHub account.

## Setup and real parallel test

1. On the **PI WEB Session Daemon machine**, follow
   [Quickstart](QUICKSTART.md) and run `npm run doctor`. Verify `pi`
   and `pi-web` are installed/enabled and GitHub `gh auth status`
   succeeds for that exact daemon OS user.
2. Create an isolated disposable GitHub repository with passing CI.
   Configure 2 or 4 independent implementation Tasks and distinct
   Worktrees; set `maxParallelByRole.implementer=4`,
   `maxParallelByRole.reviewer=2`. Use real authenticated Pi provider
   profiles (without fallback).
3. Start Autopilot; confirm four genuine Pi Session IDs run concurrently,
   their Worktree roots are different, the model and effort handshake
   is acknowledged, and each assigned session shows public activity in
   the Live Runs canvas. The `Focus inspector` button should expand
   the selected Session without losing the other agents.
4. Send a direct **steer** to an implementation Run, and **follow-up**
   to the QC Run; inspect correlated delivery receipts and bounded
   streaming. Restart the PI WEB daemon while a read-only Run is
   active and check durable matching-session inspection rather than
   a duplicate new-turn.
5. During a real QC run, request the human `after_next_qc`
   intervention. Also test an opt-in
   `diagnosticEscalation: {"afterFailures":1,"maxPerTask":1}`.
   Confirm Sol's structured proposal starts independent read-only
   reviewers, that synthesis cannot bypass the human hold, and that
   only an explicit resume releases downstream Tasks. Repeat with
   invalid model, lost report and two simultaneous interventions.
6. Observe final integration Git SHAs, tests and independent QC.
   GitHub `MERGED` must be observed before claiming full DAG
   completion. Do not use a production or protected repository
   for initial tests.

## Evidence and ADR acceptance

1. Arrange for the project's tests to produce and commit
   `screenshots/qc.png` **before** independent QC verifies that SHA.
   Set `captureQcScreenshots:true`. Verify SHA identity, private
   object store bytes and a Journal entry. A live GUI screenshot is
   **not** taken by this option: the test/project must produce it.
2. When the Workflow is fully integrated, create a clean separate
   `docs/adr` review Worktree with an unpublished Git branch.
   Enter a self-contained ADR with context, alternatives, decision
   and consequences. Preview, Stage and then explicitly **Publish
   reviewed ADR as GitHub Draft PR**. Confirm the PR head/base,
   unchanged SHA and Draft state in the disposable GitHub repo.
   Review and merge the ADR PR manually.
3. Verify 24h+ orphan blob dry-run and exact-confirm deletion;
   recorded sealed QC artifacts must never disappear.
   The full permanent evidence pinning/retention lifecycle is not
   automatically archived or discarded by this plugin.

## Limits that still require upstream capabilities

PI WEB v1 public server-plugin API supports Pi session `create/run`
and Workspace `resolve`, but **no documented Session archive/delete**
operation. We must not manipulate PI WEB-native JSONL or Session files
directly. The browser panel is scoped to the selected workspace/machine;
aggregating arbitrary other PI WEB projects requires a host-supported,
authorized cross-project enumeration contract. Full native image capture
would require authorized browser capture tooling or project-level
screenshot production, not a fabricated QC image.

Therefore the source code and mock tests alone cannot justify closing
Issues #2–#5 unless the outstanding original acceptance conditions are
demonstrated or explicitly re-scoped.
