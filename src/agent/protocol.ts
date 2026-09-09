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

export interface GitStatus {
  branch: string | null;
  /** null for a detached HEAD or an unborn branch. */
  upstream: string | null;
  ahead: number;
  behind: number;
  oid: string | null;
  entries: StatusEntry[];
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
