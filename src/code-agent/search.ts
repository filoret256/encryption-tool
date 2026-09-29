/** Project-wide search.
 *
 *  ripgrep does the work when it is installed — it already honours .gitignore,
 *  skips binaries and is an order of magnitude faster than anything reachable
 *  from JS. Without it we fall back to `git ls-files -co --exclude-standard`,
 *  which gives the same file set (tracked + untracked, ignores applied) for
 *  free, and scan those files here.
 *
 *  Results stream: the UI fills in as hits arrive rather than waiting for the
 *  whole tree, which is what makes a large repo feel usable.
 *
 *  The fallback matches in a worker, under a deadline — see ScanWorker.
 */
import { open, stat } from "node:fs/promises";
import { iter, run } from "./proc.ts";
import { isBinary } from "./fs-ops.ts";
import { readOnly } from "./git.ts";
import type { Jail } from "./jail.ts";
import type { SearchHit, SearchSummary } from "./protocol.ts";

export interface SearchOpts {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  include?: string;
  exclude?: string;
  /** Stop after this many matches so a stray "." cannot flood the socket. */
  maxMatches?: number;
}

/** Cooperative cancellation. Search-as-you-type supersedes its own requests
 *  constantly; without this the code-agent would keep a dead scan running (and, with
 *  ripgrep, a dead process) for every keystroke. */
export interface Signal {
  cancelled: boolean;
}

const DEFAULT_MAX = 5000;
const MAX_FILE = 2 * 1024 * 1024;

/** Escape a literal query so it can be handed to a regex engine unchanged. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ripgrep reports byte offsets within the line; the browser indexes strings by
 *  UTF-16 code unit. Identical for ASCII, which is the overwhelming majority. */
function byteToChar(text: string, byteOffset: number): number {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === text.length) return byteOffset; // pure ASCII
  return new TextDecoder().decode(bytes.subarray(0, byteOffset)).length;
}

/** Takes the jail rather than a bare folder: the fallback opens every file it
 *  lists, and each of those has to be vouched for by the same containment check
 *  as any other read — see readSearchable. */
export async function* search(
  jail: Jail,
  opts: SearchOpts,
  ripgrep: boolean,
  signal: Signal = { cancelled: false },
): AsyncGenerator<SearchHit, SearchSummary> {
  const cap = opts.maxMatches ?? DEFAULT_MAX;
  if (!opts.query) return { files: 0, matches: 0, truncated: false, engine: ripgrep ? "ripgrep" : "fallback" };
  return ripgrep ? yield* rgSearch(jail.root, opts, cap, signal) : yield* jsSearch(jail, opts, cap, signal);
}

// ── ripgrep ───────────────────────────────────────────────────────────────

async function* rgSearch(root: string, o: SearchOpts, cap: number, signal: Signal): AsyncGenerator<SearchHit, SearchSummary> {
  const args = ["rg", "--json", o.matchCase ? "-s" : "-i"];
  if (o.wholeWord) args.push("-w");
  if (!o.regex) args.push("-F");
  if (o.include) args.push("-g", o.include);
  if (o.exclude) args.push("-g", `!${o.exclude}`);
  // -e keeps a pattern that begins with "-" from being read as a flag.
  args.push("-e", o.query);

  const proc = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const files = new Set<string>();
  let matches = 0;
  let truncated = false;

  try {
    const dec = new TextDecoder();
    let tail = "";
    outer: for await (const bytes of iter(proc.stdout as ReadableStream<Uint8Array>)) {
      tail += dec.decode(bytes, { stream: true });
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (signal.cancelled) break outer;
        if (!line) continue;
        let msg: RgMessage;
        try {
          msg = JSON.parse(line) as RgMessage;
        } catch {
          continue;
        }
        if (msg.type !== "match") continue;
        const d = msg.data;
        const path = d.path?.text;
        const text = d.lines?.text;
        if (path === undefined || text === undefined) continue; // non-UTF8 path or line

        const stripped = text.replace(/\r?\n$/, "");
        const ranges = (d.submatches ?? []).map(
          (s) => [byteToChar(stripped, s.start), byteToChar(stripped, s.end)] as [number, number],
        );
        files.add(path);
        matches += ranges.length || 1;
        yield { path: path.replace(/\\/g, "/"), line: d.line_number ?? 0, col: ranges[0]?.[0] ?? 0, text: stripped, ranges };
        if (matches >= cap) {
          truncated = true;
          break outer;
        }
      }
    }
  } finally {
    proc.kill();
  }
  // A cancelled scan is a partial one; say so rather than reporting a complete
  // result the caller would take at face value.
  return { files: files.size, matches, truncated: truncated || signal.cancelled, engine: "ripgrep" };
}

