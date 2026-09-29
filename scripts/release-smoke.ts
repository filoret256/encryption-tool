/** Release signing: `bun run release:smoke`.
 *
 *  A signature that verifies proves little; what matters is what it refuses. So
 *  this builds one real archive, signs the list of hashes, and then attacks each
 *  layer in turn — the list, the archive, the key, the signature's absence — and
 *  expects every one to be caught, by our verifier and by plain OpenSSL, which is
 *  what a user without this repository has.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: { name: string; ok: boolean; note: string }[] = [];
function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

async function run(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, {
    env: { ...process.env, CODE_AGENT_SIGN_KEY: "", ...env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}

const dir = await mkdtemp(join(tmpdir(), "enc-release-"));
const keyBase = join(dir, "k");
const otherBase = join(dir, "other");
const out = join(dir, "out");

try {
  // ── keys ──
  const made = await run(["bun", "scripts/release-key.ts", "--out", keyBase]);
  check("a key pair is made", made.code === 0 && existsSync(`${keyBase}.pem`) && existsSync(`${keyBase}.pub.pem`), made.out.split("\n").find((l) => l.startsWith("fingerprint")) ?? made.out.slice(0, 80));
  const again = await run(["bun", "scripts/release-key.ts", "--out", keyBase]);
  check("an existing key is never overwritten", again.code !== 0 && /refusing to overwrite/.test(again.out), again.out.trim().split("\n").pop() ?? "");
  await run(["bun", "scripts/release-key.ts", "--out", otherBase]);

  // ── a signed build ──
  const built = await run(["bun", "scripts/build-code-agents.ts", "--targets", "windows-x64", "--out", out, "--sign-key", `${keyBase}.pem`]);
  const sig = await readFile(join(out, "SHA256SUMS.sig")).catch(() => null);
  check("a build with a key writes a signature", built.code === 0 && sig?.length === 64, sig ? `${sig.length} bytes (Ed25519)` : built.out.slice(-200));

  const verify = (key: string, where = out): Promise<{ code: number; out: string }> =>
    run(["bun", "scripts/verify-release.ts", "--key", key, where]);

  const good = await verify(`${keyBase}.pub.pem`);
  check("the signed release verifies", good.code === 0 && /1 archive\(s\) match/.test(good.out), good.out.trim().split("\n").pop() ?? "");

  // OpenSSL is what a user has. Checked when it is here, said so when it is not.
  const openssl = await run(["openssl", "version"]).catch(() => ({ code: 127, out: "" }));
  const ossl = (pub: string, sums: string, sigfile: string): Promise<{ code: number; out: string }> =>
    run(["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", pub, "-rawin", "-in", sums, "-sigfile", sigfile]);
  const haveOpenssl = openssl.code === 0 && /OpenSSL 3|OpenSSL 1\.1\.1/.test(openssl.out);
  if (haveOpenssl) {
    const r = await ossl(`${keyBase}.pub.pem`, join(out, "SHA256SUMS"), join(out, "SHA256SUMS.sig"));
    check("OpenSSL verifies it too, with no help from this repository", r.code === 0, r.out.trim());
  } else {
    check("OpenSSL verifies it too (skipped)", true, "no OpenSSL 1.1.1+ on this machine");
  }

  // ── attacks ──
  const wrong = await verify(`${otherBase}.pub.pem`);
  check("another key does not verify it", wrong.code === 1 && /not a valid signature/.test(wrong.out), wrong.out.trim().split("\n").pop() ?? "");

  // The list, changed: one hash swapped for another.
  const sums = await readFile(join(out, "SHA256SUMS"), "utf8");
  const forged = join(dir, "forged");
  await run(["bun", "-e", `require("node:fs").mkdirSync(${JSON.stringify(forged)}, {recursive:true})`]);
  const swapped = sums.replace(/^[0-9a-f]/, (c) => (c === "0" ? "1" : "0"));
  await writeFile(join(forged, "SHA256SUMS"), swapped);
  await writeFile(join(forged, "SHA256SUMS.sig"), sig!);
  const tamperedList = await verify(`${keyBase}.pub.pem`, forged);
  check("a changed list of hashes is caught", tamperedList.code === 1 && /not a valid signature/.test(tamperedList.out), tamperedList.out.trim().split("\n").pop() ?? "");
  if (haveOpenssl) {
    const r = await ossl(`${keyBase}.pub.pem`, join(forged, "SHA256SUMS"), join(forged, "SHA256SUMS.sig"));
    check("and by OpenSSL", r.code !== 0, r.out.trim().split("\n")[0] ?? "");
  }

  // The archive, changed: the signature is fine, the file is not what it signs.
  const file = sums.trim().split(/\s+/)[1];
  const archive = await readFile(join(out, file));
  const swappedDir = join(dir, "swapped");
  await run(["bun", "-e", `require("node:fs").mkdirSync(${JSON.stringify(swappedDir)}, {recursive:true})`]);
  await writeFile(join(swappedDir, "SHA256SUMS"), sums);
  await writeFile(join(swappedDir, "SHA256SUMS.sig"), sig!);
  await writeFile(join(swappedDir, file), Buffer.concat([archive, Buffer.from([0])]));
  const tamperedArchive = await verify(`${keyBase}.pub.pem`, swappedDir);
  check("a changed archive is caught even though the signature is genuine", tamperedArchive.code === 1 && /the signed list says/.test(tamperedArchive.out), tamperedArchive.out.trim().split("\n").pop() ?? "");

  // A list that names a path is a list that would read outside the directory.
  const pathDir = join(dir, "path");
  await run(["bun", "-e", `require("node:fs").mkdirSync(${JSON.stringify(pathDir)}, {recursive:true})`]);
  const pathSums = `${"0".repeat(64)}  ../../etc/passwd\n`;
  await writeFile(join(pathDir, "SHA256SUMS"), pathSums);
  // Signed properly, so the only thing standing in the way is the name.
  const { createPrivateKey, sign } = await import("node:crypto");
  await writeFile(join(pathDir, "SHA256SUMS.sig"), sign(null, Buffer.from(pathSums), createPrivateKey(await readFile(`${keyBase}.pem`))));
  const named = await verify(`${keyBase}.pub.pem`, pathDir);
  check("a signed list that names a path is refused", named.code === 1 && /names a path/.test(named.out), named.out.trim().split("\n").pop() ?? "");

  // ── no signature ──
  await rm(join(swappedDir, "SHA256SUMS.sig"));
  const unsigned = await verify(`${keyBase}.pub.pem`, swappedDir);
  check("a release with no signature is not accepted as signed", unsigned.code === 1 && /not signed/.test(unsigned.out), unsigned.out.trim().split("\n").pop() ?? "");

  // A rebuild without a key must not leave the last build's signature next to a
  // list it never saw.
  const rebuilt = await run(["bun", "scripts/build-code-agents.ts", "--targets", "windows-x64", "--out", out]);
  check("an unsigned rebuild removes a stale signature", rebuilt.code === 0 && !existsSync(join(out, "SHA256SUMS.sig")) && /not signed/.test(rebuilt.out), rebuilt.out.trim().split("\n").pop() ?? "");
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
