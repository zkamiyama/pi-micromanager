# Local-owner Journal, YOLO and resource maintenance

This is the single-trusted-owner Windows/WSL product profile selected in [ADR-0020](adr/0020-local-owner-durable-product.md). It is not a multi-user or Internet-facing service profile. Software regression acceptance is in [CI-first acceptance](LOCAL_OWNER_CI_ACCEPTANCE.md); the particular operator WSL environment is verified separately after merge under #86.

## Opt in on a new state root

Keep the existing PI WEB service/state unchanged. Prepare a separate development PI WEB configuration and a fresh `PI_WEB_DATA_DIR` using the host's documented setup. Its Micromanager plugin data subdirectory must be private, owned, canonical, and empty on first local-owner activation. Do not delete/move an old state marker, copy an old production database into it, or attempt to switch an existing strict/native root by changing a flag.

Example host-owned plugin settings (replace the paths/model/repository with the owner's reviewed values):

```json
{
  "productionSecurity": {
    "mode": "local-owner",
    "projectRoots": ["/home/OWNER/projects/APP"],
    "models": [{"provider": "openai", "model": "gpt-6-luna"}],
    "publication": [{"repository": "OWNER/APP", "baseBranch": "main"}],
    "limits": {
      "maxConcurrentRuns": 4,
      "maxModelRequests": 60,
      "maxToolCalls": 200,
      "maxRunMs": 1800000
    },
    "maxCommandMs": 60000,
    "maxWorkspaceBytes": 536870912,
    "localRetention": {
      "maxBytes": 268435456,
      "maxAgeDays": 30,
      "autoReclaimWorktrees": true
    }
  }
}
```

Use PI WEB's existing authentication and local-only ingress; bind the gateway to `127.0.0.1`. Windows localhost forwarding and the effective WSL network configuration remain operator assumptions to verify, not settings changed by this plugin. The host/OS/account, Pi SDK and fixed Git publisher are trusted; worker code is not. The model authentication source remains controlled by Pi or the existing validated host-only `modelAuthFile` option. Never put token contents in settings examples, Workflows, Git, logs or CI.

Workflow/quick-launch configuration must select `runtime: "durable"` and `test.execution: "sandbox"`. Explicit external `allow` decisions implement YOLO only inside the host's exact repository/base allowlist. An example Workflow permission set is:

```json
{
  "permissions": {
    "default": "ask",
    "actions": {
      "git.commit": "allow",
      "git.push": "allow",
      "github.pr.create": "allow",
      "github.pr.merge": "allow",
      "deploy.production": "deny"
    }
  }
}
```

This does not skip QC, target validation, operation generations, GitHub checks or exact-SHA merge. Omit publication configuration and deny external actions for a no-publication workflow. Strict `mode: "production"` continues to require `ask`/`deny` for external changes. Neither profile installs unconfined worker tools or falls back to native sessions.

## Journal operations

Open **JOURNAL**, then **Load evidence-linked journal**. The **Local storage usage** section is available only under local-owner settings.

Select the current sealed QC Run, then a PNG/JPEG file and **Import local image**. The raw file limit is 180 KiB; dimensions are bounded to 4096 pixels per side. The image is an operator-supplied local annotation linked to that exact QC/source SHA, not evidence that a model captured it. No image is implicitly committed, published or sent to another model. The older tracked-Git screenshot capture remains a distinct operation.

**View local image** and **Read compressed activity** explicitly load verified local bytes. A Run's public projection contains bounded summaries/events, not hidden reasoning or native transcripts. It is compressed with Zstandard and limited to 128 KiB before compression. Images and detailed archives share the configured total capacity. The oldest eligible completed details are reclaimed on subsequent storage/maintenance passes; this is not an always-running hourly deletion service.

**Pin local artifact** protects the owning Workflow's local artifacts and owned resources. Unpinning releases that pin only; active/held/unsealed work and uncertain external/retirement operations remain protected. If every eligible byte is protected, new storage is refused rather than discarding protected data. Display pagination never limits safety checks.

For **Link Git ADR**, enter the public Workspace ID and an existing tracked `docs/adr/*.md` path. The host verifies a clean regular Git file and stores its exact commit/path. A recognized HTTPS GitHub origin produces an immutable browser link; other repositories retain the local path/commit reference. Journal never becomes the canonical ADR text or starts a separate commit/push/PR flow. Use ordinary reviewed Git development for the ADR itself.

## Maintenance receipts and recovery

Completed eligible workflows can receive one automatic maintenance pass. The Journal also offers **Run local maintenance** and **Refresh local Journal**. The initial response acknowledges a persistent operation ID, not successful deletion. Refresh observes `running`, `completed`, `blocked` or `uncertain`. Duplicate calls with the same request ID return the original receipt; a different payload under that ID is refused.

The public protocol is:

```text
auto.maintenance.run    { workflowId, requestId } -> operation receipt
auto.maintenance.status { operationId }          -> current receipt
auto.maintenance.preview { workflowId }         -> candidates and latest status
auto.worktree.retire.preview { workflowId, taskId } -> immutable preview
auto.worktree.retire.confirm { previewId }       -> operation receipt
```

An external Git command may outlive a peer connection, so never infer failure or success from a lost response. Read the same operation ID. Explicitly selecting a **new maintenance pass** after a completed/blocked pass does not discard underlying resource receipts or retry an uncertain deletion. Uncertain operations require inspection; there is no automated reset or replay endpoint.

Only newly recorded, controller-created Worktrees with original directory identity, sealed successful Runs, retained result refs, and no active/held/pinned/uncertain work are eligible. Dirty, untracked, ignored, aliased, submodule, locked and legacy-unproved checkouts are retained. Git removes the working copy without `--force`; branches and result commits are not removed. Human-created native sessions and user Worktrees are never swept.

Successful owned Durable DB reclamation requires actual Harness shutdown, verified archived public evidence, a successful persisted input, SQLite checkpoint/integrity and stable file identity. No-replay tombstones and minimal QC/external operation records survive. An expired archive without a prior successful retirement receipt cannot authorize destruction of the original DB. An interrupted delete remains unknown rather than being repeated or reported successful merely because a file disappeared.

Maintenance has a 120-second side-effect admission deadline, four concurrent operation slots, bounded inventories and per-command timeouts. It drains before state ownership is released. Logical counters, archive byte limits and per-process rlimits are not WSL-wide cgroup/disk quotas, a monetary spending cap or protection against a malicious same-UID process. Metadata/receipts have finite admission limits and are retained for safety; there is no unsafe automatic tombstone sweep.

## Post-merge WSL check

Use the exact merged commit and the credential-free commands in [CI-first acceptance](LOCAL_OWNER_CI_ACCEPTANCE.md) on a separate disposable checkout. Supply only the resulting counts, code, commit and environment metadata, not tokens or native databases. Record actual namespaces, localhost/auth assumptions and stop/restart behavior for the selected WSL installation. The remaining approved real-account/test-target check is separate from these faux-provider tests. No production deployment or data migration is performed by merging this implementation.
