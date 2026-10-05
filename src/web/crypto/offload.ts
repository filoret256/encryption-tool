/** Ask the worker to do the work, or — if it cannot be started — do it here.
 *
 *  The page hands the job over and awaits a message; the thread that draws stays free, so
 *  a 10 MiB vault is a busy button rather than a frozen tab. The fallback is not politeness:
 *  a shell cached from before this file existed, a browser without module workers, or a
 *  policy that refuses the worker all leave a page that must still encrypt. In that case the
 *  work happens on the main thread exactly as it did before, and the size limit in main.ts
 *  is what keeps that from being a hang.
 *
 *  Every job the page offloads goes through here — crypto, base64 and YAML beautify alike —
 *  so there is one worker, one queue and one fallback.
 */
import { runJobHere, type Job, type JobSpec } from "../worker-jobs.ts";

/** Where the built worker lives. Fixed name, like every other asset: the compiled binary
 *  embeds it by path (src/server.ts). */
const WORKER_URL = "/public/crypto-worker.js";

interface Reply {
  id: number;
  ok: boolean;
  out?: string;
  error?: string;
}

/** The most text the page will work through itself, in characters. A job this big takes seconds
 *  on the thread that draws, and a page that answers nothing for that long is worse than a refusal
 *  that says why. The worker has no such limit: the limits in main.ts are about memory. */
export const MAX_HERE_CHARS = 4 * 1024 * 1024;

/** The fallback, with its limit: a worker that is gone must not turn a 16 MB buffer into a hang. */
function runHere(job: Job): Promise<string> {
  const size = "text" in job ? job.text.length : 0;
  if (size > MAX_HERE_CHARS) {
    const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
    return Promise.reject(
      new Error(
        `The background worker is not running, and this text (${mb(size)} M characters) is too big to work through on the page, which takes ${mb(MAX_HERE_CHARS)} M. Reload the page, or work in smaller parts.`,
      ),
    );
  }
  return runJobHere(job);
}

let worker: Worker | null = null;
/** Set when the worker could not be started or died: from then on everything runs here. */
let broken = false;
let nextId = 1;
const waiting = new Map<number, { job: Job; resolve: (out: string) => void; reject: (e: Error) => void }>();

function start(): Worker | null {
  if (worker || broken) return worker;
  try {
    worker = new Worker(WORKER_URL, { type: "module" });
  } catch {
    broken = true;
    return null;
  }
  worker.onmessage = (ev: MessageEvent<Reply>) => {
    const reply = ev.data;
    const slot = waiting.get(reply.id);
    if (!slot) return;
    waiting.delete(reply.id);
    if (reply.ok) slot.resolve(reply.out ?? "");
    else slot.reject(new Error(reply.error || "the worker refused the job"));
  };
  // A worker that fails to load fires `error` and never answers anything. Its jobs are done
  // here instead, so a missing asset costs speed and not the feature.
  worker.onerror = () => {
    broken = true;
    const orphaned = [...waiting.values()];
    waiting.clear();
    const dead = worker;
    worker = null;
    dead?.terminate();
    for (const slot of orphaned) {
      void runHere(slot.job).then(slot.resolve, slot.reject);
    }
  };
  return worker;
}

/** Run one job, off this thread when there is a worker to run it. Resolves with the
 *  result, rejects with the job's own message — "Invalid password or corrupted data" for
 *  the wrong password, the browser's own words for base64 that is not base64. */
export function runOffload(spec: JobSpec): Promise<string> {
  const job = { ...spec, id: nextId++ } as Job;
  const live = start();
  if (!live) return runHere(job);
  return new Promise<string>((resolve, reject) => {
    waiting.set(job.id, { job, resolve, reject });
    live.postMessage(job);
  });
}
