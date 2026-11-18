/**
 * RelaySession —— 环境无关的中继协议核心。
 *
 * Environment-agnostic relay protocol core. One session per relay key holds
 * the desktop's live WebSocket and every concurrent stream riding on it. The
 * Cloudflare DO (src/worker.js) and the self-hosted Node server (src/server.js)
 * both drive this class; neither knows the frame format twice.
 *
 * 每个 relay key 一个会话：持一条桌面端活动 WebSocket 与其上的全部并发流。
 * Cloudflare DO 与自托管 Node 服务都驱动本类，帧格式只在这里写一遍。
 *
 * Frames (identical to the original Worker protocol):
 *   desktop←relay: {t:"open", id, method?, ws?, path, headers}
 *                  {t:"body", id, b64} / {t:"end", id}
 *   desktop→relay: {t:"head", id, status, headers} / {t:"data", id, b64, text}
 *                  {t:"close", id} / {t:"error", id, message}
 */

import { base64FromBytes, bytesFromBase64 } from "./base64.js";

const DEFAULT_HEAD_TIMEOUT_MS = 30000;

// workerd has no setImmediate (verified: ReferenceError); setTimeout(fn, 0)
// is the equivalent macrotask on both Node and Workers.
const defer = (fn) => setTimeout(fn, 0);

// A single agent frame must stay under both transports' 1 MiB maxPayload;
// base64 inflates by 4/3, so cap the raw payload well below (256 KiB → ~340 KiB b64).
const MAX_FRAME_BYTES = 256 * 1024;

// The desktop is the only consumer; anonymous phones can open streams without
// authenticating, so cap concurrency per session.
const MAX_STREAMS = 256;

export class RelaySession {
  /**
   * @param {string} key
   * @param {{ headTimeoutMs?: number, onEvent?: (event: string, data: any) => void }} [options]
   *   headTimeoutMs injectable for tests; onEvent reports protocol-level
   *   events the transports can't see on their own (head timeouts, frames
   *   the desktop refused, streams the desktop killed).
   */
  constructor(key, options = {}) {
    this.key = key;
    this.headTimeoutMs = options.headTimeoutMs ?? DEFAULT_HEAD_TIMEOUT_MS;
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
    /** @type {{ readyState: string, send: (s: string) => void, close: (c: number, r: string) => void } | null} */
    this.agent = null;
    this.nextId = 1;
    /**
     * Stream id → deliver(kind, frame). Kind is one of
     * "head" | "data" | "close" | "error"; the desktop-close broadcast uses "close".
     * @type {Map<number, (kind: string, frame: any) => void>}
     */
    this.streams = new Map();
  }

  hasLiveAgent() {
    // Workers' server sockets report readyState "open" (string); the `ws`
    // package uses the numeric constant WebSocket.OPEN === 1.
    const rs = this.agent?.readyState;
    return rs === "open" || rs === 1;
  }

  streamCount() {
    return this.streams.size;
  }

  /**
   * Attach the desktop's socket. A reconnecting desktop replaces the previous
   * socket: the old one is closed 1012 and every stream it carried is settled
   * so frames can never interleave between two desktop connections.
   */
  attachAgent(socket) {
    if (this.agent && this.agent !== socket) {
      // 旧连接上还有没清算完的流：先逐条投递 close，再关 socket。
      this._broadcastClose();
      try {
        this.agent.close(1012, "replaced by a new agent connection");
      } catch {}
    }
    this.agent = socket;
    socket.addEventListener("message", (event) => this.onAgentFrame(event.data));
    socket.addEventListener("close", () => {
      if (this.agent !== socket) return;
      this.agent = null;
      this._broadcastClose();
    });
  }

  _broadcastClose() {
    for (const deliver of this.streams.values()) deliver("close", {});
    this.streams.clear();
  }

