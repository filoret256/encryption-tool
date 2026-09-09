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
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

export class JailError extends Error {
  readonly code = "EPATH";
  constructor(p: string) {
    super(`Path escapes the workspace: ${p}`);
  }
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
    if (rel !== "" && rel.split("/").some((seg) => seg === ".." || seg === "")) {
      throw new JailError(wire);
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

  /** Absolute native path -> wire path (POSIX, relative to root). */
  toWire(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }
}
