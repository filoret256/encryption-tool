/** Exercises every git operation the source-control panel and history view
 *  issue, against a throwaway repository: `bun run git:smoke`.
 *
 *  The panels are thin DOM over these calls, so this is where the real risk
 *  lives — parsing git's machine formats and getting the mutation semantics
 *  right. Nothing here touches the working repository.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@codemirror/state";
import { git, startAgent, type Harness } from "./harness.ts";
import { findConflicts } from "../src/web/code/conflicts.ts";
import type { Branch, Commit, CommitDetail, DiffPair, FileRead, GitStatus } from "../src/agent/protocol.ts";

const PORT = 5097;
const results: { name: string; ok: boolean; note: string }[] = [];

function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

const root = await mkdtemp(join(tmpdir(), "enc-git-"));
const w = (name: string, body: string): Promise<void> => writeFile(join(root, name), body, "utf8");

// ── fixture: two commits on main, a divergent branch, mixed working state ──
await git(root, "init", "-q", "-b", "main");
await git(root, "config", "user.email", "smoke@example.com");
await git(root, "config", "user.name", "Smoke Test");
await w("app.ts", "export const version = '1.0.0';\n");
await w("README.md", "# demo\n");
await git(root, "add", "-A");
await git(root, "commit", "-qm", "initial commit");

await git(root, "checkout", "-qb", "feature");
await w("greet.ts", "export const greet = () => 'hi';\n");
await git(root, "add", "-A");
await git(root, "commit", "-qm", "add greet");
await git(root, "checkout", "-q", "main");

await w("app.ts", "export const version = '1.1.0';\n");
await git(root, "add", "app.ts");
await w("app.ts", "export const version = '1.1.0';\nexport const extra = true;\n");
await w("notes.txt", "untracked scratch\n");

let h: Harness | null = null;
try {
  h = await startAgent(root, PORT);
  const call = h.call.bind(h);

  // ── status: the four groups the panel renders ──
  const st = await call<GitStatus>("git.status");
  const byPath = new Map(st.entries.map((e) => [e.path, e]));
  const app = byPath.get("app.ts");
  check(
    "status groups",
    st.branch === "main" && app?.index === "M" && app?.work === "M" && byPath.get("notes.txt")?.untracked === true,
    `branch=${st.branch} app.ts=${app?.index}${app?.work} untracked=${[...byPath.values()].filter((e) => e.untracked).length}`,
  );

  // ── diffs: the three kinds the UI can ask for ──
  const wt = await call<DiffPair>("git.diff", { path: "app.ts", kind: "worktree" });
  check("diff worktree", wt.before !== wt.after && wt.after?.includes("extra") === true, `${wt.beforeLabel} → ${wt.afterLabel}`);

  const staged = await call<DiffPair>("git.diff", { path: "app.ts", kind: "staged" });
  check(
    "diff staged",
    staged.before?.includes("1.0.0") === true && staged.after?.includes("1.1.0") === true,
    `${staged.beforeLabel} → ${staged.afterLabel}`,
  );

  // ── stage / unstage round trip ──
  await call("git.unstage", { paths: ["app.ts"] });
  const afterUnstage = await call<GitStatus>("git.status");
  check("unstage", afterUnstage.entries.find((e) => e.path === "app.ts")?.index === ".", "index entry cleared");

  await call("git.stage", { paths: ["app.ts", "notes.txt"] });
  const afterStage = await call<GitStatus>("git.status");
  check(
    "stage",
    afterStage.entries.every((e) => e.path === "app.ts" || e.path === "notes.txt") &&
      afterStage.entries.every((e) => e.index !== "." && !e.untracked),
    `${afterStage.entries.length} staged, none untracked`,
  );

  // ── commit + history ──
  await call("git.commit", { message: "smoke: stage and commit" });
  const log = await call<Commit[]>("git.log", { limit: 10 });
  check("commit", log[0]?.subject === "smoke: stage and commit", `head="${log[0]?.subject}"`);

  const detail = await call<CommitDetail>("git.commitDetail", { oid: log[0].oid });
  const names = detail.files.map((f) => f.path).sort();
  check(
    "commitDetail",
    names.join(",") === "app.ts,notes.txt" && detail.files.every((f) => f.added > 0 || f.deleted > 0 || f.status === "A"),
    `${names.join(", ")}`,
  );

  const commitDiff = await call<DiffPair>("git.diff", { path: "app.ts", kind: log[0].oid });
  check("diff of a commit", commitDiff.before?.includes("1.0.0") === true && commitDiff.after?.includes("extra") === true, "parent vs commit");

  // "Compare with HEAD" from the explorer: last commit vs what is on disk now.
  await w("app.ts", "export const version = '1.1.0';\nexport const extra = true;\n// local edit\n");
  const headDiff = await call<DiffPair>("git.diff", { path: "app.ts", kind: "head" });
  check(
    "diff against HEAD",
    headDiff.before?.includes("local edit") === false && headDiff.after?.includes("local edit") === true,
    `${headDiff.beforeLabel} → ${headDiff.afterLabel}`,
  );
  await git(root, "checkout", "--", "app.ts");

  // ── branches ──
  const branches = await call<Branch[]>("git.branches");
  check(
    "branches",
    branches.length === 2 && branches.find((b) => b.name === "main")?.head === true,
    branches.map((b) => `${b.head ? "*" : ""}${b.name}`).join(", "),
  );

  await call("git.branchCreate", { name: "topic" });
  await call("git.checkout", { ref: "main" });
  check("branchCreate + checkout", (await call<GitStatus>("git.status")).branch === "main", "back on main");

  // ── merge that conflicts, then abort ──
  await call("git.checkout", { ref: "feature" });
  await w("app.ts", "export const version = 'FEATURE';\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "feature edits app");
  await call("git.checkout", { ref: "main" });

  const merged = await call<{ conflict: boolean; output: string }>("git.merge", { ref: "feature" });
  const conflicted = await call<GitStatus>("git.status");
  check(
    "merge reports conflict as data",
    merged.conflict === true && conflicted.entries.some((e) => e.conflict),
    `conflict=${merged.conflict}, ${conflicted.entries.filter((e) => e.conflict).length} conflicted file(s)`,
  );

  // The conflict markers the editor has to parse are the ones git just wrote —
  // so parse those, not a hand-written fixture.
  const conflictedFile = await call<FileRead>("fs.read", { path: "app.ts" });
  // Split the way CodeMirror does, so the parser sees exactly what the editor
  // would hand it.
  const conflictDoc = Text.of((conflictedFile.text ?? "").split(/\r\n|\r|\n/));
  const regions = findConflicts(conflictDoc);
  check(
    "conflict markers parse as the editor sees them",
    regions.length === 1 && regions[0].ours.includes("1.1.0") && regions[0].theirs.includes("FEATURE"),
    regions.length === 1
      ? `ours="${regions[0].ours.trim()}" theirs="${regions[0].theirs.trim()}" labels=${regions[0].oursLabel}/${regions[0].theirsLabel}`
      : `${regions.length} regions found`,
  );

  // Accepting a side must leave a file with no markers left.
  const whole = conflictDoc.toString();
  const accepted = whole.slice(0, regions[0].from) + regions[0].theirs + whole.slice(regions[0].to);
  check(
    "accepting a side removes the region",
    findConflicts(Text.of(accepted.split(/\r\n|\r|\n/))).length === 0 && accepted.includes("FEATURE"),
    "no markers remain",
  );

  await call("git.mergeAbort");
  check("mergeAbort", (await call<GitStatus>("git.status")).entries.every((e) => !e.conflict), "worktree clean of conflicts");

  // ── stash round trip ──
  await w("app.ts", "export const version = 'stash me';\n");
  await call("git.stash", { action: "push" });
  const afterStash = await call<GitStatus>("git.status");
  await call("git.stash", { action: "pop" });
  const afterPop = await call<GitStatus>("git.status");
  check(
    "stash push/pop",
    afterStash.entries.length === 0 && afterPop.entries.length > 0,
    `clean after push (${afterStash.entries.length}), dirty after pop (${afterPop.entries.length})`,
  );

  // ── revert and reset, which isomorphic-git has no equivalent for ──
  await git(root, "checkout", "--", ".");
  const headBefore = (await call<Commit[]>("git.log", { limit: 1 }))[0].oid;
  await call("git.revert", { oid: headBefore });
  const afterRevert = await call<Commit[]>("git.log", { limit: 2 });
  check("revert", afterRevert[0].parents[0] === headBefore && /revert/i.test(afterRevert[0].subject), afterRevert[0].subject);

  await call("git.reset", { oid: headBefore, mode: "hard" });
  check("reset --hard", (await call<Commit[]>("git.log", { limit: 1 }))[0].oid === headBefore, "HEAD moved back");

  // ── rebase, absent from isomorphic-git entirely ──
  await call("git.checkout", { ref: "topic" });
  await w("topic.txt", "topic work\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "topic work");
  const rebased = await call<{ conflict: boolean; output: string }>("git.rebase", { action: "start", ref: "main" });
  const topicLog = await call<Commit[]>("git.log", { limit: 5 });
  check(
    "rebase onto main",
    rebased.conflict === false && topicLog[0].subject === "topic work",
    `head="${topicLog[0].subject}", ${topicLog.length} commits`,
  );

  // ── blame ──
  const blame = await call<{ oid: string; author: string; line: number }[]>("git.blame", { path: "README.md" });
  check("blame", blame.length > 0 && /^[0-9a-f]{40}$/.test(blame[0]?.oid ?? ""), `${blame.length} line(s), author=${blame[0]?.author}`);
} catch (e) {
  check("unexpected error", false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
} finally {
  h?.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
