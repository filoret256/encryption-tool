/** Bun HTTP server — replaces the Flask app. Stateless crypto endpoints, the
 *  static frontend, and the download point for prebuilt local agents. */
import { join } from "node:path";
import { helm, ansible } from "./crypto/index.ts";
import { VERSION } from "./version.ts";
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

/** Sent on every response.
 *
 *  The threat this is really aimed at: the code tab keeps the local agent's URL
 *  and token in localStorage, and that agent is a filesystem bridge. Script
 *  injection on this origin would therefore be script injection into someone's
 *  working directory. Everything the app loads is same-origin, so a strict
 *  policy costs nothing — the one relaxation is inline styles, which CodeMirror
 *  needs because it injects its themes as a <style> element at runtime.
 *
 *  connect-src has to allow loopback so the page can reach the user's agent.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* http://127.0.0.1:* https://127.0.0.1:* ws://localhost:* wss://localhost:* http://localhost:* https://localhost:*",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  // Nothing here needs a camera, a microphone or a location.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

const withSecurity = (headers: Record<string, string>): Record<string, string> => ({ ...SECURITY_HEADERS, ...headers });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS },
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

  const server = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0", // bind all interfaces so the container is reachable
    maxRequestBodySize: MAX_BODY,
    async fetch(req) {
      const { pathname } = new URL(req.url);

      if (req.method === "GET" && pathname === "/") {
        return new Response(Bun.file(indexHtml), { headers: withSecurity({ "content-type": "text/html" }) });
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
        if (!path) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
        return new Response(Bun.file(path), {
          headers: withSecurity({
            "content-type": AGENT_TYPE[file.endsWith(".zip") ? "zip" : "tar.gz"],
            // The version is part of the name, so a given file never changes.
            "cache-control": IMMUTABLE,
            "content-disposition": `attachment; filename="${file}"`,
          }),
        });
      }

      if (req.method === "GET" && pathname in STATIC) {
        const asset = STATIC[pathname];
        const headers: Record<string, string> = { "content-type": asset.type };
        if (asset.cache) headers["cache-control"] = asset.cache;
        return new Response(Bun.file(asset.path), { headers: withSecurity(headers) });
      }

      return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
    },
  });

  console.log(`encryption-tool listening on http://localhost:${server.port}`);
}
