/** Live Pi Run grid, not a permanent agent roster. Bounded and workspace-scoped. */
import type {
  PluginActivationContext, WorkspacePanelContext,
  WorkspacePanelContribution, PluginPeerChannel,
} from "@jmfederico/pi-web/plugin-api";
import type { AgentBinding, Seat } from "../runtime/registry.js";
import type { WorkflowInstance, TaskState } from "../core/workflow.js";

type Html = PluginActivationContext["html"];
type LiveBinding = AgentBinding & { connected?: boolean };
type Mode = "newTurn" | "steer" | "followUp";
interface Activity {
  kind:string; at:number; sequence:number; text:string;
}
interface GridState {
  active:LiveBinding[];
  history:LiveBinding[];
  workflows:WorkflowInstance[];
  selectedSessionId:string;
  workflowId:string;
  taskId:string;
  targetWorkspaceId:string;
  provider:string; model:string; effort:string;
  message:string; mode:Mode; evidenceRef:string;
  density:Record<Seat,"compact"|"expanded">;
  activity:Map<string,Activity[]>;
  loadStatus:string;
  busy:boolean; loaded:boolean;
  listening:boolean; connecting:boolean;
  channel?:PluginPeerChannel;
  controller?:AbortController;
}
const states=new Map<string,GridState>();
const scope=(ctx:WorkspacePanelContext)=>
  JSON.stringify([ctx.machine.id,ctx.workspace.projectId,ctx.workspace.id]);