interface RgMessage {
  type: string;
  data: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: { start: number; end: number }[];
  };
}

// ── fallback ──────────────────────────────────────────────────────────────

/** How long one request to the worker may run before it is given up on.
 *
 *  A request is one file's worth of matching, or one pass of the include and
 *  exclude globs over the listing. Either is milliseconds for any pattern a
 *  person would write, so three seconds is not a limit anyone reaches — it is
 *  the point past which the pattern is the problem. */
const REQUEST_LIMIT_MS = 3000;

/** How often a waiting request looks at the cancel flag and the clock. Short
 *  enough that a superseded search stops promptly, long enough to be free. */
const POLL_MS = 20;

interface WorkerHit {
  line: number;
  text: string;
  ranges: [number, number][];
}

interface WorkerRequest {
  op: "init" | "filter" | "scan";
  source?: string;
  flags?: string;
  include?: string | null;
  exclude?: string | null;
  paths?: string[];
  text?: string;
  budget?: number;
}

interface WorkerReply {
  paths?: string[];
  hits?: WorkerHit[];
}

/** Everything that runs inside the worker.
 *
 *  Self-contained on purpose: it is turned into source text and handed to the
 *  worker as a blob, so it cannot see this module. That is what lets it work
 *  unchanged in a compiled executable, where a worker file on disk would have
 *  to be named on the build's command line and shipped alongside.
 *
 *  It is the only place a pattern from the client is ever executed. */
function scanWorker(): void {
  let re: RegExp | null = null;
  let include: RegExp | null = null;
  let exclude: RegExp | null = null;

  self.onmessage = (e: MessageEvent<WorkerRequest>) => {
    const m = e.data;
    if (m.op === "init") {
      re = new RegExp(m.source!, m.flags);
      include = m.include ? new RegExp(m.include) : null;
      exclude = m.exclude ? new RegExp(m.exclude) : null;
      self.postMessage({});
    } else if (m.op === "filter") {
      const paths = m.paths!.filter((p) => (!include || include.test(p)) && !(exclude && exclude.test(p)));
      self.postMessage({ paths });
    } else {
      const lines = m.text!.split(/\r?\n/);
      const hits: WorkerHit[] = [];
      let matches = 0;
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i];
        re!.lastIndex = 0;
        const ranges: [number, number][] = [];
        for (let x = re!.exec(text); x; x = re!.exec(text)) {
          ranges.push([x.index, x.index + x[0].length]);
          if (x[0] === "") re!.lastIndex++; // zero-width match would loop forever
        }
        if (!ranges.length) continue;
        hits.push({ line: i + 1, text, ranges });
        matches += ranges.length;
        if (matches >= m.budget!) break;
      }
      self.postMessage({ hits });
    }
  };
}

const WORKER_SOURCE = `(${scanWorker.toString()})()`;

const TOO_SLOW =
  `The pattern took more than ${REQUEST_LIMIT_MS / 1000} s on one file, so the search was stopped. ` +
  "ripgrep is not installed, and without it this code-agent matches in JavaScript, where a pattern with nested " +
  "repetition can take exponential time. Install ripgrep, or simplify the pattern.";

/** Runs the client's patterns off the code-agent's thread, on a deadline.
 *
 *  A regular expression from the client runs in a backtracking engine, and
 *  `(a+)+$` against a line of a's is exponential. JavaScriptCore stops each
 *  attempt after about 0.6 s, measured — which bounds one line, not a file: with
 *  forty such lines that is twenty-four seconds on the code-agent's own thread, and
 *  the whole code-agent (every other request, the watcher, the socket itself) waits
 *  behind it. Cancel cannot help, because the thread that would read it is the
 *  one that is busy.
 *
 *  So the patterns run here instead, and a request that does not answer in
 *  REQUEST_LIMIT_MS is abandoned by terminating the worker. Checked, not
 *  assumed: terminate() does stop a worker inside a catastrophic match.
 *
 *  Go's code-agent and ripgrep need none of this — both use linear-time engines.
 *  That is also why this only exists for the fallback: install ripgrep and the
 *  problem is not merely bounded but absent.
 *
 *  The globs are matched here as well. They become regular expressions too, and
 *  a run of `*` is a run of `[^/]*`, which backtracks polynomially on a long
 *  path — the same class of problem, reached through a different box. */
class ScanWorker {
  private readonly url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  private readonly worker = new Worker(this.url);

