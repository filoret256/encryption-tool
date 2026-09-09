/** Service worker: offline app shell.
 *
 *  Scope notes that matter here:
 *   - the crypto tabs run on WebCrypto in the page, so they need no network at
 *     all; the /helm/* and /ansible/* endpoints remain for API clients and,
 *     being POST, are never cached;
 *   - the code tab talks to the local agent on 127.0.0.1, a different origin.
 *     Cross-origin requests are passed straight through — caching or delaying
 *     them would break the editor for no benefit;
 *   - assets have fixed names (no content hashing, so the compiled binary can
 *     embed them), which is why they are served stale-while-revalidate: a user
 *     may run one build behind for a single load, then self-heal.
 *
 *  Bump VERSION when the shell changes in a way old clients must not mix with.
 */

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

const VERSION = "v1";
const CACHE = `enc-tool-${VERSION}`;

const SHELL = [
  "/",
  "/public/main.js",
  "/public/main.css",
  "/public/code.js",
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
  if (url.pathname.startsWith("/public/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(staleWhileRevalidate(req));
  }
});

/** The page itself: fresh when possible, the cached shell when offline. */
async function networkFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) void cache.put("/", res.clone());
    return res;
  } catch {
    return (await cache.match("/")) ?? new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

/** Assets: serve what we have immediately, refresh it in the background. */
async function staleWhileRevalidate(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
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
