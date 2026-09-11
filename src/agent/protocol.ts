/** Wire protocol shared by the local agent and the browser client.
 *
 *  The browser cannot spawn processes, so every filesystem and git operation is
 *  an RPC to `enc-tool agent`, a second mode of this same binary running on the
 *  user's machine. Transport is a WebSocket on the loopback interface; loopback
 *  is a "potentially trustworthy" origin, so an https:// page may talk to
 *  ws://127.0.0.1 without tripping mixed-content blocking (Chromium + Firefox;
 *  WebKit refuses, hence the capability badge in the UI).
 *
 *  Frames:
 *    client -> agent   Req
 *    agent  -> client  Chunk*  Res          (one Res per Req, always last)
 *    agent  -> client  Push                 (unsolicited; no id)
 *
 *  All paths crossing the wire are POSIX-style and relative to the workspace
 *  root. The agent rejects absolute paths and any `..` segment (see jail.ts).
 */

export interface Req {
  id: number;
  op: string;
  [param: string]: unknown;
}

export type Res =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string; code?: string };

/** Partial result of a long-running op (search hits, transfer progress). */
export interface Chunk {
  id: number;
  chunk: unknown;
}

/** Server-initiated message (filesystem watcher). */
export interface Push {
  event: string;
  data: unknown;
}

export type ServerFrame = Res | Chunk | Push;

// ── op payloads ───────────────────────────────────────────────────────────

export interface AgentInfo {
  agent: "enc-tool";
  version: string;
  platform: string;
  root: string;
  /** Repository root relative to `root`, or null when the folder is not a repo. */
  repo: string | null;
  gitVersion: string | null;
  /** ripgrep is optional — without it search falls back to `git ls-files` + JS scan. */
  ripgrep: string | null;
  /** Recursive fs.watch is unavailable on some Linux kernels; UI hides live updates. */
  watch: boolean;
}

export interface DirEntry {
  name: string;
  dir: boolean;
  /** Present for files only. */
  size?: number;
  mtime?: number;
  /** True for symlinks; `dir` then reflects the link target. */
  link?: boolean;
}

export interface FileRead {
  /** utf-8 text, or null when the file is binary or over the size cap. */
  text: string | null;
  size: number;
  mtime: number;
  binary: boolean;
  tooLarge: boolean;
  /** Byte offset `text` starts at. 0 for an ordinary whole-file read.
   *
   *  A read with `length` is a window onto a file too big to open whole: the
   *  editor shows that slice read-only rather than the "too large" placeholder
   *  that used to be the only answer. The offset is where the agent actually
   *  started, which is not always where it was asked to — a window must not
   *  begin in the middle of a UTF-8 character. */
  offset: number;
  /** Whether `text` runs to the end of the file. */
  eof: boolean;
}

/** One line of `git reflog`: where a ref has been, and how it got there. */
export interface ReflogEntry {
  /** "HEAD@{3}" — what to pass back to reset onto this point. */
  selector: string;
  oid: string;
  /** The verb git recorded: "commit", "reset", "checkout", "merge"… */
  action: string;
  /** The rest of the line: a commit subject, "moving to main", and so on. */
  message: string;
  /** Unix seconds. */
  time: number;
}

/** One row of `git status --porcelain=v2`. */
export interface StatusEntry {
  path: string;
  /** Previous path for renames/copies. */
  from?: string;
  /** Index (staged) state: one of ".MADRCU" */
  index: string;
  /** Worktree (unstaged) state: one of ".MADRCU" */
  work: string;
  untracked?: boolean;
  ignored?: boolean;
  conflict?: boolean;
}

/** A git operation that stopped part-way and is waiting to be finished.
 *
 *  Merge, rebase, cherry-pick and revert all leave the repository in a state
 *  that only `--continue` or `--abort` gets out of, and during a rebase HEAD is
 *  detached — so without this the UI can only report "(detached)" and leave the
 *  user to work out what happened to their branch.
 */
