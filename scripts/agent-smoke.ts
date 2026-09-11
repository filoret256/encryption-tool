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
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  /** How to start this agent; the root and port are appended per run, because
   *  the hardening checks need a second one on a throwaway workspace. */
  exe: string[];
}

const argvFor = (impl: Impl, root: string, port: number, extra: string[] = []): string[] => [
  ...impl.exe,
  "--root",
  root,
  "--port",
  String(port),
  ...extra,
  // This harness is not a browser and sends no Origin, which the agent now
  // refuses by default. Saying so explicitly is the point: the flag is the
  // only way in for a non-browser client, and these tests are one.
  "--allow-no-origin",
];

// ── building the Go agent ─────────────────────────────────────────────────

async function buildGoAgent(go: string): Promise<string> {
  const out = join("dist", "agent-go", process.platform === "win32" ? "enc-tool-agent.exe" : "enc-tool-agent");
  await mkdir(join("dist", "agent-go"), { recursive: true });
  // The version is stamped in even here: agent.info is compared field by field
  // between the two agents, and "dev" against "4.0.0" would be a false alarm.
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
        // Also the clock. The two agents run one after the other against one
        // shared workspace, and the suite writes to it — so a file listed by
        // the first run and rewritten before the second is listed carries two
        // different timestamps for one identical behaviour. Zeroed rather than
        // dropped, so "reports an mtime" and "omits one" still differ.
        key === "mtime" && typeof v === "number" ? 0
        : key === "time" && uncommitted ? 0
        : canonical(v);
    }
    return out;
  }
  return value;
}

const stable = (v: unknown): string => JSON.stringify(canonical(v));

// ── the wire client ───────────────────────────────────────────────────────

type Call = <T>(op: string, params?: Record<string, unknown>, track?: boolean) => Promise<T> & { chunks: unknown[] };

interface Client {
  call: Call;
  /** Every `fs.change` push received so far, oldest first. The watcher suite
   *  asserts on what the agent volunteered, not only on what it was asked. */
  pushes: string[][];
  close: () => Promise<void>;
}

/** Start an agent, wait for its banner, and open the socket the browser would.
 *
 *  `tag` namespaces the recorded replies: a run drives two agents — one on this
 *  repository, one on a throwaway workspace — and the same op with the same
 *  params means different things in each.
 *
 *  `env` is added to the agent's environment, and through it to every git the
 *  agent runs. The mutation suite uses it to pin commit dates: a revert makes a
 *  commit of its own, and a commit stamped with the wall clock has a different
 *  oid in each of the two runs — which the comparison would report as the
 *  implementations disagreeing about a hash they both merely inherited from the
 *  second hand. */
async function connect(
  argv: string[],
  label: string,
  answers: Map<string, string>,
  tag: string,
  env: Record<string, string> = {},
): Promise<Client> {
  const proc = Bun.spawn(argv, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
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
  console.log(`\n${label}: ${url.replace(/token=.*/, "token=…")}\n`);

  const ws = new WebSocket(url);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; chunks: unknown[] }>();
  const pushes: string[][] = [];
  let nextId = 1;

  ws.addEventListener("message", (ev) => {
    const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
    if (typeof frame.event === "string") {
      if (frame.event === "fs.change") {
        const paths = (frame.data as { paths?: unknown })?.paths;
        if (Array.isArray(paths)) pushes.push(paths.map(String));
      }
      return;
    }
    const entry = pending.get(frame.id as number);
    if (!entry) return;
    if ("chunk" in frame) return void entry.chunks.push(frame.chunk);
    pending.delete(frame.id as number);
    if (frame.ok) entry.resolve(frame.data);
    else entry.reject(new Error(String(frame.error)));
  });

  /** `track: false` keeps a reply out of the cross-agent comparison. Needed
   *  only where the reply cannot be equal by construction — a successful write
   *  reports the mtime it happened at, and the two agents run minutes apart. */
  const call: Call = <T,>(op: string, params: Record<string, unknown> = {}, track = true) => {
    const id = nextId++;
    const chunks: unknown[] = [];
    const key = `${tag}${op} ${JSON.stringify(params)}`;
    const p = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, chunks });
      ws.send(JSON.stringify({ id, op, ...params }));
    });
    // Errors are recorded too: the two agents must fail alike, not merely
    // succeed alike.
    if (track) {
      void p.then(
        (data) => answers.set(key, stable(data)),
        (e: Error) => answers.set(key, `ERROR ${e.message}`),
      );
    } else {
      void p.catch(() => {});
    }
    return Object.assign(p, { chunks });
  };

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });

  return {
    call,
    pushes,
    async close(): Promise<void> {
      ws.close();
      proc.kill();
      await proc.exited;
    },
  };
}

// ── the throwaway workspace for the hardening checks ──────────────────────
//
// The suite above runs against this repository and is read-only on purpose.
// The hardening checks have to attempt writes — through a symlink, into .git,
// into a path a git option was asked to open — so they need a workspace it does
// not matter about, with something worth stealing placed just outside it.

const OUTSIDE = "the file outside the workspace\n";

interface Sandbox {
  /** The workspace the agent is pointed at. */
  root: string;
  /** Its parent: holds the file the escapes aim for, and the canary paths. */
  base: string;
  /** Whether file symlinks could be created. Windows refuses them without
   *  Developer Mode or elevation, and a check that cannot be set up is reported
   *  as skipped rather than quietly passed. */
  fileLinks: boolean;
  /** Whether a directory link out could be created. On Windows this falls back
   *  to a junction, which needs no privilege and which both Node and Go resolve
   *  like a symlink — so the ancestor half of the check runs there too. */
  dirLinks: boolean;
}

