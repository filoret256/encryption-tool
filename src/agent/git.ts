/** Git queries — a thin, parsing-only layer over the system `git` binary.
 *
 *  Every format string here was verified against git 2.55 before being written
 *  down; the machine-readable variants (`--porcelain=v2 -z`, `for-each-ref`
 *  with %00, `--raw --numstat -z`) are used specifically because they are
 *  NUL-delimited and therefore safe for paths containing spaces or newlines.
 */
import { run, runBytes } from "./proc.ts";
import { isBinary } from "./fs-ops.ts";
import type { Branch, Commit, CommitDetail, CommitFile, DiffPair, GitStatus, ReflogEntry, StatusEntry } from "./protocol.ts";

export class GitError extends Error {
  readonly code = "EGIT";
  constructor(message: string) {
    super(message.trim() || "git failed");
  }
}

/** Reject option-looking values before they reach an argv.
 *
 *  Git reads any argument beginning with "-" as an option, and several of those
 *  do considerably more than pick a revision: `--output=<file>` is a diff
 *  option, which means `log` and `show` both accept it, and it writes wherever
 *  it is pointed — outside the workspace the jail exists to guard. So every
 *  value that arrives from the client and lands in an argv passes through here,
 *  in the read operations as much as in the writing ones.
 */
export function safe(v: unknown, what: string): string {
  const s = String(v ?? "");
  if (s === "" || s.startsWith("-")) throw new GitError(`Invalid ${what}: ${s}`);
  return s;
}

/** `safe()` for a value whose absence is meaningful: "" means "not given" and
 *  is passed through, anything actually present is checked. */
export function safeOpt(v: unknown, what: string): string {
  const s = String(v ?? "");
  return s === "" ? "" : safe(s, what);
}

/** One of a fixed set. Used where the value is not data but a choice — a reset
 *  mode, a rebase action — and the legitimate answers are known and few.
 *  Rejecting a leading "-" is not enough there, because the value is
 *  concatenated into the flag itself. */
export function oneOf<T extends string>(v: string, allowed: readonly T[], what: string): T {
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new GitError(`Invalid ${what}: ${v}`);
}

/** %x1e between records, %x1f between fields — neither can occur in a ref name,
 *  an author name or a subject line. */
const REC = "\x1e";
const FLD = "\x1f";
const LOG_FMT = `%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s`;

/** Argv for a git command that only reads.
 *
 *  `git status` is not a pure read: it refreshes the index and writes the
 *  updated stat cache back to `.git/index`. The watcher sees a write under
 *  `.git`, the UI refreshes status, branches and history, those run `git status`
 *  again — and the three panels rebuild once a second forever, with no user
 *  action anywhere in the loop. `--no-optional-locks` tells git to skip exactly
 *  the writes it performs only as an optimisation, so a read stays a read; the
 *  same flag is why other editors do not sit in this loop. git 2.15 and newer.
 *
 *  Writes must not use it: they need the lock they are taking.
 */
export function readOnly(args: string[]): string[] {
  return ["git", "--no-optional-locks", ...args];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await run(readOnly(args), cwd);
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
  const r = await run(readOnly(["rev-parse", "--show-toplevel"]), cwd);
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
  opts: { ref?: string; limit?: number; all?: boolean; path?: string; skip?: number } = {},
): Promise<Commit[]> {
  const args = ["log", "--date-order", `--format=${LOG_FMT}`, `-n${opts.limit ?? 200}`];
  // `skip` is what makes "load more" a page rather than a bigger request: the
  // history view used to raise its limit and re-ask for the whole window, so
  // the tenth page walked the first nine again and parsed them again. A number,
  // never a string, so there is nothing here for `safe()` to screen.
  if (opts.skip && opts.skip > 0) args.push(`--skip=${Math.floor(opts.skip)}`);
  if (opts.all) args.push("--all");
  else if (opts.ref) args.push(safe(opts.ref, "ref"));
  // `--` keeps a path that looks like a flag from being parsed as one.
  if (opts.path) args.push("--", opts.path);
  return parseCommits(await git(cwd, args));
}