export interface GitOperation {
  kind: "merge" | "rebase" | "cherry-pick" | "revert";
  /** Branch the operation started on: the one a rebase will restore at the end.
   *  Absent for a merge, where HEAD stays on the branch throughout. */
  head?: string;
  /** What the work is being replayed onto (rebase), or the subject line git
   *  prepared (merge, cherry-pick, revert) — whichever names the other side. */
  onto?: string;
  /** Position in a multi-commit rebase: commit `step` of `total`. */
  step?: number;
  total?: number;
}

export interface GitStatus {
  branch: string | null;
  /** null for a detached HEAD or an unborn branch. */
  upstream: string | null;
  ahead: number;
  behind: number;
  oid: string | null;
  entries: StatusEntry[];
  /** Set while a merge/rebase/cherry-pick/revert is half-finished. */
  operation?: GitOperation | null;
  /** The commit message git has already written for the next commit, with its
   *  comment lines stripped: `MERGE_MSG` after a merge or a cherry-pick that
   *  stopped, `SQUASH_MSG` after `merge --squash`. Null when there is none.
   *
   *  A squash leaves no half-finished operation — the index is staged and git is
   *  done — so this cannot live on `operation`: it is a property of what the
   *  next commit is going to be, not of an operation in progress. */
  preparedMessage?: string | null;
}

export interface Commit {
  oid: string;
  parents: string[];
  author: string;
  email: string;
  /** Author time, seconds since epoch. */
  time: number;
  /** Decoration from %D, e.g. "HEAD -> main, origin/main, tag: v2". */
  refs: string;
  subject: string;
}

export interface Branch {
  /** Full refname, e.g. "refs/heads/main" or "refs/remotes/origin/main". */
  ref: string;
  /** Short display name, e.g. "main" or "origin/main". */
  name: string;
  oid: string;
  upstream: string | null;
  remote: boolean;
  head: boolean;
  /** refs/tags/… — a fixed point rather than something you commit onto. Listed
   *  alongside branches because everything that takes a ref (compare, create a
   *  branch from, check out) takes a tag just as happily, and a picker that
   *  hides them sends people to the terminal for a release. */
  tag: boolean;
  /** Commits this branch has that its upstream does not, and the other way
   *  round. Both 0 when there is no upstream to compare against. */
  ahead: number;
  behind: number;
  /** When the ref last moved, in unix seconds — "3 days ago" beside a branch
   *  name is most of what tells stale from current in a long list. */
  time: number;
}

/** A pair of texts for @codemirror/merge. `before`/`after` are null when the
 *  file does not exist on that side (added / deleted). */
export interface DiffPair {
  path: string;
  before: string | null;
  after: string | null;
  beforeLabel: string;
  afterLabel: string;
  binary: boolean;
}

export interface CommitFile {
  path: string;
  from?: string;
  status: "A" | "M" | "D" | "R" | "C" | "T";
  added: number;
  deleted: number;
  binary: boolean;
}

export interface CommitDetail {
  commit: Commit;
  body: string;
  files: CommitFile[];
  /** For a merge: which parent the file list was diffed against, 1-based.
   *  Absent for an ordinary commit, which has only one side to compare with. */
  parent?: number;
}

/** One line of `git blame`. The browser mirror of this is `BlameLine` in
 *  code/blame.ts, which is where the gutter renders it. */
export interface BlameRow {
  oid: string;
  author: string;
  /** Author time, seconds since epoch. */
  time: number;
  /** 1-based line in the committed file. */
  line: number;
  /** Subject of the commit this line came from, as git's porcelain reports it. */
  summary: string;
}

export interface SearchHit {
  path: string;
  /** 1-based. */
  line: number;
  /** 0-based byte column of the first match on the line. */
  col: number;
  text: string;
  /** [start, end) byte offsets of every match within `text`. */
  ranges: [number, number][];
}

export interface SearchSummary {
  files: number;
  matches: number;
  /** True when the scan stopped at the result cap. */
  truncated: boolean;
  engine: "ripgrep" | "fallback";
}

export interface FsChange {
  /** Deduplicated, workspace-relative paths that changed since the last push. */
  paths: string[];
}
