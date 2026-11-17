/**
 * CC GUI 中继 · 自托管 Node 服务器入口。
 *
 * Self-hosted Node relay entry: same frame protocol as the Cloudflare Worker
 * (src/relay.js is shared), one RelaySession per relay key, one live desktop
 * WebSocket per session. Serves plain HTTP and WebSocket tunnels on a single
 * port bound to 0.0.0.0 — Tencent EO / Alibaba ESA can use it as an origin.
 *
 * 与 Worker 相同的语义：key 只在 /agent 校验（手机路径的 token 与逐设备授权
 * 仍由 CC GUI 桌面端桥接决定）；无活动桌面连接的请求回 503。
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { RelaySession } from "./relay.js";
import { base64FromBytes } from "./base64.js";

const SERVER_MESSAGE = "CC GUI 桌面端未连接到中继。请在电脑上打开 CC GUI → 设置 → 远程访问 → 外网访问，启动中转。";

/** Headers the relay strips before forwarding (Worker equivalents + edge-origin noise). */
function isDroppedHeader(name) {
  return (
    name === "host" ||
    name === "connection" ||
    name === "upgrade" ||
    name.startsWith("sec-websocket-") ||
    name.startsWith("cf-") ||
    name.startsWith("x-forwarded-")
  );
}

function filterHeaders(rawHeaders) {
  const out = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (isDroppedHeader(name)) continue;
    out[name] = rawHeaders[i + 1];
  }
  return out;
}

function aggregateBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const parts = [];
    req.on("data", (chunk) => parts.push(chunk));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/**
 * @param {{ relayKey: string, port?: number|string, host?: string, headTimeoutMs?: number }} options
 * @returns {{ port: number, host: string, session: RelaySession, ready(): Promise<void>, close(): Promise<void> }}
 *   `port`/`host` are filled once `ready()` resolves; `port: 0` binds an ephemeral port.
 */
export function startServer(options) {
  const { relayKey } = options ?? {};
  if (!relayKey) throw new Error("RELAY_KEY is not set");
  const port = parsePort(options.port ?? 0);
  const host = options.host ?? "0.0.0.0";
  const headTimeoutMs = options.headTimeoutMs ?? 30000;

  const session = new RelaySession(relayKey, { headTimeoutMs });
  const wss = new WebSocketServer({ noServer: true });

  const handle = /** @type {any} */ ({});

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://relay.local");

    // 1. The desktop's own connection: /agent?key=<secret>.
    if (url.pathname === "/agent") {
      if (url.searchParams.get("key") !== relayKey) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("forbidden");
        return;
      }
      // A WebSocket upgrade on /agent reaches the http.Server "upgrade" event,
      // not this request handler — a plain GET here means the client never
      // asked for an upgrade.
      res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
      res.end("expected a websocket");
      return;
    }

    // 2. Everyone else is the phone. Its URL carries the app's own token; the
    //    desktop's bridge decides (token + per-device approval), so this relay
    //    holds no policy beyond "is there a desktop attached".
    if (!session.hasLiveAgent()) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end(SERVER_MESSAGE);
      return;
    }

    // A phone WebSocket upgrade reaches the http.Server "upgrade" event; a
    // plain request here is an HTTP tunnel.
    const body = await aggregateBody(req);
    const pending = session.openHttpStream({
      method: req.method,
      path: req.url,
      headers: filterHeaders(req.rawHeaders),
      body: new Uint8Array(body),
    });
    const { status, headers, chunks } = await pending;
    res.writeHead(status, headers);
    for (const chunk of chunks) res.write(chunk);
    res.end();
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://relay.local");
    if (url.pathname === "/agent") {
      if (url.searchParams.get("key") !== relayKey) {
        socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        session.attachAgent(ws);
        wss.emit("connection", ws, req);
      });
      return;
    }
    // Phone WebSocket tunnel: same contract as the Worker's tunnelSocket.
    if (!session.hasLiveAgent()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const headers = filterHeaders(req.rawHeaders);
      const streamHandle = session.openSocketStream({ path: req.url, headers });
      streamHandle.onMessage(({ bytes, text }) => {
        try {
          if (text) ws.send(new TextDecoder().decode(bytes));
          else ws.send(bytes);
        } catch {}
      });
      ws.on("message", (data, isBinary) => {
        const bytes = isBinary ? data : new TextEncoder().encode(data.toString());
        session.send({ t: "data", id: streamHandle.id, b64: base64FromBytes(bytes), text: !isBinary });
      });
      ws.on("close", () => streamHandle.close());
    });
  });

  const ready = new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      handle.port = server.address().port;
      handle.host = host;
      resolveListen();
    });
  });

  handle.ready = () => ready;
  handle.session = session;
  handle.close = () =>
    ready.then(
      () =>
        new Promise((resolveClose) => {
          wss.clients.forEach((ws) => {
            try {
              ws.close(1012, "server shutting down");
            } catch {}
          });
          server.closeAllConnections?.();
          server.close(() => resolveClose());
        }),
    );
  return handle;
}

/**
 * Parse a PORT value; non-numeric or negative input throws (no silent
 * fallback — a mistyped PORT must not quietly bind somewhere else).
 */
export function parsePort(value, label = "PORT") {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "") throw new Error(`${label} must be a non-negative integer, got: ${value}`);
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    throw new Error(`${label} must be a non-negative integer, got: ${value}`);
  }
  return num;
}

/** CLI entry: reads RELAY_KEY / PORT from the environment. */
export async function main() {
  const relayKey = process.env.RELAY_KEY;
  if (!relayKey) {
    console.error("RELAY_KEY is not set. Start with: RELAY_KEY=<your key> npm start");
    process.exit(1);
  }
  let port = 8787;
  const portEnv = process.env.PORT;
  if (portEnv !== undefined && portEnv !== "") {
    try {
      port = parsePort(portEnv);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
  const { port: boundPort } = await startServer({ relayKey, port });
  console.log(
    `CC GUI relay listening on 0.0.0.0:${boundPort} — desktop connects to /agent?key=<RELAY_KEY>`,
  );
}

const thisFile = path.resolve(fileURLToPath(import.meta.url));
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked && invoked === thisFile) {
  main();
}
