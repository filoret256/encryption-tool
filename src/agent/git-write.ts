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
// safe/oneOf live in git.ts because the read operations need them just as much:
// `--output=<file>` is a diff option, so `git log` accepts it too.
import { GitError, oneOf, readOnly, safe } from "./git.ts";

const RESET_MODES = ["soft", "mixed", "hard"] as const;
const REBASE_ACTIONS = ["start", "continue", "abort", "skip"] as const;
const SEQUENCER_KINDS = ["cherry-pick", "revert"] as const;
const SEQUENCER_ACTIONS = ["continue", "abort", "skip"] as const;
const STASH_ACTIONS = ["push", "pop", "apply", "drop", "list", "clear"] as const;
const REMOTE_ACTIONS = ["fetch", "pull", "push"] as const;
/** How `git pull` integrates: a merge commit, a rebase, or refusing anything
 *  that is not a fast-forward. */
const PULL_MODES = ["merge", "rebase", "ff-only"] as const;

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

/** Apply a unified diff to the index, or take one back out of it.
 *
 *  This is what stage-this-hunk is made of. The patch is a document, not an
 *  argument: it arrives on stdin, which is why `run` grew a stdin parameter for
 *  it. Always `--cached`, so the worktree is never touched — the caller staged
 *  or unstaged a hunk, and their open buffer must come out of it unchanged.
 *
 *  `reverse` is unstage: the same patch read backwards out of the index.
 *
 *  `--unidiff-zero` is deliberately absent. Applying a zero-context patch is
 *  guesswork about where it goes, and guessing wrong here silently stages
 *  something the user did not point at; the client builds patches with context
 *  and this refuses the ones without.
 */
export async function applyPatch(cwd: string, patch: string, reverse: boolean): Promise<string> {
  if (!patch.trim()) throw new GitError("Patch is empty");
  const args = ["apply", "--cached", "--whitespace=nowarn"];
  if (reverse) args.push("--reverse");
  const r = await run(["git", ...args], cwd, patch);
  if (r.code !== 0) throw new GitError(r.stderr || r.stdout);
  return r.stdout;
}

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

// The mode is concatenated into the flag, so it is checked against the list
// rather than merely screened for a leading "-".
export const reset = (cwd: string, oid: string, mode: "soft" | "mixed" | "hard") =>
  git(cwd, ["reset", `--${oneOf(mode, RESET_MODES, "reset mode")}`, safe(oid, "commit")]);

export const revert = (cwd: string, oid: string) =>
  git(cwd, ["revert", "--no-edit", safe(oid, "commit")]);

export const cherryPick = (cwd: string, oid: string) =>
  git(cwd, ["cherry-pick", safe(oid, "commit")]);

// ── merge / rebase ────────────────────────────────────────────────────────

/** Merge is expected to fail on conflict: git leaves conflict markers in the
 *  worktree and a non-zero exit. Report that as data, not as an error, so the
 *  UI can open the conflict resolver instead of a toast. */
export async function merge(
  cwd: string,
  ref: string,
  noFf: boolean,
  squash = false,
): Promise<{ conflict: boolean; output: string }> {
  const args = ["merge", "--no-edit"];
  // --squash stages the result and stops before committing; it is incompatible
  // with --no-ff, and the two never arrive together because the UI asks for one
  // strategy, not a set of flags.
  if (squash) args.push("--squash");
  else if (noFf) args.push("--no-ff");
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
  const verb = oneOf(action, REBASE_ACTIONS, "rebase action");
  const args = verb === "start" ? ["rebase", safe(ref, "ref")] : ["rebase", `--${verb}`];
  const r = await run(["git", ...args], cwd);
  const output = (r.stdout + r.stderr).trim();
  if (r.code === 0) return { conflict: false, output };
  if (/conflict|could not apply/i.test(output)) return { conflict: true, output };
  throw new GitError(output);
}

/** Finish or abandon a stopped cherry-pick or revert.
 *
 *  Same shape as `rebase` above, and here for the same reason: `Cherry-pick
 *  onto current` and `Revert this commit` are two clicks away in the history
 *  panel, both stop on a conflict, and without this the only way out of one was
 *  a terminal. `--continue` needs no editor, so `--no-edit` keeps it from
 *  blocking on one that will never open.
 */
