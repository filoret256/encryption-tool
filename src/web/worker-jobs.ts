/** The work the page hands to a worker, and the copy it runs when there is none.
 *
 *  One module, two callers: `crypto/worker.ts` runs these in the worker, and
 *  `crypto/offload.ts` runs the same functions on the main thread when the worker cannot
 *  be started. Keeping them here is what stops the fallback from drifting away from the
 *  real thing — the old base64 and beautify lived in main.ts and ran only on the main
 *  thread, so a 10 MB buffer was seconds of a page that answered nothing.
 *
 *  Nothing here touches the DOM, and nothing here is allowed to: it has to run in a worker.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ansible, helm } from "../crypto/index.ts";

export type CryptoTab = "ansible" | "helm";
export type CryptoAction = "encrypt" | "decrypt";

/** One job, and the shape of its answer: always a string. */
export type Job =
  | { id: number; kind: "crypto"; tab: CryptoTab; action: CryptoAction; text: string; password: string }
  | { id: number; kind: "b64encode"; text: string; unix: boolean }
  | { id: number; kind: "b64decode"; text: string }
  | { id: number; kind: "beautify"; text: string };

/** A job as the caller describes it: the page hands out the ids. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type JobSpec = DistributiveOmit<Job, "id">;

const SCHEMES = { ansible, helm };

/** Bytes to a binary string, in chunks.
 *
 *  Spreading a large Uint8Array into `String.fromCharCode(...)` overflows the call stack
 *  on big inputs, and `btoa` wants a binary string, so this is the way in. */
function bytesToBinary(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return parts.join("");
}

/** Base64 of a text buffer. `unix` is the button that means "and make the line endings
 *  Unix first", which is why the replacement happens before the encoding. */
function encodeBase64(text: string, unix: boolean): string {
  const bytes = new TextEncoder().encode(unix ? text.replace(/\r\n/g, "\n") : text);
  return btoa(bytesToBinary(bytes));
}

/** And back.
 *
 *  Not `Uint8Array.from(bin, (c) => c.charCodeAt(0))`: that calls a function once per byte,
 *  so a 10 MB buffer is ten million calls and a few hundred milliseconds of whatever thread
 *  it is on. A loop over a typed array is the same work without the closures. */
function decodeBase64(text: string): string {
  const bin = atob(text.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Run one job on this thread. Rejects with the scheme's own words for a crypto job —
 *  "Invalid password or corrupted data" is the useful one. */
export async function runJobHere(job: Job): Promise<string> {
  switch (job.kind) {
    case "crypto":
      return SCHEMES[job.tab][job.action](job.text, job.password);
    case "b64encode":
      return encodeBase64(job.text, job.unix);
    case "b64decode":
      return decodeBase64(job.text);
    case "beautify":
      return stringifyYaml(parseYaml(job.text), { indent: 2 });
  }
}