/** Which of `paths` git would ignore.
 *
 *  Asked a directory at a time: the explorer dims a folder's contents, and one
 *  call per file would be one spawn per row.
 *
 *  The paths go in on stdin rather than in the argv. `-z` is what makes the
 *  answer parseable for a path containing a newline, and git accepts `-z` only
 *  together with `--stdin` — but stdin is also the only inlet with no length
 *  limit, and a directory of ten thousand entries would otherwise be an argv
 *  too long for the platform to spawn.
 *
 *  No `--no-index`: a tracked file is not ignored however well it matches a
 *  pattern, and that is precisely the distinction the explorer is drawing.
 */
export async function checkIgnore(cwd: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const p = paths.map((x) => safe(x, "path"));
  const r = await run(readOnly(["check-ignore", "-z", "--stdin"]), cwd, p.join("\0"));
  // 0 = some are ignored, 1 = none are. Anything else is a real failure.
  if (r.code !== 0 && r.code !== 1) throw new GitError(r.stderr || r.stdout);
  return r.stdout.split("\0").filter(Boolean);
}

/** Where HEAD has been — the undo list.
 *
 *  Every ref movement git makes is recorded here, including the ones with no
 *  other way back: a `reset --hard` that threw away a commit leaves the commit
 *  itself intact and only this remembers its name. So the UI's "undo the last
 *  operation" is a reflog entry plus the reset onto it, and this is the half
 *  that has to exist first.
 */
export async function reflog(cwd: string, limit = 50): Promise<ReflogEntry[]> {
  // No `--date`: it rewrites `%gd` from the ordinal `HEAD@{0}` into a timestamp
  // form, and the ordinal is the half that can be passed back to reset. The
  // time comes from `%ct`, which `--date` does not touch.
  const out = await git(cwd, ["reflog", `-n${Math.max(1, Math.floor(limit))}`, `--format=%gd%x1f%H%x1f%gs%x1f%ct`]);
  const entries: ReflogEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const p = line.split(FLD);
    // "commit: subject", "reset: moving to …", "checkout: moving from a to b"
    const [action, rest] = splitN(p[2] ?? "", ": ", 1);
    entries.push({
      selector: p[0] ?? "",
      oid: p[1] ?? "",
      action: rest === undefined ? "" : action,
      message: rest === undefined ? (p[2] ?? "") : rest,
      time: Number(p[3] ?? 0),
    });
  }
  return entries;
}

export async function branches(cwd: string): Promise<Branch[]> {
  const out = await git(cwd, [
    "for-each-ref",
    // `upstream:track` prints "[ahead 1, behind 2]", "[gone]" or nothing;
    // `creatordate` is used rather than committerdate because it is also
    // defined for annotated tag objects, which have no committer.
    "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(upstream:track)%00%(creatordate:unix)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  const list: Branch[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [ref, oid, upstream, head, track, time] = line.split("\0");
    // refs/remotes/<name>/HEAD is a symbolic pointer, not a branch users pick.
    if (/^refs\/remotes\/[^/]+\/HEAD$/.test(ref)) continue;
    const remote = ref.startsWith("refs/remotes/");
    list.push({
      ref,
      name: ref.replace(/^refs\/(heads|remotes|tags)\//, ""),
      oid,
      upstream: upstream || null,
      remote,
      head: head.trim() === "*",
      tag: ref.startsWith("refs/tags/"),
      ahead: Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track ?? "")?.[1] ?? 0),
      time: Number(time ?? 0) || 0,
    });
  }
  return list;
}

export async function commitDetail(cwd: string, oid: string): Promise<CommitDetail> {
  oid = safe(oid, "commit");
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
  rev = safeOpt(rev, "revision");
  const spec = rev === "" ? `:${path}` : `${rev}:${path}`;
  const r = await runBytes(readOnly(["show", spec]), cwd);
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
  // Anything else is a commit-ish, which means it is client data reaching an
  // argv — the one branch here that has to be checked.
  const rev = safe(kind, "commit");
  const before = await blobAt(cwd, `${rev}^`, path);
  const after = await blobAt(cwd, rev, path);
  return {
    path,
    before: before.text,
    after: after.text,
    beforeLabel: `${rev.slice(0, 8)}^`,
    afterLabel: rev.slice(0, 8),
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
