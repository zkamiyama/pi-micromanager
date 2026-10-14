# Production security and assurance scope

Micromanager is not unconditionally safe merely because CI passes. Production operation requires the host-owned profile below, a trusted patched Linux execution host, authenticated PI WEB ingress, and deployment-level quotas and recovery procedures. Compatibility mode retains native Pi support and is **not** an OS isolation boundary.

## Threat model and implemented controls

Untrusted inputs include repository code, test programs, model tool arguments, model reports, and network replies. Trusted components include this control plane, public Pi/PI WEB SDKs, Linux kernel, Bubblewrap, system Git/gh binaries, the host workspace provider, operator settings and credentials. Compromise of these trusted components, a malicious same-UID process, kernel vulnerabilities, or a malicious administrator are not solved by this package.

With `host.settings.productionSecurity.mode = "production"`:

- Native Pi Session creation/attachment/configuration is refused. Durable workers receive only sandboxed file/shell tools plus fixed local Git broker tools. No unconfined NodeExecutionEnv is installed for them.
- Worker shells cannot see the daemon home, inherited credentials, outbound/host network, or linked Git metadata. QC/planning file tools and host tests get a read-only workspace. Arbitrary user extensions are not admitted into this tool registry.
- Git commit and final-source merge operations are brokered through fixed argv and a verified linked non-main checkout. Hooks, fsmonitor, signing and background maintenance are disabled. Executable/redirecting repository Git configuration is rejected. Final merges accept only host-frozen QC source SHAs.
- Project roots and model selections are host allowlisted. Workspaces must be inside an allowed project or the plugin's managed-worktree root. Publication repositories are separately allowlisted, and effective external mutation policies must be `ask` or `deny`, not YOLO `allow`.
- The state root must be private/owned/canonical. An OS flock prevents a second cooperating production activation from opening the same state root; lock loss aborts the wrapped host lifetime. No stale PID lock is stolen.

All Durable Runs now have persisted finite request/tool/input/deadline budgets and committed input outcome checks. An idle Harness or a provisional report is not success. Failed or unproved input outcomes remain uncertain at the workflow boundary, and cannot finalize QC, planning or implementation. Counters and deadlines do not reset on restart.

## Host policy example

This is a configuration example, not an automatically enabled deployment:

```json
{
  "productionSecurity": {
    "mode": "production",
    "projectRoots": ["/srv/micromanager/projects/example"],
    "models": [{"provider": "YOUR_PROVIDER", "model": "YOUR_EXACT_MODEL"}],
    "publication": [{"repository": "YOUR_ORG/YOUR_REPOSITORY", "baseBranch": "main"}],
    "limits": {"maxConcurrentRuns": 4, "maxModelRequests": 60, "maxToolCalls": 200, "maxRunMs": 1800000},
    "maxCommandMs": 60000,
    "maxWorkspaceBytes": 536870912
  }
}
```

Configure this through the host-owned plugin settings snapshot, not Workflow JSON. The directory and exact model must exist. The workflow must explicitly set external actions to `ask` or `deny`, runtime `durable` and test execution `sandbox`. The profile refuses startup/resume rather than silently converting existing unsafe configurations. Existing Runs without the complete new input inventory are not automatically resumed.

Production requires `/usr/bin/bwrap`, `/usr/bin/prlimit`, `/usr/bin/flock`, `/usr/bin/git`, and (only for publication) `/usr/bin/gh`. GitHub publication uses an explicit HTTPS destination and a fixed host credential helper. Do not persist a credential helper, URL rewrite, executable filter or hook configuration in the agent repository. Place only required source/dependencies in workspaces; files mounted into a worker are intentionally readable by that worker and may enter model requests. Provision dependencies separately; tools have no outbound network and no arbitrary home-directory toolchains.

## Release gates and evidence

Run `npm ci --no-audit --no-fund && npm run check`. CI includes Node 22/24 compatibility tests and a separate `successful-isolation` job with `MM_REQUIRE_SANDBOX=1`. In that job, missing or refused namespaces are failures, not passing refusal coverage. Portable hosts may skip only known sandbox-unavailability cases with an explicit diagnostic; these runs do not certify isolation success.

The security suite uses synthetic secrets, disposable Git repositories and loopback servers, real SQLite/flock, and the real Durable Harness with a deterministic faux provider. It does not incur provider charges or publish an application PR. Authenticated compatibility smoke remains a separately approved, default-branch-only workflow; it is not production isolation certification.

The `security.readiness` peer operation reports configured controls and explicitly unverified deployment conditions; it never returns a universal-safety guarantee. Before production rollout, record evidence for TLS/authentication and authorization, provider scopes/spend alerts, OS/SDK patching, cgroup memory/PID/CPU limits, disk quotas, isolation success on the **actual** execution host, offline backup/restore drills including external Git/provider state, and an independent security review.

## Limits and residual risk

Workspace size scanning and per-process rlimits are not a hard aggregate disk, memory or PID quota. A fork/file flood must also be contained by a dedicated cgroup/container and filesystem quota. The host's provider request is necessarily network-capable; request budgets limit calls, not exact monetary spend or an already admitted provider request. Read-only mount checks do not make ignored dependencies hermetic. The daemon and publisher still share a trusted control-plane process; complete process/credential separation is a further deployment hardening measure.

Private state and flock are not a verified full-system backup. The offline CLI offers `snapshot`, `verify`, and **fresh-root-only** `restore`, requiring a separately trusted manifest SHA-256 digest. Restore creates a new private directory and durably writes `RESTORE_REQUIRES_REVIEW` before copying verified payloads; errors or interruptions leave that directory quarantined. Production **and compatibility** activation reject the quarantine marker. No unquarantine or automatic replay command exists. Independently verify database integrity, immutable evidence, external Git Worktrees/PR branches, provider outcomes and native PI WEB sessions before a future manually reviewed production recovery. Never reset uncertain Runs, overwrite an existing or active state directory, or infer external side effects from local backup timestamps.

These are explicit deployment release blockers, not silently waived checks. Track S01–S06 in issues #72–#77 and broader worker/resource/recovery work in #36–#38. No production daemon is reloaded by the tests or configuration example.
