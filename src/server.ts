/** Bun HTTP server: the static frontend and the download point for prebuilt
 *  local code-agents. It does no cryptography — that runs in the page, so a password
 *  never reaches this process (see src/web/main.ts). */
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { VERSION } from "./version.ts";
import { CODE_AGENT_PORT_RANGE } from "./ports.ts";
import { TARGETS, archiveName, type CodeAgentBuild } from "./code-agent/targets.ts";

// Static assets are imported with the `file` loader so that `bun build --compile`
// embeds them into the standalone binary — the runtime image then needs nothing
// but the executable. In dev they resolve to the on-disk paths (run `bun run
// build` first to produce public/).
import indexHtml from "./web/index.html" with { type: "file" };
import mainJs from "../public/main.js" with { type: "file" };
import mainCss from "../public/main.css" with { type: "file" };
// The code tab is a second bundle, fetched on first use. Its name is fixed (no
// --splitting) precisely so it can be embedded here like the rest.
import codeJs from "../public/code.js" with { type: "file" };
// PWA assets. sw.js must be served from the root to get a "/" scope.
import swJs from "../public/sw.js" with { type: "file" };
import manifestJson from "./web/manifest.webmanifest" with { type: "file" };
import icon192 from "./web/icons/icon-192.png" with { type: "file" };
import icon512 from "./web/icons/icon-512.png" with { type: "file" };
import iconMaskable from "./web/icons/icon-maskable-512.png" with { type: "file" };
import appleIcon from "./web/icons/apple-touch-icon.png" with { type: "file" };

// No route reads a request body, so none is allowed to be large: a limit this
// small turns an upload aimed at the server into a refusal before it is read.
const MAX_BODY = 16 * 1024;
const PORT = Number(process.env.PORT ?? 5000);

