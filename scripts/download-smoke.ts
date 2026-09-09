/** Prebuilt-agent distribution: `bun run download:smoke`.
 *
 *  Two things are checked here, and neither is cosmetic.
 *
 *  The archives: a browser download that lands without the executable bit, or
 *  a zip Explorer refuses, is a dead end for the user — so the writers are read
 *  back with node:zlib and the recovered bytes, mode and CRC compared against
 *  what went in.
 *
 *  The route: it turns a string from the URL into a file on disk. It does that
 *  through an allowlist built from the manifest, and the traversal attempts
 *  below are what keeps it that way.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { iter } from "../src/agent/proc.ts";
import { pack } from "./archive.ts";
import { VERSION } from "../src/version.ts";

const results: { name: string; ok: boolean; note: string }[] = [];
function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const dec = new TextDecoder();

// ── 1. the archive writers, read back ─────────────────────────────────────
// A repeating pattern, so zip takes its deflate branch; `noise` below is
// incompressible and takes the "stored" one. Both are reachable with a real
// binary, so both are covered.
const payload = new Uint8Array(200_000);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) & 0xff;
const noise = new Uint8Array(64_000);
crypto.getRandomValues(noise);
const text = new TextEncoder().encode("#!/bin/sh\nexec agent\n");

{
  const gz = pack("tar.gz", [
    { name: "enc-tool-agent", data: payload, mode: 0o755 },
    { name: "README", data: text, mode: 0o644 },
  ]);
  const raw = new Uint8Array(gunzipSync(gz));

  // ustar: 512-byte header, then the file padded to a 512 boundary.
  const field = (buf: Uint8Array, at: number, len: number): string =>
    dec.decode(buf.subarray(at, at + len)).replace(/\0.*$/s, "").trim();
  const name = field(raw, 0, 100);
  const mode = field(raw, 100, 8);
  const size = parseInt(field(raw, 124, 12), 8);
  const magic = field(raw, 257, 6);
  const body = raw.subarray(512, 512 + size);

  // The checksum is the sum of the header bytes with its own field as spaces.
  const header = raw.slice(0, 512);
  const stated = parseInt(field(raw, 148, 8), 8);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;

  check(
    "tar.gz: header, size, mode and checksum are well formed",
    name === "enc-tool-agent" && mode === "0000755" && size === payload.length && magic === "ustar" && sum === stated,
    `name=${name} mode=${mode} size=${size} magic=${magic} cksum ${sum === stated ? "matches" : `${sum} != ${stated}`}`,
  );
  check("tar.gz: the payload round-trips byte for byte", sha256(body) === sha256(payload), `${size} bytes`);

  // The second entry proves the 512-padding between members is right.
  const at = 512 + Math.ceil(size / 512) * 512;
  const second = dec.decode(raw.subarray(at + 512, at + 512 + text.length));
  check("tar.gz: a second entry starts on the next 512-byte boundary", second === dec.decode(text), field(raw, at, 100));

  const trailer = raw.subarray(raw.length - 1024);
  check("tar.gz: ends with the two-block end-of-archive marker", trailer.every((b) => b === 0), "1024 zero bytes");
}

{
  const z = pack("zip", [{ name: "enc-tool-agent.exe", data: payload }]);
  const view = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const sig = view.getUint32(0, true);
  const method = view.getUint16(8, true);
  const crc = view.getUint32(14, true);
  const comp = view.getUint32(18, true);
  const uncomp = view.getUint32(22, true);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const start = 30 + nameLen + extraLen;
  const stored = z.subarray(start, start + comp);
  const body = method === 0 ? stored : new Uint8Array(inflateRawSync(stored));

  // Independent CRC32, so a bug in the writer's table cannot agree with itself.
  let c = 0xffffffff;
  for (const b of payload) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  const expected = (c ^ 0xffffffff) >>> 0;

  check("zip: local header is valid and the entry decodes", sig === 0x04034b50 && uncomp === payload.length && sha256(body) === sha256(payload), `method=${method === 0 ? "store" : "deflate"} ${comp} -> ${uncomp} bytes`);
  check("zip: the stored CRC32 matches the payload", crc === expected, crc.toString(16));
  check(
    "zip: the end-of-central-directory record is present",
    new DataView(z.buffer, z.byteOffset + z.length - 22, 22).getUint32(0, true) === 0x06054b50,
    "single entry, no zip64",
  );

  // Data deflate cannot shrink must be stored, not stored *and* larger.
  const nz = pack("zip", [{ name: "noise.bin", data: noise }]);
  const nv = new DataView(nz.buffer, nz.byteOffset, nz.byteLength);
  const nStart = 30 + nv.getUint16(26, true) + nv.getUint16(28, true);
  check(
    "zip: incompressible data falls back to storing it",
    nv.getUint16(8, true) === 0 && nz.length < noise.length + 200 &&
      sha256(nz.subarray(nStart, nStart + nv.getUint32(18, true))) === sha256(noise),
    `${noise.length} bytes stored, ${nz.length - noise.length} bytes of overhead`,
  );
}

// ── 2. the serving route ──────────────────────────────────────────────────
const PORT = 5093;
const MIRROR_PORT = 5094;
const EMPTY_PORT = 5095;
const dir = await mkdtemp(join(tmpdir(), "enc-agents-"));
const empty = await mkdtemp(join(tmpdir(), "enc-agents-empty-"));

const archive = pack("tar.gz", [{ name: "enc-tool-agent", data: payload, mode: 0o755 }]);
const file = `enc-tool-agent-${VERSION}-linux-x64.tar.gz`;
await writeFile(join(dir, file), archive);
await writeFile(join(dir, "secret.txt"), "not for download\n");
await writeFile(
  join(dir, "agents.json"),
  JSON.stringify({
    version: VERSION,
    builds: [
      {
        id: "linux-x64", os: "linux", arch: "x64", label: "Linux (x64)",
        exe: "enc-tool-agent", kind: "tar.gz", file,
        size: archive.length, sha256: sha256(archive),
      },
      // Listed but absent: a partial mirror must not produce a broken link.
      {
        id: "windows-x64", os: "windows", arch: "x64", label: "Windows (x64)",
        exe: "enc-tool-agent.exe", kind: "zip", file: `enc-tool-agent-${VERSION}-windows-x64.zip`,
        size: 1, sha256: "00",
      },
    ],
  }),
);

interface Build { id: string; file: string; url: string; sha256?: string; size?: number }

async function serve(port: number, env: Record<string, string>): Promise<{ kill: () => void }> {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ...env },
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });
  let banner = "";
  const d = new TextDecoder();
  for await (const bytes of iter(proc.stdout as ReadableStream<Uint8Array>)) {
    banner += d.decode(bytes, { stream: true });
    if (banner.includes("listening")) break;
  }
  return { kill: () => proc.kill() };
}

const servers: { kill: () => void }[] = [];
try {
  servers.push(await serve(PORT, { AGENT_DIR: dir }));
  const base = `http://127.0.0.1:${PORT}`;

  const listing = (await fetch(`${base}/agent/downloads`).then((r) => r.json())) as {
    version: string;
    builds: Build[];
  };
  check(
    "only archives that exist on disk are listed",
    listing.builds.length === 1 && listing.builds[0].id === "linux-x64" && listing.version === VERSION,
    `${listing.builds.length} of 2 manifest entries, version ${listing.version}`,
  );
  check(
    "a local build points at this server",
    listing.builds[0]?.url === `/agent/download/${file}`,
    listing.builds[0]?.url ?? "no build",
  );

  const res = await fetch(base + listing.builds[0].url);
  const got = new Uint8Array(await res.arrayBuffer());
  check(
    "the archive downloads intact and as an attachment",
    res.ok && sha256(got) === listing.builds[0].sha256 && (res.headers.get("content-disposition") ?? "").includes(file),
    `${got.length} bytes, sha256 matches the manifest`,
  );
  check(
    "the download carries the security headers and is cacheable",
    res.headers.get("content-security-policy") !== null &&
      res.headers.get("x-content-type-options") === "nosniff" &&
      (res.headers.get("cache-control") ?? "").includes("max-age"),
    `${res.headers.get("content-type")}, immutable per version`,
  );

  // The route joins a request string to a path only through the manifest
  // allowlist. Percent-encoded separators are used because fetch normalises a
  // literal "../" out of the URL before it is ever sent.
  const escapes = [
    "%2E%2E%2Fsecret.txt",
    "%2E%2E%2F%2E%2E%2Fpackage.json",
    "..%2Fsecret.txt",
    "%2Fetc%2Fpasswd",
    "agents.json",
    "secret.txt",
    `enc-tool-agent-${VERSION}-windows-x64.zip`,
  ];
  const leaked: string[] = [];
  for (const name of escapes) {
    const r = await fetch(`${base}/agent/download/${name}`);
    if (r.ok) leaked.push(name);
    await r.arrayBuffer();
  }
  check(
    "nothing outside the manifest can be downloaded",
    leaked.length === 0,
    leaked.length ? `served ${leaked.join(", ")}` : `${escapes.length} attempts, all 404 — traversal, siblings and the missing entry`,
  );

  // ── a mirror instead of local files ──
  servers.push(await serve(MIRROR_PORT, { AGENT_DIR: empty, AGENT_DOWNLOAD_BASE: "https://cdn.example.com/agents/" }));
  const mirrored = (await fetch(`http://127.0.0.1:${MIRROR_PORT}/agent/downloads`).then((r) => r.json())) as {
    builds: Build[];
  };
  check(
    "a mirror is advertised for every known platform",
    mirrored.builds.length === 5 &&
      mirrored.builds.every((b) => b.url.startsWith("https://cdn.example.com/agents/enc-tool-agent-")) &&
      mirrored.builds.every((b) => b.sha256 === undefined),
    `${mirrored.builds.length} builds, trailing slash trimmed, no checksums claimed for files we have not seen`,
  );
  const denied = await fetch(`http://127.0.0.1:${MIRROR_PORT}/agent/download/${file}`);
  await denied.arrayBuffer();
  check("a mirror configuration serves no local files", denied.status === 404, `status ${denied.status}`);

  // ── nothing published at all ──
  servers.push(await serve(EMPTY_PORT, { AGENT_DIR: empty }));
  const none = (await fetch(`http://127.0.0.1:${EMPTY_PORT}/agent/downloads`).then((r) => r.json())) as {
    builds: Build[];
  };
  check(
    "with no archives the listing is empty rather than broken",
    Array.isArray(none.builds) && none.builds.length === 0,
    "the panel hides itself instead of offering dead links",
  );

  // ── 3. the flag those download instructions hand out ──
  //
  // Handing out binaries makes --allow-origin the flag every user ends up
  // running, and it is the only thing standing between an arbitrary web page
  // and their working directory. So it is checked here rather than assumed:
  // the origin gate must hold independently of the token, in both directions.
  const ALLOWED = "https://tool.example.test";
  const FOREIGN = "https://evil.example.test";

  const startAgent = async (port: number, extra: string[], env: Record<string, string> = {}): Promise<() => void> => {
    const proc = Bun.spawn(["bun", "src/agent/cli.ts", ...extra, "--port", String(port), "--token", "smoke"], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "inherit",
      stdin: "ignore",
    });
    let banner = "";
    const d = new TextDecoder();
    for await (const bytes of iter(proc.stdout as ReadableStream<Uint8Array>)) {
      banner += d.decode(bytes, { stream: true });
      if (banner.includes("Paste this")) break;
    }
    return () => proc.kill();
  };

  const stopFlag = await startAgent(5096, ["--root", dir, "--allow-origin", ALLOWED]);
  const stopEnv = await startAgent(5097, ["--root", dir], {
    ENC_TOOL_ALLOW_ORIGIN: `${ALLOWED}/, https://second.example.test`,
  });
  try {
    const at = (port: number, path: string, origin: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers: { origin } });

    const allowed = await at(5096, "/ping", ALLOWED);
    const foreign = await at(5096, "/ping", FOREIGN);
    const loopback = await at(5096, "/ping", "http://localhost:5000");
    await Promise.all([allowed.text(), foreign.text(), loopback.text()]);
    check(
      "the agent answers the allowed origin and refuses others",
      allowed.status === 200 && foreign.status === 403 && loopback.status === 200,
      `allowed ${allowed.status}, foreign ${foreign.status}, loopback ${loopback.status}`,
    );
    check(
      "a refused origin gets no CORS grant either",
      foreign.headers.get("access-control-allow-origin") === null &&
        allowed.headers.get("access-control-allow-origin") === ALLOWED,
      "the browser is not told it may read the response",
    );

    // Origin is checked before the token, so a stolen token is still useless
    // from a page the user never allowed.
    const wrongToken = await at(5096, "/ws?token=nope", ALLOWED);
    const rightTokenForeign = await at(5096, "/ws?token=smoke", FOREIGN);
    await Promise.all([wrongToken.text(), rightTokenForeign.text()]);
    check(
      "origin and token gate the socket independently",
      wrongToken.status === 401 && rightTokenForeign.status === 403,
      "allowed origin + bad token -> 401, foreign origin + valid token -> 403",
    );

    const viaEnv = await at(5097, "/ping", ALLOWED);
    const viaEnvSecond = await at(5097, "/ping", "https://second.example.test");
    const viaEnvForeign = await at(5097, "/ping", FOREIGN);
    await Promise.all([viaEnv.text(), viaEnvSecond.text(), viaEnvForeign.text()]);
    check(
      "ENC_TOOL_ALLOW_ORIGIN grants the same access as the flag",
      viaEnv.status === 200 && viaEnvSecond.status === 200 && viaEnvForeign.status === 403,
      "comma-separated list parsed, trailing slash trimmed",
    );
    // ── 4. the folder argument the panel now hands out ──
    //
    // The instructions say `./enc-tool-agent <folder>`, so one binary can serve
    // every repository. That path has to work, and getting it wrong must not
    // quietly fall back to exposing the current directory instead.
    const stopPositional = await startAgent(5098, [dir, "--allow-origin", ALLOWED]);
    try {
      const info = await at(5098, "/ping", ALLOWED);
      await info.text();
      check("the folder can be passed as the first argument", info.status === 200, `agent up on the folder named by argument, not by cwd`);
    } finally {
      stopPositional();
    }

    const runCli = async (args: string[]): Promise<{ code: number; out: string }> => {
      const p = Bun.spawn(["bun", "src/agent/cli.ts", ...args], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out: out + err };
    };

    const typo = await runCli(["--roott", dir]);
    const twice = await runCli([dir, "--root", dir]);
    const twicePositional = await runCli([dir, dir]);
    check(
      "a mistyped option or a folder given twice is refused, not guessed",
      typo.code === 2 && /unknown option/.test(typo.out) &&
        twice.code === 2 && twicePositional.code === 2 && /given twice/.test(twice.out),
      "otherwise the agent would silently expose the current directory",
    );
  } finally {
    stopFlag();
    stopEnv();
  }
} catch (e) {
  check("unexpected error", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  for (const s of servers) s.kill();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await rm(empty, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
