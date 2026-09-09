/** Generates the PWA icon set: `bun run icons`.
 *
 *  Written rather than checked in as binaries so the mark can be changed in one
 *  place. There is no image library here (and no canvas in Bun), so this
 *  rasterises a signed-distance drawing by hand and writes a minimal PNG —
 *  which is a few dozen lines and avoids a dependency for four files.
 *
 *  PNG rather than SVG because iOS only takes PNG for a home-screen icon, and
 *  the maskable variant needs its glyph inside Android's safe zone.
 */
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "src", "web", "icons");

// ── PNG encoding ──────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(size: number, rgba: Uint8Array): Uint8Array {
  const stride = size * 4;
  // Filter byte 0 (None) in front of every scanline — the simplest valid PNG.
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

// ── the mark: a padlock on a rounded square ───────────────────────────────

type RGB = [number, number, number];
const BG: RGB = [37, 99, 235]; // --accent
const FG: RGB = [255, 255, 255];

/** Signed distance to a rounded rectangle; negative inside. */
function sdRoundRect(px: number, py: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to the padlock shackle: the upper half of a ring. */
function sdShackle(px: number, py: number, cx: number, cy: number, radius: number, thickness: number): number {
  const ring = Math.abs(Math.hypot(px - cx, py - cy) - radius) - thickness / 2;
  // Clip to the top half; below the centre the shackle is hidden by the body.
  return py > cy ? Math.max(ring, py - cy) : ring;
}

function render(size: number, glyphScale: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const S = 3; // supersampling grid per axis — enough for smooth edges at 192px
  const c = size / 2;
  const bgRadius = size * 0.22;

  const bodyHalfW = size * 0.30 * glyphScale;
  const bodyHalfH = size * 0.22 * glyphScale;
  const bodyCy = c + size * 0.10 * glyphScale;
  const shackleR = size * 0.17 * glyphScale;
  const shackleT = size * 0.085 * glyphScale;
  const shackleCy = bodyCy - bodyHalfH;
  const keyholeR = size * 0.055 * glyphScale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;
          if (sdRoundRect(px, py, c, c, c, c, bgRadius) <= 0) bg++;

          const body = sdRoundRect(px, py, c, bodyCy, bodyHalfW, bodyHalfH, size * 0.06 * glyphScale);
          const shackle = sdShackle(px, py, c, shackleCy, shackleR, shackleT);
          const keyhole = Math.hypot(px - c, py - bodyCy) - keyholeR;
          // The keyhole is punched out of the body, not painted over it.
          if ((body <= 0 && keyhole > 0) || shackle <= 0) fg++;
        }
      }
      const n = S * S;
      const bgA = bg / n;
      const fgA = fg / n;
      const i = (y * size + x) * 4;
      // Composite foreground over background, then the whole thing over nothing.
      const alpha = Math.max(bgA, fgA);
      if (alpha > 0) {
        for (let ch = 0; ch < 3; ch++) {
          rgba[i + ch] = Math.round((FG[ch] * fgA + BG[ch] * bgA * (1 - fgA)) / (fgA + bgA * (1 - fgA) || 1));
        }
      }
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

// ── output ────────────────────────────────────────────────────────────────

await mkdir(OUT, { recursive: true });

const files: [string, number, number][] = [
  ["icon-192.png", 192, 1],
  ["icon-512.png", 512, 1],
  // Android masks maskable icons to a circle covering ~80% of the canvas, so
  // the glyph has to shrink to stay inside the safe zone.
  ["icon-maskable-512.png", 512, 0.72],
  ["apple-touch-icon.png", 180, 1],
];

for (const [name, size, scale] of files) {
  const png = encodePng(size, render(size, scale));
  await writeFile(join(OUT, name), png);
  console.log(`  ${name.padEnd(24)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log(`\nwrote ${files.length} icons to src/web/icons/`);
