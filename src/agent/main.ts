/** The local agent: `enc-tool agent`.
 *
 *  Runs on the user's machine next to their repository and exposes the
 *  filesystem, the system `git` and ripgrep to the browser tab over a loopback
 *  WebSocket. This exists because a web page cannot spawn processes — there is
 *  no API for it — so "use the git installed in the OS" necessarily means a
 *  small local process doing the spawning.
 *
 *  Security posture (all four are load-bearing):
 *    1. binds 127.0.0.1 only — never reachable from the network;
 *    2. a token, printed at startup, is required on every connection;
 *    3. the Origin header is checked against an allowlist, because a token in
 *       localStorage is only as good as the origins that can read it;
 *    4. every path is confined to the workspace by Jail (see jail.ts).
 */
import { randomBytes } from "node:crypto";
import { Jail } from "./jail.ts";
import { probe } from "./proc.ts";
import * as fsops from "./fs-ops.ts";
import * as git from "./git.ts";
import * as gw from "./git-write.ts";
import { search, type Signal } from "./search.ts";
import { Watcher } from "./watch.ts";
import type { AgentInfo, Req, ServerFrame } from "./protocol.ts";
import { VERSION } from "../version.ts";

// ── CLI ───────────────────────────────────────────────────────────────────

interface Options {
  root: string;
  port: number;
  token: string;
  origins: string[];
}

/** Comma- or space-separated origins from the environment.
 *
 *  The agent people run is downloaded from a UI that is usually not on
 *  localhost, so it needs that origin allowed on every start. A variable can be
 *  set once in a shell profile; a flag has to be retyped every time.
 */
