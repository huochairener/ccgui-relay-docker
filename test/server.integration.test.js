import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";

const KEY = "test-key-123";

// --- helpers -------------------------------------------------------------
/** Per-socket message queue so no frame is lost between awaits. */
function makeFrameQueue(ws) {
  const queue = [];
  const waiters = [];
  ws.on("message", (data, isBinary) => {
    const item = { data, isBinary };
    if (waiters.length) waiters.shift()(item);
    else queue.push(item);
  });
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`unexpected status ${res.statusCode}`)),
    );
  });
}

function onceClosed(ws, code) {
  return new Promise((resolve, reject) => {
    ws.once("close", (c) => {
      if (code === undefined || c === code) resolve(c);
      else reject(new Error(`closed with ${c}, expected ${code}`));
    });
    ws.once("error", reject);
  });
}

/** Resolves with the next JSON frame the agent socket receives (queue-based). */
function nextFrame(agent) {
  return agent.__frames.next().then(({ data }) => JSON.parse(data.toString()));
}

function nextMessage(ws) {
  return ws.__frames.next().then(({ data, isBinary }) => {
    if (isBinary) throw new Error("expected a text frame");
    return data.toString();
  });
}

function nextBinary(ws) {
  return ws.__frames.next().then(({ data, isBinary }) => {
    if (!isBinary) throw new Error("expected a binary frame");
    return data;
  });
}

async function attachedAgent(port) {
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?key=${KEY}`);
  agent.__frames = makeFrameQueue(agent);
  await onceOpen(agent);
  return agent;
}

// --- tests ---------------------------------------------------------------

test("rejects /agent without the right key with 403", async () => {
  const handle = startServer({ relayKey: KEY, port: 0 });
  await handle.ready();
  const { port, close } = handle;
  const res = await fetch(`http://127.0.0.1:${port}/agent?key=wrong`);
  assert.equal(res.status, 403);
  await close();
});

test("rejects non-upgrade /agent with 426", async () => {
  const handle = startServer({ relayKey: KEY, port: 0 });
  await handle.ready();
  const { port, close } = handle;
  const res = await fetch(`http://127.0.0.1:${port}/agent?key=${KEY}`);
  assert.equal(res.status, 426);
  await close();
});

test("phone request without a desktop answers 503 with the Chinese message", async () => {
  const handle = startServer({ relayKey: KEY, port: 0 });
  await handle.ready();
  const { port, close } = handle;
  const res = await fetch(`http://127.0.0.1:${port}/whatever?token=x`);
  assert.equal(res.status, 503);
  assert.ok((await res.text()).includes("桌面端未连接到中继"));
  await close();
});

test("/healthz answers without a desktop and reports its state", async () => {
  const handle = startServer({ relayKey: KEY, port: 0 });
  await handle.ready();
  const { port, close } = handle;
  // No desktop attached: the health check must still answer, so it can tell
  // "the edge never reached the origin" apart from "the desktop is offline".
  let res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.desktop, false);

  const agent = await attachedAgent(port);
  res = await fetch(`http://127.0.0.1:${port}/healthz`);
  body = await res.json();
  assert.equal(body.desktop, true);
  agent.close();
  await close();
});

test("protocol events reach the transport logger", async () => {
  // A head timeout must be visible in the log: on a remote server behind an
  // edge proxy, "the phone page never starts" is otherwise untraceable.
  const lines = [];
  const logger = {
    error: (m, e) => lines.push(["error", m, e]),
    warn: (m, e) => lines.push(["warn", m, e]),
    info: (m, e) => lines.push(["info", m, e]),
    debug: (m, e) => lines.push(["debug", m, e]),
  };
  const handle = startServer({ relayKey: KEY, port: 0, headTimeoutMs: 100, logger });
  await handle.ready();
  const { port, close } = handle;
  const agent = await attachedAgent(port);
  const res = await fetch(`http://127.0.0.1:${port}/slow`);
  assert.equal(res.status, 504);
  const timeoutLine = lines.find(([lvl, msg]) => lvl === "warn" && msg.includes("head-timeout"));
  assert.ok(timeoutLine, "head timeout must be logged");
  assert.equal(timeoutLine[2].path, "/slow");
  agent.close();
  await close();
});

