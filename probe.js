// Standalone probe: run ON the server to test the EO/ESA -> origin hop.
// Usage: node probe.js <edge-url> <relay-key-from-env>
// e.g. RELAY_KEY=xxx node probe.js https://edge.example.com
const base = process.argv[2]?.replace(/\/$/, "");
if (!base) { console.error("usage: node probe.js <edge-url>"); process.exit(1); }
const key = process.env.RELAY_KEY ?? "";

const t = (ms) => `${ms}ms`;

async function main() {
  // 1. plain HTTP through the edge
  let t0 = Date.now();
  try {
    const r = await fetch(base + "/");
    console.log(`[1] GET /            -> ${r.status} in ${t(Date.now() - t0)} : ${(await r.text()).slice(0, 60).replace(/\n/g, " ")}`);
  } catch (e) { console.log(`[1] GET /            -> FAIL ${t(Date.now() - t0)}: ${e.message} ${e.cause?.code ?? ""}`); }

  // 2. agent path sanity (expect 403 with wrong key, never a hang)
  t0 = Date.now();
  try {
    const r = await fetch(`${base}/agent?key=probe-wrong-key`);
    console.log(`[2] GET /agent?wrong -> ${r.status} in ${t(Date.now() - t0)} : ${(await r.text()).slice(0, 60)}`);
  } catch (e) { console.log(`[2] GET /agent?wrong -> FAIL ${t(Date.now() - t0)}: ${e.message} ${e.cause?.code ?? ""}`); }

  // 3. WebSocket upgrade through the edge — this is what the desktop AND the phone both need
  t0 = Date.now();
  try {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/agent?key=${encodeURIComponent(key)}`);
    const done = (msg) => { console.log(`[3] WS  /agent       -> ${msg} in ${t(Date.now() - t0)}`); process.exit(0); };
    ws.on("open", () => done("OPEN (upgrade ok)"));
    ws.on("error", (e) => done(`ERROR: ${e.message}`));
    setTimeout(() => done("TIMEOUT (no upgrade response in 15s)"), 15000);
  } catch (e) { console.log(`[3] WS upgrade      -> FAIL: ${e.message}`); }
}
main();
