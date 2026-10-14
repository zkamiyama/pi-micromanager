# Residual acceptance: bounded product changes and actual hosted tests

Date: 2026-10-14. Related: #34, #35, #85, #87, #88, #92 and parents #36–#38.
This is an acceptance map, **not a production deployment certificate**.
Exact reviewed commit, final CI and real execution receipts belong in the PR/Issue
sign-off. A pending or faux run is not real-provider authentication evidence.

## #34 — source discovery is connected to production readonly Runs

`productionTools()` now includes `mm_glob_repo_files` and `mm_search_repo_text`.
Both execute a fixed program through the existing readonly Bubblewrap boundary;
only bounded JSON data enters it. Literal search has no user-defined regular
expression or shell interpolation. The glob algorithm is bounded dynamic
programming for `*`, `**`, `?`, not a backtracking expression engine.

Limits: 12,000 scanned directory entries, 1,200 candidate files, 30 path levels,
128 KiB per text file, 3 MiB total text, 60 short matches or 120 filename matches.
Hidden/control/dependency/build paths are excluded; symlinks and hardlinks are
not traversed. Prefix/glob narrowing supports larger repositories explicitly;
truncation and skipped entries are reported. Unknown schemas or escaped paths
fail inside the namespace rather than adding host mounts.

`tests/production-search.required.mjs` exercises actual namespaces and a real
Durable QC Harness using the new tools. It is in the mandatory isolation job.

## #35 — operator-owned disclosure, bounded private failure evidence

Production `diagnostics` is a host policy, never a model/workflow instruction:

```json
{
  "diagnostics": {
    "labels": {"exact reviewed test name": "Approved public label"},
    "compilerCodes": true,
    "retainPrivateRaw": false,
    "maxRawBytes": 32768,
    "maxRawArtifacts": 32
  }
}
```

Only configured exact test-name mappings and fixed compiler codes enter public
failure diagnostics. Every other production test name is withheld. Arbitrary
assertion bodies, credentials, paths and stdout/stderr are not forwarded to the
model or browser. Compatibility mode retains its older best-effort projection;
that mode is not represented as the production disclosure contract.

Raw capture is **off by default**. An operator may explicitly enable private,
immutable, size/count-bounded failure files in `private-test-failures/` beneath
private plugin state (directory 0700, files 0600, exclusive no-alias creation).
The only public receipt is an opaque hash, byte count and capture status; there
is no browser/model raw-read API. Captured raw output can be sensitive and may
enter an operator's offline backup. Enable only after reviewing the local access,
backup encryption and retention policy. Tests in this change use synthetic data.

Retention is finite **keep until manually reviewed**, not automatic deletion:
at the configured count cap, new raw capture is suppressed rather than overwriting
or deleting evidence. Repeated content/Run identity does not allocate another
file. These private raw objects are not the public-activity rows pruned by #88.
Native Pi transcripts are never copied. `tests/private-test-diagnostics.test.mjs`
and `tests/production-diagnostics.required.mjs` verify the real server path and
secret-free public Journal while synthetic raw bytes stay only in private state.
A fake `bwrap:` line in test stderr cannot inject its raw body into an error.

## #85 — supported execution contract and evidence matrix

| Path | Supported authority and enforcement | Regression evidence |
| --- | --- | --- |
| Public activation/recovery | Host-owned production policy, canonical/private state, persisted mode, exclusive local flock | production server integration, state-owner, offline restore suites |
| Workspace / tool launch | Exact selected IDs, canonical project/managed leaf, readonly QC versus isolated coding tools; actual namespace preflight | production boundary, production search, runtime suites |
| Git / external mutation | Fixed brokers, passive config, exact SHA/repository, current generation and owner after async preflight | production execution fence, publication suites |
| Stop / uncertainty | Lifetime cancellation reaches Harness/tools; join before lock release; persisted failed/uncertain result is not success | production runtime and mandatory server-isolation suites |
| Real browser / hosted runtime | Shipped PI WEB processes and Chromium sandbox, actual public peer transport and actual tools/SQLite | hosted-browser job and `scripts/hosted-acceptance.mjs` |

Supported production tool/test profile: trusted Pi/PI WEB/SDK control process
on Linux with working Bubblewrap, fixed system Git and private state. The model
provider loop and publisher are **trusted host components**, not wholly sandboxed.
Native/compatibility execution is not a production sandbox; unavailable namespaces,
wrong capabilities/models, state downgrade, unsafe paths or unproved recovery are
refused without an unconfined fallback. Arbitrary remote/container backends,
malicious same-UID processes, cross-tenant isolation and all OS/kernel patch states
are not certified. Actual target-host hard quotas/identity/ingress remain #86.

