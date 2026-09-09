/** Checks the commit-graph lane layout against a repository with real merges:
 *  `bun run graph:smoke`.
 *
 *  The load-bearing property is continuity: whatever leaves the bottom of one
 *  row must enter the top of the next, in the same columns. If that holds for
 *  every consecutive pair, the drawing has no broken or invented lines — which
 *  is the only thing that can go visibly wrong in a lane layout.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, startAgent, type Harness } from "./harness.ts";
import { computeGraph, continuationSvg, laneSvg, type GraphRow } from "../src/web/code/graph.ts";
import type { Commit } from "../src/agent/protocol.ts";

const PORT = 5096;
const results: { name: string; ok: boolean; note: string }[] = [];

function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

const root = await mkdtemp(join(tmpdir(), "enc-graph-"));
const commit = async (name: string, message: string): Promise<void> => {
  await writeFile(join(root, name), `${message}\n`, "utf8");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", message);
};

// ── a topology with two merges, a criss-cross and a long-lived side branch ──
await git(root, "init", "-q", "-b", "main");
await git(root, "config", "user.email", "graph@example.com");
await git(root, "config", "user.name", "Graph Test");

await commit("a.txt", "A root");
await commit("b.txt", "B on main");

await git(root, "checkout", "-qb", "feature");
await commit("c.txt", "C on feature");
await commit("d.txt", "D on feature");

await git(root, "checkout", "-q", "main");
await commit("e.txt", "E on main");
await git(root, "merge", "--no-ff", "--no-edit", "-q", "feature");

await git(root, "checkout", "-qb", "topic", "HEAD~2");
await commit("f.txt", "F on topic");

await git(root, "checkout", "-q", "main");
await commit("g.txt", "G on main");
await git(root, "merge", "--no-ff", "--no-edit", "-q", "topic");

// A branch that is never merged, so its lane must stay open to the end.
await git(root, "checkout", "-qb", "dangling", "HEAD~3");
await commit("h.txt", "H dangling");
await git(root, "checkout", "-q", "main");

let h: Harness | null = null;
try {
  h = await startAgent(root, PORT);
  const commits = await h.call<Commit[]>("git.log", { all: true, limit: 100 });
  const rows = computeGraph(commits);

  check("layout produced", rows.length === commits.length && rows.length >= 10, `${rows.length} rows`);

  // 1. Continuity — the property the drawing actually depends on.
  const breaks: string[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const leaving = new Set(rows[i].below);
    const entering = new Set([...rows[i + 1].through, ...rows[i + 1].incoming]);
    const missing = [...leaving].filter((c) => !entering.has(c));
    const extra = [...entering].filter((c) => !leaving.has(c));
    if (missing.length || extra.length) {
      breaks.push(`row ${i}→${i + 1}: dropped=[${missing}] invented=[${extra}] (${commits[i].subject})`);
    }
  }
  check("lane continuity", breaks.length === 0, breaks.length ? breaks.slice(0, 3).join("; ") : `${rows.length - 1} row pairs checked`);

  // 2. Every parent present in the list gets exactly one outgoing edge.
  const index = new Map(commits.map((c, i) => [c.oid, i]));
  const edgeErrors: string[] = [];
  for (let i = 0; i < commits.length; i++) {
    const known = commits[i].parents.filter((p) => index.has(p));
    if (rows[i].outgoing.length !== commits[i].parents.length && known.length === commits[i].parents.length) {
      edgeErrors.push(`${commits[i].subject}: ${rows[i].outgoing.length} edges for ${commits[i].parents.length} parents`);
    }
  }
  check("one outgoing edge per parent", edgeErrors.length === 0, edgeErrors.slice(0, 3).join("; ") || "all commits");

  // 3. Merges are flagged and actually fan out to two lanes.
  const merges = rows.filter((r) => r.merge);
  check(
    "merges fan out",
    merges.length === 2 && merges.every((m) => m.outgoing.length === 2),
    `${merges.length} merges, outgoing=${merges.map((m) => m.outgoing.length).join("/")}`,
  );

  // 4. A merge reuses the lane its second parent already occupies rather than
  //    opening a new column — otherwise the graph widens without bound.
  const widest = Math.max(...rows.map((r) => r.columns));
  check("lane count stays bounded", widest <= 4, `widest row uses ${widest} lanes for ${commits.length} commits`);

  // 5. The dot is always inside the drawn width.
  check("dot within bounds", rows.every((r) => r.lane < r.columns), "lane < columns on every row");

  // 6. The emitted SVG is well-formed: no NaN or Infinity coordinates, one dot
  //    per row, and a path or line for every edge the layout asked for.
  const svgErrors: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const svg = laneSvg(rows[i]);
    const edges = rows[i].through.length + rows[i].incoming.length + rows[i].outgoing.length;
    const drawn = (svg.match(/<line |<path /g) ?? []).length;
    if (/NaN|Infinity|undefined/.test(svg)) svgErrors.push(`row ${i}: bad coordinate`);
    if ((svg.match(/<circle /g) ?? []).length !== 1) svgErrors.push(`row ${i}: expected exactly one dot`);
    if (drawn !== edges) svgErrors.push(`row ${i}: ${drawn} shapes for ${edges} edges`);
    if (/NaN|undefined/.test(continuationSvg(rows[i]))) svgErrors.push(`row ${i}: bad continuation`);
  }
  check("svg output well-formed", svgErrors.length === 0, svgErrors.slice(0, 3).join("; ") || `${rows.length} rows rendered`);

  console.log("\n  topology as laid out:\n");
  console.log(ascii(commits, rows));
} catch (e) {
  check("unexpected error", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  h?.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

/** Rough text rendering, for eyeballing the shape the SVG will draw. */
function ascii(commits: Commit[], rows: GraphRow[]): string {
  return rows
    .map((r, i) => {
      const cells = Array.from({ length: r.columns }, () => " ");
      for (const c of r.through) cells[c] = "|";
      for (const c of r.incoming) if (c !== r.lane) cells[c] = "/";
      for (const c of r.outgoing) if (c !== r.lane) cells[c] = "\\";
      cells[r.lane] = r.merge ? "o" : "*";
      const refs = commits[i].refs ? `  (${commits[i].refs})` : "";
      return `  ${cells.join(" ").padEnd(9)}  ${commits[i].subject}${refs}`;
    })
    .join("\n");
}