// `server --health` performs a request against the running server and exits
// 0/1 — used by the Docker HEALTHCHECK so the minimal image needs no curl.
if (process.argv.includes("--health")) {
  try {
    const r = await fetch(`http://localhost:${PORT}/`);
    process.exit(r.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

/** Loopback ports the page may open a connection to.
 *
 *  The code-agent binds the first free port in 5001-5010, and `--port` may pin any
 *  one of them — src/ports.ts is where that range is stated and why. The policy
 *  therefore has to permit the whole range, or the code-agent's choice would not be
 *  a choice. A deployment that puts the code-agent somewhere else entirely says so
 *  here, otherwise the policy would cut its users off with no way to opt in:
 *
 *    CODE_AGENT_PORTS   comma-separated ports and ranges, e.g. "5001-5010,7000"
 *
 *  A malformed value stops the server rather than being quietly dropped: the
 *  symptom of a silently ignored port is a code tab that cannot connect and
 *  gives no reason, which is exactly the failure this is meant to prevent.
 */

/** Every source lands in connect-src in full, on every response, so the list is
 *  capped at a number a person would plausibly ask for rather than left to
 *  whatever a mistyped range expands to. */
const MAX_CODE_AGENT_PORTS = 64;

function parseCodeAgentPorts(spec: string): string[] {
  const reject = (item: string, why: string): never => {
    console.error(`CODE_AGENT_PORTS: "${item}" ${why}`);
    process.exit(1);
  };
  const port = (text: string, item: string): number => {
    if (!/^[0-9]{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) reject(item, "is not a port number");
    return Number(text);
  };

  const out: number[] = [];
  for (const item of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const parts = item.split("-");
    if (parts.length > 2) reject(item, "is neither a port nor a low-high range");
    const lo = port(parts[0], item);
    const hi = parts.length === 2 ? port(parts[1], item) : lo;
    if (hi < lo) reject(item, "is a range that runs backwards");
    if (hi - lo + 1 > MAX_CODE_AGENT_PORTS) reject(item, `covers more than ${MAX_CODE_AGENT_PORTS} ports`);
    for (let p = lo; p <= hi; p++) out.push(p);
  }

  const unique = [...new Set(out)].sort((a, b) => a - b);
  if (unique.length > MAX_CODE_AGENT_PORTS) {
    console.error(`CODE_AGENT_PORTS: ${unique.length} ports listed, more than the ${MAX_CODE_AGENT_PORTS} this policy will name`);
    process.exit(1);
  }
  return unique.map(String);
}

const CODE_AGENT_PORTS = parseCodeAgentPorts(process.env.CODE_AGENT_PORTS ?? CODE_AGENT_PORT_RANGE);

if (!CODE_AGENT_PORTS.length) {
  console.error("CODE_AGENT_PORTS: no ports left after parsing — the code tab could reach no code-agent at all");
  process.exit(1);
}

/** The code-agent binds 127.0.0.1 only (code-agent-go/server.go: listenLoopback), and the
 *  page reaches it two ways: the WebSocket, and a plain fetch of /ping. Hence
 *  four schemes — but each pinned to a port, not to `:*`. */
const CODE_AGENT_SOURCES = CODE_AGENT_PORTS.flatMap((port) =>
  ["ws", "wss", "http", "https"].flatMap((scheme) => [`${scheme}://127.0.0.1:${port}`, `${scheme}://localhost:${port}`]),
);

/** Stands where the nonce goes while the policy is cut in two; see CSP_PARTS. */
const NONCE_MARK = "\u0000";

/** Sent on every response.
 *
 *  The threat this is really aimed at: the code tab keeps the local code-agent's URL
 *  and token in localStorage, and that code-agent is a filesystem bridge. Script
 *  injection on this origin would therefore be script injection into someone's
 *  working directory. Everything the app loads is same-origin, so a strict
 *  policy costs nothing — the one relaxation is inline styles, which CodeMirror
 *  needs because it injects its themes as a <style> element at runtime.
 *
 *  connect-src has to allow loopback so the page can reach the user's code-agent —
 *  but only on the ports a code-agent is allowed to bind. Opening every loopback
 *  port would hand injected script a channel to every other service on the
 *  machine, which is a far larger grant than the one thing the tab needs.
 *
 *  Cut at the one place that differs between requests. It is ~2 KB — every allowed loopback port is spelled out in four schemes and
 *  two hosts — and it used to be assembled from its directives on every
 *  response, 304s and 404s included, to change 24 characters. Now it is built
 *  once, and a response only joins the two halves around its nonce. */
const CSP_PARTS = [
  [
    "default-src 'self'",
    "script-src 'self'",
    // CodeMirror injects its themes as a <style> element at runtime, so the
    // policy has to admit one — by nonce, which an attacker cannot guess,
    // rather than by 'unsafe-inline', which admits every style anywhere.
    `style-src 'self' 'nonce-${NONCE_MARK}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${CODE_AGENT_SOURCES.join(" ")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
].flatMap((policy) => policy.split(NONCE_MARK)) as [string, string];

const cspFor = (nonce: string): string => CSP_PARTS[0] + nonce + CSP_PARTS[1];

/** The headers that do not depend on the request, as pairs — built once. */
const STATIC_HEADERS = Object.entries({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // frame-ancestors 'none' above already says this to every browser that reads
  // CSP. The legacy header is kept because scanners check for it by name.
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  // Nothing on this origin is meant to be pulled into someone else's page.
  // No CORS headers are sent either, so this only closes the no-cors loads that
  // CORS never covered in the first place: <img>, <script>, <link>, <iframe>.
  "cross-origin-resource-policy": "same-origin",
  // Nothing here needs a camera, a microphone or a location.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  // This process only ever speaks plain HTTP — TLS is terminated by whatever
  // proxy the deployment puts in front. A browser must ignore this header when
  // it arrives over a non-secure transport, so sending it unconditionally is
  // harmless here and takes effect exactly where it should.
  //
  // includeSubDomains is deliberately absent: there are no cookies here to
  // protect from a sibling host, and an operator serving the app from an apex
  // domain would be forcing HTTPS onto every unrelated subdomain they own.
  "strict-transport-security": "max-age=31536000",
});

/** A fresh nonce per request. The shell embeds it so CodeMirror's runtime
 *  <style> is admitted; every other response carries one nothing uses, which
 *  costs 24 bytes and keeps one code path instead of two. */
const newNonce = (): string => randomBytes(16).toString("base64");

/** Stamps the policy headers onto a finished response.
 *
 *  This runs on the way out of `fetch` rather than at every `return`, so a
 *  route added later cannot ship without them — the previous shape, a helper
 *  each branch had to remember to call, held only as long as everyone
 *  remembered. These win over anything a route set: they are policy, not
 *  content. */
function secure(res: Response, nonce: string): Response {
  res.headers.set("content-security-policy", cspFor(nonce));
  for (const [name, value] of STATIC_HEADERS) res.headers.set(name, value);
  return res;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const IMMUTABLE = "public, max-age=604800";

/** What the bundles say when their name cannot change.
 *
 *  main.js and code.js keep fixed names — the compiled binary embeds them by
 *  path — so they can never be `immutable`. `no-cache` is not "do not cache":
 *  it stores the response and revalidates it, which with the ETag below turns
 *  every repeat visit into a 304 with no body instead of a fresh megabyte. */
const REVALIDATE = "no-cache";

const STATIC: Record<string, { path: string; type: string; cache?: string }> = {
  "/public/main.js": { path: mainJs, type: "text/javascript" },
  "/public/main.css": { path: mainCss, type: "text/css" },
  "/public/code.js": { path: codeJs, type: "text/javascript" },
  // Never cache the worker itself: a stale sw.js pins the app to an old shell
  // and no later deploy can dislodge it.
  "/sw.js": { path: swJs, type: "text/javascript", cache: "no-cache" },
  "/manifest.webmanifest": { path: manifestJson, type: "application/manifest+json" },
  "/public/icon-192.png": { path: icon192, type: "image/png", cache: IMMUTABLE },
  "/public/icon-512.png": { path: icon512, type: "image/png", cache: IMMUTABLE },
  "/public/icon-maskable-512.png": { path: iconMaskable, type: "image/png", cache: IMMUTABLE },
  "/public/apple-touch-icon.png": { path: appleIcon, type: "image/png", cache: IMMUTABLE },
};

// ── static assets: compressed once, then revalidated ──────────────────────
//
// The bundles are the whole payload of this app — main.js is half a megabyte
// and code.js over a megabyte — and they used to go out raw, with no validator
// and no cache directive, on every single load. Two things fix that, and both
// belong here rather than in the build: the compressed copies would otherwise
// have to be produced by `bun run build`, imported by name so `--compile`
// embeds them, and kept in step with the originals by hand.
//
// Compression happens on the first request for an asset and is kept in memory.
// Measured on this bundle set: brotli q9 turns code.js into 365 KB in 55 ms,
// gzip -9 into 395 KB in 21 ms — once per process, against ~1.2 MB saved on
// every request after it. q11 was rejected deliberately: 45 KB better, 1.4 s
// of blocked event loop.
//
// The ETag is what makes `no-cache` cheap: the browser asks, the server answers
// 304 with no body. It is a hash of the bytes, so a rebuild changes it and a
// restart does not — which matters because the two are not the same event here.
const MIN_COMPRESS = 1024;
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|manifest\+json))/;

interface Encoded {
  /** Held as an ArrayBuffer rather than the Uint8Array the compressor returns:
   *  a view can sit inside a larger pooled buffer, and `new Response(view)` is
   *  also not typed as a body across TypeScript's DOM libs. Detached once here,
   *  never per request. */
  body: ArrayBuffer;
  etag: string;
}

const detach = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
interface Prepared {
  /** Identity of the file on disk when this was built, so a dev rebuild of
   *  public/ is picked up without restarting the server. */
  stamp: string;
  identity: Encoded;
  br?: Encoded;
  gzip?: Encoded;
}

const prepared = new Map<string, Promise<Prepared>>();

/** How often the file behind an asset is looked at again.
 *
 *  The stamp exists so that rebuilding public/ in development is picked up
 *  without a restart, and it cost a stat on every request to do it. Once a
 *  second is as good for that purpose — nobody rebuilds faster than they can
 *  reload — and in the compiled binary, where the file is embedded and cannot
 *  change, it is a stat that never had anything to find. */
const RECHECK_MS = 1000;
const checkedAt = new Map<string, number>();

async function prepareAsset(pathname: string, asset: { path: string; type: string }): Promise<Prepared> {
  const current = prepared.get(pathname);
  if (current && Date.now() - (checkedAt.get(pathname) ?? 0) < RECHECK_MS) return current;
  checkedAt.set(pathname, Date.now());

  const file = Bun.file(asset.path);
  const stamp = `${file.size}:${file.lastModified}`;
  if (current && (await current).stamp === stamp) return current;

  const build = (async (): Promise<Prepared> => {
    const raw = await file.arrayBuffer();
    const bytes = new Uint8Array(raw);
    const digest = createHash("sha256").update(bytes).digest("base64url").slice(0, 22);
    const out: Prepared = { stamp, identity: { body: raw, etag: `"${digest}"` } };
    if (COMPRESSIBLE.test(asset.type) && bytes.length >= MIN_COMPRESS) {
      out.br = {
        body: detach(
          brotliCompressSync(bytes, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
              [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
            },
          }),
        ),
        etag: `"${digest}-br"`,
      };
      out.gzip = { body: detach(gzipSync(bytes, { level: 9 })), etag: `"${digest}-gz"` };
    }
    return out;
  })();

  prepared.set(pathname, build);
  return build;
}

/** The best encoding this client actually accepts.
 *
 *  `q=0` is a refusal, not a preference, so it is honoured — a client that says
 *  `gzip;q=0` and gets gzip anyway receives bytes it will not decode. */
function chooseEncoding(accept: string | null, asset: Prepared): { name: string; body: Encoded } {
  const accepted = new Set<string>();
  for (const part of (accept ?? "").toLowerCase().split(",")) {
    const [token, ...params] = part.trim().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    if (token) accepted.add(token);
  }
  if (asset.br && (accepted.has("br") || accepted.has("*"))) return { name: "br", body: asset.br };
  if (asset.gzip && (accepted.has("gzip") || accepted.has("*"))) return { name: "gzip", body: asset.gzip };
  return { name: "identity", body: asset.identity };
}

/** Does `if-none-match` cover this entity? The header is a list, and a weak
 *  validator (`W/"…"`) compares equal to its strong twin for revalidation. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const want = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === want || candidate.trim() === "*");
}

async function serveStatic(req: Request, pathname: string, asset: { path: string; type: string; cache?: string }): Promise<Response> {
  const ready = await prepareAsset(pathname, asset);
  const chosen = chooseEncoding(req.headers.get("accept-encoding"), ready);

  // Sent on the 304 as well: these are what the client caches alongside the
  // body, and dropping them on a revalidation would age out the entry it just
  // confirmed. Vary is not optional — the same URL now has three bodies.
  const validators: Record<string, string> = {
    etag: chosen.body.etag,
    "cache-control": asset.cache ?? REVALIDATE,
    vary: "accept-encoding",
  };
  if (etagMatches(req.headers.get("if-none-match"), chosen.body.etag)) {
    return new Response(null, { status: 304, headers: validators });
  }

  const headers: Record<string, string> = { ...validators, "content-type": asset.type };
  if (chosen.name !== "identity") headers["content-encoding"] = chosen.name;
  return new Response(chosen.body.body, { headers });
}

// ── prebuilt code-agents ───────────────────────────────────────────────────────
//
// The code tab needs a code-agent on the *user's* machine. This process usually
// runs in a container, where a code-agent could only ever expose the pod — so the
// deployment carries the cross-compiled binaries and hands them out instead.
// They are read from disk rather than embedded: `bun build --compile` would
// otherwise fold ~160 MB of executables into this executable.
//
//   CODE_AGENT_DIR             where the archives and code-agents.json live
//   CODE_AGENT_DOWNLOAD_BASE   serve them from a mirror instead, so an air-gapped
//                         site can keep the image small

const CODE_AGENT_BASE = (process.env.CODE_AGENT_DOWNLOAD_BASE ?? "").replace(/[/]+$/, "");

// An explicit CODE_AGENT_DIR is taken literally — falling back to a default when it
// turns out to be empty would quietly serve something other than what was
// configured.
const CODE_AGENT_DIRS = process.env.CODE_AGENT_DIR
  ? [process.env.CODE_AGENT_DIR]
  : ["/usr/local/share/enc-tool/code-agents", "dist/code-agents"];

interface ManifestBuild extends Omit<CodeAgentBuild, "url"> {
  size: number;
  sha256: string;
}

/** Archives actually present on disk, keyed by file name. This is the
 *  allowlist the download route checks against, so no string from a request is
 *  ever joined onto a filesystem path. */
const codeAgentFiles = new Map<string, string>();
let codeAgentBuilds: CodeAgentBuild[] = [];

async function loadCodeAgents(): Promise<void> {
  for (const dir of CODE_AGENT_DIRS) {
    const manifest = Bun.file(join(dir, "code-agents.json"));
    if (!(await manifest.exists())) continue;
    let parsed: { version: string; builds: ManifestBuild[] };
    try {
      parsed = (await manifest.json()) as { version: string; builds: ManifestBuild[] };
    } catch {
      console.warn(`code-agents: ${dir}/code-agents.json is not valid JSON — ignoring`);
      continue;
    }
    for (const b of parsed.builds ?? []) {
      const path = join(dir, b.file);
      if (!(await Bun.file(path).exists())) {
        if (CODE_AGENT_BASE) {
          // A manifest without its archives, and a mirror to fetch them from:
          // the image ships the checksums and the mirror ships the files. The
          // point of the split is where the checksum comes from — the build that
          // made this image, not the host that serves the download — so a
          // mirror that is swapped or compromised cannot vouch for itself. The
          // link is the mirror's; there is nothing local to serve, so the
          // download route (which only serves what is on disk) stays a 404.
          codeAgentBuilds.push({ ...b, url: `${CODE_AGENT_BASE}/${b.file}` });
          continue;
        }
        console.warn(`code-agents: ${b.file} is in the manifest but missing on disk`);
        continue;
      }
      codeAgentFiles.set(b.file, path);
      codeAgentBuilds.push({ ...b, url: CODE_AGENT_BASE ? `${CODE_AGENT_BASE}/${b.file}` : `/code-agent/download/${b.file}` });
    }
    if (codeAgentBuilds.length) {
      console.log(`code-agents: serving ${codeAgentBuilds.length} prebuilt code-agent(s) from ${dir}`);
      return;
    }
  }

  // Nothing on disk, but a mirror is configured: the release names are known
  // from the target table, so the panel can still link to it. Size and
  // checksum stay absent — we have not seen those files.
  if (CODE_AGENT_BASE) {
    codeAgentBuilds = TARGETS.map((t) => ({
      id: t.id,
      os: t.os,
      arch: t.arch,
      label: t.label,
      exe: t.exe,
      kind: t.kind,
      file: archiveName(t, VERSION),
      url: `${CODE_AGENT_BASE}/${archiveName(t, VERSION)}`,
    }));
    console.log(`code-agents: linking to the mirror at ${CODE_AGENT_BASE}`);
  }
}

/** Placeholder in src/web/index.html, swapped for the request's nonce. */
const NONCE_SLOT = "__CSP_NONCE__";

/** The shell, read and cut at the nonce slot — and re-read when the file changes.
 *
 *  It used to be read from disk and run through two `replaceAll`s on every load
 *  of the page. The ports never change while the process runs, so they are
 *  filled in once; what is left to do per request is to join the two halves
 *  around the nonce. The file is looked at again at most once a second, which is
 *  what keeps "edit it in dev, no restart" true. */
let shell: { stamp: string; checked: number; parts: string[] } | null = null;
async function shellParts(): Promise<string[]> {
  const now = Date.now();
  if (shell && now - shell.checked < RECHECK_MS) return shell.parts;
  const file = Bun.file(indexHtml);
  const stamp = `${file.size}:${file.lastModified}`;
  if (shell && shell.stamp === stamp) {
    shell.checked = now;
    return shell.parts;
  }
  const text = (await file.text()).replaceAll(PORTS_SLOT, CODE_AGENT_PORTS.join(","));
  shell = { stamp, checked: now, parts: text.split(NONCE_SLOT) };
  return shell.parts;
}

/** Placeholder in src/web/index.html, swapped for the ports connect-src names.
 *
 *  A page cannot read its own policy, and a connection the policy refuses looks
 *  exactly like a code-agent that never started: same error event, same close, no
 *  status code anywhere. The violation report tells them apart, but it is
 *  delivered in a queued task — after the WebSocket constructor has already
 *  thrown and the failure has been reported to the user. Handing the page the
 *  list up front lets it name the real reason at the moment it fails, in every
 *  browser, instead of racing an event that may arrive too late. */
const PORTS_SLOT = "__CODE_AGENT_PORTS__";

const CODE_AGENT_TYPE: Record<string, string> = { zip: "application/zip", "tar.gz": "application/gzip" };

// `server code-agent [...]` runs the local filesystem + git bridge for the code tab
// instead of the web server — the same binary, a second mode. It has to be a
// separate process on the user's machine because a browser tab cannot spawn
// `git`; see src/code-agent/main.ts.
if (process.argv[2] === "code-agent") {
  const { startCodeAgent } = await import("./code-agent/main.ts");
  await startCodeAgent(process.argv.slice(3));
} else {
  await loadCodeAgents();

  async function route(req: Request, nonce: string): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (req.method === "GET" && pathname === "/") {
      // The shell is the one response that has to be built rather than streamed:
      // it carries the nonce that admits CodeMirror's runtime <style>. Read per
      // request so editing it in dev needs no restart; it is 6 KB.
      const html = (await shellParts()).join(nonce);
      // A nonce that outlived its response would be a policy no longer matching
      // its page, so the shell is never stored by the HTTP cache. The service
      // worker keeps its own copy for offline, headers and all, and is unaffected.
      return new Response(html, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    }

    // Fetched only when the user opens the code tab, so the crypto tabs
    // never ask for it.
    if (req.method === "GET" && pathname === "/code-agent/downloads") {
      return json({ version: VERSION, builds: codeAgentBuilds });
    }

    if (req.method === "GET" && pathname.startsWith("/code-agent/download/")) {
      // A name that is not valid percent-encoding is not a name in the table
      // either. decodeURIComponent throws on it, and an exception out of a
      // route is not a 404 — see `error` below for what it used to be.
      let file: string;
      try {
        file = decodeURIComponent(pathname.slice("/code-agent/download/".length));
      } catch {
        return new Response("Not found", { status: 404 });
      }
      const path = codeAgentFiles.get(file);
      if (!path) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(path), {
        headers: {
          "content-type": CODE_AGENT_TYPE[file.endsWith(".zip") ? "zip" : "tar.gz"],
          // The version is part of the name, so a given file never changes.
          "cache-control": IMMUTABLE,
          "content-disposition": `attachment; filename="${file}"`,
        },
      });
    }

    if (req.method === "GET" && pathname in STATIC) {
      return serveStatic(req, pathname, STATIC[pathname]);
    }

    return new Response("Not found", { status: 404 });
  }

  // Compression is synchronous and brotli at quality 9 on the code bundle is a
  // twentieth of a second of blocked event loop — paid by whoever asked first,
  // and by everyone queued behind them. Done here it is paid once, before the
  // port is open. A bundle that is missing is not fatal: it will say so, as it
  // always did, when someone asks for it.
  await Promise.all(Object.entries(STATIC).map(([path, asset]) => prepareAsset(path, asset).catch(() => undefined)));

  const server = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0", // bind all interfaces so the container is reachable
    maxRequestBodySize: MAX_BODY,
    // Bun's development mode answers an uncaught exception with a page that
    // carries the stack, the working directory and the source lines around the
    // failure — and none of the headers `secure` stamps. It is on unless it is
    // switched off, and a compiled binary does not switch it off by itself.
    // Reproduced: one malformed percent-escape in a download URL returned it.
    development: false,
    fetch: async (req) => {
      const nonce = newNonce();
      return secure(await route(req, nonce), nonce);
    },
    // The last resort, for whatever a route throws that nobody thought of. It
    // says nothing about what went wrong — that goes to the operator's log —
    // and it goes out through `secure` like every other response, so a bug in a
    // route can no longer be a response without the policy.
    error(err) {
      console.error("request failed:", err);
      const nonce = newNonce();
      return secure(
        new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain", "cache-control": "no-store" } }),
        nonce,
      );
    },
  });

  console.log(`encryption-tool listening on http://localhost:${server.port}`);
}
