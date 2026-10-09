# ADR-0014: Opt-in automatic Git Worktrees and PI WEB Workspace identity

- Status: Implemented experimentally; mocked PI WEB and real/disposable Git tests; authenticated real-host E2E pending
- Date: 2026-10-09
- Extends/supersedes: ADR-0008 manual-ID requirement and ADR-0013 configured-final-Worktree requirement
- PI WEB reference version: `@jmfederico/pi-web` `^1.202610.1` (implementation inspected at `v1.202610.1`; caret permits later compatible releases, so the ID derivation is checked at runtime)

## Corrected fact: PI WEB does not register Worktrees

Earlier ADRs conflated the *server-plugin capability* with PI WEB's actual
Workspace discovery. PI WEB's own FAQ explicitly says "PI WEB does not
register worktrees". The Git provider's `list(project)` runs
`git -C <project> worktree list --porcelain -z` and returns linked
(non-bare, eligible) worktree directories as Workspaces on demand. No GUI
adoption or Workspace registration is required when `git worktree add`
creates a valid checkout for an already registered Git project. Browser
Workspace lists may refresh only on tab focus; this is not a limit on the
host's fresh Workspace authority resolver.

Primary PI WEB sources (version explicitly inspected):

- [FAQ: discovery and refresh](https://github.com/jmfederico/pi-web/blob/v1.202610.1/docs/faq.html)
- [Bundled Git Workspace provider: worktree list and key=path](https://github.com/jmfederico/pi-web/blob/v1.202610.1/pi-web-plugins/git/server-plugin.ts)
- [Browser-facing Workspace catalog GET](https://github.com/jmfederico/pi-web/blob/v1.202610.1/src/server/app.ts)
- [Registry: workspace id derived from projectId and provider key](https://github.com/jmfederico/pi-web/blob/v1.202610.1/src/server/workspaces/workspaceProviderRegistry.ts)
- [Host plugin workspaces v1: only resolve](https://github.com/jmfederico/pi-web/blob/v1.202610.1/src/server-plugin-api.ts)
- [Host Pi Session creation re-resolves workspace and uses its path](https://github.com/jmfederico/pi-web/blob/v1.202610.1/src/server/plugins/serverPluginPiSessionsCapability.ts)

PI WEB HTTP has `GET /api/projects/:projectId/workspaces`. This **is**
a genuine non-GUI list operation. But a PI WEB *server plugin* receives
`PiWebHostWorkspacesV1.resolve({projectId, workspaceId})`, not `list`,
nor a documented authenticated self-HTTP base URL. For unattended
server-plugin startup, Micromanager does not assume browser presence,
guess ports/auth tokens, or reach private host internals.

## Pi session semantics checked

The upstream Pi coding agent's
[`createAgentSession` implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/sdk.ts)
selects `cwd` from the explicit option/session manager/current process and
builds context/resources/tools for that working directory. Its
[`SessionManager`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)
tracks persistent sessions for that `cwd`. PI WEB's host
`PiWebHostPiSessionsV1.create` first calls Workspace authority `resolve`
then `createHostedSession(authority.workspace.path)`; this ensures a
discovered linked Worktree can host a fresh Pi Session with no GUI
registration. **Pi itself does not manage PI WEB Workspace IDs.**

## Decision and explicit configuration

Keep the manual preview/create and legacy Workspace ID configuration.
Add opt-in `managedWorktrees: true`:

```json
{
  "managedWorktrees": true,
  "workspaces": {},
  "finalization": {"workspaceId": "auto", "autoMerge": true},
  "publication": {"remote": "origin", "baseBranch": "main", "draft": true},
  "models": {
    "implementer": {"provider": "...", "model": "..."},
    "qc": {"provider": "...", "model": "..."},
    "planner": {"provider": "...", "model": "..."},
    "architect": {"provider": "...", "model": "..."}
  },
  "test": {"file": "npm", "args": ["test"], "timeoutMs": 60000},
  "maxAttempts": 5
}
```

Only an explicit Autopilot **Start** may create Git Worktrees; merely
approving Sol's DAG or saving configuration is non-mutating. Missing
implementation Task IDs are provisioned into immutable per-DAG/per-Task
paths/branches under the plugin-owned data root. When `finalization` is
configured with `workspaceId: "auto"`, provision a *separate*
`mm-final-integration` Worktree at the same time, before original Tasks
start. The final Task itself is still appended only after sealed QC PASS.
No finalization/auto-merge is enabled unless the `finalization` field
is present. Existing explicit Worktree IDs remain unchanged.

## Workspace identity: version-dependent candidate, host-validated result

The current PI WEB Git provider uses the absolute linked Worktree path
as its `ProviderWorkspace.key`. PI WEB's registry computes
`sha1(projectId + ":" + providerKey).slice(0,12)` for its Workspace
ID. This **is an implementation detail, not a documented public ABI**.
To enable unattended server-plugin setup against the inspected host version:

1. Use host-mediated argv-only `git worktree add --no-track -b`; reserve
   the exact scope/branch/base SHA/destination in SQLite *before* mutation.
2. After Git confirms, inspect Git's registered Worktree, exact branch,
   base SHA, clean checkout, real directory and symlink-free path.
3. Derive a **candidate** ID from the PI WEB version-verified Git provider
   path key and project ID; immediately call public host
   `workspaces.resolve({projectId, workspaceId: candidate})`.
4. Admit the candidate *only* if the returned authority has the exact
   project, ID, absolute checkout path, non-main flag, and
   `provider.metadata.isGitWorktree === true`.
5. Persist resolved Task/final IDs in Autopilot settings before any
   implementation Pi Session. Future host calls re-resolve identities.

If the Git Workspace provider, key, ID algorithm or host trust checks
change, the lookup **must fail closed**. Do not execute a Pi Session with
an invented ID. An upgraded PI WEB that offers a **public server-plugin
list/lookup-by-path** API should replace this version-dependent candidate
algorithm; the existing HTTP route is preferable when an authenticated,
documented host-plugin HTTP client is provided.

## Failure, restart and ownership safety

The existing provisioner uses a deterministic scoped path and branch,
checks a clean exact Git base and ref absence, prohibits symlink
parents, and writes `prepared → reserved → created` receipts. On a
lost Git response or restart, `ensure` re-inspects the *same* receipt;
it never retries an unknown `git worktree add`. If Git did not actually
create the Worktree, startup stops for human reconciliation. A failed
Workspace authority lookup leaves the verified Git Worktree retained
and the Workflow unstarted; a later explicit Start can re-inspect it
without duplication.

Existing Worktree and QC authorization gates remain: no main checkout
as a worker, exact configured models, clean Git HEAD, committed SHA,
host-executed tests, sealed evidence, independent final QC, Workflow
allow/ask/deny for publisher actions, and **GitHub-confirmed MERGED**
before marking the full DAG integrated. No forced push, admin merge,
auto-removal or unsafe reset is added.

Unique DAG/Worktree paths reduce collisions but are **not** cross-process
locks. Multiple concurrent PI WEB control planes against the same Git
repository remain unsupported. Similarly, no provider-authenticated
real Pi/PI WEB/GitHub E2E has been completed; unit/mocked-host tests and
disposable real Git cannot prove production readiness. OS-level Pi
sandboxing/credential isolation remains a separate security boundary.

## Tests and maintenance notes

- `tests/workspace-discovery.test.mjs`: matching/mismatching host
  Workspace ID, Git metadata, path, and no unauthorized fallback.
- `tests/autopilot-server.test.mjs`: explicit Start-only creation;
  separate Task/final identities; old Git receipt recovery after host
  refusal; mocked original→final Pi sessions and GitHub auto-merge
  pending until exact `MERGED`.
- `tests/worktree-provisioner.test.mjs`: real/Mock Git reservation,
  worktree path/ref/HEAD checks and no duplicate mutation.
- Keep the inspected PI WEB version and derivation checks under review;
  if server-plugin `workspaces.list` is published, remove the hash
  dependency and match current host-listed `Workspace.path` directly.
