/** A request that is never answered, and what the client does about it: `bun run agent-client:smoke`.
 *
 *  P1 of to-do-dp.md. The failure this guards against is quiet: a frame the page never got
 *  leaves the promise pending for the life of the connection, and every panel refresh that
 *  awaited it waits with it — one at a time, for ever (see code/singleflight.ts). Nothing
 *  throws, nothing is logged, the panel simply never updates again.
 *
 *  So the checks here are about endings: a request that hears nothing ends with an error
 *  naming the op and the seconds; the entry it held is gone; the agent is asked to stop; a
 *  stream is given up on after silence but not while it is talking; a stream nobody set a
 *  deadline for is left alone (a topic with nothing new is not a fault); the liveness probe
 *  gives up on its own; and a refresh built on a doomed call runs again afterwards.
 */
import { AgentClient, type AgentSpec } from "../src/web/agent-client.ts";
import { singleFlight } from "../src/web/code/singleflight.ts";

const results: { name: string; ok: boolean; note: string }[] = [];

function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Info = { agent: string };
/** An agent of the test's own: two things it does — answer what it is told to answer, and
 *  say nothing at all about the rest. The silence is the subject. */
const spec: AgentSpec<Info> = {
  name: "test-agent",
  urlKey: "test-agent-url",
  infoOp: "agent.info",
  portsMeta: "test-agent-ports",
  defaultPorts: [5001, 5010],
  deadlineMs: 400,
  slowOps: { "test.slow": 1_500, "test.stream": 300 },
  check: () => null,
};

/** The agent: it answers `agent.info`, `test.answered`, `test.stream` when told to, and
 *  records every op it saw — including the cancels the client sends when it gives up. */
interface Seen {
  op: string;
  target?: number;
}
const seen: Seen[] = [];
/** How the test agent behaves for `test.stream`: finish properly after a few chunks, or
 *  go quiet in the middle — which is what the stream deadline is about. */
let streamMode: "finish" | "goSilent" = "finish";
// Starts silent: the first connection is the one that is never answered.
let answerInfo = false;
let answerPing = true;

const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ping") {
      // A /ping that never answers: the probe has to give up by itself.
      return answerPing ? new Response("ok") : new Promise<Response>(() => {});
    }
    if (srv.upgrade(req)) return undefined;
    return new Response("no");
  },
  websocket: {
    message(ws, raw) {
      const frame = JSON.parse(String(raw)) as { id: number; op: string; target?: number };
      seen.push({ op: frame.op, target: frame.target });
      if (frame.op === "cancel") return; // the cancel is the point; it needs no answer
      if (frame.op === "agent.info") {
        if (answerInfo) ws.send(JSON.stringify({ id: frame.id, ok: true, data: { agent: "test-agent" } }));
        return; // otherwise: silence, which is the failure this file is about
      }
      if (frame.op === "test.answered") {
        setTimeout(() => ws.send(JSON.stringify({ id: frame.id, ok: true, data: { answered: true } })), 100);
        return;
      }
      if (frame.op === "test.stream") {
        // Four chunks 100 ms apart: longer than the stream's deadline of 300 ms, so a
        // client that did not count chunks as news would give up in the middle of it.
        let sent = 0;
        const timer = setInterval(() => {
          sent++;
          if (streamMode === "goSilent" && sent > 1) {
            clearInterval(timer); // silence in the middle, and no reply ever
            return;
          }
          if (sent > 3) {
            clearInterval(timer);
            ws.send(JSON.stringify({ id: frame.id, ok: true, data: { done: true } }));
            return;
          }
          ws.send(JSON.stringify({ id: frame.id, chunk: { n: sent } }));
        }, 100);
      }
    },
  },
});

const url = `ws://127.0.0.1:${server.port}/ws?token=t`;
const client = new AgentClient(spec, () => {});
const pending = (): number => (client as unknown as { pending: Map<number, unknown> }).pending.size;

