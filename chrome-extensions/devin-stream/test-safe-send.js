#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

class FakeWindow {
  constructor(href) {
    this.location = { href, origin: "https://app.devin.ai" };
    this.listeners = new Map();
    this.messages = [];
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((item) => item !== fn));
  }
  postMessage(data) {
    this.messages.push(data);
    for (const fn of [...(this.listeners.get("message") || [])]) {
      fn({ source: this, data });
    }
  }
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];
    this.listeners = new Map();
    MockWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  send(data) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("closed");
    this.sent.push(data);
  }
}

function install(sessionId) {
  MockWebSocket.instances = [];
  const window = new FakeWindow(
    `https://app.devin.ai/sessions/${sessionId}`);
  window.WebSocket = MockWebSocket;
  const context = vm.createContext({
    window,
    URL,
    Headers,
    crypto: webcrypto,
    Uint8Array,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(fs.readFileSync(
    path.join(__dirname, "inject.js"), "utf8"), context,
  { filename: "inject.js" });
  return window;
}

function request(window, requestId, sessionId, message) {
  window.postMessage({
    __wcDevinSendRequest: "window-colors-devin-send-v1",
    requestId,
    sessionId,
    message,
  });
  return window.messages.filter(
    (item) => item.__wcDevinSendResult &&
      item.requestId === requestId).at(-1);
}

const sid = "0123456789abcdef0123456789abcdef";
const otherSid = "fedcba9876543210fedcba9876543210";
const emptyWindow = install(sid);
const noSocket = request(emptyWindow, "req-no-socket", sid, "preserve me");
assert.equal(noSocket.ok, false);
assert.equal(noSocket.code, "no-open-socket");

const window = install(sid);
const matching = new window.WebSocket(
  `wss://app.devin.ai/api/events/devin-${sid}/live?token=private`);
const wrong = new window.WebSocket(
  `wss://app.devin.ai/api/events/devin-${otherSid}/live?token=private`);
const exact = "Long multiline Unicode:\nαβγ 🚀\n" + "x".repeat(4096);

const ok = request(window, "req-exact", sid, exact);
assert.equal(ok.ok, true);
assert.equal(matching.sent.length, 1);
assert.equal(wrong.sent.length, 0);
const frame = JSON.parse(matching.sent[0]);
assert.equal(frame.type, "user_message");
assert.equal(frame.message, exact);
assert.equal(frame.origin, "web");
assert.equal(frame.ensure_awake, true);
assert.match(frame.event_id, /^event-[a-f0-9]{32}$/);
assert.deepEqual(frame.rich_content, [{ text: exact }]);

// Replaying the same request id reconciles the prior ack without another send.
const duplicate = request(window, "req-exact", sid, exact);
assert.equal(duplicate.ok, true);
assert.equal(duplicate.eventId, ok.eventId);
assert.equal(matching.sent.length, 1);

matching.readyState = MockWebSocket.CLOSED;
const closed = request(window, "req-closed", sid, "preserve me");
assert.equal(closed.ok, false);
assert.equal(closed.code, "no-open-socket");
assert.equal(matching.sent.length, 1);

const mismatch = request(window, "req-mismatch", otherSid, "do not send");
assert.equal(mismatch.ok, false);
assert.equal(mismatch.code, "session-mismatch");
assert.equal(wrong.sent.length, 0);

// Guard the client-side safety invariants without executing page DOM code.
const clientSource = fs.readFileSync(
  path.join(__dirname, "..", "window-colors", "content.js"), "utf8");
assert.match(clientSource, /e\.isComposing/);
assert.match(clientSource, /e\.repeat \|\| replySending/);
assert.match(clientSource, /Safe send bridge unavailable; reload tab/);
assert.match(clientSource, /SEND_BRIDGE_TIMEOUT_MS = 3000/);
assert.match(clientSource,
  /if \(!result\.ok\) throw[\s\S]*replyInput\.value = ""/);
assert.doesNotMatch(clientSource, /findDevinChatInput/);
assert.doesNotMatch(clientSource, /findSendButton/);
assert.doesNotMatch(clientSource, /new KeyboardEvent/);

console.log("safe-send bridge tests passed");