function stateFor(ctx:WorkspacePanelContext):GridState{
  const k=scope(ctx);
  let s=states.get(k);
  if(!s){
    s={active:[],history:[],workflows:[],selectedSessionId:"",workflowId:"",taskId:"",
      targetWorkspaceId:ctx.workspace.id,provider:"openai-codex",model:"",effort:"",
      message:"",mode:"steer",evidenceRef:"",
      density:{planner:"expanded",implementer:"compact",qc:"expanded",architect:"expanded"},
      activity:new Map(),loadStatus:"Not connected.",busy:false,loaded:false,
      listening:false,connecting:false};
    states.set(k,s);
  }
  return s;
}
const phaseEnded=(phase:string)=>["settled","sealed","failed"].includes(phase);
const roles:Seat[]=["planner","implementer","qc","architect"];
function isBinding(value:unknown):value is LiveBinding {
  if(!value||typeof value!=="object")return false;
  const b=value as Record<string,unknown>;
  return typeof b.runId==="string"&&typeof b.taskId==="string"&&typeof b.seat==="string"&&
    typeof b.phase==="string"&&(typeof b.sessionId==="string"||b.sessionId===null);
}
function validatedActivity(value:unknown):Activity|undefined{
  if(!value||typeof value!=="object")return;
  const e=value as Record<string,unknown>;
  if(!["agent_started","agent_settled","message_delta","message_completed",
    "tool_started","tool_finished","model_changed","error"].includes(String(e.kind)))return;
  if(typeof e.text!=="string"||e.text.length>512||
    !Number.isSafeInteger(e.at)||!Number.isSafeInteger(e.sequence))return;
  return {kind:e.kind as string,text:e.text,at:e.at as number,sequence:e.sequence as number};
}
export function createLiveRunPanel(html:Html,lifetime:AbortSignal):WorkspacePanelContribution {
  function refresh(ctx:WorkspacePanelContext){ctx.host.requestRender();}
  async function api(ctx:WorkspacePanelContext,operation:string,input:unknown){
    if(!ctx.peer?.request)throw new Error("PI WEB server plugin is not active");
    return ctx.peer.request(operation,input as never);
  }
  async function load(ctx:WorkspacePanelContext) {
    const s=stateFor(ctx);
    if(s.busy||lifetime.aborted)return;
    s.busy=true;refresh(ctx);
    try{
      const [active,history,workflows]=await Promise.all([
        api(ctx,"agents.list",{view:"active"}),api(ctx,"agents.list",{view:"history"}),api(ctx,"list",null)]);
      if(!Array.isArray(active)||!active.every(isBinding)||
         !Array.isArray(history)||!history.every(isBinding)||!Array.isArray(workflows))
        throw new Error("Unrecognized server schema");
      s.active=active;s.history=history;s.workflows=workflows as WorkflowInstance[];
      if(!s.workflows.some(w=>w.definition.id===s.workflowId))
        s.workflowId=s.workflows[0]?.definition.id??"";
      const wf=s.workflows.find(w=>w.definition.id===s.workflowId);
      if(!wf?.tasks[s.taskId])s.taskId=Object.keys(wf?.tasks??{})[0]??"";
      const all=[...active,...history];
      if(!all.some(b=>b.sessionId===s.selectedSessionId))
        s.selectedSessionId=active.find(x=>!!x.sessionId)?.sessionId??
          history.find(x=>!!x.sessionId)?.sessionId??"";
      s.loadStatus=active.length+" active/pending execution(s), "+history.length+" completed execution(s).";
      s.loaded=true;
    }catch(error){s.loadStatus=String(error)}
    finally{s.busy=false;refresh(ctx)}
  }
  async function call(ctx:WorkspacePanelContext,operation:string,input:unknown){
    const s=stateFor(ctx);
    if(s.busy)return;
    s.busy=true;refresh(ctx);
    try{
      const result=await api(ctx,operation,input) as unknown;
      s.loadStatus=operation+" → "+JSON.stringify(result).slice(0,320);
      if(result&&typeof result==="object"&&"sessionId" in result&&
          typeof result.sessionId==="string")s.selectedSessionId=result.sessionId;
    }catch(error){s.loadStatus=operation+" error: "+String(error)}
    finally{s.busy=false;refresh(ctx)}
    void load(ctx);
  }
  async function listen(ctx:WorkspacePanelContext) {
    const s=stateFor(ctx);
    if(s.listening||s.connecting||lifetime.aborted)return;
    if(!ctx.peer?.openChannel){s.loadStatus="Live channel unavailable";refresh(ctx);return}
    s.connecting=true;refresh(ctx);
    const ctl=new AbortController();s.controller=ctl;
    try{
      const channel=await ctx.peer.openChannel("agents.events",null,{
        signal:ctl.signal,
        onData(payload) {
          if(!payload||typeof payload!=="object")return;
          const p=payload as Record<string,unknown>;
          if(p.type!=="agent_activity"||typeof p.sessionId!=="string")return;
          const event=validatedActivity(p.event);if(!event)return;
          const list=s.activity.get(p.sessionId)??[];
          s.activity.set(p.sessionId,[...list.slice(-15),event]);
          const b=s.active.find(x=>x.sessionId===p.sessionId);
          if(b){
            b.latestKind=event.kind;b.latestText=event.text;
            if(event.kind==="agent_started")b.phase="running";
            if(event.kind==="agent_settled"){
              b.phase="settled";
              // Reload server-confirmed run classification after settlement.
              queueMicrotask(()=>{if(!lifetime.aborted)void load(ctx);});
            }
          }
          refresh(ctx);
        },
      });
      if(ctl.signal.aborted||lifetime.aborted){channel.close();return}
      s.channel=channel;s.listening=true;s.loadStatus="Listening for actual Pi session activity.";
      void channel.closed.then(()=>{
        if(s.channel!==channel)return;
        delete s.channel;s.listening=false;
        s.loadStatus="Live connection closed. Reconnect to resume observing.";
        refresh(ctx);
      });
    }catch(error){s.loadStatus="Live connection unavailable: "+String(error)}
    finally{s.connecting=false;refresh(ctx)}
  }
  lifetime.addEventListener("abort",()=>{
    for(const s of states.values()){s.controller?.abort();s.channel?.close();s.activity.clear();}
    states.clear();
  },{once:true});

  function render(ctx:WorkspacePanelContext){
    const s=stateFor(ctx);
    if(!s.loaded&&!s.busy)queueMicrotask(()=>{if(!lifetime.aborted)void load(ctx);});
    if(!s.listening&&!s.connecting&&!s.controller&&!lifetime.aborted)
      queueMicrotask(()=>{if(!lifetime.aborted)void listen(ctx);});
    const wf=s.workflows.find(w=>w.definition.id===s.workflowId);
    const task=wf?.tasks[s.taskId];
    const selected=[...s.active,...s.history].find(b=>b.sessionId===s.selectedSessionId);
    const selectedActive=selected&&!phaseEnded(selected.phase);
    const taskRole:Seat=task?.spec.kind==="implementation"?
      (task.status==="awaiting_qc"?"qc":"implementer"):
      task?.spec.kind==="synthesis"?"planner":task?.spec.role==="architect"?"architect":"qc";
    const runId=task?taskRole==="qc"?
      "qc-"+task.spec.id+"-"+(task.pendingWork?.attempt??task.attempts):
      taskRole==="implementer"?"impl-"+task.spec.id+"-"+task.attempts:
        "task-"+task.spec.id+"-"+task.attempts:"";
    const eligible=!!task&&!!wf&&
      ((taskRole==="implementer"&&task.status==="running")||
       (taskRole==="qc"&&task.status==="awaiting_qc")||
       ((taskRole==="architect"||taskRole==="planner")&&task.status==="running"));
    const create=()=>{
      if(!eligible||!wf||!task)return;
      void call(ctx,"agents.create",{
        workflowId:wf.definition.id,taskId:task.spec.id,runId,seat:taskRole,
        workspaceId:s.targetWorkspaceId,requestId:crypto.randomUUID(),
        provider:s.provider,model:s.model,...(s.effort?{effort:s.effort}:{}),
      });
    };
    const send=(action:Mode|"abort"|"reconnect"|"seal")=>{
      if(!selected?.sessionId)return;
      if(action==="reconnect"){void call(ctx,"agents.reconnect",{sessionId:selected.sessionId});return}
      if(action==="seal"){void call(ctx,"agents.seal",{
        sessionId:selected.sessionId,evidenceRef:s.evidenceRef});return}
      void call(ctx,"agents.command",{
        sessionId:selected.sessionId,action,requestId:crypto.randomUUID(),
        ...(action==="abort"?{}:{text:s.message}),
      });
    };
    return html`<style>${css}</style><section class="mm-fleet" aria-label="Live Agent Runs">
      <header><h2>Active Pi executions</h2><p>Fresh Pi Session for every implementation attempt, QC run and diagnosis. Finished runs move to history.</p></header>
      <div class="mm-f-toolbar">
        <button @click=${()=>void load(ctx)} ?disabled=${s.busy}>Refresh runs</button>
        <button @click=${()=>{s.controller?.abort();s.channel?.close();delete s.controller;s.listening=false;void listen(ctx);}}
          ?disabled=${s.connecting}>Reconnect stream</button>
        <small>${s.listening?"● Events connected":"○ Events disconnected"}</small>
      </div>
      <p role="status" aria-live="polite">${s.loadStatus}</p>
      <div class="mm-f-densities">${roles.map(role=>html`<label>${role}
        <select .value=${s.density[role]}
          @change=${(ev:Event)=>{s.density[role]=(ev.target as HTMLSelectElement).value as "compact"|"expanded";refresh(ctx)}}>
          <option value="compact">Compact</option><option value="expanded">Expanded</option>
        </select></label>`)}</div>
      <div class="mm-f-grid">${s.active.length?s.active.map(b=>html`<article class="mm-f-card">
        <strong>${b.seat.toUpperCase()} · ${b.taskId}</strong>
        <small>Run ${b.runId} · ${b.phase}</small>
        <small>${b.model?b.provider+"/"+b.model:"Unconfigured"} · ${b.sessionId?.slice(0,12)??"Creating..."}</small>
        ${s.density[b.seat]==="expanded"?html`<p>${b.latestText??"No streamed public text yet."}</p>`:null}
        <button @click=${()=>{s.selectedSessionId=b.sessionId??"";refresh(ctx)}}
          ?disabled=${!b.sessionId}>Inspect / Steer</button>
      </article>`):html`<p>No active sessions. New Task runs appear here when dispatched.</p>`}</div>
      <details class="mm-f-history"><summary>Finished executions (${s.history.length})</summary>
        ${s.history.map(b=>html`<button @click=${()=>{s.selectedSessionId=b.sessionId??"";refresh(ctx)}}>
          ${b.taskId} / ${b.runId} · ${b.phase}</button>`)}
      </details>
      ${selected?html`<section class="mm-f-inspector">
        <h3>${selected.taskId} · ${selected.runId}</h3>
        <small>${selected.phase} · Session ${selected.sessionId??"not yet created"} · ${selected.workspaceId}</small>
        <div class="mm-f-activity">${(s.activity.get(selected.sessionId??"")??[]).map(event=>
          html`<p><small>${event.kind}</small> ${event.text}</p>`)}</div>
        ${selectedActive?html`<div>
          <label>Delivery
            <select .value=${s.mode} @change=${(e:Event)=>{s.mode=(e.target as HTMLSelectElement).value as Mode;refresh(ctx)}}>
              <option value="steer">Steer active turn</option>
              <option value="followUp">Queue follow-up</option>
              <option value="newTurn">Start configured run</option>
            </select>
          </label>
          <textarea rows="3" .value=${s.message}
            @input=${(e:Event)=>{s.message=(e.target as HTMLTextAreaElement).value;refresh(ctx);}}></textarea>
          <div class="mm-f-toolbar">
            <button ?disabled=${s.busy||!selected.connected||!s.message.trim()}
              @click=${()=>send(s.mode)}>Send directly to this Pi Session</button>
            <button ?disabled=${s.busy||!selected.connected} @click=${()=>send("abort")}>Interrupt</button>
            <button ?disabled=${s.busy} @click=${()=>send("reconnect")}>Reconnect session</button>
          </div>
        </div>`:null}
        ${selected.phase==="settled"?html`<div>
          <p>Agent settled. This Session is never reused. Preserve verification evidence before sealing.</p>
          <input .value=${s.evidenceRef} placeholder="Durable evidence reference"
            @input=${(e:Event)=>{s.evidenceRef=(e.target as HTMLInputElement).value;refresh(ctx);}} />
          <button ?disabled=${s.busy||!s.evidenceRef.trim()} @click=${()=>send("seal")}>Seal completed run</button>
        </div>`:null}
        ${phaseEnded(selected.phase)?html`<p>Historical run: steering disabled. New work requires a fresh execution.</p>`:null}
      </section>`:null}
      <details><summary>Manual one-shot launch (requires an admitted Workflow task)</summary>
        <p>Experimental. This creates a fresh Pi Session in an existing worktree; no automatic worktree creation or QC dispatch exists yet.</p>
        <label>Workflow <select .value=${s.workflowId} @change=${(e:Event)=>{
          s.workflowId=(e.target as HTMLSelectElement).value;
          s.taskId=Object.keys(s.workflows.find(w=>w.definition.id===s.workflowId)?.tasks??{})[0]??"";refresh(ctx);
        }}>${s.workflows.map(w=>html`<option value=${w.definition.id}>${w.definition.title}</option>`)}</select></label>
        <label>Task <select .value=${s.taskId} @change=${(e:Event)=>{s.taskId=(e.target as HTMLSelectElement).value;refresh(ctx)}}>
          ${Object.values(wf?.tasks??{}).map(t=>html`<option value=${t.spec.id}>${t.spec.title} · ${t.status}</option>`)}
        </select></label>
        <p>${eligible?"Eligible "+taskRole+" execution: "+runId:"Selected Task has no admitted run; use the Workflow engine first."}</p>
        <label>Existing Pi workspace ID<input .value=${s.targetWorkspaceId}
          @input=${(e:Event)=>{s.targetWorkspaceId=(e.target as HTMLInputElement).value;refresh(ctx);}}/></label>
        <label>Provider<input .value=${s.provider} @input=${(e:Event)=>{s.provider=(e.target as HTMLInputElement).value;}} /></label>
        <label>Model ID<input .value=${s.model} @input=${(e:Event)=>{s.model=(e.target as HTMLInputElement).value;refresh(ctx);}}/></label>
        <label>Effort<input .value=${s.effort} @input=${(e:Event)=>{s.effort=(e.target as HTMLInputElement).value;}}/></label>
        <button ?disabled=${s.busy||!eligible||!s.model.trim()||!s.targetWorkspaceId.trim()}
          @click=${create}>Create a fresh Pi Session · ${runId}</button>
      </details>
    </section>`;
  }
  return {id:"live-runs",title:"Live Runs",order:51,render};
}
const css=`
  .mm-fleet {box-sizing:border-box;padding:14px;color:inherit;min-width:0;font:inherit;font-size:13px;}
  .mm-fleet h2{font-size:17px;margin:0;} .mm-fleet header p{font-size:12px;color:var(--pi-muted);}
  .mm-fleet button,.mm-fleet select,.mm-fleet input,.mm-fleet textarea{
    color:inherit;background:var(--pi-surface);border:1px solid var(--pi-border-muted);border-radius:6px;padding:5px;font:inherit;}
  .mm-fleet button:hover:not(:disabled){background:var(--pi-surface-hover);cursor:pointer;}
  .mm-fleet button:disabled{opacity:.45;cursor:not-allowed;}
  .mm-fleet label{display:flex;flex-direction:column;gap:4px;min-width:0;}
  .mm-fleet input,.mm-fleet textarea{box-sizing:border-box;width:100%;}
  .mm-f-toolbar,.mm-f-densities{display:flex;flex-wrap:wrap;gap:9px;margin:10px 0;align-items:center;}
  .mm-f-densities label{font-size:11px;}
  .mm-f-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:12px 0;}
  .mm-f-card{border:1px solid var(--pi-border-muted);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:5px;min-width:0;}
  .mm-f-card small{font-size:11px;overflow-wrap:anywhere;color:var(--pi-muted);}
  .mm-f-card p{margin:3px 0;overflow-wrap:anywhere;white-space:pre-wrap;}
  .mm-f-inspector{border:1px solid var(--pi-accent-border);border-radius:8px;padding:10px;margin:14px 0;}
  .mm-f-inspector h3{margin:0 0 4px;} .mm-f-inspector textarea{display:block;margin:8px 0;}
  .mm-f-activity{max-height:240px;overflow:auto;} .mm-f-activity p{margin:3px 0;overflow-wrap:anywhere;}
  .mm-f-history{margin:12px 0;} .mm-f-history button{display:block;margin:5px 0;}
  .mm-fleet details{border-top:1px solid var(--pi-border-muted);padding:9px 0;}
  .mm-fleet details label{margin:8px 0;}
`;