  /**
   * HTTP request over the tunnel. Resolves with
   * {status, headers, chunks, done} so both transports (Worker ReadableStream,
   * Node res) can consume it.
   */
  openHttpStream({ method, path, headers, body, onChunk, onClose }) {
    const id = this.nextId++;
    let resolveHead;
    const headReady = new Promise((r) => (resolveHead = r));
    let headSeen = false;
    let timer = null;

    // Anonymous phones can open streams without authenticating; cap the
    // per-session concurrency and answer 503 instead of queueing forever.
    if (this.streams.size >= MAX_STREAMS) {
      resolveHead({ status: 503, headers: { "content-type": "text/plain; charset=utf-8" }, timedOut: false });
      // No open frame was sent and the stream was never registered, but the
      // consumer still holds the head promise and an open body: defer onClose
      // exactly like settle() so the response actually terminates.
      defer(() => {
        if (onClose) onClose();
      });
      return { head: headReady, id, cancel() {} };
    }

    const settle = (status, headers, timeoutExpired) => {
      headSeen = true;
      clearTimeout(timer);
      this.streams.delete(id);
      // Resolve first; the consumer writes the head, then the macrotask-deferred
      // onClose ends the body (never an unwritten head → implicit 200).
      resolveHead({ status, headers, timedOut: timeoutExpired });
      defer(() => {
        if (onClose) onClose();
      });
    };

    const deliver = (kind, frame) => {
      if (kind === "head") {
        if (headSeen) return;
        headSeen = true;
        clearTimeout(timer);
        this.streams.set(id, dataDeliver); // keep receiving data frames after head
        resolveHead({ status: frame.status ?? 200, headers: frame.headers ?? {} });
        return;
      }
      if (kind === "close" || kind === "error") {
        // A stream that died before its head still needs a valid response.
        if (!headSeen) {
          this._emit(kind === "error" ? "stream-error" : "stream-closed-before-head", { id, method, path, message: frame.message });
          const tail = kind === "error" ? new TextEncoder().encode(frame.message ?? "relay stream closed") : new Uint8Array(0);
          if (onChunk && tail.length) onChunk(tail);
          settle(502, { "content-type": "text/plain; charset=utf-8" }, false);
        } else {
          clearTimeout(timer);
          this.streams.delete(id);
          this._emit(kind === "error" ? "stream-error" : "stream-closed", { id, method, path, message: frame.message });
          // Head was already resolved; the consumer's await continuation must
          // write the head before we end the body. The consumer observes the
          // promise through extra .then layers, so a microtask is not enough —
          // yield a full macrotask tick.
          defer(() => {
            if (onClose) onClose();
          });
        }
      }
    };

    const dataDeliver = (kind, frame) => {
      if (kind === "data") {
        try {
          const bytes = bytesFromBase64(frame.b64);
          if (onChunk) onChunk(bytes);
        } catch {}
        return;
      }
      deliver(kind, frame);
    };

    this.streams.set(id, deliver);
    this.send({ t: "open", id, method, path, headers });
    if (body && body.length) {
      if (body.length > MAX_FRAME_BYTES) {
        // A single b64 frame of the request body would exceed the 1 MiB
        // maxPayload on both transports (1009). The desktop client's support
        // for multiple body frames per id is unverified, so fail loudly
        // instead of silently corrupting the tunnel.
        this.send({ t: "error", id, message: "request body too large for relay frame" });
        settle(413, { "content-type": "text/plain; charset=utf-8" }, false);
        return { head: headReady, id, cancel() {} };
      }
      this.send({ t: "body", id, b64: base64FromBytes(body) });
    }
    this.send({ t: "end", id });

    timer = setTimeout(() => {
      if (headSeen) return;
      this._emit("head-timeout", { id, method, path });
      this.send({ t: "close", id });
      settle(504, { "content-type": "text/plain; charset=utf-8" }, true);
    }, this.headTimeoutMs);

    const cancel = () => {
      clearTimeout(timer);
      this.streams.delete(id);
      this.send({ t: "close", id });
    };
    return { head: headReady.then(({ status, headers, timedOut }) => ({ status, headers, timedOut })), id, cancel };
  }

  /**
   * Live WebSocket tunnel (the app's /ws). Returns a handle; frames travel
   * both ways unframed at the app layer, framed (b64) on the agent socket.
   */
  openSocketStream({ path, headers }) {
    const id = this.nextId++;
    /** @type {Set<(m: {bytes: Uint8Array, text: boolean}) => void>} */
    const listeners = new Set();
    /** @type {Set<(info: {code: number, reason: string}) => void>} */
    const closeListeners = new Set();
    let closed = false;
    // Same per-session cap as HTTP streams; the phone path is unauthenticated.
    if (this.streams.size >= MAX_STREAMS) {
      const rejectHandle = {
        id,
        onMessage() {},
        onClose(cb) {
          cb({ code: 1013, reason: "too many relay streams" });
        },
        close() {},
      };
      return rejectHandle;
    }
    this.streams.set(id, (kind, frame) => {
      if (kind === "data") {
        try {
          const bytes = bytesFromBase64(frame.b64);
          const text = frame.text !== false;
          for (const cb of listeners) cb({ bytes, text });
        } catch {}
        return;
      }
      if (kind === "close" || kind === "error") {
        // Desktop-side stream death must reach the phone: the original Worker
        // closed the app socket 1012 here.
        closed = true;
        this.streams.delete(id);
        for (const cb of closeListeners) cb({ code: 1012, reason: "relay stream closed" });
        closeListeners.clear();
        listeners.clear();
      }
    });
    this.send({ t: "open", id, ws: true, path, headers });
    const handle = {
      id,
      onMessage(cb) {
        if (!closed) listeners.add(cb);
      },
      onClose(cb) {
        if (!closed) closeListeners.add(cb);
        else cb({ code: 1012, reason: "relay stream closed" });
      },
      close: () => {
        closed = true;
        this.streams.delete(id);
        this.send({ t: "close", id });
      },
    };
    return handle;
  }

  /**
   * Send a data frame only if its base64 form fits the 1 MiB maxPayload on
   * both transports (256 KiB raw → ~340 KiB b64). Oversized data frames are
   * dropped and an error frame is delivered instead — the desktop's support
   * for multi-frame payloads is unverified, so never send one that cannot
   * arrive.
   */
  sendData(id, bytes, text) {
    if (bytes.length > MAX_FRAME_BYTES) {
      this._emit("payload-too-large", { id, bytes: bytes.length, limit: MAX_FRAME_BYTES });
      this.send({ t: "error", id, message: "payload too large for relay frame" });
      return;
    }
    this.send({ t: "data", id, b64: base64FromBytes(bytes), text });
  }

  /**
   * Report a protocol-level event to the transport's logger (if any).
   * Never throws: a broken logger must not take the relay down.
   */
  _emit(event, data) {
    if (!this.onEvent) return;
    try {
      this.onEvent(event, data);
    } catch {}
  }

  send(frame) {
    if (!this.hasLiveAgent()) return;
    // agent.send throws on Workers' server socket once it is closing/closed —
    // an unhandled throw here would take down the whole relay.
    try {
      this.agent.send(JSON.stringify(frame));
    } catch {}
  }

  onAgentFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const deliver = this.streams.get(frame.id);
    if (deliver) deliver(frame.t, frame);
  }
}
