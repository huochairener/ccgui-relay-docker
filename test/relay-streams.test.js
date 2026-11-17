import { test } from "node:test";
import assert from "node:assert/strict";
import { RelaySession } from "../src/relay.js";

const base64Of = (s) => Buffer.from(s, "utf8").toString("base64");

function fakeAgent() {
  const listeners = { message: [], close: [] };
  return {
    readyState: "open",
    sent: [],
    closeCalls: [],
    addEventListener(type, fn) {
      listeners[type].push(fn);
    },
    emitMessage(data) {
      for (const fn of listeners.message) fn({ data });
    },
    emitClose() {
      for (const fn of listeners.close) fn({});
    },
    send(frame) {
      this.sent.push(JSON.parse(frame));
    },
    close(code, reason) {
      this.closeCalls.push({ code, reason });
      this.readyState = "closed";
    },
    get last() {
      return this.sent[this.sent.length - 1];
    },
  };
}

function waitingSession() {
  const session = new RelaySession("k");
  session.attachAgent(fakeAgent());
  return session;
}

test("open+body+end serializes onto agent socket in order", () => {
  const session = waitingSession();
  const req = {
    method: "POST",
    path: "/p?x=1",
    headers: { "content-type": "text/plain" },
    body: new TextEncoder().encode("hi"),
  };
  const promise = session.openHttpStream(req);
  const frames = session.agent.sent;
  assert.deepEqual(frames[0], {
    t: "open",
    id: 1,
    method: "POST",
    path: "/p?x=1",
    headers: { "content-type": "text/plain" },
  });
  assert.deepEqual(frames[1], { t: "body", id: 1, b64: base64Of("hi") });
  assert.deepEqual(frames[2], { t: "end", id: 1 });
  assert.ok(promise.head instanceof Promise);
  assert.equal(promise.id, 1);
  assert.equal(typeof promise.cancel, "function");
  // No onClose/consumer here: a default 30s head timer would hang the test
  // runner's event loop.
  promise.cancel();
});

test("head+data+close frames stream the response via callbacks", async () => {
  const session = waitingSession();
  const chunks = [];
  let closed = false;
  const pending = session.openHttpStream({
    method: "GET",
    path: "/a",
    headers: {},
    body: new Uint8Array(0),
    onChunk: (bytes) => chunks.push(bytes),
    onClose: () => {
      closed = true;
    },
  });
  const id = 1;
  session.agent.emitMessage(
    JSON.stringify({ t: "head", id, status: 200, headers: { "x-a": "b" } }),
  );
  session.agent.emitMessage(
    JSON.stringify({ t: "data", id, b64: base64Of("part"), text: true }),
  );
  session.agent.emitMessage(JSON.stringify({ t: "close", id }));
  const res = await pending.head;
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-a"], "b");
  assert.equal(Buffer.concat(chunks).toString(), "part");
  await new Promise((r) => setTimeout(r, 0)); // onClose is macrotask-deferred (defer = setTimeout 0)
  assert.equal(closed, true);
  assert.equal(session.streamCount(), 0);
});

test("empty request body omits the body frame", () => {
  const session = waitingSession();
  const handle = session.openHttpStream({
    method: "GET",
    path: "/a",
    headers: {},
    body: new Uint8Array(0),
    headTimeoutMs: 20,
  });
  assert.deepEqual(
    session.agent.sent.map((f) => f.t),
    ["open", "end"],
  );
  handle.cancel(); // never leave a head timer hanging on the event loop
});

test("stream died before head yields 502 with error message", async () => {
  const session = waitingSession();
  const chunks = [];
  const pending = session.openHttpStream({
    method: "GET",
    path: "/a",
    headers: {},
    body: new Uint8Array(0),
    onChunk: (bytes) => chunks.push(bytes),
    onClose: () => {},
  });
  session.agent.emitMessage(JSON.stringify({ t: "error", id: 1, message: "boom" }));
  const res = await pending.head;
  assert.equal(res.status, 502);
  assert.equal(Buffer.concat(chunks).toString(), "boom");
  assert.equal(session.streamCount(), 0);
});

