/** Filesystem operations exposed to the explorer.
 *
 *  Thin wrappers over node:fs — the value here is that every path goes through
 *  the Jail first and that reads classify binary/oversized content instead of
 *  handing the editor a mangled string.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DirEntry, FileRead } from "./protocol.ts";
import type { Jail } from "./jail.ts";

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

export async function readTextFile(jail: Jail, path: string): Promise<FileRead> {
  const abs = await jail.toAbsExisting(path);
  const st = await stat(abs);
  if (st.size > MAX_TEXT) {
    return { text: null, size: st.size, mtime: st.mtimeMs, binary: false, tooLarge: true };
  }
  const bytes = await readFile(abs);
  const binary = isBinary(bytes);
  return {
    text: binary ? null : new TextDecoder().decode(bytes),
    size: st.size,
    mtime: st.mtimeMs,
    binary,
    tooLarge: false,
  };
}

export async function writeTextFile(jail: Jail, path: string, text: string): Promise<{ mtime: number }> {
  const abs = jail.toAbs(path);
  await writeFile(abs, text, "utf8");
  const st = await stat(abs);
  return { mtime: st.mtimeMs };
}

export async function createFile(jail: Jail, path: string): Promise<void> {
  const abs = jail.toAbs(path);
  await mkdir(dirname(abs), { recursive: true });
  // "wx" fails if it already exists — never silently truncate someone's file.
  await writeFile(abs, "", { flag: "wx" });
}

export async function createDir(jail: Jail, path: string): Promise<void> {
  await mkdir(jail.toAbs(path), { recursive: true });
}

export async function movePath(jail: Jail, from: string, to: string): Promise<void> {
  const src = await jail.toAbsExisting(from);
  const dst = jail.toAbs(to);
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
