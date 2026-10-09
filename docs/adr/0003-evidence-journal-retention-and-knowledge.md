# ADR-0003: Bounded evidence, live journal, and knowledge promotion

- Status: Accepted design; bounded Journal/retention (ADR-0009) and private QC screenshots/reviewed ADR staging (ADR-0010) implemented; native cleanup/PR publication pending
- Date: 2026-10-09

## Decision

Use **three independent storage classes**:

1. **Hot:** live session streaming, short-lived tool output, screenshots, current worktrees. Never duplicate Pi's full JSONL transcript inside the workflow DB. UI deltas are ephemeral; persist only necessary bounded projections.
2. **Warm:** durable QC verdicts, immutable evidence IDs, amendments, finite event history, final DAG, journal summaries, references to Git commits and PRs.
3. **Permanent:** approved and self-contained ADRs, migration decisions, project constraints and high-value lessons written back to the **target repository**, not to the global control-plane database.

The workflow database is authoritative only for ongoing/recent execution, **not an infinite second source of technical truth**. Compaction must never erase active workflow state, unmerged evidence, outstanding user input, or material needed for a pending ADR review.

## Proposed default retention (configurable, not yet running)

| Class | Expiry after safe completion |
| --- | --- |
| In-memory token deltas | Immediately when rendered/settled |
| Large tool stdout/stderr | 7 days |
| Intermediate screenshots | 14 days |
| QC failure evidence | 30 days after resolution |
| Detailed journal events | 30 days after orchestra closure |
| Full finished workflow event history | 90 days |
| Condensed task summary | 180 days |
| Owned clean worktree | 3-day post-integration grace |
| Trash quarantine | 7 days before physical purge |
| Accepted ADR and migration decisions | Git history, no workflow TTL |

Quotas: warn at 80% of evidence quota, throttle optional capture by 95%, preserve required evidence or **pause safely** rather than silently discarding it. Images are files addressed by SHA-256, with metadata/ref counts in the DB, not blobs inside hot tables. Never store API secrets, raw authentication tokens, or private prompt internals in journals. Images may contain secrets: treat uploads as sensitive, scope access, and scan/redact where feasible.

## Garbage collection protocol

`active -> sealed -> gc_eligible -> quarantine -> purged`.

- Seal only after task run/QC results and required knowledge promotion decisions are durable.
- Recheck real Session/Workspace liveness at deletion time, not just based on timestamps. Protected: running, waiting for human intervention, active descendant/linked tasks, unmerged/unpushed work, pinned evidence, pending ADR PR, unresolved errors or unknown state.
- Preview expected reclaimed bytes/items with reasons and references; support dry-run. Do not delete files outside MAMC-owned roots. Two-phase rename into owned quarantine before deferred unlink; traversal and symlink escape checks required.
- Remove expired command receipts and workflow events only after the parent run is sealed; do not break live idempotency.
- SQLite WAL checkpoint/vacuum at idle maintenance windows; no full VACUUM during active scheduling.
- PI WEB already has a **manual** Session Cleanup path with busy-session exclusions and archive/delete preview. Avoid deleting its JSONL or worktrees by direct rm; ask the host for capability-based scoped cleanup or limit automated GC to MAMC-owned files until an upstream integration is available.

## Journal projection

An agent-tool event does not itself need a prose rewrite. A Live Journal is a **derived view** over bounded task events and evidence IDs: role, task, pass/fail, diff statistics, tests, screenshot, timestamp, source link, plus a concise optional checkpoint summary. Prefer thumbnails and lazy image loading. Full artifacts remain referenced by IDs, never repeatedly carried through WebSockets.

## Knowledge promotion

When a significant long-lived decision or repeated QC failure changes the design:

1. Collect final evidence snapshot and PR/commit SHAs.
2. Ask Sol/Astra for a candidate ADR with Context, Considered Options, Decision, Consequences, Verification, and References. Never cite soon-to-expire logs as the **sole** source for rationale.
3. Open an explicit PR in the **target repo**, e.g. `docs/adr/0012-token-invalidation.md` (plus `docs/engineering/migrations/` for migration notes). Commit/publish only with the relevant authorization/approval policy.
4. Pin the minimal referenced evidence until that ADR decision is accepted/rejected. A rejection is not silently converted to an acceptance.
5. Move old detailed data into retention after the final publication and QC seal. Keep `AGENTS.md` short; do not inject all ADR files into every model turn.

## Implemented retention subset (ADR-0009)

The current implementation provides an evidence-linked Journal projection over
bounded Workflow events, durable QC/run summaries and SHA-256 evidence refs.
A preview/confirm retention flow can transactionally prune up to 200 old,
public Run activity records only after their Run has been sealed and their
entire Workflow has completed integration/synthesis. Both event age and
Run sealing age must meet the operator's 30–365 day threshold.

Native Pi Session JSONL, owned/linked Worktrees, branches, command receipts,
QC evidence and unfinished Workflow state remain untouched.

ADR-0010 adds explicit, SHA-256 content-addressed private PNG/JPEG screenshot
capture only when an existing file is tracked in the exact sealed QC Git commit,
and verifies the stored image bytes on read. It also provides a **reviewed**
ADR proposal with actual QC/evidence/screenshot references that can be staged
without a Git commit in a distinct review Worktree. The operator still owns
Git review and PR publication; Micromanager never claims a user-authored
ADR is already accepted. PI WEB does not
offer a public native Session archive/delete API in the current v1 contract;
such cleanup must not be replaced by raw filesystem deletion.

## Consequences and limitations

The current implementation only runs explicit, scoped GC for sealed public activity projections. Real screenshot bytes and human-reviewed ADR file staging are available, but no native Session/Worktree GC, automatic screenshot taking or ADR PR publishing is implemented. `WorkflowInstance.events` has a maximum of 200 entries to bound state. Existing PI WEB session cleanup and worktree removal must remain separate until their lifecycle protections are explicitly integrated.
