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
/** The same digits as char codes, for the writer below. */
const HEX_CODES = Uint8Array.from(HEX, (c) => c.charCodeAt(0));
/** The value of each hex digit, -1 for anything else. ASCII only: a code point above 127
 *  is not a digit, and is checked for before this table is read. */
const HEX_VALUES = ((): Int8Array => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < 10; i++) table[0x30 + i] = i; // 0-9
  for (let i = 0; i < 6; i++) {
    table[0x41 + i] = 10 + i; // A-F
    table[0x61 + i] = 10 + i; // a-f
  }
  return table;
})();

const ASCII = new TextDecoder();

/** The bytes as lowercase hex.
 *
 *  One pass into a Uint8Array of ASCII, decoded once — not a growing string appended two
 *  characters at a time. The string version costs nothing for the 32 bytes of a salt and
 *  everything for the tens of megabytes of an Ansible Vault ciphertext: measured on 20 MiB
 *  it took 1.9 s on the development machine and 2.2–3.1 s on the stand, and the buffer it
 *  built lived as UTF-16 (two bytes per hex digit) on top of the copies `+=` keeps. This
 *  allocates exactly the result and touches each byte once. */
export function toHex(bytes: Bytes): string {
  return ASCII.decode(hexAscii(bytes));
}

/** The same hex, left as the ASCII bytes it is. A caller that goes on to hex it again, or to
 *  wrap it, needs bytes: as a string it would be decoded and encoded back for nothing. */
export function hexAscii(bytes: Bytes): Bytes {
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0, j = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out[j++] = HEX_CODES[b >> 4];
    out[j++] = HEX_CODES[b & 15];
  }
  return out;
}

/** `head`, a line break, and the bytes as hex in lines of `width` digits (an even number, so a
 *  break never falls inside a byte). One pass into one buffer, decoded once: cutting a 36 MB
 *  string into 470 000 slices and joining them took about as long as the encryption itself. */
export function hexLines(head: string, bytes: Bytes, width: number): string {
  const perLine = width / 2;
  const lines = Math.ceil(bytes.length / perLine);
  const out = new Uint8Array(head.length + 1 + bytes.length * 2 + Math.max(lines - 1, 0));
  let j = 0;
  for (let i = 0; i < head.length; i++) out[j++] = head.charCodeAt(i); // ASCII by contract
  out[j++] = 10;
  for (let start = 0; start < bytes.length; start += perLine) {
    if (start > 0) out[j++] = 10;
    const end = Math.min(start + perLine, bytes.length);
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      out[j++] = HEX_CODES[b >> 4];
      out[j++] = HEX_CODES[b & 15];
    }
  }
  return ASCII.decode(out);
}

/** Strict, unlike `Buffer.from(s, "hex")`, which silently truncates at the
 *  first invalid character and turns corrupt input into a confusing failure
 *  further down. Decoded through a table rather than `parseInt` per pair: an
 *  Ansible Vault envelope is two hex encodings of the whole payload, and
 *  `parseInt` on a two-character slice allocates a string per byte. */
export function fromHex(s: string): Bytes {
  if (s.length % 2 !== 0) throw new Error("Invalid hex data");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hiCode = s.charCodeAt(i * 2);
    const loCode = s.charCodeAt(i * 2 + 1);
    const hi = hiCode < 128 ? HEX_VALUES[hiCode] : -1;
    const lo = loCode < 128 ? HEX_VALUES[loCode] : -1;
    if (hi < 0 || lo < 0) throw new Error("Invalid hex data");
    out[i] = (hi << 4) | lo;
  }
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
