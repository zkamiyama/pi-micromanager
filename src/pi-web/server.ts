/** PI WEB server adapter: scoped persistence and a typed, bounded control seam. */
import { join } from "node:path";
import type { PiWebServerPlugin, JsonValue } from "@jmfederico/pi-web/server-plugin-api";
import { WorkflowStore } from "../core/store.js";
import { WorkflowError, type WorkflowAction } from "../core/workflow.js";

function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new WorkflowError("invalid_input", "Object required");
  return input as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) throw new WorkflowError("invalid_id", "Non-empty ID required");
  return value;
}

const plugin: PiWebServerPlugin = {
  apiVersion: 3,
  name: "pi-micromanager",
  activate(host) {
    const store = new WorkflowStore(join(host.dataDirectory, "workflows.sqlite"));
    return {
      peer: {
        request(context) {
          context.signal.throwIfAborted();
          const project = context.project.id;
          const workspace = context.workspace.id;
          switch (context.operation) {
            case "list": return store.list(project, workspace) as unknown as JsonValue;
            case "get": return store.get(project, workspace, id(context.input)) as unknown as JsonValue;
            case "create": return store.create(project, workspace, context.input) as unknown as JsonValue;
            case "act": {
              const input = object(context.input);
              if (!Number.isSafeInteger(input.expectedRevision)) throw new WorkflowError("invalid_revision", "Expected revision required");
              return store.act(project, workspace, id(input.workflowId), input.expectedRevision as number,
                id(input.commandId), object(input.action) as unknown as WorkflowAction) as unknown as JsonValue;
            }
            default: throw new WorkflowError("invalid_operation", "Unsupported workflow operation");
          }
        },
      },
      dispose() { store.close(); },
    };
  },
};
export default plugin;
