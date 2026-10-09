/** Versioned, bounded control and activity protocol for hosted Pi sessions. */
export const CONTROL_CHANNEL = "pi-micromanager:control:v1";
export const RECEIPT_CHANNEL = "pi-micromanager:receipt:v1";
export const ACTIVITY_CHANNEL = "pi-micromanager:activity:v1";

export type RuntimeControl =
  | { type: "probe"; requestId: string }
  | { type: "configure"; requestId: string; provider: string; model: string; effort?: string; sessionName?: string }
  | { type: "message"; requestId: string; text: string; delivery: "newTurn" | "steer" | "followUp" }
  | { type: "abort"; requestId: string };

export interface RuntimeReceipt {
  requestId: string;
  status: "ok" | "failed" | "uncertain";
  code?: string;
  message?: string;
  provider?: string;
  model?: string;
  effort?: string;
  idle?: boolean;
}

export const activityKinds = [
  "agent_started", "agent_settled", "message_delta", "message_completed",
  "tool_started", "tool_finished", "model_changed", "error",
] as const;
export type ActivityKind = typeof activityKinds[number];
export interface RuntimeActivity {
  kind: ActivityKind;
  at: number;
  sequence: number;
  text: string;
}
function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function bounded(value: unknown, max: number, nonempty = true): value is string {
  return typeof value === "string" && value.length <= max && (!nonempty || value.trim().length > 0);
}
const requestIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function parseRuntimeControl(input: unknown): RuntimeControl | undefined {
  if (!record(input) || !bounded(input.requestId, 128) || !requestIdPattern.test(input.requestId)) return;
  const requestId = input.requestId;
  if (input.type === "probe" || input.type === "abort") return { type: input.type, requestId };
  if (input.type === "configure") {
    if (!bounded(input.provider, 120) || !bounded(input.model, 160)) return;
    if (input.effort !== undefined && !bounded(input.effort, 32)) return;
    if (input.sessionName !== undefined && !bounded(input.sessionName, 120)) return;
    return { type: "configure", requestId, provider: input.provider, model: input.model,
      ...(input.effort === undefined ? {} : { effort: input.effort as string }),
      ...(input.sessionName === undefined ? {} : { sessionName: input.sessionName as string }) };
  }
  if (input.type === "message") {
    if (!bounded(input.text, 16000) ||
      (input.delivery !== "newTurn" && input.delivery !== "steer" && input.delivery !== "followUp")) return;
    return { type: "message", requestId, text: input.text, delivery: input.delivery };
  }
}
export function parseRuntimeReceipt(input: unknown): RuntimeReceipt | undefined {
  if (!record(input) || !bounded(input.requestId, 128) || !requestIdPattern.test(input.requestId) ||
    (input.status !== "ok" && input.status !== "failed" && input.status !== "uncertain")) return;
  const result: RuntimeReceipt = { requestId: input.requestId, status: input.status };
  for (const field of ["code", "message", "provider", "model", "effort"] as const) {
    const value = input[field];
    if (value !== undefined) {
      if (!bounded(value, field === "message" ? 600 : 160, false)) return;
      result[field] = value;
    }
  }
  if (input.idle !== undefined) {
    if (typeof input.idle !== "boolean") return;
    result.idle = input.idle;
  }
  return result;
}
export function parseRuntimeActivity(input: unknown): RuntimeActivity | undefined {
  if (!record(input) || !activityKinds.includes(input.kind as ActivityKind) ||
    !Number.isSafeInteger(input.at) || (input.at as number) < 0 ||
    !Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1 ||
    !bounded(input.text, 512, false)) return;
  return { kind: input.kind as ActivityKind, at: input.at as number,
    sequence: input.sequence as number, text: input.text };
}
