/**
 * A session-local bridge over PI WEB's public pi-session-events capability.
 * A timeout is UNCERTAIN, never a reason to resend a non-idempotent command.
 */
import { REPORT_CHANNEL, parseRunReport, type RunReport } from "../automation/report.js";
import {
  CONTROL_CHANNEL, RECEIPT_CHANNEL, ACTIVITY_CHANNEL,
  parseRuntimeReceipt, parseRuntimeActivity,
  type RuntimeControl, type RuntimeReceipt, type RuntimeActivity,
} from "./protocol.js";

export interface PiEventConnection {
  readonly signal: AbortSignal;
  on(channel: string, handler: (value: unknown) => void | Promise<void>): () => void;
  emit(channel: string, data: unknown): void;
  close(): void;
}
export type ActivityListener = (value: RuntimeActivity) => void;
export type ReportListener = (value: RunReport) => void;
type Waiting = { resolve(value: RuntimeReceipt): void; timeout: ReturnType<typeof setTimeout> };
function uncertain(id: string, code: string): RuntimeReceipt {
  return { requestId: id, status: "uncertain", code,
    message: "Delivery is not confirmed; inspect this session before attempting another action" };
}

export class PiSessionBridge {
  private readonly pending = new Map<string, Waiting>();
  private readonly subscriptions: (() => void)[] = [];
  private closed = false;
  constructor(private readonly conn: PiEventConnection, onActivity: ActivityListener,
    onReport?: ReportListener) {
    this.subscriptions.push(conn.on(RECEIPT_CHANNEL, data => {
      const receipt = parseRuntimeReceipt(data);
      if (!receipt) return;
      const pending = this.pending.get(receipt.requestId);
      if (!pending) return;
      this.pending.delete(receipt.requestId);
      clearTimeout(pending.timeout);
      pending.resolve(receipt);
    }));
    this.subscriptions.push(conn.on(ACTIVITY_CHANNEL, data => {
      const event = parseRuntimeActivity(data);
      if (event) onActivity(event);
    }));
    if(onReport)this.subscriptions.push(conn.on(REPORT_CHANNEL,data=>{
      const report=parseRunReport(data);
      if(report)onReport(report);
    }));
    conn.signal.addEventListener("abort", this.stop, { once: true });
  }
  readonly stop = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.conn.signal.removeEventListener("abort", this.stop);
    for (const unsubscribe of this.subscriptions) unsubscribe();
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timeout);
      waiter.resolve(uncertain(id, "connection_closed"));
    }
    this.pending.clear();
    this.conn.close();
  };
  get connected(): boolean { return !this.closed && !this.conn.signal.aborted; }
  async send(command: RuntimeControl, timeoutMs = 8000): Promise<RuntimeReceipt> {
    if (!this.connected) return uncertain(command.requestId, "connection_closed");
    if (this.pending.has(command.requestId)) throw new Error("Command already pending");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000) {
      throw new Error("Invalid command timeout");
    }
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this.pending.delete(command.requestId);
        resolve(uncertain(command.requestId, "no_receipt"));
      }, timeoutMs);
      this.pending.set(command.requestId, { timeout, resolve });
      try { this.conn.emit(CONTROL_CHANNEL, command); }
      catch {
        // An emit failure does not prove the receiver saw nothing.
        clearTimeout(timeout);
        this.pending.delete(command.requestId);
        resolve(uncertain(command.requestId, "send_uncertain"));
      }
    });
  }
}
