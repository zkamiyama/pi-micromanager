# ADR-0010: Immutable QC screenshots and reviewed target-repository ADR staging

- Status: Accepted for opt-in evidence capture and staging; native screenshot generation / PR publishing remain separate
- Date: 2026-10-09
- Related: ADR-0003, ADR-0007, ADR-0008, ADR-0009

## Context

The first evidence Journal held bounded textual QC receipts and Git SHA hashes,
but lacked verifiable bytes for a screenshot produced during a real Task.
An engineering decision that depends on screenshots or a completed QC audit
should not be "proven" by an assistant claiming an image was taken.
Architecture knowledge also belongs in the target project repository, not
in an infinite second transcript stored by Micromanager.

## Decision A: Content-addressed screenshots, explicitly captured

In **Journal → Actual QC screenshot evidence**, an operator may select the
latest, durably sealed, automatic QC Run and a relative path of the form
`screenshots/<safe-name>.png` or `.jpg/.jpeg`.

The host checks:
- the Workflow, exact QC Run/session/evidence receipt, and most recent QC
  source commit match and have not been replaced;
- PI WEB's public Workspaces resolver still owns the source linked Git
  Worktree; the Worktree has no unsealed competing Run;
- Git's root is the resolved Workspace, the checkout is clean, and its exact
  HEAD equals the QC-reviewed SHA;
- the file is a real regular file within the `screenshots/` directory,
  without a symlink leaf or path traversal;
- the file is an identified PNG/JPEG with size at most **1 MiB** (PNG
  dimensions at most 4096×4096); the original screenshot is already present
  on disk. This control plane does **not** fabricate or take screenshots.

After explicit capture, original bytes are stored under a private
plugin-owned, workflow-scoped SHA-256 content-addressed path with a durable
SQLite metadata record. The Run identity, QC SHA, content hash, file name,
size and timestamp appear in Journal. Capture is idempotent for identical
bytes, rejects mutations of an earlier record and caps storage to 32
artifacts/Workflow and 16 MiB/Orchestra scope.

The UI can request a **lazy, explicitly selected** image preview (up to
512 KiB); the host rereads and verifies stored bytes against SHA-256 on
every retrieval. Larger images remain hash-addressed with metadata and
require external operator inspection. No binary images are copied into
Workflow JSON, Pi prompts or general logs, and no screenshot bytes are
uploaded or pushed to GitHub by this feature.

Screenshot contents may contain personal information, tokens, proprietary
screens or credentials. The operator must inspect/redact before capture.
Storing privately does not prove redaction or screenshot test correctness.
The model's QC verdict and host Git/test gates remain authoritative; an
image cannot independently turn a failed QC into PASS.

## Decision B: ADR candidates with evidence, separate human-owned publication

When **all Tasks are resolved** (implementation Tasks `integrated`,
other Tasks `done`) and no active human amendment is pending, an operator
can provide explicit Context, Options, Decision and Consequences fields in
**Journal → Propose a verified architecture decision**.

A read-only ADR preview:
- rechecks sealed native QC Run identities and authoritative evidence refs;
- rereads and verifies any cited immutable screenshot bytes and cites only
  images whose SHA matches the current QC-backed implementation commit;
- includes exact QC Run, Git SHA, evidence hashes and screenshot references;
- records the target's clean Git HEAD, Workflow Revision, content SHA-256,
  chosen `docs/adr/0000-slug.md` path and a 10-minute expiry.

The target must be a **separate, linked, non-main Git Worktree** on a
non-protected review branch with no unsealed Pi Run. Files may not overwrite
existing content or escape the checkout through symlinks. The preview
contains the exact proposed Markdown, labeled *Proposed*, not *Accepted*.

Only a second explicit **Stage exact reviewed ADR file** action writes
those exact, bounded bytes to the target Worktree through an exclusive
create. A durable `reserved` marker is written **before** the non-atomic
filesystem action. On timeout or crash the operator uses **Inspect** to
reconcile the exact SHA: the tool never blindly retries or overwrites.

Staging leaves the ADR **uncommitted**. Micromanager never executes `git add`,
`git commit`, Push, merge or remote PR publication here. The operator still
reviews and publishes the file according to the target repository's own
security, branch protection and code review policy.

## Verification and limits

- Native Node and real temporary Git repositories in CI exercise
  screenshot capture, cross-Workflow isolation, head/dirty checks, private
  byte integrity and invalid-path rejection.
- Real disposable Git integration tests exercise ADR preview, Git target
  movement, human staging, exact file hashing, restart reconciliation and
  rejection of unauthorized writes.
- UI uses documented PI WEB plugin APIs. Authenticated real-provider/host E2E
  and actual automatic browser screenshot generation remain intentionally
  unverified/deferred.
- This is a meaningful ADR **staging** path, not automated GitHub PR creation
  or knowledge promotion without a human review.
