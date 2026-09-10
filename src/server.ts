/** Bun HTTP server — replaces the Flask app. Stateless crypto endpoints, the
 *  static frontend, and the download point for prebuilt local agents. */
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { helm, ansible } from "./crypto/index.ts";
import { VERSION } from "./version.ts";
import { AGENT_PORT_RANGE } from "./ports.ts";
import { TARGETS, archiveName, type AgentBuild } from "./agent/targets.ts";

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

const MAX_BODY = 2 * 1024 * 1024; // 2 MB, matches Flask MAX_CONTENT_LENGTH
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
 *  The agent binds the first free port in 5001-5010, and `--port` may pin any
 *  one of them — src/ports.ts is where that range is stated and why. The policy
 *  therefore has to permit the whole range, or the agent's choice would not be
 *  a choice. A deployment that puts the agent somewhere else entirely says so
 *  here, otherwise the policy would cut its users off with no way to opt in:
 *
 *    AGENT_PORTS   comma-separated ports and ranges, e.g. "5001-5010,7000"
 *
 *  A malformed value stops the server rather than being quietly dropped: the
 *  symptom of a silently ignored port is a code tab that cannot connect and
 *  gives no reason, which is exactly the failure this is meant to prevent.
 */

/** Every source lands in connect-src in full, on every response, so the list is
 *  capped at a number a person would plausibly ask for rather than left to
 *  whatever a mistyped range expands to. */
const MAX_AGENT_PORTS = 64;

function parseAgentPorts(spec: string): string[] {
  const reject = (item: string, why: string): never => {
    console.error(`AGENT_PORTS: "${item}" ${why}`);
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
    if (hi - lo + 1 > MAX_AGENT_PORTS) reject(item, `covers more than ${MAX_AGENT_PORTS} ports`);
    for (let p = lo; p <= hi; p++) out.push(p);
  }

  const unique = [...new Set(out)].sort((a, b) => a - b);
  if (unique.length > MAX_AGENT_PORTS) {
    console.error(`AGENT_PORTS: ${unique.length} ports listed, more than the ${MAX_AGENT_PORTS} this policy will name`);
    process.exit(1);
  }
  return unique.map(String);
}

const AGENT_PORTS = parseAgentPorts(process.env.AGENT_PORTS ?? AGENT_PORT_RANGE);

if (!AGENT_PORTS.length) {
  console.error("AGENT_PORTS: no ports left after parsing — the code tab could reach no agent at all");
  process.exit(1);
}

/** The agent binds 127.0.0.1 only (agent-go/server.go: listenLoopback), and the
 *  page reaches it two ways: the WebSocket, and a plain fetch of /ping. Hence
 *  four schemes — but each pinned to a port, not to `:*`. */
const AGENT_SOURCES = AGENT_PORTS.flatMap((port) =>
  ["ws", "wss", "http", "https"].flatMap((scheme) => [`${scheme}://127.0.0.1:${port}`, `${scheme}://localhost:${port}`]),
);

/** Sent on every response.
 *
 *  The threat this is really aimed at: the code tab keeps the local agent's URL
 *  and token in localStorage, and that agent is a filesystem bridge. Script
 *  injection on this origin would therefore be script injection into someone's
 *  working directory. Everything the app loads is same-origin, so a strict
 *  policy costs nothing — the one relaxation is inline styles, which CodeMirror
 *  needs because it injects its themes as a <style> element at runtime.
 *
 *  connect-src has to allow loopback so the page can reach the user's agent —
 *  but only on the ports an agent is allowed to bind. Opening every loopback
 *  port would hand injected script a channel to every other service on the
 *  machine, which is a far larger grant than the one thing the tab needs.
 */
