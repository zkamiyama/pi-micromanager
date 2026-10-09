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

**Runtime adapter now implemented experimentally (not E2E-verified):** public PI WEB session creation in an existing resolved workspace, Pi companion model/effort handshake, direct steer/abort and activity projection, per-Run registry, dynamic Live Runs/History panel. These are manual operations and do not imply unattended task dispatch.

**Orchestra canvas (new):** The Live Runs panel has become a floating, connected PI WEB-styled canvas. Each node represents a **real active or pending Pi Run**, not a permanent/fictional role. Dotted links show orchestra membership; solid accent links only appear for explicit Task DAG dependencies between currently visible Runs. The Orchestrator dock reports actual Run activity; its chat input is enabled **only when a live, connected planner Pi Session exists**. This does not add automatic Sol dispatch.

**NOT YET implemented:** automatic Workflow-to-Pi dispatch, automatic worktree provisioning, full transcript history replay, verified QC output/evidence and automatic sealing, safe native Pi Session/Worktree cleanup, real Sol planner dispatch, image evidence, ADR publication, Android-specific UX or TTS. The original DAG demonstration remains a simulator.

## Architecture and ADRs

- [ADR-0001 — Control plane and product boundaries](docs/adr/0001-control-plane-and-product-boundaries.md)
- [ADR-0002 — Deterministic DAG, QC barriers, and Workflow Amendments](docs/adr/0002-deterministic-dag-and-live-interventions.md)
- [ADR-0003 — Evidence, Live Journal, retention, knowledge promotion](docs/adr/0003-evidence-journal-retention-and-knowledge.md)
- [ADR-0004 — Cockpit, provider adapters, implementation order](docs/adr/0004-cockpit-provider-adapters-and-delivery-order.md)
- [ADR-0005 — Task-scoped interventions and Sol planner boundary](docs/adr/0005-task-scoped-interventions.md)
- [ADR-0006 — Ephemeral execution runs and dynamic live grid](docs/adr/0006-ephemeral-execution-runs.md)

## Development

Requires Node.js 22.19+ (PI WEB version constraint). Runtime plugin compatibility should be tested against the installed PI WEB version; source APIs are versioned and may evolve.

```bash
npm install
npm run check
```

For integration testing, install the built package locally through **PI WEB → Settings → Pi packages**, enable `pi-micromanager` under **PI WEB plugins**, then restart the relevant PI WEB Session Daemon **only when no important agents are running** and reload the browser. Open a workspace and select the **Micromanager** tab, then **Create/load demo DAG**. All buttons inside the demo simulate transitions: they do *not* edit source code or start Pi agents.

The package's PI WEB plugin declaration is in `package.json`; `src/pi-web/browser.ts` implements Browser API v4 and `src/pi-web/server.ts` owns one SQLite database under PI WEB's plugin-provided `dataDirectory`. The plain orchestration engine in `src/core/` has **no Pi imports** so future runtime adapters can be swapped.

The example DAG is at [`examples/auth.workflow.json`](examples/auth.workflow.json). It is **our schema**, not a built-in PI WEB configuration format.

## Orchestra canvas controls

Open the **Orchestra** PI WEB workspace tab (its stable internal panel ID remains `live-runs`). Run windows appear automatically from `agents.list` and live `agents.events` as one-shot Pi Sessions are launched via the experimental manual workflow below. The canvas is contained in the PI WEB tab; narrow views scroll horizontally, not via a PI WEB host DOM override. Up to 12 active/pending Runs are shown on a page, with previous/next navigation.

- Click an Agent to inspect it; click empty canvas to de-emphasize nodes without hiding their status. Click an Agent again to restore full opacity.
- Drag a node **header** to move the window and attached links. Keyboard users can focus its header and use arrow keys (Shift+arrow for larger steps). Positions are workspace-local UI state, not durable Workflow mutations.
- Each node has its own per-Run draft and exact direct Pi Session target. Configured new Runs show **Start**; running ones offer **Steer** or **Follow-up**. Unconnected, held/uncertain and finished Sessions cannot be messaged from these controls. Acknowledge receipts do not claim task completion.
- The Orchestrator console is an observation surface until a real planner Run is present; then its composer sends **directly** to that planner Pi Session. A planner is not automatically spawned. Task-scoped workflow amendments remain in the separate **Micromanager → Task Lens** prototype.
- Dashed lines mean Run membership in this workspace. Solid lines represent Task DAG dependencies only if both linked Tasks have visible live Runs. These lines do **not** claim to visualize hidden model reasoning or implicit communication between Agents.

No fake Agents, automatic dispatch, synthesized chats, or permanent Session reuse are introduced by this UI.

## Boundaries and safety

- The control plane controls *workflow admission*, not the model's hidden reasoning; observable text and tools only.
- No implicit production auto-merge, code mutation, model credential storage, or destructive workspace cleanup.
- All real modifying agents must be in isolated worktrees before concurrent execution is permitted.
- The eventual control plane will keep raw Pi transcript files in their owning host, store only finite event projections/evidence references and promote important ADRs through PRs in the target repo.
- TTS/Swarmfield is a later, deliberately low-priority experiment.

## License

MIT, see [LICENSE](LICENSE).

## Per-attempt fresh Pi Sessions

Each Luna attempt and every QC Run creates a fresh Pi Session. The same model may be reused, but the old session context is **never** the next run. The dynamic **Live Runs** PI WEB panel shows running/pending sessions; settled runs move to History (no steer). The Workflow Task, not the Agent role, remains the durable object. Evidence must be sealed before a modifying worktree can be released. See [ADR-0006](docs/adr/0006-ephemeral-execution-runs.md).

The manual one-shot Pi creation form is experimental: it requires an admitted Task run, an existing linked worktree for a modifying Luna, a target PI WEB Workspace ID, and a configured provider/model. There is no automatic worktree allocation, background scheduler or real-provider E2E proof yet. The earlier DAG demo and its transition buttons remain simulation-only.
