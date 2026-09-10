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

const argvFor = (impl: Impl, root: string, port: number): string[] => [
  ...impl.exe,
  "--root",
  root,
  "--port",
  String(port),
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
        key === "mtime" && typeof v === "number" ? Math.floor(v)
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
  close: () => Promise<void>;
}

/** Start an agent, wait for its banner, and open the socket the browser would.
 *
 *  `tag` namespaces the recorded replies: a run drives two agents — one on this
 *  repository, one on a throwaway workspace — and the same op with the same
 *  params means different things in each. */
async function connect(argv: string[], label: string, answers: Map<string, string>, tag: string): Promise<Client> {
  const proc = Bun.spawn(argv, {
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
  console.log(`\n${label}: ${url.replace(/token=.*/, "token=…")}\n`);

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
  return { results, answers };
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

    // Neighbours of .git that are ordinary content and must stay writable.
    await allowed("write to .gitignore still works", "fs.write", { path: ".gitignore", text: "node_modules\n" });
    await allowed("write to .github still works", "fs.createFile", { path: ".github/ci.yml" });

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
    await denied("a write past the read limit is refused", "fs.write",
      { path: "too-big.txt", text: overCap }, /^Text is too large: [0-9]+ bytes .limit 4194304.$/);
    await allowed("a write at the limit still goes through", "fs.write",
      { path: "at-limit.txt", text: "y".repeat(4 * 1024 * 1024) }, "exactly 4 MB");
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
