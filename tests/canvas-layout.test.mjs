import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCanvasGraph, runKey, NODE_WIDTH, NODE_HEIGHT, CANVAS_WIDTH,
} from "../dist/pi-web/canvas-layout.js";

const agent = (workflowId, taskId, runId) => ({
  workflowId, taskId, key: runKey(workflowId, runId),
});

test("run identity cannot collide on separators, and no agents yields no edges", () => {
  assert.notEqual(runKey("a:b", "c"), runKey("a", "b:c"));
  assert.notEqual(runKey("a", "b,c"), runKey("a,b", "c"));
  const empty = buildCanvasGraph([], []);
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.links.length, 0);
  assert.ok(empty.height > 0);
});

test("canvas lays out real runs in bounded non-overlapping slots", () => {
  const runs = Array.from({ length: 7 }, (_, i) => agent("wf", "task" + i, "run" + i));
  const graph = buildCanvasGraph(runs, []);
  assert.equal(graph.nodes.length, runs.length);
  assert.equal(graph.links.length, runs.length); // Real orchestra membership, not invented task transitions
  assert.deepEqual(graph.nodes.map(({ x, y }) => [x, y]), [
    [32, 32], [336, 32], [640, 32],
    [32, 320], [336, 320], [640, 320],
    [32, 608],
  ]);
  assert.ok(graph.nodes.every(n => n.x + NODE_WIDTH <= graph.width && n.y + NODE_HEIGHT < graph.root.y));
});

test("dependency connectors require actual visible same-workflow task relationships", () => {
  const runs = [agent("w1", "api", "i1"), agent("w1", "qc", "q1"), agent("w2", "api", "i2")];
  const graph = buildCanvasGraph(runs, [
    { workflowId: "w1", fromTaskId: "api", toTaskId: "qc" },
    { workflowId: "w1", fromTaskId: "api", toTaskId: "qc" },
    { workflowId: "w2", fromTaskId: "api", toTaskId: "qc" },
    { workflowId: "w1", fromTaskId: "missing", toTaskId: "qc" },
  ]);
  const deps = graph.links.filter(link => link.kind === "dependency");
  assert.equal(deps.length, 1);
  assert.equal(deps[0].sourceKey, runs[0].key);
  assert.equal(deps[0].targetKey, runs[1].key);
  assert.equal(graph.links.filter(link => link.kind === "orchestra").length, 3);
});

test("node positions are bounded; invalid or stale coordinates do not break rendering", () => {
  const a = agent("w", "api", "run1"), b = agent("w", "qc", "run2");
  const initial = buildCanvasGraph([a, b], []);
  const graph = buildCanvasGraph([a, b], [], new Map([
    [a.key, { x: -999, y: 999999 }],
    [b.key, { x: Number.NaN, y: Number.POSITIVE_INFINITY }],
    ["stale", { x: 200, y: 200 }],
  ]));
  assert.equal(graph.nodes[0].x, 12);
  assert.equal(graph.nodes[0].y, graph.root.y - NODE_HEIGHT - 12);
  assert.equal(graph.nodes[1].x, initial.nodes[1].x);
  assert.equal(graph.nodes[1].y, initial.nodes[1].y);
  assert.equal(graph.width, CANVAS_WIDTH);
});
