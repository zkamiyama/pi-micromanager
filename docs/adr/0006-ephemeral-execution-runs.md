# ADR-0006: Ephemeral execution runs, dynamic grid, evidence-gated retirement

- Status: Accepted (runtime foundation implemented; unattended dispatch and GC pending)
- Date: 2026-10-09
- Related: ADR-0001, ADR-0002, ADR-0005
- Supersedes: The prototype assumption of one reusable Agent seat per Task and role

## Context

Multi-Agent-Shogun's fixed tmux pane layout is a useful **view**, not a runtime
requirement. Reusing the same Pi Session for successive Luna implementation and
QC rounds would mix contexts, encourage confirmation bias and make it hard to
audit which exact revision was examined. The user wants to watch any number
of concurrent Agents, not to maintain a permanently allocated "Luna #1" roster.

## Decision

**Tasks and workflows are durable; execution Runs are one-shot.**

Each implementation attempt, independent QC, diagnosis, synthesis, or planner
operation normally spawns a **new Pi Session**. Reuse of a model or role is not
reuse of its previous session context.

Typical timeline:

    Task auth-api
      Implementation Attempt 1  -> Pi Session A (Luna)
      QC Run 1                  -> Pi Session B (Sol xhigh)
      Implementation Attempt 2 -> Pi Session C (Luna, fresh context)
      QC Run 2                  -> Pi Session D (Sol xhigh)
      Parallel diagnostics     -> Pi Sessions E and F (Astra and Opus)
      Synthesis                -> Pi Session G (Sol)
      Implementation Attempt 3 -> Pi Session H (Luna)

The definitive task graph and evidence live in the Workflow DB, not in the
memory of Pi Session A/B/C or one persistent orchestrator conversation.

## Identity / scope

A Run is identified by project + orchestraWorkspaceId + workflowId + runId.
A runId is immutable within a workflow. Examples: impl-auth-api-2,
qc-auth-api-2, and task-diag-escalation-astra-1.

The orchestration Workspace owns the Workflow Instance. A worker's Pi Session
may run in a **different** workspace/worktree. PI WEB's public workspaces
capability re-resolves the target workspace before any session creation.

Never key execution identity solely by Task and role; both repeat.

## Lifecycle

    admitted Task gate
      -> reserve unique Run (durable, idempotent command ID)
      -> create Pi Session
      -> companion handshake; verify provider, exact model and effort
      -> run work
      -> Pi agent_settled event: Run moves from Live Runs to History
      -> validate/persist output, QC result and evidence
      -> seal the Run
      -> archive native Pi Session; eventually GC safe worktree and logs

The agent_settled event indicates Pi has finished its turn. It does NOT by
itself certify a QC PASS, authorize the next DAG stage, guarantee a Git commit
has been saved or mean Pi JSONL can already be deleted.

Sealing requires a durable evidence reference. The alpha records the
reference but does not yet verify an external artifact's bytes or perform
destructive cleanup.

Unknown Pi Session creation or message delivery is treated as uncertain.
Never blindly spawn again with the same runId if the prior creation result
was lost.

## UX

- Cockpit/Live Runs shows **active or pending execution instances** only.
- Upon settlement, a Run leaves the active grid and is accessible in History
  and the future source-linked Live Journal.
- Finished Runs do not have a direct-steer input. To rework the same Task,
  launch a fresh Pi Session with a new runId.
- Task Lens targets the durable Task. Direct steer resolves the *currently
  selected active Run*, never a stale display-name or the previous Luna.
- Per-role compact/expanded presentation preferences do not constrain or
  reserve Agent Sessions.
- Multiple Luna implementation runs may execute concurrently only when
  writeable worktree ownership is distinct. A sequential new writer may reuse
  the same Task worktree only after its predecessor has settled, evidence is
  sealed and any QC snapshot is consistent.

## Initial implementation

- Replaces Task+seat primary keys with immutable per-Run keys.
- Separates owner Orchestra Workspace from actual Pi Session Workspace.
- Introduces public target-workspace validation before creating sessions.
- Prevents a second simultaneous modifying Run on the same worktree.
- Provides a dynamic Live Runs / finished History PI WEB panel.
- Registers a Pi companion extension and implements correlated receipts and
  bounded public activity records; past transcripts remain in Pi, not duplicated
  in MAMC's database.

This PR does **not** yet deliver an unattended DAG dispatcher, automatic
worktree creation/retirement, end-to-end real-provider integration proof,
or Pi Session archive/delete. The manual one-shot launch surface is
experimental, while the prior DAG/Cockpit example is still marked simulation.

## Review triggers

Re-evaluate if PI WEB gains a stable public per-Run lifecycle API, native
workspace orchestration, model-configuration admission or GC protections.
Prefer upstream capabilities over maintaining a long-lived PI WEB fork.
