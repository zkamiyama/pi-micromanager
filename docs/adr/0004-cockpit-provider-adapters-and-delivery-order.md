# ADR-0004: Flat Cognitive Overload cockpit, provider adapters, and delivery order

- Status: Accepted design; incremental delivery
- Date: 2026-10-09

## UX principle

**Maximum observability, minimum mandatory attention.** An Agent may be `compact` (title/status only), `expanded` (live transcript/tools), `focused` (full inspector), or `muted` in future audio; these are **independent per-agent preferences**, not model context or parent delegation rules. Cognitive Overload means the user may expose any permitted detail at any time, without requiring every detail on screen.

The human may directly steer Sol, Luna, Astra, QC, or the workflow itself. Parenthood is metadata, not an authority bottleneck. Humans can act even when the orchestrator is busy. Never imply private chain-of-thought is observable; stream only provider-exposed content, tool results and factual state.

## Model/provider rules

- No Codex CLI lock-in. Pi provider/session credentials remain owned by Pi/PI WEB and the configured upstream integrations. Never store OAuth tokens, session cookies or API keys in workflow state.
- Model selection is per-role *intent*: e.g. low-effort planner, max implementer, xhigh QC, high-end diagnosis. Actual model IDs, provider support, and effort levels are validated at runtime, with no silent fallback to the wrong model.
- PI WEB `pi-sessions` v1 `run({projectId, workspaceId, prompt})` does **not** take an explicit model/effort ID. Implement a future `create -> connect companion -> configure model -> receive acknowledgment -> start prompt` handshake; reject if setup fails. The `pi-session-events` channel is **not** a native general-purpose steer/agent-stream API; the companion handles command dispatch with correlation IDs and explicit receipts.
- Each modifying Agent gets its own worktree. Pi WEB Git discovers existing linked worktrees but automatic provisioning/removal under conflict-safe leases must be built separately.

## Intended screens

- **Cockpit:** all role instances, lightweight live agent transcript/tool snapshots, configurable per-seat density, selected-seat direct steer/interrupt and optional images, browser/mobile responsive.
- **DAG:** live graph, blocked edges, gates and amendment barriers, attempt nodes and re-plans. Editing routes through typed commands, never mutates instance files.
- **Kanban:** derived from exactly the same state machine; no independent card state.
- **Live Journal:** chronological source-linked events plus inline test metrics and optional screenshots; derived from persisted evidence, not a second LLM controlling workflow.
- **Storage & Knowledge:** dry-run retention, protected evidence, orphan worktrees, pending ADR promotion (later).

## Technical UI restrictions

PI WEB Browser API v4 supports `workspacePanels` and `applicationPanels`, but their placement is a **tab surface** (third column), not a guaranteed fullscreen tiled terminal grid. v0.1 registers an ordinary Workspace panel; large-screen full grid and multi-project orchestras need a compatible full-width host capability or a carefully isolated standalone client rather than a fragile DOM hack.

The Browser Plugin must not import PI WEB private routes or internal services. Server/Browser communication is limited to declared public peer requests/channels and paired versions; companion activity may be forwarded only with explicit subscription/auth rules. No cross-project leakage on remote PI WEB machines.

## Prioritized milestones

| Milestone | Outcome | Current state |
| --- | --- | --- |
| 0 | ADRs, package skeleton, pure DAG/QC engine, SQLite state and tests | In progress |
| 1 | PI WEB panel: graph / kanban / workflow journal / compact preference (simulation, explicitly labeled) | In progress |
| 2 | Pi + PI WEB session bridge, model/effort handshake, worktree isolation, crash recovery & leases | Planned |
| 3 | Real-time flat multi-agent cockpit with direct steer, human barriers, per-agent inspector | Planned |
| 4 | Evidence media, live screenshots and artifact-linked journal; retention/ADR promotion | Planned |
| 5 | Replanning, automatic escalation, deep workflow editor and repository hard gates | Planned |
| Last | **Swarmfield multi-voice TTS and spatial audio** (mostly whimsical, deliberately last) | Deferred |

## Acceptance for first real end-to-end milestone

Run an actual four-seat orchestra (Sol, two Luna, QC) with distinct worktrees, prove that each session's public text/tool activity appears in a flat viewer, send human steer without touching Sol, and prove the after-QC barrier prevents the next Luna dispatch until diagnostic synthesis resolves. The simulation build **does not** satisfy this end-to-end criterion.

## Decision review triggers

Revisit if PI WEB's public extension API cannot expose a performant multi-agent grid, if Pi companion messages lack sufficient delivery acknowledgment, or if UI-restart lifecycle conflicts with a durable background scheduler. Prefer upstream capability requests or a separately supervised control-plane service over a permanent PI WEB fork.
