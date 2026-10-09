/** PI WEB workspace panel. v0.1 is a control-state simulator, not yet a Pi runtime. */
import { createLiveRunPanel, selectOrchestraTask } from "./fleet.js";
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
  autopilotDraft: string;
  autopilotStatus: string;
  autopilotEnabled: boolean;
  autopilotConfigured: boolean;
  autopilotConfigFor?:string;
  workflowDraft:string;
  integrationTargetWorkspaceId:string;
  integrationStatus:string;
  integrationPreview?:{
    id:string;workflowId:string;taskId:string;targetWorkspaceId:string;
    sourceSha:string;targetHead:string;qcRunId:string;expiresAt:number;
  };
  goalText:string;goalProvider:string;goalModel:string;goalEffort:string;
  goalStatus:string;goalProposalText:string;goalProposalReady:boolean;
  goalRef?:{draftWorkflowId:string;runId:string};
}
const roleNames: Role[] = ["planner", "implementer", "reviewer", "architect"];
const states = new Map<string, State>();
const keyFor = (context: WorkspacePanelContext) => JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
function stateFor(context: WorkspacePanelContext): State {
  const key = keyFor(context);
  let state = states.get(key);
  if (!state) {
    let goalRef:State["goalRef"];
    try{
      const raw=typeof localStorage==="undefined"?null:
        localStorage.getItem("pi-micromanager:goal-ref:"+key);
      const value:unknown=raw?JSON.parse(raw):null;
      if(value&&typeof value==="object"&&!Array.isArray(value)&&
        "draftWorkflowId" in value&&typeof value.draftWorkflowId==="string"&&
        "runId" in value&&typeof value.runId==="string")
        goalRef={draftWorkflowId:value.draftWorkflowId,runId:value.runId};
    }catch{/* Browser storage may be blocked. */}
    state = { workflows: [], status: "Load workflows to begin.", busy: false, loaded: false, view: "cockpit",
      detailByRole: { planner: "expanded", implementer: "compact", reviewer: "expanded", architect: "expanded" },
      autopilotDraft:JSON.stringify({
        workspaces:{},
        models:{
          implementer:{provider:"",model:""},qc:{provider:"",model:""},
          planner:{provider:"",model:""},architect:{provider:"",model:""},
        },test:{file:"npm",args:["test"],timeoutMs:60000},maxAttempts:5,
      },null,2),
      autopilotStatus:"Not configured",autopilotEnabled:false,autopilotConfigured:false,
      goalText:"",goalProvider:"",goalModel:"",goalEffort:"",
      goalStatus:goalRef?"A prior goal proposal can be checked":"No proposal in progress",
      goalProposalText:"",goalProposalReady:false,
      ...(goalRef?{goalRef}:{}),
      integrationTargetWorkspaceId:"",integrationStatus:"",
      workflowDraft:JSON.stringify({
        id:"custom-feature",title:"Custom development workflow",maxQcRounds:5,
        maxParallelByRole:{planner:1,implementer:2,reviewer:2,architect:2},
        tasks:[{id:"feature",title:"REPLACE: specific development Task",
          description:"REPLACE: state the exact repository change required",
          acceptanceCriteria:["REPLACE: define an independently testable acceptance condition"],
          kind:"implementation",role:"implementer",dependsOn:[]}],
      },null,2),
      interventionMode: "workflow",
      interventionDraft: "After the next QC, ask Astra and Claude Opus to independently investigate the root cause and alternatives; let Sol synthesize before Luna resumes." };
    states.set(key, state);
  }
  return state;
}
const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "pi-micromanager",
  activate({ html, lifetimeSignal, runtimePluginId }) {
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
          try{
            const auto=await send(context,"auto.status",{workflowId:id}) as
              {enabled:boolean;status:string;config:unknown}|null;
            state.autopilotEnabled=auto?.enabled??false;
            state.autopilotConfigured=!!auto;
            state.autopilotStatus=auto?.status??"Not configured";
            if(auto&&state.autopilotConfigFor!==id){
              state.autopilotDraft=JSON.stringify(auto.config,null,2);
              state.autopilotConfigFor=id;
            }
          }catch(error){state.autopilotStatus="Autopilot unavailable: "+String(error);}
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

    function saveGoalRef(context:WorkspacePanelContext,ref:State["goalRef"]):void{
      try{
        if(typeof localStorage==="undefined")return;
        const key="pi-micromanager:goal-ref:"+keyFor(context);
        if(ref)localStorage.setItem(key,JSON.stringify(ref));
        else localStorage.removeItem(key);
      }catch{/* Reference persistence is optional, not an execution authority. */}
    }
    async function proposeGoal(context:WorkspacePanelContext){
      const state=stateFor(context);
      if(state.busy||!state.goalText.trim()||!state.goalProvider.trim()||
        !state.goalModel.trim())return;
      state.busy=true;state.goalStatus="Starting a fresh read-only Sol proposal…";
      context.host.requestRender();
      try{
        const result=await send(context,"auto.propose",{
          goal:state.goalText,provider:state.goalProvider,model:state.goalModel,
          ...(state.goalEffort.trim()?{effort:state.goalEffort.trim()}:{}),
        }) as {draftWorkflowId:string;runId:string;status:string};
        const ref={draftWorkflowId:result.draftWorkflowId,runId:result.runId};
        state.goalRef=ref;saveGoalRef(context,ref);
        state.goalProposalText="";state.goalProposalReady=false;state.goalStatus=result.status;
      }catch(error){state.goalStatus="Goal planning failed: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function checkGoal(context:WorkspacePanelContext){
      const state=stateFor(context),ref=state.goalRef;
      if(state.busy||!ref)return;
      state.busy=true;context.host.requestRender();
      try{
        const result=await send(context,"auto.proposal",ref) as
          {phase:string;proposal:WorkflowDefinition|null;summary:string|null;canAccept:boolean;notice?:string};
        if(result.proposal){
          state.goalProposalText=JSON.stringify(result.proposal,null,2);
          state.goalProposalReady=result.canAccept;
          state.goalStatus=(result.canAccept?"Review before approval: ":
            "Sol submitted a proposal; wait for Run settlement: ")+
            (result.summary??"Validated Task DAG");
        }else state.goalStatus=result.notice??("Proposal phase: "+result.phase+
          ". Wait for the real Pi Session to finish, then check again.");
      }catch(error){state.goalStatus="Cannot read proposal: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function acceptGoal(context:WorkspacePanelContext){
      const state=stateFor(context),ref=state.goalRef;
      if(state.busy||!ref||!state.goalProposalText||!state.goalProposalReady)return;
      state.busy=true;context.host.requestRender();
      try{
        const created=await send(context,"auto.acceptProposal",ref) as WorkflowInstance;
        state.selected=created;
        delete state.selectedTaskId;
        state.workflowDraft=JSON.stringify(created.definition,null,2);
        state.autopilotEnabled=false;state.autopilotConfigured=false;
        delete state.autopilotConfigFor;
        state.goalStatus="Approved "+created.definition.id+
          ". Configure exact models, tests and linked worktrees before starting Autopilot.";
        delete state.goalRef;state.goalProposalReady=false;saveGoalRef(context,undefined);
        state.workflows=state.workflows.filter(x=>x.definition.id!==created.definition.id).concat(created);
      }catch(error){state.goalStatus="Proposal acceptance failed: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function importWorkflow(context:WorkspacePanelContext){
      const state=stateFor(context);
      if(state.busy)return;
      state.busy=true;context.host.requestRender();
      try{
        const created=await send(context,"create",JSON.parse(state.workflowDraft)) as WorkflowInstance;
        state.selected=created;
        delete state.selectedTaskId;
        state.status="Workflow saved with validated DAG; no Pi Runs launched.";
        state.autopilotConfigured=false;state.autopilotEnabled=false;
        delete state.autopilotConfigFor;
      }catch(error){state.status="Workflow import failed: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
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
        state.status = "Applied "+action.type+" as revision "+next.revision+
          (state.autopilotConfigured?" (explicit human decision)":" (simulation only)");
      } catch (error) { state.status = String(error); }
      finally { state.busy = false; if (!disposed) context.host.requestRender(); }
    }


    async function autopilotCommand(context:WorkspacePanelContext,operation:"configure"|"start"|"pause"){
      const state=stateFor(context),workflowId=state.selected?.definition.id;
      if(!workflowId||state.busy)return;
      state.busy=true;state.autopilotStatus="Processing "+operation+"…";context.host.requestRender();
      try{
        const result=await send(context,"auto."+operation,{
          workflowId,...(operation==="configure"?{config:JSON.parse(state.autopilotDraft)}:{}),
        }) as {enabled:boolean;status:string};
        state.autopilotEnabled=result.enabled;state.autopilotStatus=result.status;
        if(operation==="configure"){
          state.autopilotConfigured=true;
          state.autopilotConfigFor=workflowId;
        }
      }catch(error){state.autopilotStatus=String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function integrationCommand(context:WorkspacePanelContext,taskId:string,
      action:"preview"|"confirm"){
      const state=stateFor(context),workflow=state.selected;
      if(!workflow||state.busy)return;
      state.busy=true;context.host.requestRender();
      try{
        if(action==="preview"){
          delete state.integrationPreview;
          const proof=await send(context,"auto.integration.preview",{
            workflowId:workflow.definition.id,taskId,
            targetWorkspaceId:state.integrationTargetWorkspaceId.trim(),
          }) as NonNullable<State["integrationPreview"]>;
          if(proof.workflowId!==workflow.definition.id||proof.taskId!==taskId)
            throw new Error("Unexpected integration proof scope");
          state.integrationPreview=proof;
          state.integrationStatus="Read-only Git ancestry confirmed. Review both SHAs before finalizing.";
        }else{
          const proof=state.integrationPreview;
          if(!proof||proof.taskId!==taskId||proof.workflowId!==workflow.definition.id)
            throw new Error("Preview the exact Task and Git target first");
          const next=await send(context,"auto.integration.confirm",{
            previewId:proof.id,
          }) as WorkflowInstance;
          state.selected=next;
          state.workflows=state.workflows.map(w=>
            w.definition.id===next.definition.id?next:w);
          state.integrationStatus="Git integration verified; Task advanced to integrated. "+
            "No merge, push or file change was performed by Micromanager.";
          delete state.integrationPreview;
        }
      }catch(error){state.integrationStatus="Integration refused: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    function selectTask(context: WorkspacePanelContext, taskId: string) {
      const state = stateFor(context);
      state.selectedTaskId = taskId;
      delete state.integrationPreview;state.integrationStatus="";
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
            ${pending?.status === "planning" && !state.autopilotConfigured ? html`<button ?disabled=${state.busy}
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
            ${pending.status === "planning" ? html`<p>Barrier is durable.
              ${state.autopilotEnabled?
                "Autopilot launches a fresh read-only Sol planning Run; QC remains held if it finishes first.":
                state.autopilotConfigured?
                  "Autopilot is paused. Start it to run Sol planning; the QC barrier remains armed.":
                  "The demo planner is simulation-only until real Autopilot is configured."}</p>` : null}
            ${pending.planRationale ? html`<p>Plan: ${pending.planRationale}</p>` : null}
          </div>` : null}
        </div>` : html`<div class="mm-lens-content">
          <p>Direct ${state.interventionMode === "qc" ? "QC" : "implementer"} steer will target
            the Pi Session bound to task ${task.spec.id} without routing through Sol.</p>
          <p>The Orchestra panel resolves the current one-shot Run in this Task and
            opens its direct Pi Session composer. This workflow preview never pretends to send a command.</p>
          <button ?disabled=${state.busy} @click=${() => {
            selectOrchestraTask(context,w.definition.id,task.spec.id,
              state.interventionMode === "qc" ? "qc" : "implementer");
            void context.navigate({
              machineId:context.machine.id,
              projectId:context.workspace.projectId,
              workspaceId:context.workspace.id,
              view:"workspace",
              tool:runtimePluginId+":live-runs",
            }).catch(error=>{state.status="Cannot open Orchestra: "+String(error);context.host.requestRender();});
          }}>Open Task's live Run in Orchestra</button>
        </div>`}

        ${task.spec.kind==="implementation"&&task.status==="passed"&&state.autopilotConfigured?
          html`<div class="mm-integration" aria-label="Verify external Git integration">
            <strong>Verify completed Git integration</strong>
            <p>This verification is read-only. First integrate the QC-passed commit into
              another Git Worktree yourself, then select its PI WEB workspace ID.
              Preview checks target HEAD, source ancestry and sealed QC evidence.</p>
            <label>Target workspace ID
              <input maxlength="128" .value=${state.integrationTargetWorkspaceId}
                placeholder="Existing integrated workspace ID"
                ?disabled=${state.busy}
                @input=${(e:Event)=>{
                  state.integrationTargetWorkspaceId=(e.target as HTMLInputElement).value;
                  delete state.integrationPreview;state.integrationStatus="";
                  context.host.requestRender();
                }}/></label>
            <button ?disabled=${state.busy||state.autopilotEnabled||
                !state.integrationTargetWorkspaceId.trim()}
              @click=${()=>void integrationCommand(context,task.spec.id,"preview")}>
              Preview verified Git state</button>
            ${state.integrationPreview?.taskId===task.spec.id?html`
              <div class="mm-integration-proof">
                <p>QC Run: ${state.integrationPreview.qcRunId}</p>
                <p>QC source: <code>${state.integrationPreview.sourceSha}</code></p>
                <p>Target HEAD: <code>${state.integrationPreview.targetHead}</code></p>
                <p>Target workspace: ${state.integrationPreview.targetWorkspaceId}</p>
                <p>Expires: ${new Date(state.integrationPreview.expiresAt).toLocaleTimeString()}</p>
                <button ?disabled=${state.busy||state.autopilotEnabled}
                  @click=${()=>void integrationCommand(context,task.spec.id,"confirm")}>
                  Confirm integration and unblock DAG</button>
              </div>`:null}
            ${state.integrationStatus?html`<p role="status">${state.integrationStatus}</p>`:null}
          </div>`:null}
      </section>`;
    }
    const actionsFor = (context: WorkspacePanelContext, t: TaskState, w: WorkflowInstance) => {
      const act = (action: WorkflowAction) => { void change(context, action); };
      const buttons = [];
      if(stateFor(context).autopilotConfigured){
        // Do not offer simulation transitions for a real automated Workflow.
        // The explicit human resume decision is still supported.
        if(t.status==="held")for(const a of w.amendments.filter(a=>a.targetTaskId===t.spec.id&&
          a.status==="activated"&&a.synthesisTaskId&&w.tasks[a.synthesisTaskId]?.status==="done")){
          buttons.push(html`<button @click=${()=>act({type:"resume_after_diagnosis",
            amendmentId:a.id,decision:"rework"})}>Approve rework</button>`);
          if(t.lastQc?.verdict==="pass")buttons.push(html`<button
            @click=${()=>act({type:"resume_after_diagnosis",amendmentId:a.id,
              decision:"accept_pass"})}>Accept QC pass</button>`);
        }
        return buttons;
      }
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
              <aside role="note">DAG/Cockpit demo buttons are simulation-only. Autopilot below is a separate opt-in, real Pi Session executor. No automatic merging or Worktree deletion.</aside>
              <div class="toolbar">
                <button ?disabled=${state.busy} @click=${() => { void refresh(context); }}>Reload</button>
                <button ?disabled=${state.busy} @click=${() => { void createDemo(context); }}>Create/load demo DAG</button>
                <select aria-label="Workflow" @change=${(e: Event) => { const target = e.target as HTMLSelectElement; void refresh(context, target.value); }}>
                  ${state.workflows.map(x => html`<option value=${x.definition.id} ?selected=${x.definition.id === w?.definition.id}>${x.definition.title}</option>`)}
                </select>
              </div>
              <p role="status" aria-live="polite">${state.status}</p>

              <details class="mm-goal-proposal">
                <summary><strong>Ask Sol to plan a new goal</strong> · read-only proposal</summary>
                <p>Sol creates a structured Task DAG through a real Pi Session. Nothing is
                  executed until you review/accept the proposal and separately start Autopilot.</p>
                <label for="mm-goal-text">Development goal</label>
                <textarea id="mm-goal-text" rows="4" maxlength="4000"
                  placeholder="Describe the feature, constraints and expected result…"
                  .value=${state.goalText} ?disabled=${state.busy}
                  @input=${(e:Event)=>{state.goalText=(e.target as HTMLTextAreaElement).value;
                    context.host.requestRender();}}></textarea>
                <div class="mm-goal-credentials">
                  <label>Pi provider <input maxlength="120" placeholder="Configured provider ID"
                    .value=${state.goalProvider} ?disabled=${state.busy}
                    @input=${(e:Event)=>{state.goalProvider=(e.target as HTMLInputElement).value;
                      context.host.requestRender();}} /></label>
                  <label>Model ID <input maxlength="160" placeholder="Exact model ID"
                    .value=${state.goalModel} ?disabled=${state.busy}
                    @input=${(e:Event)=>{state.goalModel=(e.target as HTMLInputElement).value;
                      context.host.requestRender();}} /></label>
                  <label>Effort (optional) <input maxlength="32" placeholder="Supported effort"
                    .value=${state.goalEffort} ?disabled=${state.busy}
                    @input=${(e:Event)=>{state.goalEffort=(e.target as HTMLInputElement).value;}} /></label>
                </div>
                <div class="mm-actions">
                  <button ?disabled=${state.busy||!state.goalText.trim()||
                    !state.goalProvider.trim()||!state.goalModel.trim()}
                    @click=${()=>void proposeGoal(context)}>Ask Sol (read-only)</button>
                  <button ?disabled=${state.busy||!state.goalRef}
                    @click=${()=>void checkGoal(context)}>Check proposal</button>
                </div>
                <p role="status" aria-live="polite">${state.goalStatus}</p>
                ${state.goalProposalText?html`
                  <label for="mm-goal-preview">Sol's proposed DAG (review before approval)</label>
                  <textarea id="mm-goal-preview" rows="12" readonly spellcheck="false"
                    .value=${state.goalProposalText}></textarea>
                  <div class="mm-actions">
                    <button ?disabled=${state.busy||!state.goalProposalReady} @click=${()=>void acceptGoal(context)}>
                      Approve and save exact proposal</button>
                    <button ?disabled=${state.busy} @click=${()=>{
                      state.workflowDraft=state.goalProposalText;
                      context.host.requestRender();
                    }}>Copy into editable Workflow import</button>
                  </div>`:null}
              </details>
              <details class="mm-workflow-import">
                <summary>Import a real Workflow DAG (JSON)</summary>
                <p>Author a Task DAG here or paste a definition. Server-side validation rejects
                  cycles and unsupported dependencies before saving any workflow.</p>
                <textarea rows="10" spellcheck="false" aria-label="Workflow definition JSON"
                  .value=${state.workflowDraft} ?disabled=${state.busy}
                  @input=${(e:Event)=>{state.workflowDraft=(e.target as HTMLTextAreaElement).value;}}></textarea>
                <button ?disabled=${state.busy} @click=${()=>void importWorkflow(context)}>
                  Validate and save Workflow</button>
              </details>
              <details class="mm-autopilot">
                <summary><strong>Autopilot · Real Orchestrator</strong>
                  <span>${state.autopilotEnabled?"● Running":"○ Paused / offline"}</span></summary>
                <p>Supply exact Pi models, existing linked Git Worktree workspace IDs per Task,
                  and a real test argv. Automated launches remain under deterministic DAG/QC gates.</p>
                <label for="mm-auto-config">Autopilot configuration (JSON)</label>
                <textarea id="mm-auto-config" rows="12" spellcheck="false"
                  .value=${state.autopilotDraft} ?disabled=${state.busy||state.autopilotEnabled}
                  @input=${(e:Event)=>{state.autopilotDraft=(e.target as HTMLTextAreaElement).value;}}></textarea>
                <div class="mm-actions">
                  <button ?disabled=${state.busy||state.autopilotEnabled||!w}
                    @click=${()=>void autopilotCommand(context,"configure")}>Save configuration</button>
                  <button ?disabled=${state.busy||state.autopilotEnabled||!w}
                    @click=${()=>void autopilotCommand(context,"start")}>Start Autopilot</button>
                  <button ?disabled=${state.busy||!state.autopilotEnabled||!w}
                    @click=${()=>void autopilotCommand(context,"pause")}>Pause admission</button>
                </div>
                <p role="status" aria-live="polite">${state.autopilotStatus}</p>
              </details>
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

  .mm-goal-proposal{border:1px solid var(--pi-border-muted);border-radius:8px;
    padding:10px;margin:12px 0;background:var(--pi-surface);}
  .mm-goal-proposal summary{cursor:pointer;}
  .mm-goal-proposal p{font-size:12px;color:var(--pi-muted);}
  .mm-goal-proposal label{display:block;font-size:12px;margin:8px 0 5px;}
  .mm-goal-proposal textarea{width:100%;box-sizing:border-box;resize:vertical;
    color:inherit;background:var(--pi-surface);border:1px solid var(--pi-border-muted);
    border-radius:6px;padding:8px;font:12px ui-monospace,monospace;}
  .mm-goal-proposal textarea[readonly]{opacity:.88;}
  .mm-goal-credentials{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;}
  .mm-goal-credentials input{width:100%;box-sizing:border-box;background:var(--pi-surface);
    color:inherit;border:1px solid var(--pi-border-muted);border-radius:6px;padding:6px;}

  .mm-integration{border:1px solid var(--pi-border-muted);background:var(--pi-surface);
    border-radius:8px;padding:10px;margin:12px 0;font-size:12px;}
  .mm-integration p{color:var(--pi-muted);overflow-wrap:anywhere;}
  .mm-integration label{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
  .mm-integration input{min-width:180px;max-width:100%;background:var(--pi-surface);
    border:1px solid var(--pi-border-muted);border-radius:5px;color:inherit;padding:5px;}
  .mm-integration-proof{margin-top:10px;padding:8px;border:1px dashed var(--pi-border-muted);
    border-radius:7px;}
  .mm-integration-proof code{overflow-wrap:anywhere;font-size:11px;}
  .mm-workflow-import{border:1px solid var(--pi-border-muted);border-radius:8px;
    padding:10px;margin:12px 0;background:var(--pi-surface);}
  .mm-workflow-import summary{cursor:pointer;font-weight:600;}
  .mm-workflow-import p{color:var(--pi-muted);font-size:12px;}
  .mm-workflow-import textarea{width:100%;box-sizing:border-box;resize:vertical;margin:8px 0;
    background:var(--pi-surface);color:inherit;border:1px solid var(--pi-border-muted);
    border-radius:6px;padding:8px;font:12px ui-monospace,monospace;}
  .mm-autopilot {border:1px solid var(--pi-border-muted);background:var(--pi-surface);
    border-radius:9px;padding:11px;margin:12px 0;}
  .mm-autopilot summary {cursor:pointer;display:flex;align-items:center;gap:10px;justify-content:space-between;}
  .mm-autopilot summary span{font-size:11px;color:var(--pi-muted);}
  .mm-autopilot p{font-size:12px;color:var(--pi-muted);}
  .mm-autopilot label{font-size:12px;display:block;margin:8px 0 5px;}
  .mm-autopilot textarea{width:100%;box-sizing:border-box;min-height:120px;resize:vertical;
    background:var(--pi-surface);border:1px solid var(--pi-border-muted);color:inherit;
    border-radius:6px;font:12px ui-monospace,SFMono-Regular,monospace;padding:9px;}
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
