/** Base-image pins: `bun scripts/pin-images.ts [--write]`.
 *
 *  The Dockerfile names each base image by tag *and* digest, so that a build
 *  pulls exactly what was reviewed and not whatever the tag has come to mean. A
 *  pin that nothing ever moves stops getting security fixes, so this is how it is
 *  moved on purpose: it asks the registry what each tag points at today, says
 *  which pins are behind, and with --write rewrites them.
 *
 *  Without --write it changes nothing and exits 1 if any pin is out of date —
 *  fit for a scheduled job that opens a reminder rather than a surprise.
 *
 *  Docker Hub only, which is where every image here lives. The digest is the
 *  index of the multi-arch image, so the pin holds on amd64 and arm64 alike.
 */
import { readFile, writeFile } from "node:fs/promises";

const PATH = "Dockerfile";
const write = process.argv.includes("--write");

// `FROM image:tag[@sha256:…]` and `COPY --from=image:tag[@sha256:…]`
const REF = /(?<=\bFROM\s+|--from=)([a-z0-9][a-z0-9._\/-]*):([A-Za-z0-9._-]+)(?:@(sha256:[0-9a-f]{64}))?/g;

async function digestOf(image: string, tag: string): Promise<string> {
  const repo = image.includes("/") ? image : `library/${image}`;
  const token = (await (await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`)).json()) as {
    token: string;
  };
  const res = await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, {
    method: "HEAD",
    headers: {
      authorization: `Bearer ${token.token}`,
      accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
    },
  });
  const digest = res.headers.get("docker-content-digest");
  if (!res.ok || !digest) throw new Error(`${image}:${tag}: registry answered ${res.status}`);
  return digest;
}

const original = await readFile(PATH, "utf8");
const seen = new Map<string, string>();
for (const m of original.matchAll(REF)) seen.set(`${m[1]}:${m[2]}`, m[3] ?? "(none)");

let behind = 0;
const fresh = new Map<string, string>();
for (const [ref, pinned] of seen) {
  const [image, tag] = ref.split(":");
  const now = await digestOf(image, tag);
  fresh.set(ref, now);
  const state = pinned === now ? "current" : pinned === "(none)" ? "not pinned" : "BEHIND";
  if (pinned !== now) behind++;
  console.log(`${state.padEnd(10)} ${ref.padEnd(30)} ${pinned === now ? now : `${pinned} -> ${now}`}`);
}

if (write && behind) {
  const updated = original.replace(REF, (_all, image: string, tag: string) => `${image}:${tag}@${fresh.get(`${image}:${tag}`)}`);
  await writeFile(PATH, updated);
  console.log(`\n${behind} pin(s) rewritten in ${PATH}. Review the diff, then rebuild.`);
} else if (behind) {
  console.log(`\n${behind} pin(s) out of date. Run with --write to update ${PATH}.`);
}
process.exit(!write && behind ? 1 : 0);
