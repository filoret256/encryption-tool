/** Filesystem operations exposed to the explorer.
 *
 *  Thin wrappers over node:fs — the value here is that every path goes through
 *  the Jail first and that reads classify binary/oversized content instead of
 *  handing the editor a mangled string.
 */
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DirEntry, FileRead } from "./protocol.ts";
import { isGitDirName, type Jail } from "./jail.ts";

/** Above this a file opens as read-only "too large" rather than in the editor.
 *  CodeMirror copes with a few MB, but the round trip over the socket does not. */
const MAX_TEXT = 4 * 1024 * 1024;
/** A NUL byte in the first block is the same heuristic git itself uses. */
const SNIFF = 8000;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export async function readDir(jail: Jail, path: string): Promise<DirEntry[]> {
  const abs = await jail.toAbsExisting(path);
  const dirents = await readdir(abs, { withFileTypes: true });
  const out: DirEntry[] = [];

  for (const d of dirents) {
    // The jail refuses to open anything under the git directory, so listing it
    // would only offer the explorer a row that errors when clicked.
    if (isGitDirName(d.name)) continue;
    const link = d.isSymbolicLink();
    let isDir = d.isDirectory();
    let size: number | undefined;
    let mtime: number | undefined;

    try {
      // stat() follows symlinks, so a link to a directory sorts with directories.
      const st = await stat(abs + "/" + d.name);
      isDir = st.isDirectory();
      if (!isDir) {
        size = st.size;
        mtime = st.mtimeMs;
      }
    } catch {
      // Broken symlink or a race with an external delete — list it anyway.
    }
    out.push(link ? { name: d.name, dir: isDir, size, mtime, link } : { name: d.name, dir: isDir, size, mtime });
  }

  // Directories first, then natural-order by name — matches VS Code's explorer.
  out.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
  return out;
}

/** Trim a byte range so it holds only whole UTF-8 characters.
 *
 *  A window onto a large file starts and ends wherever the caller asked, which
 *  is very unlikely to be a character boundary — and decoding a half character
 *  puts U+FFFD at each end of every page. So the start walks forward off any
 *  continuation byte, and the end walks back off a lead byte whose sequence the
 *  slice does not contain.
 *
 *  Both agents must trim identically, or the same window returns different text
 *  depending on which one is running. This is the definition the other copy in
 *  agent-go/fsops.go mirrors.
 */
export function alignUtf8(bytes: Uint8Array, from: number, to: number): [number, number] {
  let start = from;
  // 0b10xxxxxx is a continuation byte: it cannot begin a character.
  while (start < to && (bytes[start] & 0xc0) === 0x80) start++;
  let end = to;
  // Walk back to the last lead byte and keep it only if its whole sequence fits.
  let i = end - 1;
  while (i >= start && (bytes[i] & 0xc0) === 0x80) i--;
  if (i >= start) {
    const b = bytes[i];
    const need = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (i + need > end) end = i;
  }
  return [start, end];
}

/** Read a file, or a window of one.
 *
 *  Without `length` this is the whole file, and anything over the cap comes back
 *  as `tooLarge` with no text — the editor cannot hold it and the socket cannot
 *  carry it. With `length` the cap does not apply to the file, only to the
 *  window: a 300 MB log is readable a page at a time, read-only, which is the
 *  difference between "cannot be opened" and "can be looked at".
 */
export async function readTextFile(
  jail: Jail,
  path: string,
  range?: { offset?: number; length?: number },
): Promise<FileRead> {
  const abs = await jail.toAbsExisting(path);
  const st = await stat(abs);

  const wantLength = Math.floor(range?.length ?? 0);
  if (wantLength > 0) {
    if (wantLength > MAX_TEXT) throw new Error(`Length is too large: ${wantLength} bytes (limit ${MAX_TEXT})`);
    const from = Math.min(Math.max(0, Math.floor(range?.offset ?? 0)), st.size);
    const to = Math.min(from + wantLength, st.size);
    // Only the window is read. Reading the file and slicing it would make a
    // 300 MB log cost 300 MB per page, which is the thing this exists to avoid.
    const buf = Buffer.alloc(to - from);
    const fh = await open(abs, "r");
    let got = 0;
    try {
      got = (await fh.read(buf, 0, buf.length, from)).bytesRead;
    } finally {
      await fh.close();
    }
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, got);
    // Sniffed over the window, not the file: a window of a file whose binary
    // bytes are elsewhere is text, and refusing it would be refusing the page
    // the user asked for because of a page they did not.
    if (isBinary(bytes)) {
      return { text: null, size: st.size, mtime: st.mtimeMs, binary: true, tooLarge: false, offset: from, eof: from + got >= st.size };
    }
    const [s, e] = alignUtf8(bytes, 0, got);
    return {
      text: new TextDecoder().decode(bytes.subarray(s, e)),
      size: st.size,
      mtime: st.mtimeMs,
      binary: false,
      tooLarge: false,
      offset: from + s,
      eof: from + e >= st.size,
    };
  }

  if (st.size > MAX_TEXT) {
    return { text: null, size: st.size, mtime: st.mtimeMs, binary: false, tooLarge: true, offset: 0, eof: false };
  }
  const bytes = await readFile(abs);
  const binary = isBinary(bytes);
  return {
    text: binary ? null : new TextDecoder().decode(bytes),
    size: st.size,
    mtime: st.mtimeMs,
    binary,
    tooLarge: false,
    offset: 0,
    eof: true,
  };
}

export async function writeTextFile(jail: Jail, path: string, text: string): Promise<{ mtime: number }> {
  // Reads stop at MAX_TEXT, but the socket accepts a 32 MB frame, so writes had
  // no ceiling at all: a client could put far more on the disk than the editor
  // could ever open again. A write that no read can return is not an edit.
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_TEXT) throw new Error(`Text is too large: ${bytes} bytes (limit ${MAX_TEXT})`);
  const abs = await jail.toAbsForWrite(path);
  await writeFile(abs, text, "utf8");
  const st = await stat(abs);
  return { mtime: st.mtimeMs };
}

export async function createFile(jail: Jail, path: string): Promise<void> {
  const abs = await jail.toAbsForWrite(path);
  await mkdir(dirname(abs), { recursive: true });
  // "wx" fails if it already exists — never silently truncate someone's file.
  await writeFile(abs, "", { flag: "wx" });
}

export async function createDir(jail: Jail, path: string): Promise<void> {
  await mkdir(await jail.toAbsForWrite(path), { recursive: true });
}

export async function movePath(jail: Jail, from: string, to: string): Promise<void> {
  const src = await jail.toAbsExisting(from);
  const dst = await jail.toAbsForWrite(to);
  await mkdir(dirname(dst), { recursive: true });
  await rename(src, dst);
}

export async function deletePaths(jail: Jail, paths: string[]): Promise<void> {
  for (const p of paths) {
    const abs = await jail.toAbsExisting(p);
    await rm(abs, { recursive: true, force: true });
  }
}

export async function statPath(jail: Jail, path: string): Promise<{ dir: boolean; size: number; mtime: number }> {
  const st = await stat(await jail.toAbsExisting(path));
  return { dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
}

export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, SNIFF);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
