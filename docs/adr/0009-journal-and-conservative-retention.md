# ADR-0009: Evidence-linked Journal and conservative activity retention

- Status: Accepted; bounded Journal and confirmed activity retention implemented; screenshot orphan GC extended by ADR-0016
- Date: 2026-10-09
- Extends: ADR-0003, ADR-0006, ADR-0007

## Evidence-linked Journal

`auto.journal` is a read-only, workspace-scoped projection over the
authoritative Workflow, one-shot Pi Run registry and immutable SQLite evidence
receipts. It preserves actual Task/QC status, Run identity and session,
latest public activity event kind, QC verdict, exact Git HEAD and finite
host-reported evidence summary. It does **not** copy native Pi JSONL transcripts,
tool arguments, hidden reasoning, prompts or provider credentials. The current
view is bounded to 120 recent Workflow events and 120 Runs per Workflow.
The normal Workflow/Run/evidence records remain authoritative.

Host test verification persists exit code, output byte counts and SHA-256
fingerprints. Potentially sensitive raw stdout/stderr is not copied into
Journal evidence. A failed test remains a failure even if a model claimed PASS.

## Retention boundary

Only **public activity projection rows** in `execution_activity` can be
deleted by `auto.retention.confirm`; each such row must:
- be at least the requested age (30–365 days);
- belong to a Run that has also been durably `sealed` for that age,
  with a non-null evidence reference;
- belong to a Workflow whose **every** Task is `integrated` or `done`,
  and which has **no** pending planning/armed/activated QC amendments;
- still match the exact Run's saved evidence reference and native Session ID.

`auto.retention.preview` selects at most 200 eligible rows and records a
workspace-scoped SHA-256 fingerprint of their identities and dimensions,
estimated UTF-8 bytes and an expiration after 10 minutes. A second explicit
operator confirmation rechecks the source Workflow/Run/evidence state and
every selected row; a changed Run, new activity, moved retention window or
wrong workspace fails closed. The actual SQLite deletion is transactional.

If the activity deletion commits but the separate plan receipt write is
interrupted, re-confirming can recognize all the original IDs are already
absent and recover an idempotent completed receipt. Partial deletion is
uncertain and requires human reconciliation. Active previews are rate-limited;
old preview receipts eventually age out after 30 days.

This operation never deletes authoritative Workflow revisions, Task/QC
results, durable command receipts, evidence metadata, native Pi Sessions,
native Pi JSONL, Git Worktrees or Git branches. It is not a global cleanup
button. Running/held/failed/inconclusive workflows are protected indefinitely
until a user resolves the relevant decisions.

## Limits

PI WEB `pi-sessions` v1 publicly supports create/run and the companion
events bus supports connection; **no public Session archive/delete or
liveness-aware GC method exists**. Do not touch native Pi Session files
through filesystem deletion or invent an internal host route.

Similarly, PI WEB's native Worktree removal flow owns deletion safety.
Micromanager does not automatically remove linked Git Worktrees. Future
storage quotas, screenshot evidence, full artifact attestation, workspace
quarantine and ADR publication require separate supported APIs and explicit
security/retention review.

Mock-host tests and disposable **real Git CLI** integration tests increase
confidence, but an authenticated real-provider/PI WEB-host E2E remains pending
under the user's deferred trial plan.

## Addendum (ADR-0016): Private orphan image cleanup

A second, explicitly confirmed operation now inspects only **plugin-owned**
content-addressed screenshot blob directories. Files must be older than
24 hours, have a filename matching their SHA-256 bytes and be **absent**
from the scoped `screenshot_evidence` table. The target Workflow must be
completely resolved, all Runs inactive, and no Autopilot active. Preview
stores a 10-minute fingerprint of the exact bounded orphan set; Confirm
revalidates the manifest and reserves the operation **before** unlink.
Changes or ambiguous crashes stop safely, and referenced QC/screenshot
objects stay pinned.

The new cleanup is **not** general session/worktree GC, hot/warm/permanent
retention, thumbnail optimization or removal of authoritative evidence.
The PI WEB public host session capability still lacks archive/delete.
See [ADR-0016](0016-bounded-diagnostic-escalation-and-evidence-publication.md).
