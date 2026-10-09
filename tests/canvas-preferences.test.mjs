import test from "node:test";
import assert from "node:assert/strict";
import {
  canvasStorageKey, parseCanvasPreferences, serializeCanvasPreferences,
} from "../dist/pi-web/canvas-preferences.js";

test("UI layout preferences round-trip per machine/project/workspace without storing drafts",()=>{
  const first=canvasStorageKey(JSON.stringify(["machine", "project", "workspace"]));
  const second=canvasStorageKey(JSON.stringify(["other-machine", "project", "workspace"]));
  assert.notEqual(first,second);
  const prefs={dimmed:true,positions:new Map([["[\"wf\",\"run\"]",{x:512.6,y:40.3}]]),
    density:new Map([["[\"wf\",\"run\"]","expanded"]])};
  const stored=serializeCanvasPreferences(prefs);
  const restored=parseCanvasPreferences(stored);
  assert.equal(restored.dimmed,true);
  assert.deepEqual([...restored.positions],[["[\"wf\",\"run\"]",{x:513,y:40}]]);
  assert.deepEqual([...restored.density],[["[\"wf\",\"run\"]","expanded"]]);
  assert.ok(!stored.includes("secret prompt"));
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(),["density","dimmed","positions","version"]);
});
test("malformed, oversized and unsupported versions are treated as empty",()=>{
  for (const raw of ["", "{", "null", JSON.stringify({version:999,dimmed:true}),
    "x".repeat(70000)]) {
    const prefs=parseCanvasPreferences(raw);
    assert.equal(prefs.dimmed,false);
    assert.equal(prefs.positions.size,0);
    assert.equal(prefs.density.size,0);
  }
});
test("corrupt node coordinates and unknown densities cannot pollute UI state",()=>{
  const payload=JSON.stringify({version:1,dimmed:"true",
    positions:[["valid",10,20],["negative",-100,150],["bad",Infinity,20],["bad2","x",20],
      ["bad3",null,0],["",1,1],["ok",12,-4]],
    density:[["valid","compact"],["ignored","huge"],["bad",true],["", "expanded"]]});
  const prefs=parseCanvasPreferences(payload);
  assert.equal(prefs.dimmed,false);
  assert.equal(prefs.positions.has("bad"),false);
  assert.equal(prefs.positions.has("bad2"),false);
  assert.equal(prefs.positions.has("bad3"),false);
  assert.equal(prefs.positions.has(""),false);
  assert.equal(prefs.positions.get("negative").x,-100);
  assert.deepEqual([...prefs.density],[["valid","compact"]]);
});
