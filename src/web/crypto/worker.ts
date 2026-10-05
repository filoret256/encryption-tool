/** The worker's side: take a job, run it, answer.
 *
 *  Ansible Vault is a double hex encoding, so a 10 MiB buffer becomes ~40 MiB of envelope,
 *  and building it — even with the fast hex in crypto/bytes.ts — is work the thread that
 *  draws must not be doing: measured before this, encrypting 10 MiB blocked the page for
 *  2.8–7 s with no progress and no way to stop it, and 20 MiB took the process's memory
 *  with it (OOM-killed on the stand). Here it blocks nothing; the page shows a busy button
 *  and stays responsive.
 *
 *  Base64 and YAML beautify ride the same worker, for the same reason at a smaller scale:
 *  both walk the whole buffer, and on the main thread they are the difference between a
 *  button and a stall.
 *
 *  Six lines of protocol, and no secrets leave the machine: the password arrives in a
 *  message and the envelope goes back in one, both between this worker and the page.
 *  Nothing is sent anywhere — the worker is `worker-src 'self'`, and the server has no
 *  crypto endpoint to send it to.
 */
import { runJobHere, type Job } from "../worker-jobs.ts";

/** The worker scope, declared locally: this project compiles against the DOM lib, where
 *  `self` is a Window and `postMessage` wants a target origin. */
interface WorkerScope {
  onmessage: ((ev: MessageEvent<Job>) => void) | null;
  postMessage(message: unknown): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (ev: MessageEvent<Job>) => {
  const job = ev.data;
  void (async () => {
    try {
      const out = await runJobHere(job);
      scope.postMessage({ id: job.id, ok: true, out });
    } catch (e) {
      // The scheme's own words: "Invalid password or corrupted data" is the useful one.
      scope.postMessage({ id: job.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
};
