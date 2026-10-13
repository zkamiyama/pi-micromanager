# Production remediation continuation

Release decision: **BLOCKED**. This document distinguishes implemented components
from end-to-end production integration. A successful test of an optional callback
is not proof that the server actually supplies that callback.

## Implemented in this continuation

| Issue | Change | Remaining acceptance work |
|---|---|---|
| #79 | `workspace-boundary.ts` rejects canonical state/package overlap in both directions, foreign project roots and non-leaf managed roots. `state-mode.ts` persists and validates a production-only marker. | Neither helper is yet connected to `src/pi-web/server.ts`; actual activation/capability paths remain vulnerable. |
| #80 | `StateOwner` keeps the flock open file description in the daemon, rather than a long-lived helper. `DurableRunHost` accepts an explicit lifetime signal, cancels active tools, joins close, and persists uncertain interruption before reconnect. | The control plane does not yet pass its lifetime signal to Durable. Automatic joined server disposal on owner loss and public API fault injection remain required. |
| #81 | `guardedHostExecution` checks the request signal after awaited Git inspection, and supports a captured final admission fence. The previously failing low-level Pause/lifetime tests now pass. | The server does not yet supply a control-generation fence; low-level injected-Pause coverage is not end-to-end Pause coverage. |
| #75 | Parent-owned OS lock; bounded offline SQLite/WAL-aware snapshots, SHA-256 manifest verification, exact payload inventory and explicit external dependency records. | Restore-to-new-root, automatic replay quarantine, reviewed external-state reconciliation and an actual restore drill remain unimplemented. |

The intended server-entrypoint/control-plane wiring and restore implementation
were not applied: the tooling rejected those writes. They were not rerouted
through another transport. Do not close the above issues from helper tests alone.

## Offline snapshot tool

After building, `scripts/offline-state.mjs --help` lists two commands: `snapshot`
and `verify`. The snapshot command requires explicit `--offline-confirmed` and
`--reason` values. Stop **all** state writers first. The flag records the
operator's prerequisite acknowledgement; it is not a process-level proof.
Production owners cooperate using the same local-filesystem lock. Legacy tools
that ignore this lock must also be stopped.

Snapshots use SQLite's backup API to include committed WAL data. They never
copy WAL/SHM files as independent databases, follow symbolic/hard links, overwrite
an existing destination or create a missing source directory. Every payload file
is hashed and the completed manifest digest is returned only after synchronization.
Keep that digest in a separately trusted record. Recomputing a digest from an
untrusted archive does not authenticate the archive.

Managed Git Worktrees, project repositories, remote PR/branch states, provider
submissions and PI WEB-hosted native session storage are **external dependencies**,
not falsely included in a complete machine backup. Known Run, Worktree-plan and
publication identities are recorded when present in the copied control databases.
Raw snapshot files may contain private project material; retain them in private,
access-controlled storage. Encryption, independent/off-host copies and disk quotas
remain deployment responsibilities.

There is deliberately **no restore or unquarantine command** in this version.
A failure may leave a newly allocated partial snapshot directory, but no successful
receipt is returned. Do not auto-activate extracted databases or clear quarantine
markers as a substitute for the missing restore/reconciliation implementation.

## Ownership trust boundary

The daemon opens the lock descriptor and lets a short-lived `flock` invocation
lock an inherited duplicate. The invocation exits before acquisition is returned;
the parent descriptor retains the lock until explicit release or process exit.
No PID-based stale-lock deletion or lock stealing is performed. Normal shutdown
must join workers before calling release. Canonical private paths and a trusted
local filesystem are required. Same-UID malicious processes, ignored advisory
locks, or namespace/host compromise are not covered by this mechanism.

## Verification scope

Tests use disposable local files, real SQLite/WAL databases, temporary local Git,
OS locks and the real Durable Harness with a deterministic faux provider. They do
not use production state, paid models or application publication. End-to-end
server wiring and restored-system behavior are not certified by these tests.

The release obligations in SECURITY.md and issues #36–#38/#72–#81 remain in force:
ingress authentication/authorization, deployment isolation, resource and provider
billing limits, external-state recovery and independent review need actual evidence.
