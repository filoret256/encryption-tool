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
import { Jail, withinRoot } from "./jail.ts";
import { probe } from "./proc.ts";
import * as fsops from "./fs-ops.ts";
import * as git from "./git.ts";
import * as gw from "./git-write.ts";
import { search, type Signal } from "./search.ts";
import { Watcher } from "./watch.ts";
import type { AgentInfo, Req, ServerFrame } from "./protocol.ts";
import { VERSION } from "../version.ts";
import { AGENT_PORT_MAX, AGENT_PORT_MIN, AGENT_PORT_RANGE, agentPortRange } from "../ports.ts";

// ── CLI ───────────────────────────────────────────────────────────────────

interface Options {
  root: string;
  port: number;
  /** Whether --port named it. An explicit port is bound or the agent stops; the
   *  default one is only where the search for a free port starts. */
  portExplicit: boolean;
  token: string;
  origins: string[];
  noClipboard: boolean;
  allowNoOrigin: boolean;
  allowMultiple: boolean;
  /** Folders `agent.setRoot` may move the workspace into, beyond the startup
   *  root itself. Empty is the safe default — see canReroot(). */
  allowRoots: string[];
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
    port: AGENT_PORT_MIN,
    portExplicit: false,
    token: "",
    origins: envOrigins(),
    noClipboard: false,
    allowNoOrigin: false,
    allowMultiple: false,
    allowRoots: [],
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
      case "--port": {
        // A mistyped port used to fall back to the default, which is the silent
        // wrong answer this file refuses everywhere else: the user would be
        // handed a URL for a port they never asked for.
        const raw = value();
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`--port takes a port number, not "${raw}"`);
        o.port = n;
        o.portExplicit = true;
        break;
      }
      case "--token": o.token = value(); break;
      case "--allow-origin": o.origins.push(value().replace(/\/$/, "")); break;
      case "--no-clipboard": o.noClipboard = true; break;
      case "--allow-no-origin": o.allowNoOrigin = true; break;
      case "--allow-multiple": o.allowMultiple = true; break;
      case "--allow-root": o.allowRoots.push(value()); break;
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
  --port <n>              pin the loopback port. Without it the agent takes the
                          first free port in ${AGENT_PORT_RANGE} — the ports the
                          web app is allowed to open a connection to — so a
                          second agent on a second folder needs no flag at all.
                          A port outside that range is bound as asked, but the
                          browser refuses it unless the web app was started
                          with AGENT_PORTS naming it.
  --token <str>           fixed access token (default: random, printed below)
  --allow-origin <url>    origin allowed to connect, repeatable
                          (http://localhost:5000 and http://127.0.0.1:5000 are
                          allowed by default — the web app's own port)
  --allow-no-origin       also accept clients that send no Origin header:
                          curl, scripts, anything that is not a browser. Off by
                          default — a browser always sends one, so a missing
                          Origin is never the app.
  --allow-root <dir>      another folder the editor may switch the workspace
                          to, repeatable. Without it the workspace can only be
                          moved inside the folder the agent was started on,
                          which can never reach anything it could not already
                          read. Naming a folder here is what lets the editor
                          open a second project without a second agent.
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
  /** How to reach this client. Set once the socket is open; used by a reroot
   *  to re-aim a watcher that is running on a folder this agent has left. */
  send: Send | null;
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
  /** Move the whole agent to another folder. Supplied by startAgent, which owns
   *  the mutable workspace state; see reroot() there. */
  reroot: (dir: string) => Promise<AgentInfo>;
}

