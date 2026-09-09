/** End-to-end smoke test for the agent: `bun run agent:smoke`.
 *
 *  Spawns a real agent against this repository, connects over the loopback
 *  WebSocket exactly as the browser will, and exercises one op per subsystem.
 *  Exits non-zero on the first failure so it can gate a commit.
 *
 *  There are two agents — the original TypeScript one and the Go port — and the
 *  point of this file is that neither gets its own test. The same checks run
 *  against both over the same wire, which is what makes "the port behaves
 *  identically" a measured claim rather than a hopeful one.
 *
 *    bun scripts/agent-smoke.ts [--impl ts|go|both]
 *
 *  The Go suite is skipped, loudly, when no Go toolchain is present; set GO_BIN
 *  to point at one that is not on PATH.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { iter } from "../src/agent/proc.ts";
import { findGo } from "./go-toolchain.ts";
import { VERSION } from "../src/version.ts";
import type { AgentInfo, Branch, Commit, CommitDetail, DirEntry, DiffPair, FileRead, GitStatus, SearchHit } from "../src/agent/protocol.ts";

interface Result {
  name: string;
  ok: boolean;
  note: string;
}

interface Impl {
  id: string;
  label: string;
  port: number;
  argv: string[];
}

// ── building the Go agent ─────────────────────────────────────────────────

async function buildGoAgent(go: string): Promise<string> {
  const out = join("dist", "agent-go", process.platform === "win32" ? "enc-tool-agent.exe" : "enc-tool-agent");
  await mkdir(join("dist", "agent-go"), { recursive: true });
  // The version is stamped in even here: agent.info is compared field by field
  // between the two agents, and "dev" against "3.5.0" would be a false alarm.
  const proc = Bun.spawn([go, "build", "-ldflags", `-X main.version=${VERSION}`, "-o", join("..", out), "."], {
    cwd: "agent-go",
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  if ((await proc.exited) !== 0) throw new Error("go build failed");
  return out;
}

// ── response comparison ───────────────────────────────────────────────────

/** Stable JSON: keys sorted, and mtimes floored.
 *
 *  Node reports mtime as fractional milliseconds and Go as whole ones, which is
 *  a difference in the clock rather than in the answer. Everything else is
 *  compared exactly — including field order-independent structure, so a missing
 *  `null` or an extra `"from"` shows up. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const rec = value as Record<string, unknown>;
    // git blame attributes uncommitted lines to the all-zero sha and stamps them
    // with the time of the call, so the two runs differ by a second whenever the
    // blamed file has unsaved edits. That is the clock again, not the answer.
    const uncommitted = typeof rec.sha === "string" && /^0+$/.test(rec.sha);
    for (const key of Object.keys(rec).sort()) {
      const v = rec[key];
      out[key] =
        key === "mtime" && typeof v === "number" ? Math.floor(v)
        : key === "time" && uncommitted ? 0
        : canonical(v);
    }
    return out;
  }
  return value;
}

const stable = (v: unknown): string => JSON.stringify(canonical(v));

// ── one run of the suite against one agent ────────────────────────────────

async function suite(impl: Impl): Promise<{ results: Result[]; answers: Map<string, string> }> {
  const results: Result[] = [];
  /** Every reply, keyed by the request that produced it, for the cross-agent
   *  comparison below. */
  const answers = new Map<string, string>();
  const check = (name: string, ok: boolean, note = ""): void => {
    results.push({ name, ok, note });
    console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
  };

  const proc = Bun.spawn(impl.argv, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });

  async function waitForUrl(timeoutMs = 15000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const dec = new TextDecoder();
    let buf = "";
    for await (const bytes of iter(proc.stdout as ReadableStream<Uint8Array>)) {
      buf += dec.decode(bytes, { stream: true });
      const m = /(ws:\/\/127\.0\.0\.1:\d+\/ws\?token=[0-9a-f]+)/.exec(buf);
      if (m) return m[1];
      if (Date.now() > deadline) break;
    }
    throw new Error(`agent did not print a URL:\n${buf}`);
  }

  const url = await waitForUrl();
  console.log(`\n${impl.label}: ${url.replace(/token=.*/, "token=…")}\n`);

  // ── minimal client ──────────────────────────────────────────────────────

  const ws = new WebSocket(url);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; chunks: unknown[] }>();
  let nextId = 1;

  ws.addEventListener("message", (ev) => {
    const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
    if (typeof frame.event === "string") return; // push (fs.change)
    const entry = pending.get(frame.id as number);
    if (!entry) return;
    if ("chunk" in frame) return void entry.chunks.push(frame.chunk);
    pending.delete(frame.id as number);
    if (frame.ok) entry.resolve(frame.data);
    else entry.reject(new Error(String(frame.error)));
  });

  function call<T>(op: string, params: Record<string, unknown> = {}): Promise<T> & { chunks: unknown[] } {
    const id = nextId++;
    const chunks: unknown[] = [];
    const key = `${op} ${JSON.stringify(params)}`;
    const p = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, chunks });
      ws.send(JSON.stringify({ id, op, ...params }));
    });
    // Errors are recorded too: the two agents must fail alike, not merely
    // succeed alike.
    void p.then(
      (data) => answers.set(key, stable(data)),
      (e: Error) => answers.set(key, `ERROR ${e.message}`),
    );
    return Object.assign(p, { chunks });
  }

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });

  // ── the checks ──────────────────────────────────────────────────────────

  try {
    const info = await call<AgentInfo>("agent.info");
    check("agent.info", info.agent === "enc-tool", `git=${info.gitVersion} rg=${info.ripgrep ?? "none"} watch=${info.watch}`);

    const entries = await call<DirEntry[]>("fs.readdir", { path: "src" });
    const dirsFirst = entries.every((e, i) => i === 0 || !e.dir || entries[i - 1].dir);
    check("fs.readdir", entries.some((e) => e.name === "server.ts") && dirsFirst, `${entries.length} entries, dirs first`);

    const file = await call<FileRead>("fs.read", { path: "package.json" });
    check("fs.read", (file.text ?? "").includes('"encryption-tool"'), `${file.size} bytes`);

    await call("fs.read", { path: "../../../etc/passwd" }).then(
      () => check("jail blocks ..", false, "escape was allowed"),
      (e: Error) => check("jail blocks ..", /escapes the workspace/i.test(e.message), e.message),
    );

    const status = await call<GitStatus>("git.status");
    check("git.status", status.branch !== null, `branch=${status.branch} entries=${status.entries.length}`);

    const commits = await call<Commit[]>("git.log", { limit: 5 });
    check("git.log", commits.length > 0 && /^[0-9a-f]{40}$/.test(commits[0]?.oid ?? ""), `${commits.length} commits, head="${commits[0]?.subject}"`);

    const branches = await call<Branch[]>("git.branches");
    check("git.branches", branches.some((b) => b.head), branches.map((b) => b.name).join(", "));

    // The second commit is the first one with a parent, so its diff is non-empty.
    const withParent = commits.find((c) => c.parents.length > 0);
    const detail = await call<CommitDetail>("git.commitDetail", { oid: withParent!.oid });
    check(
      "git.commitDetail",
      detail.files.length > 0 && detail.files.every((f) => f.path !== ""),
      `${detail.files.length} files, +${detail.files.reduce((n, f) => n + f.added, 0)}`,
    );

    const target = detail.files.find((f) => f.status === "M") ?? detail.files[0];
    const pair = await call<DiffPair>("git.diff", { path: target.path, kind: withParent!.oid });
    check("git.diff", pair.before !== null || pair.after !== null, `${target.path}: ${pair.beforeLabel} -> ${pair.afterLabel}`);

    const hits = call<{ files: number; matches: number; engine: string }>("search", {
      query: "TabEditor",
      matchCase: true,
      wholeWord: true,
      regex: false,
    });
    const summary = await hits;
    const streamed = hits.chunks.filter((c) => (c as { hit?: SearchHit }).hit).length;
    check("search", summary.matches > 0 && streamed === summary.matches, `${summary.matches} matches in ${summary.files} files via ${summary.engine}, ${streamed} streamed`);

    const watching = await call<{ watching: boolean }>("watch.start");
    check("watch.start", typeof watching.watching === "boolean", `watching=${watching.watching}`);

    await call("git.nope").then(
      () => check("unknown op rejected", false, "no error"),
      (e: Error) => check("unknown op rejected", /Unknown op/.test(e.message), e.message),
    );

    // ── parity probes ──
    //
    // Read-only calls with no assertion of their own. They exist so that the
    // cross-agent comparison has something to bite on beyond the checks above:
    // these are the parsers most likely to drift — porcelain v2, for-each-ref,
    // --raw/--numstat, blame porcelain — and a difference in any field of any
    // row fails the run.
    const head = commits[0]!.oid;
    const probes: [string, Record<string, unknown>][] = [
      ["fs.readdir", { path: "" }],
      ["fs.readdir", { path: "src/web/code" }],
      ["fs.stat", { path: "package.json" }],
      ["fs.read", { path: "src/version.ts" }],
      ["fs.read", { path: "src/web/icons/icon-192.png" }], // binary classification
      ["fs.read", { path: "does/not/exist.txt" }], // error parity
      ["fs.readdir", { path: "/etc" }], // jail parity, absolute
      ["fs.read", { path: "..\\..\\secrets" }], // jail parity, backslashes
      ["git.identity", {}],
      ["git.remotes", {}],
      ["git.log", { limit: 20, all: true }],
      ["git.log", { limit: 3, path: "src/server.ts" }],
      ["git.commitDetail", { oid: head }],
      ["git.blame", { path: "src/version.ts" }],
      ["git.blob", { rev: head, path: "package.json" }],
      ["git.blob", { rev: head, path: "no/such/file" }],
      ["git.diff", { path: "src/server.ts", kind: "head" }],
      ["git.diff", { path: "src/server.ts", kind: "staged" }],
      ["git.diff", { path: "src/server.ts", kind: "worktree" }],
      ["git.stash", { action: "list" }],
      ["git.commit", { message: "   " }], // refuses on both, same message
      ["git.checkout", { ref: "--upload-pack=evil" }], // safeArg parity
      ["search", { query: "export function", matchCase: false, regex: false }],
      ["search", { query: "TODO|FIXME", regex: true, matchCase: true, include: "src/**" }],
      ["search", { query: "zzz-no-such-string-zzz" }],
    ];
    for (const [op, params] of probes) await call(op, params).catch(() => {});
  } catch (e) {
    check("unexpected error", false, e instanceof Error ? e.message : String(e));
  } finally {
    ws.close();
    proc.kill();
    await proc.exited;
  }

  return { results, answers };
}

