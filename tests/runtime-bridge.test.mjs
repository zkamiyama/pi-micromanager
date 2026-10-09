import assert from "node:assert/strict";
import test from "node:test";
import { PiSessionBridge } from "../dist/runtime/session-bridge.js";
import { CONTROL_CHANNEL, RECEIPT_CHANNEL, ACTIVITY_CHANNEL } from "../dist/runtime/protocol.js";

class FakeConn {
  abortController = new AbortController();
  signal = this.abortController.signal;
  handlers = new Map();
  responses = [];
  closed = false;
  on(channel, handler) {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler); this.handlers.set(channel, set);
    return () => set.delete(handler);
  }
  emit(channel, data) {
    this.responses.push({channel,data});
    if (channel === CONTROL_CHANNEL && this.autoReply) this.emit(RECEIPT_CHANNEL, this.autoReply(data));
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
  close() { this.closed = true; }
  autoReply;
}
test("synchronous receipts are captured before a command is emitted", async () => {
  const conn = new FakeConn();
  conn.autoReply = x => ({requestId:x.requestId,status:"ok",idle:true});
  const bridge = new PiSessionBridge(conn, () => {});
  const receipt = await bridge.send({type:"probe",requestId:"probe-1"});
  assert.equal(receipt.status,"ok");
  assert.equal(conn.responses[0].channel,CONTROL_CHANNEL);
  bridge.stop(); assert.equal(conn.closed,true);
});
test("companion activity arrives only after validation", async () => {
  const conn = new FakeConn(), seen = [];
  const bridge = new PiSessionBridge(conn, item => seen.push(item));
  conn.emit(ACTIVITY_CHANNEL,{kind:"tool_started",at:1700000000000,sequence:1,text:"grep"});
  conn.emit(ACTIVITY_CHANNEL,{kind:"private_thinking",at:1700000000000,sequence:2,text:"never"});
  assert.deepEqual(seen.map(x=>x.text),["grep"]);
  bridge.stop();
});
test("timeout and disconnection are uncertain, never silently resent", async () => {
  const conn = new FakeConn(), bridge = new PiSessionBridge(conn, () => {});
  const result = await bridge.send({type:"message",requestId:"x",text:"nudge",delivery:"steer"},50);
  assert.equal(result.status,"uncertain");
  assert.equal(result.code,"no_receipt");
  assert.equal(conn.responses.filter(x=>x.channel===CONTROL_CHANNEL).length,1);
  const waiting = bridge.send({type:"probe",requestId:"y"},1000);
  conn.abortController.abort();
  assert.equal((await waiting).status,"uncertain");
  assert.equal(conn.closed,true);
});
test("unrelated receipts cannot settle another request", async () => {
  const conn = new FakeConn(), bridge = new PiSessionBridge(conn, () => {});
  const result = bridge.send({type:"probe",requestId:"wanted"},50);
  conn.emit(RECEIPT_CHANNEL,{requestId:"unrelated",status:"ok"});
  assert.equal((await result).code,"no_receipt");
  bridge.stop();
});
