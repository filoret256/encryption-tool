/** PWA wiring: `bun run pwa:smoke`.
 *
 *  Boots the real server and checks everything an installable app needs that
 *  can be verified without a browser: the manifest is valid and complete, the
 *  icons it points at exist at the sizes it claims (read out of the PNG header,
 *  not trusted from the manifest), the worker is served from the root scope
 *  with a cache policy that lets it be replaced, and the shell links it all up.
 */
import { iter } from "../src/agent/proc.ts";

const PORT = 5094;
const base = `http://127.0.0.1:${PORT}`;
const results: { name: string; ok: boolean; note: string }[] = [];

function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

/** Width and height straight out of the PNG IHDR chunk. */
function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

const proc = Bun.spawn(["bun", "src/server.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT) },
  stdout: "pipe",
  stderr: "inherit",
  stdin: "ignore",
});

const dec = new TextDecoder();
let banner = "";
for await (const bytes of iter(proc.stdout as ReadableStream<Uint8Array>)) {
  banner += dec.decode(bytes, { stream: true });
  if (banner.includes("listening")) break;
}

try {
  // ── manifest ──
  const mres = await fetch(`${base}/manifest.webmanifest`);
  const manifest = (await mres.json()) as {
    name?: string;
    short_name?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    theme_color?: string;
    background_color?: string;
    icons?: { src: string; sizes: string; type: string; purpose?: string }[];
  };
  check(
    "manifest served as application/manifest+json",
    mres.ok && (mres.headers.get("content-type") ?? "").includes("application/manifest+json"),
    mres.headers.get("content-type") ?? "",
  );

  const required = ["name", "short_name", "start_url", "display", "theme_color", "background_color"] as const;
  const missing = required.filter((k) => !manifest[k]);
  check("manifest has the fields install requires", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : `display=${manifest.display}`);

  const icons = manifest.icons ?? [];
  const sizeOf = (i: { sizes: string }): number => Number(i.sizes.split("x")[0]) || 0;
  check(
    "manifest declares 192 and 512 plus a maskable icon",
    icons.some((i) => sizeOf(i) >= 192) &&
      icons.some((i) => sizeOf(i) >= 512) &&
      icons.some((i) => (i.purpose ?? "").includes("maskable")),
    icons.map((i) => `${i.sizes}${i.purpose === "maskable" ? " maskable" : ""}`).join(", "),
  );

  // ── the icons the manifest points at ──
  const iconNotes: string[] = [];
  let iconsOk = true;
  for (const icon of icons) {
    const res = await fetch(base + icon.src);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const size = pngSize(bytes);
    const declared = sizeOf(icon);
    const good = res.ok && (res.headers.get("content-type") ?? "").includes("image/png") && size?.w === declared && size?.h === declared;
    if (!good) iconsOk = false;
    iconNotes.push(`${icon.src.split("/").pop()}=${size ? `${size.w}x${size.h}` : "not a PNG"}`);
  }
  check("icons exist at the declared sizes", iconsOk && icons.length > 0, iconNotes.join(", "));

  const apple = await fetch(`${base}/public/apple-touch-icon.png`);
  const appleSize = pngSize(new Uint8Array(await apple.arrayBuffer()));
  check("apple-touch-icon served for iOS", apple.ok && appleSize?.w === 180, appleSize ? `${appleSize.w}x${appleSize.h}` : "missing");

  // ── the worker ──
  const sw = await fetch(`${base}/sw.js`);
  const swBody = await sw.text();
  check(
    "sw.js served from the root scope",
    sw.ok && (sw.headers.get("content-type") ?? "").includes("javascript"),
    `${sw.status} ${sw.headers.get("content-type")}`,
  );
  // A cached worker pins the app to an old shell that no deploy can dislodge.
  check("sw.js is not cacheable", (sw.headers.get("cache-control") ?? "").includes("no-cache"), sw.headers.get("cache-control") ?? "(none)");
  check(
    "worker registers the lifecycle handlers",
    ["install", "activate", "fetch", "message"].every((e) => swBody.includes(`"${e}"`) || swBody.includes(`'${e}'`)),
    `${(swBody.length / 1024).toFixed(1)} KB`,
  );
  // Caching a cross-origin request would break the agent connection probe.
  check("worker leaves other origins alone", swBody.includes("origin"), "origin check present in the bundle");

  // ── the shell links it together ──
  const html = await fetch(`${base}/`).then((r) => r.text());
  const links: [string, boolean][] = [
    ['rel="manifest"', html.includes('rel="manifest"')],
    ["theme-color", html.includes('name="theme-color"')],
    ["apple-touch-icon", html.includes('rel="apple-touch-icon"')],
    ["update prompt", html.includes('id="update-bar"')],
  ];
  check("index.html wires the PWA metadata", links.every(([, ok]) => ok), links.filter(([, ok]) => !ok).map(([n]) => `missing ${n}`).join(", ") || "all present");

  // ── the shell assets the worker precaches must exist ──
  const shell = ["/", "/public/main.js", "/public/main.css", "/public/code.js", "/manifest.webmanifest", "/public/icon-192.png", "/public/icon-512.png"];
  const bad: string[] = [];
  for (const path of shell) {
    const res = await fetch(base + path);
    if (!res.ok) bad.push(`${path} → ${res.status}`);
  }
  check("every precached shell URL resolves", bad.length === 0, bad.join(", ") || `${shell.length} URLs`);
} catch (e) {
  check("unexpected error", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  proc.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
