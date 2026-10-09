/** PI WEB workspace panel. v0.1 is a control-state simulator, not yet a Pi runtime. */
import { createLiveRunPanel } from "./fleet.js";
import type { PiWebPlugin, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { WorkflowAction, WorkflowDefinition, WorkflowInstance, TaskState, Role } from "../core/workflow.js";

const DEMO: WorkflowDefinition = {
  id: "demo-auth", title: "Auth migration — workflow preview", maxQcRounds: 5,
  maxParallelByRole: { planner: 1, implementer: 2, reviewer: 2, architect: 2 },
  tasks: [
    { id: "contract", title: "Define contract", kind: "implementation", role: "implementer", dependsOn: [] },
    { id: "api", title: "Implement API", kind: "implementation", role: "implementer", dependsOn: [{ taskId: "contract", gate: "qc_passed" }] },
    { id: "ui", title: "Implement UI", kind: "implementation", role: "implementer", dependsOn: [{ taskId: "contract", gate: "qc_passed" }] },
    { id: "integration", title: "Integration tests", kind: "implementation", role: "implementer", dependsOn: [{ taskId: "api", gate: "qc_passed" }, { taskId: "ui", gate: "qc_passed" }] },
  ],
};
type View = "cockpit" | "dag" | "kanban" | "journal";
type Detail = "compact" | "expanded";
type InterventionMode = "workflow" | "implementer" | "qc";
interface State {
  workflows: WorkflowInstance[];
  selected?: WorkflowInstance;
  status: string;
  busy: boolean;
  loaded: boolean;
  view: View;
  detailByRole: Record<Role, Detail>;
  selectedTaskId?: string;
  interventionMode: InterventionMode;
  interventionDraft: string;
}
const roleNames: Role[] = ["planner", "implementer", "reviewer", "architect"];
const states = new Map<string, State>();
const keyFor = (context: WorkspacePanelContext) => JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
function stateFor(context: WorkspacePanelContext): State {
  const key = keyFor(context);
  let state = states.get(key);
  if (!state) {
    state = { workflows: [], status: "Load workflows to begin.", busy: false, loaded: false, view: "cockpit",
      detailByRole: { planner: "expanded", implementer: "compact", reviewer: "expanded", architect: "expanded" },
      interventionMode: "workflow",
      interventionDraft: "After the next QC, ask Astra and Claude Opus to independently investigate the root cause and alternatives; let Sol synthesize before Luna resumes." };
    states.set(key, state);
  }
  return state;
}
const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "pi-micromanager",
  activate({ html, lifetimeSignal }) {
    let disposed = false;
    async function send(context: WorkspacePanelContext, operation: string, input: unknown): Promise<unknown> {
      if (!context.peer?.request) throw new Error("Enable the pi-micromanager server plugin in PI WEB settings");
      return context.peer.request(operation, input as never);
    }
    async function refresh(context: WorkspacePanelContext, workflowId?: string) {
      const state = stateFor(context);
      if (state.busy) return;
      state.busy = true;
      context.host.requestRender();
      try {
        const result = await send(context, "list", null);
        if (!Array.isArray(result)) throw new Error("Invalid workflow list");
        state.workflows = result as WorkflowInstance[];
        const id = workflowId ?? state.selected?.definition.id ?? state.workflows[0]?.definition.id;
        if (id) {
          if (state.selected?.definition.id !== id) delete state.selectedTaskId;
          state.selected = await send(context, "get", id) as WorkflowInstance;
        }
        if (state.selectedTaskId && !state.selected?.tasks[state.selectedTaskId]) delete state.selectedTaskId;
        state.loaded = true;
        state.status = `${state.workflows.length} saved workflow(s).`;
      } catch (error) { state.status = String(error); }
      finally { state.busy = false; if (!disposed) context.host.requestRender(); }
    }
    async function createDemo(context: WorkspacePanelContext) {
      const state = stateFor(context);
      if (state.busy) return;
      state.busy = true; context.host.requestRender();
      try {
        const created = await send(context, "create", DEMO) as WorkflowInstance;
        state.status = "Demo stored in scoped SQLite. No Pi agents have been launched.";
        state.selected = created;
        delete state.selectedTaskId;
      } catch (error) { state.status = String(error); }
      finally { state.busy = false; if (!disposed) { context.host.requestRender(); void refresh(context, "demo-auth"); } }
    }
    async function change(context: WorkspacePanelContext, action: WorkflowAction) {
      const state = stateFor(context);
      const workflow = state.selected;
      if (state.busy || !workflow) return;
      state.busy = true; context.host.requestRender();
      try {
        const next = await send(context, "act", { workflowId: workflow.definition.id, expectedRevision: workflow.revision,
          commandId: crypto.randomUUID(), action }) as WorkflowInstance;
        state.selected = next;
        state.workflows = state.workflows.map(x => x.definition.id === next.definition.id ? next : x);
        state.status = `Applied ${action.type} as revision ${next.revision} (simulation only).`;
      } catch (error) { state.status = String(error); }
      finally { state.busy = false; if (!disposed) context.host.requestRender(); }
    }

    function selectTask(context: WorkspacePanelContext, taskId: string) {
      const state = stateFor(context);
      state.selectedTaskId = taskId;
      state.interventionMode = "workflow";
      context.host.requestRender();
    }
    function taskLens(context: WorkspacePanelContext, w: WorkflowInstance) {
      const state = stateFor(context);
      const task = state.selectedTaskId ? w.tasks[state.selectedTaskId] : undefined;
      if (!task) return html`<section class="mm-lens" aria-label="Task Lens">
        <strong>Task Lens</strong>
        <p>Choose a task in Cockpit, DAG, or Kanban. Its identity is attached automatically.</p>
      </section>`;
      const pending = w.amendments.find(a => a.targetTaskId === task.spec.id &&
        ["planning", "armed", "activated"].includes(a.status));
      const canHold = task.spec.kind === "implementation" &&
        ["ready", "running", "awaiting_qc"].includes(task.status) && !pending;
      return html`<section class="mm-lens" aria-label="Task Lens">
        <div class="mm-lens-head"><div><strong>Task Lens · ${task.spec.title}</strong>
          <p>Target: ${w.definition.id} / ${task.spec.id} · ${task.status} · QC ${task.qcRounds}/${w.definition.maxQcRounds}</p>
        </div><button @click=${() => { delete state.selectedTaskId; context.host.requestRender(); }}>Close</button></div>
        <div class="mm-modes" role="group" aria-label="Intervention target">
          ${(["workflow", "implementer", "qc"] as const).map(mode => html`<button
            class=${state.interventionMode === mode ? "selected" : ""}
            aria-pressed=${state.interventionMode === mode}
            @click=${() => { state.interventionMode = mode; context.host.requestRender(); }}>
            ${mode === "workflow" ? "Change workflow (Sol)" : mode === "implementer" ? "Steer implementer" : "Steer QC"}
          </button>`)}
        </div>
        ${state.interventionMode === "workflow" ? html`<div class="mm-lens-content">
          <p>Reserve the next post-QC transition now. Sol prepares a typed plan; only the engine can apply its DAG changes.
            Other tasks are unaffected.</p>
          <label for="mm-intervention-text">Instruction to Sol (task target is automatic)</label>
          <textarea id="mm-intervention-text" rows="3" maxlength="4000" .value=${state.interventionDraft}
            ?disabled=${state.busy || !!pending}
            @input=${(e: Event) => { state.interventionDraft = (e.target as HTMLTextAreaElement).value; context.host.requestRender(); }}></textarea>
          <div class="mm-actions">
            <button ?disabled=${state.busy || !canHold || !state.interventionDraft.trim()}
              @click=${() => { void change(context, {
                type: "request_intervention",
                interventionId: "human-" + crypto.randomUUID().replace(/-/g, "").slice(0, 18),
                targetTaskId: task.spec.id, afterQcRunId: "next",
                instruction: state.interventionDraft.trim(),
              }); }}>Reserve next QC barrier</button>
            ${pending && (pending.status === "planning" || pending.status === "armed") ? html`<button
              ?disabled=${state.busy}
              @click=${() => { void change(context, { type: "cancel_amendment", amendmentId: pending.id }); }}>
              Cancel pending intervention</button>` : null}
            ${pending?.status === "planning" ? html`<button ?disabled=${state.busy}
              @click=${() => { void change(context, {
                type: "plan_intervention", interventionId: pending.id,
                rationale: "SIMULATION ONLY: independent root-cause and alternative analysis",
                agents: [
                  { id: "astra", title: "Root cause investigation", role: "architect", model: "configured-astra-model" },
                  { id: "opus", title: "Alternative design investigation", role: "architect", model: "configured-opus-model" },
                ],
              }); }}>Simulate Sol plan (Astra + Opus)</button>` : null}
          </div>
          ${pending ? html`<div class="mm-intervention-state" role="status">
            <strong>Intervention ${pending.id}: ${pending.status}</strong>
            <p>${pending.instruction ?? "Typed diagnostic plan"} · after QC: ${pending.afterQcRunId}</p>
            ${pending.status === "planning" ? html`<p>Barrier is durable. Sol planner connection is NOT implemented;
              this task will remain held if QC finishes before planning.</p>` : null}
            ${pending.planRationale ? html`<p>Plan: ${pending.planRationale}</p>` : null}
          </div>` : null}
        </div>` : html`<div class="mm-lens-content">
          <p>Direct ${state.interventionMode === "qc" ? "QC" : "implementer"} steer will target
            the Pi Session bound to task ${task.spec.id} without routing through Sol.</p>
          <p role="status">Unavailable in this simulator: real Pi Session bindings and native steer
            are not connected. No message is sent.</p>
          <button disabled>Send directly (requires Pi bridge)</button>
        </div>`}
      </section>`;
    }
    const actionsFor = (context: WorkspacePanelContext, t: TaskState, w: WorkflowInstance) => {
      const act = (action: WorkflowAction) => { void change(context, action); };
      const buttons = [];
      if (t.status === "ready") buttons.push(html`<button @click=${() => act({ type: "start", taskId: t.spec.id })}>Simulate start</button>`);
      if (t.status === "running") buttons.push(t.spec.kind === "implementation"
        ? html`<button @click=${() => act({ type: "implementation_finished", taskId: t.spec.id,
            headSha: `simulation-${t.attempts}`, criteriaRevision: 0, testsPassed: true })}>Simulate tests pass</button>`
        : html`<button @click=${() => act({ type: "complete", taskId: t.spec.id })}>Simulate complete</button>`);
      if (t.status === "awaiting_qc") {
        for (const verdict of ["pass", "fail"] as const) buttons.push(html`<button @click=${() => act({ type: "qc_finalized", taskId: t.spec.id,
          runId: `qc-${t.spec.id}-${t.qcRounds + 1}`, headSha: t.pendingWork?.headSha ?? "", criteriaRevision: t.pendingWork?.criteriaRevision ?? 0,
          attempt: t.pendingWork?.attempt ?? 0, verdict })}>Simulate QC ${verdict}</button>`);
      }
      if (t.status === "held") for (const a of w.amendments.filter(a => a.targetTaskId === t.spec.id && a.status === "activated" && a.synthesisTaskId && w.tasks[a.synthesisTaskId]?.status === "done")) {
        buttons.push(html`<button @click=${() => act({ type: "resume_after_diagnosis", amendmentId: a.id, decision: "rework" })}>Resume implementation</button>`);
      }
      if (t.status === "passed") buttons.push(html`<button @click=${() => act({ type: "integrate", taskId: t.spec.id })}>Simulate integration</button>`);
      return buttons;
    };
    const layout = (w: WorkflowInstance) => {
      const depths = new Map<string, number>();
      const depth = (id: string): number => {
        if (depths.has(id)) return depths.get(id)!;
        const task = w.tasks[id]; if (!task) return 0;
        const n = task.spec.dependsOn.length ? 1 + Math.max(...task.spec.dependsOn.map(d => depth(d.taskId))) : 0;
        depths.set(id, n); return n;
      };
      for (const id of Object.keys(w.tasks)) depth(id);
      const byLevel = new Map<number, string[]>();
      for (const [id, d] of depths) byLevel.set(d, [...byLevel.get(d) ?? [], id]);
      const coords = new Map<string, { x: number; y: number }>();
      for (const [d, ids] of byLevel) ids.forEach((id, i) => coords.set(id, { x: 18 + d * 205, y: 18 + i * 86 }));
      return { coords, width: 235 + Math.max(...depths.values()) * 205, height: 36 + Math.max(...[...byLevel.values()].map(a => a.length)) * 86 };
    };
    return {
      contributions: {
        workspacePanels: [{
          id: "micromanager", title: "Micromanager", order: 50,
          render(context) {
            const state = stateFor(context);
            const w = state.selected;
            const tasks = w ? Object.values(w.tasks) : [];
            return html`<style>${styles}</style><section class="mm">
              <header><h2>pi-micromanager</h2><p>See everything. Hear everything. Steer anything. Welcome to Cognitive Overload!</p></header>
              <aside role="note">v0.1 foundation: workflow simulation only. No Pi Agent processes are launched or controlled yet.</aside>
              <div class="toolbar">
                <button ?disabled=${state.busy} @click=${() => { void refresh(context); }}>Reload</button>
                <button ?disabled=${state.busy} @click=${() => { void createDemo(context); }}>Create/load demo DAG</button>
                <select aria-label="Workflow" @change=${(e: Event) => { const target = e.target as HTMLSelectElement; void refresh(context, target.value); }}>
                  ${state.workflows.map(x => html`<option value=${x.definition.id} ?selected=${x.definition.id === w?.definition.id}>${x.definition.title}</option>`)}
                </select>
              </div>
              <p role="status" aria-live="polite">${state.status}</p>
              <nav aria-label="Views">${(["cockpit", "dag", "kanban", "journal"] as const).map(view => html`
                <button class=${state.view === view ? "selected" : ""} @click=${() => { state.view = view; context.host.requestRender(); }}>${view.toUpperCase()}</button>
              `)}</nav>
              ${!w ? html`<p>Create a demo DAG or load a saved workflow.</p>` : html`
                <p>Workflow ${w.definition.id} · revision ${w.revision} · QC max ${w.definition.maxQcRounds}</p>
                ${taskLens(context, w)}
                ${state.view === "cockpit" ? html`
                  <div class="mm-toggles">${roleNames.map(role => html`<label>${role}<select .value=${state.detailByRole[role]}
                     @change=${(e: Event) => { state.detailByRole[role] = (e.target as HTMLSelectElement).value as Detail; context.host.requestRender(); }}>
                    <option value="compact">Compact</option><option value="expanded">Expanded</option></select></label>`)}</div>
                  <div class="mm-grid">${tasks.map(t => html`<article class="mm-card ${state.selectedTaskId === t.spec.id ? "mm-task-selected" : ""}"><h3>${t.spec.title}</h3><small>${t.spec.role} · ${t.status} · attempt ${t.attempts}</small>
                     <button class="mm-intervene" @click=${() => selectTask(context, t.spec.id)}>Intervene in this task</button>
                    ${state.detailByRole[t.spec.role] === "expanded" ? html`<p>Task ${t.spec.id}. Depends on ${t.spec.dependsOn.map(d => `${d.taskId}(${d.gate})`).join(", ") || "nothing"}. QC ${t.qcRounds}/${w.definition.maxQcRounds}.</p>
                    <div class="mm-actions">${actionsFor(context, t, w)}</div>` : null}
                  </article>`)}</div>` : null}
                ${state.view === "dag" ? (() => { const graph = layout(w); return html`<div class="mm-scroll"><svg width=${graph.width} height=${graph.height} viewBox=${`0 0 ${graph.width} ${graph.height}`} role="img" aria-label="Workflow DAG">
                  ${tasks.flatMap(t => t.spec.dependsOn.map(d => { const from = graph.coords.get(d.taskId)!; const to = graph.coords.get(t.spec.id)!; return html`<line x1=${from.x+170} y1=${from.y+28} x2=${to.x} y2=${to.y+28} stroke="currentColor" stroke-opacity=".45" stroke-width="1.6" />`; }))}
                  ${tasks.map(t => { const p = graph.coords.get(t.spec.id)!; return html`<g role="button" tabindex="0" aria-label=${"Intervene in " + t.spec.title} @click=${() => selectTask(context,t.spec.id)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTask(context,t.spec.id); } }}><rect x=${p.x} y=${p.y} rx="8" width="170" height="55" fill="var(--pi-surface)" stroke="var(--pi-border-muted)" /><text x=${p.x+9} y=${p.y+21} fill="currentColor" font-size="11">${t.spec.title.slice(0,23)}</text><text x=${p.x+9} y=${p.y+39} fill="var(--pi-muted)" font-size="10">${t.status}</text></g>`; })}
                </svg></div>`; })() : null}
                ${state.view === "kanban" ? html`<div class="mm-kanban">${(["blocked", "ready", "running", "awaiting_qc", "held", "passed", "done", "integrated", "needs_human"] as const).map(status => html`
                  <section><strong>${status}</strong>${tasks.filter(t=>t.status===status).map(t=>html`<button class="mm-pill" @click=${() => selectTask(context,t.spec.id)}>${t.spec.title}</button>`)}</section>`)}</div>` : null}
                ${state.view === "journal" ? html`<div class="mm-events">${[...w.events].reverse().map(e=>html`<article><time>${e.at}</time><p><strong>${e.type}</strong> · ${e.message}</p></article>`)}</div>` : null}
              `}
            </section>`;
          },
        }, createLiveRunPanel(html, lifetimeSignal)],
      },
      dispose() { disposed = true; states.clear(); },
    };
  },
};
const styles = `
  .mm { padding: 16px; color: inherit; line-height: 1.5; min-width: 0; }
  .mm h2 { margin: 0; font-size: 18px; }
  .mm header p { margin: 2px 0 16px; font-size: 12px; color: var(--pi-muted); }
  .mm aside { border: 1px solid var(--pi-warning-border); background: var(--pi-warning-surface); padding: 9px; border-radius: 8px; font-size: 12px; }
  .mm button, .mm select { font: inherit; padding: 5px 8px; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-surface); color: inherit; }
  .mm button:hover:not(:disabled) { background: var(--pi-surface-hover); cursor: pointer; }
  .mm button:disabled { opacity: .4; }
  .mm nav { display:flex; flex-wrap:wrap; gap: 6px; margin:12px 0; }
  .mm nav .selected { border-color: var(--pi-accent-border); color: var(--pi-accent); }
  .mm .toolbar { display:flex; flex-wrap:wrap; gap: 8px; margin-top: 12px; }
  .mm .mm-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; }
  .mm-card { border:1px solid var(--pi-border-muted); border-radius:10px; padding: 10px; min-width:0; }
  .mm-card h3 { margin:0; font-size:13px; }
  .mm-card small, .mm time { color: var(--pi-muted); }
  .mm-card p { font-size:12px; overflow-wrap:anywhere; }
  .mm-actions {display:flex;flex-wrap:wrap;gap:6px;}
  .mm-toggles {display:flex; flex-wrap:wrap;gap:12px; margin:12px 0;font-size:12px;}
  .mm-toggles label {display:flex;gap:5px;align-items:center;}
  .mm-scroll {max-width:100%;overflow:auto;}
  .mm-kanban {display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px;}
  .mm-kanban section {border:1px solid var(--pi-border-muted);padding:8px;border-radius:8px;min-height:76px;}
  .mm-pill {background:var(--pi-surface);border-radius:6px;padding:6px;margin-top:7px;font-size:12px;}
  .mm-events article {border-bottom:1px solid var(--pi-border-muted);padding:7px 0;font-size:12px;}
  .mm-events p {margin:0;}
  .mm-task-selected { outline: 2px solid var(--pi-accent-border); }
  .mm-intervene { font-size: 11px !important; margin-top: 6px; }
  .mm-lens { border: 1px solid var(--pi-accent-border); border-radius: 9px; padding: 12px; margin: 12px 0; background: var(--pi-surface); }
  .mm-lens-head { display:flex; justify-content:space-between; align-items:start; gap:8px; }
  .mm-lens-head p,.mm-lens-content p { margin:5px 0 9px; font-size:12px; color:var(--pi-muted); }
  .mm-modes { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; }
  .mm-modes .selected { border-color:var(--pi-accent-border); color:var(--pi-accent); }
  .mm-lens-content label { display:block; font-size:12px; margin:9px 0 4px; }
  .mm-lens-content textarea { font:inherit; box-sizing:border-box; width:100%; min-height:70px; resize:vertical; padding:8px; background:var(--pi-surface); color:inherit; border:1px solid var(--pi-border-muted); border-radius:6px; }
  .mm-lens-content textarea:disabled { opacity:.55; }
  .mm-intervention-state { margin-top:12px; padding:10px; border:1px solid var(--pi-border-muted); border-radius:6px; }
  .mm-kanban .mm-pill { display:block; width:100%; text-align:left; cursor:pointer; }
  .mm-scroll svg g[role="button"] { cursor:pointer; }
  .mm-scroll svg g[role="button"]:focus-visible { outline:2px solid var(--pi-accent); }

`;
export default plugin;
