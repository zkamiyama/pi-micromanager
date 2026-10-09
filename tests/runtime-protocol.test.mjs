import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_CHANNEL, RECEIPT_CHANNEL, ACTIVITY_CHANNEL, parseRuntimeControl, parseRuntimeReceipt, parseRuntimeActivity } from "../dist/runtime/protocol.js";

test("control, receipt and activity channels are disjoint and versioned", () => {
  assert.equal(new Set([CONTROL_CHANNEL, RECEIPT_CHANNEL, ACTIVITY_CHANNEL]).size, 3);
  assert.match(CONTROL_CHANNEL, /:v1$/);
});
test("runtime parser validates and narrows untrusted commands", () => {
  assert.deepEqual(parseRuntimeControl({type:"message", requestId:"abc-1", text:"review this",delivery:"steer",secret:"omit"}),
    {type:"message",requestId:"abc-1",text:"review this",delivery:"steer"});
  assert.equal(parseRuntimeControl({type:"message",requestId:"abc-1",text:"x".repeat(16001),delivery:"steer"}),undefined);
  assert.equal(parseRuntimeControl({type:"configure",requestId:"cmd1",provider:"",model:"opus"}),undefined);
  assert.equal(parseRuntimeControl({type:"message",requestId:"cmd1",text:"hi",delivery:"wrong"}),undefined);
  assert.equal(parseRuntimeControl({type:"abort",requestId:"bad id"}),undefined);
  assert.deepEqual(parseRuntimeControl({type:"configure",requestId:"id1",provider:"openai",model:"codex",effort:"xhigh"}),
    {type:"configure",requestId:"id1",provider:"openai",model:"codex",effort:"xhigh"});
});
test("runtime receipts and public activity projections have finite size", () => {
  assert.deepEqual(parseRuntimeReceipt({requestId:"x",status:"ok",model:"codex",secret:"drop"}),
    {requestId:"x",status:"ok",model:"codex"});
  assert.equal(parseRuntimeReceipt({requestId:"x",status:"ok",message:"!".repeat(601)}),undefined);
  assert.deepEqual(parseRuntimeActivity({kind:"tool_started",at:1700000000000,sequence:1,text:"bash",secret:"omit"}),
    {kind:"tool_started",at:1700000000000,sequence:1,text:"bash"});
  assert.equal(parseRuntimeActivity({kind:"thinking",at:1700000000000,sequence:1,text:"secret"}),undefined);
  assert.equal(parseRuntimeActivity({kind:"message_delta",at:1700000000000,sequence:1,text:"x".repeat(513)}),undefined);
});
