/**
 * base64 helpers for the relay protocol (environment-agnostic).
 *
 * 中继协议的 base64 编解码（环境无关）。Node 有 Buffer（快 100 倍），
 * Workers 只有 btoa/atob —— 按运行时分派，而不是按「btoa 是否存在」：
 * Node 18+ 也有全局 btoa（已废弃、逐字节拼接、极慢），不能作为判据。
 */

export function base64FromBytes(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  // Workers path: btoa needs a binary string; build it in chunks to avoid
  // pathological string concatenation on large payloads.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function bytesFromBase64(text) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"));
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