const str = (v: unknown): string => String(v ?? "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

const OPS: Record<string, (ctx: Ctx, p: Req) => Promise<unknown>> = {
  "agent.info": async (c) => c.info,

  /** Point the agent at a different folder without restarting it.
   *
   *  The path is absolute and native — this is the one op whose whole purpose
   *  is to leave the current workspace, so it does not go through the jail. It
   *  goes through canReroot() instead, which is the operator's boundary rather
   *  than the page's: by default only the folder the agent was started on and
   *  what is under it, which cannot reach anything the agent could not already
   *  read. Widening that is a --allow-root flag and therefore a decision made at
   *  the terminal, never by the page asking nicely. */
  "agent.setRoot": (c, p) => c.reroot(str(p.path)),

  // ── filesystem ──
  "fs.readdir": (c, p) => fsops.readDir(c.jail, str(p.path)),
  "fs.read": (c, p) => fsops.readTextFile(c.jail, str(p.path), { offset: num(p.offset), length: num(p.length) }),
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
      skip: num(p.skip) || undefined,
    }),
  "git.branches": (c) => git.branches(c.cwd),
  "git.checkIgnore": (c, p) => git.checkIgnore(c.cwd, strs(p.paths)),
  "git.reflog": (c, p) => git.reflog(c.cwd, num(p.limit) || 50),
  "git.commitDetail": (c, p) => git.commitDetail(c.cwd, str(p.oid), num(p.parent) || 1),
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
  "git.applyPatch": (c, p) => gw.applyPatch(c.cwd, str(p.patch), Boolean(p.reverse)),
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
  "git.tagCreate": (c, p) =>
    gw.tagCreate(c.cwd, str(p.name), {
      ref: p.ref ? str(p.ref) : undefined,
      message: p.message ? str(p.message) : undefined,
      force: Boolean(p.force),
    }),
  "git.tagDelete": (c, p) => gw.tagDelete(c.cwd, str(p.name)),

  // ── git: merge / rebase / stash ──
  "git.merge": (c, p) => gw.merge(c.cwd, str(p.ref), Boolean(p.noFf), Boolean(p.squash)),
  "git.mergeAbort": (c) => gw.mergeAbort(c.cwd),
  "git.rebase": (c, p) =>
    gw.rebase(c.cwd, (str(p.action) || "start") as "start" | "continue" | "abort" | "skip", p.ref ? str(p.ref) : undefined),
  "git.sequencer": (c, p) =>
    gw.sequencer(
      c.cwd,
      (str(p.what) || "cherry-pick") as "cherry-pick" | "revert",
      (str(p.action) || "abort") as "continue" | "abort" | "skip",
    ),
  "git.stash": (c, p) =>
    gw.stash(c.cwd, (str(p.action) || "list") as "push" | "pop" | "apply" | "drop" | "list" | "clear", {
      message: p.message ? str(p.message) : undefined,
      ref: p.ref ? str(p.ref) : undefined,
    }),

  // ── git: remotes (streams progress) ──
  "git.remotes": (c) => gw.remotes(c.cwd),
  "git.remoteAdmin": (c, p) =>
    gw.remoteAdmin(c.cwd, (str(p.action) || "add") as "add" | "rename" | "remove", {
      name: p.name ? str(p.name) : undefined,
      url: p.url ? str(p.url) : undefined,
      to: p.to ? str(p.to) : undefined,
    }),
  "git.remote": (c, p) =>
    gw.remote(
      c.cwd,
      (str(p.action) || "fetch") as "fetch" | "pull" | "push",
      {
        remote: p.remote ? str(p.remote) : undefined,
        ref: p.ref ? str(p.ref) : undefined,
        setUpstream: Boolean(p.setUpstream),
        force: Boolean(p.force),
        mode: p.mode ? str(p.mode) : undefined,
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

/** Live connections. Only `agent.setRoot` reads this, and only to re-aim the
 *  watchers: a watcher left on a folder the agent has left reports changes the
 *  client cannot resolve to any path it is showing. */
const connections = new Set<Conn>();

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
  //
  // `snap` is reused by agent.setRoot, which has to do exactly the same thing
  // to the folder it is handed.
  const snap = async (dir: string): Promise<{ jail: Jail; top: string | null }> => {
    const opened = await Jail.open(dir);
    const toplevel = await git.repoRoot(opened.root);
    return { jail: toplevel ? await Jail.open(toplevel) : opened, top: toplevel };
  };

  let top: string | null;
  ({ jail, top } = await snap(jail.root));
  if (top && top !== opts.root) console.log(`agent: using repository root ${jail.root}`);

  /** Folders the workspace may be moved into.
   *
   *  The startup root is always one of them, so setRoot can narrow to a
   *  subfolder and come back — neither reaches anything this agent could not
   *  already read, which makes the default a non-escalation rather than a
   *  judgement call. Anything wider is a --allow-root on the command line: the
   *  operator's decision, made at the terminal, not the page's. */
  const rerootBases: string[] = [jail.root];
  for (const dir of opts.allowRoots) {
    try {
      rerootBases.push((await Jail.open(dir)).root);
    } catch {
      fail(`--allow-root folder does not exist: ${dir}`);
    }
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

  /** Move the workspace. Backs `agent.setRoot`; see the op for why the boundary
   *  is where it is.
   *
   *  Every connection's watcher is pointed at the new folder, because a watcher
   *  left on the old one reports changes the client can no longer resolve to a
   *  path — a tree that refreshes on edits to a folder it is not showing. */
  const reroot = async (dir: string): Promise<AgentInfo> => {
    if (!dir) throw new Error("A folder is required");
    let opened: Jail;
    try {
      opened = await Jail.open(dir);
    } catch {
      throw new Error(`Cannot open folder: ${dir}`);
    }
    if (!rerootBases.some((base) => withinRoot(base, opened.root))) {
      throw Object.assign(new Error(`Folder is outside what this agent may open: ${opened.root}`), { code: "EPATH" });
    }
    // Snapping happens after the check, never before: the repository root of an
    // allowed folder can be above it, and that is a folder nobody allowed.
    const next = await snap(opened.root);
    if (!rerootBases.some((base) => withinRoot(base, next.jail.root))) {
      throw Object.assign(new Error(`Repository root is outside what this agent may open: ${next.jail.root}`), {
        code: "EPATH",
      });
    }
    jail = next.jail;
    top = next.top;
    info.root = jail.root;
    info.repo = top ? "." : null;
    for (const c of connections) {
      if (!c.watcher) continue;
      c.watcher.close();
      c.watcher = Watcher.start(jail.root, (paths) => c.send?.({ event: "fs.change", data: { paths } }));
    }
    console.log(`agent: workspace is now ${jail.root}`);
    return info;
  };

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

  /** Bind the first free port, and say why in a sentence when there is none.
   *
   *  Running a second agent on a second folder is an ordinary thing to do, and
   *  what used to happen is that it stopped dead on "address already in use",
   *  leaving the user to pick a port by hand — and then to find out that the
   *  page is only allowed to reach some of them. Walking the range is that
   *  decision made once, here.
   *
   *  An explicit --port is never second-guessed. It names a port, and quietly
   *  serving a different one would hand this folder to a tab that asked for
   *  somebody else's. */
  const listen = <T>(start: (port: number) => T): T => {
    let last: unknown;
    for (const port of opts.portExplicit ? [opts.port] : agentPortRange()) {
      try {
        return start(port);
      } catch (e) {
        // Any refusal moves on to the next candidate rather than stopping: the
        // errno for a taken port is not reported the same way on every
        // platform, and the last one is still reported if none of them work.
        last = e;
      }
    }
    const inUse = (last as { code?: string })?.code === "EADDRINUSE";
    const why = inUse ? "address already in use" : last instanceof Error ? last.message : String(last);
    if (opts.portExplicit) {
      console.error(`agent: cannot listen on 127.0.0.1:${opts.port}: ${why}`);
      if (inUse) console.error(`agent: drop --port and the agent takes the first free port in ${AGENT_PORT_RANGE}`);
    } else {
      console.error(`agent: no free loopback port in ${AGENT_PORT_RANGE}: ${why}`);
      console.error("agent: stop an agent you are done with, or pass --port <n> and start the web app with AGENT_PORTS naming that port");
    }
    process.exit(1);
  };

  const server = listen((port) =>
    Bun.serve<{ conn: Conn; origin: string }>({
    port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const headers = cors(origin);

      // Before anything else, the preflight included: a request that reached
      // this port under a name that is not ours gets nothing back, not even the
      // CORS grant that would tell the page it is worth trying again.
      if (!hostAllowed(req.headers.get("host"), srv.port ?? port)) return new Response("forbidden", { status: 403 });

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
        const conn: Conn = { watcher: null, send: null, inflight: new Map(), slots: new Slots(MAX_CONCURRENT_PROCS) };
        connections.add(conn);
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
        conn.send = send;
        const signal: Signal = { cancelled: false };
        conn.inflight.set(req.id, signal);
        const ctx: Ctx = { jail, cwd: jail.root, info, conn, send, id: req.id, signal, reroot };
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
        connections.delete(ws.data.conn);
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

  /** The port actually bound — which is the one the banner, the Host check and
   *  the URL all have to agree on, and with the range walked above it is no
   *  longer necessarily the one that was asked for. */
  const bound = server.port ?? opts.port;

  // The page's connect-src names the range and nothing outside it, so a port
  // beyond it is one the browser refuses before a packet leaves — which from
  // the tab looks exactly like an agent that never started. On stderr: stdout
  // carries the URL and nothing else, on purpose.
  if (bound < AGENT_PORT_MIN || bound > AGENT_PORT_MAX) {
    lifecycle(
      `warning: port ${bound} is outside ${AGENT_PORT_RANGE} — the editor tab will refuse it unless the web app was started with AGENT_PORTS=${bound}`,
    );
  }

  const url = `ws://127.0.0.1:${bound}/ws?token=${token}`;

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
