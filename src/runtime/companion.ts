/**
 * Pi-native companion extension. All model auth remains in Pi.
 * Companions expose only public text/tool names; no hidden reasoning or tool args.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONTROL_CHANNEL, RECEIPT_CHANNEL, ACTIVITY_CHANNEL, parseRuntimeControl,
  type RuntimeControl, type RuntimeReceipt, type RuntimeActivity, type ActivityKind,
} from "./protocol.js";

type StoredReceipt = { id: string; hash: string; result: RuntimeReceipt };
const receiptEntry = "pi-micromanager:receipt";
const claimEntry = "pi-micromanager:claim";
function digest(control: RuntimeControl): string {
  return createHash("sha256").update(JSON.stringify(control)).digest("hex");
}
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export default function micromanagerCompanion(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let sequence = 0;
  let lastPublicText = "";
  let lastEmitAt = 0;
  const receipts = new Map<string, StoredReceipt>();
  const claims = new Map<string, string>();

  function activity(kind: ActivityKind, text: string): void {
    const projected: RuntimeActivity = {
      kind, at: Date.now(), sequence: ++sequence, text: text.slice(-512),
    };
    pi.events.emit(ACTIVITY_CHANNEL, projected);
  }
  function reply(result: RuntimeReceipt): void { pi.events.emit(RECEIPT_CHANNEL, result); }

  function reloadReceipts(context: ExtensionContext): void {
    receipts.clear();
    claims.clear();
    // Custom entries do not enter the model context; this is a bounded
    // command receipt and an uncertain-send marker, not a duplicated transcript.
    for (const entry of context.sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;
      if (entry.customType !== claimEntry && entry.customType !== receiptEntry) continue;
      const data: unknown = entry.data;
      if (!data || typeof data !== "object" || Array.isArray(data) ||
          !("id" in data) || !("hash" in data) ||
          typeof data.id !== "string" || typeof data.hash !== "string") continue;
      if (entry.customType === claimEntry) claims.set(data.id, data.hash);
      else if ("result" in data && data.result && typeof data.result === "object") {
        // Only our own previously recorded receipts are considered.
        const result = data.result as RuntimeReceipt;
        receipts.set(data.id, { id: data.id, hash: data.hash, result });
      }
    }
  }
  pi.on("session_start", (_event, context) => { ctx = context; reloadReceipts(context); });
  pi.on("session_shutdown", () => { ctx = undefined; receipts.clear(); claims.clear(); });

  pi.on("agent_start", () => { lastPublicText = ""; activity("agent_started", "Agent started"); });
  pi.on("agent_settled", event =>
    activity("agent_settled", event.aborted ? "Agent interrupted" : "Agent settled"));
  pi.on("message_update", event => {
    if (event.message.role !== "assistant") return;
    const rendered = event.message.content.filter(part => part.type === "text")
      .map(part => part.text).join("\n");
    if (rendered === lastPublicText) return;
    const now = Date.now();
    if (now - lastEmitAt < 500 && rendered.length - lastPublicText.length < 120) return;
    lastEmitAt = now;
    lastPublicText = rendered;
    activity("message_delta", rendered.slice(-450));
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    const rendered = event.message.content.filter(part => part.type === "text")
      .map(part => part.text).join("\n");
    if (rendered.trim()) activity("message_completed", rendered.slice(-450));
    lastPublicText = "";
  });
  pi.on("tool_execution_start", event => activity("tool_started", event.toolName));
  pi.on("tool_execution_end", event =>
    activity(event.isError ? "error" : "tool_finished",
      event.toolName + (event.isError ? " failed" : " finished")));

  // PI WEB's pi-session-events connection is a narrow shared event bus. It has
  // no transport-level acknowledgment; this extension supplies one explicitly.
  pi.events.on(CONTROL_CHANNEL, input => {
    const command = parseRuntimeControl(input);
    if (!command) return;
    void handle(command).catch(error => reply({
      requestId: command.requestId, status: "uncertain",
      code: "unexpected_failure", message: errorText(error),
    }));
  });

  async function handle(command: RuntimeControl): Promise<void> {
    const context = ctx;
    if (!context) {
      reply({ requestId: command.requestId, status: "failed", code: "session_not_ready" });
      return;
    }
    const hash = digest(command);
    const previous = receipts.get(command.requestId);
    if (previous) {
      reply(previous.hash === hash ? previous.result :
        { requestId: command.requestId, status: "failed", code: "idempotency_conflict" });
      return;
    }
    if (claims.has(command.requestId)) {
      reply({ requestId: command.requestId, status: "uncertain",
        code: claims.get(command.requestId) === hash ? "delivery_undetermined" : "idempotency_conflict" });
      return;
    }
    const respond = (result: RuntimeReceipt) => {
      pi.appendEntry(receiptEntry, { id: command.requestId, hash, result });
      receipts.set(command.requestId, { id: command.requestId, hash, result });
      if (receipts.size > 256) receipts.delete(receipts.keys().next().value!);
      reply(result);
    };
    if (command.type === "probe") {
      respond({ requestId: command.requestId, status: "ok", idle: context.isIdle(),
        ...(context.model ? { provider: context.model.provider, model: context.model.id } : {}),
        effort: pi.getThinkingLevel() });
      return;
    }
    if (command.type === "configure") {
      if (!context.isIdle() || context.hasPendingMessages()) {
        respond({ requestId: command.requestId, status: "failed", code: "busy",
          message: "Configuration requires an idle, empty command queue" });
        return;
      }
      const model = context.modelRegistry.find(command.provider, command.model);
      if (!model) {
        respond({ requestId: command.requestId, status: "failed", code: "model_unavailable",
          message: "The exact provider/model is not in Pi's model catalogue" });
        return;
      }
      if (!await pi.setModel(model)) {
        respond({ requestId: command.requestId, status: "failed", code: "auth_required",
          message: "Authenticate the requested provider in Pi" });
        return;
      }
      if (command.effort !== undefined) {
        // Pi clamps unsupported thinking levels; never silently accept a clamp.
        pi.setThinkingLevel(command.effort as Parameters<typeof pi.setThinkingLevel>[0]);
        if (pi.getThinkingLevel() !== command.effort) {
          respond({ requestId: command.requestId, status: "failed", code: "effort_unsupported",
            message: "Pi did not accept the exact requested effort" });
          return;
        }
      }
      if (command.sessionName !== undefined) pi.setSessionName(command.sessionName);
      activity("model_changed", command.provider + "/" + command.model);
      respond({ requestId: command.requestId, status: "ok",
        provider: model.provider, model: model.id, effort: pi.getThinkingLevel(), idle: true });
      return;
    }
    if (command.type === "message") {
      if (command.delivery === "steer" && context.isIdle()) {
        respond({ requestId: command.requestId, status: "failed", code: "not_running",
          message: "Steer is only available during a running turn" });
        return;
      }
      if (command.delivery === "newTurn" && (!context.isIdle() || context.hasPendingMessages())) {
        respond({ requestId: command.requestId, status: "failed", code: "busy",
          message: "Use steer or followUp while the session is busy" });
        return;
      }
    }
    // Reserve command identity before any action that cannot be undone. A
    // crash with an unresolved claim is reported as uncertain, never replayed.
    pi.appendEntry(claimEntry, { id: command.requestId, hash });
    claims.set(command.requestId, hash);
    try {
      if (command.type === "abort") context.abort();
      else if (command.type === "message") {
        pi.sendUserMessage(command.text, command.delivery === "newTurn"
          ? undefined : { deliverAs: command.delivery === "steer" ? "steer" : "followUp" });
      }
      respond({ requestId: command.requestId, status: "ok",
        message: command.type === "abort" ? "Interrupt requested" : "Pi admitted the message, not yet completed" });
    } catch (error) {
      respond({ requestId: command.requestId, status: "uncertain",
        code: "delivery_uncertain", message: errorText(error) });
    }
  }
}
