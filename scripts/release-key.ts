/** Make a release-signing key pair: `bun scripts/release-key.ts [--out release-key]`.
 *
 *  Writes <out>.pem (the private key — keep it off this repository and out of the
 *  image) and <out>.pub.pem (the public key, which users verify against).
 *  Ed25519, because a signature is 64 bytes, there is nothing to choose wrongly,
 *  and OpenSSL (1.1.1 and later) verifies it without any extra tool:
 *
 *    openssl pkeyutl -verify -pubin -inkey release-key.pub.pem -rawin \
 *      -in SHA256SUMS -sigfile SHA256SUMS.sig
 *
 *  What this does not do, and cannot: decide where the private key lives, or how
 *  users come to trust the public one. A signature is only as good as the second
 *  of those — a public key fetched from the same place as the download proves
 *  nothing the download did not. Publish it somewhere else (the project's page,
 *  a package, a printed fingerprint), and rotate it when the private half may
 *  have been seen.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const flag = process.argv.indexOf("--out");
const base = flag >= 0 ? (process.argv[flag + 1] ?? "") : "release-key";
if (!base) throw new Error("--out needs a name");

const privatePath = `${base}.pem`;
const publicPath = `${base}.pub.pem`;
// Never replaced: a key that was already in use and is overwritten is a key whose
// signatures can no longer be made, and nothing here can tell.
for (const p of [privatePath, publicPath]) {
  if (existsSync(p)) throw new Error(`${p} already exists; refusing to overwrite a key`);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
await writeFile(publicPath, publicPem);

// The fingerprint is what a person can compare by eye or read out: of the DER
// form, so it does not change with line endings in the PEM.
const fingerprint = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
console.log(`private key  ${privatePath}   (mode 0600 where the platform honours it — keep it secret)`);
console.log(`public key   ${publicPath}`);
console.log(`fingerprint  sha256:${fingerprint}`);
console.log(`\nSign a release:  bun scripts/build-code-agents.ts --sign-key ${privatePath}`);
console.log(`Verify it:       bun scripts/verify-release.ts --key ${publicPath}`);
