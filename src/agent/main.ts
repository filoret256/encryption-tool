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
import { copyToClipboard, interactive } from "./clipboard.ts";
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
  noClipboard: boolean;
  allowNoOrigin: boolean;
  allowMultiple: boolean;
}

/** Origins trusted without being named on the command line: the port the web
 *  app is served from by default (src/server.ts PORT), and nothing else.
 *
 *  What this replaced was a pattern matching *any* loopback origin on *any*
 *  port, which meant every other dev server on the machine — and script
 *  injected into any of them — spoke to this agent with the same authority as
 *  the app itself. A user serving the app elsewhere names it with
 *  --allow-origin: one flag, against a whole class of silent access. */
const DEFAULT_ORIGINS = ["http://localhost:5000", "http://127.0.0.1:5000", "http://[::1]:5000"];

/** Names this agent answers to. Anything else arrived here under a name we did
 *  not choose — see hostAllowed(). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Character class rather than an escape, to match envOrigins() above. */
const TRAILING_SLASH = /[/]+$/;

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
  const o: Options = {
    root: "",
    port: 5001,
    token: "",
    origins: envOrigins(),
    noClipboard: false,
    allowNoOrigin: false,
    allowMultiple: false,
  };
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
      case "--no-clipboard": o.noClipboard = true; break;
      case "--allow-no-origin": o.allowNoOrigin = true; break;
      case "--allow-multiple": o.allowMultiple = true; break;
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
                          (http://localhost:5000 and http://127.0.0.1:5000 are
                          allowed by default — the web app's own port)
  --allow-no-origin       also accept clients that send no Origin header:
                          curl, scripts, anything that is not a browser. Off by
                          default — a browser always sends one, so a missing
                          Origin is never the app.
  --allow-multiple        serve more than one client at once. By default the
                          agent takes a single connection and refuses the rest
                          while it is held, so it is always clear which page is
                          holding the folder.
  --no-clipboard          do not copy the URL to the clipboard on startup
  --version               print the version and exit

Environment:
  ENC_TOOL_ALLOW_ORIGIN   extra allowed origins, comma-separated — the same as
                          --allow-origin, but set once instead of per run

The agent listens on 127.0.0.1 only. Paste the URL below into the editor tab.`;

// ── connection state ──────────────────────────────────────────────────────

/** How many child processes one connection may have running at once.
 *
 *  `search` and every git op spawn one. Search-as-you-type issues a request per
 *  keystroke, and nothing bounded how many of those could be running: the cap
 *  turns a burst into a queue instead of a fork bomb. Four is enough that no
 *  single slow scan blocks the panel a user is looking at. */
const MAX_CONCURRENT_PROCS = 4;

/** A counting semaphore, per connection.
 *
 *  Queues rather than refuses: the client asked for work it is entitled to, and
 *  a request that waits its turn is an ordinary slow response, while one that
 *  fails is an error the UI has to explain. */
class Slots {
  private free: number;
  private waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.free = limit;
  }

  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  }

  /** Let everyone through, for a connection that is going away: a waiter that
   *  is never resolved is a promise that never settles. */
  drain(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

/** Ops that start a child process, and so are worth counting. */
const spawnsProcess = (op: string): boolean => op === "search" || op.startsWith("git.");

interface Conn {
  watcher: Watcher | null;
  /** Cancellation flags for requests still running, keyed by request id. */
  inflight: Map<number, Signal>;
  /** Bounds concurrent child processes — see MAX_CONCURRENT_PROCS. */
  slots: Slots;
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

  const allowedOrigins = new Set([...DEFAULT_ORIGINS, ...opts.origins]);

  /** Refusals are logged: from the browser's side a rejected upgrade looks
   *  exactly like an agent that is not running, so without this line the user
   *  goes off to debug a process that is doing precisely what it was told. */
  const refuse = (what: string, value: string, hint: string): false => {
    console.error(`agent: refused ${what} ${value || "(none)"} — ${hint}`);
    return false;
  };

  const originAllowed = (origin: string | null): boolean => {
    if (!origin) {
      // A browser always sends one. The absence of the header is therefore
      // never the app, and used to be the way past this check entirely.
      return (
        opts.allowNoOrigin ||
        refuse("client with no Origin", "", "pass --allow-no-origin to permit non-browser clients")
      );
    }
    if (allowedOrigins.has(origin.replace(TRAILING_SLASH, ""))) return true;
    return refuse("origin", origin, `pass --allow-origin ${origin}`);
  };

  /** The second lock, and the one that does not depend on the browser
   *  volunteering a header we like.
   *
   *  A page on attacker.example whose DNS answers 127.0.0.1 reaches this
   *  process directly — DNS rebinding. Such a request carries the attacker's
   *  own Origin and the check above refuses it, but it is one check, and with
   *  --allow-no-origin there is no Origin to judge. The name the request
   *  arrived under is the other half: the browser puts the rebound hostname
   *  in Host, and that is never one of ours. */
  const hostAllowed = (host: string | null, port: number): boolean => {
    // The bound port, not the one that was asked for: they are the same today,
    // but the name this agent answers to is the one it actually got.
    const expected = `127.0.0.1:${port}`;
    if (!host) return refuse("request with no Host header", "", "expected " + expected);
    let parsed: URL;
    try {
      parsed = new URL(`http://${host}`);
    } catch {
      return refuse("unparseable Host", host, "expected " + expected);
    }
    if (LOOPBACK_HOSTS.has(parsed.hostname) && parsed.port === String(port)) return true;
    return refuse("Host", host, "this agent answers to " + expected + " only");
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

  /** Connections held right now. The lock in the /ws branch reads it, and the
   *  startup banner promises what it will do. */
  let clients = 0;

  /** Whether the current lock has already been reported. Reset when it lifts. */
  let refusalLogged = false;

  /** Connection lifecycle goes to stderr, not stdout.
   *
   *  stdout carries exactly one thing scripts parse — the URL with the token —
   *  and a line arriving there later, on somebody else's schedule, is the kind
   *  of thing that breaks a pipe reader six months from now. */
  const lifecycle = (message: string): void => console.error(`agent: ${message}`);

  /** Wrapped so a taken port reads as a sentence rather than a stack trace.
   *
   *  Running a second agent on a second folder is an ordinary thing to do, and
   *  the first thing that happens is this — the Go agent already says it in one
   *  line, and there is no reason for the two to differ. */
  const listen = <T>(start: () => T): T => {
    try {
      return start();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EADDRINUSE") {
        console.error(`agent: cannot listen on 127.0.0.1:${opts.port}: address already in use`);
        console.error("agent: another agent is probably on that port — pass --port <n> to pick a free one");
      } else {
        console.error(`agent: cannot listen on 127.0.0.1:${opts.port}: ${e instanceof Error ? e.message : String(e)}`);
      }
      process.exit(1);
    }
  };

  const server = listen(() =>
    Bun.serve<{ conn: Conn; origin: string }>({
    port: opts.port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const headers = cors(origin);

      // Before anything else, the preflight included: a request that reached
      // this port under a name that is not ours gets nothing back, not even the
      // CORS grant that would tell the page it is worth trying again.
      if (!hostAllowed(req.headers.get("host"), srv.port ?? opts.port)) return new Response("forbidden", { status: 403 });

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

      // Unauthenticated liveness probe: the UI's capability badge needs to tell
      // "agent not running" apart from "wrong token", and this reveals nothing
      // beyond the agent's presence to origins already on the allowlist.
      if (url.pathname === "/ping") {
        if (!originAllowed(origin)) return new Response("forbidden", { status: 403 });
        return Response.json({ agent: "enc-tool", version: VERSION }, { headers });
      }

      if (url.pathname === "/ws") {
        // Order matters: the specific refusals first, so a foreign origin or a
        // bad token still says so rather than "busy".
        if (!originAllowed(origin)) return new Response("forbidden", { status: 403, headers });
        if (url.searchParams.get("token") !== token) return new Response("unauthorized", { status: 401, headers });
        if (!opts.allowMultiple && clients > 0) {
          // Once per lock, not once per attempt: a refused tab keeps
          // reconnecting on a backoff, and a line every few seconds would bury
          // the one event worth seeing.
          if (!refusalLogged) {
            refusalLogged = true;
            lifecycle(
              "refused a second client — this agent is locked to the one already connected (--allow-multiple lifts that); further attempts stay quiet until it disconnects",
            );
          }
          return new Response("agent busy", { status: 409, headers });
        }
        // Counted here rather than in open(): between this check and the
        // handshake completing there is a turn of the loop, and two upgrades
        // arriving in it would both have seen zero.
        clients++;
        const conn: Conn = { watcher: null, inflight: new Map(), slots: new Slots(MAX_CONCURRENT_PROCS) };
        if (srv.upgrade(req, { data: { conn, origin: origin ?? "(no Origin)" } })) return undefined;
        clients--;
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
        //
        // Wrapped rather than called directly because a handler can throw
        // *synchronously*: the git helpers validate arguments while building
        // the argv (see safe() in git-write.ts), so `git.checkout` with a ref
        // starting with "-" threw before any promise existed. That escaped this
        // callback and killed the process — a crash reachable by exactly the
        // input the validation was written to reject.
        void (async () => {
          if (!spawnsProcess(req.op)) return handler(ctx, req);
          await conn.slots.acquire();
          try {
            return await handler(ctx, req);
          } finally {
            conn.slots.release();
          }
        })()
          .then(
            (data) => send({ id: req.id, ok: true, data }),
            (e: unknown) => {
              const err = e as { message?: string; code?: string };
              send({ id: req.id, ok: false, error: err?.message ?? String(e), code: err?.code });
            },
          )
          .finally(() => conn.inflight.delete(req.id));
      },
      open(ws) {
        lifecycle(
          opts.allowMultiple
            ? `client connected — ${ws.data.origin} (${clients} connected)`
            : `client connected — ${ws.data.origin} — locked: no other client until this one disconnects`,
        );
      },
      close(ws) {
        clients--;
        refusalLogged = false;
        lifecycle(
          opts.allowMultiple
            ? `client disconnected — ${ws.data.origin} (${clients} connected)`
            : `client disconnected — ${ws.data.origin} — unlocked, accepting a connection again`,
        );
        ws.data.conn.watcher?.close();
        ws.data.conn.watcher = null;
        // Anything still queued for a slot would otherwise wait for a turn that
        // is never coming.
        ws.data.conn.slots.drain();
        // Nothing will read the results now; let running scans stop early.
        for (const signal of ws.data.conn.inflight.values()) signal.cancelled = true;
        ws.data.conn.inflight.clear();
      },
    },
  }),
  );

  const url = `ws://127.0.0.1:${server.port}/ws?token=${token}`;

  // Copied for the user rather than left to their mouse: the token is new on
  // every run, so this is the one line they would otherwise select by hand
  // every single time. Only when someone is actually watching — see
  // interactive() — and never when they have asked us not to.
  const copied = !opts.noClipboard && interactive() && (await copyToClipboard(url));

  console.log(`
enc-tool agent ${VERSION}
  folder    ${jail.root}
  git       ${info.gitVersion ?? "NOT FOUND — git operations are unavailable"}
  ripgrep   ${info.ripgrep ?? "not found — using the slower built-in search"}
  watcher   ${info.watch ? "live" : "unavailable on this platform"}
  origins   ${[...allowedOrigins].join(", ")}
  no-origin ${opts.allowNoOrigin ? "accepted (--allow-no-origin)" : "refused"}
  clients   ${opts.allowMultiple ? "many (--allow-multiple)" : "one at a time — the second is refused while the first holds"}

  Paste this into the editor tab:
  ${url}${copied ? "\n  ✓ copied to your clipboard" : ""}
`);
}
