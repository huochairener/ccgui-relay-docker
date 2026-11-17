/**
 * CC GUI 中继 · Cloudflare Worker 入口（薄壳）。
 *
 * Thin shell kept for wrangler compatibility: all Worker logic lives in
 * src/worker.js (RelayDO + default fetch handler). Wrangler 的 main 指向
 * src/worker.js；本文件仅为保持既有导入路径 `src/index.js` 不变而存在。
 *
 * `Relay` is the historical export name Wrangler binds as a Durable Object
 * (wrangler.toml: class_name = "Relay").
 */

export { RelayDO as Relay, AGENT_PATH, default } from "./worker.js";
