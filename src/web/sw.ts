/** Service worker: offline app shell.
 *
 *  Scope notes that matter here:
 *   - the crypto tabs run on WebCrypto in the page, so they need no network at
 *     all; the /helm/* and /ansible/* endpoints remain for API clients and,
 *     being POST, are never cached;
 *   - the code tab talks to the local agent on 127.0.0.1, a different origin.
 *     Cross-origin requests are passed straight through — caching or delaying
 *     them would break the editor for no benefit;
 *   - the code tab talks to the local agent on 127.0.0.1, a different origin.
 *
 *  Assets have fixed names — no content hashing, because the compiled binary
 *  embeds them by path. That used to mean serving them stale-while-revalidate
 *  and letting a client run one build behind for a load. It is not a workable
 *  trade: the shell is network-first, so a returning user got the *new*
 *  index.html driving the *old* bundle, and since sw.js itself had not changed
 *  there was no new worker and therefore no update prompt either — the mismatch
 *  was completely silent. Scripts and styles are now network-first like the
 *  shell, with the cache as the offline fallback, so what runs is never older
 *  than the page that asked for it.
 *
 *  The cache is keyed by the app version, so a release drops the previous one
 *  and the worker itself changes, which is what raises the update bar.
 */
import { VERSION } from "../version.ts";

/** The service-worker globals, declared locally: pulling in lib.webworker would
 *  collide with the DOM lib this project compiles against. */
interface ServiceWorkerScope {
  addEventListener(type: "install" | "activate", cb: (e: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", cb: (e: FetchEventLike) => void): void;
  addEventListener(type: "message", cb: (e: { data: unknown }) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: { origin: string };
}
interface ExtendableEventLike {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}

const sw = self as unknown as ServiceWorkerScope;

const CACHE = `enc-tool-v${VERSION}`;

// What a visitor needs before they have asked for anything. code.js is not on
// this list on purpose: it is the largest asset in the app and it belongs to
// one of three tabs, so precaching it made everyone who came to decrypt a
// string pay for the editor. It is cached the same way as everything else the
// moment the code tab is opened — see the fetch handler below.
const SHELL = [
  "/",
  "/public/main.js",
  "/public/main.css",
  "/manifest.webmanifest",
  "/public/icon-192.png",
  "/public/icon-512.png",
];

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Added one at a time: addAll rejects the whole install if any single
      // entry 404s, which would leave the app with no worker at all.
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // crypto POSTs always go to the network
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return; // the local agent lives elsewhere

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
    return;
  }
  // Code and styles decide how the app behaves, so they follow the shell: fresh
  // when the network allows, cached only when it does not.
  if (/\.(js|css)$/.test(url.pathname)) {
    event.respondWith(networkFirst(req));
    return;
  }
  // Icons and the manifest can lag a load without anyone noticing.
  if (url.pathname.startsWith("/public/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(staleWhileRevalidate(req));
  }
});

/** Assets now travel compressed, so they carry `Vary: accept-encoding`, and a
 *  lookup that honours Vary can miss a body the cache is holding — the stored
 *  request and the new one would have to agree header for header. Everything
 *  here is keyed by URL and kept in exactly one copy, so the header plays no
 *  part in finding it. */
const MATCH: CacheQueryOptions = { ignoreVary: true };

/** Fresh when possible, the cached copy when offline.
 *
 *  Navigations are stored under "/" so any route falls back to the one shell we
 *  keep; everything else is keyed by its own URL. */
async function networkFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const key = req.mode === "navigate" ? "/" : req;
  try {
    const res = await fetch(req);
    if (res.ok) void cache.put(key, res.clone());
    return res;
  } catch {
    return (await cache.match(key, MATCH)) ?? new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

/** Assets: serve what we have immediately, refresh it in the background. */
async function staleWhileRevalidate(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, MATCH);
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok) void cache.put(req, res.clone());
      return res;
    })
    .catch(() => undefined);
  return cached ?? (await fresh) ?? new Response("Offline", { status: 503, statusText: "Offline" });
}

// The page asks for the swap rather than the worker forcing it, so assets never
// change underneath a session the user is in the middle of.
sw.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") void sw.skipWaiting();
});
