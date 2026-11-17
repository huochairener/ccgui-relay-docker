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

export class RelaySession {
  /**
   * @param {string} key
   * @param {{ headTimeoutMs?: number }} [options] — headTimeoutMs injectable for tests.
   */
  constructor(key, options = {}) {
    this.key = key;
    this.headTimeoutMs = options.headTimeoutMs ?? DEFAULT_HEAD_TIMEOUT_MS;
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
    return this.agent !== null && this.agent.readyState === "open";
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
  openHttpStream({ method, path, headers, body }) {
    const id = this.nextId++;
    let resolveHead;
    const headReady = new Promise((r) => (resolveHead = r));
    const chunks = [];
    const state = { headSeen: false, done: false };
    let timer = null;

    const finish = (status, headers, tailBytes, timeoutExpired) => {
      if (state.headSeen && !timeoutExpired) return; // close/error after head just ends the body
      state.headSeen = true;
      state.done = true;
      clearTimeout(timer);
      this.streams.delete(id);
      resolveHead({ status, headers, tailBytes });
    };

    const deliver = (kind, frame) => {
      if (kind === "head") {
        if (state.headSeen) return;
        state.headSeen = true;
        clearTimeout(timer);
        resolveHead({ status: frame.status ?? 200, headers: frame.headers ?? {} });
        return;
      }
      if (kind === "data") {
        try {
          chunks.push(bytesFromBase64(frame.b64));
        } catch {}
        return;
      }
      if (kind === "close" || kind === "error") {
        // A close/error after the head simply ends the body; the response is
        // complete either way.
        state.done = true;
        clearTimeout(timer);
        this.streams.delete(id);
        if (state.headSeen) return;
        finish(
          502,
          { "content-type": "text/plain; charset=utf-8" },
          kind === "error" ? new TextEncoder().encode(frame.message ?? "relay stream closed") : new Uint8Array(0),
          false,
        );
      }
    };

    this.streams.set(id, deliver);
    this.send({ t: "open", id, method, path, headers });
    if (body && body.length) this.send({ t: "body", id, b64: base64FromBytes(body) });
    this.send({ t: "end", id });

    timer = setTimeout(() => {
      if (state.headSeen) return;
      this.streams.delete(id);
      this.send({ t: "close", id });
      finish(504, { "content-type": "text/plain; charset=utf-8" }, new Uint8Array(0), true);
    }, this.headTimeoutMs);

    return headReady.then(({ status, headers, tailBytes }) => {
      if (tailBytes && tailBytes.length) chunks.push(tailBytes);
      return { status, headers, chunks, done: state.done };
    });
  }

  /**
   * Live WebSocket tunnel (the app's /ws). Returns a handle; frames travel
   * both ways unframed at the app layer, framed (b64) on the agent socket.
   */
  openSocketStream({ path, headers }) {
    const id = this.nextId++;
    /** @type {Set<(m: {bytes: Uint8Array, text: boolean}) => void>} */
    const listeners = new Set();
    this.streams.set(id, (kind, frame) => {
      if (kind !== "data") return;
      try {
        const bytes = bytesFromBase64(frame.b64);
        const text = frame.text !== false;
        for (const cb of listeners) cb({ bytes, text });
      } catch {}
    });
    this.send({ t: "open", id, ws: true, path, headers });
    const handle = {
      onMessage(cb) {
        listeners.add(cb);
      },
      close: () => {
        this.streams.delete(id);
        this.send({ t: "close", id });
      },
    };
    return handle;
  }

  send(frame) {
    if (this.hasLiveAgent()) this.agent.send(JSON.stringify(frame));
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