test("HTTP round-trip through the desktop socket", async () => {
  const handle = startServer({ relayKey: KEY, port: 0 });
  await handle.ready();
  const { port, close } = handle;
  const agent = await attachedAgent(port);
  const phone = fetch(`http://127.0.0.1:${port}/api/data?token=app-token`, {
    method: "POST",
    body: "payload",
    headers: { "content-type": "text/plain", "x-app-token": "t" },
  });
  const open = await nextFrame(agent);
  assert.equal(open.t, "open");
  assert.equal(open.method, "POST");
  assert.equal(open.path, "/api/data?token=app-token");
  assert.ok(!("host" in open.headers));
  assert.ok(
    Object.keys(open.headers).every(
      (h) => !h.startsWith("cf-") && !h.startsWith("x-forwarded-"),
    ),
  );
  assert.equal(open.headers["x-app-token"], "t");
  const body = await nextFrame(agent);
  assert.equal(body.t, "body");
  assert.equal(Buffer.from(body.b64, "base64").toString(), "payload");
  const end = await nextFrame(agent);
  assert.equal(end.t, "end");
  agent.send(JSON.stringify({ t: "head", id: open.id, status: 200, headers: { "content-type": "text/plain" } }));
  agent.send(JSON.stringify({ t: "data", id: open.id, b64: Buffer.from("ok").toString("base64"), text: true }));
  agent.send(JSON.stringify({ t: "close", id: open.id }));
  const res = await phone;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  agent.close();
  await close();
});

test("websocket round-trip keeps text and binary frame types", async () => {
  const handle = startServer({ relayKey: KEY, port: 0 });
  await handle.ready();
  const { port, close } = handle;
  const agent = await attachedAgent(port);
  const app = new WebSocket(`ws://127.0.0.1:${port}/ws?token=app-token`);
  app.__frames = makeFrameQueue(app);
  await onceOpen(app);
  const open = await nextFrame(agent);
  assert.equal(open.t, "open");
  assert.equal(open.ws, true);
  assert.equal(open.path, "/ws?token=app-token");

  // app → relay → desktop: text frames carry text:true, binary text:false
  app.send("hello");
  const d1 = await nextFrame(agent);
  assert.equal(d1.t, "data");
  assert.equal(d1.text, true);
  assert.equal(Buffer.from(d1.b64, "base64").toString(), "hello");

  app.send(Uint8Array.from([0, 255, 1]));
  const d2 = await nextFrame(agent);
  assert.equal(d2.text, false);
  assert.deepEqual(Array.from(Buffer.from(d2.b64, "base64")), [0, 255, 1]);

  // desktop → relay → app: text:true delivers a text frame, text:false binary
  agent.send(JSON.stringify({ t: "data", id: open.id, b64: Buffer.from("re:hi").toString("base64"), text: true }));
  assert.equal(await nextMessage(app), "re:hi");
  agent.send(JSON.stringify({ t: "data", id: open.id, b64: Buffer.from([9, 250]).toString("base64"), text: false }));
  assert.deepEqual(Array.from(await nextBinary(app)), [9, 250]);

  // app closes → desktop sees a close frame for that stream
  const appClosed = onceClosed(app);
  app.close();
  assert.equal((await nextFrame(agent)).t, "close");
  await appClosed;

  agent.close();
  await close();
});