  /** One request at a time. Resolves null if the search was cancelled while it
   *  waited; rejects if the deadline passed. Either way the caller closes. */
  request(message: WorkerRequest, signal: Signal): Promise<WorkerReply | null> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const settle = (finish: () => void): void => {
        clearInterval(timer);
        this.worker.onmessage = null;
        this.worker.onerror = null;
        finish();
      };
      const timer = setInterval(() => {
        if (signal.cancelled) settle(() => resolve(null));
        else if (Date.now() - started > REQUEST_LIMIT_MS) settle(() => reject(new Error(TOO_SLOW)));
      }, POLL_MS);
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => settle(() => resolve(e.data));
      this.worker.onerror = (e: ErrorEvent) => settle(() => reject(new Error(e.message || "search worker failed")));
      this.worker.postMessage(message);
    });
  }

  close(): void {
    this.worker.terminate();
    URL.revokeObjectURL(this.url);
  }
}

/** The text of a file the listing named, or null when it is not to be scanned.
 *
 *  The listing is a list of names, and a name is not a promise about where it
 *  leads: a symlink committed to the repository (`notes -> ~/.ssh/id_rsa`) is
 *  listed like any other file, and `readFile` follows it out of the workspace.
 *  The results carry the matching lines, so a search would have been a way to
 *  read a file the jail exists to keep out of reach. Every other op reads
 *  through `toAbsExisting`; this one did not, which is the whole of that hole.
 *  ripgrep does not follow links by default, so only this path was open.
 *
 *  The size is checked before the read, not after. Reading a file and then
 *  finding it too large costs the whole file, and search-as-you-type would pay
 *  that for a tracked 500 MB dump on every keystroke. The read is bounded by the
 *  size that was checked, so a file that grows in between is skipped rather than
 *  read whole. Anything that is not a regular file is skipped: opening a FIFO
 *  would wait for a writer that never comes. */
async function readSearchable(jail: Jail, rel: string): Promise<string | null> {
  try {
    const abs = await jail.toAbsExisting(rel);
    const st = await stat(abs);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const fh = await open(abs, "r");
    try {
      const buf = new Uint8Array(st.size + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > st.size) return null; // grew since it was measured
      const bytes = buf.subarray(0, bytesRead);
      return isBinary(bytes) ? null : new TextDecoder().decode(bytes);
    } finally {
      await fh.close();
    }
  } catch {
    return null; // outside the workspace, inside the git directory, gone, or unreadable
  }
}

async function* jsSearch(jail: Jail, o: SearchOpts, cap: number, signal: Signal): AsyncGenerator<SearchHit, SearchSummary> {
  let src = o.regex ? o.query : escapeRe(o.query);
  if (o.wholeWord) src = `\\b(?:${src})\\b`;
  const flags = o.matchCase ? "g" : "gi";
  // Compiled here first, only to be told it is malformed: a syntax error is a
  // failed search the UI can report, and it should not have to come back from a
  // worker to be one. Compiling runs nothing.
  new RegExp(src, flags);

  const listed = await run(readOnly(["ls-files", "-co", "--exclude-standard", "-z"]), jail.root);
  const listing = listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : [];

  const files = new Set<string>();
  let matches = 0;
  const partial = (): SearchSummary => ({ files: files.size, matches, truncated: true, engine: "fallback" });

  const worker = new ScanWorker();
  try {
    const ready = await worker.request(
      {
        op: "init",
        source: src,
        flags,
        include: o.include ? globSource(o.include) : null,
        exclude: o.exclude ? globSource(o.exclude) : null,
      },
      signal,
    );
    if (!ready) return partial();
    const filtered = await worker.request({ op: "filter", paths: listing }, signal);
    if (!filtered) return partial();

    for (const rel of filtered.paths ?? []) {
      if (signal.cancelled) return partial();

      const text = await readSearchable(jail, rel);
      if (text === null) continue;

      const scanned = await worker.request({ op: "scan", text, budget: cap - matches }, signal);
      if (!scanned) return partial();
      for (const hit of scanned.hits ?? []) {
        files.add(rel);
        matches += hit.ranges.length;
        yield { path: rel, line: hit.line, col: hit.ranges[0][0], text: hit.text, ranges: hit.ranges };
      }
      if (matches >= cap) return partial();
    }
  } finally {
    worker.close();
  }
  return { files: files.size, matches, truncated: false, engine: "fallback" };
}

/** Minimal glob support for the include/exclude boxes: * and ** only. Returns
 *  regular-expression source, which the worker compiles and runs. */
function globSource(glob: string): string {
  const src = glob
    .split("/")
    .map((seg) => (seg === "**" ? ".*" : escapeRe(seg).replace(/\\\*/g, "[^/]*")))
    .join("/");
  return `^${src}$|(^|/)${src}($|/)`;
}
