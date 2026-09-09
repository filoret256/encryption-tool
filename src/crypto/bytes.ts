/** Byte helpers for the crypto layer.
 *
 *  Everything here is Uint8Array rather than Buffer so the same modules run in
 *  Bun and in the browser: the encryptors moved to WebCrypto, which both
 *  runtimes provide, and Buffer exists in only one of them.
 */

/** A Uint8Array pinned to a plain ArrayBuffer. Since TypeScript 5.7 the bare
 *  type is generic over its buffer and may be SharedArrayBuffer-backed, which
 *  WebCrypto’s BufferSource does not accept. */
export type Bytes = Uint8Array<ArrayBuffer>;

export const utf8 = (s: string): Bytes => new TextEncoder().encode(s);
export const fromUtf8 = (b: Bytes): string => new TextDecoder().decode(b);

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Bytes): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

/** Strict, unlike `Buffer.from(s, "hex")`, which silently truncates at the
 *  first invalid character and turns corrupt input into a confusing failure
 *  further down. */
export function fromHex(s: string): Bytes {
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error("Invalid hex data");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Spreading a large array into String.fromCharCode overflows the call stack,
// so both directions work in chunks.
const CHUNK = 0x8000;

export function toBase64(bytes: Bytes): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(s: string): Bytes {
  const binary = atob(s.replace(/\s/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Constant-time comparison — replaces node:crypto's timingSafeEqual. The
 *  length is compared up front, as that is not secret. */
export function timingSafeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
