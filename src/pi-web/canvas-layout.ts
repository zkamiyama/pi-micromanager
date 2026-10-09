/** Pure geometry for the Live Runs orchestra canvas. Only actual Runs and Task DAG edges are projected. */
export interface CanvasRun {
  key: string;
  workflowId: string;
  taskId: string;
}
export interface CanvasDependency {
  workflowId: string;
  fromTaskId: string;
  toTaskId: string;
}
export interface CanvasPosition { x: number; y: number }
export interface CanvasNode extends CanvasRun, CanvasPosition {}
export interface CanvasLink {
  kind: "orchestra" | "dependency";
  sourceKey?: string;
  targetKey: string;
  from: CanvasPosition;
  to: CanvasPosition;
}
export interface CanvasGraph {
  width: number;
  height: number;
  root: CanvasPosition;
  nodes: CanvasNode[];
  links: CanvasLink[];
}

export const NODE_WIDTH = 280;
export const NODE_HEIGHT = 234;
const COLUMNS = 3;
const GAP_X = 24;
const GAP_Y = 54;
const PAD = 32;
export const CANVAS_WIDTH = PAD * 2 + COLUMNS * NODE_WIDTH + (COLUMNS - 1) * GAP_X;

export function runKey(workflowId: string, runId: string): string {
  // JSON encoding avoids collisions caused by arbitrary separators in user-defined IDs.
  return JSON.stringify([workflowId, runId]);
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Nodes can be repositioned but never dragged off-canvas or over the Orchestrator dock. */
export function buildCanvasGraph(
  runs: readonly CanvasRun[],
  dependencies: readonly CanvasDependency[],
  positions: ReadonlyMap<string, CanvasPosition> = new Map(),
): CanvasGraph {
  const rows = Math.max(1, Math.ceil(runs.length / COLUMNS));
  const root: CanvasPosition = { x: CANVAS_WIDTH / 2, y: PAD + rows * (NODE_HEIGHT + GAP_Y) + 12 };
  const nodes = runs.map((run, index): CanvasNode => {
    const defaultX = PAD + (index % COLUMNS) * (NODE_WIDTH + GAP_X);
    const defaultY = PAD + Math.floor(index / COLUMNS) * (NODE_HEIGHT + GAP_Y);
    const override = positions.get(run.key);
    const x = override && Number.isFinite(override.x) ? override.x : defaultX;
    const y = override && Number.isFinite(override.y) ? override.y : defaultY;
    return {
      ...run,
      x: clamp(x, 12, CANVAS_WIDTH - NODE_WIDTH - 12),
      y: clamp(y, 12, root.y - NODE_HEIGHT - 12),
    };
  });
  const links: CanvasLink[] = nodes.map(node => ({
    kind: "orchestra",
    targetKey: node.key,
    from: { ...root },
    to: { x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT + 5 },
  }));
  const byTask = new Map<string, CanvasNode>();
  // The visible Run for a Task is sufficient to show the actual DAG dependency.
  for (const node of nodes) {
    const key = JSON.stringify([node.workflowId, node.taskId]);
    if (!byTask.has(key)) byTask.set(key, node);
  }
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    const from = byTask.get(JSON.stringify([dependency.workflowId, dependency.fromTaskId]));
    const to = byTask.get(JSON.stringify([dependency.workflowId, dependency.toTaskId]));
    if (!from || !to || from.key === to.key) continue;
    const id = JSON.stringify([from.key, to.key]);
    if (seen.has(id)) continue;
    seen.add(id);
    const dx = (to.x + NODE_WIDTH / 2) - (from.x + NODE_WIDTH / 2);
    const dy = (to.y + NODE_HEIGHT / 2) - (from.y + NODE_HEIGHT / 2);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    links.push({
      kind: "dependency",
      sourceKey: from.key,
      targetKey: to.key,
      from: horizontal ?
        { x: from.x + (dx >= 0 ? NODE_WIDTH + 4 : -4), y: from.y + NODE_HEIGHT / 2 } :
        { x: from.x + NODE_WIDTH / 2, y: from.y + (dy >= 0 ? NODE_HEIGHT + 4 : -4) },
      to: horizontal ?
        { x: to.x + (dx >= 0 ? -4 : NODE_WIDTH + 4), y: to.y + NODE_HEIGHT / 2 } :
        { x: to.x + NODE_WIDTH / 2, y: to.y + (dy >= 0 ? -4 : NODE_HEIGHT + 4) },
    });
  }
  return { width: CANVAS_WIDTH, height: root.y + 252, root, nodes, links };
}

/** Shared by Lit rendering and pointer-drag live SVG updates. */
export function canvasLinkPath(link: CanvasLink): string {
  const dx = link.to.x - link.from.x;
  const dy = link.to.y - link.from.y;
  if (link.kind === "dependency") {
    return "M " + link.from.x + " " + link.from.y +
      " C " + (link.from.x + dx * .45) + " " + link.from.y +
      ", " + (link.to.x - dx * .45) + " " + link.to.y +
      ", " + link.to.x + " " + link.to.y;
  }
  return "M " + link.from.x + " " + link.from.y +
    " C " + link.from.x + " " + (link.from.y - 72) +
    ", " + link.to.x + " " + (link.to.y + 58) +
    ", " + link.to.x + " " + link.to.y;
}
export function canvasArrowTransform(link: CanvasLink): string {
  const angle = Math.atan2(link.to.y - link.from.y, link.to.x - link.from.x) * 180 / Math.PI;
  return "translate(" + link.to.x + " " + link.to.y + ") rotate(" + angle + ")";
}
