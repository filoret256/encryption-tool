/** Git queries — a thin, parsing-only layer over the system `git` binary.
 *
 *  Every format string here was verified against git 2.55 before being written
 *  down; the machine-readable variants (`--porcelain=v2 -z`, `for-each-ref`
 *  with %00, `--raw --numstat -z`) are used specifically because they are
 *  NUL-delimited and therefore safe for paths containing spaces or newlines.
 */
import { run, runBytes } from "./proc.ts";
import { isBinary } from "./fs-ops.ts";
import type { Branch, Commit, CommitDetail, CommitFile, DiffPair, GitStatus, StatusEntry } from "./protocol.ts";

export class GitError extends Error {
  readonly code = "EGIT";
  constructor(message: string) {
    super(message.trim() || "git failed");
  }
}

/** %x1e between records, %x1f between fields — neither can occur in a ref name,
 *  an author name or a subject line. */
const REC = "\x1e";
const FLD = "\x1f";
const LOG_FMT = `%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s`;

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await run(["git", ...args], cwd);
  if (r.code !== 0) throw new GitError(r.stderr || r.stdout);
  return r.stdout;
}

/** Split on `sep` at most `n` times, leaving the remainder in the last slot —
 *  git puts the path last precisely so it can contain the separator. */
function splitN(s: string, sep: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  for (let i = 0; i < n; i++) {
    const at = rest.indexOf(sep);
    if (at === -1) break;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + sep.length);
  }
  out.push(rest);
  return out;
}

/** Absolute path of the repository containing `cwd`, or null if there is none. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await run(["git", "rev-parse", "--show-toplevel"], cwd);
  return r.code === 0 ? r.stdout.trim() : null;
}

// ── status ────────────────────────────────────────────────────────────────

export async function status(cwd: string): Promise<GitStatus> {
  const out = await git(cwd, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
  const f = out.split("\0");
  const st: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, oid: null, entries: [] };

  for (let i = 0; i < f.length; i++) {
    const rec = f[i];
    if (!rec) continue;

    if (rec.startsWith("# ")) {
      const [key, ...rest] = rec.slice(2).split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") st.oid = val === "(initial)" ? null : val;
      else if (key === "branch.head") st.branch = val === "(detached)" ? null : val;
      else if (key === "branch.upstream") st.upstream = val;
      else if (key === "branch.ab") {
        const m = /^\+(-?\d+) -(-?\d+)$/.exec(val);
        if (m) {
          st.ahead = Number(m[1]);
          st.behind = Number(m[2]);
        }
      }
      continue;
    }

    let e: StatusEntry | null = null;
    switch (rec[0]) {
      case "1": {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        const p = splitN(rec, " ", 8);
        e = { path: p[8], index: p[1][0], work: p[1][1] };
        break;
      }
      case "2": {
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
        const p = splitN(rec, " ", 9);
        e = { path: p[9], from: f[++i], index: p[1][0], work: p[1][1] };
        break;
      }
      case "u": {
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        const p = splitN(rec, " ", 10);
        e = { path: p[10], index: p[1][0], work: p[1][1], conflict: true };
        break;
      }
      case "?":
        e = { path: rec.slice(2), index: ".", work: "?", untracked: true };
        break;
      case "!":
        e = { path: rec.slice(2), index: ".", work: ".", ignored: true };
        break;
    }
    if (e) st.entries.push(e);
  }
  return st;
}

// ── history ───────────────────────────────────────────────────────────────

function parseCommits(out: string): Commit[] {
  return out
    .split(REC)
    .filter((r) => r.trim() !== "")
    .map((rec) => {
      const p = rec.split(FLD);
      return {
        oid: p[0] ?? "",
        parents: (p[1] ?? "").split(" ").filter(Boolean),
        author: p[2] ?? "",
        email: p[3] ?? "",
        time: Number(p[4] ?? 0),
        refs: p[5] ?? "",
        subject: (p[6] ?? "").replace(/\n+$/, ""),
      };
    });
}

export async function log(
  cwd: string,
  opts: { ref?: string; limit?: number; all?: boolean; path?: string } = {},
): Promise<Commit[]> {
  const args = ["log", "--date-order", `--format=${LOG_FMT}`, `-n${opts.limit ?? 200}`];
  if (opts.all) args.push("--all");
  else if (opts.ref) args.push(opts.ref);
  // `--` keeps a path that looks like a flag from being parsed as one.
  if (opts.path) args.push("--", opts.path);
  return parseCommits(await git(cwd, args));
}

export async function branches(cwd: string): Promise<Branch[]> {
  const out = await git(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)",
    "refs/heads",
    "refs/remotes",
  ]);
  const list: Branch[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [ref, oid, upstream, head] = line.split("\0");
    // refs/remotes/<name>/HEAD is a symbolic pointer, not a branch users pick.
    if (/^refs\/remotes\/[^/]+\/HEAD$/.test(ref)) continue;
    const remote = ref.startsWith("refs/remotes/");
    list.push({
      ref,
      name: ref.replace(/^refs\/(heads|remotes)\//, ""),
      oid,
      upstream: upstream || null,
      remote,
      head: head.trim() === "*",
    });
  }
  return list;
}

export async function commitDetail(cwd: string, oid: string): Promise<CommitDetail> {
  const commit = parseCommits(await git(cwd, ["log", "-1", `--format=${LOG_FMT}`, oid]))[0];
  if (!commit) throw new GitError(`unknown commit ${oid}`);
  // The body is fetched separately rather than appended to LOG_FMT: it is free
  // text and may contain the record separator, which would corrupt the parse.
  const body = (await git(cwd, ["log", "-1", "--format=%b", oid])).replace(/\n+$/, "");

  const args = ["show", "--no-color", "--format=", "--raw", "--numstat", "-z"];
  // A merge shows no diff by default; compare against its first parent instead.
  if (commit.parents.length > 1) args.push("-m", "--first-parent");
  args.push(oid);

  return { commit, body, files: parseFileList(await git(cwd, args)) };
}

/** Parse the interleaved `--raw` + `--numstat` sections of a -z diff. Raw
 *  records start with ':', numstat records start with a digit or '-'. */