// ── driver ────────────────────────────────────────────────────────────────

function wanted(argv: string[]): string {
  const i = argv.indexOf("--impl");
  const inline = argv.find((a) => a.startsWith("--impl="));
  const value = inline ? inline.slice("--impl=".length) : i >= 0 ? argv[i + 1] : "both";
  if (!["ts", "go", "both"].includes(value ?? "")) throw new Error(`--impl must be ts, go or both`);
  return value ?? "both";
}

const want = wanted(process.argv.slice(2));
const impls: Impl[] = [];

if (want === "ts" || want === "both") {
  impls.push({
    id: "ts",
    label: "TypeScript agent (src/agent)",
    port: 5099,
    argv: ["bun", "src/agent/cli.ts", "--root", process.cwd(), "--port", "5099"],
  });
}

if (want === "go" || want === "both") {
  const go = await findGo();
  if (!go) {
    console.log("\nskipping the Go agent: no toolchain found (set GO_BIN to point at one)\n");
    if (want === "go") process.exit(0);
  } else {
    const binary = await buildGoAgent(go);
    if (!existsSync(binary)) throw new Error(`go build produced nothing at ${binary}`);
    impls.push({
      id: "go",
      label: "Go agent (agent-go)",
      port: 5098,
      argv: [binary, "--root", process.cwd(), "--port", "5098"],
    });
  }
}

