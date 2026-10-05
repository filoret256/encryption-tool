/** Browser-side client for a local agent — the code-agent or the kafka-agent.
 *
 *  One WebSocket to ws://127.0.0.1:<port>/ws?token=… . Loopback is treated as a
 *  potentially-trustworthy origin, so this works from an https:// page in
 *  Chromium and Firefox; WebKit refuses, which is what the capability badge
 *  reports (see code/caps.ts).
 *
 *  The two agents speak the same frames and differ in a name, a port range and
 *  what their first reply looks like, so everything else — reconnecting with
 *  backoff, giving up when asking again will not help, explaining a refusal
 *  the browser will not explain — is here once, and each agent is a small
 *  `AgentSpec`.
 *
 *  The URL carries the token and is kept in localStorage. That is deliberate
 *  and safe only because the agent also checks the Origin header — a token
 *  readable by this origin is useless to any other one.
 */
import type { Push, Req, Res } from "../code-agent/protocol.ts";

/** What makes one agent different from the other. */
export interface AgentSpec<Info> {
  /** "code-agent", "kafka-agent": how every message here refers to it. */
  name: string;
  /** localStorage key of the last URL used. */
  urlKey: string;
  /** The op whose reply is the agent's own description. */
  infoOp: string;
  /** The <meta name> the server fills with the ports connect-src permits. */
  portsMeta: string;
  /** The range the agent binds by default (src/ports.ts): the meaning of "this URL
   *  is a URL of this agent" when the page has no meta tag to read. */
  defaultPorts: readonly [number, number];
  /** Ops whose concurrent duplicates are answered once. Only reads with no side
   *  effect and no streamed chunks belong here: two callers share one reply
   *  object, so an op that changes anything — or whose caller mutates what comes
   *  back — must not be on the list. */
  sharedReads?: ReadonlySet<string>;
  /** How long an ordinary request may go unanswered before the client gives up on
   *  it, in milliseconds. Defaults to DEFAULT_DEADLINE_MS. */
  deadlineMs?: number;
  /** Ops that are known to take longer than that, by how long. A local agent answers in
   *  milliseconds; the exceptions are the ops that walk a whole repository or wait on a
   *  network, and each says there how long it may take. A streamed op named here gets
   *  that long *between* frames rather than in total — see callTracked. */
  slowOps?: Readonly<Record<string, number>>;
  /** Refuse a reply that describes some other agent: the reason, or null. */
  check(info: Info): string | null;
}

/** Attempts before the client stops trying and says why.
 *
 *  With the backoff below (1s, 2s, 4s, 8s, 15s…) this is a little over a
 *  minute of retrying — long enough to ride out an agent restart or a laptop
 *  waking up, short enough that a URL which will never work stops pretending
 *  it might. */
const GIVE_UP_AFTER = 8;

/** How long a request may go unanswered before the client gives up on it.
 *
 *  A local agent answers in milliseconds, so a request that has heard nothing for half a
 *  minute is one that will not be answered: a frame the page never got, or an op the agent
 *  never finished. Without this the promise stayed pending for the life of the connection
 *  and everything awaiting it stayed with it — above all the panels' refresh, which runs
 *  one at a time (see code/singleflight.ts), so a single lost frame stopped a panel from
 *  ever updating again. The ops that legitimately take longer name themselves in
 *  AgentSpec.slowOps. */
const DEFAULT_DEADLINE_MS = 30_000;

/** What a liveness probe may take. It exists to tell "nothing is listening" from
 *  "something refused us", and either answer arrives at once or not at all. */
const PROBE_DEADLINE_MS = 3_000;

/** What the handshake may take. An agent that is there answers its info op at once, so a
 *  silent one is reported in seconds rather than after the deadline of an ordinary call:
 *  waiting half a minute at "connecting…" tells nobody anything. */
const HANDSHAKE_DEADLINE_MS = 10_000;

/** Ports a violation report says this page was actually refused.
 *
 *  Kept alongside the meta list rather than replaced by it, because the two
 *  fail in different directions: the list can be stale (a cached shell), and
 *  the report can be late — it is delivered in a queued task, while Chromium
 *  throws from the WebSocket constructor synchronously, so the first attempt is
 *  already over by the time it lands. Either one naming the port is enough. */
const blockedPorts = new Set<string>();

