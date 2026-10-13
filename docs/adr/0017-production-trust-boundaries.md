# ADR-0017: Host-enforced production trust boundaries

Status: implemented candidate, subject to successful exact-commit CI and deployment evidence.

## Context

The R01–R23 remediation established deterministic workflow gates, but idle execution, same-user repository tests, native extension tools, executable Git configuration, and unlocked multi-database state still could not justify system-level production assurance. A test mock is not a runtime authority and a model assertion is not a security attestation.

## Decision

Keep compatibility mode explicit. Add a host-owned immutable production settings profile that wraps the existing public control plane rather than letting Workflow JSON enable or relax isolation. Production uses Durable only, sandboxed file/shell tools with no host SDK filesystem, and fixed local Git broker operations. Git metadata is masked in sandbox mounts; network and credentials remain outside untrusted tools. Read-only roles/tests get read-only mounts. External mutations require exact operator approval and a host destination allowlist.

Persist request/tool/input/deadline limits independently of model reports. At runtime settlement, check every admitted input's committed outcome through the public Durable transaction API; failed/missing proof cannot become a successful workflow transition. Retain uncertain reservations. Use a private canonical state root and lifetime OS lock for production activation.

Pin CI actions to verified upstream full SHAs, do not persist checkout credentials, and distinguish mandatory successful isolation from portable refusal tests. Publish controls and unknowns through a readiness projection rather than an unconditional safe boolean.

## Consequences

Existing unsafe/YOLO profiles and old unproved input inventories require explicit migration. Production tools have a bounded subset of repository functionality; native arbitrary extensions, network-dependent tool setup, executable Git filters, and unrestricted Git commands are not supported there. Intentional refusal is preferable to a hidden privileged fallback.

Kernel/host compromise, same-UID malicious processes, authentication/TLS outside this plugin, hard machine-resource quotas, exact provider billing, external-state restore, and independent review remain deployment obligations. Git commit brokers and the publisher are trusted code and must stay small and separately tested. Ordinary state-machine core semantics are unchanged.

## Continuation status: release still blocked

The state-owner lock is now retained by the daemon's own open file descriptor;
a disposable child only establishes it. Offline snapshot creation and trusted-digest
verification are implemented, with external Git/provider/native-session dependencies
recorded explicitly. Restore and external-state reconciliation are not implemented.
New canonical path, production-mode, last-hop admission-fence and Durable-lifetime
components have regression coverage but are not fully connected at the public
server boundary. See [the continuation matrix](../PRODUCTION_REMEDIATION_PROGRESS.md).
Issues #79, #80, #81 and #75 remain open; component tests do not authorize a production release.