const outcome = async (p: Promise<unknown>): Promise<{ how: string; code?: string }> => {
  try {
    await p;
    return { how: "resolved" };
  } catch (e) {
    return { how: `rejected: ${(e as Error).message}`, code: (e as { code?: string }).code };
  }
};

// ── the handshake with an agent that says nothing ─────────────────────────
{
  const started = Date.now();
  const r = await outcome(client.connect(url));
  const took = Date.now() - started;
  check("a silent agent fails the handshake instead of hanging", r.how.startsWith("rejected"), r.how);
  // The handshake's own deadline is 10 s (agent-client.ts); the check is that it is a
  // known, bounded wait rather than the life of the connection.
  check("and it fails within the handshake deadline", took < 12_000, `${took} ms`);
  check("the connection is reported as failed, not as connecting", client.state === "error", client.state);
  check("nothing is left waiting", pending() === 0, `pending=${pending()}`);
}

// Now let it answer, so the rest of the checks have an online client.
answerInfo = true;
let online = false;
try {
  await client.connect(url);
  online = true;
} catch (e) {
  check("the answering agent connects", false, (e as Error).message);
}
if (online) check("the answering agent connects", true);

// ── a plain request that is answered in time ──────────────────────────────
{
  const r = await outcome(client.call("test.answered"));
  check("an answer inside the deadline is delivered", r.how === "resolved", r.how);
}

// ── a plain request that is never answered ────────────────────────────────
{
  const started = Date.now();
  const r = await outcome(client.call("test.never"));
  const took = Date.now() - started;
  check("an unanswered request ends with an error", r.how.startsWith("rejected"), r.how);
  check("the error says which op and how long", /test\.never/.test(r.how) && /\d+(\.\d+)? s/.test(r.how), r.how);
  check("the error carries ETIMEDOUT", r.code === "ETIMEDOUT", String(r.code));
  check("it ends at the deadline, not later", took >= 400 && took < 1_500, `${took} ms`);
  check("the entry is taken out of pending", pending() === 0, `pending=${pending()}`);
  check("the agent was asked to stop the op", seen.some((s) => s.op === "cancel"), JSON.stringify(seen.slice(-3)));
}

// ── an op that names itself as slow ───────────────────────────────────────
{
  const started = Date.now();
  const r = await outcome(client.call("test.slow"));
  const took = Date.now() - started;
  check("a slow op gets the deadline it named (1.5 s), not the agent's", took >= 1_500 && took < 3_000, `${took} ms ${r.how}`);
}

// ── a stream: silence ends it, chatter does not ───────────────────────────
{
  streamMode = "finish";
  const chunks: number[] = [];
  const r = await outcome(client.callTracked("test.stream", {}, (c) => chunks.push((c as { n: number }).n)).promise);
  check("chatter keeps a stream alive past its deadline", chunks.length >= 3 && r.how === "resolved", `chunks=${chunks.length} ${r.how}`);
}
{
  streamMode = "goSilent"; // a chunk, then nothing — no reply either
  const chunks: number[] = [];
  const r = await outcome(client.callTracked("test.stream", {}, (c) => chunks.push((c as { n: number }).n)).promise);
  check("silence ends a stream that named a deadline", r.code === "ETIMEDOUT" && chunks.length > 0, `chunks=${chunks.length} ${r.how}`);
}

// ── a stream nobody set a deadline for is left alone ──────────────────────
{
  let late = "";
  const tracked = client.callTracked("test.quiet", {}, () => {}); // not in slowOps: no deadline at all
  void tracked.promise.catch(() => undefined);
  await Promise.race([tracked.promise, sleep(700)]);
  void (late = pending() > 0 ? "still waiting" : "gone");
  check("a stream with no deadline is not killed for being quiet", late === "still waiting", `${late}, pending=${pending()}`);
  void client.call("cancel", { target: tracked.id }).catch(() => undefined);
  await sleep(50);
}