async function makeSandbox(): Promise<Sandbox> {
  const base = await mkdtemp(join(tmpdir(), "enc-agent-smoke-"));
  const root = join(base, "workspace");
  await mkdir(root, { recursive: true });

  const git = async (...args: string[]): Promise<void> => {
    const p = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    await p.exited;
  };
  await git("init", "-q");
  await git("config", "user.email", "smoke@example.invalid");
  await git("config", "user.name", "Smoke");
  await writeFile(join(root, "app.ts"), "export const v = 1;\n");
  await writeFile(join(root, "real.txt"), "a real file\n");
  // A neighbour of .git that is ordinary content. Created here rather than by
  // the suite, because the sandbox is shared between the two runs: a directory
  // the first run brings into being is a directory the second run's `readdir`
  // sees and the first run's did not, and the byte-for-byte comparison would
  // report that as the implementations disagreeing.
  await mkdir(join(root, ".github"), { recursive: true });
  await git("add", ".");
  await git("commit", "-qm", "init");
  // A configured remote, so "only a configured name" has something to accept.
  await git("remote", "add", "origin", "https://example.invalid/repo.git");

  // Two things to steal, in two shapes: a file for the file link to point at,
  // and a directory for the directory link. The directory link deliberately
  // does not point at `base` — the workspace lives there, so that would make a
  // cycle for anything that ever walks the sandbox.
  await writeFile(join(base, "outside.txt"), OUTSIDE);
  await mkdir(join(base, "outside-dir"), { recursive: true });
  await writeFile(join(base, "outside-dir", "outside.txt"), OUTSIDE);

  // A link out to a file that exists, one out to a file that does not (the
  // dangling case: following it would create the far end), and one that stays
  // inside — which must keep working, because reading through one already does.
  let fileLinks = true;
  try {
    await symlink(join(base, "outside.txt"), join(root, "escape.txt"), "file");
    await symlink(join(base, "nowhere.txt"), join(root, "dangling.txt"), "file");
    await symlink(join(root, "real.txt"), join(root, "inside.txt"), "file");
  } catch {
    fileLinks = false;
  }

  // A directory link out. Junctions are the fallback rather than the exception:
  // they are what an unprivileged Windows process can make, and skipping the
  // check there would leave the escape untested on the platform most likely to
  // be running this.
  let dirLinks = true;
  try {
    await symlink(join(base, "outside-dir"), join(root, "escape-dir"), "dir");
  } catch {
    dirLinks = false;
    if (process.platform === "win32") {
      const p = Bun.spawn(["cmd", "/c", "mklink", "/J", join(root, "escape-dir"), join(base, "outside-dir")], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      dirLinks = (await p.exited) === 0;
    }
  }

  return { root, base, fileLinks, dirLinks };
}

// ── one run of the suite against one agent ────────────────────────────────

async function suite(impl: Impl, sandbox: Sandbox): Promise<{ results: Result[]; answers: Map<string, string> }> {
  const results: Result[] = [];
  /** Every reply, keyed by the request that produced it, for the cross-agent
   *  comparison below. */
  const answers = new Map<string, string>();
  const check = (name: string, ok: boolean, note = ""): void => {
    results.push({ name, ok, note });
    console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
  };

  const client = await connect(argvFor(impl, process.cwd(), impl.port), impl.label, answers, "");
  const { call } = client;

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
    await client.close();
  }

  await hardening(impl, sandbox, answers, check);
  await mutations(impl, answers, check);
  await newOps(impl, answers, check);
  await watcherQuiet(impl, answers, check);
  return { results, answers };
}

// ── mutations: the ops that change the repository ─────────────────────────
//
// Twelve ops were reached by neither suite above, because neither could run
// them: the read-only suite works on this repository, and the hardening suite
// shares one workspace between the two agents, so anything that writes history
// would leave the second agent looking at a repository the first had already
// changed. They are exactly the ops that stage, unstage, discard, branch,
// merge, revert and cherry-pick — the ones that do something irreversible to a
// user's work, and the ones whose replies nothing was comparing.
//
// That is the same silence the junction escape lived in: a hole in the Go jail
// survived because the only test that would have caught it was never run.
//
// Each agent gets its own workspace, built to the same recipe with fixed dates
// and a fixed identity, so the commit oids come out identical and the two runs
// remain comparable field for field.

/** Fixed so two separately built repositories hash to the same commits. */
const FIXED_DATE = "2020-01-01T00:00:00Z";

async function makeRepo(tag: string, parent = tmpdir()): Promise<string> {
  const root = await mkdtemp(join(parent, `enc-agent-mut-${tag}-`));
  const git = async (...args: string[]): Promise<void> => {
    const p = Bun.spawn(["git", ...args], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
    });
    await p.exited;
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "smoke@example.invalid");
  await git("config", "user.name", "Smoke");
  // Off, so a checkout hands back the bytes that were committed. With Windows'
  // default the file comes back with CRLF, which makes a byte-for-byte
  // assertion about discarded content platform-dependent — and would put the
  // two platforms' commit oids out of step with each other as well.
  await git("config", "core.autocrlf", "false");
  await writeFile(join(root, "a.txt"), "one\n");
  await writeFile(join(root, "b.txt"), "two\n");
  await git("add", "-A");
  await git("commit", "-qm", "first");
  // A second commit, so revert and cherry-pick have something with a parent.
  await writeFile(join(root, "a.txt"), "one changed\n");
  await git("add", "-A");
  await git("commit", "-qm", "second");
  return root;
}

