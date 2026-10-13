import test from "node:test";
import assert from "node:assert/strict";
import {add, multiply} from "../src/math.mjs";

test("add preserves positive and negative numbers",()=>{
  assert.equal(add(2,3),5);
  assert.equal(add(-4,7),3);
});

test("multiply returns the product of positive values",()=>{
  assert.equal(multiply(3,4),12);
});

test("multiply returns the product of negative and positive values",()=>{
  assert.equal(multiply(-2,3),-6);
});

test("multiply returns zero when one value is zero",()=>{
  assert.equal(multiply(5,0),0);
});
