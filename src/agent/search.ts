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
 */
import { readFile } from "node:fs/promises";
import { iter, run } from "./proc.ts";
import { isBinary } from "./fs-ops.ts";
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
 *  constantly; without this the agent would keep a dead scan running (and, with
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

export async function* search(
  root: string,
  opts: SearchOpts,
  ripgrep: boolean,
  signal: Signal = { cancelled: false },
): AsyncGenerator<SearchHit, SearchSummary> {
  const cap = opts.maxMatches ?? DEFAULT_MAX;
  if (!opts.query) return { files: 0, matches: 0, truncated: false, engine: ripgrep ? "ripgrep" : "fallback" };
  return ripgrep ? yield* rgSearch(root, opts, cap, signal) : yield* jsSearch(root, opts, cap, signal);
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

async function* jsSearch(root: string, o: SearchOpts, cap: number, signal: Signal): AsyncGenerator<SearchHit, SearchSummary> {
  const listed = await run(["git", "ls-files", "-co", "--exclude-standard", "-z"], root);
  const paths = listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : [];

  let src = o.regex ? o.query : escapeRe(o.query);
  if (o.wholeWord) src = `\\b(?:${src})\\b`;
  const re = new RegExp(src, o.matchCase ? "g" : "gi");
  const includeRe = o.include ? globToRe(o.include) : null;
  const excludeRe = o.exclude ? globToRe(o.exclude) : null;

  const files = new Set<string>();
  let matches = 0;

  for (const rel of paths) {
    if (signal.cancelled) return { files: files.size, matches, truncated: true, engine: "fallback" };
    if (includeRe && !includeRe.test(rel)) continue;
    if (excludeRe && excludeRe.test(rel)) continue;

    let bytes: Uint8Array;
    try {
      bytes = await readFile(`${root}/${rel}`);
    } catch {
      continue; // listed but gone, or unreadable
    }
    if (bytes.length > MAX_FILE || isBinary(bytes)) continue;

    const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      re.lastIndex = 0;
      const ranges: [number, number][] = [];
      for (let m = re.exec(text); m; m = re.exec(text)) {
        ranges.push([m.index, m.index + m[0].length]);
        if (m[0] === "") re.lastIndex++; // zero-width match would loop forever
      }
      if (!ranges.length) continue;
      files.add(rel);
      matches += ranges.length;
      yield { path: rel, line: i + 1, col: ranges[0][0], text, ranges };
      if (matches >= cap) return { files: files.size, matches, truncated: true, engine: "fallback" };
    }
  }
  return { files: files.size, matches, truncated: false, engine: "fallback" };
}

/** Minimal glob support for the include/exclude boxes: * and ** only. */
function globToRe(glob: string): RegExp {
  const src = glob
    .split("/")
    .map((seg) => (seg === "**" ? ".*" : escapeRe(seg).replace(/\\\*/g, "[^/]*")))
    .join("/");
  return new RegExp(`^${src}$|(^|/)${src}($|/)`);
}