const cspFor = (nonce: string): string =>
  [
    "default-src 'self'",
    "script-src 'self'",
    // CodeMirror injects its themes as a <style> element at runtime, so the
    // policy has to admit one — by nonce, which an attacker cannot guess,
    // rather than by 'unsafe-inline', which admits every style anywhere.
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${AGENT_SOURCES.join(" ")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

const securityHeaders = (nonce: string): Record<string, string> => ({
  "content-security-policy": cspFor(nonce),
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
  for (const [name, value] of Object.entries(securityHeaders(nonce))) res.headers.set(name, value);
  return res;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const ok = (result: unknown) => json({ result });
const fail = (error: string, status: number) => json({ error }, status);

type CryptoFn = (text: string, password: string) => Promise<string>;

/** Shared handler for the 4 crypto endpoints — mirrors validate_request + api_response. */
async function crypto(req: Request, fn: CryptoFn): Promise<Response> {
  let data: Record<string, unknown>;
  try {
    data = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("Invalid JSON body", 400);
  }
  for (const field of ["text", "password"] as const) {
    if (!data?.[field]) {
      return fail(`${field[0].toUpperCase()}${field.slice(1)} is required`, 400);
    }
  }
  try {
    return ok(await fn(String(data.text), String(data.password)));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
}

const ROUTES: Record<string, CryptoFn> = {
  "/helm/encrypt": helm.encrypt,
  "/helm/decrypt": helm.decrypt,
  "/ansible/encrypt": ansible.encrypt,
  "/ansible/decrypt": ansible.decrypt,
};

const IMMUTABLE = "public, max-age=604800";

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

// ── prebuilt agents ───────────────────────────────────────────────────────
//
// The code tab needs an agent on the *user's* machine. This process usually
// runs in a container, where an agent could only ever expose the pod — so the
// deployment carries the cross-compiled binaries and hands them out instead.
// They are read from disk rather than embedded: `bun build --compile` would
// otherwise fold ~160 MB of executables into this executable.
//
//   AGENT_DIR             where the archives and agents.json live
//   AGENT_DOWNLOAD_BASE   serve them from a mirror instead, so an air-gapped
//                         site can keep the image small

const AGENT_BASE = (process.env.AGENT_DOWNLOAD_BASE ?? "").replace(/[/]+$/, "");

// An explicit AGENT_DIR is taken literally — falling back to a default when it
// turns out to be empty would quietly serve something other than what was
// configured.
const AGENT_DIRS = process.env.AGENT_DIR
  ? [process.env.AGENT_DIR]
  : ["/usr/local/share/enc-tool/agents", "dist/agents"];

interface ManifestBuild extends Omit<AgentBuild, "url"> {
  size: number;
  sha256: string;
}

/** Archives actually present on disk, keyed by file name. This is the
 *  allowlist the download route checks against, so no string from a request is
 *  ever joined onto a filesystem path. */
const agentFiles = new Map<string, string>();
let agentBuilds: AgentBuild[] = [];

async function loadAgents(): Promise<void> {
  for (const dir of AGENT_DIRS) {
    const manifest = Bun.file(join(dir, "agents.json"));
    if (!(await manifest.exists())) continue;
    let parsed: { version: string; builds: ManifestBuild[] };
    try {
      parsed = (await manifest.json()) as { version: string; builds: ManifestBuild[] };
    } catch {
      console.warn(`agents: ${dir}/agents.json is not valid JSON — ignoring`);
      continue;
    }
    for (const b of parsed.builds ?? []) {
      const path = join(dir, b.file);
      if (!(await Bun.file(path).exists())) {
        console.warn(`agents: ${b.file} is in the manifest but missing on disk`);
        continue;
      }
      agentFiles.set(b.file, path);
      agentBuilds.push({ ...b, url: AGENT_BASE ? `${AGENT_BASE}/${b.file}` : `/agent/download/${b.file}` });
    }
    if (agentBuilds.length) {
      console.log(`agents: serving ${agentBuilds.length} prebuilt agent(s) from ${dir}`);
      return;
    }
  }

  // Nothing on disk, but a mirror is configured: the release names are known
  // from the target table, so the panel can still link to it. Size and
  // checksum stay absent — we have not seen those files.
  if (AGENT_BASE) {
    agentBuilds = TARGETS.map((t) => ({
      id: t.id,
      os: t.os,
      arch: t.arch,
      label: t.label,
      exe: t.exe,
      kind: t.kind,
      file: archiveName(t, VERSION),
      url: `${AGENT_BASE}/${archiveName(t, VERSION)}`,
    }));
    console.log(`agents: linking to the mirror at ${AGENT_BASE}`);
  }
}

/** Placeholder in src/web/index.html, swapped for the request's nonce. */
const NONCE_SLOT = "__CSP_NONCE__";

/** Placeholder in src/web/index.html, swapped for the ports connect-src names.
 *
 *  A page cannot read its own policy, and a connection the policy refuses looks
 *  exactly like an agent that never started: same error event, same close, no
 *  status code anywhere. The violation report tells them apart, but it is
 *  delivered in a queued task — after the WebSocket constructor has already
 *  thrown and the failure has been reported to the user. Handing the page the
 *  list up front lets it name the real reason at the moment it fails, in every
 *  browser, instead of racing an event that may arrive too late. */
const PORTS_SLOT = "__AGENT_PORTS__";

const AGENT_TYPE: Record<string, string> = { zip: "application/zip", "tar.gz": "application/gzip" };

// `server agent [...]` runs the local filesystem + git bridge for the code tab
// instead of the web server — the same binary, a second mode. It has to be a
// separate process on the user's machine because a browser tab cannot spawn
// `git`; see src/agent/main.ts.
if (process.argv[2] === "agent") {
  const { startAgent } = await import("./agent/main.ts");
  await startAgent(process.argv.slice(3));
} else {
  await loadAgents();

  async function route(req: Request, nonce: string): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (req.method === "GET" && pathname === "/") {
      // The shell is the one response that has to be built rather than streamed:
      // it carries the nonce that admits CodeMirror's runtime <style>. Read per
      // request so editing it in dev needs no restart; it is 6 KB.
      const html = (await Bun.file(indexHtml).text())
        .replaceAll(NONCE_SLOT, nonce)
        .replaceAll(PORTS_SLOT, AGENT_PORTS.join(","));
      // A nonce that outlived its response would be a policy no longer matching
      // its page, so the shell is never stored by the HTTP cache. The service
      // worker keeps its own copy for offline, headers and all, and is unaffected.
      return new Response(html, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    }

    if (req.method === "POST" && pathname in ROUTES) {
      return crypto(req, ROUTES[pathname]);
    }

    // Fetched only when the user opens the code tab, so the crypto tabs
    // never ask for it.
    if (req.method === "GET" && pathname === "/agent/downloads") {
      return json({ version: VERSION, builds: agentBuilds });
    }

    if (req.method === "GET" && pathname.startsWith("/agent/download/")) {
      const file = decodeURIComponent(pathname.slice("/agent/download/".length));
      const path = agentFiles.get(file);
      if (!path) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(path), {
        headers: {
          "content-type": AGENT_TYPE[file.endsWith(".zip") ? "zip" : "tar.gz"],
          // The version is part of the name, so a given file never changes.
          "cache-control": IMMUTABLE,
          "content-disposition": `attachment; filename="${file}"`,
        },
      });
    }

    if (req.method === "GET" && pathname in STATIC) {
      const asset = STATIC[pathname];
      const headers: Record<string, string> = { "content-type": asset.type };
      if (asset.cache) headers["cache-control"] = asset.cache;
      return new Response(Bun.file(asset.path), { headers });
    }

    return new Response("Not found", { status: 404 });
  }

  const server = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0", // bind all interfaces so the container is reachable
    maxRequestBodySize: MAX_BODY,
    fetch: async (req) => {
      const nonce = newNonce();
      return secure(await route(req, nonce), nonce);
    },
  });

  console.log(`encryption-tool listening on http://localhost:${server.port}`);
}