const runs: { impl: Impl; results: Result[]; answers: Map<string, string> }[] = [];
for (const impl of impls) {
  console.log(`\n── ${impl.label} ${"─".repeat(Math.max(0, 50 - impl.label.length))}`);
  const { results, answers } = await suite(impl);
  runs.push({ impl, results, answers });
}

// The two implementations must not merely both pass — they must return the same
// bytes, or "identical behaviour" is a claim about two different test runs that
// happened to agree on a dozen booleans.
let mismatched = 0;
if (runs.length === 2) {
  const [a, b] = runs;

  for (const name of new Set([...a.results.map((r) => r.name), ...b.results.map((r) => r.name)])) {
    const ra = a.results.find((r) => r.name === name);
    const rb = b.results.find((r) => r.name === name);
    if (!ra || !rb || ra.ok !== rb.ok) {
      mismatched++;
      console.log(`  DIFFER  ${name}: ${a.impl.id}=${ra?.ok ?? "absent"} ${b.impl.id}=${rb?.ok ?? "absent"}`);
    }
  }

  console.log("");
  let compared = 0;
  for (const key of new Set([...a.answers.keys(), ...b.answers.keys()])) {
    const va = a.answers.get(key);
    const vb = b.answers.get(key);
    compared++;
    if (va === vb) continue;
    mismatched++;
    console.log(`  DIFFER  ${key}`);
    console.log(`     ${a.impl.id}: ${firstDifference(va, vb)}`);
    console.log(`     ${b.impl.id}: ${firstDifference(vb, va)}`);
  }
  console.log(`compared ${compared} replies field for field`);
}

/** Show the neighbourhood of the first differing character rather than two
 *  40 KB blobs the reader has to diff by eye. */
function firstDifference(mine: string | undefined, theirs: string | undefined): string {
  if (mine === undefined) return "(no reply)";
  if (theirs === undefined) return `${mine.slice(0, 160)}…`;
  let i = 0;
  while (i < mine.length && i < theirs.length && mine[i] === theirs[i]) i++;
  const from = Math.max(0, i - 40);
  return `${from > 0 ? "…" : ""}${mine.slice(from, i + 80)}${i + 80 < mine.length ? "…" : ""}`;
}

console.log("");
let failed = 0;
for (const { impl, results } of runs) {
  const bad = results.filter((r) => !r.ok).length;
  failed += bad;
  console.log(`${impl.id.padEnd(3)} ${results.length - bad}/${results.length} passed`);
}
if (runs.length === 2) {
  console.log(mismatched ? `\n${mismatched} check(s) differ between implementations` : `\nboth implementations agree on all checks`);
}

process.exit(failed || mismatched ? 1 : 0);
