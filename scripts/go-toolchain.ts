/** Finding a Go toolchain, in the one place both the build script and the
 *  smoke test can agree on.
 *
 *  Go is not needed to work on the web app or the TypeScript agent, so its
 *  absence is never fatal here — callers decide whether to skip or to fail.
 *  GO_BIN exists for the common case of a toolchain unpacked somewhere that is
 *  not on PATH.
 */
import { join } from "node:path";

export async function findGo(): Promise<string | null> {
  const exe = process.platform === "win32" ? "go.exe" : "go";
  const candidates = [
    process.env.GO_BIN,
    process.env.GOROOT ? join(process.env.GOROOT, "bin", exe) : undefined,
    "go",
  ].filter((c): c is string => Boolean(c));

  for (const go of candidates) {
    try {
      const proc = Bun.spawn([go, "version"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      if ((await proc.exited) === 0) return go;
    } catch {
      // not on PATH, or not executable — try the next candidate
    }
  }
  return null;
}

export const GO_MISSING =
  "no Go toolchain found. Install Go, or set GO_BIN to the go binary of an existing one.";
