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
  // 0. health check: identifies which hop replies (relay vs edge) and needs
  //    no desktop, so it works even while the app is broken.
  let t0 = Date.now();
  try {
    const r = await fetch(base + "/healthz");
    const body = (await r.text()).slice(0, 80).replace(/\n/g, " ");
    console.log(`[0] GET /healthz     -> ${r.status} in ${ms(Date.now() - t0)} : ${body}`);
  } catch (e) {
    console.log(`[0] GET /healthz     -> FAIL ${ms(Date.now() - t0)}: ${e.message} ${e.cause?.code ?? ""}`);
  }

  // 1. plain HTTP through the edge
  t0 = Date.now();
  try {
    const r = await fetch(base + "/");
    const body = (await r.text()).slice(0, 60).replace(/\n/g, " ");
    // Our relay never returns HTML itself: it returns plain text ("forbidden",
    // the Chinese "desktop not connected" message, or a desktop-provided
    // body). So an HTML body came from the DESKTOP app (the phone page) or
    // from an EDGE security page — the two are told apart by markers.
    const waf = /edgeone|edgeone|阿里云|腾讯云|安全防护|waf|blocked|access denied|安全网关|aliyun/i.test(body);
    const who = waf ? "EDGE security page" : body.startsWith("<") ? "desktop app page (HTML)" : "relay plain text";
    console.log(`[1] GET /            -> ${r.status} in ${ms(Date.now() - t0)} [${who}] : ${body}`);
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

  // 3. WS  /ws — the phone's control socket. This needs NO desktop and NO
  //    key, so it is safe to run: it never disturbs the running desktop.
  //    A plain-text 503 means the edge forwarded the Upgrade request to the
  //    origin intact; an HTML page or 426 means the edge broke the upgrade.
  console.log(`[3] WS  /ws          -> ${await wsProbe(`${base.replace(/^http/, "ws")}/ws`)}`);

  // 4. WS  /agent with the REAL key — the desktop's own long connection.
  //    NOTE: this replaces the running desktop's socket (the relay keeps one
  //    desktop per key), so the desktop will reconnect right after. Only run
  //    it when you can afford that, and expect the phone to fail while the
  //    desktop is reconnecting.
  const wsUrl = `${base.replace(/^http/, "ws")}/agent?key=${encodeURIComponent(key)}`;
  console.log(`[4] WS  /agent       -> ${await wsProbe(wsUrl)}`);
  process.exit(0);
}
main();