test("desktop close delivers close to every live stream and clears map", async () => {
  const session = waitingSession();
  const p1 = session.openHttpStream({
    method: "GET",
    path: "/1",
    headers: {},
    body: new Uint8Array(0),
  });
  session.agent.emitClose();
  const res = await p1.head;
  assert.equal(res.status, 502);
  assert.equal(session.streamCount(), 0);
  assert.equal(session.hasLiveAgent(), false);
});

test("replacing the agent closes the old socket with 1012 and clears its streams", () => {
  const session = new RelaySession("k");
  const old = fakeAgent();
  session.attachAgent(old);
  session.openHttpStream({
    method: "GET",
    path: "/x",
    headers: {},
    body: new Uint8Array(0),
    headTimeoutMs: 20,
  });
  assert.equal(session.streamCount(), 1);
  const fresh = fakeAgent();
  session.attachAgent(fresh);
  assert.deepEqual(old.closeCalls, [
    { code: 1012, reason: "replaced by a new agent connection" },
  ]);
  assert.equal(session.streamCount(), 0); // 旧流已随旧连接清算，不得串到新桌面
  assert.equal(session.agent, fresh);
  // headTimeoutMs: 20 的 timer 已被清算（_broadcastClose 清了 streams），
  // 但 cancel() 显式兜底，绝不给事件循环留吊着的 timer。
  assert.equal(session.agent, fresh);
});

test("data frames arriving after head still reach onChunk", async () => {
  const session = waitingSession();
  const chunks = [];
  let closed = false;
  const pending = session.openHttpStream({
    method: "GET",
    path: "/stream",
    headers: {},
    body: new Uint8Array(0),
    onChunk: (bytes) => chunks.push(bytes),
    onClose: () => {
      closed = true;
    },
  });
  session.agent.emitMessage(
    JSON.stringify({ t: "head", id: 1, status: 200, headers: {} }),
  );
  // 桌面分 tick 流式发送：head → data → close。head 后的数据必须继续透传，
  // 这是与 Worker ReadableStream 语义对齐的核心场景。
  session.agent.emitMessage(
    JSON.stringify({ t: "data", id: 1, b64: base64Of("late"), text: true }),
  );
  session.agent.emitMessage(JSON.stringify({ t: "close", id: 1 }));
  await pending.head;
  await new Promise((r) => setTimeout(r, 0)); // onClose is macrotask-deferred (defer = setTimeout 0)
  assert.equal(Buffer.concat(chunks).toString(), "late");
  assert.equal(closed, true);
});

test("head timeout yields 504 and sends close frame", async () => {
  const session = new RelaySession("k", { headTimeoutMs: 20 });
  session.attachAgent(fakeAgent());
  const pending = session.openHttpStream({
    method: "GET",
    path: "/slow",
    headers: {},
    body: new Uint8Array(0),
    onClose: () => {},
  });
  const res = await pending.head;
  assert.equal(res.status, 504);
  assert.equal(res.timedOut, true);
  assert.equal(session.streamCount(), 0);
  assert.equal(session.agent.last.t, "close");
});

test("onAgentFrame ignores malformed JSON without throwing", () => {
  const session = waitingSession();
  session.agent.emitMessage("not json at all");
  session.agent.emitMessage("}\u0000{");
  assert.equal(session.streamCount(), 0);
});

test("openSocketStream forwards data frames and close, text normalized", async () => {
  const session = waitingSession();
  const handle = session.openSocketStream({ path: "/ws", headers: {} });
  const seen = [];
  handle.onMessage((m) => seen.push(m));
  session.agent.emitMessage(
    JSON.stringify({ t: "data", id: 1, b64: base64Of("txt"), text: true }),
  );
  session.agent.emitMessage(
    JSON.stringify({ t: "data", id: 1, b64: base64Of("bin"), text: false }),
  );
  // text 归一化：缺失视为文本（Worker 语义 frame.text === false 才是二进制）
  session.agent.emitMessage(
    JSON.stringify({ t: "data", id: 1, b64: base64Of("dflt") }),
  );
  assert.deepEqual(seen, [
    { bytes: new TextEncoder().encode("txt"), text: true },
    { bytes: new TextEncoder().encode("bin"), text: false },
    { bytes: new TextEncoder().encode("dflt"), text: true },
  ]);
  handle.close();
  assert.deepEqual(session.agent.sent.at(-1), { t: "close", id: 1 });
  assert.equal(session.streamCount(), 0);
});
