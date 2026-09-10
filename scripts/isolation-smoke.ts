/** Multi-user isolation: `bun run isolation:smoke`.
 *
 *  The question this answers is whether one person's data can reach another
 *  when many use the app at once. The architecture is meant to make that
 *  impossible rather than unlikely:
 *
 *    - the crypto tabs run WebCrypto in the page, so plaintext and passwords
 *      never leave the browser at all;
 *    - the server keeps no per-request state and no session, so there is
 *      nothing for two requests to share;
 *    - the code tab talks only to an agent on the user's own loopback
 *      interface, jailed to one folder.
 *
 *  Each of those is checked here rather than asserted.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { iter } from "../src/agent/proc.ts";
import { git, startAgent, type Harness } from "./harness.ts";
import { ansible, helm } from "../src/crypto/index.ts";
import type { FileRead, SearchSummary } from "../src/agent/protocol.ts";
import { esc } from "../src/web/code/ui.ts";

const SERVER_PORT = 5091;
const AGENT_A = 5089;
const AGENT_B = 5088;
const USERS = 60;

const results: { name: string; ok: boolean; note: string }[] = [];
function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

const server = Bun.spawn(["bun", "src/server.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(SERVER_PORT) },
  stdout: "pipe",
  stderr: "inherit",
  stdin: "ignore",
});
{
  const dec = new TextDecoder();
  let banner = "";
  for await (const bytes of iter(server.stdout as ReadableStream<Uint8Array>)) {
    banner += dec.decode(bytes, { stream: true });
    if (banner.includes("listening")) break;
  }
}
const base = `http://127.0.0.1:${SERVER_PORT}`;

let agentA: Harness | null = null;
let agentB: Harness | null = null;
const rootA = await mkdtemp(join(tmpdir(), "enc-userA-"));
const rootB = await mkdtemp(join(tmpdir(), "enc-userB-"));

try {
  // ── 1. concurrent API users must never see each other's data ──
  // The endpoints stay for API clients, so hammer them the way many people at
  // once would and check every answer belongs to the request that asked.
  const post = async (path: string, body: unknown): Promise<{ result?: string; error?: string }> =>
    (await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json())) as { result?: string; error?: string };

  for (const scheme of ["ansible", "helm"] as const) {
    const users = Array.from({ length: USERS }, (_, i) => ({
      text: `user-${i} secret payload ${"x".repeat(i)}`,
      password: `password-of-user-${i}`,
    }));

    const ciphertexts = await Promise.all(users.map((u) => post(`/${scheme}/encrypt`, u)));
    const decrypted = await Promise.all(
      ciphertexts.map((c, i) => post(`/${scheme}/decrypt`, { text: c.result, password: users[i].password })),
    );
    const roundTrip = decrypted.every((d, i) => d.result === users[i].text);

    // And a ciphertext must not open with someone else's password.
    const crossed = await Promise.all(
      ciphertexts.map((c, i) => post(`/${scheme}/decrypt`, { text: c.result, password: users[(i + 1) % USERS].password })),
    );
    const leaked = crossed.filter((d, i) => d.result !== undefined && d.result === users[i].text);

    check(
      `${scheme}: ${USERS} concurrent users get only their own data`,
      roundTrip && leaked.length === 0,
      `${USERS} round trips correct, ${leaked.length} leaked under a foreign password`,
    );
  }

  // ── 2. no session, no cookie, nothing cacheable by a shared proxy ──
  const encRes = await fetch(`${base}/ansible/encrypt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "x", password: "y" }),
  });
  await encRes.text();
  const shellRes = await fetch(`${base}/`);
  await shellRes.text();
  const identifying = ["set-cookie", "etag", "last-modified", "x-request-id"].filter(
    (h) => encRes.headers.get(h) !== null,
  );
  check(
    "crypto responses carry no session or cache identity",
    identifying.length === 0 && !(encRes.headers.get("cache-control") ?? "").includes("public"),
    identifying.length ? `unexpected: ${identifying.join(", ")}` : "no set-cookie, no etag, not publicly cacheable",
  );
  check("the shell sets no cookie either", shellRes.headers.get("set-cookie") === null, "static, identical for everyone");

  // The agent's URL and token live in localStorage, and that agent is a
  // filesystem bridge — so script injection on this origin would be script
  // injection into someone's working directory. The policy is what stops a
  // stolen token from being usable by injected code.
  const csp = shellRes.headers.get("content-security-policy") ?? "";
  const required = [
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ];
  const missingCsp = required.filter((d) => !csp.includes(d));
  check(
    "a strict CSP is served, with no inline or remote script allowed",
    missingCsp.length === 0 && !/script-src[^;]*unsafe-inline/.test(csp) && !/script-src[^;]*https?:/.test(csp),
    missingCsp.length ? `missing ${missingCsp.join(", ")}` : "script-src is 'self' only",
  );
  const connectSrc = (csp.split(";").find((d) => d.trim().startsWith("connect-src")) ?? "").trim();
  const sources = connectSrc.split(" ").filter(Boolean).slice(1);
  check(
    "the policy still permits the loopback agent",
    connectSrc.includes("ws://127.0.0.1:5001") && connectSrc.includes("http://127.0.0.1:5001"),
    "connect-src allows ws:// and http:// on the agent's default port",
  );
  // The point of pinning it: injected script gets a channel to the agent, not
  // to every other thing the user happens to be running on loopback.
  const unpinned = sources.filter((src) => src !== "'self'" && !/:[0-9]{1,5}$/.test(src));
  check(
    "and to nothing else on loopback",
    sources.length > 1 && unpinned.length === 0,
    unpinned.length ? `not pinned to a port: ${unpinned.join(", ")}` : `${sources.length - 1} sources, every one a fixed port`,
  );

  // style-src used to carry 'unsafe-inline' for CodeMirror's runtime <style>.
  // A nonce replaces it, and a nonce is worth something only if it is fresh
  // per response and actually matches the shell it arrived with.
  const nonceOf = (policy: string): string => new RegExp("style-src[^;]*'nonce-([^']+)'").exec(policy)?.[1] ?? "";
  const shellA = await fetch(`${base}/`);
  const htmlA = await shellA.text();
  const nonceA = nonceOf(shellA.headers.get("content-security-policy") ?? "");
  const shellB = await fetch(`${base}/`);
  await shellB.text();
  const nonceB = nonceOf(shellB.headers.get("content-security-policy") ?? "");
  check(
    "no directive falls back to 'unsafe-inline'",
    !csp.includes("unsafe-inline"),
    csp.includes("unsafe-inline") ? "still present" : "style-src is 'self' plus a nonce",
  );
  check(
    "the shell carries the nonce it was served with, and a fresh one each time",
    nonceA.length >= 16 && htmlA.includes(`content="${nonceA}"`) && nonceA !== nonceB,
    nonceA.length >= 16 ? `${nonceA.length}-char nonce, matched in the page, and not reused` : "no nonce in style-src",
  );

  const hardening = [
    "x-content-type-options",
    "referrer-policy",
    "cross-origin-opener-policy",
    "x-frame-options",
    "cross-origin-resource-policy",
    "permissions-policy",
    "strict-transport-security",
  ];
  const missingHeaders = hardening.filter((h) => shellRes.headers.get(h) === null);
  check("hardening headers are present", missingHeaders.length === 0, missingHeaders.length ? `missing ${missingHeaders.join(", ")}` : hardening.join(", "));

  // Every branch of the request handler, including the ones that are easy to
  // forget: the two 404s and a rejected request body. The headers are stamped
  // on the way out of `fetch` precisely so this list cannot drift, and this is
  // the check that says so — a route added without them fails here.
  const policy = ["content-security-policy", ...hardening];
  const fresh: [string, Response][] = [
    ["GET /public/main.js", await fetch(`${base}/public/main.js`)],
    ["GET /manifest.webmanifest", await fetch(`${base}/manifest.webmanifest`)],
    ["GET /agent/downloads", await fetch(`${base}/agent/downloads`)],
    ["GET /agent/download/<unknown>", await fetch(`${base}/agent/download/nope.zip`)],
    ["GET /<unknown>", await fetch(`${base}/no-such-route`)],
    [
      "POST /helm/encrypt (bad body)",
      await fetch(`${base}/helm/encrypt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
    ],
  ];
  await Promise.all(fresh.map(([, r]) => r.text()));
  // shellRes and encRes are drained above; only their headers are read here.
  const everyRoute: [string, Response][] = [["GET /", shellRes], ["POST /ansible/encrypt", encRes], ...fresh];
  const bare = everyRoute.filter(([, r]) => policy.some((h) => r.headers.get(h) === null)).map(([name]) => name);
  check(
    "no route can answer without the policy headers",
    bare.length === 0,
    bare.length ? `served bare: ${bare.join(", ")}` : `${everyRoute.length} routes checked, 404s and rejected bodies included`,
  );

  // ── 2b. the other half of the CSP ──
  //
  // The policy above is what stops an injected script from running. This is
  // what stops one being injected: the panels build their rows with innerHTML,
  // and the strings in them — file paths, branch names, commit subjects — come
  // from whatever repository the user opened. A repository can be cloned with a
  // file named `" onmouseover=… x="`.
  //
  // There used to be two escapers, `esc` for text and `attr` for attributes,
  // and the wrong one was picked in four separate panels. So the rule being
  // held here is the structural one: exactly one escaper, and it is safe in
  // both contexts.
  const HOSTILE = `" onmouseover="alert(1)`;
  const escaped = esc(HOSTILE);
  check(
    "the escaper neutralises every character that can break out",
    !/[<>"'&](?!\w+;)/.test(escaped) && !escaped.includes('"') && !escaped.includes("'"),
    escaped,
  );
  /** The attribute names a real HTML parser finds on the div — which is the
   *  only question that matters. A break-out shows up as a name nobody wrote. */
  const attrsOf = async (value: string): Promise<string[]> => {
    let names: string[] = [];
    await new HTMLRewriter()
      .on("div", { element: (el) => void (names = [...el.attributes].map(([n]) => n)) })
      .transform(new Response(`<div class="row" title="${value}">x</div>`))
      .text();
    return names;
  };

  // The negative control comes first: a check that cannot observe the failure
  // it is written to catch would pass just as happily over a broken escaper.
  const rawAttrs = await attrsOf(HOSTILE);
  check(
    "the check can see a break-out when there is one",
    rawAttrs.includes("onmouseover"),
    `unescaped, the parser finds: ${rawAttrs.join(", ")}`,
  );
  const safeAttrs = await attrsOf(escaped);
  check(
    "an attribute built with the escaper cannot be escaped from",
    safeAttrs.join(",") === "class,title",
    `escaped, the parser finds: ${safeAttrs.join(", ")}`,
  );

  // A second escaper is how this went wrong the first time — caps.ts grew its
  // own, search-panel.ts grew another. Anything defining the entity table
  // outside ui.ts is one.
  const webFiles = new Bun.Glob("**/*.ts").scan({ cwd: "src/web", absolute: true });
  const rogue: string[] = [];
  for await (const path of webFiles) {
    if (path.replace(/\\/g, "/").endsWith("src/web/code/ui.ts")) continue;
    if (/["']&amp;["']/.test(await readFile(path, "utf8"))) rogue.push(path.replace(/.*src[\\/]web[\\/]/, ""));
  }
  check("only one module knows how to escape HTML", rogue.length === 0, rogue.length ? `also in ${rogue.join(", ")}` : "src/web/code/ui.ts");

  // ── 3. the browser bundle must not post secrets anywhere ──
  // A regression here would silently start sending plaintext and passwords to
  // a shared server, so it is asserted against the built bundle.
  const bundle = await readFile("public/main.js", "utf8");
  const posts = ["/ansible/encrypt", "/ansible/decrypt", "/helm/encrypt", "/helm/decrypt"].filter((p) => bundle.includes(p));
  check(
    "the built bundle never calls the crypto endpoints",
    posts.length === 0,
    posts.length ? `still references ${posts.join(", ")}` : "encryption happens in the page, nothing is sent",
  );

  // ── 4. two agents, two folders, no crossing ──
  await writeFile(join(rootA, "secret-a.txt"), "user A private\n", "utf8");
  await writeFile(join(rootB, "secret-b.txt"), "user B private\n", "utf8");
  for (const r of [rootA, rootB]) {
    await git(r, "init", "-q", "-b", "main");
    await git(r, "config", "user.email", "u@example.com");
    await git(r, "config", "user.name", "U");
    await git(r, "add", "-A");
    await git(r, "commit", "-qm", "fixture");
  }

  agentA = await startAgent(rootA, AGENT_A);
  agentB = await startAgent(rootB, AGENT_B);

  const aOwn = await agentA.call<FileRead>("fs.read", { path: "secret-a.txt" });
  const bOwn = await agentB.call<FileRead>("fs.read", { path: "secret-b.txt" });
  check("each agent serves its own folder", aOwn.text?.includes("user A") === true && bOwn.text?.includes("user B") === true, "both read their own file");

  // Reaching the other user's folder, by name and by traversal.
  const escapes = [
    "secret-b.txt",
    `../${rootB.split(/[/\\]/).pop()}/secret-b.txt`,
    "../../../../../../etc/passwd",
    rootB.replace(/\\/g, "/") + "/secret-b.txt",
  ];
  const outcomes: string[] = [];
  for (const path of escapes) {
    try {
      const r = await agentA.call<FileRead>("fs.read", { path });
      outcomes.push(r.text?.includes("user B") ? `LEAKED via ${path}` : `empty for ${path}`);
    } catch (e) {
      outcomes.push((e as Error).message.slice(0, 28));
    }
  }
  check("one agent cannot read the other's folder", !outcomes.some((o) => o.startsWith("LEAKED")), outcomes.join(" | "));

  // A project-wide search must not wander outside the workspace either.
  const searchA = agentA.call<SearchSummary>("search", { query: "private", matchCase: false, wholeWord: false, regex: false });
  const summaryA = await searchA;
  const hitPaths = searchA.chunks.map((c) => (c as { hit: { path: string } }).hit?.path).filter(Boolean);
  check(
    "search stays inside the workspace",
    summaryA.files === 1 && hitPaths.every((p) => p === "secret-a.txt"),
    `${summaryA.files} file(s): ${[...new Set(hitPaths)].join(", ")}`,
  );

  // ── 5. two connections to one agent keep separate in-flight state ──
  // Request ids are per connection, so one connection must not be able to
  // cancel — or otherwise reach into — another's work.
  const second = await startAgent(rootA, AGENT_A + 10);
  try {
    const running = agentA.call<SearchSummary>("search", { query: "e", matchCase: false, wholeWord: false, regex: false });
    const foreign = await second.call<{ cancelled: boolean }>("cancel", { target: running.id });
    const mine = await running;
    check(
      "one connection cannot cancel another's request",
      foreign.cancelled === false && mine.truncated === false,
      `foreign cancel refused, the request finished normally (${mine.matches} matches)`,
    );
  } finally {
    second.close();
  }

  // ── 6. the agent is not reachable from the network ──
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!lan) {
    check("the agent is unreachable off-machine", true, "SKIPPED — no non-loopback IPv4 on this host");
  } else {
    let reachable = false;
    try {
      const r = await fetch(`http://${lan}:${AGENT_A}/ping`, { signal: AbortSignal.timeout(2500) });
      reachable = r.ok;
    } catch {
      reachable = false;
    }
    check("the agent is unreachable off-machine", !reachable, `bound to loopback only; ${lan}:${AGENT_A} refused`);
  }

  // ── 7. same plaintext and password never produce the same ciphertext ──
  // Reused salt or IV across users would be a real cross-user weakness.
  const same = { text: "identical across users", password: "identical" };
  const helmOut = await Promise.all(Array.from({ length: 20 }, () => helm.encrypt(same.text, same.password)));
  const vaultOut = await Promise.all(Array.from({ length: 20 }, () => ansible.encrypt(same.text, same.password)));
  check(
    "identical input yields unique ciphertext per call",
    new Set(helmOut).size === 20 && new Set(vaultOut).size === 20,
    "fresh salt and IV every time, in both schemes",
  );
} catch (e) {
  check("unexpected error", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  agentA?.close();
  agentB?.close();
  server.kill();
  await rm(rootA, { recursive: true, force: true }).catch(() => undefined);
  await rm(rootB, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