// Guarded because the URL matchers below are also imported by the smoke tests,
// which run in Bun — there is no document there to listen on.
if (typeof document !== "undefined") {
  document.addEventListener("securitypolicyviolation", (e) => {
    if (!(e.effectiveDirective || e.violatedDirective).startsWith("connect-src")) return;
    try {
      blockedPorts.add(new URL(e.blockedURI).port);
    } catch {
      /* blockedURI is not always a URL — it can be "self", "inline", a bare scheme */
    }
  });
}

/** The loopback ports this page is allowed to open a connection to for an agent.
 *
 *  connect-src pins them (server.ts), so an agent started on some other port is
 *  refused by the browser before a packet leaves — and that is indistinguishable
 *  from nothing listening: the same error event, the same close, no status code
 *  anywhere. Without a reason the user is sent off to debug an agent that is
 *  running perfectly well.
 *
 *  A page cannot read its own policy, so the server states the list in the
 *  shell (server.ts: PORTS_SLOT). Empty when the shell came from somewhere that
 *  did not fill it in — a file:// copy, or a service-worker cache older than
 *  this — and empty is read as "no opinion", never as "nothing allowed". */
function metaPorts(meta: string): string[] {
  if (typeof document === "undefined") return [];
  return (document.querySelector<HTMLMetaElement>(`meta[name="${meta}"]`)?.content ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => /^[0-9]{1,5}$/.test(p));
}

/** "5001-5010" when the allowed ports are one run, "5001, 7000" when they are not. */
function portsText(ports: string[]): string {
  const n = ports.map(Number).sort((a, b) => a - b);
  const oneRun = n.length > 1 && n.every((p, i) => i === 0 || p === n[i - 1] + 1);
  return oneRun ? `${n[0]}-${n[n.length - 1]}` : n.join(", ");
}

const LOOPBACK_URL = /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?\/ws\?(?:[^\s]*&)?token=[^\s&]+$/;

/** Does this text look like this agent's URL, rather than whatever else happens
 *  to be on the clipboard?
 *
 *  Deliberately narrow. It gates two conveniences — prefilling the connect
 *  dialog and connecting straight from a paste — and both act on data the page
 *  did not ask a human about, so the shape has to be the agent's own and
 *  nothing else: a loopback host, the /ws path, a token — and, when there is a
 *  port, one of *this* agent's. The last is what keeps a kafka-agent URL pasted
 *  on the code tab from connecting the code tab to the wrong program.
 *
 *  Loopback-only is not a restriction invented here. The agents bind 127.0.0.1
 *  and the page's own connect-src permits nothing else, so a remote ws:// would
 *  be blocked a moment later anyway — better not to offer it at all. */
export function matchAgentUrl(spec: AgentSpec<unknown>, text: string): boolean {
  const m = LOOPBACK_URL.exec(text.trim());
  if (!m) return false;
  if (m[1] === undefined) return true;
  const port = Number(m[1]);
  const listed = metaPorts(spec.portsMeta);
  return listed.length ? listed.includes(String(port)) : port >= spec.defaultPorts[0] && port <= spec.defaultPorts[1];
}

