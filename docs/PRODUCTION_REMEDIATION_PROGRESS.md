# Production safety remediation — PR #78 continuation

Release status: **candidate pending exact-commit CI and independent deployment review**.
Code-level remediation does not certify the running host, deployment, ingress or provider billing.

## Integration and acceptance matrix

| Issue | Runtime change | Disposable regression evidence |
| --- | --- | --- |
| #79 | The public PI WEB Workspaces resolver invokes canonical, project-scoped `assertWorkspaceBoundary` and checks exact selected IDs. Server activation persists/verifies a production-only marker and rejects implicit compatibility downgrade. | `tests/production-server-integration.test.mjs` exercises state/package ancestors, aliases, foreign project, managed parent and leaf, and a marked-root activation. |
| #80 | The combined state-owner/host lifetime signal reaches the live `DurableRunHost`, model admissions, tool cancellations, and backend disposal. Shutdown joins in-flight public requests and active Harness/tool processes **before** releasing flock; failed joins retain ownership rather than silently transferring it. | Public server startup and fault-injected owner loss during a delayed faux model and an actual isolated shell tool, plus direct Harness and OS owner tests. |
| #81 | A host-owned control-generation snapshot and owner check is captured on production Git invocation, checked again **after** asynchronous repository-config preflight, directly before native execution. A changed generation is a fail-closed denial. | Public `auto.worktree.create` with actual temporary Git and deferred config preflight: Pause, configuration change and owner loss cause zero `git worktree add` mutations. |
| #75 | Offline SQLite/WAL snapshot and SHA-256 verification remain. Restore requires an independently trusted digest and **creates** a new canonical directory; it never overwrites existing state, writes `RESTORE_REQUIRES_REVIEW` before any payload, verifies each copy, and has no unquarantine or replay command. | `tests/offline-backup.test.mjs`: WAL round-trip, tampering, traversal, overwrite refusal, interrupted partial restore, preserved quarantine and dependency inventory. |

Use `npm ci --no-audit --no-fund && npm run check` and the dedicated
`MM_REQUIRE_SANDBOX=1` job on the **exact final PR commit**. A skipped/refused
sandbox is not a successful-isolation certification. Record job names, results,
test counts and the reviewed diff before considering a merge.

## Offline snapshot / restore runbook (no live production operations)

These commands must only be used after the operator has independently stopped
all state writers and confirmed the state root is offline. The confirmation
flag is an explicit acknowledgement, **not** a daemon-state oracle.

```sh
node scripts/offline-state.mjs snapshot --source /offline/state --destination /new/snapshot --reason "offline receipt" --offline-confirmed
node scripts/offline-state.mjs verify --source /new/snapshot --digest TRUSTED_64_HEX_RECEIPT
node scripts/offline-state.mjs restore --source /new/snapshot --destination /brand-new/private-state --digest TRUSTED_64_HEX_RECEIPT --reason "offline recovery drill" --offline-confirmed
```

The manifest receipt digest must be retained in a separately trusted record:
recomputing it from an untrusted archive does not authenticate the backup.
No command takes an existing or live state directory as a restore destination.
A restore interrupted after creating its root leaves a quarantined partial
directory. Destroy *only disposable test fixtures* when exercising deletion.

### External-state reconciliation required before any later production use

The snapshot is a plugin-state archive, **not** a machine snapshot. The
manifest records known Run, Worktree and publication identifiers where present
and explicitly excludes managed and linked Git Worktrees, remote branches/PRs,
provider submissions, native PI WEB session storage and credentials. After
restoring, an operator must independently reconcile exact worktree/Git SHA,
publication/remote outcome, uncertain provider results, native sessions and
host credentials/authorizations. No uncertain Run may be automatically
replayed or relabeled successful. Production and compatibility activation
both refuse the quarantine marker. There is intentionally **no automatic
unquarantine** or reviewed-migration bypass in this PR.

### Ownership trust boundary

The state lock is an OS flock on a daemon-owned file descriptor. The short-lived
launcher only acquires the inherited description; the daemon keeps it until
joined close. The in-process generation fence protects cooperating local
operations and assumes trusted local filesystem, unmodified host SDK/Git and
no malicious same-UID process. It does not provide distributed fencing across
independent state roots. Quotas, auth/TLS, cgroups, provider spend limits,
actual host namespace success, OS patching and independent security review
remain external deployment obligations. None of these tests reloads a production
daemon, deploys code, publishes application changes or accesses a paid provider.
