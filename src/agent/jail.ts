/** Path containment for the agent.
 *
 *  The agent listens on loopback and every request carries a path, so this is
 *  the file that keeps a malicious (or merely buggy) page from reading outside
 *  the folder the user opened. Two checks, both required:
 *
 *    1. lexical — reject absolute paths and any `..` segment before resolving,
 *       so nothing can climb out via the string itself;
 *    2. realpath — for paths that already exist, resolve symlinks and re-check
 *       containment, so a symlink inside the workspace cannot point out of it.
 *
 *  Everything on the wire is POSIX-style and relative to the root; conversion
 *  to native separators happens here and nowhere else.
 */
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";

export class JailError extends Error {
  readonly code = "EPATH";
  constructor(p: string, reason = "Path escapes the workspace") {
    super(`${reason}: ${p}`);
  }
}

/** Does a path segment name the git directory?
 *
 *  The git directory is machinery, not content: a client that can write
 *  `.git/config` or `.git/hooks/*` runs commands on this machine the next time
 *  git is invoked — and the agent invokes git on its own, to refresh the status
 *  panel, so it need not even wait for the user. Nothing the editor
 *  legitimately does goes through here; git itself is reached with the `git.*`
 *  ops instead.
 *
 *  Matched the way git's own protections match it: case-insensitively (the
 *  segment is the same directory on a case-insensitive filesystem), ignoring
 *  the trailing dots and spaces Windows strips before opening a file, and
 *  including the NTFS 8.3 short name.
 */
export function isGitDirName(seg: string): boolean {
  const s = seg.toLowerCase().replace(/[. ]+$/, "");
  return s === ".git" || s === "git~1";
}

/** Windows paths are case-insensitive; comparing raw strings would let
 *  `C:\Work\repo\..\Other` slip past a case-mismatched prefix test. */
const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

function contains(root: string, abs: string): boolean {
  if (fold(abs) === fold(root)) return true;
  const rel = relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export class Jail {
  private constructor(readonly root: string) {}

  /** Resolve the workspace root once, following symlinks, so every later
   *  containment test compares against a canonical path. */
  static async open(dir: string): Promise<Jail> {
    return new Jail(await realpath(resolve(dir)));
  }

  /** Wire path -> absolute native path. Use for paths that may not exist yet
   *  (create, write, rename target). */
  toAbs(wire: string): string {
    const rel = String(wire).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    // A drive letter or an empty segment ("a//b") means the caller built the
    // path wrong; ".." is the one that actually escapes. Reject all three.
    if (/^[a-zA-Z]:/.test(rel)) throw new JailError(wire);
    if (rel !== "") {
      for (const seg of rel.split("/")) {
        if (seg === ".." || seg === "") throw new JailError(wire);
        if (isGitDirName(seg)) throw new JailError(wire, "Path is inside the git directory");
      }
    }
    const abs = resolve(this.root, rel);
    if (!contains(this.root, abs)) throw new JailError(wire);
    return abs;
  }

  /** Same, plus a symlink-aware re-check. Use for paths that must already
   *  exist (read, stat, delete, rename source). */
  async toAbsExisting(wire: string): Promise<string> {
    const abs = this.toAbs(wire);
    try {
      const real = await realpath(abs);
      if (!contains(this.root, real)) throw new JailError(wire);
      return real;
    } catch (e) {
      if (e instanceof JailError) throw e;
      return abs; // ENOENT and friends surface from the actual operation
    }
  }

  /** `toAbs` plus the symlink checks a write needs. Use it for every operation
   *  that creates or replaces something: write, create, mkdir, and the
   *  destination of a rename.
   *
   *  `toAbsExisting` resolves a path that must already exist, so it was never
   *  reached by the operations that make one — and that is exactly where the
   *  escape was: `writeFile` and its friends follow a symlink, so a link
   *  committed to the repository (`notes.txt -> ~/.ssh/authorized_keys`) is a
   *  write outside the workspace even though every string involved stayed
   *  inside it, and every lexical check passes.
   *
   *  Two resolutions, because one does not cover the other:
   *
   *   1. the leaf, via `lstat` — a link is followed only when its target is
   *      inside the workspace, which keeps editing an in-workspace link
   *      working, the way reading through one already does. A dangling link is
   *      refused outright: there is no target to check, and following it would
   *      create the file at the far end;
   *   2. the deepest ancestor that exists, via `realpath` — any directory on
   *      the way may itself be a link out, and the segments below the deepest
   *      existing one cannot be links, because they do not exist yet.
   *
   *  Note for renames: `rename` replaces a symlink rather than following it, so
   *  resolving the leaf makes a move onto an existing link land on its target
   *  instead. Both stay inside the workspace, and one rule for every write is
   *  worth more here than matching that corner exactly.
   */
  async toAbsForWrite(wire: string): Promise<string> {
    let abs = this.toAbs(wire);

    const link = await lstat(abs).then(
      (st) => st.isSymbolicLink(),
      () => false,
    );
    if (link) {
      const real = await realpath(abs).catch(() => null);
      if (real === null || !contains(this.root, real)) throw new JailError(wire);
      abs = real;
    }

    for (let dir = dirname(abs); ; ) {
      const real = await realpath(dir).catch(() => null);
      if (real !== null) {
        if (!contains(this.root, real)) throw new JailError(wire);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached the volume root without finding anything
      dir = parent;
    }

    return abs;
  }

  /** Absolute native path -> wire path (POSIX, relative to root). */
  toWire(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }
}
