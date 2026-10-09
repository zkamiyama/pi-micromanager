import test from "node:test";
import assert from "node:assert/strict";
import {add} from "../src/math.mjs";

test("add preserves positive and negative numbers",()=>{
  assert.equal(add(2,3),5);
  assert.equal(add(-4,7),3);
});
