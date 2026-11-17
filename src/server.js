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

const SERVER_MESSAGE = "CC GUI 桌面端未连接到中继。请在电脑上打开 CC GUI → 设置 → 远程访问 → 外网访问，启动中转。";

/** Headers the relay strips before forwarding (Worker equivalents + edge-origin noise). */
function isDroppedHeader(name) {
  return (
    name === "host" ||
    name === "upgrade" ||
    name.startsWith("sec-websocket-") ||
    name.startsWith("cf-") ||
    name.startsWith("x-forwarded-")
  );
}

/**
 * Framing headers the hop itself decides: the relay chunks streaming
 * responses itself, so a desktop-declared content-length lies about the
 * body (truncation) or conflicts with transfer-encoding (unparseable
 * response). Never forward them.
 */
const FRAMING_HEADERS = new Set(["content-length", "transfer-encoding", "connection", "keep-alive", "trailer", "upgrade"]);

function filterHeaders(rawHeaders) {
  const out = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (isDroppedHeader(name) || FRAMING_HEADERS.has(name)) continue;
    out[name] = rawHeaders[i + 1];
  }
  return out;
}

const MAX_BODY = 8 * 1024 * 1024; // 8 MiB cap: a huge Content-Length must not OOM the relay

/**
 * Attach the error listener every ws needs: ws emits 'error' for protocol
 * violations (e.g. a frame over maxPayload) and an unlistened 'error' on
 * an EventEmitter is an uncaught exception — one anonymous frame could
 * kill the whole process.
 */
const killWs = (ws) => {
  ws.on("error", () => {
    try {
      ws.terminate();
    } catch {}
  });
  return ws;
};

function aggregateBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const parts = [];
    let failed = false;
    let tooLarge = false;
    let size = 0;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      reject(err);
    };
    req.on("data", (chunk) => {
      if (failed) return; // oversized/aborted: keep draining, discard
      size += chunk.length;
      if (size > MAX_BODY) {
        // Do not destroy the socket: an early RST makes the client's
        // in-flight upload die with a socket error before it can read the
        // 413. Keep draining (discarding) to the end, then reject.
        tooLarge = true;
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      if (tooLarge) fail(new Error("request body too large"));
      else resolve(Buffer.concat(parts));
    });
    // A phone-side cancel (ECONNRESET mid-body) must not become an unhandled
    // rejection: the connection is dead, so just swallow and let the request
    // handler observe `failed` via the close event.
    req.on("error", () => fail(new Error("request aborted")));
    // Node does not reliably emit 'error' on a clean client disconnect
    // mid-body; without this the handler can hang until requestTimeout.
    req.on("close", () => {
      if (!req.complete) fail(new Error("client aborted mid-body"));
    });
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
  // Cloudflare caps Worker WebSocket frames at 1 MiB; matching it keeps both
  // entries on one protocol envelope and bounds memory amplification.
  const wss = new WebSocketServer({ noServer: true, clientTracking: true, maxPayload: 1024 * 1024 });
  // Handshake-layer errors must not reach the uncaught-exception handler.
  wss.on("error", () => {});

  // Dead desktops (network drop without FIN) keep readyState "open" for a
  // long time; ping/pong reaps them so phones fail fast instead of waiting
  // out the 30s head timeout on every request.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {}
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, 30000);
  heartbeat.unref?.();

  const handle = /** @type {any} */ ({});

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (e) {
      // Anything that escapes (client abort mid-body, oversized body,
      // unexpected state) must not take the process down — the socket is
      // likely dead anyway; answer what we still can.
      if (!res.headersSent && res.writable) {
        try {
          const tooLarge = e instanceof Error && e.message === "request body too large";
          res.writeHead(tooLarge ? 413 : 502, { "content-type": "text/plain; charset=utf-8" });
          res.end(tooLarge ? "request body too large" : "relay request aborted");
        } catch {}
      } else {
        try {
          res.end();
        } catch {}
      }
    }
  });

  async function handleRequest(req, res) {
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

    // Plain HTTP tunnel: stream the desktop's head, then every data frame as
    // it arrives (the Worker used a ReadableStream; chunked transfer keeps the
    // same streaming semantics over node:http).
    const body = await aggregateBody(req);
    let resEnded = false;
    let headWritten = false;
    let paused = false; // res.write backpressure: buffer until "drain"
    let bufferedBytes = 0;
    const MAX_BUFFERED = 4 * 1024 * 1024; // cap the backpressure buffer too
    /** @type {Uint8Array[]} buffered until writeHead commits the real headers / drain fires */
    const pendingChunks = [];
    const closeAfterHead = { value: false };
    const endRes = () => {
      if (resEnded) return;
      resEnded = true;
      res.end();
    };
    const flushPendingChunks = () => {
      if (resEnded || headWritten === false || paused) return;
      for (const chunk of pendingChunks.splice(0)) {
        const ok = res.write(chunk);
        if (!ok) {
          paused = true;
          res.once("drain", () => {
            paused = false;
            flushPendingChunks();
          });
          break;
        }
      }
    };
    let streamHandle = null;
    res.on("close", () => {
      // Cancel only if the response was still live: endRes() paths (normal
      // end, timeout, invalid status) have already settled the stream, and a
      // second close frame for a dead id would just confuse the desktop.
      const wasLive = !resEnded;
      resEnded = true; // client vanished: stop accepting chunks
      if (wasLive) streamHandle?.cancel();
    });
    const writeChunk = (bytes) => {
      if (resEnded) return;
      if (!headWritten || paused) {
        if (bufferedBytes + bytes.length > MAX_BUFFERED) {
          // Backpressure beyond the cap: fail this response instead of
          // buffering without bound (slow phone + big file = unbounded heap).
          if (!headWritten && !resEnded) {
            headWritten = true;
            try {
              res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
            } catch {}
          }
          try {
            streamHandle?.cancel();
          } catch {}
          endRes();
          return;
        }
        pendingChunks.push(bytes); // res.write before writeHead sends implicit headers / while paused
        bufferedBytes += bytes.length;
        return;
      }
      const ok = res.write(bytes);
      if (!ok && !resEnded) {
        paused = true;
        res.once("drain", () => {
          paused = false;
          flushPendingChunks();
        });
      }
    };
    const pending = session.openHttpStream({
      method: req.method,
      path: req.url,
      headers: filterHeaders(req.rawHeaders),
      body: new Uint8Array(body),
      onChunk: writeChunk,
      onClose: () => {
        // The head may not be written yet (close/error raced ahead of the
        // await continuation). Write it now, then end — never an implicit 200.
        if (!headWritten && !resEnded) {
          headWritten = true;
          try {
            res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          } catch {}
        }
        endRes();
      },
    });
    streamHandle = pending;
    const { status, headers: resHeaders, timedOut } = await pending.head;
    if (timedOut) {
      // Head timeout: relay.js deferred onClose as a macrotask, so the await
      // continuation wins the race and the 504 must be written HERE — the
      // deferred onClose would otherwise fall back to a bare 502. The relay
      // has already settled the stream, so no cancel is needed.
      if (!headWritten && !resEnded) {
        headWritten = true;
        try {
          res.writeHead(504, { "content-type": "text/plain; charset=utf-8" });
          res.write("desktop did not respond within the head timeout");
        } catch {}
        for (const chunk of pendingChunks.splice(0)) res.write(chunk);
      }
      endRes();
      return;
    }
    closeAfterHead.value = resEnded; // close frame beat the await continuation
    // Desktop-controlled head: a corrupt or malicious frame must never crash
    // the server (ERR_INVALID_CHAR / ERR_HTTP_INVALID_STATUS_CODE are thrown
    // synchronously by writeHead and nothing downstream catches them).
    const validStatus = Number.isInteger(status) && status >= 100 && status <= 599;
    const safeHeaders = {};
    if (validStatus) {
      for (const [name, value] of Object.entries(resHeaders ?? {})) {
        if (
          !/^[!-~]+$/.test(name) ||
          typeof value !== "string" ||
          /[\r\n\0]/.test(value) ||
          !/^[\t -~]*$/.test(value)
        ) {
          continue; // drop the poisoned header, keep the rest
        }
        // Framing headers describe THIS hop's transport, not the payload:
        // the relay chunks streaming responses itself, so a desktop-declared
        // content-length silently truncates the body and transfer-encoding
        // conflicts with it. Never forward them.
        if (FRAMING_HEADERS.has(name)) continue;
        safeHeaders[name] = value;
      }
    }
    if (!headWritten && !resEnded) {
      headWritten = true;
      try {
        res.writeHead(validStatus ? status : 502, validStatus ? safeHeaders : { "content-type": "text/plain; charset=utf-8" });
      } catch {
        try {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        } catch {}
      }
    }
    flushPendingChunks();
    if (closeAfterHead.value || !validStatus) {
      // An invalid status means the desktop frame is corrupt: the stream in
      // session.streams would otherwise keep receiving data forever.
      if (!validStatus) streamHandle.cancel();
      endRes();
    }
    // Otherwise the desktop may still be streaming; res.end() arrives via onClose.
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://relay.local");
    if (url.pathname === "/agent") {
      if (url.searchParams.get("key") !== relayKey) {
        socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        killWs(ws);
        ws.isAlive = true;
        ws.on("pong", () => {
          ws.isAlive = true;
        });
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
      killWs(ws);
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      const headers = filterHeaders(req.rawHeaders);
      const streamHandle = session.openSocketStream({ path: req.url, headers });
      streamHandle.onMessage(({ bytes, text }) => {
        try {
          if (text) ws.send(new TextDecoder().decode(bytes));
          else ws.send(bytes);
        } catch {}
      });
      streamHandle.onClose(({ code, reason }) => {
        try {
          ws.close(code, reason);
        } catch {}
      });
      ws.on("message", (data, isBinary) => {
        const bytes = isBinary ? data : new TextEncoder().encode(data.toString());
        session.sendData(streamHandle.id, new Uint8Array(bytes), !isBinary);
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
          clearInterval(heartbeat);
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
  const handle = startServer({ relayKey, port });
  try {
    await handle.ready();
  } catch (e) {
    // EADDRINUSE and friends must be loud: a silent exit 0 under Docker's
    // restart loop looks like a healthy crash cycle.
    console.error(`CC GUI relay failed to start: ${e?.code ?? ""} ${e?.message ?? e}`);
    process.exit(1);
  }
  console.log(
    `CC GUI relay listening on 0.0.0.0:${handle.port} — desktop connects to /agent?key=<RELAY_KEY>`,
  );
}

const thisFile = path.resolve(fileURLToPath(import.meta.url));
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked && invoked === thisFile) {
  main();
}
