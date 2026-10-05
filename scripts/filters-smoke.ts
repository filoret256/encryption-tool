/** The filters over long lists, without a browser: `bun run filters:smoke`.
 *
 *  "Go to file" ranks up to twenty thousand paths on a keystroke; the explorer and the history
 *  filter walk whole lists. The ranking must give what it always gave — the same fifty paths in
 *  the same order — only faster, and the pause before a filter runs must collapse a burst of
 *  keystrokes into one run, and run at once when asked to.
 */
import { debounce } from "../src/web/code/debounce.ts";
import { hunkPatches } from "../src/web/code/hunkpatch.ts";
import { rankPaths } from "../src/web/code/quickrank.ts";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

// ── the ranking is the old ranking ────────────────────────────────────────

/** What the page did before: score every path (lower-casing it and the query each time), keep the
 *  matches, sort them all, take the first fifty. */
function reference(all: string[], query: string): string[] {
  const score = (path: string): number => {
    const haystack = path.toLowerCase();
    const needle = query.toLowerCase();
    const direct = haystack.lastIndexOf(needle);
    if (direct !== -1) return 1000 - (haystack.length - direct);
    let at = -1;
    for (const ch of needle) {
      at = haystack.indexOf(ch, at + 1);
      if (at === -1) return -1;
    }
    return 500 - haystack.length;
  };
  return all
    .map((p) => ({ p, s: score(p) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 50)
    .map((r) => r.p);
}

let seed = 12345;
const rnd = (n: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const words = ["src", "web", "code", "index", "tree", "Main", "util", "test", "kafka", "agent", "Docs", "READ", "me", "lib", "app"];
const exts = [".ts", ".go", ".md", ".json", ".yaml", ".css"];
const all: string[] = [];
for (let i = 0; i < 20000; i++) {
  const depth = 1 + rnd(5);
  const parts: string[] = [];
  for (let d = 0; d < depth; d++) parts.push(words[rnd(words.length)] + (rnd(4) === 0 ? String(rnd(50)) : ""));
  all.push(parts.join("/") + exts[rnd(exts.length)]);
}
const lower = all.map((p) => p.toLowerCase());

for (const q of ["w", "ind", "wcdx", "SRC/web", "kafka.go", "zzz", "me", ".ts", "docs/readme"]) {
  const want = reference(all, q);
  const got = rankPaths(all, lower, q, 50);
  check(`the same fifty for "${q}"`, want.length === got.length && want.every((p, i) => p === got[i]), `${got.length} matches shown`);
}

const time = (f: () => void, n = 5): number => {
  f();
  const t = performance.now();
  for (let i = 0; i < n; i++) f();
  return (performance.now() - t) / n;
};
const before = time(() => reference(all, "wcdx"));
const after = time(() => rankPaths(all, lower, "wcdx", 50));
check("faster than the old ranking on 20,000 paths", after < before, `${before.toFixed(1)} ms → ${after.toFixed(1)} ms for one query`);

// ── the pause ─────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
{
  let runs = 0;
  const d = debounce(() => runs++, 30);
  for (let i = 0; i < 10; i++) d();
  check("a burst of calls is not run yet", runs === 0);
  await sleep(60);
  check("and is run once when it stops", runs === 1, String(runs));
  d();
  d.flush();
  check("flush runs a pending call now", runs === 2);
  await sleep(60);
  check("and it is not run again after", runs === 2);
  d();
  d.cancel();
  await sleep(60);
  check("cancel drops a pending call", runs === 2);
  d.flush();
  check("flush with nothing pending does nothing", runs === 2);
}

// ── one diff per pair of texts ─────────────────────────────────────────────

{
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const after = before.replace("line 50\n", "line fifty\n").replace("line 150\n", "line one-fifty\n");
  const first = hunkPatches("a.txt", before, after);
  const again = hunkPatches("a.txt", before, after);
  check("the patches of a pair are made once: the second ask is the first answer", first === again && first.length === 2, `${first.length} patches`);
  const other = hunkPatches("a.txt", before, after.replace("fifty", "FIFTY"));
  check("another pair is made again", other !== first && other[0].includes("FIFTY"));
  check("the patches of a pair do not change when it is asked for again after another", hunkPatches("a.txt", before, after)[0] === first[0]);
}

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`${results.length} checks passed: the ranking is unchanged and the pause behaves`);
