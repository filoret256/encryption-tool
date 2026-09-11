/** Compare two folders.
 *
 *  The question this answers is the one the tool was missing entirely: "what is
 *  different between prod and stage?". Before, the only way to find out was to
 *  expand both trees, read the two lists side by side, and open every
 *  same-named pair by hand — so the answer depended on how carefully you looked.
 *
 *  It is deliberately a *file-set* comparison, not a recursive diff: which paths
 *  exist on one side only, and which exist on both but differ. Opening a pair is
 *  one click from the result, and that lands in the ordinary diff view.
 *
 *  Cost matters here, because "compare two folders" can mean twenty files or
 *  twenty thousand. Sizes come back with the directory listing for free, so big
 *  files are judged on size alone; everything of ordinary source size is read,
 *  because a CRLF and an LF copy of one file have different sizes and are not a
 *  difference anybody asked about.
 */
import type { DirEntry } from "../../agent/protocol.ts";

export type EntryState = "left" | "right" | "differs" | "same";

export interface FolderEntry {
  /** Path relative to the compared folder, so the two sides line up. */
  rel: string;
  state: EntryState;
  /** Full workspace paths, present on whichever side holds the file. */
  leftPath?: string;
  rightPath?: string;
}

export interface FolderCompareResult {
  entries: FolderEntry[];
  /** Set when a walk hit its ceiling: the answer is partial, and says so. */
  truncated: boolean;
}

export interface FolderOps {
  readDir(path: string): Promise<DirEntry[]>;
  read(path: string): Promise<{ text: string | null; binary: boolean }>;
}

/** Past this, a folder comparison is not the tool anyone wants; it stops and
 *  reports the list as partial rather than reading ten thousand files. */
const MAX_FILES = 4000;

/** Files above this are compared on size alone. Pulling both copies of a 40 MB
 *  archive through the socket to confirm what the byte count already says is a
 *  bad trade; below it, reading is what makes a CRLF-only difference read as
 *  "same" instead of as a change. */
const READ_LIMIT = 1 << 20;

interface Walked {
  /** relative path → size in bytes (-1 when the agent did not report one) */
  files: Map<string, number>;
  truncated: boolean;
}

/** Every file under `root`, keyed by path relative to it. */
async function walk(ops: FolderOps, root: string): Promise<Walked> {
  const files = new Map<string, number>();
  const queue: string[] = [""];
  let truncated = false;

  while (queue.length) {
    const rel = queue.shift()!;
    let entries: DirEntry[];
    try {
      entries = await ops.readDir(rel ? `${root}/${rel}` : root);
    } catch {
      continue; // an unreadable directory is skipped, not fatal to the compare
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.dir) {
        // .git under a compared folder is machinery, never content.
        if (e.name !== ".git") queue.push(childRel);
      } else if (files.size < MAX_FILES) {
        files.set(childRel, e.size ?? -1);
      } else {
        truncated = true;
      }
    }
  }
  return { files, truncated };
}

/** Do these two files hold the same thing?
 *
 *  Line endings are normalised for the same reason the diff view normalises
 *  them: a file checked out on Windows and one written on Linux are not a
 *  difference anybody asked about. */
async function sameContent(ops: FolderOps, left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([ops.read(left).catch(() => null), ops.read(right).catch(() => null)]);
  if (!a || !b) return false;
  // Equal-size binaries are called equal rather than pulled through the socket
  // to be sure — `text` is null for those anyway.
  if (a.binary || b.binary) return a.binary === b.binary;
  const normalise = (s: string | null): string => (s ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return normalise(a.text) === normalise(b.text);
}

/** Compare two folders in the workspace. */
export async function compareFolders(ops: FolderOps, left: string, right: string): Promise<FolderCompareResult> {
  const [a, b] = await Promise.all([walk(ops, left), walk(ops, right)]);
  const all = [...new Set([...a.files.keys(), ...b.files.keys()])].sort();

  const entries: FolderEntry[] = [];
  const toRead: FolderEntry[] = [];
  for (const rel of all) {
    const sizeA = a.files.get(rel);
    const sizeB = b.files.get(rel);
    const leftPath = `${left}/${rel}`;
    const rightPath = `${right}/${rel}`;
    if (sizeB === undefined) {
      entries.push({ rel, state: "left", leftPath });
    } else if (sizeA === undefined) {
      entries.push({ rel, state: "right", rightPath });
    } else if (sizeA > READ_LIMIT || sizeB > READ_LIMIT) {
      entries.push({ rel, state: sizeA === sizeB ? "same" : "differs", leftPath, rightPath });
    } else {
      // Provisional; settled by the read pass below.
      const entry: FolderEntry = { rel, state: "differs", leftPath, rightPath };
      entries.push(entry);
      toRead.push(entry);
    }
  }

  // A few reads at a time: one at a time makes a hundred-file folder feel like
  // a hang, and all at once floods a socket that also carries the UI's own
  // traffic.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < toRead.length) {
      const entry = toRead[next++]!;
      if (await sameContent(ops, entry.leftPath!, entry.rightPath!)) entry.state = "same";
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, toRead.length) }, worker));

  return { entries, truncated: a.truncated || b.truncated };
}
