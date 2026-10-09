/**
 * Pi-native companion extension. All model auth remains in Pi.
 * Companions expose only public text/tool names; no hidden reasoning or tool args.
 */
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { REPORT_CHANNEL, parseRunReport, type RunReport } from "../automation/report.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CONTROL_CHANNEL, RECEIPT_CHANNEL, ACTIVITY_CHANNEL, parseRuntimeControl,
  type RuntimeControl, type RuntimeReceipt, type RuntimeActivity, type ActivityKind, type RunJobContext,
} from "./protocol.js";

type StoredReceipt = { id: string; hash: string; result: RuntimeReceipt };
const receiptEntry = "pi-micromanager:receipt";
const claimEntry = "pi-micromanager:claim";
const jobEntry = "pi-micromanager:job:v1";
const reportEntry = "pi-micromanager:report:v1";
const turnStateEntry = "pi-micromanager:turn-state:v1";
const safeReadTools=new Set(["read","grep","find","ls","mm_qc_report","mm_task_report","mm_plan_intervention"]);
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
  let job:RunJobContext|undefined;
  let recorded:RunReport|undefined;
  let turnSettled:boolean|undefined;
  let turnInterrupted:boolean|undefined;
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
    job=undefined;recorded=undefined;turnSettled=undefined;turnInterrupted=undefined;
    // Custom entries do not enter the model context; this is a bounded
    // command receipt and an uncertain-send marker, not a duplicated transcript.
    for (const entry of context.sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;
      if(entry.customType===jobEntry){
        const data:unknown=entry.data;
        if(data&&typeof data==="object"&&"kind" in data&&"runId" in data)
          job=data as RunJobContext;
        continue;
      }
      if(entry.customType===reportEntry){
        const parsed=parseRunReport(entry.data);
        if(parsed)recorded=parsed;
        continue;
      }
      if(entry.customType===turnStateEntry){
        const data:unknown=entry.data;
        if(data&&typeof data==="object"&&!Array.isArray(data)&&
          "runId" in data&&typeof data.runId==="string"&&
          "settled" in data&&typeof data.settled==="boolean"&&
          "interrupted" in data&&typeof data.interrupted==="boolean"){
          if(!job||data.runId===job.runId){
            turnSettled=data.settled;
            turnInterrupted=data.interrupted;
          }
        }
        continue;
      }
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
  pi.on("session_shutdown", () => { ctx = undefined;job=undefined;recorded=undefined;turnSettled=undefined;turnInterrupted=undefined;receipts.clear(); claims.clear(); });

  pi.on("agent_start", () => {
    lastPublicText = "";
    if(job){
      turnSettled=false;turnInterrupted=false;
      pi.appendEntry(turnStateEntry,{runId:job.runId,settled:false,interrupted:false});
    }
    activity("agent_started", "Agent started");
  });
  pi.on("agent_settled", event => {
    if(job){
      turnSettled=true;turnInterrupted=event.aborted;
      // Persist BEFORE notifying the server, making a missed socket event
      // recoverable from the public Pi Session's own durable entries.
      pi.appendEntry(turnStateEntry,{runId:job.runId,settled:true,interrupted:event.aborted});
    }
    activity("agent_settled", event.aborted ? "Agent interrupted" : "Agent settled");
  });
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

  // A report is one structured model assertion; host Git/test checks remain mandatory.
  pi.registerTool({
    name:"mm_qc_report",label:"Submit QC verdict",
    description:"Submit the final QC verdict exactly once after inspecting code and evidence. This cannot approve merging.",
    parameters:Type.Object({
      verdict:Type.Union([Type.Literal("pass"),Type.Literal("fail"),Type.Literal("inconclusive")]),
      summary:Type.String({minLength:1,maxLength:2000}),
    }),
    async execute(_toolId,params){
      if(!job||job.kind!=="qc")throw new Error("Not bound to an automated QC Run");
      if(recorded)throw new Error("A verdict was already submitted for this Run");
      const report:RunReport={kind:"qc",runId:job.runId,verdict:params.verdict,
        summary:params.summary,at:Date.now()};
      pi.appendEntry(reportEntry,report);
      recorded=report;
      pi.events.emit(REPORT_CHANNEL,report);
      return {content:[{type:"text" as const,text:"QC verdict recorded; host validation still required."}],
        details:report};
    },
  });
  pi.registerTool({
    name:"mm_task_report",label:"Submit task result",
    description:"Submit one concise evidence-backed summary for a diagnosis or synthesis Task.",
    parameters:Type.Object({summary:Type.String({minLength:1,maxLength:2000})}),
    async execute(_toolId,params){
      if(!job||(job.kind!=="diagnosis"&&job.kind!=="synthesis"))
        throw new Error("Not bound to a diagnosis or synthesis Run");
      if(recorded)throw new Error("A Task result was already submitted for this Run");
      const report:RunReport={kind:"task",runId:job.runId,summary:params.summary,at:Date.now()};
      pi.appendEntry(reportEntry,report);
      recorded=report;
      pi.events.emit(REPORT_CHANNEL,report);
      return {content:[{type:"text" as const,text:"Task result recorded for the Orchestrator."}],
        details:report};
    },
  });

  pi.registerTool({
    name:"mm_plan_intervention",label:"Submit Sol investigation plan",
    description:"Propose 1..4 independent investigators for this human-requested QC intervention. "+
      "Models must be exact provider/model choices given by the Orchestrator. "+
      "The deterministic Workflow engine validates the plan; no Task changes are made by this tool.",
    parameters:Type.Object({
      summary:Type.String({minLength:1,maxLength:2000}),
      agents:Type.Array(Type.Object({
        id:Type.String({minLength:1,maxLength:32}),
        title:Type.String({minLength:1,maxLength:200}),
        role:Type.Union([Type.Literal("architect"),Type.Literal("reviewer")]),
        model:Type.String({minLength:1,maxLength:160}),
      }),{minItems:1,maxItems:4}),
    }),
    async execute(_toolId,params){
      if(!job||job.kind!=="planning")throw new Error("Not bound to a Sol planning Run");
      if(recorded)throw new Error("A plan was already submitted");
      const report:RunReport={kind:"plan",runId:job.runId,summary:params.summary,
        agents:params.agents,at:Date.now()};
      pi.appendEntry(reportEntry,report);
      recorded=report;
      pi.events.emit(REPORT_CHANNEL,report);
      return {content:[{type:"text" as const,text:"Plan submitted for deterministic validation."}],
        details:report};
    },
  });
  pi.on("tool_call",event=>{
    if(job&&job.kind!=="implementation"&&!safeReadTools.has(event.toolName))
      return {block:true,reason:"This automated "+job.kind+" Session is read-only"};
    return;
  });

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
        fresh: !context.sessionManager.getEntries().some(e => e.type === "message"),
        ...(context.model ? { provider: context.model.provider, model: context.model.id } : {}),
        effort: pi.getThinkingLevel() });
      return;
    }
    if (command.type === "inspect") {
      if(!job){
        respond({requestId:command.requestId,status:"failed",code:"job_not_bound"});
        return;
      }
      // Report replay is explicit and bound to this exact hosted Session.
      if(recorded&&recorded.runId===job.runId)pi.events.emit(REPORT_CHANNEL,recorded);
      respond({requestId:command.requestId,status:"ok",jobRunId:job.runId,
        idle:context.isIdle(),
        ...(turnSettled===undefined?{}:{turnSettled}),
        ...(turnInterrupted===undefined?{}:{turnInterrupted}),
        hasReport:!!recorded&&recorded.runId===job.runId});
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
      if(command.job){
        if(job&&JSON.stringify(job)!==JSON.stringify(command.job)){
          respond({requestId:command.requestId,status:"failed",code:"job_already_bound"});
          return;
        }
        job=command.job;
        pi.appendEntry(jobEntry,job);
        if(job.kind!=="implementation")
          pi.setActiveTools([...pi.getActiveTools().filter(name=>safeReadTools.has(name))]);
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
