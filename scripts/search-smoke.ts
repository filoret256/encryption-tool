/** Project search and replace: `bun run search:smoke`.
 *
 *  Covers the agent side (streaming hits, the four modifiers, globs,
 *  cancellation) and the pure parts of the client side (preserve case, and the
 *  per-line replacement that `Replace all` is built on).
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, startAgent, type Harness } from "./harness.ts";
import { patternSource, preserveCase, replaceInLine } from "../src/web/code/search-panel.ts";
import type { SearchHit, SearchSummary } from "../src/agent/protocol.ts";

const PORT = 5095;
const results: { name: string; ok: boolean; note: string }[] = [];

function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

const root = await mkdtemp(join(tmpdir(), "enc-search-"));
await mkdir(join(root, "src"), { recursive: true });
await mkdir(join(root, "vendor"), { recursive: true });

await git(root, "init", "-q", "-b", "main");
await git(root, "config", "user.email", "s@example.com");
await git(root, "config", "user.name", "S");
await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");

await writeFile(
  join(root, "src", "a.ts"),
  ["const widget = 1;", "const Widget = 2;", "const WIDGET = 3;", "// widgetFactory is not a whole word", "const other = widget + Widget;"].join("\n"),
  "utf8",
);
await writeFile(join(root, "src", "b.ts"), "export const widget = 'in b';\n", "utf8");
await writeFile(join(root, "vendor", "c.ts"), "const widget = 'vendor';\n", "utf8");
// A multi-byte prefix: ripgrep reports byte offsets, the panel indexes
// characters. Only a non-ASCII line can tell whether that conversion is right.
await writeFile(join(root, "src", "u.ts"), "// комментарий 🔐 про widget здесь\nconst über = 'widget';\n", "utf8");
await writeFile(join(root, "ignored.txt"), "widget widget widget\n", "utf8");
await git(root, "add", "-A");
await git(root, "commit", "-qm", "fixtures");

type Search = { hits: SearchHit[]; summary: SearchSummary };

let h: Harness | null = null;
try {
  h = await startAgent(root, PORT);

  const run = async (params: Record<string, unknown>): Promise<Search> => {
    const call = h!.call<SearchSummary>("search", {
      matchCase: false,
      wholeWord: false,
      regex: false,
      ...params,
    });
    const summary = await call;
    const hits = call.chunks.map((c) => (c as { hit: SearchHit }).hit).filter(Boolean);
    return { hits, summary };
  };

  // ── streaming and the ignore rules ──
  const all = await run({ query: "widget" });
  const paths = [...new Set(all.hits.map((x) => x.path))].sort();
  // One hit is one line, which may hold several matches — so the summary counts
  // ranges, not hits.
  const streamed = all.hits.reduce((n, x) => n + x.ranges.length, 0);
  check(
    "streams hits, honours .gitignore",
    streamed === all.summary.matches && !paths.includes("ignored.txt") && paths.length === 4,
    `${all.summary.matches} matches on ${all.hits.length} lines in ${paths.join(", ")} via ${all.summary.engine}`,
  );

  // ── modifiers ──
  const cased = await run({ query: "Widget", matchCase: true });
  check(
    "match case",
    cased.hits.every((x) => x.ranges.every(([s, e]) => cased.hits.length && x.text.slice(s, e) === "Widget")),
    `${cased.summary.matches} matches, all exactly "Widget"`,
  );

  const insensitive = await run({ query: "WIDGET" });
  check("case-insensitive by default", insensitive.summary.matches > cased.summary.matches, `${insensitive.summary.matches} vs ${cased.summary.matches}`);

  const word = await run({ query: "widget", wholeWord: true, matchCase: true });
  const factoryHit = word.hits.some((x) => x.ranges.some(([s]) => x.text.slice(s, s + 14) === "widgetFactory"));
  check("whole word", !factoryHit, `widgetFactory excluded, ${word.summary.matches} matches`);

  const re = await run({ query: "const (\\w+) = \\d", regex: true });
  check("regex", re.summary.matches === 3 && re.hits.every((x) => /^const \w+ = \d/.test(x.text.trim())), `${re.summary.matches} matches`);

  // ── globs ──
  const included = await run({ query: "widget", include: "src/**" });
  check(
    "include glob",
    included.hits.every((x) => x.path.startsWith("src/")) && included.summary.files === 3,
    `${included.summary.files} files, all under src/`,
  );

  const excluded = await run({ query: "widget", exclude: "vendor/**" });
  check("exclude glob", !excluded.hits.some((x) => x.path.startsWith("vendor/")), `${excluded.summary.files} files, vendor/ dropped`);

  // ── ranges point at the real match ──
  const first = all.hits[0];
  check(
    "ranges align with the line text",
    all.hits.every((x) => x.ranges.every(([s, e]) => x.text.slice(s, e).toLowerCase() === "widget")),
    `e.g. ${first.path}:${first.line} "${first.text.slice(first.ranges[0][0], first.ranges[0][1])}"`,
  );

  // ── non-ASCII offsets ──
  const uni = await run({ query: "widget" });
  const uniHits = uni.hits.filter((x) => x.path === "src/u.ts");
  check(
    "offsets survive multi-byte characters",
    uniHits.length === 2 && uniHits.every((x) => x.ranges.every(([a, b]) => x.text.slice(a, b).toLowerCase() === "widget")),
    uniHits.map((x) => `${x.line}:${x.ranges[0][0]} -> "${x.text.slice(x.ranges[0][0], x.ranges[0][1])}"`).join(", "),
  );

  // ── the two engines must agree ──
  // Start a second agent with ripgrep filtered out of PATH so it falls back to
  // the `git ls-files` walk, then compare the two result sets hit for hit.
  // Skipped, loudly, when ripgrep is not installed — there is nothing to compare
  // against and the rest of the suite must still run anywhere.
  if (uni.summary.engine !== "ripgrep") {
    check("ripgrep and the fallback return identical hits", true, "SKIPPED — ripgrep is not installed, only the fallback was exercised");
  } else {
    const strippedPath = (process.env.PATH ?? "")
      .split(";")
      .filter((dir) => !/ripgrep/i.test(dir))
      .join(";");
    const other = await startAgent(root, PORT + 1, {
      ...(process.env as Record<string, string>),
      PATH: strippedPath,
      Path: strippedPath, // Windows env keys are case-insensitive; Bun's map is not
    });
    try {
      const shape = (hits: SearchHit[]): string =>
        hits
          .map((x) => `${x.path}:${x.line}:${x.ranges.map((r) => r.join("-")).join(",")}:${x.text}`)
          .sort()
          .join("|");

      const b = other.call<SearchSummary>("search", { query: "widget", matchCase: false, wholeWord: false, regex: false });
      const bSummary = await b;
      const bHits = b.chunks.map((c) => (c as { hit: SearchHit }).hit).filter(Boolean);

      check("the two engines are actually different", bSummary.engine === "fallback", `${uni.summary.engine} vs ${bSummary.engine}`);
      check(
        "ripgrep and the fallback return identical hits",
        shape(uni.hits) === shape(bHits) && uni.summary.matches === bSummary.matches,
        `${uni.summary.matches} matches each, identical ranges and text`,
      );
    } finally {
      other.close();
    }
  }

  // ── cancellation ──
  // Frames are processed in order and the signal is registered synchronously,
  // so the cancel always lands while the scan is still between files.
  const broad = h.call<SearchSummary>("search", { query: "e", matchCase: false, wholeWord: false, regex: false });
  const cancelled = await h.call<{ cancelled: boolean }>("cancel", { target: broad.id });
  const broadSummary = await broad;
  check(
    "cancel stops a running scan",
    cancelled.cancelled && broadSummary.truncated,
    `cancelled=${cancelled.cancelled}, truncated=${broadSummary.truncated}, ${broadSummary.matches} matches before stopping`,
  );
  const unknown = await h.call<{ cancelled: boolean }>("cancel", { target: 99999 });
  check("cancel of an unknown id is harmless", unknown.cancelled === false, "reports false, does not throw");

  // ── replace, end to end on a real file ──
  const target = await run({ query: "widget", matchCase: true, wholeWord: true });
  const aHits = target.hits.filter((x) => x.path === "src/a.ts");
  const original = await readFile(join(root, "src", "a.ts"), "utf8");
  const parts = original.split(/(\r?\n)/);
  let applied = 0;
  for (const hit of aHits) {
    const idx = (hit.line - 1) * 2;
    const out = replaceInLine(parts[idx], hit.ranges, "gadget", { regex: null, preserveCase: false });
    parts[idx] = out.line;
    applied += out.count;
  }
  await h.call("fs.write", { path: "src/a.ts", text: parts.join("") });
  const after = await run({ query: "widget", matchCase: true, wholeWord: true });
  check(
    "replace all in a file",
    applied === aHits.reduce((n, x) => n + x.ranges.length, 0) && !after.hits.some((x) => x.path === "src/a.ts"),
    `${applied} replaced, src/a.ts now clean`,
  );

  const rewritten = await readFile(join(root, "src", "a.ts"), "utf8");
  check(
    "untouched text preserved",
    rewritten.includes("const Widget = 2;") && rewritten.includes("widgetFactory") && rewritten.split("\n").length === original.split("\n").length,
    "other lines and line count unchanged",
  );
} catch (e) {
  check("unexpected error", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  h?.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

// ── pure client-side logic ────────────────────────────────────────────────

const caseCases: [string, string, string][] = [
  ["widget", "gadget", "gadget"],
  ["Widget", "gadget", "Gadget"],
  ["WIDGET", "gadget", "GADGET"],
  ["WiDgEt", "gadget", "gadget"], // mixed case is left as typed
  ["widget", "Gadget", "gadget"],
];
check(
  "preserve case",
  caseCases.every(([found, rep, want]) => preserveCase(found, rep) === want),
  caseCases.map(([f, r, w]) => `${f}→${preserveCase(f, r)}(want ${w})`).join(", "),
);

const multi = replaceInLine("aa bb aa", [[0, 2], [6, 8]], "xxx", { regex: null, preserveCase: false });
check("multiple ranges on one line", multi.line === "xxx bb xxx" && multi.count === 2, `"${multi.line}"`);

const backref = replaceInLine("const foo = 1", [[0, 13]], "let $1 = 1", {
  regex: new RegExp(patternSource("const (\\w+) = \\d", { matchCase: true, wholeWord: false, regex: true, preserveCase: false })),
  preserveCase: false,
});
check("regex backreference", backref.line === "let foo = 1", `"${backref.line}"`);

const grow = replaceInLine("ab ab", [[0, 2], [3, 5]], "cdef", { regex: null, preserveCase: false });
check("offsets survive a growing replacement", grow.line === "cdef cdef", `"${grow.line}"`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
