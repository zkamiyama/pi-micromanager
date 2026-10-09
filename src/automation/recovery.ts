/** Fail-closed classification of Pi Session state after server/plugin restart. */
import type { RuntimeReceipt } from "../runtime/protocol.js";

export type RecoveredRunState="running"|"settled"|"aborted"|"uncertain";

/** Pi's durable, Session-local turn marker is required; "idle" alone proves nothing. */
export function classifyRecoveredRun(runId:string,reply:RuntimeReceipt):RecoveredRunState {
  if(reply.status!=="ok"||reply.jobRunId!==runId||
    typeof reply.idle!=="boolean"||typeof reply.turnSettled!=="boolean"||
    typeof reply.turnInterrupted!=="boolean")return "uncertain";
  if(reply.idle&&reply.turnSettled)
    return reply.turnInterrupted?"aborted":"settled";
  if(!reply.idle&&!reply.turnSettled&&!reply.turnInterrupted)return "running";
  return "uncertain";
}
