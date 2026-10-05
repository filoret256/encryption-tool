/** The code-agent's process slots, with a connection that closes: `bun run slots:smoke`.
 *
 *  One connection may have a few child processes running, and the rest wait for a turn. What
 *  must hold is the count: never more running than the limit, whatever the order in which work
 *  finishes and connections close. `drain` — the close — used to let the waiters through as if
 *  each had a slot, and then every one of them released a slot it never held.
 */
import { Slots } from "../src/code-agent/slots.ts";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── an ordinary queue ─────────────────────────────────────────────────────

{
  const s = new Slots(2);
  check("the first two take a slot at once", (await s.acquire()) && (await s.acquire()));
  let third: boolean | null = null;
  void s.acquire().then((v) => (third = v));
  await tick();
  check("the third waits", third === null);
  s.release();
  await tick();
  check("a release hands its slot to the one in line", third === true);
}

// ── a connection that closes with work waiting ────────────────────────────

{
  const s = new Slots(2);
  await s.acquire();
  await s.acquire();
  const waiters: (boolean | null)[] = [null, null, null];
  waiters.forEach((_, i) => void s.acquire().then((v) => (waiters[i] = v)));
  await tick();
  check("three wait behind two", waiters.every((w) => w === null));
  s.drain();
  await tick();
  check("a close tells the waiters it is over, and gives them no slot", waiters.every((w) => w === false), JSON.stringify(waiters));
  // The two that were running finish, and give theirs back.
  s.release();
  s.release();
  check("nothing can be taken from a connection that has closed", (await s.acquire()) === false);
}

// ── the count, over a long run ────────────────────────────────────────────

{
  const LIMIT = 4;
  const s = new Slots(LIMIT);
  let running = 0;
  let most = 0;
  const work = async (): Promise<void> => {
    if (!(await s.acquire())) return;
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    running--;
    s.release();
  };
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < 200; i++) jobs.push(work());
  await new Promise((r) => setTimeout(r, 10));
  s.drain(); // the connection closes in the middle of it
  for (let i = 0; i < 50; i++) jobs.push(work()); // requests that arrive after
  await Promise.all(jobs);
  check("never more than the limit running, closing in the middle of a run", most <= LIMIT, `most ${most} of ${LIMIT}`);
  check("everything that started has finished", running === 0);
}

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`${results.length} checks passed: the process slots keep their count when a connection closes`);
