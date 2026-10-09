/** PI WEB Server API v3: workflow control plus real, explicitly scoped Pi sessions. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,
  type PiWebHostPiSessionsV1, type PiWebHostPiSessionEventsV1,
  type PiWebServerPlugin, type JsonValue, type ServerPluginPeerRequestContext,
} from "@jmfederico/pi-web/server-plugin-api";
import { WorkflowStore } from "../core/store.js";
import { WorkflowError, type WorkflowAction } from "../core/workflow.js";
import { AgentRegistry, type AgentBinding, type Reservation, type Seat } from "../runtime/registry.js";
import { PiSessionBridge } from "../runtime/session-bridge.js";
import { type RuntimeActivity, type RuntimeControl } from "../runtime/protocol.js";

function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkflowError("invalid_input", "Object required");
  }
  return input as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new WorkflowError("invalid_id", "Non-empty ID required");
  }
  return value;
}
function seat(value: unknown): Seat {
  if (value !== "planner" && value !== "implementer" && value !== "qc" && value !== "architect") {
    throw new WorkflowError("invalid_seat", "Select planner, implementer, qc or architect");
  }
  return value;
}
function str(value: unknown, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new WorkflowError("invalid_input", "Required nonempty string (max " + max + ")");
  }
  return value;
}
function j(value: unknown): JsonValue { return value as JsonValue; }

type Fanout = { scope: string; send: (payload: JsonValue) => void };
const plugin: PiWebServerPlugin = {
  apiVersion: 3,
  name: "pi-micromanager",
  requires: [PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY],
  activate(host) {
    const store = new WorkflowStore(join(host.dataDirectory, "workflows.sqlite"));
    const agents = new AgentRegistry(join(host.dataDirectory, "agents.sqlite"));
    let sessions: PiWebHostPiSessionsV1 | undefined;
    let sessionEvents: PiWebHostPiSessionEventsV1 | undefined;
    const live = new Map<string, PiSessionBridge>();
    const viewers = new Set<Fanout>();
    const scopeKey = (projectId: string, workspaceId: string): string => JSON.stringify([projectId,workspaceId]);
    const bridgeKey = (projectId: string, workspaceId: string, sessionId: string): string =>
      JSON.stringify([projectId,workspaceId,sessionId]);

    function publish(binding: AgentBinding, event: RuntimeActivity): void {
      if (!binding.sessionId) return;
      agents.record(binding, event);
      const key = scopeKey(binding.projectId, binding.workspaceId);
      for (const viewer of viewers) {
        if (viewer.scope !== key) continue;
        try { viewer.send(j({ type: "agent_activity", sessionId: binding.sessionId, event })); }
        catch { viewers.delete(viewer); }
      }
    }
    async function connect(binding: AgentBinding): Promise<PiSessionBridge> {
      if (!binding.sessionId) throw new Error("Session identity is not yet known; reconcile the pending launch manually");
      const key = bridgeKey(binding.projectId,binding.workspaceId,binding.sessionId);
      const prior = live.get(key);
      if (prior?.connected) return prior;
      if (prior) { prior.stop(); live.delete(key); }
      if (!sessionEvents) throw new Error("PI WEB session-events capability is not available");
      const conn = await sessionEvents.connect({
        projectId:binding.projectId,workspaceId:binding.workspaceId,sessionId:binding.sessionId,
      });
      const bridge = new PiSessionBridge(conn, event => publish(binding,event));
      live.set(key,bridge);
      conn.signal.addEventListener("abort", () => {
        if (live.get(key) === bridge) live.delete(key);
      }, {once:true});
      return bridge;
    }
    function bound(context: ServerPluginPeerRequestContext, sessionId: string): AgentBinding {
      return agents.get(context.project.id,context.workspace.id,sessionId);
    }
    function reservation(context: ServerPluginPeerRequestContext, input: Record<string, unknown>): Reservation {
      const workflowId = id(input.workflowId);
      const taskId = id(input.taskId);
      const workflow = store.get(context.project.id,context.workspace.id,workflowId);
      if (!Object.hasOwn(workflow.tasks,taskId)) {
        throw new WorkflowError("unknown_task", "Select an existing Task in this workspace");
      }
      const targetSeat = seat(input.seat);
      if (targetSeat === "implementer" && context.workspace.isMain) {
        throw new WorkflowError("worktree_required",
          "Implementers require a separate linked Git worktree. Create/select one in PI WEB first.");
      }
      return {
        projectId: context.project.id,workspaceId: context.workspace.id,
        workflowId,taskId,seat:targetSeat,requestId:id(input.requestId),
      };
    }
    async function verify(binding: AgentBinding): Promise<{ bridge: PiSessionBridge; status: string }> {
      const bridge = await connect(binding);
      const probe = await bridge.send({type:"probe",requestId:randomUUID()},7000);
      if (probe.status === "ok") {
        agents.update(binding,binding.phase === "configured" ? "configured" : "connected");
      } else {
        agents.update(binding,"uncertain");
      }
      return {bridge,status:probe.status};
    }
    function answer(binding: AgentBinding, extra: Record<string, unknown> = {}): JsonValue {
      return j({ ...binding, ...extra });
    }
    return {
      start({ capabilities }) {
        sessions = capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
        sessionEvents = capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
      },
      peer: {
        async request(context) {
          context.signal.throwIfAborted();
          host.lifetimeSignal.throwIfAborted();
          const project = context.project.id;
          const workspace = context.workspace.id;
          switch (context.operation) {
            case "list": return j(store.list(project,workspace));
            case "get": return j(store.get(project,workspace,id(context.input)));
            case "create": return j(store.create(project,workspace,context.input));
            case "act": {
              const input = object(context.input);
              if (!Number.isSafeInteger(input.expectedRevision)) {
                throw new WorkflowError("invalid_revision","Expected revision required");
              }
              return j(store.act(project,workspace,id(input.workflowId),input.expectedRevision as number,
                id(input.commandId),object(input.action) as unknown as WorkflowAction));
            }
            case "agents.list": {
              return j(agents.list(project,workspace).map(b => ({
                ...b,connected:Boolean(b.sessionId && live.get(bridgeKey(project,workspace,b.sessionId))?.connected),
              })));
            }
            case "agents.history": {
              const input = object(context.input);
              return j(agents.activities(project,workspace,id(input.sessionId)));
            }
            case "agents.create": {
              const input = object(context.input);
              const selection = reservation(context,input);
              const previous = agents.getSeat(project,workspace,selection.workflowId,selection.taskId,selection.seat);
              if (previous) {
                if (previous.requestId !== selection.requestId) throw new Error("Task seat already reserved");
                return answer(previous,{note:"Existing reservation reused; no second session spawned"});
              }
              // Reserve BEFORE host I/O; uncertain creation must never be replayed automatically.
              agents.reserve(selection);
              if (!sessions) throw new Error("PI WEB pi-sessions capability is not active");
              const created = await sessions.create({projectId:project,workspaceId:workspace});
              let binding = agents.assign(selection,created.sessionId);
              const checked = await verify(binding);
              binding = agents.get(project,workspace,created.sessionId);
              if (checked.status !== "ok") return answer(binding,{
                note:"Session created but companion did not acknowledge probe. Inspect PI WEB Sessions; do not retry creation.",
              });
              const provider = str(input.provider,120);
              const model = str(input.model);
              const effort = input.effort === undefined ? undefined : str(input.effort,32);
              const configured = await checked.bridge.send({
                type:"configure",requestId:randomUUID(),provider,model,
                ...(effort ? { effort } : {}),
                sessionName:"Micromanager " + selection.seat + " / " + selection.taskId,
              });
              binding = agents.update(binding,configured.status === "ok" ? "configured" :
                configured.status === "uncertain" ? "uncertain" : "blocked",
                configured.status === "ok" ? { provider,model,...(effort ? {effort} : {}) } : undefined);
              return answer(binding,{configuration:configured});
            }
            case "agents.attach": {
              const input = object(context.input);
              const selection = reservation(context,input);
              const sessionId = id(input.sessionId);
              const previous = agents.getSeat(project,workspace,selection.workflowId,selection.taskId,selection.seat);
              if (previous) {
                if (previous.requestId !== selection.requestId || previous.sessionId !== sessionId) {
                  throw new Error("Task seat already bound to another request or Pi session");
                }
                return answer(previous,{note:"Existing attachment"});
              }
              // A foreign session must already be hosted in THIS PI WEB workspace.
              if (!sessionEvents) throw new Error("PI WEB pi-session-events capability is not active");
              const checkConn = await sessionEvents.connect({projectId:project,workspaceId:workspace,sessionId});
              const temp = new PiSessionBridge(checkConn,() => {});
              const checked = await temp.send({type:"probe",requestId:randomUUID()},7000);
              temp.stop();
              if (checked.status !== "ok") {
                throw new Error("Pi companion unavailable; enable the package and reload the selected session");
              }
              agents.reserve(selection);
              let binding = agents.assign(selection,sessionId);
              binding = agents.update(binding,"connected");
              await connect(binding);
              return answer(binding,{configuration:checked});
            }
            case "agents.reconnect": {
              const input = object(context.input);
              const binding = bound(context,id(input.sessionId));
              const checked = await verify(binding);
              return answer(agents.get(project,workspace,binding.sessionId!),{probeStatus:checked.status});
            }
            case "agents.configure": {
              const input = object(context.input);
              let binding = bound(context,id(input.sessionId));
              const bridge = live.get(bridgeKey(project,workspace,binding.sessionId!));
              if (!bridge?.connected) throw new Error("Reconnect the Pi session before configuring it");
              const provider = str(input.provider,120), model = str(input.model);
              const effort = input.effort === undefined ? undefined : str(input.effort,32);
              const receipt = await bridge.send({type:"configure",requestId:id(input.requestId),provider,model,
                ...(effort ? {effort} : {})});
              binding = agents.update(binding,receipt.status === "ok" ? "configured" :
                receipt.status === "uncertain" ? "uncertain" : "blocked",
                receipt.status === "ok" ? {provider,model,...(effort ? {effort} : {})} : undefined);
              return answer(binding,{configuration:receipt});
            }
            case "agents.command": {
              const input = object(context.input);
              const binding = bound(context,id(input.sessionId));
              const bridge = live.get(bridgeKey(project,workspace,binding.sessionId!));
              if (!bridge?.connected) throw new Error("Session not connected; choose Reconnect first");
              const action = input.action;
              let cmd: RuntimeControl;
              if (action === "abort") cmd = {type:"abort",requestId:id(input.requestId)};
              else {
                if (action !== "newTurn" && action !== "steer" && action !== "followUp") {
                  throw new Error("Unknown Pi delivery mode");
                }
                cmd = {type:"message",requestId:id(input.requestId),text:str(input.text,16000),
                  delivery:action};
              }
              // This is EXPLICIT human direct control, not automatic DAG dispatch.
              // Never mark workflow complete or silently count a QC PASS here.
              return j(await bridge.send(cmd,10000));
            }
            default: throw new WorkflowError("invalid_operation","Unsupported workflow operation");
          }
        },
        openChannel(context) {
          if (context.operation !== "agents.events" || context.input !== null) {
            throw new Error("Unsupported live Agent channel");
          }
          const viewer: Fanout = {
            scope:scopeKey(context.project.id,context.workspace.id),
            send:context.send,
          };
          viewers.add(viewer);
          const cleanup = () => { viewers.delete(viewer);context.signal.removeEventListener("abort",cleanup); };
          context.signal.addEventListener("abort",cleanup,{once:true});
          return {
            receive(_data,signal) { signal.throwIfAborted(); throw new Error("Live Agent feed is read-only"); },
            close:cleanup,
          };
        },
      },
      dispose() {
        for (const bridge of live.values()) bridge.stop();
        live.clear();
        viewers.clear();
        agents.close();
        store.close();
      },
    };
  },
};
export default plugin;
