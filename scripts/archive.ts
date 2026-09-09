/** Minimal tar.gz and zip writers.
 *
 *  Both formats are a few hundred bytes of header around the payload, and
 *  writing them here keeps the agent build stage free of `tar`, `zip` and any
 *  npm dependency — it needs nothing but Bun and a network route to Bun's CDN.
 *
 *  Why two formats at all: a binary downloaded straight from a browser arrives
 *  without the executable bit on macOS and Linux, so the user meets
 *  `permission denied` before anything else. tar preserves mode 0755. Windows
 *  has no such bit and Explorer opens zip natively, so that side gets a zip.
 */
import { deflateRawSync, gzipSync } from "node:zlib";

export interface Entry {
  name: string;
  data: Uint8Array;
  /** Unix mode; only tar carries it. */
  mode?: number;
  mtime?: Date;
}

// ── tar (ustar) ───────────────────────────────────────────────────────────

const BLOCK = 512;

/** Octal, NUL-terminated, right-aligned in `len` — the ustar number format. */
function octal(value: number, len: number): string {
  return value.toString(8).padStart(len - 1, "0") + "\0";
}

function tarHeader(e: Entry): Uint8Array {
  const head = new Uint8Array(BLOCK);
  const enc = new TextEncoder();
  const put = (s: string, at: number): void => head.set(enc.encode(s), at);

  if (enc.encode(e.name).length > 100) throw new Error(`tar: name too long: ${e.name}`);
  put(e.name, 0);
  put(octal(e.mode ?? 0o644, 8), 100);
  put(octal(0, 8), 108); // uid
  put(octal(0, 8), 116); // gid
  put(octal(e.data.length, 12), 124);
  put(octal(Math.floor((e.mtime ?? new Date()).getTime() / 1000), 12), 136);
  head[156] = 0x30; // typeflag '0' — a regular file
  put("ustar\0", 257);
  put("00", 263);
  put("root", 265);
  put("root", 297);

  // The checksum is computed with its own field read as eight spaces, then
  // written back as six octal digits, a NUL and a space.
  head.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of head) sum += b;
  put(octal(sum, 7), 148);
  head[155] = 0x20;
  return head;
}

const pad = (n: number): number => (BLOCK - (n % BLOCK)) % BLOCK;

export function tar(entries: Entry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  const push = (b: Uint8Array): void => {
    parts.push(b);
    size += b.length;
  };
  for (const e of entries) {
    push(tarHeader(e));
    push(e.data);
    push(new Uint8Array(pad(e.data.length)));
  }
  push(new Uint8Array(BLOCK * 2)); // end-of-archive marker
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const tarGz = (entries: Entry[]): Uint8Array =>
  new Uint8Array(gzipSync(tar(entries), { level: 9 }));

// ── zip ───────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, the only timestamp zip carries. */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zip(entries: Entry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const deflated = new Uint8Array(deflateRawSync(e.data, { level: 9 }));
    // Deflate can inflate incompressible data; storing is then both smaller and
    // faster to unpack.
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const { time, date } = dosTime(e.mtime ?? new Date());
    const crc = crc32(e.data);

    const local = new DataView(new ArrayBuffer(30 + name.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, stored ? 0 : 8, true); // method: store / deflate
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    const localBytes = new Uint8Array(local.buffer);
    localBytes.set(name, 30);

    const central = new DataView(new ArrayBuffer(46 + name.length));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed
    central.setUint16(10, stored ? 0 : 8, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, e.data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    const centralBytes = new Uint8Array(central.buffer);
    centralBytes.set(name, 46);

    locals.push(localBytes, body);
    centrals.push(centralBytes);
    offset += localBytes.length + body.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const pack = (kind: "zip" | "tar.gz", entries: Entry[]): Uint8Array =>
  kind === "zip" ? zip(entries) : tarGz(entries);
