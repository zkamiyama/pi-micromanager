/** Live Pi Run grid, not a permanent agent roster. Bounded and workspace-scoped. */
import type {
  PluginActivationContext, WorkspacePanelContext,
  WorkspacePanelContribution, PluginPeerChannel,
} from "@jmfederico/pi-web/plugin-api";
import type { AgentBinding, Seat } from "../runtime/registry.js";
import type { WorkflowInstance } from "../core/workflow.js";
import {
  buildCanvasGraph, runKey, NODE_WIDTH, NODE_HEIGHT,
  type CanvasPosition, type CanvasDependency,
} from "./canvas-layout.js";

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
  canvasDimmed:boolean;
  canvasPage:number;
  plannerSessionId:string;
  nodePositions:Map<string,CanvasPosition>;
  nodeDrafts:Map<string,string>;
  nodeModes:Map<string,Mode>;
  drag?:{key:string;pointerId:number;startX:number;startY:number;origin:CanvasPosition};
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
      listening:false,connecting:false,canvasDimmed:false,canvasPage:0,
       plannerSessionId:"",nodePositions:new Map(),nodeDrafts:new Map(),nodeModes:new Map()};
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
    typeof b.workflowId==="string"&&roles.includes(b.seat as Seat)&&
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
       s.canvasPage=Math.min(s.canvasPage,Math.max(0,Math.ceil(active.length/12)-1));
       const activeKeys=new Set(active.map(b=>runKey(b.workflowId,b.runId)));
       for(const key of s.nodePositions.keys())if(!activeKeys.has(key))s.nodePositions.delete(key);
       for(const key of s.nodeDrafts.keys())if(!activeKeys.has(key))s.nodeDrafts.delete(key);
       for(const key of s.nodeModes.keys())if(!activeKeys.has(key))s.nodeModes.delete(key);
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
    for(const s of states.values()){s.controller?.abort();s.channel?.close();s.activity.clear();
      s.nodePositions.clear();s.nodeDrafts.clear();s.nodeModes.clear();}
    states.clear();
  },{once:true});


  const isCommandReady=(b:LiveBinding):boolean=>
    !!b.sessionId&&b.connected===true&&(b.phase==="configured"||b.phase==="running");
  const modeFor=(s:GridState,b:LiveBinding):Mode=>
    b.phase==="configured"?"newTurn":s.nodeModes.get(runKey(b.workflowId,b.runId))==="followUp"?"followUp":"steer";
  function focus(ctx:WorkspacePanelContext,b:LiveBinding){
    const s=stateFor(ctx);
    s.selectedSessionId=b.sessionId??"";
    s.canvasDimmed=false;
    refresh(ctx);
  }
  async function sendNode(ctx:WorkspacePanelContext,b:LiveBinding){
    const s=stateFor(ctx),key=runKey(b.workflowId,b.runId);
    const message=s.nodeDrafts.get(key)?.trim();
    if(!message||!isCommandReady(b)||s.busy||lifetime.aborted)return;
    const action=modeFor(s,b);
    s.busy=true;refresh(ctx);
    try {
      const receipt=await api(ctx,"agents.command",{
        sessionId:b.sessionId,action,requestId:crypto.randomUUID(),text:message,
      }) as {status?:string;message?:string};
      if(receipt?.status==="ok"){
        // Acknowledged only. Do not treat acknowledgement as proof the Agent finished.
        s.nodeDrafts.delete(key);
        s.loadStatus="Command acknowledged by "+b.runId+".";
      }else{
        // Keep the draft and never automatically retry an uncertain delivery.
        s.loadStatus="Command to "+b.runId+" "+(receipt?.status??"unknown")+
          ": "+(receipt?.message??"Check session state before retrying.");
      }
    }catch(error){s.loadStatus="Command to "+b.runId+" failed: "+String(error);}
    finally{s.busy=false;refresh(ctx);void load(ctx);}
  }
  function startDrag(ctx:WorkspacePanelContext,key:string,origin:CanvasPosition,event:PointerEvent){
    if(event.button!==0)return;
    const s=stateFor(ctx);
    s.drag={key,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,origin};
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
    s.canvasDimmed=false;refresh(ctx);
  }
  function moveDrag(ctx:WorkspacePanelContext,event:PointerEvent){
    const s=stateFor(ctx),drag=s.drag;
    if(!drag||drag.pointerId!==event.pointerId)return;
    s.nodePositions.set(drag.key,{
      x:drag.origin.x+event.clientX-drag.startX,
      y:drag.origin.y+event.clientY-drag.startY,
    });
    refresh(ctx);
  }
  function endDrag(ctx:WorkspacePanelContext,event:PointerEvent){
    const s=stateFor(ctx);
    if(s.drag?.pointerId!==event.pointerId)return;
    const target=event.currentTarget as HTMLElement;
    if(target.hasPointerCapture(event.pointerId))target.releasePointerCapture(event.pointerId);
    delete s.drag;refresh(ctx);
  }
  function nudge(ctx:WorkspacePanelContext,key:string,pos:CanvasPosition,event:KeyboardEvent){
    const amount=event.shiftKey?32:12;
    const delta:Record<string,CanvasPosition>={
      ArrowLeft:{x:-amount,y:0},ArrowRight:{x:amount,y:0},
      ArrowUp:{x:0,y:-amount},ArrowDown:{x:0,y:amount},
    };
    const move=delta[event.key];if(!move)return;
    event.preventDefault();
    const s=stateFor(ctx);
    s.nodePositions.set(key,{x:pos.x+move.x,y:pos.y+move.y});
    s.canvasDimmed=false;refresh(ctx);
  }

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

    const newest=[...s.active].sort((a,b)=>
      b.createdAt.localeCompare(a.createdAt)||b.runId.localeCompare(a.runId));
    const pageCount=Math.max(1,Math.ceil(newest.length/12));
    const visible=newest.slice(s.canvasPage*12,(s.canvasPage+1)*12);
    const dependencies:CanvasDependency[]=[];
    for(const b of visible){
      const task=s.workflows.find(w=>w.definition.id===b.workflowId)?.tasks[b.taskId];
      for(const dependency of task?.spec.dependsOn??[])dependencies.push({
        workflowId:b.workflowId,fromTaskId:dependency.taskId,toTaskId:b.taskId,
      });
    }
    const graph=buildCanvasGraph(visible.map(b=>({
      key:runKey(b.workflowId,b.runId),workflowId:b.workflowId,taskId:b.taskId,
    })),dependencies,s.nodePositions);
    const byKey=new Map(visible.map(b=>[runKey(b.workflowId,b.runId),b]));
    const planners=newest.filter(b=>b.seat==="planner"&&!!b.sessionId);
    const planner=planners.find(b=>b.sessionId===s.plannerSessionId)??planners[0];
    const plannerKey=planner?runKey(planner.workflowId,planner.runId):"";
    const plannerAvailable=!!planner&&isCommandReady(planner);
    const wirePath=(link:(typeof graph.links)[number]):string=>{
      const dx=link.to.x-link.from.x,dy=link.to.y-link.from.y;
      if(link.kind==="dependency")return "M "+link.from.x+" "+link.from.y+
        " C "+(link.from.x+dx*.45)+" "+link.from.y+
        ", "+(link.to.x-dx*.45)+" "+link.to.y+", "+link.to.x+" "+link.to.y;
      return "M "+link.from.x+" "+link.from.y+
        " C "+link.from.x+" "+(link.from.y-72)+
        ", "+link.to.x+" "+(link.to.y+58)+", "+link.to.x+" "+link.to.y;
    };
    const renderNode=(node:(typeof graph.nodes)[number])=>{
      const b=byKey.get(node.key);
      if(!b)return null;
      const key=node.key,latest=(s.activity.get(b.sessionId??"")??[]).slice(-3);
      const ready=isCommandReady(b),expanded=s.density[b.seat]==="expanded";
      return html`<article class="mm-f-node ${s.selectedSessionId&&b.sessionId===s.selectedSessionId&&!s.canvasDimmed?"mm-f-selected":""}"
          style=${`left:${node.x}px;top:${node.y}px;`}
          aria-label=${"Pi Run "+b.runId} @click=${()=>focus(ctx,b)}>
        <div class="mm-f-node-head" role="button" tabindex="0"
          title="Drag to move; arrow keys move this Agent (Shift for larger steps)."
          aria-label=${"Focus or move "+b.seat+" "+b.runId}
          @pointerdown=${(e:PointerEvent)=>{focus(ctx,b);startDrag(ctx,key,{x:node.x,y:node.y},e);}}
          @pointermove=${(e:PointerEvent)=>moveDrag(ctx,e)}
          @pointerup=${(e:PointerEvent)=>endDrag(ctx,e)}
          @pointercancel=${(e:PointerEvent)=>endDrag(ctx,e)}
          @keydown=${(e:KeyboardEvent)=>{
            if(e.key==="Enter"||e.key===" "){e.preventDefault();focus(ctx,b);}
            else nudge(ctx,key,{x:node.x,y:node.y},e);
          }}>
          <span class="mm-f-node-dot ${b.phase==="running"?"mm-f-running":b.phase==="uncertain"||b.phase==="blocked"?"mm-f-needs-attention":""}"></span>
          <strong>${b.seat.toUpperCase()}</strong>
          <span class="mm-f-node-phase">${b.phase}</span>
          <span class="mm-f-drag-handle" aria-hidden="true">⠿</span>
        </div>
        <div class="mm-f-node-meta">
          <strong title=${b.taskId}>${b.taskId}</strong>
          <small title=${b.runId}>${b.runId} · ${b.model?b.provider+"/"+b.model:"Not configured"}</small>
        </div>
        <div class="mm-f-node-log" aria-label=${"Public activity for "+b.runId}>
          ${expanded&&latest.length?latest.map(item=>html`<p><small>${item.kind}</small> ${item.text||"(no text)"}</p>`):
            html`<p>${b.latestText??(b.sessionId?"Waiting for Pi activity…":"Pi Session not created.")}</p>`}
        </div>
        <div class="mm-f-node-compose">
          <select aria-label=${"Delivery mode for "+b.runId} .value=${modeFor(s,b)}
            ?disabled=${s.busy||!ready||b.phase==="configured"}
            @change=${(e:Event)=>{s.nodeModes.set(key,(e.target as HTMLSelectElement).value as Mode);refresh(ctx);}}>
            ${b.phase==="configured"?html`<option value="newTurn">Start</option>`:html`
              <option value="steer">Steer</option><option value="followUp">Follow-up</option>`}
          </select>
          <textarea rows="1" maxlength="16000" aria-label=${"Message "+b.runId}
            placeholder=${ready?"Message this Agent…":"Reconnect / configure to message"}
            .value=${s.nodeDrafts.get(key)??""} ?disabled=${!ready||s.busy}
            @input=${(e:Event)=>{s.nodeDrafts.set(key,(e.target as HTMLTextAreaElement).value);refresh(ctx);}}></textarea>
          <button title=${"Send directly to "+b.runId} aria-label=${"Send to "+b.runId}
            ?disabled=${!ready||s.busy||!s.nodeDrafts.get(key)?.trim()}
            @click=${(e:Event)=>{e.stopPropagation();void sendNode(ctx,b);}}>↗</button>
        </div>
      </article>`;
    };
    return html`<style>${css}</style><section class="mm-fleet" aria-label="Live Agent Runs">
      <header><h2>Orchestra · Live Runs</h2><p>Floating Pi Agent conversations above the Orchestrator. Each card is a real one-shot Run; settled sessions move to History.</p></header>
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

      <div class="mm-f-canvas-nav">
        <span>${newest.length} live/pending Runs · ${pageCount>1?"Page "+(s.canvasPage+1)+"/"+pageCount:"All Runs visible"}</span>
        <span class="mm-f-canvas-legend"><i></i> Orchestra membership <b></b> Task dependency</span>
        <button ?disabled=${s.canvasPage===0} @click=${()=>{s.canvasPage--;refresh(ctx);}}>← Previous</button>
        <button ?disabled=${s.canvasPage>=pageCount-1} @click=${()=>{s.canvasPage++;refresh(ctx);}}>Next →</button>
      </div>
      <p class="mm-f-hint">Drag a header to move its window. Click empty space to fade nodes; click an Agent to focus it. On narrow panels, scroll the canvas horizontally.</p>
      <div class="mm-f-canvas-scroll" role="region" aria-label="Connected agent canvas" tabindex="0">
        <div class="mm-f-canvas ${s.canvasDimmed?"mm-f-dimmed":""}"
          style=${`width:${graph.width}px;height:${graph.height}px;`}>
          <button class="mm-f-blanket" aria-label="Clear focus and fade agent nodes"
            @click=${()=>{s.canvasDimmed=true;refresh(ctx);}}></button>
          <svg class="mm-f-connections" width=${graph.width} height=${graph.root.y+10}
            viewBox=${`0 0 ${graph.width} ${graph.root.y+10}`} aria-hidden="true">
            ${graph.links.map(link=>html`<path d=${wirePath(link)}
              fill="none" stroke=${link.kind==="dependency"?"var(--pi-accent)":"var(--pi-border-muted)"}
              stroke-width=${link.kind==="dependency"?2:1.5}
              stroke-dasharray=${link.kind==="orchestra"?"6 6":""}
              stroke-linecap="round" />`)}
            <circle cx=${graph.root.x} cy=${graph.root.y} r="5" fill="var(--pi-accent)" />
          </svg>
          ${graph.nodes.map(node=>renderNode(node))}
          ${!visible.length?html`<p class="mm-f-canvas-empty">
            No Pi agent Runs are active. New sessions appear as floating chat windows after a Task Run is admitted and launched.
          </p>`:null}
          <section class="mm-f-orchestrator"
            style=${`left:${graph.root.x-340}px;top:${graph.root.y+20}px;`}
            aria-label="Orchestrator console">
            <div class="mm-f-orch-title">
              <strong>◇ Orchestrator</strong>
              <small>Current workspace · observed Pi activity</small>
              <span>${planners.length?"● "+planners.length+" planner Run(s)":"○ No planner Run"}</span>
            </div>
            <div class="mm-f-orch-feed" aria-label="Latest live run summaries">
              ${newest.length?newest.slice(0,3).map(b=>html`<p><b>${b.seat} · ${b.taskId}</b>
                ${b.latestText??b.phase}</p>`):html`<p>No live activity yet. This area observes Runs; it does not fabricate an agent conversation.</p>`}
            </div>
            <div class="mm-f-orch-compose">
              ${planners.length>1?html`<select aria-label="Planner Run" .value=${planner?.sessionId??""}
                @change=${(e:Event)=>{s.plannerSessionId=(e.target as HTMLSelectElement).value;refresh(ctx);}}>
                ${planners.map(b=>html`<option value=${b.sessionId??""}>${b.taskId} / ${b.runId}</option>`)}
              </select>`:null}
              <textarea rows="1" maxlength="16000"
                aria-label="Message the live planner Pi Session"
                placeholder=${plannerAvailable?"Direct message to planner Pi Run…":"No connected planner Pi Run"}
                ?disabled=${!plannerAvailable||s.busy}
                .value=${s.nodeDrafts.get(plannerKey)??""}
                @input=${(e:Event)=>{s.nodeDrafts.set(plannerKey,(e.target as HTMLTextAreaElement).value);refresh(ctx);}}></textarea>
              <button ?disabled=${!plannerAvailable||s.busy||!s.nodeDrafts.get(plannerKey)?.trim()}
                @click=${()=>{if(planner)void sendNode(ctx,planner);}}>Send</button>
            </div>
            <small class="mm-f-orch-foot">
              ${planner? "Direct to "+planner.runId+" · "+(plannerAvailable?modeFor(s,planner):"Reconnect/configure before sending") :
                "No live planner is connected. Workflow simulation and Task Lens are in the Micromanager tab."}
            </small>
          </section>
        </div>
      </div>
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

  .mm-f-canvas-nav{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px;font-size:11px;color:var(--pi-muted);}
  .mm-f-canvas-nav button{padding:4px 7px;}
  .mm-f-canvas-legend{margin-inline:auto;display:flex;gap:6px;align-items:center;}
  .mm-f-canvas-legend i{display:inline-block;width:18px;border-top:2px dashed var(--pi-border-muted);}
  .mm-f-canvas-legend b{display:inline-block;width:18px;border-top:2px solid var(--pi-accent);}
  .mm-f-hint{font-size:11px;color:var(--pi-muted);margin:8px 0;}
  .mm-f-canvas-scroll{max-width:100%;max-height:min(75vh,850px);overflow:auto;border:1px solid var(--pi-border-muted);
    border-radius:10px;background:var(--pi-background,var(--pi-surface));}
  .mm-f-canvas{position:relative;max-width:none;box-sizing:border-box;
    background-image:radial-gradient(var(--pi-border-muted) .55px,transparent .55px);
    background-size:22px 22px;}
  .mm-f-blanket{position:absolute;inset:0;z-index:0;width:100%;height:100%;padding:0!important;
    border:0!important;background:transparent!important;border-radius:0!important;cursor:default;}
  .mm-f-blanket:focus-visible{outline:2px solid var(--pi-accent);outline-offset:-4px;}
  .mm-f-connections{position:absolute;top:0;left:0;z-index:1;pointer-events:none;transition:opacity .18s ease;}
  .mm-f-canvas-empty{position:absolute;top:70px;left:50%;transform:translateX(-50%);width:360px;
    text-align:center;line-height:1.6;color:var(--pi-muted);pointer-events:none;}
  .mm-f-node{position:absolute;z-index:2;width:280px;height:234px;box-sizing:border-box;display:flex;flex-direction:column;
    border:1px solid var(--pi-border-muted);border-radius:10px;background:var(--pi-surface);
    box-shadow:0 8px 24px rgba(0,0,0,.13);overflow:hidden;transition:opacity .18s ease,border-color .18s ease;}
  .mm-f-node.mm-f-selected{border-color:var(--pi-accent);box-shadow:0 8px 25px rgba(0,0,0,.16);}
  .mm-f-dimmed .mm-f-node{opacity:.35;}
  .mm-f-dimmed .mm-f-connections{opacity:.27;}
  .mm-f-node-head{display:flex;align-items:center;gap:8px;padding:9px 10px;cursor:grab;touch-action:none;
    border-bottom:1px solid var(--pi-border-muted);user-select:none;min-height:34px;box-sizing:border-box;}
  .mm-f-node-head:active{cursor:grabbing;}
  .mm-f-node-head:focus-visible{outline:2px solid var(--pi-accent);outline-offset:-2px;}
  .mm-f-node-head strong{font-size:12px;letter-spacing:.02em;}
  .mm-f-node-dot{width:8px;height:8px;border-radius:50%;background:var(--pi-muted);flex-shrink:0;}
  .mm-f-node-dot.mm-f-running{background:var(--pi-success,var(--pi-accent));}
  .mm-f-node-dot.mm-f-needs-attention{background:var(--pi-warning,var(--pi-accent));}
  .mm-f-node-phase{color:var(--pi-muted);font-size:11px;margin-left:auto;}
  .mm-f-drag-handle{color:var(--pi-muted);font-size:14px;}
  .mm-f-node-meta{padding:7px 10px 4px;min-width:0;display:flex;flex-direction:column;gap:3px;}
  .mm-f-node-meta strong{font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;}
  .mm-f-node-meta small{font-size:10px;color:var(--pi-muted);white-space:nowrap;text-overflow:ellipsis;overflow:hidden;}
  .mm-f-node-log{min-height:0;flex:1;overflow:auto;padding:5px 10px;border-top:1px solid var(--pi-border-muted);}
  .mm-f-node-log p{font-size:11px;margin:3px 0;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;}
  .mm-f-node-log small{color:var(--pi-muted);font-size:10px;margin-right:4px;}
  .mm-f-node-compose{display:flex;align-items:stretch;gap:4px;padding:7px;border-top:1px solid var(--pi-border-muted);}
  .mm-f-node-compose select{width:77px;flex-shrink:0;padding:4px;font-size:11px;}
  .mm-f-node-compose textarea{flex:1;min-width:0;resize:none;height:31px;overflow:auto;padding:5px;font-size:11px;}
  .mm-f-node-compose button{width:30px;flex-shrink:0;font-size:17px;padding:0;}
  .mm-f-orchestrator{position:absolute;z-index:2;width:680px;height:206px;box-sizing:border-box;
    border:1px solid var(--pi-accent-border);border-radius:10px;background:var(--pi-surface);
    box-shadow:0 10px 28px rgba(0,0,0,.12);overflow:hidden;display:flex;flex-direction:column;}
  .mm-f-orch-title{display:flex;gap:9px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--pi-border-muted);}
  .mm-f-orch-title strong{font-size:14px;white-space:nowrap;}
  .mm-f-orch-title small{font-size:11px;color:var(--pi-muted);flex:1;}
  .mm-f-orch-title span{font-size:10px;color:var(--pi-muted);white-space:nowrap;}
  .mm-f-orch-feed{overflow:auto;flex:1;min-height:0;padding:6px 12px;}
  .mm-f-orch-feed p{font-size:11px;color:var(--pi-muted);margin:3px 0;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis;}
  .mm-f-orch-feed b{color:inherit;margin-right:7px;}
  .mm-f-orch-compose{display:flex;gap:6px;padding:6px 10px;align-items:center;border-top:1px solid var(--pi-border-muted);}
  .mm-f-orch-compose select{max-width:130px;}
  .mm-f-orch-compose textarea{flex:1;min-width:0;height:31px;padding:5px;resize:none;font-size:11px;}
  .mm-f-orch-compose button{flex-shrink:0;padding:6px 12px;}
  .mm-f-orch-foot{padding:0 11px 7px;color:var(--pi-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
`;
