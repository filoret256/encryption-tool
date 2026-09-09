/** Git mutations and remote operations.
 *
 *  Two rules hold throughout:
 *   - no value coming from the client may start with "-", or git would read it
 *     as an option (`--upload-pack=…`, `-c core.sshCommand=…` are the sharp
 *     ones); `safe()` rejects those before the spawn;
 *   - paths are always passed after `--`.
 *
 *  Credentials are deliberately absent: the system git picks up the platform
 *  credential helper and the user's SSH agent, so no token ever reaches this
 *  process or the browser.
 */
import { run, runLines } from "./proc.ts";
import { GitError } from "./git.ts";

/** Reject option-looking values; everything else git treats as data. */
function safe(v: unknown, what: string): string {
  const s = String(v ?? "");
  if (s === "" || s.startsWith("-")) throw new GitError(`Invalid ${what}: ${s}`);
  return s;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await run(["git", ...args], cwd);
  if (r.code !== 0) throw new GitError(r.stderr || r.stdout);
  return r.stdout;
}

// ── index ─────────────────────────────────────────────────────────────────

export const stage = (cwd: string, paths: string[]) =>
  git(cwd, ["add", "--", ...paths.map((p) => safe(p, "path"))]);

/** Unstage. On an unborn branch there is no HEAD to reset against, so fall
 *  back to removing the entry from the index outright. */
export async function unstage(cwd: string, paths: string[]): Promise<string> {
  const p = paths.map((x) => safe(x, "path"));
  const r = await run(["git", "restore", "--staged", "--", ...p], cwd);
  if (r.code === 0) return r.stdout;
  return git(cwd, ["rm", "--cached", "-r", "--", ...p]);
}

/** Throw away worktree changes. Staged-but-untracked files are deleted. */
export const discard = (cwd: string, paths: string[]) =>
  git(cwd, ["checkout", "--", ...paths.map((p) => safe(p, "path"))]);

export async function commit(
  cwd: string,
  opts: { message: string; amend?: boolean; all?: boolean },
): Promise<string> {
  if (!opts.message.trim() && !opts.amend) throw new GitError("Commit message is required");
  const args = ["commit", "-m", opts.message];
  if (opts.amend) args.push("--amend");
  if (opts.all) args.push("-a");
  return git(cwd, args);
}

// ── branches / refs ───────────────────────────────────────────────────────

export const checkout = (cwd: string, ref: string) => git(cwd, ["checkout", safe(ref, "ref")]);

export const branchCreate = (cwd: string, name: string, from?: string) =>
  git(cwd, ["switch", "-c", safe(name, "branch"), ...(from ? [safe(from, "ref")] : [])]);

export const branchDelete = (cwd: string, name: string, force = false) =>
  git(cwd, ["branch", force ? "-D" : "-d", safe(name, "branch")]);

export const branchRename = (cwd: string, from: string, to: string) =>
  git(cwd, ["branch", "-m", safe(from, "branch"), safe(to, "branch")]);

export const reset = (cwd: string, oid: string, mode: "soft" | "mixed" | "hard") =>
  git(cwd, ["reset", `--${mode}`, safe(oid, "commit")]);

export const revert = (cwd: string, oid: string) =>
  git(cwd, ["revert", "--no-edit", safe(oid, "commit")]);

export const cherryPick = (cwd: string, oid: string) =>
  git(cwd, ["cherry-pick", safe(oid, "commit")]);

// ── merge / rebase ────────────────────────────────────────────────────────

/** Merge is expected to fail on conflict: git leaves conflict markers in the
 *  worktree and a non-zero exit. Report that as data, not as an error, so the
 *  UI can open the conflict resolver instead of a toast. */
export async function merge(cwd: string, ref: string, noFf: boolean): Promise<{ conflict: boolean; output: string }> {
  const args = ["merge", "--no-edit"];
  if (noFf) args.push("--no-ff");
  args.push(safe(ref, "ref"));
  const r = await run(["git", ...args], cwd);
  const output = (r.stdout + r.stderr).trim();
  if (r.code === 0) return { conflict: false, output };
  if (/conflict/i.test(output)) return { conflict: true, output };
  throw new GitError(output);
}

export const mergeAbort = (cwd: string) => git(cwd, ["merge", "--abort"]);

export async function rebase(
  cwd: string,
  action: "start" | "continue" | "abort" | "skip",
  ref?: string,
): Promise<{ conflict: boolean; output: string }> {
  const args =
    action === "start" ? ["rebase", safe(ref, "ref")] : ["rebase", `--${action}`];
  const r = await run(["git", ...args], cwd);
  const output = (r.stdout + r.stderr).trim();
  if (r.code === 0) return { conflict: false, output };
  if (/conflict|could not apply/i.test(output)) return { conflict: true, output };
  throw new GitError(output);
}

/** Mark a conflicted file resolved once the user has edited the markers out. */
export const markResolved = (cwd: string, paths: string[]) =>
  git(cwd, ["add", "--", ...paths.map((p) => safe(p, "path"))]);

// ── stash ─────────────────────────────────────────────────────────────────

export async function stash(
  cwd: string,
  action: "push" | "pop" | "apply" | "drop" | "list" | "clear",
  opts: { message?: string; ref?: string } = {},
): Promise<string> {
  switch (action) {
    case "push":
      return git(cwd, ["stash", "push", "--include-untracked", ...(opts.message ? ["-m", opts.message] : [])]);
    case "list":
      return git(cwd, ["stash", "list", "--format=%gd%x00%ct%x00%gs"]);
    case "clear":
      return git(cwd, ["stash", "clear"]);
    default:
      return git(cwd, ["stash", action, ...(opts.ref ? [safe(opts.ref, "stash ref")] : [])]);
  }
}

// ── remotes ───────────────────────────────────────────────────────────────

/** fetch/pull/push write their progress to stderr; stream it so the UI shows a
 *  live log instead of freezing until the transfer ends. */
export async function remote(
  cwd: string,
  action: "fetch" | "pull" | "push",
  opts: { remote?: string; ref?: string; setUpstream?: boolean; force?: boolean },
  onProgress: (line: string) => void,
): Promise<{ output: string }> {
  const args: string[] = [action, "--progress"];
  if (action === "fetch") args.push("--prune");
  if (action === "push" && opts.setUpstream) args.push("--set-upstream");
  // --force-with-lease refuses to clobber commits this clone has not seen.
  if (action === "push" && opts.force) args.push("--force-with-lease");
  if (opts.remote) args.push(safe(opts.remote, "remote"));
  if (opts.ref) args.push(safe(opts.ref, "ref"));

  const lines: string[] = [];
  const it = runLines(["git", ...args], cwd, {
    stderr: (line) => {
      lines.push(line);
      onProgress(line);
    },
  });
  let next = await it.next();
  while (!next.done) {
    lines.push(next.value);
    onProgress(next.value);
    next = await it.next();
  }
  const code = next.value;
  const output = lines.join("\n").trim();
  if (code !== 0) throw new GitError(output);
  return { output };
}

export async function remotes(cwd: string): Promise<{ name: string; url: string }[]> {
  const out = await git(cwd, ["remote", "-v"]);
  const seen = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m) seen.set(m[1], m[2]);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

/** `git commit` refuses to run without an identity; surface that as a check the
 *  UI can run before showing the commit box. */
export async function identity(cwd: string): Promise<{ name: string | null; email: string | null }> {
  const one = async (key: string) => {
    const r = await run(["git", "config", "--get", key], cwd);
    return r.code === 0 ? r.stdout.trim() || null : null;
  };
  return { name: await one("user.name"), email: await one("user.email") };
}
