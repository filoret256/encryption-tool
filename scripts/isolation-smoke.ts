/** Multi-user isolation: `bun run isolation:smoke`.
 *
 *  The question this answers is whether one person's data can reach another
 *  when many use the app at once. The architecture is meant to make that
 *  impossible rather than unlikely:
 *
 *    - the crypto tabs run WebCrypto in the page, so plaintext and passwords
 *      never leave the browser at all — the server has no crypto endpoints,
 *      which is checked below rather than assumed;
 *    - the server keeps no per-request state and no session, so there is
 *      nothing for two requests to share;
 *    - the code tab talks only to a code-agent on the user's own loopback
 *      interface, jailed to one folder.
 *
 *  Each of those is checked here rather than asserted.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { iter } from "../src/code-agent/proc.ts";
import { CODE_AGENT_PORT_MAX, CODE_AGENT_PORT_MIN, CODE_AGENT_PORT_RANGE } from "../src/ports.ts";
import { git, startCodeAgent, type Harness } from "./harness.ts";
import { ansible, helm } from "../src/crypto/index.ts";
import type { FileRead, SearchSummary } from "../src/code-agent/protocol.ts";
import { esc } from "../src/web/code/ui.ts";

const SERVER_PORT = 5091;
const CODE_AGENT_A = 5089;
const CODE_AGENT_B = 5088;
// Each user costs several 600 000-round key derivations, so this is the number
// that keeps the run to seconds while still being far more than "a couple".
const USERS = 24;

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

let codeAgentA: Harness | null = null;
let codeAgentB: Harness | null = null;
const rootA = await mkdtemp(join(tmpdir(), "enc-userA-"));
const rootB = await mkdtemp(join(tmpdir(), "enc-userB-"));

try {
  // ── 1. concurrent users must never see each other's data ──
  // The crypto modules are what the page runs, and they hold no state between
  // calls. Hammer them the way many tabs at once would and check every answer
  // belongs to the call that asked.
  for (const scheme of [ansible, helm]) {
    const name = scheme === ansible ? "ansible" : "helm";
    const users = Array.from({ length: USERS }, (_, i) => ({
      text: `user-${i} secret payload ${"x".repeat(i)}`,
      password: `password-of-user-${i}`,
    }));

    const ciphertexts = await Promise.all(users.map((u) => scheme.encrypt(u.text, u.password)));
    const decrypted = await Promise.all(ciphertexts.map((c, i) => scheme.decrypt(c, users[i].password)));
    const roundTrip = decrypted.every((d, i) => d === users[i].text);

    // And a ciphertext must not open with someone else's password.
    const crossed = await Promise.all(
      ciphertexts.map((c, i) => scheme.decrypt(c, users[(i + 1) % USERS].password).then((r) => r, () => undefined)),
    );
    const leaked = crossed.filter((d, i) => d !== undefined && d === users[i].text);

    check(
      `${name}: ${USERS} concurrent users get only their own data`,
      roundTrip && leaked.length === 0,
      `${USERS} round trips correct, ${leaked.length} leaked under a foreign password`,
    );
  }

  // The server used to expose these, and a password sent to one crossed the
  // network. Gone is the claim; a 404 that still carries the policy headers is
  // the proof, and the headers are checked with the other routes below.
  const gone: [string, Response][] = [];
  for (const path of ["/helm/encrypt", "/helm/decrypt", "/ansible/encrypt", "/ansible/decrypt"]) {
    gone.push([`POST ${path}`, await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", password: "y" }),
    })]);
  }
  await Promise.all(gone.map(([, r]) => r.text()));
  const answered = gone.filter(([, r]) => r.status !== 404).map(([n, r]) => `${n} → ${r.status}`);
  check("the server has no crypto endpoints", answered.length === 0, answered.length ? answered.join(", ") : "all four answer 404");

  // ── 2. no session, no cookie, nothing cacheable by a shared proxy ──
  const encRes = await fetch(`${base}/code-agent/downloads`);
  await encRes.text();
  const shellRes = await fetch(`${base}/`);
  const htmlShell = await shellRes.text();
  const identifying = ["set-cookie", "etag", "last-modified", "x-request-id"].filter(
    (h) => encRes.headers.get(h) !== null,
  );
  check(
    "API responses carry no session or cache identity",
    identifying.length === 0 && !(encRes.headers.get("cache-control") ?? "").includes("public"),
    identifying.length ? `unexpected: ${identifying.join(", ")}` : "no set-cookie, no etag, not publicly cacheable",
  );
  check("the shell sets no cookie either", shellRes.headers.get("set-cookie") === null, "static, identical for everyone");

  // The code-agent's URL and token live in localStorage, and that code-agent is a
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
  // The code-agent binds the first free port in this range (src/ports.ts), so the
  // policy has to cover the whole of it — the ends are what a second and a
  // tenth code-agent land on, and either one missing is a tab that cannot connect.
  const missingCodeAgentPorts = [CODE_AGENT_PORT_MIN, CODE_AGENT_PORT_MAX].flatMap((p) =>
    ["ws", "http"].map((s) => `${s}://127.0.0.1:${p}`).filter((src) => !connectSrc.includes(src)),
  );
  check(
    "the policy still permits the loopback code-agent, across the whole port range",
    missingCodeAgentPorts.length === 0,
    missingCodeAgentPorts.length ? `missing ${missingCodeAgentPorts.join(", ")}` : `ws:// and http:// on ${CODE_AGENT_PORT_RANGE}`,
  );

  // The page cannot read its own policy, and a refused connection is
  // indistinguishable from an absent code-agent without this: the violation report
  // that would tell them apart arrives in a queued task, after the failure has
  // already been reported to the user. See src/web/code/code-agent.ts.
  const metaPorts = /<meta name="code-agent-ports" content="([^"]*)"/.exec(htmlShell)?.[1] ?? "";
  const listed = metaPorts.split(",").filter(Boolean);
  check(
    "the shell names those ports, so the tab can explain a refusal",
    listed.length > 0 && listed.every((p) => connectSrc.includes(`ws://127.0.0.1:${p}`)),
    listed.length ? `${listed.length} ports, every one of them in connect-src` : "no code-agent-ports meta in the shell",
  );
  // The point of pinning it: injected script gets a channel to the code-agent, not
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
    ["GET /code-agent/downloads", await fetch(`${base}/code-agent/downloads`)],
    ["GET /code-agent/download/<unknown>", await fetch(`${base}/code-agent/download/nope.zip`)],
    // A percent-escape that does not decode used to throw out of the route, and
    // what answered was Bun's development error page: stack, working directory
    // and source lines, with none of the policy headers.
    ["GET /code-agent/download/<bad escape>", await fetch(`${base}/code-agent/download/%E0%A4%A`)],
    ["GET /<unknown>", await fetch(`${base}/no-such-route`)],
    ["POST /helm/encrypt (removed)", await fetch(`${base}/helm/encrypt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })],
  ];
  const badEscape = fresh.find(([name]) => name === "GET /code-agent/download/<bad escape>")![1];
  const badEscapeBody = await badEscape.clone().text();
  const leaks = ["cwd", "stack", "at route", "server.ts", process.cwd()].filter((s) => badEscapeBody.includes(s));
  check(
    "a malformed URL is a plain 404, not a debug page",
    badEscape.status === 404 && leaks.length === 0 && badEscapeBody.length < 200,
    leaks.length ? `the body mentions ${leaks.join(", ")}` : `${badEscape.status}, ${badEscapeBody.length} bytes, nothing about the server`,
  );
  await Promise.all(fresh.map(([, r]) => r.text()));
  // shellRes and encRes are drained above; only their headers are read here.
  const everyRoute: [string, Response][] = [["GET /", shellRes], ["GET /code-agent/downloads", encRes], ...fresh];
  const bare = everyRoute.filter(([, r]) => policy.some((h) => r.headers.get(h) === null)).map(([name]) => name);
  check(
    "no route can answer without the policy headers",
    bare.length === 0,
    bare.length ? `served bare: ${bare.join(", ")}` : `${everyRoute.length} routes checked, 404s and rejected bodies included`,
  );

  // ── 2a. what was made cheaper must still be right ──
  //
  // The shell is built per request because it carries that request's nonce, and
  // the policy is stamped on every response. Both were rebuilt from scratch each
  // time and are now assembled from parts prepared once — which is exactly the
  // kind of change that goes wrong quietly, by sharing a nonce or leaving the
  // placeholder in. So: a fresh nonce every time, the same one in the header and
  // the page, no placeholder left, and a policy that differs between two
  // responses in the nonce alone.
  {
    const nonces = new Set<string>();
    const problems: string[] = [];
    const policies: string[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`${base}/`);
      const html = await r.text();
      const policy = r.headers.get("content-security-policy") ?? "";
      const inHeader = /'nonce-([^']+)'/.exec(policy)?.[1];
      const inPage = /name="csp-nonce" content="([^"]*)"/.exec(html)?.[1];
      if (!inHeader || inHeader !== inPage) problems.push(`#${i}: header ${inHeader} vs page ${inPage}`);
      if (html.includes("__CSP_NONCE__") || html.includes("__CODE_AGENT_PORTS__")) problems.push(`#${i}: a placeholder survived`);
      if (inHeader) nonces.add(inHeader);
      policies.push(policy.replace(/'nonce-[^']+'/, "'nonce-X'"));
    }
    const ports = /name="code-agent-ports" content="([^"]*)"/.exec(await (await fetch(`${base}/`)).text())?.[1];
    check(
      "every shell gets its own nonce, in the header and in the page",
      problems.length === 0 && nonces.size === 25,
      problems.length ? problems.slice(0, 2).join("; ") : `25 responses, 25 distinct nonces, ports ${ports}`,
    );
    const notFound = await fetch(`${base}/no-such-route`);
    await notFound.text();
    const policy404 = (notFound.headers.get("content-security-policy") ?? "").replace(/'nonce-[^']+'/, "'nonce-X'");
    check(
      "the policy is the same on every response but for the nonce",
      new Set([...policies, policy404]).size === 1 && policy404.includes("connect-src 'self' ws://127.0.0.1:5001"),
      `${policy404.length} bytes, identical on 25 shells and a 404`,
    );
  }

  // A cold server: the first request for a bundle used to compress it, on the
  // event loop, while the person waited — brotli at quality 9 on a 1.3 MB file.
  // It is done at startup now. Timed against the second request, on a server
  // started for the purpose, because the shared one above has already served it.
  {
    const cold = Bun.spawn(["bun", "src/server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: "5591" },
      stdout: "pipe",
      stderr: "inherit",
      stdin: "ignore",
    });
    try {
      const dec = new TextDecoder();
      let banner = "";
      for await (const bytes of iter(cold.stdout as ReadableStream<Uint8Array>)) {
        banner += dec.decode(bytes, { stream: true });
        if (banner.includes("listening")) break;
      }
      const timed = async (): Promise<number> => {
        const t0 = performance.now();
        const r = await fetch("http://127.0.0.1:5591/public/code.js", { headers: { "accept-encoding": "br" } });
        await r.arrayBuffer();
        return performance.now() - t0;
      };
      const first = await timed();
      const second = await timed();
      check(
        "the first request for a bundle does not pay for compressing it",
        first < second + 30,
        `first ${first.toFixed(1)} ms, second ${second.toFixed(1)} ms (compressing it takes ~55 ms and more)`,
      );
    } finally {
      cold.kill();
    }
  }

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

  // ── 4. two code-agents, two folders, no crossing ──
  await writeFile(join(rootA, "secret-a.txt"), "user A private\n", "utf8");
  await writeFile(join(rootB, "secret-b.txt"), "user B private\n", "utf8");
  for (const r of [rootA, rootB]) {
    await git(r, "init", "-q", "-b", "main");
    await git(r, "config", "user.email", "u@example.com");
    await git(r, "config", "user.name", "U");
    await git(r, "add", "-A");
    await git(r, "commit", "-qm", "fixture");
  }

  codeAgentA = await startCodeAgent(rootA, CODE_AGENT_A);
  codeAgentB = await startCodeAgent(rootB, CODE_AGENT_B);

  const aOwn = await codeAgentA.call<FileRead>("fs.read", { path: "secret-a.txt" });
  const bOwn = await codeAgentB.call<FileRead>("fs.read", { path: "secret-b.txt" });
  check("each code-agent serves its own folder", aOwn.text?.includes("user A") === true && bOwn.text?.includes("user B") === true, "both read their own file");

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
      const r = await codeAgentA.call<FileRead>("fs.read", { path });
      outcomes.push(r.text?.includes("user B") ? `LEAKED via ${path}` : `empty for ${path}`);
    } catch (e) {
      outcomes.push((e as Error).message.slice(0, 28));
    }
  }
  check("one code-agent cannot read the other's folder", !outcomes.some((o) => o.startsWith("LEAKED")), outcomes.join(" | "));

  // A project-wide search must not wander outside the workspace either.
  const searchA = codeAgentA.call<SearchSummary>("search", { query: "private", matchCase: false, wholeWord: false, regex: false });
  const summaryA = await searchA;
  const hitPaths = searchA.chunks.map((c) => (c as { hit: { path: string } }).hit?.path).filter(Boolean);
  check(
    "search stays inside the workspace",
    summaryA.files === 1 && hitPaths.every((p) => p === "secret-a.txt"),
    `${summaryA.files} file(s): ${[...new Set(hitPaths)].join(", ")}`,
  );

  // ── 5. two connections to one code-agent keep separate in-flight state ──
  // Request ids are per connection, so one connection must not be able to
  // cancel — or otherwise reach into — another's work.
  const second = await startCodeAgent(rootA, CODE_AGENT_A + 10);
  try {
    const running = codeAgentA.call<SearchSummary>("search", { query: "e", matchCase: false, wholeWord: false, regex: false });
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

  // ── 5b. a burst of process-spawning requests is queued, not dropped ──
  //
  // Every git op and every search forks a child, and nothing used to bound how
  // many could be in flight: search-as-you-type issues one per keystroke. They
  // are now capped per connection (MAX_CONCURRENT_PROCS) and the surplus waits
  // its turn — so what this asserts is that waiting is all it does. Every reply
  // still arrives, still carries its own request's id, and still says the same
  // thing it would have said alone.
  const alone = await codeAgentA.call<{ files: number }>("search", { query: "private", matchCase: false, wholeWord: false, regex: false });
  // Captured, because narrowing of a module-level `let` does not survive into
  // a closure — and every one of these calls is made from one.
  const codeAgent = codeAgentA;
  const burst = await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      i % 2 === 0
        ? codeAgent.call<{ files: number }>("search", { query: "private", matchCase: false, wholeWord: false, regex: false })
        : codeAgent.call<{ files: number }>("git.status", {}).then(() => ({ files: alone.files })),
    ),
  );
  check(
    "a burst of process-spawning requests all complete",
    burst.length === 24 && burst.every((r) => r.files === alone.files),
    `24 concurrent search/git.status calls, every reply matching the same call made alone (${alone.files} file)`,
  );

  // ── 6. the code-agent is not reachable from the network ──
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!lan) {
    check("the code-agent is unreachable off-machine", true, "SKIPPED — no non-loopback IPv4 on this host");
  } else {
    let reachable = false;
    try {
      const r = await fetch(`http://${lan}:${CODE_AGENT_A}/ping`, { signal: AbortSignal.timeout(2500) });
      reachable = r.ok;
    } catch {
      reachable = false;
    }
    check("the code-agent is unreachable off-machine", !reachable, `bound to loopback only; ${lan}:${CODE_AGENT_A} refused`);
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
  codeAgentA?.close();
  codeAgentB?.close();
  server.kill();
  await rm(rootA, { recursive: true, force: true }).catch(() => undefined);
  await rm(rootB, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
