import { test } from "node:test";
import assert from "node:assert/strict";
import { base64FromBytes, bytesFromBase64 } from "../src/base64.js";

const base64Of = (s) => Buffer.from(s, "utf8").toString("base64");

test("round-trips arbitrary bytes through base64", () => {
  const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255, 10, 13, 34, 92]);
  assert.deepEqual(
    Array.from(bytesFromBase64(base64FromBytes(bytes))),
    Array.from(bytes),
  );
});

test("round-trips utf-8 text through base64", () => {
  const text = "中继 relay 🚀";
  const bytes = new TextEncoder().encode(text);
  assert.equal(
    new TextDecoder().decode(bytesFromBase64(base64FromBytes(bytes))),
    text,
  );
});
