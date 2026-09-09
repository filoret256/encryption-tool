/** Shared test harness: boot a real agent and talk to it over the same
 *  WebSocket protocol the browser uses. */
import { iter } from "../src/agent/proc.ts";

export interface Harness {
  /** The returned promise also carries the streamed chunks and the request id,
   *  so a test can cancel the very request it just issued. */
  call<T>(op: string, params?: Record<string, unknown>): Promise<T> & { chunks: unknown[]; id: number };
  close(): void;
}

/** `env` lets a test start the agent with a doctored PATH — that is how the
 *  ripgrep and fallback search engines get compared against each other. */
export async function startAgent(root: string, port: number, env?: Record<string, string>): Promise<Harness> {
  const proc = Bun.spawn(["bun", "src/agent/cli.ts", "--root", root, "--port", String(port)], {
    cwd: process.cwd(),
    env: env ?? (process.env as Record<string, string>),
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });

  const dec = new TextDecoder();
  let buf = "";
  let url = "";
  for await (const bytes of iter(proc.stdout as ReadableStream<Uint8Array>)) {
    buf += dec.decode(bytes, { stream: true });
    const m = /(ws:\/\/127\.0\.0\.1:\d+\/ws\?token=[0-9a-f]+)/.exec(buf);
    if (m) {
      url = m[1];
      break;
    }
  }
  if (!url) throw new Error(`agent did not print a URL:\n${buf}`);

  const ws = new WebSocket(url);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; chunks: unknown[] }>();
  let nextId = 1;

  ws.addEventListener("message", (ev) => {
    const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
    if (typeof frame.event === "string") return;
    const entry = pending.get(frame.id as number);
    if (!entry) return;
    if ("chunk" in frame) return void entry.chunks.push(frame.chunk);
    pending.delete(frame.id as number);
    if (frame.ok) entry.resolve(frame.data);
    else entry.reject(new Error(String(frame.error)));
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });

  return {
    call<T>(op: string, params: Record<string, unknown> = {}) {
      const id = nextId++;
      const chunks: unknown[] = [];
      const p = new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, chunks });
        ws.send(JSON.stringify({ id, op, ...params }));
      });
      return Object.assign(p, { chunks, id });
    },
    close() {
      ws.close();
      proc.kill();
    },
  };
}

/** Run git directly (test setup), bypassing the agent. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err || out}`);
  return out;
}
