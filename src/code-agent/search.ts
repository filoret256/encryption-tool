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
import type { SearchHit, SearchStop, SearchSummary } from "./protocol.ts";

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

/** How far a scan has got. Sent while it runs, and in the summary at the end.
 *
 *  `candidates` is how many files the scan had to choose from and `scanned` how
 *  many it looked at, so "12,300 of 40,000" is a sentence the page can write.
 *  ripgrep walks the tree itself and reports neither, so both are null with it. */
export interface ScanProgress {
  scanned: number;
  candidates: number;
}

const DEFAULT_MAX = 5000;
const MAX_FILE = 2 * 1024 * 1024;

/** How long a whole scan may run, with either engine.
 *
 *  The per-request limit below bounds one file; nothing bounded the sum. A
 *  repository of 40,000 files where each takes a few milliseconds is minutes of
 *  scanning, and search-as-you-type issues one of these per keystroke — so a
 *  slow-enough pattern was a promise the code-agent could not keep, with no
 *  number in it and no way to say how far it had got. Thirty seconds is past
 *  any scan a person waits for, and the answer says it stopped there. */
const SCAN_LIMIT_MS = 30_000;

/** How many files between progress frames. A frame every file would be 40,000
 *  frames for one scan, which is the thing batching exists to avoid. */
const PROGRESS_EVERY = 512;

/** The three numbers above, as one thing a caller may tighten.
 *
 *  Same shape as the process deadlines in proc.ts: the defaults are what the
 *  code-agent runs with, and a test that cannot wait thirty seconds passes its
 *  own — which is the only way to check a bound without reaching it. */
export interface ScanLimits {
  scanMs?: number;
  requestMs?: number;
  progressEvery?: number;
}

export function scanLimits(given: ScanLimits = {}): Required<ScanLimits> {
  return {
    scanMs: given.scanMs ?? SCAN_LIMIT_MS,
    requestMs: given.requestMs ?? REQUEST_LIMIT_MS,
    progressEvery: given.progressEvery ?? PROGRESS_EVERY,
  };
}

/** Escape a literal query so it can be handed to a regex engine unchanged. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The most highlighted ranges one line carries. A minified bundle is one line with tens of
 *  thousands of matches, and a result that holds all of them is megabytes for one row nobody
 *  can read; the count of matches is still the true one. */
const MAX_RANGES_PER_LINE = 500;

/** A line's submatches as UTF-16 ranges. ripgrep reports byte offsets within the line; the
 *  browser indexes strings by UTF-16 code unit — identical for ASCII, which is the
 *  overwhelming majority. The line is encoded once rather than once per
 *  offset: two offsets a match used to cost two encodings of the whole line — 1.6 MB of
 *  allocations for a 4 KB line with 200 matches. A line of ASCII, nearly all of them, is not
 *  encoded at all. */
function toCharRanges(text: string, submatches: { start: number; end: number }[]): [number, number][] {
  const shown = submatches.length > MAX_RANGES_PER_LINE ? submatches.slice(0, MAX_RANGES_PER_LINE) : submatches;
  if (!/[^\u0000-\u007f]/.test(text)) return shown.map((s) => [s.start, s.end]);
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  const at = (offset: number): number => decoder.decode(bytes.subarray(0, offset)).length;
  return shown.map((s) => [at(s.start), at(s.end)]);
}

/** Takes the jail rather than a bare folder: the fallback opens every file it
 *  lists, and each of those has to be vouched for by the same containment check
 *  as any other read — see readSearchable. */
export async function* search(
  jail: Jail,
  opts: SearchOpts,
  ripgrep: boolean,
  signal: Signal = { cancelled: false },
  onProgress?: (p: ScanProgress) => void,
  given: ScanLimits = {},
): AsyncGenerator<SearchHit, SearchSummary> {
  const limits = scanLimits(given);
  const cap = opts.maxMatches ?? DEFAULT_MAX;
  if (!opts.query) {
    return {
      files: 0,
      matches: 0,
      truncated: false,
      engine: ripgrep ? "ripgrep" : "fallback",
      reason: null,
      scanned: ripgrep ? null : 0,
      candidates: ripgrep ? null : 0,
    };
  }
  const deadline = Date.now() + limits.scanMs;
  return ripgrep
    ? yield* rgSearch(jail.root, opts, cap, signal, deadline)
    : yield* jsSearch(jail, opts, cap, signal, deadline, limits.requestMs, limits.progressEvery, onProgress);
}

// ── ripgrep ───────────────────────────────────────────────────────────────

async function* rgSearch(
  root: string,
  o: SearchOpts,
  cap: number,
  signal: Signal,
  deadline: number,
): AsyncGenerator<SearchHit, SearchSummary> {
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
  let reason: SearchStop | null = null;

  try {
    const dec = new TextDecoder();
    let tail = "";
    outer: for await (const bytes of iter(proc.stdout as ReadableStream<Uint8Array>)) {
      tail += dec.decode(bytes, { stream: true });
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (signal.cancelled) {
          reason = "cancelled";
          break outer;
        }
        if (Date.now() > deadline) {
          // Same bound as the fallback, and the same sentence at the end: a scan
          // that ran this long is one the caller has stopped waiting for.
          reason = "time";
          break outer;
        }
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
        const submatches = d.submatches ?? [];
        const ranges = toCharRanges(stripped, submatches);
        files.add(path);
        matches += submatches.length || 1;
        yield { path: path.replace(/\\/g, "/"), line: d.line_number ?? 0, col: ranges[0]?.[0] ?? 0, text: stripped, ranges };
        if (matches >= cap) {
          truncated = true;
          reason = "matches";
          break outer;
        }
      }
    }
  } finally {
    proc.kill();
  }
  // A scan that stopped early is a partial one; say so rather than reporting a
  // complete result the caller would take at face value.
  return {
    files: files.size,
    matches,
    truncated: truncated || reason !== null,
    engine: "ripgrep",
    reason,
    // ripgrep walks the tree itself: it never tells us how many files there were
    // or how many it looked at, and inventing either would be worse than null.
    scanned: null,
    candidates: null,
  };
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
  // The same limit as MAX_RANGES_PER_LINE, written out: this function is sent as text.
  const MAX_RANGES = 500;
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
          if (ranges.length >= MAX_RANGES) break;
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

