/**
 * CC GUI 中继（Cloudflare Worker）——让手机在外网访问本机 CC GUI，而无需在
 * 本机开放任何入站端口。
 *
 * 桌面端主动外连 /agent?key=<secret> 并保持一条 WebSocket；此后每个进来的请求
 * 都成为这条连接上的一条流，因此「谁能进来」仍然只由桌面端自己的桥接决定：URL
 * 里的 token 与逐设备授权都在应用内完成。本 Worker 只校验 key 并搬运字节。
 *
 * 流是具名且多路复用的，每个 key 一个 Durable Object 持有 agent socket，所以
 * 重连的桌面端永远不会和自己交错。
 *
 * ---
 *
 * CC GUI relay: lets a phone reach the desktop app without opening any
 * inbound port on the desktop.
 *
 * The desktop dials OUT to /agent?key=<secret> and keeps one WebSocket open.
 * Every request that arrives here becomes a stream on that socket, so the
 * desktop's own bridge stays the only thing that decides who gets in: the
 * token in the URL and the per-device approval both happen inside the app.
 * This Worker only checks the key and moves bytes.
 *
 * Streams are named and multiplexed, and one Durable Object per key owns the
 * agent socket, so a reconnecting desktop can never interleave with itself.
 *
 * 协议本体在 src/relay.js（RelaySession），与自托管 Node 入口共用同一份帧实现；
 * 本文件只保留 Workers 运行时特有的部分：WebSocketPair、Durable Object 绑定。
 */

import { RelaySession } from "./relay.js";

export const AGENT_PATH = "/agent";

// A huge request body must not pin DO memory (OOM / CPU burn).
const MAX_BODY = 8 * 1024 * 1024;

export class RelayDO {
  constructor(state, env) {
    this.session = new RelaySession(env.RELAY_KEY);
    this.nextId = 1;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === AGENT_PATH) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected a websocket", { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      this.session.attachAgent(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!this.session.hasLiveAgent()) {
      return new Response(
        "CC GUI 桌面端未连接到中继。请在电脑上打开 CC GUI → 设置 → 远程访问 → 外网访问，启动中转。",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return request.headers.get("Upgrade") === "websocket"
      ? this.tunnelSocket(request)
      : this.tunnelHttp(request);
  }

  /**
   * Read the request body with a hard cap: memory must stay bounded even for a
   * malicious Content-Length, so count chunks while streaming instead of
   * arrayBuffer()-ing the whole thing first. Returns null when over MAX_BODY.
   */
  async _readBodyWithCap(request) {
    const reader = request.body.getReader();
    /** @type {Uint8Array[]} */
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        try {
          await reader.cancel();
        } catch {}
        return null; // too large
      }
      parts.push(value);
    }
    const out = new Uint8Array(size);
    let off = 0;
    for (const part of parts) {
      out.set(part, off);
      off += part.byteLength;
    }
    return out;
  }

  /** HTTP: request head + body in, response head + chunks streamed out. */
  async tunnelHttp(request) {
    const body = await this._readBodyWithCap(request);
    if (body === null) {
      // A huge request body must not pin DO memory: reject before tunneling.
      return new Response("request body too large", { status: 413 });
    }
    const headers = filterWorkerHeaders(request.headers);

    // Same streaming model as the original Worker: a ReadableStream keeps
    // accepting data frames after the head until close/error ends it.
    let streamController;
    const stream = new ReadableStream({
      start(c) {
        streamController = c;
      },
      // Phone aborted mid-stream: without cancel the stream stays in
      // session.streams forever and the desktop keeps pushing data.
      cancel() {
        pending?.cancel();
      },
    });

    const pending = this.session.openHttpStream({
      method: request.method,
      path: new URL(request.url).pathname + new URL(request.url).search,
      headers,
      body,
      onChunk: (bytes) => {
        try {
          streamController?.enqueue(bytes);
        } catch {}
      },
      onClose: () => {
        try {
          streamController?.close();
        } catch {}
      },
    });

    const { status, headers: resHeaders } = await pending.head;
    return new Response(stream, { status, headers: resHeaders });
  }

  /** Live socket (the app's /ws): frames travel both ways, unframed. */
  tunnelSocket(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const headers = filterWorkerHeaders(request.headers, [
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-extensions",
    ]);
    const path = new URL(request.url).pathname + new URL(request.url).search;

    const handle = this.session.openSocketStream({ path, headers });
    handle.onMessage(({ bytes, text }) => {
      try {
        // The app's client reads JSON; a frame the desktop sent as text must
        // not turn into a Blob on the way (it used to, and every response was
        // dropped).
        if (text) server.send(new TextDecoder().decode(bytes));
        else server.send(bytes);
      } catch {}
    });
    handle.onClose(({ code, reason }) => {
      try {
        server.close(code, reason);
      } catch {}
    });

    server.addEventListener("message", (event) => {
      const isText = typeof event.data === "string";
      const bytes = isText ? new TextEncoder().encode(event.data) : new Uint8Array(event.data);
      this.session.sendData(handle.id, bytes, isText);
    });
    server.addEventListener("close", () => handle.close());

    return new Response(null, { status: 101, webSocket: client });
  }
}

const HOP_HEADERS = ["host", "cf-connecting-ip", "cf-ray", "upgrade", "connection"];

// The relay chunks streaming responses itself; a desktop-declared
// content-length lies about the body (truncation) or conflicts with
// transfer-encoding (unparseable response). Never forward framing headers.
const FRAMING_HEADERS = new Set(["content-length", "transfer-encoding", "keep-alive", "trailer"]);

function filterWorkerHeaders(headers, extraDrops = []) {
  const dropped = new Set([...HOP_HEADERS, ...FRAMING_HEADERS, ...extraDrops]);
  const out = {};
  for (const [name, value] of headers) {
    // The hop is TLS-terminated here; the desktop's bridge sees plain HTTP.
    if (dropped.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

export { RelayDO as Relay };
export default {
  async fetch(request, env) {
    const key = env.RELAY_KEY;
    if (!key) return new Response("relay key is not configured", { status: 500 });
    const url = new URL(request.url);

    // 1. The desktop's own connection: /agent?key=<secret>.
    if (url.pathname === AGENT_PATH) {
      if (url.searchParams.get("key") !== key) return new Response("forbidden", { status: 403 });
      return env.RELAY.get(env.RELAY.idFromName(key)).fetch(request);
    }

    // 2. Everyone else is the phone, and its URL carries the app's own token:
    //    the desktop's bridge is what decides (token + per-device approval),
    //    so this Worker holds no policy beyond "is there a desktop attached".
    return env.RELAY.get(env.RELAY.idFromName(key)).fetch(request);
  },
};
