/** Browser-side client for the local agent.
 *
 *  One WebSocket to ws://127.0.0.1:<port>/ws?token=… . Loopback is treated as a
 *  potentially-trustworthy origin, so this works from an https:// page in
 *  Chromium and Firefox; WebKit refuses it, which is what the capability badge
 *  reports (see caps.ts).
 *
 *  The URL carries the token and is kept in localStorage. That is deliberate
 *  and safe only because the agent also checks the Origin header — a token
 *  readable by this origin is useless to any other one.
 */
import type { AgentInfo, Push, Req, Res } from "../../agent/protocol.ts";

const URL_KEY = "enc-agent-url";

/** Does this text look like an agent URL, rather than whatever else happens to
 *  be on the clipboard?
 *
 *  Deliberately narrow. It gates two conveniences — prefilling the connect
 *  dialog and connecting straight from a paste — and both act on data the page
 *  did not ask a human about, so the shape has to be the agent's own and
 *  nothing else: a loopback host, the /ws path, a token.
 *
 *  Loopback-only is not a restriction invented here. The agent binds 127.0.0.1
 *  and the page's own connect-src permits nothing else, so a remote ws:// would
 *  be blocked a moment later anyway — better not to offer it at all. */
const AGENT_URL = /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/ws\?(?:[^\s]*&)?token=[^\s&]+$/;

export const isAgentUrl = (text: string): boolean => AGENT_URL.test(text.trim());

const UNREACHABLE = "cannot reach the agent";

/** Ports this page was refused a connection to, by its own policy.
 *
 *  connect-src pins the agent's port (server.ts: AGENT_PORTS), so an agent
 *  started on some other port is refused by the browser before a packet leaves
 *  — and that is indistinguishable from nothing listening: the same error
 *  event, the same close, no status code anywhere. The violation report is the
 *  only thing that separates them, and without it the user is sent off to debug
 *  an agent that is running perfectly well. */
const blockedPorts = new Set<string>();

// Guarded because isAgentUrl() above is also imported by the smoke tests,
// which run in Bun — there is no document there to listen on.
if (typeof document !== "undefined") {
  document.addEventListener("securitypolicyviolation", (e) => {
    if (!(e.effectiveDirective || e.violatedDirective).startsWith("connect-src")) return;
    try {
      blockedPorts.add(new global.URL(e.blockedURI).port);
    } catch {
      /* blockedURI is not always a URL — it can be "self", "inline", a bare scheme */
    }
  });
}

/** Why the last attempt did not connect, as far as the page can tell. */
function unreachableReason(url: string): string {
  let port: string;
  try {
    port = new global.URL(url).port;
  } catch {
    return UNREACHABLE;
  }
  if (!blockedPorts.has(port)) return UNREACHABLE;
  return `port ${port || "(default)"} is blocked by this page's security policy — the server allows only the agent's own port`;
}

export type AgentState = "offline" | "connecting" | "online" | "error";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onChunk?: (c: unknown) => void;
}

export class AgentClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(data: unknown) => void>>();
  private nextId = 1;
  private url = "";
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while a reconnect is wanted; cleared by an explicit disconnect(). */
  private wantOpen = false;

  state: AgentState = "offline";
  info: AgentInfo | null = null;
  lastError = "";

  constructor(private readonly onState: () => void) {}

  /** The last URL the user connected with, for prefilling the connect dialog. */
  savedUrl(): string {
    try {
      return localStorage.getItem(URL_KEY) ?? "";
    } catch {
      return "";
    }
  }

  /** Is an agent listening at all? Distinguishes "not running" from "bad token"
   *  so the badge can say something useful instead of just "failed". */
  static async probe(wsUrl: string): Promise<boolean> {
    try {
      const u = new global.URL(wsUrl);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      u.pathname = "/ping";
      u.search = "";
      const r = await fetch(u.toString(), { mode: "cors" });
      return r.ok;
    } catch {
      return false;
    }
  }

  async connect(url: string): Promise<AgentInfo> {
    this.disconnect();
    this.url = url.trim();
    this.wantOpen = true;
    try {
      localStorage.setItem(URL_KEY, this.url);
    } catch {
      /* private mode — the session still works, it just will not be remembered */
    }
    return this.open();
  }

  private open(): Promise<AgentInfo> {
    this.setState("connecting");
    return new Promise<AgentInfo>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        // Firefox throws here for a policy refusal; Chromium only fires "error".
        const blocked = unreachableReason(this.url);
        this.fail(blocked !== UNREACHABLE ? blocked : e instanceof Error ? e.message : "bad agent URL");
        return reject(new Error(this.lastError));
      }
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.retry = 0;
        this.call<AgentInfo>("agent.info").then(
          (info) => {
            this.info = info;
            this.setState("online");
            resolve(info);
          },
          (e: Error) => {
            this.fail(e.message);
            reject(e);
          },
        );
      });

      ws.addEventListener("message", (ev) => this.receive(String(ev.data)));

      ws.addEventListener("close", () => {
        this.ws = null;
        // Reject everything in flight; a half-applied UI is worse than an error.
        for (const [, p] of this.pending) p.reject(new Error("agent disconnected"));
        this.pending.clear();
        if (this.state === "online") this.setState("offline");
        // The violation report can land after "error" did, so the reason is
        // settled here, once, rather than in whichever handler ran first.
        if (this.lastError === "" || this.lastError === UNREACHABLE) this.lastError = unreachableReason(this.url);
        if (this.wantOpen) this.scheduleRetry();
        reject(new Error(this.lastError || "agent connection closed"));
      });

      // "error" carries no detail in browsers; the close handler reports it.
      ws.addEventListener("error", () => {
        if (this.state === "connecting") this.lastError = unreachableReason(this.url);
      });
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
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
      p.onChunk?.(frame.chunk);
      return;
    }
    this.pending.delete(frame.id);
    if (frame.ok) p.resolve(frame.data);
    else p.reject(Object.assign(new Error(frame.error), { code: frame.code }));
  }

  call<T>(op: string, params: Record<string, unknown> = {}, onChunk?: (c: unknown) => void): Promise<T> {
    return this.callTracked<T>(op, params, onChunk).promise;
  }

  /** Same as `call`, but exposes the request id so the caller can supersede it
   *  with the `cancel` op — search-as-you-type needs exactly that. */
  callTracked<T>(
    op: string,
    params: Record<string, unknown> = {},
    onChunk?: (c: unknown) => void,
  ): { id: number; promise: Promise<T> } {
    const ws = this.ws;
    const id = this.nextId++;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return { id, promise: Promise.reject(new Error("agent is not connected")) };
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onChunk });
      ws.send(JSON.stringify({ id, op, ...params } satisfies Req));
    });
    return { id, promise };
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
