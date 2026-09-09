/** End-to-end smoke test for the agent: `bun run agent:smoke`.
 *
 *  Spawns a real agent against this repository, connects over the loopback
 *  WebSocket exactly as the browser will, and exercises one op per subsystem.
 *  Exits non-zero on the first failure so it can gate a commit.
 */
import { iter } from "../src/agent/proc.ts";
import type { AgentInfo, Branch, Commit, CommitDetail, DirEntry, DiffPair, FileRead, GitStatus, SearchHit } from "../src/agent/protocol.ts";

const PORT = 5099;
const results: { name: string; ok: boolean; note: string }[] = [];

function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

// ── boot an agent and read its URL off stdout ─────────────────────────────

const proc = Bun.spawn(["bun", "src/agent/cli.ts", "--root", process.cwd(), "--port", String(PORT)], {
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
console.log(`\nagent up: ${url.replace(/token=.*/, "token=…")}\n`);

// ── minimal client ────────────────────────────────────────────────────────

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
  const p = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, chunks });
    ws.send(JSON.stringify({ id, op, ...params }));
  });
  return Object.assign(p, { chunks });
}

await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve());
  ws.addEventListener("error", () => reject(new Error("websocket failed to open")));
});

// ── the checks ────────────────────────────────────────────────────────────

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
} catch (e) {
  check("unexpected error", false, e instanceof Error ? e.message : String(e));
} finally {
  ws.close();
  proc.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