function envOrigins(): string[] {
  return (process.env.ENC_TOOL_ALLOW_ORIGIN ?? "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((o) => o.replace(/[/]+$/, ""));
}

function fail(message: string): never {
  console.error(`agent: ${message}\nTry --help.`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const o: Options = { root: "", port: 5001, token: "", origins: envOrigins() };
  let rootFrom = "";

  const setRoot = (dir: string, source: string): void => {
    // Silently preferring one over the other would expose a folder the user
    // did not name — and this process hands that folder to a browser.
    if (o.root) fail(`folder given twice: ${rootFrom} "${o.root}" and ${source} "${dir}"`);
    o.root = dir;
    rootFrom = source;
  };

  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = (): string => inline ?? argv[++i] ?? "";
    switch (flag) {
      case "--root": setRoot(value(), "--root"); break;
      case "--port": o.port = Number(value()) || o.port; break;
      case "--token": o.token = value(); break;
      case "--allow-origin": o.origins.push(value().replace(/\/$/, "")); break;
      case "--version":
      case "-v":
        console.log(VERSION);
        process.exit(0);
      case "--help":
      case "-h":
        console.log(HELP);
        process.exit(0);
      default:
        // A mistyped flag must not be read as a folder, and must not be
        // ignored either — ignoring it would silently expose the current
        // directory instead of the one that was meant.
        if (flag.startsWith("-")) fail(`unknown option "${flag}"`);
        setRoot(argv[i], "argument");
    }
  }

  if (!o.root) o.root = process.cwd();
  return o;
}

const HELP = `enc-tool agent — local filesystem + git bridge for the web editor

  enc-tool-agent [folder] [options]

The folder may be given as the first argument, so the binary can live anywhere
and be pointed at a project instead of copied into one:

  enc-tool-agent ~/work/my-project --allow-origin https://enc.example.com

  --root <dir>            same thing as the positional folder
                          (default: current directory)
  --port <n>              loopback port (default: 5001)
  --token <str>           fixed access token (default: random, printed below)
  --allow-origin <url>    origin allowed to connect, repeatable
                          (loopback origins are always allowed)
  --version               print the version and exit

Environment:
  ENC_TOOL_ALLOW_ORIGIN   extra allowed origins, comma-separated — the same as
                          --allow-origin, but set once instead of per run

The agent listens on 127.0.0.1 only. Paste the URL below into the editor tab.`;

// ── connection state ──────────────────────────────────────────────────────

interface Conn {
  watcher: Watcher | null;
  /** Cancellation flags for requests still running, keyed by request id. */
  inflight: Map<number, Signal>;
}

// ── op dispatch ───────────────────────────────────────────────────────────

type Send = (frame: ServerFrame) => void;
interface Ctx {
  jail: Jail;
  /** cwd for git — the repository root, which is also the workspace root. */
  cwd: string;
  info: AgentInfo;
  conn: Conn;
  send: Send;
  id: number;
  signal: Signal;
}

const str = (v: unknown): string => String(v ?? "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

const OPS: Record<string, (ctx: Ctx, p: Req) => Promise<unknown>> = {
  "agent.info": async (c) => c.info,

  // ── filesystem ──
  "fs.readdir": (c, p) => fsops.readDir(c.jail, str(p.path)),
  "fs.read": (c, p) => fsops.readTextFile(c.jail, str(p.path)),
  "fs.write": (c, p) => fsops.writeTextFile(c.jail, str(p.path), str(p.text)),
  "fs.createFile": (c, p) => fsops.createFile(c.jail, str(p.path)).then(() => ({ ok: true })),
  "fs.createDir": (c, p) => fsops.createDir(c.jail, str(p.path)).then(() => ({ ok: true })),
  "fs.move": (c, p) => fsops.movePath(c.jail, str(p.from), str(p.to)).then(() => ({ ok: true })),
  "fs.delete": (c, p) => fsops.deletePaths(c.jail, strs(p.paths)).then(() => ({ ok: true })),
  "fs.stat": (c, p) => fsops.statPath(c.jail, str(p.path)),

  // ── git: read ──
  "git.status": (c) => git.status(c.cwd),
  "git.log": (c, p) =>
    git.log(c.cwd, {
      ref: p.ref ? str(p.ref) : undefined,
      limit: Number(p.limit) || undefined,
      all: Boolean(p.all),
      path: p.path ? str(p.path) : undefined,
    }),
  "git.branches": (c) => git.branches(c.cwd),
  "git.commitDetail": (c, p) => git.commitDetail(c.cwd, str(p.oid)),
  "git.blob": (c, p) => git.blobAt(c.cwd, str(p.rev), str(p.path)),
  "git.blame": (c, p) => git.blame(c.cwd, str(p.path)),
  "git.diff": (c, p) =>
    git.diffPair(c.cwd, str(p.path), str(p.kind), async () => {
      const f = await fsops.readTextFile(c.jail, str(p.path)).catch(() => null);
      return f?.text ?? null;
    }),

  // ── git: index + commits ──
  "git.stage": (c, p) => gw.stage(c.cwd, strs(p.paths)),
  "git.unstage": (c, p) => gw.unstage(c.cwd, strs(p.paths)),
  "git.discard": (c, p) => gw.discard(c.cwd, strs(p.paths)),
  "git.resolve": (c, p) => gw.markResolved(c.cwd, strs(p.paths)),
  "git.commit": (c, p) =>
    gw.commit(c.cwd, { message: str(p.message), amend: Boolean(p.amend), all: Boolean(p.all) }),
  "git.identity": (c) => gw.identity(c.cwd),

  // ── git: refs ──
  "git.checkout": (c, p) => gw.checkout(c.cwd, str(p.ref)),
  "git.branchCreate": (c, p) => gw.branchCreate(c.cwd, str(p.name), p.from ? str(p.from) : undefined),
  "git.branchDelete": (c, p) => gw.branchDelete(c.cwd, str(p.name), Boolean(p.force)),
  "git.branchRename": (c, p) => gw.branchRename(c.cwd, str(p.from), str(p.to)),
  "git.reset": (c, p) => gw.reset(c.cwd, str(p.oid), (str(p.mode) || "mixed") as "soft" | "mixed" | "hard"),
  "git.revert": (c, p) => gw.revert(c.cwd, str(p.oid)),
  "git.cherryPick": (c, p) => gw.cherryPick(c.cwd, str(p.oid)),

  // ── git: merge / rebase / stash ──
  "git.merge": (c, p) => gw.merge(c.cwd, str(p.ref), Boolean(p.noFf)),
  "git.mergeAbort": (c) => gw.mergeAbort(c.cwd),
  "git.rebase": (c, p) =>
    gw.rebase(c.cwd, (str(p.action) || "start") as "start" | "continue" | "abort" | "skip", p.ref ? str(p.ref) : undefined),
  "git.stash": (c, p) =>
    gw.stash(c.cwd, (str(p.action) || "list") as "push" | "pop" | "apply" | "drop" | "list" | "clear", {
      message: p.message ? str(p.message) : undefined,
      ref: p.ref ? str(p.ref) : undefined,
    }),

  // ── git: remotes (streams progress) ──
  "git.remotes": (c) => gw.remotes(c.cwd),
  "git.remote": (c, p) =>
    gw.remote(
      c.cwd,
      (str(p.action) || "fetch") as "fetch" | "pull" | "push",
      {
        remote: p.remote ? str(p.remote) : undefined,
        ref: p.ref ? str(p.ref) : undefined,
        setUpstream: Boolean(p.setUpstream),
        force: Boolean(p.force),
      },
      (line) => c.send({ id: c.id, chunk: { progress: line } }),
    ),

  // ── search (streams hits) ──
  search: async (c, p) => {
    const it = search(
      c.cwd,
      {
        query: str(p.query),
        matchCase: Boolean(p.matchCase),
        wholeWord: Boolean(p.wholeWord),
        regex: Boolean(p.regex),
        include: p.include ? str(p.include) : undefined,
        exclude: p.exclude ? str(p.exclude) : undefined,
        maxMatches: Number(p.maxMatches) || undefined,
      },
      c.info.ripgrep !== null,
      c.signal,
    );
    let next = await it.next();
    while (!next.done) {
      c.send({ id: c.id, chunk: { hit: next.value } });
      next = await it.next();
    }
    return next.value;
  },

  /** Supersede a running request — search-as-you-type issues one per keystroke
   *  and abandons the previous, which would otherwise keep scanning. */
  cancel: async (c, p) => {
    const target = c.conn.inflight.get(Number(p.target));
    if (target) target.cancelled = true;
    return { cancelled: Boolean(target) };
  },

  // ── watcher ──
  "watch.start": async (c) => {
    c.conn.watcher?.close();
    c.conn.watcher = Watcher.start(c.jail.root, (paths) => c.send({ event: "fs.change", data: { paths } }));
    return { watching: c.conn.watcher !== null };
  },
  "watch.stop": async (c) => {
    c.conn.watcher?.close();
    c.conn.watcher = null;
    return { watching: false };
  },
};

// ── server ────────────────────────────────────────────────────────────────

export async function startAgent(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const token = opts.token || randomBytes(16).toString("hex");

  let jail: Jail;
  try {
    jail = await Jail.open(opts.root);
  } catch {
    console.error(`agent: cannot open folder: ${opts.root}`);
    process.exit(1);
  }

  // Snap the workspace to the repository root when the folder sits inside one:
  // git reports paths relative to the toplevel, and one coordinate system for
  // both filesystem and git paths is what keeps the UI honest.
  const top = await git.repoRoot(jail.root);
  if (top) {
    const snapped = await Jail.open(top);
    if (snapped.root !== jail.root) console.log(`agent: using repository root ${snapped.root}`);
    jail = snapped;
  }

  const info: AgentInfo = {
    agent: "enc-tool",
    version: VERSION,
    platform: process.platform,
    root: jail.root,
    repo: top ? "." : null,
    gitVersion: await probe(["git", "--version"]),
    ripgrep: await probe(["rg", "--version"]),
    watch: true,
  };
  // Probe the watcher once so agent.info can tell the UI the truth up front.
  const probeWatcher = Watcher.start(jail.root, () => {});
  info.watch = probeWatcher !== null;
  probeWatcher?.close();

  const originAllowed = (origin: string | null): boolean => {
    if (!origin) return true; // non-browser client; the token still gates it
    if (opts.origins.includes(origin.replace(/\/$/, ""))) return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  };

  const cors = (origin: string | null): Record<string, string> =>
    origin && originAllowed(origin)
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-headers": "content-type",
          // Forward-compat with Chrome's Private Network Access preflight, which
          // would otherwise start blocking https -> loopback without warning.
          "access-control-allow-private-network": "true",
          vary: "origin",
        }
      : {};

  const server = Bun.serve<{ conn: Conn }>({
    port: opts.port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const headers = cors(origin);

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

      // Unauthenticated liveness probe: the UI's capability badge needs to tell
      // "agent not running" apart from "wrong token", and this reveals nothing
      // beyond the agent's presence to origins already on the allowlist.
      if (url.pathname === "/ping") {
        if (!originAllowed(origin)) return new Response("forbidden", { status: 403 });
        return Response.json({ agent: "enc-tool", version: VERSION }, { headers });
      }

      if (url.pathname === "/ws") {
        if (!originAllowed(origin)) return new Response("forbidden", { status: 403, headers });
        if (url.searchParams.get("token") !== token) return new Response("unauthorized", { status: 401, headers });
        if (srv.upgrade(req, { data: { conn: { watcher: null, inflight: new Map() } } })) return undefined;
        return new Response("upgrade failed", { status: 400, headers });
      }
      return new Response("not found", { status: 404, headers });
    },
    websocket: {
      message(ws, raw) {
        let req: Req;
        try {
          req = JSON.parse(String(raw)) as Req;
        } catch {
          return;
        }
        const send: Send = (frame) => {
          if (ws.readyState === 1) ws.send(JSON.stringify(frame));
        };
        const handler = OPS[req.op];
        if (!handler) return send({ id: req.id, ok: false, error: `Unknown op: ${req.op}`, code: "ENOOP" });
        if (!top && req.op.startsWith("git.")) {
          return send({ id: req.id, ok: false, error: "Not a git repository", code: "ENOREPO" });
        }

        const conn = ws.data.conn;
        const signal: Signal = { cancelled: false };
        conn.inflight.set(req.id, signal);
        const ctx: Ctx = { jail, cwd: jail.root, info, conn, send, id: req.id, signal };
        // Not awaited: a long search or push must not block other requests.
        void handler(ctx, req)
          .then(
            (data) => send({ id: req.id, ok: true, data }),
            (e: unknown) => {
              const err = e as { message?: string; code?: string };
              send({ id: req.id, ok: false, error: err?.message ?? String(e), code: err?.code });
            },
          )
          .finally(() => conn.inflight.delete(req.id));
      },
      close(ws) {
        ws.data.conn.watcher?.close();
        ws.data.conn.watcher = null;
        // Nothing will read the results now; let running scans stop early.
        for (const signal of ws.data.conn.inflight.values()) signal.cancelled = true;
        ws.data.conn.inflight.clear();
      },
    },
  });

  const url = `ws://127.0.0.1:${server.port}/ws?token=${token}`;
  console.log(`
enc-tool agent ${VERSION}
  folder    ${jail.root}
  git       ${info.gitVersion ?? "NOT FOUND — git operations are unavailable"}
  ripgrep   ${info.ripgrep ?? "not found — using the slower built-in search"}
  watcher   ${info.watch ? "live" : "unavailable on this platform"}
  origins   ${opts.origins.length ? opts.origins.join(", ") : "loopback only (pass --allow-origin for a remote UI)"}

  Paste this into the editor tab:
  ${url}
`);
}