test("desktop reconnect replaces the old socket; new streams go to the new socket", async () => {
  const handle = startServer({ relayKey: KEY, port: 0 });
  await handle.ready();
  const { port, close } = handle;
  const a1 = await attachedAgent(port);
  fetch(`http://127.0.0.1:${port}/pending`, { method: "GET" }); // in-flight stream on a1
  await nextFrame(a1); // open frame for /pending

  const a2 = await attachedAgent(port); // replaces a1
  await onceClosed(a1, 1012);

  const phone = fetch(`http://127.0.0.1:${port}/after`, { method: "GET" });
  const open2 = await nextFrame(a2);
  assert.equal(open2.path, "/after");
  a2.send(JSON.stringify({ t: "head", id: open2.id, status: 201, headers: {} }));
  a2.send(JSON.stringify({ t: "close", id: open2.id }));
  assert.equal((await phone).status, 201);

  a2.close();
  await close();
});

test("desktop disconnect mid-stream answers 502 and later requests 503 again", async () => {
  const handle = startServer({ relayKey: KEY, port: 0 });
  await handle.ready();
  const { port, close } = handle;
  const agent = await attachedAgent(port);
  const phone = fetch(`http://127.0.0.1:${port}/x`, { method: "GET" });
  await nextFrame(agent); // open
  agent.close();
  const res = await phone;
  assert.equal(res.status, 502);
  const after = await fetch(`http://127.0.0.1:${port}/y`, { method: "GET" });
  assert.equal(after.status, 503);
  await close();
});

test("malformed agent frames do not kill the server", async () => {
  const handle = startServer({ relayKey: KEY, port: 0, headTimeoutMs: 5000 });
  await handle.ready();
  const { port, close } = handle;
  const agent = await attachedAgent(port);
  agent.send("this is not json");
  agent.send("}\u0000{");
  // Bad frames are ignored, desktop stays attached → the next request is
  // tunneled (not 503); a well-behaved desktop still completes the round trip.
  const phone = fetch(`http://127.0.0.1:${port}/still-alive`, { method: "GET" });
  const open = await nextFrame(agent);
  assert.equal(open.t, "open");
  assert.equal(open.path, "/still-alive");
  agent.send(JSON.stringify({ t: "head", id: open.id, status: 204, headers: {} }));
  agent.send(JSON.stringify({ t: "close", id: open.id }));
  const res = await phone;
  assert.equal(res.status, 204);
  agent.close();
  await close();
});

test("startServer without a relayKey throws", () => {
  assert.throws(() => startServer({ port: 0 }), /RELAY_KEY/);
});
test("startServer with a non-numeric port throws instead of falling back", () => {
  assert.throws(() => startServer({ relayKey: KEY, port: "not-a-port" }), /PORT/);
});

test("parsePort rejects non-numeric PORT for main()", async () => {
  const { parsePort } = await import("../src/server.js");
  assert.throws(() => parsePort("abc"), /PORT/);
  assert.throws(() => parsePort(""), /PORT/);
  assert.equal(parsePort("8787"), 8787);
  assert.equal(parsePort("0"), 0);
});

// --- review regression tests ---------------------------------------------

test("oversized ws frame from anonymous phone does not crash the server", async () => {
  const handle = startServer({ relayKey: KEY, port: 0, headTimeoutMs: 1000 });
  await handle.ready();
  const { port, close } = handle;
  const agent = await attachedAgent(port);
  const app = new WebSocket(`ws://127.0.0.1:${port}/ws?token=t`);
  app.__frames = makeFrameQueue(app);
  await onceOpen(app);
  app.on("error", () => {}); // the 1009 close is expected here
  app.send(Buffer.alloc(2 * 1024 * 1024)); // over maxPayload: must close, not crash
  await new Promise((r) => setTimeout(r, 150));
  // The terminated app socket emits close → a close(id) frame for the dead
  // stream also lands on the agent socket; only the fresh /still-up open
  // (its own id) is the round-two stream.
  const phone = fetch(`http://127.0.0.1:${port}/still-up`, { method: "GET" });
  let open = null;
  for (let i = 0; i < 6 && !open; i++) {
    const f = await nextFrame(agent);
    if (f.t === "open" && String(f.path).includes("/still-up")) open = f;
  }
  assert.ok(open, "expected the /still-up open frame");
  for (let i = 0; i < 3; i++) {
    const f = await nextFrame(agent);
    if (f.t === "end") break;
  }
  agent.send(JSON.stringify({ t: "head", id: open.id, status: 200, headers: {} }));
  agent.send(JSON.stringify({ t: "close", id: open.id }));
  assert.equal((await phone).status, 200);
  app.close();
  agent.close();
  await close();
});

