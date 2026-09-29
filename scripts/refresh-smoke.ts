/** Refresh coalescing: `bun run refresh:smoke`.
 *
 *  The code tab refreshes its panels on what the file watcher reports. These
 *  checks pin the property that keeps a burst of reports from becoming a burst
 *  of `git status` runs — see src/web/code/singleflight.ts — and, as important,
 *  the one that keeps coalescing from serving a stale answer.
 */
import { singleFlight } from "../src/web/code/singleflight.ts";

const results: { name: string; ok: boolean; note: string }[] = [];
function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── an idle call runs at once, and once ──
{
  let runs = 0;
  const flight = singleFlight(async () => void runs++);
  await flight();
  await flight();
  check("calls with nothing in flight each run", runs === 2, `${runs} runs for 2 sequential calls`);
}

// ── a storm becomes two runs ──
{
  let runs = 0;
  let live = 0;
  let overlapped = false;
  const flight = singleFlight(async () => {
    runs++;
    if (++live > 1) overlapped = true;
    await sleep(40);
    live--;
  });
  const calls = Array.from({ length: 500 }, () => flight());
  await Promise.all(calls);
  check("500 calls during one run cost two runs, not 500", runs === 2, `${runs} runs`);
  check("two runs never overlap", !overlapped, overlapped ? "two were live at once" : "at most one live");
}

// ── the answer is never older than the call ──
{
  // The run reads the world when it starts. A caller that has just changed the
  // world and awaits the flight must get a run that started after the change.
  let world = 0;
  const seen: number[] = [];
  const flight = singleFlight(async () => {
    seen.push(world);
    await sleep(30);
  });
  const first = flight(); // starts now, sees world = 0
  world = 1; // something changes while it runs
  await flight(); // the caller who changed it awaits
  check("a caller after a change is not answered by a run that began before it", seen.length === 2 && seen[1] === 1, `runs saw ${JSON.stringify(seen)}`);
  await first;

  // And callers that arrive before the queued run starts share it.
  let count = 0;
  const shared = singleFlight(async () => {
    count++;
    await sleep(30);
  });
  const a = shared();
  const b = shared();
  const c = shared();
  await Promise.all([a, b, c]);
  check("callers arriving before the queued run starts share it", count === 2, `${count} runs for 3 calls`);
}

// ── errors belong to their own run ──
{
  let n = 0;
  const flight = singleFlight(async () => {
    n++;
    await sleep(20);
    if (n === 1) throw new Error("first run failed");
  });
  const first = flight().then(() => "ok", (e: Error) => e.message);
  const second = flight().then(() => "ok", (e: Error) => e.message);
  const [a, b] = await Promise.all([first, second]);
  check("a failed run does not cancel the queued one", n === 2 && a === "first run failed" && b === "ok", `first: ${a}, second: ${b}, ${n} runs`);
  const after = await flight().then(() => "ok", (e: Error) => e.message);
  check("and the flight is usable afterwards", after === "ok" && n === 3, `${n} runs`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
