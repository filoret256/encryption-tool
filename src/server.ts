/** Bun HTTP server — replaces the Flask app. Stateless crypto endpoints. */
import { helm, ansible } from "./crypto/index.ts";

// Static assets are imported with the `file` loader so that `bun build --compile`
// embeds them into the standalone binary — the runtime image then needs nothing
// but the executable. In dev they resolve to the on-disk paths (run `bun run
// build` first to produce public/).
import indexHtml from "./web/index.html" with { type: "file" };
import mainJs from "../public/main.js" with { type: "file" };
import mainCss from "../public/main.css" with { type: "file" };

const MAX_BODY = 2 * 1024 * 1024; // 2 MB, matches Flask MAX_CONTENT_LENGTH
const PORT = Number(process.env.PORT ?? 5000);

// `server --health` performs a request against the running server and exits
// 0/1 — used by the Docker HEALTHCHECK so the minimal image needs no curl.
if (process.argv.includes("--health")) {
  try {
    const r = await fetch(`http://localhost:${PORT}/`);
    process.exit(r.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const ok = (result: unknown) => json({ result });
const fail = (error: string, status: number) => json({ error }, status);

type CryptoFn = (text: string, password: string) => string;

/** Shared handler for the 4 crypto endpoints — mirrors validate_request + api_response. */
async function crypto(req: Request, fn: CryptoFn): Promise<Response> {
  let data: Record<string, unknown>;
  try {
    data = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("Invalid JSON body", 400);
  }
  for (const field of ["text", "password"] as const) {
    if (!data?.[field]) {
      return fail(`${field[0].toUpperCase()}${field.slice(1)} is required`, 400);
    }
  }
  try {
    return ok(fn(String(data.text), String(data.password)));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
}

const ROUTES: Record<string, CryptoFn> = {
  "/helm/encrypt": helm.encrypt,
  "/helm/decrypt": helm.decrypt,
  "/ansible/encrypt": ansible.encrypt,
  "/ansible/decrypt": ansible.decrypt,
};

const STATIC: Record<string, { path: string; type: string }> = {
  "/public/main.js": { path: mainJs, type: "text/javascript" },
  "/public/main.css": { path: mainCss, type: "text/css" },
};

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // bind all interfaces so the container is reachable
  maxRequestBodySize: MAX_BODY,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (req.method === "GET" && pathname === "/") {
      return new Response(Bun.file(indexHtml), { headers: { "content-type": "text/html" } });
    }

    if (req.method === "POST" && pathname in ROUTES) {
      return crypto(req, ROUTES[pathname]);
    }

    if (req.method === "GET" && pathname in STATIC) {
      const asset = STATIC[pathname];
      return new Response(Bun.file(asset.path), { headers: { "content-type": asset.type } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`encryption-tool listening on http://localhost:${server.port}`);