// ── the liveness probe gives up on its own ────────────────────────────────
{
  answerPing = false;
  const started = Date.now();
  const alive = await AgentClient.probe(url);
  const took = Date.now() - started;
  check("a /ping that never answers is a no, in seconds", alive === false && took < 5_000, `${alive} after ${took} ms`);
  answerPing = true;
}

// ── the panel behind it: a refresh built on a doomed call runs again ──────
{
  let runs = 0;
  const refresh = singleFlight(async () => {
    runs++;
    await client.call("test.never").catch(() => undefined);
  });
  const first = refresh();
  const later = [refresh(), refresh()];
  await Promise.all([first, ...later]);
  check("a refresh whose call timed out finishes", true, `runs=${runs}`);
  check("and the next refresh starts a new run instead of waiting for ever", runs >= 2, `runs=${runs}`);
}

// ── an agent that answers /ping and turns the socket away (X-05) ───────────
{
  // What a busy agent looks like from the page: /ping answers, the upgrade is refused.
  let upgrades = 0;
  const busy = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/ping") return new Response("ok");
      upgrades++;
      return new Response("busy", { status: 409 });
    },
  });
  const busyUrl = `ws://127.0.0.1:${busy.port}/ws?token=t`;
  const other = new AgentClient(spec, () => {});
  const r = await outcome(other.connect(busyUrl));
  check("a busy agent is named: already serving another tab", r.how.includes("already serving another tab"), r.how);
  check("and the state is an error with that reason", other.state === "error" && other.lastError.includes("already serving another tab"), other.state);
  const tries = upgrades;
  await sleep(2_500); // the first retry would be at 1 s, the second at 3 s
  check("and the client stops asking", upgrades === tries && !(other as unknown as { wantOpen: boolean }).wantOpen, `${tries} attempt(s), ${upgrades - tries} more`);
  check("with no retry timer left", (other as unknown as { retryTimer: unknown }).retryTimer === null);

  // The same refusal on a retry — the agent was there, went away, came back busy.
  const again = new AgentClient(spec, () => {});
  const wasBefore = upgrades;
  void again.connect(busyUrl).catch(() => undefined);
  await sleep(1_500);
  check("a second client is refused the same way, once", upgrades === wasBefore + 1 && again.state === "error", `${upgrades - wasBefore} attempt(s)`);

  // An agent that is not listening at all is still worth retrying.
  const gone = new AgentClient(spec, () => {});
  const goneUrl = `ws://127.0.0.1:${busy.port}/ws?token=t`;
  busy.stop(true);
  void gone.connect(goneUrl).catch(() => undefined);
  await sleep(1_500);
  check("a port nobody listens on is retried, not given up on", (gone as unknown as { wantOpen: boolean }).wantOpen && gone.state !== "error", gone.state);
  gone.disconnect();
}

// ── a disconnect the user asked for is remembered (X-06) ──────────────────
{
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const mine = new AgentClient(spec, () => {});
  answerInfo = true;
  await mine.connect(url);
  check("a connect is remembered and will be repeated on load", mine.autoConnectUrl() === url && mine.savedUrl() === url);

  // The link breaks: the agent goes away. That is not the user's doing.
  mine.disconnect();
  check("losing the link does not stop the automatic connection", mine.autoConnectUrl() === url);

  await mine.connect(url);
  mine.disconnectByUser();
  check("a disconnect the user asked for stops it", mine.autoConnectUrl() === "" && mine.state === "offline");
  check("and the URL stays for the connect dialog", mine.savedUrl() === url);

  await mine.connect(url);
  check("connecting again takes it back", mine.autoConnectUrl() === url);
  mine.disconnect();
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

client.disconnect();
server.stop(true);

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  for (const f of failed) console.log(`  FAIL  ${f.name}`);
  console.log(`\n${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`${results.length} checks passed: an unanswered request ends, and the panel behind it keeps going`);
