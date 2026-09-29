/** Check a release: `bun scripts/verify-release.ts --key <public.pem> [dir]`.
 *
 *  Two things, in this order, and the second means nothing without the first:
 *
 *   1. SHA256SUMS carries a valid signature (SHA256SUMS.sig) from the key given —
 *      so the list of hashes is the one the key's owner made;
 *   2. every archive in that list, present in the directory, has the hash the
 *      list gives — so the files are the ones the list is about.
 *
 *  An archive that is not in the directory is reported and skipped, not failed:
 *  a mirror may carry a subset. One that is there and wrong, or a signature that
 *  does not verify, exits 1. Users without bun do the same with OpenSSL and
 *  sha256sum; see README.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const argv = process.argv.slice(2);
const at = argv.indexOf("--key");
const keyPath = at >= 0 ? argv[at + 1] : undefined;
const dir = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--key")[0] ?? "dist/code-agents";
if (!keyPath) {
  console.error("usage: bun scripts/verify-release.ts --key <public.pem> [dir]");
  process.exit(2);
}

const fail = (message: string): never => {
  console.error(`FAIL  ${message}`);
  process.exit(1);
};

const sums = await readFile(join(dir, "SHA256SUMS")).catch(() => fail(`no SHA256SUMS in ${dir}`));
const signature = await readFile(join(dir, "SHA256SUMS.sig")).catch(() => fail(`no SHA256SUMS.sig in ${dir} — the release is not signed`));
const key = createPublicKey(await readFile(keyPath));

if (!verify(null, sums, key, signature)) fail("SHA256SUMS.sig is not a valid signature of SHA256SUMS by this key");
console.log("ok    SHA256SUMS is signed by this key");

let checked = 0;
let absent = 0;
for (const line of sums.toString("utf8").split("\n")) {
  const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
  if (!m) continue;
  const [, want, file] = m;
  // A name from a signed file is still a name to be careful with: this joins it
  // onto a directory, so nothing but a bare file name is accepted.
  if (file.includes("/") || file.includes("\\") || file === "..") fail(`SHA256SUMS names a path, not a file: ${file}`);
  const bytes = await readFile(join(dir, file)).catch(() => null);
  if (!bytes) {
    absent++;
    console.log(`skip  ${file} (not in ${dir})`);
    continue;
  }
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) fail(`${file} has sha256 ${got}, the signed list says ${want}`);
  checked++;
  console.log(`ok    ${file}`);
}
console.log(`\n${checked} archive(s) match the signed list${absent ? `, ${absent} not present` : ""}.`);
