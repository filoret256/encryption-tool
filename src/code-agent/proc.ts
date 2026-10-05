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

/** A process that ran past its deadline, or went quiet for too long. A class of
 *  its own for the same reason as the one above: git's own last words from a
 *  killed process are about a broken pipe, which says nothing about why. */
export class TimedOut extends Error {
  readonly code = "ETIMEDOUT";
  constructor(message: string) {
    super(message);
  }
}

/** How long a child process may run before it is killed.
 *
 *  Nothing bounded a child's lifetime. `Bun.spawn` has no deadline of its own,
 *  and `GIT_TERMINAL_PROMPT=0` only stops git from *asking* for a password: a
 *  fetch against a connection that never opens stayed alive and held one of the
 *  four process slots — and four of those stop every search and every git
 *  operation, which from the page looks exactly like a frozen application and
 *  is only cured by restarting the code-agent.
 *
 *  A read is bounded by its own work, and five minutes is far past the worst of
 *  it — a status of a very large tree is the slowest thing here, and it is
 *  seconds. A command that talks to a remote is bounded by somebody else's
 *  network, which is why it gets a longer allowance and why it also gets a
 *  window for silence: `--progress` makes a transfer talk continuously, so a
 *  command that has said nothing at all for three minutes is one whose
 *  connection has stopped carrying bytes, however patient the other end is.
 *
 *  The Go code-agent has the same numbers (code-agent-go/proc.go): the two must
 *  fail alike. */
const PROC_DEADLINE_MS = 5 * 60_000;
const NETWORK_DEADLINE_MS = 20 * 60_000;
const NETWORK_IDLE_MS = 3 * 60_000;

/** Git subcommands that talk to a remote, and so are bounded by a network
 *  rather than by a disk. Classified from the argv rather than passed in by
 *  each caller: the caller that forgot to say so would be the one that hangs. */
const NETWORK_GIT = new Set(["fetch", "pull", "push", "ls-remote", "clone", "submodule"]);

/** Options that take the next argv entry as their value. Only these can stand
 *  in front of a subcommand. */
const GIT_OPTS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** The git subcommand in an argv, or "" when this is not git.
 *
 *  Not simply `argv[1]`: a read runs as `git --no-optional-locks log …`, and
 *  reading the option as the subcommand would classify every read as "not a
 *  remote" by accident rather than by rule. */
