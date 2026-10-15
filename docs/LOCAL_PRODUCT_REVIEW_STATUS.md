# Local-owner product draft: review status and remaining acceptance

Date: 2026-10-15. Scope: #5, #89, #86 and parent trackers #36/#37, under [ADR-0020](adr/0020-local-owner-durable-product.md).

**Not accepted or merged.** This note documents a read-only review of the retained local development draft. It is not a report of vulnerabilities in the shipped main branch, a completed regression test, or an authorization to apply unverified lifecycle code.

## Reviewed source and environment

The retained checkout is `/tmp/mm-local-product-1T9MUw/repo` on the owner's 270-PC, branch `feat/local-durable-product`, based on `6dcb050aa3bdbb0e4fd28ed2173a8d64589596ec`. Its runtime changes and new artifact/lifecycle files are uncommitted. The final source state is not represented by that base SHA alone.

After the owner restarted Desktop Commander, read-only commands succeeded. The host reported Node 22.23.3, kernel `6.18.33.1-microsoft-standard-WSL2`, and zero D-state Bubblewrap processes. This was not a new local-owner end-to-end qualification.

## Concrete review observations

| Area | Observation in the uncommitted draft | Required resolution and evidence |
| --- | --- | --- |
| Image transport | Local image input allows 512 KiB raw bytes / up to 700,000 base64 characters, but the pinned PI WEB public protocol limits JSON request input to 256 KiB | Choose an image bound fitting base64 plus metadata, or design a separately reviewed chunk protocol. Test through the actual public browser/peer boundary, including just-below/above-limit inputs |
| Image decoding | JPEG validation checks start/end signatures but does not establish bounded decoded dimensions | Validate supported bounded frame structure before browser decoding; test oversized dimensions, truncated segments and unsupported media. An upload remains operator-provided, not attested QC capture |
| Compressed logs | Read bounds include maximum decompressed output, while the draft has not established a complete decoder resource/window bound | Verify the selected Zstandard API and cap decoder resource use; test high-ratio, malformed and oversized frames with disposable files |
| Archive identity | `archiveRun` rebuilds public activity under a stable per-Run key; later activity pruning or changes can yield a different request hash on repeated maintenance | Reuse and verify the original finalized archive/retirement receipt. Prove repeated maintenance and reopen do not overwrite a prior archive or recreate expired detail |
| Pins and owned-resource retention | Artifact pins are stored, but the draft's Workflow protection predicate does not inspect them | Define and test the relationship between artifact/Workflow pins, pending evidence and owned Run/Worktree reclamation. Never report a pin as protection beyond what is actually enforced |
| Public request lifetime | The maintenance peer request awaits work that may include many Runs and a Git removal timeout longer than the pinned host's 10-second backend request deadline | Use a bounded, correlated admission/receipt and observable joined operation, or otherwise demonstrate bounded completion. Lost request replies must not restart an uncertain deletion |
| Worktree and Durable retirement | New ownership checks, operation reservations and tombstones exist in the draft but lack the required complete failure/restart test suite | Exercise actual disposable Worktrees/SQLite/Harness shutdown, retained Git refs, competing leases, dirty/untracked/ignored files, changed authority, checkpoint failure, interruption, lost replies and no-replay across reopen |
| Journal UI | The previous attempt to add the local artifact/ADR-link/maintenance controls did not execute | Connect the supported public UI and test actual image/log display, link authority, pending/blocked states and scope changes; do not count helper-only tests as product completion |

These are source-review observations and missing proofs. Except for the documented transport limits, they are not claims of reproduced exploits. The earlier 26 focused profile/server/fence tests did not validate the later artifact/reclamation code.

## Refused operation in this follow-up

A single `Remote_Desktop_Commander.start_process` call proposing source fixes for media bounds, archive reuse and pin-aware maintenance, followed by a build, was blocked by OpenAI's tool-safety check. No detailed reason was returned. That edit/build call did not execute, and the same runtime change was not rephrased or applied through another route.

Desktop Commander connectivity was therefore restored, but the separate tool-safety refusal remained. This is not an owner-authorization deficit and not a failed model response. No new paid model call, production daemon operation, native Session deletion or user-data reclamation occurred.

## Work allowed independently

English documentation translation and the standalone TypeScript compiler upgrade use separate clean development branches, not the refused runtime draft. Their successful build/CI/merge results qualify those changes only. They do not close #5/#89/#86 or their parents.

The next legitimate completion evidence must cover the actual corrected source, the real public server/browser path, finite lifecycle/fault cases, Node 22/24, required successful isolation and hosted regression gates. Preserve owner-approved scope and existing security controls. Keep uncertain outcomes and original trial data until their own reconciliation is proved; a missing resource or green documentation CI is not a deletion receipt.