async function mutations(
  impl: Impl,
  answers: Map<string, string>,
  check: (name: string, ok: boolean, note?: string) => void,
): Promise<void> {
  const root = await makeRepo(impl.id);
  const client = await connect(
    argvFor(impl, root, impl.port + 20),
    `${impl.label} — mutations`,
    answers,
    "mut ",
    { GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  );
  const { call } = client;

  try {
    // Staging, in both directions, and the status that must reflect it. The
    // reply to git.status is what carries the parity: a porcelain-v2 field read
    // differently by one implementation shows up here and nowhere else.
    await writeFile(join(root, "a.txt"), "one edited\n");
    await writeFile(join(root, "new.txt"), "fresh\n");
    await call("git.stage", { paths: ["a.txt", "new.txt"] });
    const staged = await call<GitStatus>("git.status");
    check(
      "git.stage",
      staged.entries.filter((e) => e.index !== ".").length === 2,
      staged.entries.map((e) => `${e.path}:${e.index}${e.work}`).join(" "),
    );

    await call("git.unstage", { paths: ["new.txt"] });
    const unstaged = await call<GitStatus>("git.status");
    check("git.unstage", unstaged.entries.some((e) => e.path === "new.txt" && e.untracked), "new.txt back to untracked");

    // Discard throws work away, which is why it is worth knowing the two agents
    // agree on exactly which work. On a path that is modified but *not* staged:
    // discard restores from the index, so discarding something staged a moment
    // ago restores the staged copy and proves nothing.
    await writeFile(join(root, "b.txt"), "two edited\n");
    await call("git.discard", { paths: ["b.txt"] });
    const afterDiscard = await readFile(join(root, "b.txt"), "utf8");
    check("git.discard", afterDiscard === "two\n", JSON.stringify(afterDiscard));

    // Branches: create, rename, delete — and the listing after each, which is
    // the for-each-ref parser both implementations have their own copy of.
    //
    // branchCreate is `switch -c`, so it moves HEAD onto the new branch; git
    // refuses to delete the branch the worktree is on, which is why each of
    // these steps checks out main again before the next.
    await call("git.branchCreate", { name: "topic", from: "HEAD" });
    const withTopic = await call<Branch[]>("git.branches");
    check(
      "git.branchCreate",
      withTopic.some((b) => b.name === "topic" && b.head),
      withTopic.map((b) => (b.head ? `*${b.name}` : b.name)).join(", "),
    );

    await call("git.checkout", { ref: "main" });
    await call("git.branchRename", { from: "topic", to: "topic-2" });
    const renamed = await call<Branch[]>("git.branches");
    check(
      "git.branchRename",
      renamed.some((b) => b.name === "topic-2") && !renamed.some((b) => b.name === "topic"),
      renamed.map((b) => b.name).join(", "),
    );

    await call("git.branchDelete", { name: "topic-2" });
    const deleted = await call<Branch[]>("git.branches");
    check("git.branchDelete", !deleted.some((b) => b.name.startsWith("topic")), deleted.map((b) => b.name).join(", "));

    // Merge of a branch that points at the same commit: a fast-forward that
    // changes nothing, so the repository is left where the later checks expect
    // it, and the reply is still the one the panel would show.
    await call("git.branchCreate", { name: "ff", from: "HEAD" });
    await call("git.checkout", { ref: "main" });
    const merged = await call("git.merge", { ref: "ff" });
    check("git.merge", merged !== undefined, "already up to date");
    await call("git.branchDelete", { name: "ff" });

    // Revert and cherry-pick need a clean tree — git refuses both otherwise —
    // so the staging left over from the checks above is put back first.
    await call("git.unstage", { paths: ["a.txt"] });
    await call("git.discard", { paths: ["a.txt"] });
    await call("fs.delete", { paths: ["new.txt"] });
    const clean = await call<GitStatus>("git.status");
    check("tree clean before revert", clean.entries.length === 0, `${clean.entries.length} entries`);

    // Revert first, then cherry-pick the same commit back, which leaves the tree
    // as it was — and makes both ops observable through the log rather than the
    // tree.
    const log = await call<Commit[]>("git.log", { limit: 5 });
    const second = log.find((c) => c.subject === "second")!;
    await call("git.revert", { oid: second.oid });
    const afterRevert = await call<Commit[]>("git.log", { limit: 5 });
    check("git.revert", afterRevert.length === log.length + 1, `${afterRevert.length} commits, head="${afterRevert[0]?.subject}"`);

    await call("git.cherryPick", { oid: second.oid });
    const afterPick = await call<Commit[]>("git.log", { limit: 6 });
    check("git.cherryPick", afterPick.length === afterRevert.length + 1, `head="${afterPick[0]?.subject}"`);

    // mergeAbort with no merge in progress, and resolve on a path with no
    // conflict: neither is a normal call, and an agent that answers one of them
    // differently is an agent that says something different in the panel.
    await call("git.mergeAbort", {}).catch(() => {});
    await call("git.resolve", { paths: ["b.txt"] }).catch(() => {});
    check("git.mergeAbort / git.resolve answered", true, "recorded for comparison");

    // The other half of the watcher. Started by the read-only suite; stopping it
    // was never called anywhere.
    await call("watch.start");
    const stopped = await call("watch.stop");
    check("watch.stop", stopped !== undefined, JSON.stringify(stopped));
  } catch (e) {
    check("unexpected error (mutations)", false, e instanceof Error ? e.message : String(e));
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

// ── the ops added for the agent package ───────────────────────────────────
//
// Eight ops that arrived in one pass, each behind a piece of UI that could not
// be built without it. They share a suite for the same reason they shared a
// pass: every one of them is a new argv in two implementations, and the only
// question worth asking about each is whether the two answer alike.

async function newOps(
  impl: Impl,
  answers: Map<string, string>,
  check: (name: string, ok: boolean, note?: string) => void,
): Promise<void> {
  // Two repositories under one parent, and the agent told the parent is fair
  // game: that is the shape agent.setRoot exists for — one agent, a second
  // project, no restart.
  const parent = await mkdtemp(join(tmpdir(), `enc-agent-ops-${impl.id}-`));
  const root = await makeRepo(`ops-${impl.id}`, parent);
  const other = await makeRepo(`other-${impl.id}`, parent);
  const client = await connect(
    argvFor(impl, root, impl.port + 40, ["--allow-root", parent]),
    `${impl.label} — new ops`,
    answers,
    "ops ",
    { GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  );
  const { call } = client;

  /** The op must be refused, with a message matching `re`.
   *
   *  `track` is off where the params carry this run's temp directory: the
   *  cross-agent comparison keys replies by op and params, and the two runs get
   *  their own workspaces — so a path that differs by construction would be
   *  reported as the implementations disagreeing. The check itself still runs
   *  against both. */
  const denied = async (
    name: string,
    op: string,
    params: Record<string, unknown>,
    re: RegExp,
    track = true,
  ): Promise<void> => {
    try {
      const data = await call(op, params, track);
      check(name, false, `ALLOWED — returned ${JSON.stringify(data).slice(0, 60)}`);
    } catch (e) {
      const msg = (e as Error).message;
      check(name, re.test(msg), msg.slice(0, 80));
    }
  };

  try {
    // ── UXB-77: git.log skip ──
    // Two commits exist. Page size one: the second page must be the second
    // commit, and asking past the end must be empty rather than an error.
    const page1 = await call<Commit[]>("git.log", { limit: 1 });
    const page2 = await call<Commit[]>("git.log", { limit: 1, skip: 1 });
    const all = await call<Commit[]>("git.log", { limit: 10 });
    check(
      "git.log skip pages the history",
      page1.length === 1 && page2.length === 1 && page1[0].oid === all[0].oid && page2[0].oid === all[1].oid,
      `${page1[0]?.subject} then ${page2[0]?.subject}`,
    );
    const past = await call<Commit[]>("git.log", { limit: 5, skip: 99 });
    check("git.log skip past the end is empty", past.length === 0, `${past.length} commits`);

    // ── UXB-74: git.checkIgnore ──
    await writeFile(join(root, ".gitignore"), "ignored.txt\nbuild/\n");
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, "ignored.txt"), "x\n");
    await writeFile(join(root, "build", "out.js"), "x\n");
    await writeFile(join(root, "kept.txt"), "x\n");
    const ignored = await call<string[]>("git.checkIgnore", {
      paths: ["ignored.txt", "kept.txt", "build/out.js", "a.txt"],
    });
    check(
      "git.checkIgnore names only the ignored",
      ignored.length === 2 && ignored.includes("ignored.txt") && ignored.includes("build/out.js"),
      JSON.stringify(ignored),
    );
    const noneIgnored = await call<string[]>("git.checkIgnore", { paths: ["a.txt", "b.txt"] });
    // Exit 1 means "none of them", which must read as an empty list and not as
    // a failed command — the difference between a dimmed tree and a red toast.
    check("git.checkIgnore with no matches is empty, not an error", noneIgnored.length === 0, JSON.stringify(noneIgnored));

    // ── UXB-79: tags ──
    await call("git.tagCreate", { name: "v1.0.0", ref: "HEAD" });
    await call("git.tagCreate", { name: "v1.1.0", ref: "HEAD", message: "first annotated" });
    const tagged = await call<Branch[]>("git.branches");
    const tags = tagged.filter((b) => b.tag).map((b) => b.name).sort();
    check("git.tagCreate, lightweight and annotated", tags.join(",") === "v1.0.0,v1.1.0", tags.join(", "));
    await call("git.tagDelete", { name: "v1.0.0" });
    const afterDelete = await call<Branch[]>("git.branches");
    check(
      "git.tagDelete",
      !afterDelete.some((b) => b.tag && b.name === "v1.0.0"),
      afterDelete.filter((b) => b.tag).map((b) => b.name).join(", ") || "none",
    );
    await denied("git.tagCreate refuses an option-shaped name", "git.tagCreate", { name: "--output=x" }, /Invalid tag/);

    // ── UXB-80: reflog ──
    // Every ref movement so far is in it, newest first, and HEAD@{0} is the
    // most recent — which is what "undo the last operation" resets onto.
    const reflog = await call<{ selector: string; oid: string; action: string; message: string; time: number }[]>(
      "git.reflog",
      { limit: 10 },
    );
    check(
      "git.reflog lists ref movements newest first",
      reflog.length >= 2 && reflog[0].selector === "HEAD@{0}" && reflog[0].oid.length === 40,
      reflog.slice(0, 2).map((r) => `${r.selector} ${r.action}: ${r.message}`).join(" | "),
    );
    check(
      "git.reflog splits the action from the message",
      reflog.every((r) => !r.message.startsWith(": ")) && reflog.some((r) => r.action === "commit"),
      reflog.map((r) => r.action).join(","),
    );

    // ── UXB-72: remote administration ──
    await call("git.remoteAdmin", { action: "add", name: "origin", url: "https://example.invalid/x.git" });
    const added = await call<{ name: string; url: string }[]>("git.remotes");
    check("git.remoteAdmin add", added.length === 1 && added[0].name === "origin", JSON.stringify(added));
    await call("git.remoteAdmin", { action: "rename", name: "origin", to: "upstream" });
    const renamed = await call<{ name: string; url: string }[]>("git.remotes");
    check("git.remoteAdmin rename", renamed.length === 1 && renamed[0].name === "upstream", JSON.stringify(renamed));

    // The URL is the one value here git will later execute against, so the
    // refusals matter more than the happy path.
    await denied(
      "git.remoteAdmin refuses an ext:: transport",
      "git.remoteAdmin",
      { action: "add", name: "evil", url: "ext::sh -c whoami" },
      /Unsupported remote URL/,
    );
    await denied(
      "git.remoteAdmin refuses a local path",
      "git.remoteAdmin",
      { action: "add", name: "local", url: "../../elsewhere" },
      /Unsupported remote URL/,
    );
    await denied(
      "git.remoteAdmin refuses an option-shaped name",
      "git.remoteAdmin",
      { action: "add", name: "-x", url: "https://example.invalid/x.git" },
      /Invalid remote/,
    );
    await denied(
      "git.remoteAdmin action is not a git subcommand",
      "git.remoteAdmin",
      { action: "set-url", name: "upstream", url: "https://example.invalid/y.git" },
      /Invalid remote admin action/,
    );
    await call("git.remoteAdmin", { action: "remove", name: "upstream" });
    const removed = await call<{ name: string; url: string }[]>("git.remotes");
    check("git.remoteAdmin remove", removed.length === 0, JSON.stringify(removed));

    // ── UXB-76: applyPatch ──
    // A one-hunk patch against a two-line file: the index must take it and the
    // worktree must not move, which is the whole point of --cached.
    await writeFile(join(root, "hunk.txt"), "alpha\nbeta\ngamma\n");
    await call("git.stage", { paths: ["hunk.txt"] });
    await call("git.commit", { message: "add hunk.txt" }, false);
    await writeFile(join(root, "hunk.txt"), "alpha\nBETA\ngamma\n");
    const patch = [
      "diff --git a/hunk.txt b/hunk.txt",
      "--- a/hunk.txt",
      "+++ b/hunk.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    await call("git.applyPatch", { patch });
    const stagedHunk = await call<GitStatus>("git.status");
    check(
      "git.applyPatch stages a hunk",
      stagedHunk.entries.some((e) => e.path === "hunk.txt" && e.index === "M"),
      stagedHunk.entries.map((e) => `${e.path}:${e.index}${e.work}`).join(" "),
    );
    check("git.applyPatch left the worktree alone", (await readFile(join(root, "hunk.txt"), "utf8")) === "alpha\nBETA\ngamma\n");

    await call("git.applyPatch", { patch, reverse: true });
    const unstagedHunk = await call<GitStatus>("git.status");
    check(
      "git.applyPatch reverse unstages it again",
      !unstagedHunk.entries.some((e) => e.path === "hunk.txt" && e.index === "M"),
      unstagedHunk.entries.map((e) => `${e.path}:${e.index}${e.work}`).join(" ") || "clean index",
    );
    await denied("git.applyPatch refuses an empty patch", "git.applyPatch", { patch: "   " }, /Patch is empty/);
    await denied("git.applyPatch refuses a patch that does not apply", "git.applyPatch",
      { patch: patch.replace("alpha", "nothing-like-this") }, /./);

    // ── UXB-82: windowed fs.read ──
    // The file is deliberately longer than one window and carries multi-byte
    // characters, because a window that lands mid-character is the failure
    // this has to not have.
    const line = "абвгд-0123456789\n"; // 27 bytes: 10 two-byte runes + 7 ascii
    const big = line.repeat(200);
    await writeFile(join(root, "big.txt"), big);
    const bigBytes = Buffer.byteLength(big, "utf8");

    const head = await call<FileRead>("fs.read", { path: "big.txt", length: 100 });
    check(
      "fs.read window: offset 0",
      head.text !== null && head.offset === 0 && !head.eof && head.size === bigBytes && big.startsWith(head.text),
      `${head.text?.length} chars of ${head.size} bytes`,
    );
    // 25 is inside the first line's trailing ascii run; 5 is mid-way through a
    // two-byte rune, which is the case alignUtf8 exists for.
    const mid = await call<FileRead>("fs.read", { path: "big.txt", offset: 5, length: 60 });
    check(
      "fs.read window: an offset mid-character is snapped forward",
      mid.text !== null && mid.offset === 6 && !mid.text.includes("�"),
      `offset asked 5, got ${mid.offset}`,
    );
    check(
      "fs.read window: the text is exactly the bytes it claims",
      mid.text === Buffer.from(big, "utf8").subarray(mid.offset, mid.offset + Buffer.byteLength(mid.text ?? "", "utf8")).toString("utf8"),
    );
    const tail = await call<FileRead>("fs.read", { path: "big.txt", offset: bigBytes - 20, length: 4096 });
    check("fs.read window: the last one reports eof", tail.eof === true && tail.text !== null, `eof=${tail.eof}`);
    const whole = await call<FileRead>("fs.read", { path: "big.txt" });
    check("fs.read without a window is unchanged", whole.text === big && whole.offset === 0 && whole.eof === true);
    await denied("fs.read refuses a window past the read cap", "fs.read",
      { path: "big.txt", length: 4 * 1024 * 1024 + 1 }, /^Length is too large: \d+ bytes .limit 4194304.$/);

    // ── UXB-73: agent.setRoot ──
    // The second repository, and back again.
    const moved = await call<AgentInfo>("agent.setRoot", { path: other }, false);
    check("agent.setRoot moves the workspace to another repository", moved.root === other && moved.repo === ".", moved.root.slice(-24));
    const listedThere = await call<DirEntry[]>("fs.readdir", { path: "" }, false);
    check(
      "the new root is what fs.readdir lists",
      listedThere.map((e) => e.name).join(",") === "a.txt,b.txt",
      listedThere.map((e) => e.name).join(", "),
    );
    const logThere = await call<Commit[]>("git.log", { limit: 10 }, false);
    check("git follows the workspace", logThere.length === 2 && logThere[0].subject === "second", `${logThere.length} commits`);

    // The parent holds both repositories and is a repository itself of nothing.
    // Saying so is the point: a stale `repo: "."` would have the UI showing a
    // branch for a folder that has none.
    const atParent = await call<AgentInfo>("agent.setRoot", { path: parent }, false);
    check("a folder that is not a repository reports so", atParent.repo === null && atParent.root === parent, JSON.stringify(atParent.repo));
    try {
      await call("git.status", {}, false);
      check("git ops are refused outside a repository", false, "git.status answered");
    } catch (e) {
      check("git ops are refused outside a repository", /Not a git repository/.test((e as Error).message), (e as Error).message);
    }

    const back = await call<AgentInfo>("agent.setRoot", { path: root }, false);
    check("agent.setRoot comes back, and git with it", back.root === root && back.repo === ".", `${back.repo}`);

    // A subfolder of a repository snaps back up to the repository root, the
    // same way the startup root does — one coordinate system for filesystem and
    // git paths is the whole reason that snapping exists.
    await call("fs.createDir", { path: "sub/inner" }, false);
    const snapped = await call<AgentInfo>("agent.setRoot", { path: join(root, "sub") }, false);
    check("a subfolder of a repository snaps to the repository root", snapped.root === root, snapped.root.slice(-24));

    await denied(
      "agent.setRoot refuses a folder outside the allowed roots",
      "agent.setRoot",
      { path: tmpdir() },
      /outside what this agent may open/,
    );
    await denied("agent.setRoot refuses a folder that is not there", "agent.setRoot",
      { path: join(root, "no-such-folder") }, /Cannot open folder/, false);
    const still = await call<AgentInfo>("agent.info", {}, false);
    check("a refused setRoot left the workspace where it was", still.root === root, still.root.slice(-24));
  } catch (e) {
    check("unexpected error (new ops)", false, e instanceof Error ? e.message : String(e));
  } finally {
    await client.close();
    await rm(parent, { recursive: true, force: true });
  }
}

// ── the watcher must not hear the agent's own reads ───────────────────────
//
// `git status` refreshes the index and writes the updated stat cache back to
// `.git/index`. The watcher reports that as a change under `.git`, the UI
// refreshes status, branches and history, and those run `git status` again: the
// three panels rebuilt once a second forever with nobody touching anything.
// `--no-optional-locks` is what breaks the circle — see readOnly() in
// src/agent/git.ts and agent-go/git.go.
//
// Measured, not asserted: the reads the UI issues on a refresh are issued here,
// and the pushes the agent volunteers afterwards are counted. A positive
// control follows, because a watcher that reports nothing at all would
// otherwise pass this happily.

async function watcherQuiet(
  impl: Impl,
  answers: Map<string, string>,
  check: (name: string, ok: boolean, note?: string) => void,
): Promise<void> {
  const root = await makeRepo(`watch-${impl.id}`);
  const client = await connect(argvFor(impl, root, impl.port + 30), `${impl.label} — watcher`, answers, "watch ");
  const { call, pushes } = client;

  /** The watcher debounces by 120ms and the filesystem is not instant; a
   *  quarter second is comfortably past both without making the suite slow. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

  try {
    const started = await call<{ watching: boolean }>("watch.start");
    check("watch.start", started.watching === true, JSON.stringify(started));

    // Anything left over from opening the workspace is not what is being
    // measured here.
    await settle();
    pushes.length = 0;

    // One refresh cycle as the UI performs it, three times over. Before the
    // fix each of these rounds produced a `.git` push, which is precisely what
    // made the next round happen.
    for (let i = 0; i < 3; i++) {
      await call("git.status");
      await call("git.log", { limit: 50 });
      await call("git.branches");
      await settle();
    }

    const gitPushes = pushes.filter((p) => p.includes(".git") || p.includes("*"));
    check(
      "reads do not wake the watcher",
      gitPushes.length === 0,
      gitPushes.length ? `${gitPushes.length} push(es): ${JSON.stringify(gitPushes.slice(0, 3))}` : "no .git pushes",
    );

    // The control: a real edit still has to arrive, or the check above is
    // measuring a dead watcher.
    pushes.length = 0;
    await writeFile(join(root, "watched.txt"), "touched\n");
    for (let i = 0; i < 20 && !pushes.length; i++) await settle();
    check(
      "a real change still arrives",
      pushes.some((p) => p.includes("watched.txt") || p.includes("*")),
      JSON.stringify(pushes.slice(0, 3)),
    );

    // A write through the agent is a change like any other: the tree has to
    // hear about it, so this must not be suppressed along with the reads.
    pushes.length = 0;
    await call("fs.write", { path: "viaAgent.txt", text: "written\n" }, false);
    for (let i = 0; i < 20 && !pushes.length; i++) await settle();
    check(
      "an agent write still arrives",
      pushes.some((p) => p.includes("viaAgent.txt") || p.includes("*")),
      JSON.stringify(pushes.slice(0, 3)),
    );

    // And a commit — a real `.git` change — must still reach the panels, or
    // the fix would have traded one bug for a worse one.
    pushes.length = 0;
    await call("git.stage", { paths: ["watched.txt", "viaAgent.txt"] });
    await call("git.commit", { message: "from the watcher suite" }, false);
    for (let i = 0; i < 20 && !pushes.some((p) => p.includes(".git") || p.includes("*")); i++) await settle();
    check(
      "a commit still wakes the watcher",
      pushes.some((p) => p.includes(".git") || p.includes("*")),
      JSON.stringify(pushes.slice(0, 3)),
    );
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

// ── hardening: the ways out of the workspace, and the ways back in ────────
//
// One case per closed hole, driven over the same wire against both agents, so
// "fixed" is measured rather than asserted — and so a fix that lands in one
// implementation and not the other fails the run.
//
// Every refusal message is recorded for the cross-agent comparison too: the two
// agents must refuse alike, down to the wording, or the UI shows a different
// toast depending on which agent the user happens to be running.

async function hardening(
  impl: Impl,
  sandbox: Sandbox,
  answers: Map<string, string>,
  check: (name: string, ok: boolean, note?: string) => void,
): Promise<void> {
  const client = await connect(
    argvFor(impl, sandbox.root, impl.port + 10),
    `${impl.label} — hardening`,
    answers,
    "sandbox ",
  );
  const { call } = client;

  /** The op must be refused, with a message matching `re`. */
  const denied = async (name: string, op: string, params: Record<string, unknown>, re: RegExp): Promise<void> => {
    try {
      const data = await call(op, params);
      check(name, false, `ALLOWED — returned ${JSON.stringify(data).slice(0, 60)}`);
    } catch (e) {
      const msg = (e as Error).message;
      check(name, re.test(msg), msg.slice(0, 80));
    }
  };

  /** The op must still work: a jail that refuses everything is not a fix. */
  const allowed = async (name: string, op: string, params: Record<string, unknown>, note = ""): Promise<void> => {
    try {
      // Not tracked: a successful write reports the mtime it happened at.
      await call(op, params, false);
      check(name, true, note);
    } catch (e) {
      check(name, false, `REFUSED — ${(e as Error).message}`);
    }
  };

  const skip = (name: string, why: string): void => check(`${name} (skipped)`, true, why);
  const gone = async (path: string): Promise<boolean> => !(await Bun.file(path).exists());

  try {
    // ── SEC-01: the git directory ──
    for (const [name, path] of [
      [".git/hooks/pre-commit", ".git/hooks/pre-commit"],
      [".git/config", ".git/config"],
      [".git case-folded", ".GIT/config"],
      [".git with a trailing dot", ".git./config"],
      [".git by its short name", "git~1/config"],
      [".git via backslashes", ".git\\config"],
      [".git in a subdirectory", "sub/.git/config"],
    ] as [string, string][]) {
      await denied(`write to ${name} refused`, "fs.write", { path, text: "x" }, /inside the git directory/);
    }
    await denied("read of .git/config refused", "fs.read", { path: ".git/config" }, /inside the git directory/);
    await denied("delete of .git refused", "fs.delete", { paths: [".git"] }, /inside the git directory/);
    await denied("move onto .git refused", "fs.move", { from: "app.ts", to: ".git/x" }, /inside the git directory/);

    const listing = await call<DirEntry[]>("fs.readdir", { path: "" });
    check("fs.readdir does not offer .git", !listing.some((e) => e.name === ".git"), listing.map((e) => e.name).join(", "));

    const config = await readFile(join(sandbox.root, ".git", "config"), "utf8");
    check("the repository config survived", !/fsmonitor|hooksPath/.test(config), "no command keys written");

    // Neighbours of .git that are ordinary content and must stay writable. What
    // is being tested is the *name* — that `isGitDirName` does not over-match
    // `.gitignore` or `.github` — so where the file sits is free, and it is
    // chosen to keep this suite from disturbing what the suite also compares.
    //
    // Both live inside `.github`, which the sandbox pre-creates, because these
    // are the only two checks here that write rather than refuse and the
    // sandbox is shared between the two runs. A file created at the root would
    // be absent from the first run's `readdir` and present in the second's, and
    // a file rewritten at the root would carry a different mtime in each — both
    // reported as the implementations disagreeing, which would be this test
    // describing its own side effects. A directory entry carries no mtime, so
    // `.github` itself stays byte-identical in both listings.
    await allowed("write to .gitignore still works", "fs.write", { path: ".github/.gitignore", text: "node_modules\n" });
    // Per implementation, because createFile is exclusive: the first agent to
    // run would create the file and the second would fail on EEXIST.
    await allowed("write to .github still works", "fs.createFile", { path: `.github/ci-${impl.id}.yml` });

    // ── SEC-04: symlinks ──
    //
    // The leaf of the path is a link out, and the ancestor of the path is a link
    // out, are two different holes: one is closed by lstat-ing the leaf, the
    // other by resolving the deepest ancestor that exists. Both are exercised.
    if (!sandbox.fileLinks) {
      skip("escapes through a file link", "this platform would not create file symlinks");
    } else {
      await denied("write through a link out refused", "fs.write",
        { path: "escape.txt", text: "OWNED" }, /escapes the workspace/);
      await denied("write through a dangling link out refused", "fs.write",
        { path: "dangling.txt", text: "OWNED" }, /escapes the workspace/);
      await denied("move onto a link out refused", "fs.move",
        { from: "real.txt", to: "escape.txt" }, /escapes the workspace/);

      check("the dangling link's target was not created", await gone(join(sandbox.base, "nowhere.txt")), "nowhere.txt absent");

      // A link that stays inside is content, not an escape: reading through one
      // already worked, and writing has to agree with that.
      await allowed("write through a link that stays inside still works", "fs.write",
        { path: "inside.txt", text: "edited through the link\n" });
      const target = await readFile(join(sandbox.root, "real.txt"), "utf8");
      check("it reached the link's target", target === "edited through the link\n", JSON.stringify(target));
    }

    if (!sandbox.dirLinks) {
      skip("escapes through a directory link", "this platform would not create directory links");
    } else {
      await denied("write below a linked directory refused", "fs.write",
        { path: "escape-dir/outside.txt", text: "OWNED" }, /escapes the workspace/);
      await denied("createFile below a linked directory refused", "fs.createFile",
        { path: "escape-dir/new.txt" }, /escapes the workspace/);
      await denied("createDir below a linked directory refused", "fs.createDir",
        { path: "escape-dir/new-dir" }, /escapes the workspace/);
      await denied("createDir onto the link itself refused", "fs.createDir",
        { path: "escape-dir" }, /escapes the workspace/);
      await denied("a path two levels below the link refused", "fs.write",
        { path: "escape-dir/deep/deeper/x.txt", text: "OWNED" }, /escapes the workspace/);
    }

    // Whatever the refusals said, the proof is that neither target changed.
    for (const [what, path] of [
      ["beside the workspace", join(sandbox.base, "outside.txt")],
      ["in the linked directory", join(sandbox.base, "outside-dir", "outside.txt")],
    ] as [string, string][]) {
      const text = await readFile(path, "utf8");
      check(`the file ${what} is untouched`, text === OUTSIDE, JSON.stringify(text.slice(0, 32)));
    }

    // ── SEC-02: git option injection ──
    //
    // --output= is a diff option, so `log` and `show` accept it and write
    // wherever it points. The canary sits outside the workspace: the check is
    // not only that the call was refused but that no file appeared.
    const canary = join(sandbox.base, "canary.txt");
    await denied("git.log ref option injection refused", "git.log", { ref: `--output=${canary}` }, /^Invalid ref:/);
    await denied("git.commitDetail oid option injection refused", "git.commitDetail", { oid: `--output=${canary}` }, /^Invalid commit:/);
    await denied("git.diff kind option injection refused", "git.diff", { kind: `--output=${canary}`, path: "app.ts" }, /^Invalid commit:/);
    await denied("git.blob rev option injection refused", "git.blob", { rev: `--output=${canary}`, path: "app.ts" }, /^Invalid revision:/);
    await denied("git.reset mode is not a free string", "git.reset", { oid: "HEAD", mode: "output=x" }, /^Invalid reset mode:/);
    await denied("git.rebase action is not a free string", "git.rebase", { action: "exec=whoami" }, /^Invalid rebase action:/);
    await denied("git.stash action is not a free string", "git.stash", { action: "--fake" }, /^Invalid stash action:/);
    check("no file was written outside the workspace", await gone(canary), "canary.txt absent");

    // The same values, legitimately: a jail that refuses HEAD is not a fix.
    await allowed("git.log with a ref still works", "git.log", { ref: "HEAD", limit: 5 }, "HEAD accepted");
    await allowed("git.blob of the index still works", "git.blob", { rev: "", path: "app.ts" }, "empty rev accepted");
    await allowed("git.diff kind=worktree still works", "git.diff", { kind: "worktree", path: "app.ts" }, "");
    await allowed("git.reset mode=mixed still works", "git.reset", { oid: "HEAD", mode: "mixed" }, "");

    // ── SEC-03: remotes ──
    await denied("push to a URL refused", "git.remote",
      { action: "push", remote: "https://attacker.example/x.git", ref: "HEAD" }, /^Unknown remote:/);
    await denied("fetch from a URL refused", "git.remote",
      { action: "fetch", remote: "https://attacker.example/x.git" }, /^Unknown remote:/);
    await denied("the ext:: transport refused", "git.remote",
      { action: "fetch", remote: "ext::sh -c whoami" }, /^Unknown remote:/);
    await denied("a remote given as a path refused", "git.remote",
      { action: "fetch", remote: "../../elsewhere" }, /^Unknown remote:/);
    await denied("the remote action is not a git subcommand", "git.remote",
      { action: "clone", remote: "origin" }, /^Invalid remote action:/);
    await allowed("git.remotes still lists the configured one", "git.remotes", {}, "origin");

    // ── write size ──
    //
    // Reads stop at 4 MB; writes used to stop only at the 32 MB WebSocket
    // frame, which let a client put on the disk what no read could return.
    const overCap = "x".repeat(4 * 1024 * 1024 + 1);
    // Inside `.github` for the reason given above: this suite compares the root
    // listing byte for byte, and a file one run leaves there is a file the
    // other run's listing does not have.
    await denied("a write past the read limit is refused", "fs.write",
      { path: ".github/too-big.txt", text: overCap }, /^Text is too large: [0-9]+ bytes .limit 4194304.$/);
    await allowed("a write at the limit still goes through", "fs.write",
      { path: ".github/at-limit.txt", text: "y".repeat(4 * 1024 * 1024) }, "exactly 4 MB");
  } catch (e) {
    check("unexpected error (hardening)", false, e instanceof Error ? e.message : String(e));
  } finally {
    await client.close();
  }
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
    exe: ["bun", "src/agent/cli.ts"],
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
      exe: [binary],
    });
  }
}

// Built once and shared: the hardening checks are refusals, so both agents can
// be pointed at the same workspace, and pointing them at the same one is what
// makes their replies comparable.
const sandbox = await makeSandbox();
if (!sandbox.fileLinks || !sandbox.dirLinks) {
  const missing = [!sandbox.fileLinks && "file", !sandbox.dirLinks && "directory"].filter(Boolean).join(" and ");
  console.log(`\nnote: this platform would not create ${missing} symlinks — those checks report as skipped\n`);
}

const runs: { impl: Impl; results: Result[]; answers: Map<string, string> }[] = [];
for (const impl of impls) {
  console.log(`\n── ${impl.label} ${"─".repeat(Math.max(0, 50 - impl.label.length))}`);
  const { results, answers } = await suite(impl, sandbox);
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

// The links inside point outward, so this is deleted rather than left in the
// temp directory for something else to walk into later.
await rm(sandbox.base, { recursive: true, force: true }).catch(() => undefined);

process.exit(failed || mismatched ? 1 : 0);