export function gitSubcommand(argv: string[]): string {
  const exe = (argv[0] ?? "").split(/[\\/]/).pop() ?? "";
  if (exe !== "git" && exe !== "git.exe") return "";
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (GIT_OPTS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return "";
}

/** A command's two clocks, which the test above or the caller may fix. */
export interface ProcLimits {
  deadlineMs?: number;
  idleMs?: number;
}

/** The two clocks a command gets: how long it may run, and — for a command
 *  that talks to a remote — how long it may be silent.
 *
 *  Exported because it is the part of the watchdog worth checking without
 *  waiting five minutes, and because "a read and a fetch are treated
 *  differently" is a decision rather than an accident. `limits` is how a test
 *  says so; nothing in the editor passes it. */
export function procDeadlines(argv: string[], limits: ProcLimits = {}): Required<ProcLimits> {
  if (limits.deadlineMs !== undefined) return { deadlineMs: limits.deadlineMs, idleMs: limits.idleMs ?? 0 };
  return NETWORK_GIT.has(gitSubcommand(argv))
    ? { deadlineMs: NETWORK_DEADLINE_MS, idleMs: NETWORK_IDLE_MS }
    : { deadlineMs: PROC_DEADLINE_MS, idleMs: 0 };
}

/** A dead-man's switch on one child process.
 *
 *  `touch` is called wherever the process says anything, which is what "the
 *  connection is still carrying bytes" looks like: only a command that talks to
 *  a remote has that window at all, because only there is silence evidence of
 *  anything. */
class Watchdog {
  private total: ReturnType<typeof setTimeout> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private over: "deadline" | "idle" | null = null;
  private off = false;
  private readonly deadlineMs: number;
  private readonly idleMs: number;

  constructor(
    private readonly argv: string[],
    private readonly kill: () => void,
    limits: ProcLimits,
  ) {
    this.deadlineMs = limits.deadlineMs ?? PROC_DEADLINE_MS;
    this.idleMs = limits.idleMs ?? 0;
    this.total = setTimeout(() => this.fire("deadline"), this.deadlineMs);
    if (this.idleMs > 0) this.idle = setTimeout(() => this.fire("idle"), this.idleMs);
  }

  touch(): void {
    if (this.off || this.over !== null) return;
    if (this.idle !== null) {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => this.fire("idle"), this.idleMs);
    }
  }

  get timedOut(): boolean {
    return this.over !== null;
  }

  stop(): void {
    this.off = true;
    if (this.total !== null) clearTimeout(this.total);
    if (this.idle !== null) clearTimeout(this.idle);
    this.total = this.idle = null;
  }

  /** What to say about it: the command, and which of the two clocks ran out.
   *  The wording is the Go code-agent's (code-agent-go/proc.go): a page that
   *  showed one sentence against one agent and another against the other would
   *  be two behaviours, not one. */
  message(): string {
    let what = this.argv.slice(1).join(" ");
    if (what.length > 120) what = `${what.slice(0, 120)}…`;
    if (what === "") what = "the command";
    const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));
    if (this.over === "idle") return `${what} said nothing for ${minutes(this.idleMs)} minutes and was stopped`;
    return `${what} did not finish within ${minutes(this.deadlineMs)} minutes and was stopped`;
  }

  private fire(why: "deadline" | "idle"): void {
    if (this.off || this.over !== null) return;
    this.over = why;
    this.stop();
    this.kill();
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
export async function run(argv: string[], cwd: string, stdin?: string, limits: ProcLimits = {}): Promise<RunResult> {
  const r = await runLimited(argv, cwd, stdin, MAX_GIT_OUTPUT, limits);
  return { code: r.code, stdout: new TextDecoder().decode(r.bytes), stderr: r.stderr };
}

/** A command's output, collected in one buffer.
 *
 *  It used to be a list of chunks and then a second buffer of the whole size,
 *  with the chunks copied into it at the end: two copies of the same bytes alive
 *  at once, each up to 64 MB, and one of these per running git — four of them
 *  was around half a gigabyte of intermediate memory before the string and the
 *  JSON on top. The limit is measured on what has been read, so it is the list
 *  that has to go: this is the only copy, it grows by doubling, and the caller
 *  gets the buffer itself rather than a copy of it.
 *
 *  The Go code-agent does the same thing with a bytes.Buffer
 *  (code-agent-go/proc.go): the two must fail alike.
 *
 *  Reaching the limit stops the process where it stands — nothing is read to its
 *  end and then refused, and nothing is copied to say so.
 *
 *  Where it starts matters too: a command that says four lines should not cost a
 *  64 MB allocation, and one that says megabytes pays for a handful of
 *  doublings — a copy of what has been read so far, once per doubling. */
const OUTPUT_START_BYTES = 64 * 1024;

class Output {
  private buf: Uint8Array;
  private len = 0;

  constructor(private readonly max: number) {
    this.buf = new Uint8Array(Math.min(OUTPUT_START_BYTES, max));
  }

  /** Take a chunk, or say that the process has gone past its limit. */
  write(chunk: Uint8Array): boolean {
    if (this.len + chunk.length > this.max) return false;
    if (this.len + chunk.length > this.buf.length) this.grow(this.len + chunk.length);
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    return true;
  }

  private grow(need: number): void {
    let cap = this.buf.length;
    while (cap < need) cap = Math.min(cap * 2, this.max);
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** What was read, as a view rather than a copy. A slice would copy the whole
   *  output a second time to save at most the capacity it was read into, and
   *  every caller decodes or inspects these bytes and then drops them. */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/** Run a command and return what it wrote, unless that is more than `max` bytes:
 *  then the process is killed and this throws OutputTooLarge.
 *
 *  The process is also killed if it runs past its deadline. `limits` is how the
 *  watchdog's two numbers are overridden, and nothing in the editor passes it;
 *  it exists so that a test can make a five-minute deadline into a
 *  five-hundred-millisecond one. */
export async function runLimited(
  argv: string[],
  cwd: string,
  stdin: string | undefined,
  max: number,
  limits: ProcLimits = {},
): Promise<{ code: number; bytes: Uint8Array; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });
  const watch = new Watchdog(argv, () => proc.kill(), procDeadlines(argv, limits));

  try {
    // stderr is drained so a full pipe cannot stall the child, and only its start
    // is kept: an error message is a few lines.
    const stderrDone = (async () => {
      const dec = new TextDecoder();
      let kept = "";
      for await (const bytes of iter(proc.stderr as ReadableStream<Uint8Array>)) {
        watch.touch();
        if (kept.length < 1 << 20) kept += dec.decode(bytes, { stream: true });
      }
      return kept;
    })();

    const out = new Output(max);
    for await (const bytes of iter(proc.stdout as ReadableStream<Uint8Array>)) {
      watch.touch();
      if (!out.write(bytes)) {
        proc.kill();
        await proc.exited;
        throw new OutputTooLarge();
      }
    }
    const [stderr, code] = await Promise.all([stderrDone, proc.exited]);
    // Checked before the exit code: a process killed for running too long
    // exits with a failure of its own, and that is not what went wrong.
    if (watch.timedOut) throw new TimedOut(watch.message());
    return { code, bytes: out.bytes(), stderr };
  } finally {
    watch.stop();
  }
}

/** Byte-exact variant — blobs may be binary, and decoding them as UTF-8 first
 *  would corrupt the content before we get a chance to detect that. */
export async function runBytes(argv: string[], cwd: string, limits: ProcLimits = {}): Promise<{ code: number; bytes: Uint8Array; stderr: string }> {
  return runLimited(argv, cwd, undefined, MAX_GIT_OUTPUT, limits);
}

/** Stream stdout line by line. Used for search hits and transfer progress so
 *  the UI fills in as results arrive instead of after the process exits. */
export async function* runLines(
  argv: string[],
  cwd: string,
  opts: { stderr?: (line: string) => void; limits?: ProcLimits } = {},
): AsyncGenerator<string, number> {
  const proc = Bun.spawn(argv, { cwd, env: env(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const watch = new Watchdog(argv, () => proc.kill(), procDeadlines(argv, opts.limits));

  try {
    if (opts.stderr) {
      // Git writes transfer progress to stderr; drain it concurrently, otherwise
      // a full pipe buffer deadlocks the child.
      void (async () => {
        const dec = new TextDecoder();
        let tail = "";
        for await (const bytes of iter(proc.stderr as ReadableStream<Uint8Array>)) {
          watch.touch();
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
      watch.touch();
      tail += dec.decode(bytes, { stream: true });
      const parts = tail.split("\n");
      tail = parts.pop() ?? "";
      for (const line of parts) yield line;
    }
    if (tail) yield tail;
    const code = await proc.exited;
    if (watch.timedOut) throw new TimedOut(watch.message());
    return code;
  } finally {
    watch.stop();
  }
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
