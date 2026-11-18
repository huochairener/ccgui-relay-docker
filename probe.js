// Standalone probe: run ON the server (or on the PC) to test the edge -> origin hop.
// Zero dependencies: works without npm install.
// Usage: RELAY_KEY=<your-key> node probe.js <edge-url>
// e.g. RELAY_KEY=xxx node probe.js https://ccgui-relay.example.cn
//
// [1] plain HTTP through the edge (phone page path)
// [2] /agent auth sanity (403 forbidden = our relay answered, origin reachable)
// [3] WebSocket upgrade through the edge with the REAL key — exactly what the
//     desktop's /agent long connection and the phone's /ws control socket need.
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

const base = process.argv[2]?.replace(/\/$/, "");
if (!base) {
  console.error("usage: RELAY_KEY=<your-key> node probe.js <edge-url>");
  process.exit(1);
}
const key = process.env.RELAY_KEY ?? "";
const ms = (n) => `${n}ms`;

/** Minimal WebSocket-upgrade probe over http/https, no deps. */
function wsProbe(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const done = (msg) => resolve(`${msg} in ${ms(Date.now() - t0)}`);
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(url.replace(/^ws/, "http"), {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        // random per-connection key, as a real client would send
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
      },
      timeout: timeoutMs,
    });
    req.on("upgrade", (res) => {
      res.socket.destroy();
      done(`UPGRADED (101 ${res.status === 101 ? "ok" : res.status})`);
    });
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => {
        if (chunks.length < 3) chunks.push(c.toString().slice(0, 120));
      });
      res.on("end", () => done(`NO UPGRADE: ${res.statusCode} ${chunks.join(" ").slice(0, 120)}`));
      res.on("error", () => done(`NO UPGRADE: ${res.statusCode}`));
    });
    req.on("timeout", () => {
      req.destroy();
      done("TIMEOUT (no upgrade response in 15s)");
    });
    req.on("error", (e) => done(`ERROR: ${e.message}${e.cause?.code ? " " + e.cause.code : ""}`));
    req.end();
  });
}

async function main() {
  // 1. plain HTTP through the edge
  let t0 = Date.now();
  try {
    const r = await fetch(base + "/");
    console.log(`[1] GET /            -> ${r.status} in ${ms(Date.now() - t0)} : ${(await r.text()).slice(0, 60).replace(/\n/g, " ")}`);
  } catch (e) {
    console.log(`[1] GET /            -> FAIL ${ms(Date.now() - t0)}: ${e.message} ${e.cause?.code ?? ""}`);
  }

  // 2. agent path sanity (expect 403 "forbidden" from our relay with a wrong key)
  t0 = Date.now();
  try {
    const r = await fetch(`${base}/agent?key=probe-wrong-key`);
    console.log(`[2] GET /agent?wrong -> ${r.status} in ${ms(Date.now() - t0)} : ${(await r.text()).slice(0, 60)}`);
  } catch (e) {
    console.log(`[2] GET /agent?wrong -> FAIL ${ms(Date.now() - t0)}: ${e.message} ${e.cause?.code ?? ""}`);
  }

  // 3. WebSocket upgrade with the real key — the critical one.
  // The handshake itself is plain HTTP, so ws:// -> http:// for the request.
  const wsUrl = `${base.replace(/^http/, "ws")}/agent?key=${encodeURIComponent(key)}`;
  console.log(`[3] WS  /agent       -> ${await wsProbe(wsUrl)}`);
  process.exit(0);
}
main();