/** What a caller is told when one file took longer than its request deadline.
 *  Built from the deadline rather than from the constant, because a caller may
 *  have tightened it and a message with the wrong number in it is worse than
 *  none. */
function tooSlow(requestMs: number): string {
  return (
    `The pattern took more than ${requestMs / 1000} s on one file, so the search was stopped. ` +
    "ripgrep is not installed, and without it this code-agent matches in JavaScript, where a pattern with nested " +
    "repetition can take exponential time. Install ripgrep, or simplify the pattern."
  );
}

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
/** One worker, shared by every scan in this process.
 *
 *  It used to be built per search — a Blob, an object URL and a Worker for every
 *  keystroke of search-as-you-type, each thrown away at the end. That is startup
 *  cost paid on the path a person feels most: the first result of the next
 *  search. One worker serves them all, and the pattern is re-initialised at the
 *  top of each scan, which is all the isolation the old arrangement bought.
 *
 *  A worker that misses a request deadline is the exception: it is still inside
 *  the match that missed it and will never read another message, so it is
 *  terminated and forgotten rather than handed to the next search. */
let sharedWorker: ScanWorker | null = null;

function sharedScanWorker(): ScanWorker {
  sharedWorker ??= new ScanWorker();
  return sharedWorker;
}

function dropWorker(worker: ScanWorker): void {
  worker.close();
  if (sharedWorker === worker) sharedWorker = null;
}

class ScanWorker {
  private readonly url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  private readonly worker = new Worker(this.url);
  /** Set when this worker has been given up on: a stuck worker is never reused. */
  dead = false;

  /** One request at a time. Resolves null if the search was cancelled while it
   *  waited; rejects if the deadline passed, and then the worker is killed.
   *
   *  terminate() is what actually stops a catastrophic match — checked, not
   *  assumed — and it has to happen here rather than in the caller's `finally`,
   *  because the worker is shared: a caller that walked away from a stuck worker
   *  would leave it for the next search to post into. */
  request(message: WorkerRequest, signal: Signal, requestMs: number): Promise<WorkerReply | null> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const settle = (finish: () => void): void => {
        clearInterval(timer);
        this.worker.onmessage = null;
        this.worker.onerror = null;
        finish();
      };
      const timer = setInterval(() => {
        if (signal.cancelled) {
          settle(() => resolve(null));
        } else if (Date.now() - started > requestMs) {
          this.dead = true;
          dropWorker(this);
          settle(() => reject(new Error(tooSlow(requestMs))));
        }
      }, POLL_MS);
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => settle(() => resolve(e.data));
      this.worker.onerror = (e: ErrorEvent) => {
        this.dead = true;
        settle(() => reject(new Error(e.message || "search worker failed")));
      };
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

async function* jsSearch(
  jail: Jail,
  o: SearchOpts,
  cap: number,
  signal: Signal,
  deadline: number,
  requestMs: number,
  progressEvery: number,
  onProgress?: (p: ScanProgress) => void,
): AsyncGenerator<SearchHit, SearchSummary> {
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
  let scanned = 0;
  const candidates = listing.length;
  const summary = (reason: SearchStop | null): SearchSummary => ({
    files: files.size,
    matches,
    // Anything but a scan that reached the end is a partial answer.
    truncated: reason !== null,
    engine: "fallback",
    reason,
    scanned,
    candidates,
  });

  const worker = sharedScanWorker();
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
      requestMs,
    );
    if (!ready) return summary("cancelled");
    const filtered = await worker.request({ op: "filter", paths: listing }, signal, requestMs);
    if (!filtered) return summary("cancelled");

    for (const rel of filtered.paths ?? []) {
      if (signal.cancelled) return summary("cancelled");
      // The whole scan is on a clock, not just each request: see SCAN_LIMIT_MS.
      if (Date.now() > deadline) return summary("time");

      const text = await readSearchable(jail, rel);
      if (text === null) continue;
      scanned++;
      // Every PROGRESS_EVERY files the caller is told how far this has got. The
      // scan of a large repository is minutes of silence otherwise.
      if (onProgress && scanned % progressEvery === 0) onProgress({ scanned, candidates });

      const scannedHits = await worker.request({ op: "scan", text, budget: cap - matches }, signal, requestMs);
      if (!scannedHits) return summary("cancelled");
      for (const hit of scannedHits.hits ?? []) {
        files.add(rel);
        matches += hit.ranges.length;
        yield { path: rel, line: hit.line, col: hit.ranges[0][0], text: hit.text, ranges: hit.ranges };
      }
      if (matches >= cap) return summary("matches");
    }
  } finally {
    // A worker that missed its deadline killed itself; a healthy one is kept for
    // the next search. Either way this scan is done with it.
    if (worker.dead) dropWorker(worker);
  }
  // A scan whose caller walked away during the last file has not reached the
  // end, and saying it did would be a complete answer to a question nobody is
  // listening to any more.
  return summary(signal.cancelled ? "cancelled" : null);
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