## #87 — capacity-aware new-work admission, not a machine quota

Host-owned `productionSecurity.storage` defaults:

```json
{
  "maxStateBytes": 8589934592,
  "warningStateBytes": 6442450944,
  "minAvailableBytes": 268435456,
  "warningAvailableBytes": 536870912,
  "maxEntries": 100000,
  "maxScanMs": 2000
}
```

`security.capacity` returns bounded metadata-only total/managed bytes, filesystem
available bytes, completeness, warning/blocked reason and configured limits. No
credential/file payload or full path inventory is returned. Scans never follow
control-state aliases or hardlinks. Internal dependency aliases in an exact
managed leaf are counted but not followed; targets outside that same leaf fail.
Concurrent directory changes, unavailable capacity, an exhausted scan budget or
invalid policy block new work instead of claiming an accurate measurement.

Public new-work routes, actual Durable launch/resume, Worktree creation, and the
last hop after asynchronous Git preflight enforce the current measurement.
Readiness, inspection and stopping remain usable. Existing active/uncertain Runs
and their budget reservations/evidence are not deleted or relabeled. Capacity
recovery permits a *new* admission check; it never resets an uncertain Run.

Per-file metadata scans are a sampled admission rule, not an atomic allocation
reservation or hard aggregate disk quota. Operators must budget the private state
filesystem and configure #86 cgroup/filesystem controls. A large trusted dataset
may require deliberately raised finite limits; no unlimited/fail-open setting is
provided. `tests/storage-admission.test.mjs` covers restart, pressure during actual
public Git preflight, aliases, low space, warning/scan bounds and retained evidence.

## #88 — exact own-activity retention proof

Public activity preview is tied to scoped IDs, content digests, Run evidence,
Run update time and Workflow revision. Active/unsealed/uncertain siblings, pending
approvals and incomplete external publication pin the Workflow. Existence checks
cover *all* records, not the bounded browser history pages.

Deletion rechecks exact contents/sealing under its SQLite write transaction and
stores an operation receipt **atomically with DELETE**. A lost response can be
reconciled after reopening from that receipt; missing rows by themselves are
not proof of success. Expired/cross-scope/changed/partially deleted candidates
fail closed. No native Pi JSONL/SQLite, QC evidence, private failure artifact,
Worktree, ADR or external state is reclaimed by this operation.

`tests/activity-retention.test.mjs` includes same-length tampering, a writer
between preview validation and DELETE, unexplained missing rows, lost completion,
reopening and approvals/publications outside the 100-item UI page.

## #92 — actual hosted test and explicit remaining assurance

See [hosted local procedure](HOSTED_ACCEPTANCE.md). The credential-free mode runs
real PI WEB, Chromium, plugin peer, Workflow engine, Git brokers, Bubblewrap,
Durable Harness, QC/diagnosis/synthesis and state recovery. Only provider responses
are scripted. Four live cards and direct UI steer exposed a subscription-start
race; rereading the Run snapshot **after** channel acknowledgement prevents
missing a Run created during the public channel's non-replayed startup gap.

An optional, explicitly approved same-repository publication trial uses only new
`e2e/local-luna-*` base/source refs. The actual product publisher performs approved
push/PR/merge; one real successful merge reply is deliberately discarded, then
state is reopened and reconciled from GitHub without a second merge request.
The test supervisor refuses a second external merge before it can happen. This
is distinct from the earlier direct-GitHub-tool branch trial. A failed or ambiguous
external trial retains local state and test refs for inspection, not blind replay.

A real OAuth mode is an owner-operated acceptance profile, using the previously
approved Luna Low / QC Max selection. A faux CI pass does not complete that real
model-backed acceptance. User-reported real SDK smoke #91 remains valid and is
not rerun merely to infer hosted results. #92 closes only when its own relevant
executions and external reconciliation receipts have actually succeeded.

## Still separate

#86 full deployment qualification, #89 safe native-session/Worktree physical GC,
and broader #5 archival ownership cannot be certified by these product tests.
Public owner lifecycle APIs and complete cross-system deletion proofs remain
prerequisites. Do not guess private routes or remove another owner's files.
No production service, credential value, existing user data, protected ref,
security policy or deployment is changed by these defaults or regressions.