function parseFileList(out: string): CommitFile[] {
  const f = out.split("\0");
  const order: { status: CommitFile["status"]; path: string; from?: string }[] = [];
  const nums = new Map<string, { added: number; deleted: number; binary: boolean }>();

  for (let i = 0; i < f.length; i++) {
    const rec = f[i];
    if (!rec) continue;

    if (rec.startsWith(":")) {
      // :<mSrc> <mDst> <hSrc> <hDst> <status>
      const letter = (rec.trim().split(" ").pop() ?? "M")[0] as CommitFile["status"];
      if (letter === "R" || letter === "C") {
        const from = f[++i];
        order.push({ status: letter, path: f[++i], from });
      } else {
        order.push({ status: letter, path: f[++i] });
      }
      continue;
    }

    // <added>\t<deleted>\t<path>   (path empty for renames -> two more fields)
    const parts = splitN(rec, "\t", 2); // limit 2: a filename may contain a tab
    const binary = parts[0] === "-";
    const added = binary ? 0 : Number(parts[0]) || 0;
    const deleted = binary ? 0 : Number(parts[1]) || 0;
    let path = parts[2] ?? "";
    if (path === "") {
      i++; // skip the old path
      path = f[++i] ?? "";
    }
    if (path) nums.set(path, { added, deleted, binary });
  }

  return order.map((o) => {
    const n = nums.get(o.path) ?? { added: 0, deleted: 0, binary: false };
    return { path: o.path, from: o.from, status: o.status, ...n };
  });
}

// ── file contents ─────────────────────────────────────────────────────────

/** Text of `path` at revision `rev`, or null when it does not exist there or
 *  is binary. `rev` is a commit-ish, or "" for the index (":<path>"). */
export async function blobAt(cwd: string, rev: string, path: string): Promise<{ text: string | null; binary: boolean }> {
  const spec = rev === "" ? `:${path}` : `${rev}:${path}`;
  const r = await runBytes(["git", "show", spec], cwd);
  if (r.code !== 0) return { text: null, binary: false };
  const binary = isBinary(r.bytes);
  return { text: binary ? null : new TextDecoder().decode(r.bytes), binary };
}

/** Build the two sides for @codemirror/merge.
 *  kind "worktree" — index vs file on disk (unstaged changes)
 *  kind "staged"   — HEAD vs index (staged changes)
 *  kind "head"     — last commit vs file on disk (everything since HEAD)
 *  otherwise       — the commit-ish itself vs its first parent */
export async function diffPair(
  cwd: string,
  path: string,
  kind: string,
  readWorktree: () => Promise<string | null>,
): Promise<DiffPair> {
  if (kind === "worktree") {
    const before = await blobAt(cwd, "", path);
    const after = await readWorktree();
    return {
      path,
      before: before.text,
      after,
      beforeLabel: "index",
      afterLabel: "working tree",
      binary: before.binary,
    };
  }
  if (kind === "head") {
    const before = await blobAt(cwd, "HEAD", path);
    const after = await readWorktree();
    return { path, before: before.text, after, beforeLabel: "HEAD", afterLabel: "working tree", binary: before.binary };
  }
  if (kind === "staged") {
    const before = await blobAt(cwd, "HEAD", path);
    const after = await blobAt(cwd, "", path);
    return { path, before: before.text, after: after.text, beforeLabel: "HEAD", afterLabel: "index", binary: before.binary || after.binary };
  }
  const before = await blobAt(cwd, `${kind}^`, path);
  const after = await blobAt(cwd, kind, path);
  return {
    path,
    before: before.text,
    after: after.text,
    beforeLabel: `${kind.slice(0, 8)}^`,
    afterLabel: kind.slice(0, 8),
    binary: before.binary || after.binary,
  };
}

export async function blame(cwd: string, path: string): Promise<{ oid: string; author: string; time: number; line: number }[]> {
  const out = await git(cwd, ["blame", "--line-porcelain", "--", path]);
  const rows: { oid: string; author: string; time: number; line: number }[] = [];
  let cur: { oid: string; author: string; time: number; line: number } | null = null;
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (header) {
      cur = { oid: header[1], author: "", time: 0, line: Number(header[2]) };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("author ")) cur.author = line.slice(7);
    else if (line.startsWith("author-time ")) cur.time = Number(line.slice(12));
    else if (line.startsWith("\t")) {
      rows.push(cur);
      cur = null;
    }
  }
  return rows;
}
