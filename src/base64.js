/**
 * base64 helpers for the relay protocol (environment-agnostic).
 *
 * 中继协议的 base64 编解码（环境无关）。Cloudflare Workers 有 btoa/atob，
 * Node 18+ 的全局版本是废弃 API，所以两边都用各自的稳妥实现。
 */

export function base64FromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(bytes).toString("base64");
}

export function bytesFromBase64(text) {
  if (typeof atob === "function") {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(text, "base64"));
}
