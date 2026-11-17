import { test } from "node:test";
import assert from "node:assert/strict";

test("worker entry re-exports RelayDO as Relay and the default handler", async () => {
  const entry = await import("../src/index.js");
  const worker = await import("../src/worker.js");
  assert.equal(typeof entry.Relay, "function"); // wrangler.toml 的 DO class_name 是 "Relay"
  assert.equal(typeof entry.default.fetch, "function");
  assert.equal(entry.Relay, worker.RelayDO);
  assert.equal(entry.default.fetch, worker.default.fetch);
});

test("AGENT_PATH is exported for reuse by the Node entry", async () => {
  const worker = await import("../src/worker.js");
  assert.equal(worker.AGENT_PATH, "/agent");
});
