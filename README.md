# pi-micromanager

**A human-steerable control plane for Pi agent swarms.**

> See everything. Hear everything. Steer anything. Welcome to Cognitive Overload!

`pi-micromanager` is an experimental, intentionally small control plane built on [Pi](https://github.com/earendil-works/pi) and [PI WEB](https://github.com/jmfederico/pi-web). It aims to preserve Multi-Agent-Shogun's **flat, simultaneous observation and direct human intervention** without requiring every agent to read long organizational `AGENTS.md` role prompts.

The orchestration layer is code, not another personality prompt: a validated Task DAG, explicit QC gates, bounded retries, versioned human amendments, and durable workflow state.

## Implementation status (v0.1 alpha)

**Implemented and testable now:**

- Pure deterministic, cycle-checked DAG engine with `completed`, `qc_passed`, `integrated`, and `qc_finalized` dependency gates.
- Per-role concurrency validation, implementation attempts, QC verdicts bound to the matching commit SHA / criteria revision / attempt, and a configurable QC budget.
- A one-shot human barrier that pauses the next post-QC action, inserts independent parallel diagnosis tasks, waits for synthesis, and requires an explicit resume decision.
- **Task-scoped intervention requests:** reserve a durable QC barrier immediately, even while Sol is still planning; accept a typed Sol plan before or after QC, and reject downstream work until the hold is resolved.
- SQLite-backed workspace-scoped workflow state, revision compare-and-swap, durable command-idempotency receipts, bounded event history.
- **PI WEB Browser API v4 / Server API v3 plugin** with a **simulation-only** four-view panel: Cockpit, DAG, Kanban, Journal. The demo never launches an agent; all visible actions are explicitly labeled simulation. A Task Lens is accessible from Cockpit, DAG and Kanban. It persists a selected-Task intervention and shows a simulated Sol plan; native direct-agent steer is deliberately disabled.
- Native `node:test` coverage for state-machine safety and persistence.

**Runtime adapter implemented experimentally (not authenticated E2E-verified):** Public PI WEB session creation in an existing resolved workspace, Pi companion model/effort handshake, direct steer/abort, bounded activity streams, immutable per-Run registry and Orchestra Live Runs/History.

**New opt-in Autopilot (PR #7):** A real Sol goal-proposal Session can first turn a natural-language objective into a strictly validated DAG for **explicit human approval**. After approval and Worktree/model configuration, the server-side scheduler runs **validated, saved** DAGs in fresh Pi Sessions. It admits ready implementation Tasks, checks Git commits and real test exit codes, starts independent read-only QC, honors QC retry budgets and human holds, dispatches Sol's typed intervention plan and parallel frozen-snapshot diagnosis/synthesis, and persists bounded evidence receipts. An unknown/aborted Run **pauses safely**; server restart reconciles existing Sessions from durable Pi turn markers before resuming. Automatic divergent Git merges and GitHub PR merges are prohibited; safe dependent fast-forwards are supported. New Workflows with an explicit `publication` destination can autonomously push QC-sealed commits and create Draft PRs under the Workflow permission policy.

**Evidence Journal & confirmed retention (PR #7):** The Journal tab can read a finite, evidence-linked projection of Task status, QC SHA/verdict, one-shot Pi Runs and durable evidence references. The operator may preview and confirm pruning public activity projections over 30 days old **only when** their Runs are sealed and entire Workflows are complete; no native Pi JSONL, QC evidence, command receipt, Workflow state or Git Worktree is removed. Test outputs are retained as bounded exit/size/SHA-256 fingerprints rather than potentially sensitive stdout/stderr.

**Immutable QC screenshots and reviewed ADR drafts (PR #7):** An operator may import an existing PNG/JPEG screenshot from a sealed QC Run's clean, exact Git commit into a private SHA-256-addressed artifact store, then explicitly verify/view it from Journal. When all Tasks are complete/integrated, an evidence-linked ADR proposal can be previewed and staged as an exact new Markdown file in a separate non-main Git Worktree after human confirmation. No screenshot is fabricated, and no ADR is automatically committed, pushed or published.

**Orchestra canvas (new):** The Live Runs panel has become a floating, connected PI WEB-styled canvas. Each node represents a **real active or pending Pi Run**, not a permanent/fictional role. Dotted links show orchestra membership; solid accent links only appear for explicit Task DAG dependencies between currently visible Runs. The Orchestrator dock reports actual Run activity; its chat input is enabled **only when a live, connected planner Pi Session exists**. The planner window represents a real Session only when Sol is actually running.

**Still not implemented/verified:** Automatic discovery/registration of newly created Worktrees as PI WEB Workspace IDs, unattended goal → execution without explicit DAG approval/Workspace setup, independent provider-authenticated multi-Agent E2E, automatic browser screenshot capture and broader artifact types, full Pi JSONL replay, safe Pi Session/Worktree garbage collection, conflict-resolving or divergent Git merges and protected-branch operations, ADR Git commit/PR publication, Android-specific UI or TTS. Sol now supports both **read-only initial goal-to-DAG proposals** and Task-scoped intervention planning; proposed DAGs still need explicit acceptance and real run configuration. Existing demo transition buttons remain a simulator.

## Architecture and ADRs

- [ADR-0001 — Control plane and product boundaries](docs/adr/0001-control-plane-and-product-boundaries.md)
- [ADR-0002 — Deterministic DAG, QC barriers, and Workflow Amendments](docs/adr/0002-deterministic-dag-and-live-interventions.md)
- [ADR-0003 — Evidence, Live Journal, retention, knowledge promotion](docs/adr/0003-evidence-journal-retention-and-knowledge.md)
- [ADR-0004 — Cockpit, provider adapters, implementation order](docs/adr/0004-cockpit-provider-adapters-and-delivery-order.md)
- [ADR-0005 — Task-scoped interventions and Sol planner boundary](docs/adr/0005-task-scoped-interventions.md)
- [ADR-0006 — Ephemeral execution runs and dynamic live grid](docs/adr/0006-ephemeral-execution-runs.md)
- [ADR-0007 — Opt-in durable Autopilot and fail-closed Pi execution](docs/adr/0007-opt-in-autopilot.md)
- [ADR-0008 — Managed Worktree provisioning and verified Git integration](docs/adr/0008-git-worktree-provisioning-and-integration.md)
- [ADR-0009 — Evidence-linked Journal and conservative activity retention](docs/adr/0009-journal-and-conservative-retention.md)
- [ADR-0010 — Immutable QC screenshots and reviewed ADR staging](docs/adr/0010-screenshot-artifacts-and-reviewed-adr-staging.md)
- [ADR-0011 — YOLO Workflow permissions and QC-gated Draft PR publication](docs/adr/0011-yolo-workflow-permissions-and-publication.md)
- [ADR-0012 — Safe automatic dependent Worktree Git convergence](docs/adr/0012-safe-automatic-git-convergence.md)

## Development

Requires Node.js 22.19+ (PI WEB version constraint). Runtime plugin compatibility should be tested against the installed PI WEB version; source APIs are versioned and may evolve.

```bash
npm install
npm run check
```

For integration testing, install the built package locally through **PI WEB → Settings → Pi packages**, enable `pi-micromanager` under **PI WEB plugins**, then restart the relevant PI WEB Session Daemon **only when no important agents are running** and reload the browser. Open a workspace and select the **Micromanager** tab. **Create/load demo DAG** and its simulation transition buttons do not edit code or launch Pi Sessions. The separate **Import a real Workflow DAG** and **Autopilot** controls are not a simulation: starting Autopilot can execute and modify code inside the configured linked Worktrees. Enable only for a repository and provider you intend to use.

The package's PI WEB plugin declaration is in `package.json`; `src/pi-web/browser.ts` implements Browser API v4 and `src/pi-web/server.ts` owns one SQLite database under PI WEB's plugin-provided `dataDirectory`. The plain orchestration engine in `src/core/` has **no Pi imports** so future runtime adapters can be swapped.

The example DAG is at [`examples/auth.workflow.json`](examples/auth.workflow.json). It is **our schema**, not a built-in PI WEB configuration format.

## Opt-in Autopilot (real Pi execution)

The **initial Sol proposal is read-only**. It is a fresh Pi Session using the
`mm_workflow_proposal` tool, limited to 16 implementation Tasks with bounded
requirements, valid acyclic dependencies and explicit acceptance criteria.
The proposed definition is retained as a typed report in the scoped SQLite
ledger and native Pi Session. A human must review/accept the exact proposal
before a real Workflow is created. If desired, copy the proposal into the
editable JSON importer to revise it before saving; proposal text alone
cannot launch a modifying Agent.

1. In PI WEB, create/verify **separate linked Git worktrees**, or use **Micromanager → Manage isolated Git Worktree → Preview → Create** to create a task-owned branch/linked Git Worktree after explicit review. Select the new workspace in PI WEB and copy its **actual PI WEB Workspace ID** into Autopilot configuration. A modifying Task must not use the project's main checkout.
2. Under **Micromanager → Ask Sol to plan a new goal**, enter a precise natural-language goal and exact authenticated Pi planner provider/model. Check the real Pi Session proposal, inspect its DAG and choose **Approve and save exact proposal**. Alternatively import a reviewed JSON DAG through **Import a real Workflow DAG**. In either case, give each Task a concrete `description` and `acceptanceCriteria` lines. Implementation and QC Runs receive **the same** contract. Verify Task IDs, dependency gates and requested changes before starting.
3. Under **Autopilot → configuration (JSON)**, map every implementation Task ID to an existing linked Worktree workspace ID; configure **all four** exact Pi provider/model profiles and a bounded executable test argv. For YOLO publication, verify `publication.remote` and `publication.baseBranch` and make sure `gh` and Git authentication are available on the host. Legacy configs without `publication` never push. Save configuration, then explicitly **Start Autopilot**.
4. Watch actual one-shot Pi Runs in the **Orchestra** tab. The scheduler makes fresh Sessions for implementation/QC/rework and can publish QC-passed Draft PRs. It fast-forwards clean unstarted dependent Worktrees, but never auto-merges GitHub PRs or divergent branches. Use **Pause admission** to stop *new* work; current running Pi turns continue unless directly interrupted.
5. For a human QC intervention, use **Task Lens** to register the after-next-QC barrier. Sol produces a typed plan, the investigations and synthesis run read-only, and a **human explicit resume** remains required.

Example configuration (replace IDs and all provider/model values with your real installed PI WEB/Pi settings):

```json
{
  "workspaces": {
    "api": "existing-linked-worktree-workspace-id-api",
    "ui": "existing-linked-worktree-workspace-id-ui"
  },
  "models": {
    "implementer": { "provider": "your-provider", "model": "your-implementer-model" },
    "qc": { "provider": "your-provider", "model": "your-qc-model" },
    "planner": { "provider": "your-provider", "model": "your-planner-model" },
    "architect": { "provider": "your-provider", "model": "your-architect-model" }
  },
  "test": { "file": "npm", "args": ["test"], "timeoutMs": 60000 },
  "maxAttempts": 5
}
```

Models may optionally specify a supported `effort`. Use actual **Task IDs** from the imported DAG, not the placeholders above. A QC reviewer defaults to the implementation Worktree as a read-only snapshot unless `reviewWorkspaces` provides a separately linked workspace whose HEAD already matches the implementation SHA. Independent diagnoses run against that same frozen snapshot. Worktrees must remain clean; a dirty checkout or unsupported exact model causes a safe stop.

**Important:** A dependency gate such as `qc_passed` does not itself move
Git commits. After a Task's QC PASS is sealed, the host propagates the exact
QC-approved SHA to each **unstarted, clean, distinct, linked dependent Worktree**
using `git merge --ff-only` when Git proves the target HEAD is an ancestor.
The Workflow becomes `integrated` only when *every* direct dependent Worktree
contains that passing SHA. The scheduler rechecks real Git ancestry **before**
admitting a dependent Pi Session. It never automatically rewrites history,
cherry-picks or resolves divergent branches. A conflict/divergence leaves the
Workflow paused for manual Git reconciliation. Terminal Tasks with no
dependents remain QC-`passed`, and GitHub PR merge remains separate.
See [ADR-0012](docs/adr/0012-safe-automatic-git-convergence.md).

The scheduler runs in the PI WEB server-plugin lifetime (not as a separate operating-system service). It restores active Run identity on restart from persisted companion turn entries where possible. If a settled Pi Session's typed QC/plan report notification is lost, the host reconnects to **that same Session read-only** to recover the durable report; wrong-Run reports and unknown turn states cause a safe pause, not a retry. Uncertain command delivery remains blocked until reconciled. Public-host-capability mock integration tests cover actual Session launch, bounded host tests, QC transitions, typed Sol proposal approval and lost report replay. Host shutdown now drains in-flight scheduler verification and fences new Pi Session sends when its lifetime ends, before closing SQLite. Authenticated real-provider/GUI E2E is still deferred. See [ADR-0007](docs/adr/0007-opt-in-autopilot.md) for recovery and trust boundaries.

## YOLO default and Workflow permission gates

**YOLO is the default**: after you explicitly start an automated Workflow,
Pi implementation Runs may edit, test and commit code, and Micromanager's
host-side publisher can Push the QC-passed commit and create a **Draft**
GitHub Pull Request automatically. The built-in review/QC gates still apply.

The optional `permissions` section belongs in the **Workflow definition**
(imported DAG JSON), not in a model chat prompt:

```json
{
  "permissions": {
    "default": "allow",
    "actions": {
      "git.commit": "allow",
      "git.integrate": "allow",
      "git.push": "ask",
      "github.pr.create": "allow",
      "github.pr.merge": "ask",
      "deploy.production": "ask"
    }
  }
}
```

`allow` runs without human interaction, `ask` creates a durable approval
request, and `deny` prevents the corresponding **host-managed operation**.
`git.commit: ask` holds admission before the modifying Pi Session begins,
bound to the exact Task attempt and Workflow revision. `git.push` and
`github.pr.create` approvals bind the exact sealed QC Run, Git SHA and
publication remote/base. Open **Autopilot → Load publication & approvals**
to inspect and approve or deny these specific requests. Changing a commit,
target or source revision cannot reuse a previous approval.

`github.pr.merge` and `deploy.production` are policy names reserved for
future host executors and default to `ask`—**no automatic merge or
deployment executor exists**. Publication is enabled only if the separately
saved Autopilot configuration contains:

```json
"publication": {
  "remote": "origin",
  "baseBranch": "main",
  "draft": true
}
```

The UI prepopulates this for new configurations. Verify the actual base
branch before saving. Historical configs without this field remain local
only, avoiding surprising outward effects. The host invokes `git` and
`gh` as bounded argv processes, verifies QC SHA and repository ownership,
and uses no-force Push and Draft PR creation. Lost responses are reconciled
against Git remote SHA / GitHub PR state, not blindly retried.

**Security limitation:** Pi's `tool_call` hook blocks common direct shell
publish commands, but an arbitrary model-controlled shell can bypass
text-pattern guards via scripts or network clients. The permission model
enforces **Micromanager's own executor**, not a universal OS capability
boundary. Do not expose write-enabled GitHub/deployment credentials to
untrusted Pi processes when a real denial guarantee is required. Use an
isolated Pi OS/container identity and narrowly scoped host-side credentials.
PI WEB's current public Session API has no supported per-Run sandbox
configuration, so this integration cannot itself promise host enforcement.
See [ADR-0011](docs/adr/0011-yolo-workflow-permissions-and-publication.md).

## YOLO Git integration into dependent Worktrees

YOLO also propagates a sealed QC commit into its direct dependent Task branches
when Git permits a **fast-forward without a conflict**. This uses the existing
linked Git Worktrees; there is no Worktree registration or checkout creation
during propagation. The Worktree must be unstarted, clean, non-main,
without an active Pi Run and on a non-protected branch.

Set `permissions.actions["git.integrate"]` to `ask` for a durable approval
bound to the original QC Run/SHA, the child Task/Workspace and its exact
baseline HEAD. `deny` pauses autonomous propagation. `allow` (YOLO default)
uses the host's `git merge --ff-only` and persists a reservation before the
non-idempotent Git action. A lost Git response is reconciled by exact target
SHA rather than blindly running merge again. Completed receipts are visible
alongside publication approvals in the Autopilot control panel.

**No automatic conflict resolution:** when two upstream branches diverge or
a dependent Task has already started, the Worktree is left untouched and the
Workflow safely pauses. You can review/integrate the branches manually in
Git, then restart Autopilot; it will verify actual ancestor relationships
rather than assuming Git has been updated.

## Managed Worktrees and Git integration proof

**Worktree creation (explicit, no automatic deletion):** Select an unstarted
implementation Task in the **Manage isolated Git Worktree** section. Preview
the repository's clean base SHA, a task-scoped branch and a location inside
Micromanager's private data directory. Click **Create reviewed Git Worktree**
only when you intend to add that Git branch and checkout. If the response is
uncertain, use **Inspect reserved Worktree**; never issue another blind create.
Once PI WEB's Git provider discovers the newly linked checkout, select it in
PI WEB and copy its Workspace ID into the configuration. This registration
step is manual because public PI WEB `workspaces` v1 has no create/list API.

**QC-to-Git integration (verified, not performed):** QC PASS is intentionally
not a Git merge. Perform the actual Git integration yourself, following your
repo's review policy. For the passed Task, open **Task Lens → Verify completed
Git integration**, enter the *distinct target* PI WEB Git Workspace ID,
and select **Preview verified Git state**. The host verifies that the target
is clean, not being written by an Agent, and contains the exact QC-approved
commit as an ancestor of target HEAD. The short-lived preview displays the
source/target commits. **Confirm integration and unblock DAG** then repeats
all checks and marks the Task `integrated` via durable CAS; it never executes
Git merge/cherry-pick/push. Existing dependent worktrees must also contain
the upstream commit before automatic downstream execution.

Review [ADR-0008](docs/adr/0008-git-worktree-provisioning-and-integration.md)
for reservation/reconciliation details and the remaining PI WEB API limitation.

## Evidence Journal and safe manual retention

Open **Micromanager → Journal → Load evidence-linked journal** to inspect the
authoritative Task lifecycle, QC verdict/commit SHA, native one-shot Run
identities and matching immutable evidence references without copying the Pi
transcript. The evidence summaries are finite local projections; raw host test
stdout/stderr are not duplicated. The Workflow and native Pi Sessions remain
the source of truth for their respective state.

Within Journal, **Review old public activity retention** offers a read-only
preview for activity older than **30–365 days**. Only activity rows from
durably **sealed** Runs whose entire Workflows are integrated/completed are
eligible. Pending human decisions, unmerged QC passes, unsealed or uncertain
Runs and missing evidence prevent pruning. A second confirmation rechecks the
exact cohort under a transaction; lost or stale previews fail closed. At most
200 rows are selected per preview. The native Pi Session, Git Workspace,
Task/QC history, evidence receipts and command idempotency receipts are
**never** deleted by this operation.

**Native Pi Session archival/deletion and Worktree GC are still deliberately
not automatic.** The currently published PI WEB host capabilities do not
provide session cleanup or workspace deletion APIs to paired plugins, and
directly removing PI JSONL/worktrees would bypass host-owned lifecycle safety.

The normal build CI additionally exercises **real Git commands** in a
disposable test repository (Worktree creation, feature commit and verified
fast-forward integration). This is neither a user's real PI WEB host nor an
authenticated Pi provider test. For design/security boundaries, see
[ADR-0009](docs/adr/0009-journal-and-conservative-retention.md).

## QC screenshot artifacts and reviewed ADR draft staging

**Capture an actual screenshot:** After a fresh read-only QC Pi Run is sealed
with evidence and the Task's Git checkout is still clean at the exact
QC-reviewed SHA, place or commit a PNG/JPEG file in that linked Worktree under
`screenshots/<name>.png` (or `.jpg/.jpeg`). In **Micromanager → Journal → Actual
QC screenshot evidence**, choose the sealed QC Run and relative file path,
then use **Capture verified screenshot bytes**. The host checks the Run,
sealed evidence, workspace authority, Git HEAD, file type and path. It also
proves that the screenshot is **tracked in the exact QC-reviewed Git commit**
and that the current on-disk blob matches it. An ignored/untracked image is
not accepted even if ordinary Git status reports the checkout as clean. It stores
up to 1 MiB of original bytes in a private, SHA-256 content-addressed store,
with quotas and strict scope isolation.

Images **can contain secrets**: inspect/redact before explicit capture. The
image is stored on the PI WEB host, not sent to the model. Click
**Verify / view image** to recheck saved bytes and lazily display images of
up to 512 KiB; larger images retain metadata but are not sent inline by this
API. A screenshot does **not** independently certify QC or change a verdict.
This is not automatic screenshot generation.

**Stage an ADR based on source evidence:** Once all Workflow Tasks are
integrated or completed, open **Journal → Propose a verified architecture
decision (ADR)**. Enter a **separate** non-main linked Git review Workspace ID (never one of
the Workflow's current or historical Agent Worktrees) and a
four-digit filename such as `0012-token-rotation.md`, then author Context,
Considered Options, Decision, and Consequences. The read-only preview embeds
the exact durable QC Run / Git SHA / evidence references and revalidates any
captured screenshots. Confirm to write the exact reviewed Markdown to
`docs/adr/` in the separate review Worktree. A crash between reservation and
write is reconciled by **Inspect**, never an automatic overwrite. The file is
left **uncommitted** for independent Git review, Push and PR publication.

See [ADR-0010](docs/adr/0010-screenshot-artifacts-and-reviewed-adr-staging.md)
for provenance, quotas, trust boundaries and publication limits.

## Orchestra canvas controls

Open the **Orchestra** PI WEB workspace tab (its stable internal panel ID remains `live-runs`). Run windows appear automatically from `agents.list` and live `agents.events` as one-shot Pi Sessions are launched via the experimental manual workflow below. The canvas is contained in the PI WEB tab; narrow views scroll horizontally, not via a PI WEB host DOM override. Up to 12 active/pending Runs are shown on a page, with previous/next navigation and role/Task/Run filtering. The panel stays within PI WEB's public third-column tab API.

- Click an Agent to inspect it (loading up to 60 retained public activity entries); click empty canvas to de-emphasize nodes without hiding their status. Click an Agent again to restore full opacity.
- Drag a node **header** to move the window and attached links. Keyboard users can focus its header and use arrow keys (Shift+arrow for larger steps). Positions, blank-canvas dimming and per-Run compact/expanded view are remembered in browser storage, keyed by machine/project/workspace. These are UI preferences only, not Workflow mutations; **agent prompts, message drafts and transcript text are never put into browser layout storage**.
- Each node has its own per-Run draft and exact direct Pi Session target, and a +/- control that overrides the role's default log density. Configured new Runs show **Start**; running ones offer **Steer** or **Follow-up**. Unconnected, held/uncertain and finished Sessions cannot be messaged from these controls. Acknowledge receipts do not claim task completion.
- The Orchestrator console is an observation surface until a real planner Run is present; then its composer sends **directly** to that planner Pi Session. A planner is not automatically spawned. Task-scoped workflow amendments remain in the separate **Micromanager → Task Lens** prototype.
- **Micromanager → Task Lens → Steer implementer/QC** opens the Orchestra workspace panel and focuses the matching active one-shot Run. If none exists, it never selects a different Agent. The read-only activity stream retries up to five times on disconnection; switched-away workspaces release their subscriptions.
- Dashed lines mean Run membership in this workspace. Solid lines represent Task DAG dependencies only if both linked Tasks have visible live Runs. These lines do **not** claim to visualize hidden model reasoning or implicit communication between Agents.

No fake Agents, automatic dispatch, synthesized chats, or permanent Session reuse are introduced by this UI.

## Boundaries and safety

- The control plane controls *workflow admission*, not the model's hidden reasoning; observable text and tools only.
- No automatic divergent merge or GitHub PR merge, provider credential storage or destructive Workspace cleanup. Dependents can safely auto fast-forward with explicit Workflow permissions. Git Push/Draft PR are only enabled with an explicit publication target and Workflow permission gates. Code changes occur **only** through explicitly started Pi implementation Runs in validated, isolated Worktrees.
- All real modifying agents must be in isolated worktrees before concurrent execution is permitted.
- Native Pi transcripts stay with their owning host; Micromanager stores bounded public activity projections and immutable evidence references instead of copying raw JSONL. ADR promotion into target repos is not yet implemented.
- TTS/Swarmfield is a later, deliberately low-priority experiment.

## License

MIT, see [LICENSE](LICENSE).

## Per-attempt fresh Pi Sessions

Each Luna attempt and every QC Run creates a fresh Pi Session. The same model may be reused, but the old session context is **never** the next run. The dynamic **Live Runs** PI WEB panel shows running/pending sessions; settled runs move to History (no steer). The Workflow Task, not the Agent role, remains the durable object. Evidence must be sealed before a modifying worktree can even become eligible for separate, manual lifecycle cleanup. See [ADR-0006](docs/adr/0006-ephemeral-execution-runs.md).

The manual one-shot Pi creation form is experimental: it requires an admitted Task run, an existing linked worktree for a modifying Luna, a target PI WEB Workspace ID, and a configured provider/model. An opt-in, background, DAG-driven Autopilot scheduler and explicit managed Worktree creation are available, but authenticated real-provider E2E is not yet proven. The earlier DAG demo and its transition buttons remain simulation-only.
