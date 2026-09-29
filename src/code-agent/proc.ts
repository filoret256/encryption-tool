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

/** The most a git command may say before it is stopped.
 *
 *  `run` and `runBytes` read a command's whole output into memory, and nothing
 *  bounded it: `git.blob` of a 1 GB file from history, or a log asked for ten
 *  million commits, went into a buffer, then a string, then JSON, then the
 *  frame — several copies, some GB. Files on disk have always stopped at 4 MB;
 *  history did not.
 *
 *  64 MB is far past anything the panels can show, and the process is killed at
 *  the limit rather than read to its end and then refused. The Go code-agent has the
 *  same number (code-agent-go/proc.go): the two must fail alike. */
export const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/** A process said more than it was allowed to. A class of its own so that a
 *  caller with a better message — a blob knows it is a file, and what its limit
 *  is — can tell it from any other failure and say so. */
export class OutputTooLarge extends Error {
  readonly code = "EGIT";
  constructor(message = "git's output is larger than the 64 MB limit") {
    super(message);
  }
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

/** `stdin` feeds the process and closes the pipe; without it stdin is closed
 *  from the start, which is what every other caller wants. `git apply` reads
 *  its patch this way and has no other way in — a patch is not an argv. */
export async function run(argv: string[], cwd: string, stdin?: string): Promise<RunResult> {
  const r = await runLimited(argv, cwd, stdin, MAX_GIT_OUTPUT);
  return { code: r.code, stdout: new TextDecoder().decode(r.bytes), stderr: r.stderr };
}

/** Run a command and return what it wrote, unless that is more than `max` bytes:
 *  then the process is killed and this throws OutputTooLarge. */
export async function runLimited(
  argv: string[],
  cwd: string,
  stdin: string | undefined,
  max: number,
): Promise<{ code: number; bytes: Uint8Array; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });

  // stderr is drained so a full pipe cannot stall the child, and only its start
  // is kept: an error message is a few lines.
  const stderrDone = (async () => {
    const dec = new TextDecoder();
    let kept = "";
    for await (const bytes of iter(proc.stderr as ReadableStream<Uint8Array>)) {
      if (kept.length < 1 << 20) kept += dec.decode(bytes, { stream: true });
    }
    return kept;
  })();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const bytes of iter(proc.stdout as ReadableStream<Uint8Array>)) {
    total += bytes.length;
    if (total > max) {
      proc.kill();
      await proc.exited;
      throw new OutputTooLarge();
    }
    chunks.push(bytes);
  }
  const [stderr, code] = await Promise.all([stderrDone, proc.exited]);

  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  return { code, bytes: joined, stderr };
}

/** Byte-exact variant — blobs may be binary, and decoding them as UTF-8 first
 *  would corrupt the content before we get a chance to detect that. */
export async function runBytes(argv: string[], cwd: string): Promise<{ code: number; bytes: Uint8Array; stderr: string }> {
  return runLimited(argv, cwd, undefined, MAX_GIT_OUTPUT);
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
