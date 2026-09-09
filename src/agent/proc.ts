/** Process helpers.
 *
 *  Everything here spawns with an argv array and never through a shell, so no
 *  part of a request can be interpreted as shell syntax. Git additionally runs
 *  with GIT_TERMINAL_PROMPT=0 — otherwise a fetch against a repo needing
 *  credentials blocks forever on a prompt nobody can see.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Bun's subprocess streams are async-iterable at runtime, but the DOM lib's
 *  ReadableStream type has no [Symbol.asyncIterator]. Narrow it in one place
 *  instead of casting at every `for await`. */
export const iter = (s: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> =>
  s as unknown as AsyncIterable<Uint8Array>;

const DEFAULT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  // Keep git's output stable regardless of the user's locale and config.
  LC_ALL: "C",
  GIT_PAGER: "cat",
};

function env(): Record<string, string> {
  return { ...(process.env as Record<string, string>), ...DEFAULT_ENV };
}

export async function run(argv: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(argv, { cwd, env: env(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Byte-exact variant — blobs may be binary, and decoding them as UTF-8 first
 *  would corrupt the content before we get a chance to detect that. */
export async function runBytes(argv: string[], cwd: string): Promise<{ code: number; bytes: Uint8Array; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd, env: env(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [buf, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, bytes: new Uint8Array(buf), stderr };
}

/** Stream stdout line by line. Used for search hits and transfer progress so
 *  the UI fills in as results arrive instead of after the process exits. */
export async function* runLines(
  argv: string[],
  cwd: string,
  opts: { stderr?: (line: string) => void } = {},
): AsyncGenerator<string, number> {
  const proc = Bun.spawn(argv, { cwd, env: env(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });

  if (opts.stderr) {
    // Git writes transfer progress to stderr; drain it concurrently, otherwise
    // a full pipe buffer deadlocks the child.
    void (async () => {
      const dec = new TextDecoder();
      let tail = "";
      for await (const bytes of iter(proc.stderr as ReadableStream<Uint8Array>)) {
        tail += dec.decode(bytes, { stream: true });
        // Progress uses \r; treat both terminators as line breaks.
        const parts = tail.split(/\r\n|[\r\n]/);
        tail = parts.pop() ?? "";
        for (const line of parts) if (line) opts.stderr!(line);
      }
      if (tail) opts.stderr!(tail);
    })();
  }

  const dec = new TextDecoder();
  let tail = "";
  for await (const bytes of iter(proc.stdout as ReadableStream<Uint8Array>)) {
    tail += dec.decode(bytes, { stream: true });
    const parts = tail.split("\n");
    tail = parts.pop() ?? "";
    for (const line of parts) yield line;
  }
  if (tail) yield tail;
  return await proc.exited;
}

/** Probe an executable's presence, returning its first version line or null. */
export async function probe(argv: string[]): Promise<string | null> {
  try {
    const r = await run(argv, process.cwd());
    if (r.code !== 0) return null;
    return r.stdout.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}