export type AgentState = "offline" | "connecting" | "online" | "error";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onChunk?: (c: unknown) => void;
  /** The op, for the sentence a deadline writes. */
  op: string;
  /** How long silence may last: the whole request for a plain call, and between two
   *  frames for a stream. Zero means no deadline at all. */
  deadlineMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class AgentClient<Info> {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  private nextId = 1;
  /** In-flight pure reads, keyed by op and params — see AgentSpec.sharedReads. */
  private inFlight = new Map<string, Promise<unknown>>();
  private url = "";
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while a reconnect is wanted; cleared by an explicit disconnect(). */
  private wantOpen = false;

  state: AgentState = "offline";
  info: Info | null = null;
  lastError = "";

  constructor(
    protected readonly spec: AgentSpec<Info>,
    private readonly onState: () => void,
  ) {}

  private get unreachable(): string {
    return `cannot reach the ${this.spec.name}`;
  }

  /** The last URL the user connected with, for prefilling the connect dialog. */
  savedUrl(): string {
    try {
      return localStorage.getItem(this.spec.urlKey) ?? "";
    } catch {
      return "";
    }
  }

  /** Where the key that says "the user left" is kept: beside the URL, which stays for the
   *  dialog to prefill. */
  private get leftKey(): string {
    return `${this.spec.urlKey}:left`;
  }

  /** The URL a page that has just loaded should connect to by itself, or "" for none.
   *
   *  The last URL is remembered so that an agent that went away (a restart, a laptop that
   *  slept) is found again after a reload. A person who chose `disconnect` meant something
   *  else: the next load should not undo it (X-06). Losing the link is remembered; leaving
   *  is not the same thing, and only leaving stops the automatic connection. */
  autoConnectUrl(): string {
    try {
      if (localStorage.getItem(this.leftKey) === "1") return "";
    } catch {
      /* no storage: nothing says the user left */
    }
    return this.savedUrl();
  }

  /** `disconnect` for a person who asked for it: the page will not connect again by itself
   *  after a reload until they connect (see autoConnectUrl). The URL stays for the dialog. */
  disconnectByUser(): void {
    try {
      localStorage.setItem(this.leftKey, "1");
    } catch {
      /* private mode — the disconnect holds for this page only */
    }
    this.disconnect();
  }

  /** Is an agent listening at all? Distinguishes "not running" from "bad token"
   *  so the badge can say something useful instead of just "failed". */
  static async probe(wsUrl: string, deadlineMs = PROBE_DEADLINE_MS): Promise<boolean> {
    // A fetch with no signal waits as long as the other end keeps the connection open.
    // This one asks a question that has an answer or none at all, so time is the answer.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deadlineMs);
    try {
      const u = new URL(wsUrl);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      u.pathname = "/ping";
      u.search = "";
      const r = await fetch(u.toString(), { mode: "cors", signal: abort.signal });
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Why the last attempt did not connect, as far as the page can tell. */
  private unreachableReason(url: string): string {
    let port: string;
    try {
      const u = new URL(url);
      // An agent URL may omit the port, in which case the scheme's default is the
      // one the browser would have dialled — and the one the policy judges.
      port = u.port || (u.protocol === "wss:" || u.protocol === "https:" ? "443" : "80");
    } catch {
      return this.unreachable;
    }
    const allowed = metaPorts(this.spec.portsMeta);
    const refused = blockedPorts.has(port);
    const outside = allowed.length > 0 && !allowed.includes(port);
    if (!refused && !outside) return this.unreachable;
    const name = this.spec.name;
    return allowed.length
      ? `port ${port} is blocked by this page's security policy — it allows ${portsText(allowed)}. Start the ${name} without --port and it takes a free port in that range.`
      : `port ${port} is blocked by this page's security policy — the server allows only the ${name}'s own ports`;
  }

  async connect(url: string): Promise<Info> {
    this.disconnect();
    this.url = url.trim();
    this.wantOpen = true;
    try {
      localStorage.setItem(this.spec.urlKey, this.url);
      localStorage.removeItem(this.leftKey);
    } catch {
      /* private mode — the session still works, it just will not be remembered */
    }
    try {
      return await this.open();
    } catch (e) {
      // A refused WebSocket carries no reason a page is allowed to read, so a
      // busy agent and a stopped one look identical here. /ping tells them
      // apart: it answers only if the agent is up and this origin is welcome,
      // which leaves exactly one explanation for the socket being turned away.
      if (this.lastError === this.unreachable && (await AgentClient.probe(this.url))) this.failBusy();
      throw e instanceof Error && !this.lastError ? e : new Error(this.lastError);
    }
  }

  private open(): Promise<Info> {
    this.setState("connecting");
    return new Promise<Info>((resolve, reject) => {
      let ws: WebSocket;
      let opened = false;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        // Firefox throws here for a policy refusal; Chromium only fires "error".
        const blocked = this.unreachableReason(this.url);
        this.fail(blocked !== this.unreachable ? blocked : e instanceof Error ? e.message : `bad ${this.spec.name} URL`);
        return reject(new Error(this.lastError));
      }
      this.ws = ws;
      // A socket that was superseded owns nothing: connect() closes the old one and opens
      // a new one, and the old one's close lands afterwards. Without this, that close
      // cleared the *new* socket and rejected the requests the new one was carrying —
      // every request failing as "not connected" while the agent was answering normally.
      const mine = (): boolean => this.ws === ws;

      ws.addEventListener("open", () => {
        if (!mine()) return;
        opened = true;
        this.retry = 0;
        this.call<Info>(this.spec.infoOp, {}, undefined, HANDSHAKE_DEADLINE_MS).then(
          (info) => {
            // The wrong program on the right kind of port: a URL of the other agent.
            const wrong = this.spec.check(info);
            if (wrong) {
              this.wantOpen = false;
              ws.close();
              this.fail(wrong);
              return reject(new Error(wrong));
            }
            this.info = info;
            this.setState("online");
            resolve(info);
          },
          (e: Error) => {
            // An agent that does not know our info op is not the one we wanted.
            const message = /Unknown op/.test(e.message)
              ? `this is not the ${this.spec.name} — it does not answer ${this.spec.infoOp}. Paste the URL the ${this.spec.name} printed.`
              : e.message;
            this.wantOpen = false;
            ws.close();
            this.fail(message);
            reject(new Error(message));
          },
        );
      });

      ws.addEventListener("message", (ev) => {
        if (mine()) this.receive(String(ev.data));
      });

      ws.addEventListener("close", () => {
        // Only the socket the client is using may close the client: see `mine`.
        if (!mine()) {
          reject(new Error(`${this.spec.name} connection was replaced`));
          return;
        }
        this.ws = null;
        // Reject everything in flight; a half-applied UI is worse than an error.
        for (const [, p] of this.pending) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(new Error(`${this.spec.name} disconnected`));
        }
        this.pending.clear();
        if (this.state === "online") this.setState("offline");
        // The violation report can land after "error" did, so the reason is
        // settled here, once, rather than in whichever handler ran first.
        if (this.lastError === "" || this.lastError === this.unreachable) this.lastError = this.unreachableReason(this.url);
        if (this.wantOpen) {
          if (opened) this.scheduleRetry();
          else this.retryUnlessBusy();
        }
        reject(new Error(this.lastError || `${this.spec.name} connection closed`));
      });

      // "error" carries no detail in browsers; the close handler reports it.
      ws.addEventListener("error", () => {
        if (!mine()) return;
        if (this.state === "connecting") this.lastError = this.unreachableReason(this.url);
      });
    });
  }

  /** A socket that never opened: the agent is not there, or it is there and turned us away.
   *  /ping tells them apart, as in connect(): an agent that answers it and still refuses the
   *  socket is serving another tab (or the token is stale), and asking again every few
   *  seconds changes nothing. That is a final answer; only a silent port is worth retrying. */
  private retryUnlessBusy(): void {
    if (this.retryTimer) return;
    void AgentClient.probe(this.url).then((listening) => {
      // Superseded while the probe was out: a newer connect() or a disconnect owns the state.
      if (!this.wantOpen || this.ws !== null) return;
      if (listening) this.failBusy();
      else this.scheduleRetry();
    });
  }

  /** The agent answers, and will not take this socket: no more attempts, and the reason. */
  private failBusy(): void {
    this.wantOpen = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.fail(`the ${this.spec.name} is running but refused this connection — it is already serving another tab`);
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const name = this.spec.name;

    // Some failures are not going to get better by asking again. A token that
    // no longer matches, an origin the agent refuses, a port outside the
    // policy — the agent answers /ping perfectly well and turns the socket
    // away every time. Retrying those forever left the badge saying
    // "Connecting…" indefinitely and the row underneath advising the user to
    // start an agent that was already running.
    if (this.retry >= GIVE_UP_AFTER) {
      this.wantOpen = false;
      void AgentClient.probe(this.url).then((listening) => {
        this.fail(
          listening
            ? `the ${name} is running but keeps refusing this connection — the token in the URL is probably stale, or it is serving another tab. Connect again with the URL it printed.`
            : `${this.lastError || this.unreachable} — gave up after ${GIVE_UP_AFTER} attempts. Start the ${name} and connect again.`,
        );
      });
      return;
    }

    // 1s, 2s, 4s … capped at 15s — enough to survive an agent restart without
    // hammering a port nobody is listening on.
    const delay = Math.min(1000 * 2 ** this.retry++, 15000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wantOpen) void this.open().catch(() => {});
    }, delay);
  }

  private receive(raw: string): void {
    let frame: Res | Push | { id: number; chunk: unknown };
    try {
      frame = JSON.parse(raw) as Res | Push | { id: number; chunk: unknown };
    } catch {
      return;
    }
    if ("event" in frame) {
      for (const cb of this.listeners.get(frame.event) ?? []) cb(frame.data);
      return;
    }
    const p = this.pending.get(frame.id);
    if (!p) return;
    if ("chunk" in frame) {
      // Something is moving, so the deadline — for a stream, the one between frames —
      // starts again. A live view with nothing to show is silent for as long as it likes:
      // only an op that says how long it may be quiet has a deadline at all.
      this.arm(frame.id, p);
      p.onChunk?.(frame.chunk);
      return;
    }
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(frame.id);
    if (frame.ok) p.resolve(frame.data);
    else p.reject(Object.assign(new Error(frame.error), { code: frame.code }));
  }

  call<T>(op: string, params: Record<string, unknown> = {}, onChunk?: (c: unknown) => void, deadlineMs?: number): Promise<T> {
    // Two panels asking the same question in the same tick is one question.
    // Only while the first is still in flight: this is deduplication, not a
    // cache, so nothing here can serve a stale answer.
    if (!onChunk && this.spec.sharedReads?.has(op)) {
      const key = `${op} ${JSON.stringify(params)}`;
      const live = this.inFlight.get(key) as Promise<T> | undefined;
      if (live) return live;
      const promise = this.callTracked<T>(op, params, undefined, deadlineMs).promise;
      this.inFlight.set(key, promise);
      const done = (): void => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      };
      promise.then(done, done);
      return promise;
    }
    return this.callTracked<T>(op, params, onChunk, deadlineMs).promise;
  }

  /** Same as `call`, but exposes the request id so the caller can supersede it
   *  with the `cancel` op — search-as-you-type needs exactly that.
   *
   *  A request that hears nothing is given up on: the entry is taken out of `pending`, the
   *  agent is told to stop, and the caller gets an error naming the op and the seconds. A
   *  plain call is given AgentSpec.slowOps[op], or the agent's own deadline, or
   *  DEFAULT_DEADLINE_MS. A streamed call has no deadline unless the op is named in
   *  slowOps — then that is how long it may be *silent*: a topic with nothing new to show
   *  is not a fault, and a fetch that says nothing for five minutes is. */
  callTracked<T>(
    op: string,
    params: Record<string, unknown> = {},
    onChunk?: (c: unknown) => void,
    deadlineMs?: number,
  ): { id: number; promise: Promise<T> } {
    const ws = this.ws;
    const id = this.nextId++;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return { id, promise: Promise.reject(new Error(`${this.spec.name} is not connected`)) };
    }
    const named = this.spec.slowOps?.[op];
    const deadline = deadlineMs ?? named ?? (onChunk ? 0 : (this.spec.deadlineMs ?? DEFAULT_DEADLINE_MS));
    const promise = new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject, onChunk, op, deadlineMs: deadline };
      this.pending.set(id, entry);
      this.arm(id, entry);
      ws.send(JSON.stringify({ id, op, ...params } satisfies Req));
    });
    return { id, promise };
  }

  /** Start, or start again, the silence clock of one request. */
  private arm(id: number, p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    if (p.deadlineMs <= 0) return;
    p.timer = setTimeout(() => this.expire(id, p), p.deadlineMs);
  }

  /** Nothing was heard within the deadline. The entry goes, the agent is asked to stop —
   *  best effort, and the reply to that is dropped for having no waiter — and the caller
   *  is told in a sentence rather than left waiting for the life of the connection. */
  private expire(id: number, p: Pending): void {
    if (this.pending.get(id) !== p) return;
    this.pending.delete(id);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ id: this.nextId++, op: "cancel", target: id } satisfies Req));
    }
    const seconds = p.deadlineMs >= 10_000 ? `${Math.round(p.deadlineMs / 1000)} s` : `${(p.deadlineMs / 1000).toFixed(1)} s`;
    const why = p.onChunk
      ? `${this.spec.name} sent nothing for ${seconds} while running ${p.op} — stopped waiting for it`
      : `${this.spec.name} did not answer ${p.op} within ${seconds}`;
    p.reject(Object.assign(new Error(why), { code: "ETIMEDOUT" }));
  }

  on(event: string, cb: (data: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  disconnect(): void {
    this.wantOpen = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close();
    this.ws = null;
    this.info = null;
    this.setState("offline");
  }

  private fail(message: string): void {
    this.lastError = message;
    this.setState("error");
  }

  private setState(s: AgentState): void {
    if (this.state === s) return;
    this.state = s;
    if (s === "online") this.lastError = "";
    this.onState();
  }
}