export async function sequencer(
  cwd: string,
  what: "cherry-pick" | "revert",
  action: "continue" | "abort" | "skip",
): Promise<{ conflict: boolean; output: string }> {
  const verb = oneOf(what, SEQUENCER_KINDS, "sequencer command");
  const step = oneOf(action, SEQUENCER_ACTIONS, "sequencer action");
  const args = [verb, `--${step}`, ...(step === "continue" ? ["--no-edit"] : [])];
  const r = await run(["git", ...args], cwd);
  const output = (r.stdout + r.stderr).trim();
  if (r.code === 0) return { conflict: false, output };
  if (/conflict/i.test(output)) return { conflict: true, output };
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
  // The default branch passes the action through as a git subcommand, so this
  // is a fixed list rather than a type assertion the wire never honoured.
  switch (oneOf(action, STASH_ACTIONS, "stash action")) {
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

/** Resolve a remote *name*, and only a name.
 *
 *  Git reads the `<repository>` argument as a URL whenever it is not a
 *  configured remote, so an unchecked value here is `git push https://…  HEAD`
 *  — the user's repository handed to whoever asked for it, and `git fetch`
 *  pulling back whatever they choose to serve. Screening for a leading "-"
 *  does not catch that; being on the repository's own remote list does.
 */
async function knownRemote(cwd: string, name: string): Promise<string> {
  const wanted = safe(name, "remote");
  const known = await remotes(cwd);
  if (!known.some((r) => r.name === wanted)) throw new GitError(`Unknown remote: ${wanted}`);
  return wanted;
}

/** fetch/pull/push write their progress to stderr; stream it so the UI shows a
 *  live log instead of freezing until the transfer ends. */
export async function remote(
  cwd: string,
  action: "fetch" | "pull" | "push",
  opts: { remote?: string; ref?: string; setUpstream?: boolean; force?: boolean; mode?: string },
  onProgress: (line: string) => void,
): Promise<{ output: string }> {
  // The action is the git subcommand itself, so it comes off a list.
  const args: string[] = [oneOf(action, REMOTE_ACTIONS, "remote action"), "--progress"];
  if (action === "fetch") args.push("--prune");
  // How a pull integrates what it fetched. Passed explicitly rather than left
  // to `pull.rebase`, so the UI can say which one it is about to do — and so a
  // trunk-based repository is not handed a merge commit because a config the
  // page cannot see was not set.
  if (action === "pull" && opts.mode) {
    const mode = oneOf(opts.mode, PULL_MODES, "pull mode");
    args.push(mode === "rebase" ? "--rebase" : mode === "ff-only" ? "--ff-only" : "--no-rebase");
  }
  if (action === "push" && opts.setUpstream) args.push("--set-upstream");
  // --force-with-lease refuses to clobber commits this clone has not seen.
  if (action === "push" && opts.force) args.push("--force-with-lease");
  if (opts.remote) args.push(await knownRemote(cwd, opts.remote));
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

const REMOTE_ADMIN = ["add", "rename", "remove"] as const;

/** A remote name the user is about to create. Unlike `knownRemote` there is
 *  nothing to check it against yet, so the shape is checked instead: git's own
 *  rules for a ref component, which is what a remote name becomes. */
function newRemoteName(name: string): string {
  const n = safe(name, "remote");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n) || n.endsWith(".lock")) {
    throw new GitError(`Invalid remote name: ${n}`);
  }
  return n;
}

/** Screen a remote URL before it is written into .git/config.
 *
 *  This is the one place the client hands over something git will later execute
 *  against. `<transport>::<address>` makes git run `git-remote-<transport>`,
 *  and `ext::sh -c whoami` is the documented way to spell "run this" — the
 *  fetch path already refuses those, but a URL stored in the config is fetched
 *  by name afterwards and would sail straight past that check.
 *
 *  So the allowed set is the transports that move bytes over a network and
 *  nothing else. A local path is refused too: `git fetch /some/other/repo`
 *  would pull a repository from outside the workspace into this one, where the
 *  page can then read it — the jail exists to make exactly that impossible.
 */
function safeRemoteUrl(url: string): string {
  const u = safe(url, "remote URL");
  if (u.includes("::")) throw new GitError(`Unsupported remote URL: ${u}`);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(u);
  if (scheme) {
    if (!["https", "http", "ssh", "git"].includes(scheme[1].toLowerCase())) {
      throw new GitError(`Unsupported remote URL: ${u}`);
    }
    return u;
  }
  // scp-like: [user@]host:path — the form every ssh remote is written in.
  if (/^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?:[^\s]+$/.test(u) && !/^[A-Za-z]:[\\/]/.test(u)) return u;
  throw new GitError(`Unsupported remote URL: ${u}`);
}

/** Add, rename or remove a remote. Fetching through one is `remote()` above;
 *  this is the configuration behind it. */
export async function remoteAdmin(
  cwd: string,
  action: "add" | "rename" | "remove",
  opts: { name?: string; url?: string; to?: string },
): Promise<string> {
  switch (oneOf(action, REMOTE_ADMIN, "remote admin action")) {
    case "add":
      return git(cwd, ["remote", "add", newRemoteName(opts.name ?? ""), safeRemoteUrl(opts.url ?? "")]);
    case "rename":
      // The source must exist, the destination must merely be a legal name.
      return git(cwd, ["remote", "rename", await knownRemote(cwd, opts.name ?? ""), newRemoteName(opts.to ?? "")]);
    default:
      return git(cwd, ["remote", "remove", await knownRemote(cwd, opts.name ?? "")]);
  }
}

// ── tags ──────────────────────────────────────────────────────────────────

/** Create a tag. With a message it is an annotated tag — an object of its own
 *  with an author and a date — which is what a release wants; without one it is
 *  a lightweight pointer, which is what a bookmark wants. */
export async function tagCreate(
  cwd: string,
  name: string,
  opts: { ref?: string; message?: string; force?: boolean },
): Promise<string> {
  const args = ["tag"];
  if (opts.force) args.push("--force");
  if (opts.message?.trim()) args.push("-a", "-m", opts.message);
  args.push(safe(name, "tag"));
  if (opts.ref) args.push(safe(opts.ref, "ref"));
  return git(cwd, args);
}

export const tagDelete = (cwd: string, name: string) => git(cwd, ["tag", "-d", safe(name, "tag")]);

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
    const r = await run(readOnly(["config", "--get", key]), cwd);
    return r.code === 0 ? r.stdout.trim() || null : null;
  };
  return { name: await one("user.name"), email: await one("user.email") };
}