test("desktop framing headers are stripped from the response head", async () => {
  const handle = startServer({ relayKey: KEY, port: 0, headTimeoutMs: 2000 });
  await handle.ready();
  const { port, close } = handle;
  const agent = await attachedAgent(port);
  const phone = fetch(`http://127.0.0.1:${port}/liar`, { method: "GET" });
  const open = await nextFrame(agent);
  agent.send(
    JSON.stringify({
      t: "head",
      id: open.id,
      status: 200,
      headers: { "content-length": "2", "content-type": "text/plain", "transfer-encoding": "chunked", "x-keep": "yes" },
    }),
  );
  agent.send(JSON.stringify({ t: "data", id: open.id, b64: Buffer.from("0123456789").toString("base64"), text: true }));
  agent.send(JSON.stringify({ t: "close", id: open.id }));
  const res = await phone;
  assert.equal(res.status, 200);
  // The lying content-length must not truncate the body; TE/CL must not coexist.
  assert.equal(await res.text(), "0123456789");
  assert.equal(res.headers.get("x-keep"), "yes");
  assert.equal(res.headers.get("content-length"), null);
  agent.close();
  await close();
});

test("head timeout answers 504 with a message, not a bare 502", async () => {
  const handle = startServer({ relayKey: KEY, port: 0, headTimeoutMs: 100 });
  await handle.ready();
  const { port, close } = handle;
  const agent = await attachedAgent(port);
  const phone = fetch(`http://127.0.0.1:${port}/slow`, { method: "GET" });
  await nextFrame(agent); // open; desktop never answers
  const res = await phone;
  assert.equal(res.status, 504);
  assert.ok((await res.text()).includes("timeout"));
  agent.close();
  await close();
});

test("phone abort mid-stream cancels the relay stream", async () => {
  const handle = startServer({ relayKey: KEY, port: 0, headTimeoutMs: 30000 });
  await handle.ready();
  const { port, close, session } = handle;
  const agent = await attachedAgent(port);
  agent.on("message", (d) => {
    const f = JSON.parse(d.toString());
    if (f.t === "open") {
      agent.send(JSON.stringify({ t: "head", id: f.id, status: 200, headers: { "content-type": "text/plain" } }));
    }
  });
  const ac = new AbortController();
  fetch(`http://127.0.0.1:${port}/stream`, { signal: ac.signal }).catch(() => {});
  await nextFrame(agent); // open
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(session.streamCount(), 1);
  ac.abort();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(session.streamCount(), 0); // must not leak
  // Desktop saw the close frame for the aborted stream (after open/body?/end).
  let closeFrame;
  for (let i = 0; i < 4; i++) {
    closeFrame = await agent.__frames.next().then(({ data }) => JSON.parse(data.toString()));
    if (closeFrame.t === "close") break;
  }
  assert.equal(closeFrame.t, "close");
  agent.close();
  await close();
});

test("request body over MAX_BODY answers 413", async () => {
  const handle = startServer({ relayKey: KEY, port: 0, headTimeoutMs: 1000 });
  await handle.ready();
  const { port, close } = handle;
  await attachedAgent(port);
  // 9 MiB > 8 MiB cap
  const res = await fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", body: Buffer.alloc(9 * 1024 * 1024) });
  assert.equal(res.status, 413);
  await close();
});
