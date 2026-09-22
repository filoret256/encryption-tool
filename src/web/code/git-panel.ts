/** Source-control panel: status, staging, commits, branches, remotes.
 *
 *  Every action is one call into the agent, which runs the system git. That is
 *  why rebase, revert and reset are here at all — they are not reimplemented,
 *  they are the real commands, so their semantics are git's and not an
 *  approximation of them.
 */
import type { AgentClient } from "./agent.ts";
import type { Branch, Commit, CommitDetail, CommitFile, GitOperation, GitStatus, ReflogEntry, StatusEntry } from "../../agent/protocol.ts";
import { esc, modalChoice, modalConfirm, modalPrompt, setHtmlKeepingScroll, showMenu, startTrimmed, type MenuItem } from "./ui.ts";
import { pickRef } from "./refpicker.ts";
import { iconBranch, iconCheck, iconDiscard, iconFetch, iconMinus, iconMore, iconPlus, iconPull, iconPush } from "./icons.ts";

export interface GitPanelCallbacks {
  /** kind: "worktree" (index vs disk), "staged" (HEAD vs index) or a commit oid. */
  openDiff(path: string, kind: string): void;
  openFile(path: string): void;
  /** `scope` tags a notice as being about a state rather than an event, so it
   *  can be taken down when that state passes — see `dismiss` below. */
  toast(message: string, isError?: boolean, scope?: string): void;
  /** Drop the notices carrying this scope. */
  dismiss(scope: string): void;
  /** A one-line summary plus everything the command actually said.
   *
   *  git answers in paragraphs — which files conflicted, which refs moved, what
   *  it suggests doing next — and all of it used to be dropped on the floor for
   *  the operations that succeed, leaving `git merged` in the log and nothing
   *  to check it against. The summary is the line; the transcript goes to the
   *  output log behind a "details" button. */
  report(summary: string, detail?: string, opts?: { isError?: boolean; scope?: string }): void;
  /** List what differs between two refs — branches, tags, commits. */
  compareRefs(left: string, right: string): void;
  /** Something changed on disk or in refs — reload the tree and decorations. */
  afterChange(): void;
}

type Group = "conflict" | "staged" | "changes" | "untracked";

const GROUP_TITLES: Record<Group, string> = {
  conflict: "conflicts",
  staged: "staged changes",
  changes: "changes",
  untracked: "untracked",
};

/** The conflict section, named after whatever produced the conflicts.
 *
 *  It said "merge conflicts" during a rebase, a cherry-pick and a revert as
 *  well — three operations whose conflicts resolve to different things, and one
 *  of which (rebase) reverses the meaning of "current" and "incoming" in the
 *  editor. A `stash pop` can leave conflicts with no operation in progress at
 *  all, which is why the plain word is the fallback rather than "merge". */
function conflictTitle(op: GitOperation | null): string {
  return op ? `${op.kind} conflicts` : "conflicts";
}

/** One entry of `git stash list`.
 *
 *  The agent has listed, applied and dropped stashes by name since the first
 *  version; the panel offered "stash" and "pop latest" and nothing else, so a
 *  second `stash push` put the first one somewhere the UI could not name. */
interface Stash {
  /** `stash@{0}` — what every stash command takes as its argument. */
  ref: string;
  time: number;
  /** `On main: wip` or `WIP on main: cd1e044 …` as git wrote it. */
  subject: string;
}

/** `%gd%x00%ct%x00%gs` per line, which is what the agent asks git for. */
function parseStashes(raw: string): Stash[] {
  const out: Stash[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [ref, time, ...rest] = line.split("\0");
    if (!ref) continue;
    out.push({ ref, time: Number(time) || 0, subject: rest.join("\0") });
  }
  return out;
}

/** "On main: wip" carries the branch, which the row shows separately. */
function stashLabel(subject: string): { branch: string; text: string } {
  const m = /^(?:WIP on|On) ([^:]+): (.*)$/.exec(subject);
  if (!m) return { branch: "", text: subject };
  // An unnamed stash reads "WIP on main: <oid> <subject of HEAD>", where the
  // oid is noise: it names the commit the stash sits on, not the work in it.
  return { branch: m[1], text: m[2].replace(/^[0-9a-f]{7,40}\s+/, "") };
}

const SHELL = `
  <div class="gp-head">
    <button class="t-btn js-branch" type="button" title="Branches">${iconBranch}<span class="js-branch-name">—</span></button>
    <button class="t-btn gp-sync js-sync" type="button" hidden></button>
    <span class="t-spacer"></span>
    <button class="t-icon js-fetch" type="button" title="Fetch">${iconFetch}</button>
    <button class="t-icon js-pull" type="button" title="Pull">${iconPull}</button>
    <button class="t-icon js-push" type="button" title="Push">${iconPush}</button>
    <button class="t-icon js-more" type="button" title="More actions">${iconMore}</button>
  </div>
  <div class="gp-op js-op" hidden></div>
  <div class="gp-commit">
    <textarea class="js-message" rows="2" placeholder="Message (Ctrl+Enter to commit)" spellcheck="false"></textarea>
    <div class="gp-commit-row">
      <button class="t-btn t-btn-primary js-commit" type="button"
        title="Commit (Ctrl+Enter) — Ctrl+Shift+Enter commits and pushes">✓ commit</button>
      <button class="t-btn js-amend" type="button" title="Replace the last commit">amend</button>
      <button class="t-icon js-history" type="button" title="Recent commit messages">↺</button>
      <span class="t-spacer"></span>
      <!-- What the branch still owes the remote, next to the button that just
           created the debt. The arrows in the header say the same thing, but
           nothing after a commit points at them. -->
      <button class="t-btn gp-unpushed js-unpushed" type="button" hidden></button>
      <span class="gp-len js-len" aria-live="off"></span>
    </div>
    <p class="gp-warn js-warn" hidden></p>
  </div>
  <div class="gp-groups js-groups"></div>
  <div class="gp-progress js-progress" hidden></div>`;

/** Collapsible sections: the four file groups plus the stash list. */
type Section = Group | "stash";

/** Notices about a half-finished operation, taken down when it finishes: see
 *  notify.ts. "merge stopped with conflicts — resolve them below" is true until
 *  it is not, and a red box that goes on saying it after the merge commit is
 *  worse than no box at all. */
export const OP_SCOPE = "git-operation";
/** "Commit message is required" stops being true at the first keystroke. */
const MSG_SCOPE = "commit-message";

const COLLAPSED_KEY = "enc-scm-collapsed";
const VIEW_KEY = "enc-scm-view";
const SORT_KEY = "enc-scm-sort";
const PULL_KEY = "enc-scm-pull";

/** How a pull integrates what it fetched.
 *
 *  Asked rather than assumed. `git pull` merges unless `pull.rebase` says
 *  otherwise, and that config lives on the machine, not in the page — so the
 *  button used to do whichever one the repository happened to be set up for,
 *  without saying which, and a branch that was meant to stay linear quietly
 *  gained a merge commit. */
type PullMode = "merge" | "rebase" | "ff-only";
const PULL_MODES = ["merge", "rebase", "ff-only"] as const;
const PULL_LABELS: Record<PullMode, string> = {
  merge: "merge",
  rebase: "rebase",
  "ff-only": "fast-forward only",
};
/** The same three, short enough to sit on the button beside the arrow. */
const PULL_TAGS: Record<PullMode, string> = { merge: "m", rebase: "rb", "ff-only": "ff" };

const loadCollapsed = (): Set<Section> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as Section[]);
  } catch {
    return new Set();
  }
};

const saveCollapsed = (s: Set<Section>): void => {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s]));
  } catch {
    /* private mode */
  }
};

const loadPref = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
};

/** The remembered pull strategy, or null if the user has not chosen one.
 *
 *  Null is a real state, not a default: it is what makes the first divergent
 *  pull ask instead of guessing. */
/** Per folder, not per browser.
 *
 *  One person's machine holds a trunk-based repository and a gitflow one, and
 *  the right answer for pull is not the same in both — a single remembered
 *  choice means whichever they answered first is silently applied to the other.
 *  Keyed by the workspace path the agent reports.
 */
const loadPullModes = (): Record<string, PullMode> => {
  try {
    const raw = JSON.parse(localStorage.getItem(PULL_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    // The old format was a single mode string for every folder. Nothing is
    // migrated from it: one repository's answer is not evidence about another.
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(
        (e): e is [string, PullMode] => typeof e[1] === "string" && (PULL_MODES as readonly string[]).includes(e[1]),
      ),
    );
  } catch {
    return {};
  }
};

const savePref = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};

/** The other side of a merge, as git named it in MERGE_MSG.
 *
 *  "Merge branch 'feature/x' into develop" is a sentence about the operation;
 *  the banner has already said it is merging, so what is left to say is which
 *  branch is coming in. Anything that does not match the template — a merged
 *  tag, a cherry-pick subject — is shown as written. */
export function mergeSource(subject: string): string {
  const m = /^Merge (?:branch|remote-tracking branch|tag|commit) '([^']+)'/.exec(subject);
  return m ? m[1] : subject;
}

/** What a merge that did not stop on a conflict actually did.
 *
 *  The agent runs git with LC_ALL=C, so these phrases are git's own and not a
 *  translation. Anything unrecognised falls back to naming the ref, which is
 *  still more than "merged" said. */
function mergeOutcome(ref: string, output: string, mode: "default" | "no-ff" | "squash" = "default"): string {
  if (/already up to date/i.test(output)) return `already up to date — ${ref} is in this branch`;
  // A squash merge stages the changes and stops; saying "merged" would suggest
  // the work is recorded, and it is not until the user commits.
  if (mode === "squash") return `squashed ${ref} into the index — write a message and commit`;
  if (/fast[- ]forward/i.test(output)) return `merged ${ref} (fast-forward)`;
  return `merged ${ref}${mode === "no-ff" ? " (merge commit)" : ""}`;
}

/** Relative age, short enough for a row. */
function ago(seconds: number): string {
  const d = Math.max(0, Date.now() / 1000 - seconds);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return `${Math.floor(d / (86400 * 30))}mo ago`;
}

export class GitPanel {
  private status: GitStatus | null = null;
  private branches: Branch[] = [];
  private stashes: Stash[] = [];
  /** Groups the user has folded away, remembered between sessions: a repo
   *  where "untracked" is always noise should not need folding on every load. */
  private collapsed = loadCollapsed();
  /** Flat list or folder tree, and what orders the rows. Both remembered:
   *  someone who works in a monorepo wants the tree every time, and someone
   *  who does not never wants to see it. */
  private view = loadPref(VIEW_KEY, ["list", "tree"] as const, "list");
  private sort = loadPref(SORT_KEY, ["name", "status"] as const, "name");
  /** Remembered pull strategies, keyed by workspace folder. The current
   *  folder's entry is null until the user has been asked once — see doPull(). */
  private pullModes = loadPullModes();

  /** Which folder the remembered strategy belongs to. Falls back to a fixed
   *  key before the agent has said where it is pointed, so a pull made in that
   *  window is still remembered somewhere rather than nowhere. */
  private get folderKey(): string {
    return this.agent.info?.root ?? "(unknown)";
  }

  /** The strategy chosen for this folder, if one has been. */
  private get pull(): PullMode | null {
    return this.pullModes[this.folderKey] ?? null;
  }
  /** Whether this folder has anywhere to push to, and which folder that answer
   *  is about.
   *
   *  Asked once per folder rather than with every status: remotes change when
   *  someone changes them (and that path clears this), while the status is
   *  re-read on every file the watcher sees move. Remote-tracking branches
   *  would have answered it for free, but a remote that has been added and not
   *  yet fetched has none — and that is exactly the repository where "publish"
   *  is the thing to offer. */
  private hasRemote = false;
  private remotesFor: string | null = null;
  /** The prepared message already put in the box, so a box the user has since
   *  emptied is not refilled on the next watcher event. */
  private preparedOffered: string | null = null;
  /** The stash whose contents are on screen, and what is in it.
   *
   *  Until this, the only way to find out what a stash held was to apply it —
   *  which is the one thing you do not want to do to check. */
  private openStash: string | null = null;
  private stashFiles = new Map<string, CommitFile[]>();
  private busy = false;
  /** Fingerprint of the rendered file list, so an unchanged status leaves the
   *  rows — and any click in flight over them — alone. */
  private renderedKey = "";
  /** The same, for the operation banner: it carries buttons with listeners, so
   *  rebuilding it on every watcher event would drop clicks the way the file
   *  rows used to. */
  private renderedOp = "";
  /** Set when git refused to answer. Shown in place of the file list, because
   *  "No changes." for a failed status is a claim about the working tree that
   *  nothing has checked. */
  private failure: string | null = null;

  private readonly $: <T extends HTMLElement>(sel: string) => T;

  constructor(
    private readonly host: HTMLElement,
    private readonly agent: AgentClient,
    private readonly cb: GitPanelCallbacks,
  ) {
    host.classList.add("gp");
    host.innerHTML = SHELL;
    this.$ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;

    this.$(".js-branch").addEventListener("click", (e) => this.branchMenu(e as MouseEvent));
    this.$(".js-sync").addEventListener("click", () => void this.sync());
    this.$(".js-more").addEventListener("click", (e) => void this.moreMenu(e as MouseEvent));
    this.$(".js-fetch").addEventListener("click", () => void this.remote("fetch", {}));
    this.$(".js-pull").addEventListener("click", () => void this.doPull());
    // The button says which strategy is armed, so the choice is not something
    // you have to remember making.
    this.showPullMode();
    this.$(".js-push").addEventListener("click", () => void this.push());
    this.$(".js-commit").addEventListener("click", () => void this.commit(false));
    this.$(".js-amend").addEventListener("click", () => void this.commit(true));
    this.$(".js-history").addEventListener("click", (e) => void this.messageHistory(e as MouseEvent));
    // Same action as the arrows in the header: pull first if the branch is
    // behind, then push — or publish a branch that has no upstream yet.
    this.$(".js-unpushed").addEventListener("click", () => void this.sync());
    const box = this.$<HTMLTextAreaElement>(".js-message");
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        // Shift sends it on in the same press. Committing and pushing is two
        // deliberate acts and stays two buttons; this is for the case where
        // the answer to "and now push?" is always yes.
        void this.commit(false, e.shiftKey);
      }
    });
    box.addEventListener("input", () => this.onMessageInput());
    // Opening a file reacts to the press: this panel rebuilds on every save and
    // every watcher event, and a rebuild between mousedown and mouseup means no
    // click event is ever produced. Stage / unstage / discard stay on click, so
    // dragging off the button still cancels them.
    this.$(".js-groups").addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".js-retry")) void this.refresh();
    });
    this.$(".js-groups").addEventListener("pointerdown", (e) => this.onGroupPress(e as PointerEvent));
    this.$(".js-groups").addEventListener("click", (e) => void this.onGroupAction(e as MouseEvent));
    this.$(".js-groups").addEventListener("contextmenu", (e) => this.onGroupMenu(e as MouseEvent));
  }

  // ── data ────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (this.agent.state !== "online" || !this.agent.info?.gitVersion) {
      this.status = null;
      this.render();
      return;
    }
    try {
      // Only the first status in a folder asks about remotes; after that the
      // answer is kept until something changes it. A failure here is not one:
      // it leaves "no remote", which hides an offer rather than making a wrong
      // one.
      const askRemotes = this.remotesFor !== this.folderKey;
      const [status, branches, identity, stashes, remotes] = await Promise.all([
        this.agent.call<GitStatus>("git.status"),
        this.agent.call<Branch[]>("git.branches"),
        this.agent.call<{ name: string | null; email: string | null }>("git.identity"),
        // A repository with no stashes answers with an empty string, not an
        // error, so this never needs its own failure path.
        this.agent.call<string>("git.stash", { action: "list" }).catch(() => ""),
        askRemotes ? this.agent.call<{ name: string }[]>("git.remotes").catch(() => []) : Promise.resolve(null),
      ]);
      this.status = status;
      this.branches = branches;
      this.stashes = parseStashes(stashes);
      this.failure = null;
      if (remotes) {
        this.hasRemote = remotes.length > 0;
        this.remotesFor = this.folderKey;
      }

      // The operation is over, or its conflicts are: whatever was said about
      // them is now a claim about a state that no longer exists, so take it
      // down rather than leave it for the user to close by hand.
      if (!status.operation || !status.entries.some((e) => e.conflict)) this.cb.dismiss(OP_SCOPE);

      this.offerPreparedMessage(status.preparedMessage ?? null);
      // The strategy is per folder, and which folder this is only becomes known
      // once the agent has answered — so the button's tag is settled here
      // rather than in the constructor.
      this.showPullMode();

      // git refuses to commit without an identity; say so before the failure.
      const warn = this.$<HTMLElement>(".js-warn");
      const missing = !identity.name || !identity.email;
      warn.hidden = !missing;
      warn.textContent = missing ? "git user.name / user.email are not set — commits will fail." : "";
    } catch (e) {
      this.status = null;
      const message = e instanceof Error ? e.message : String(e);
      const notARepo = /not a git repository/i.test(message);
      this.failure = notARepo ? null : message;
      if (!notARepo) this.cb.toast(message, true);
    }
    this.render();
  }

  /** Right-click on a stash: the same three actions as the icons, named.
   *
   *  The icons appear on hover and are a glyph each; a right-click is what
   *  people try when they want to know what a row can do, and on these rows it
   *  used to do nothing at all. */
  private onGroupMenu(e: MouseEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-stash]");
    const ref = row?.dataset.stash;
    if (!ref) return;
    e.preventDefault();
    const stash = this.stashes.find((s) => s.ref === ref);
    const name = stash ? stashLabel(stash.subject).text || ref : ref;
    showMenu(e.clientX, e.clientY, [
      {
        label: this.openStash === ref ? "Hide what is in it" : "Show what is in it",
        run: () => void this.toggleStash(ref),
      },
      { label: `Apply ${name} — keep the stash`, separated: true, run: () => void this.stashAction("apply", ref) },
      { label: `Pop ${name} — apply and remove`, run: () => void this.stashAction("pop", ref) },
      { label: `Drop ${name}`, danger: true, run: () => void this.stashAction("drop", ref) },
    ]);
  }

  /** Open or close a stash, reading its file list the first time.
   *
   *  A stash is a commit whose first parent is the commit it was taken on, so
   *  `git.commitDetail` answers this with no new agent code — and its files
   *  open in the same diff as any other commit's. */
  private async toggleStash(ref: string): Promise<void> {
    if (this.openStash === ref) {
      this.openStash = null;
      this.renderedKey = "";
      this.render();
      return;
    }
    this.openStash = ref;
    this.renderedKey = "";
    this.render();
    if (this.stashFiles.has(ref)) return;
    try {
      const detail = await this.agent.call<CommitDetail>("git.commitDetail", { oid: ref });
      this.stashFiles.set(ref, detail.files);
    } catch (e) {
      this.stashFiles.set(ref, []);
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
    if (this.openStash === ref) {
      this.renderedKey = "";
      this.render();
    }
  }

  /** Put a message in the box and focus it.
   *
   *  For an operation that stages something and leaves the wording to the user
   *  — squashing a run of commits, where the subjects being folded together are
   *  the obvious first draft. Overwrites whatever is there, because the caller
   *  has just been confirmed by the user; `offerPreparedMessage` is the one
   *  that must not. */
  setMessage(text: string): void {
    const box = this.$<HTMLTextAreaElement>(".js-message");
    box.value = text;
    this.preparedOffered = null;
    this.onMessageInput();
    // After the caller's refresh, not before it. A squash is followed by a
    // status reload and a tab redraw, and both can put the keyboard back in the
    // editor — which is how the first version of this sent a commit message
    // into the open source file instead of into the box.
    setTimeout(() => {
      box.focus();
      const firstLine = box.value.indexOf("\n");
      box.setSelectionRange(0, firstLine === -1 ? box.value.length : firstLine);
    }, 0);
  }

  /** Put git's own message in the box, once, when it has written one.
   *
   *  Finishing a merge or a squash means committing something git has already
   *  composed a message for — `Merge branch 'feature/x' into develop`, or the
   *  list of commits a squash folded together. The box was empty regardless, so
   *  the message had to be retyped from memory, and pressing commit without
   *  doing so answered "Commit message is required" for a commit git was
   *  perfectly happy to make itself.
   *
   *  Offered, not enforced: it fills an empty box and never overwrites typing,
   *  and clearing the box is respected until git prepares a different message.
   */
  private offerPreparedMessage(prepared: string | null): void {
    const box = this.$<HTMLTextAreaElement>(".js-message");
    if (!prepared) {
      // The offer is withdrawn when git withdraws it — an aborted merge, a
      // reset after a squash. Only the untouched offer is taken back: anything
      // the user has since typed over it is theirs, and a box that empties
      // itself under someone's hands is worse than a stale suggestion.
      if (this.preparedOffered && box.value === this.preparedOffered) {
        box.value = "";
        this.onMessageInput();
      }
      this.preparedOffered = null;
      return;
    }
    if (this.preparedOffered === prepared) return;
    // A different message is only put in on top of the last untouched offer,
    // never over typing.
    if (box.value.trim() && box.value !== this.preparedOffered) return;
    this.preparedOffered = prepared;
    box.value = prepared;
    this.onMessageInput();
  }

  /** Entries split into the four sections; a file can be both staged and
   *  changed (git's "MM"), so this is not a partition. */
  private groups(): Record<Group, StatusEntry[]> {
    const out: Record<Group, StatusEntry[]> = { conflict: [], staged: [], changes: [], untracked: [] };
    for (const e of this.status?.entries ?? []) {
      if (e.ignored) continue;
      if (e.conflict) out.conflict.push(e);
      else if (e.untracked) out.untracked.push(e);
      else {
        if (e.index !== ".") out.staged.push(e);
        if (e.work !== ".") out.changes.push(e);
      }
    }
    return out;
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private render(): void {
    const st = this.status;
    // Assigning textContent replaces the text node even when the value is the
    // same, so only write on a difference.
    const set = (sel: string, value: string): void => {
      const el = this.$(sel);
      if (el.textContent !== value) el.textContent = value;
    };
    // A rebase detaches HEAD, so the branch button would read "(detached)" for
    // the whole operation — which is true and useless. git knows which branch
    // is being rebased; say that, and let the banner below say what is going on.
    const op = st?.operation ?? null;
    set(".js-branch-name", st?.branch ?? (op?.head ? `${op.head} (rebasing)` : st ? "(detached)" : "—"));
    this.renderOperation(op);

    // The divergence is the most-used control in this panel, so it is a
    // button: it says what it will do and does it. It used to be a <span> —
    // two glyphs, no tooltip, nothing to press — while the actual pull and
    // push hid behind identical arrow icons further along the row.
    const sync = this.syncState();
    const syncBtn = this.$<HTMLButtonElement>(".js-sync");
    syncBtn.hidden = !sync;
    if (sync) {
      set(".js-sync", sync.arrows);
      syncBtn.title = sync.title;
    }

    // The same state, in words, in the commit block. Only when there is work of
    // ours to send: a branch that is merely behind is not something a commit
    // has just made worse, and a reminder there would be noise.
    const unpushed = this.$<HTMLButtonElement>(".js-unpushed");
    unpushed.hidden = !sync?.unpushed;
    if (sync?.unpushed) {
      set(".js-unpushed", sync.words);
      unpushed.title = sync.title;
    }

    const g = this.groups();
    const total = g.conflict.length + g.staged.length + g.changes.length + g.untracked.length;
    const key = JSON.stringify([
      st === null,
      (["conflict", "staged", "changes", "untracked"] as Group[]).map((k) =>
        g[k].map((e) => [e.path, e.index, e.work]),
      ),
      this.stashes.map((s) => [s.ref, s.subject]),
      // An opened stash and the files in it are part of what is drawn.
      [this.openStash, this.openStash ? (this.stashFiles.get(this.openStash)?.length ?? -1) : 0],
      this.view,
      this.sort,
      // The conflict section is named after the operation, so a rebase that
      // follows a merge over the same files has to redraw the heading.
      this.status?.operation?.kind ?? null,
      [...this.collapsed],
    ]);
    // An error state must be able to redraw itself once the cause is gone, so
    // it never counts as "the same as last time".
    if (key === this.renderedKey && !this.failure) return;
    this.renderedKey = this.failure ? "" : key;
    // Refreshed on every watcher event and every save, so rebuilding must not
    // scroll the list back to the top while someone is reading it.
    setHtmlKeepingScroll(
      this.$(".js-groups"),
      this.failure
        ? `<div class="panel-error">
             <p class="panel-error-title">Status could not be read.</p>
             <pre>${esc(this.failure)}</pre>
             <button class="t-btn js-retry" type="button">try again</button>
           </div>`
      : !st
        ? `<p class="gp-empty">Not a git repository.</p>`
        : (total === 0
            ? `<p class="gp-empty">No changes.</p>`
            : (["conflict", "staged", "changes", "untracked"] as Group[])
                .filter((k) => g[k].length)
                .map((k) => this.groupHtml(k, g[k]))
                .join("")) + this.stashHtml(),
    );
  }

  /** The banner for a half-finished merge, rebase, cherry-pick or revert.
   *
   *  It exists because the state was previously only legible to someone who
   *  already knew git: a rebase showed "(detached)" and a toast that scrolled
   *  away, and the way out — continue, skip, abort — was the last three items
   *  of an overflow menu. Those three are still in the menu; this is the thing
   *  you see without looking for it, and it is also what tells the user which
   *  side "current" and "incoming" mean in the conflict editor.
   */
  private renderOperation(op: GitOperation | null): void {
    const host = this.$<HTMLElement>(".js-op");
    host.hidden = !op;
    if (!op) {
      host.replaceChildren();
      this.renderedOp = "";
      return;
    }

    const conflicts = (this.status?.entries ?? []).filter((e) => e.conflict).length;
    const key = JSON.stringify([op, conflicts]);
    if (key === this.renderedOp) return;
    this.renderedOp = key;

    const verb = { merge: "MERGING", rebase: "REBASING", "cherry-pick": "CHERRY-PICKING", revert: "REVERTING" }[op.kind];
    // What the operation is about, in the words of whichever file git wrote it
    // into: the rebase directory names refs, MERGE_MSG names the commit.
    const source = op.kind === "rebase" ? [op.head, op.onto && `onto ${op.onto}`].filter(Boolean).join(" ") : mergeSource(op.onto ?? "");
    const step = op.step && op.total && op.total > 1 ? ` · commit ${op.step} of ${op.total}` : "";

    const next =
      conflicts > 0
        ? `${conflicts} conflicted file${conflicts === 1 ? "" : "s"} left — resolve ${conflicts === 1 ? "it" : "them"} below`
        : op.kind === "merge"
          ? "conflicts resolved — write a message and commit to finish"
          : "conflicts resolved — continue to finish";

    host.innerHTML = `
      <div class="gp-op-line">
        <span class="gp-op-verb">${verb}</span>
        <span class="gp-op-what" title="${esc(source)}">${esc(source)}${esc(step)}</span>
      </div>
      <p class="gp-op-next">${esc(next)}</p>
      <div class="gp-op-actions">
        ${
          op.kind === "merge"
            ? ""
            : `<button class="t-btn t-btn-primary js-op-continue" type="button"${conflicts ? " disabled" : ""}>continue</button>
               <button class="t-btn js-op-skip" type="button">skip this commit</button>`
        }
        <button class="t-btn t-btn-primary t-btn-danger js-op-abort" type="button">abort ${esc(op.kind)}</button>
      </div>`;

    host.querySelector(".js-op-continue")?.addEventListener("click", () => void this.operationStep("continue", op));
    host.querySelector(".js-op-skip")?.addEventListener("click", () => void this.operationStep("skip", op));
    host.querySelector(".js-op-abort")?.addEventListener("click", () => void this.operationStep("abort", op));
  }

  /** continue / skip / abort, routed to whichever command owns this state. */
  private async operationStep(action: "continue" | "skip" | "abort", op: GitOperation): Promise<void> {
    if (action === "abort") {
      const ok = await modalConfirm({
        title: `Abort the ${op.kind}?`,
        detail:
          op.kind === "rebase"
            ? "The branch goes back to where it was before the rebase started. Conflict edits made since are lost."
            : "The working tree goes back to the commit this started from. Conflict edits made since are lost.",
        okLabel: `abort ${op.kind}`,
        danger: true,
      });
      if (!ok) return;
    }
    const done = { continue: "continued", skip: "commit skipped", abort: `${op.kind} aborted` }[action];
    if (op.kind === "rebase") await this.run("git.rebase", { action }, `rebase ${done}`);
    else if (op.kind === "merge") await this.run("git.mergeAbort", {}, "merge aborted");
    else await this.run("git.sequencer", { what: op.kind, action }, `${op.kind} ${done}`);
  }

  /** Stashes, listed and named.
   *
   *  They live below the file groups because they are not part of what is
   *  about to be committed — but they are part of the working state, and until
   *  now the only way to find out what was in one was to pop it. */
  private stashHtml(): string {
    if (!this.stashes.length) return "";
    const open = !this.collapsed.has("stash");
    return `<section class="gp-group">
      <header class="gp-group-head">
        <button class="gp-caret" type="button" data-collapse="stash"
                aria-expanded="${open}" title="${open ? "Collapse" : "Expand"}">${open ? "▾" : "▸"}</button>
        <span>stashes</span><span class="gp-count">${this.stashes.length}</span>
        <span class="t-spacer"></span>
      </header>
      ${
        open
          ? this.stashes
              .map((s) => {
                const { branch, text } = stashLabel(s.subject);
                // The branch is named only when it is not the one checked out:
                // otherwise every row repeats "main" and spends the width the
                // message needs. The full label is in the tooltip regardless.
                const elsewhere = branch && branch !== this.status?.branch ? branch : "";
                const open = this.openStash === s.ref;
                const files = this.stashFiles.get(s.ref);
                // What is in it, without applying it to find out. A stash is a
                // commit, so this is the same file list the history shows for
                // one — and clicking a row opens the same diff.
                const contents = !open
                  ? ""
                  : files === undefined
                    ? `<div class="gp-stash-files"><span class="gp-empty">loading…</span></div>`
                    : files.length === 0
                      ? `<div class="gp-stash-files"><span class="gp-empty">Nothing in this stash.</span></div>`
                      : `<div class="gp-stash-files">${files
                          .map(
                            (f) => `<div class="gp-row gp-stash-file" data-stash-file="${esc(f.path)}"
                              data-stash-ref="${esc(s.ref)}" title="${esc(f.path)}">
                              <span class="gp-name">${esc(f.path.split("/").pop() ?? f.path)}</span>
                              <span class="gp-dir">${esc(startTrimmed(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""))}</span>
                              <span class="gp-mark">${f.binary ? "bin" : `+${f.added} −${f.deleted}`}</span>
                            </div>`,
                          )
                          .join("")}</div>`;

                return `<div class="gp-row gp-stash" data-stash="${esc(s.ref)}"
                  title="${esc(`${s.ref} — ${s.subject}`)}">
                  <span class="gp-caret">${open ? "▾" : "▸"}</span>
                  <span class="gp-name">${esc(text || "(no message)")}</span>
                  <span class="gp-dir">${esc([elsewhere, ago(s.time)].filter(Boolean).join(" · "))}</span>
                  <span class="gp-actions">
                    <button class="t-icon" data-stash-act="apply" title="Apply — keep the stash">↧</button>
                    <button class="t-icon" data-stash-act="pop" title="Pop — apply and remove">↥</button>
                    <button class="t-icon" data-stash-act="drop" title="Drop — delete this stash">${iconDiscard}</button>
                  </span>
                </div>${contents}`;
              })
              .join("")
          : ""
      }
    </section>`;
  }

  private groupHtml(group: Group, entries: StatusEntry[]): string {
    const open = !this.collapsed.has(group);
    const bulk =
      group === "staged"
        ? `<button class="t-icon" data-bulk="unstage" data-group="${group}" title="Unstage all">${iconMinus}</button>`
        : group === "conflict"
          ? `<button class="t-icon" data-bulk="stage" data-group="${group}" title="Mark all resolved">${iconCheck}</button>`
          : `<button class="t-icon" data-bulk="stage" data-group="${group}" title="Stage all">${iconPlus}</button>
             <button class="t-icon" data-bulk="discard" data-group="${group}" title="Discard all">${iconDiscard}</button>`;

    // The caret is its own button rather than the whole header: the header also
    // carries "stage all" and "discard all", and a bar that both collapses and
    // discards depending on where you land is a bar nobody trusts.
    return `<section class="gp-group">
      <header class="gp-group-head">
        <button class="gp-caret" type="button" data-collapse="${group}"
                aria-expanded="${open}" title="${open ? "Collapse" : "Expand"}">${open ? "▾" : "▸"}</button>
        <span>${group === "conflict" ? esc(conflictTitle(this.status?.operation ?? null)) : GROUP_TITLES[group]}</span><span class="gp-count">${entries.length}</span>
        <span class="t-spacer"></span>${bulk}
      </header>
      ${open ? this.entriesHtml(group, entries) : ""}
    </section>`;
  }

  /** The rows of one group, flat or nested, in the chosen order. */
  private entriesHtml(group: Group, entries: StatusEntry[]): string {
    const sorted = [...entries].sort(this.comparator());
    if (this.view === "list") return sorted.map((e) => this.rowHtml(group, e)).join("");

    // Tree mode. Directories are headings, not rows to act on: staging a whole
    // folder is what the group's "stage all" is for, and a half-target that
    // sometimes means a file and sometimes a folder is the thing this view is
    // supposed to remove. Folders with a single child are joined into one
    // heading ("roles/common/tasks"), the way every file tree does it — fifty
    // changed files in a monorepo are otherwise fifty levels of indentation.
    const byDir = new Map<string, StatusEntry[]>();
    for (const e of sorted) {
      const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
      const list = byDir.get(dir);
      if (list) list.push(e);
      else byDir.set(dir, [e]);
    }
    const dirs = [...byDir.keys()].sort();
    return dirs
      .map((dir) => {
        const rows = byDir.get(dir)!.map((e) => this.rowHtml(group, e, true)).join("");
        if (!dir) return rows;
        return `<div class="gp-dirhead" title="${esc(dir)}">${esc(startTrimmed(dir))}</div>${rows}`;
      })
      .join("");
  }

  /** How rows are ordered inside a group. */
  private comparator(): (a: StatusEntry, b: StatusEntry) => number {
    if (this.sort === "status") {
      // Conflicts first, then deletions, then the rest: the order in which the
      // rows need a decision, not the order git happened to print them.
      const rank = (e: StatusEntry): number => {
        const letter = e.conflict ? "!" : e.untracked ? "U" : e.index !== "." ? e.index : e.work;
        return "!DRCAMTU".indexOf(letter) + 1 || 99;
      };
      return (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path);
    }
    return (a, b) => a.path.localeCompare(b.path);
  }

  private rowHtml(group: Group, e: StatusEntry, nested = false): string {
    const name = e.path.split("/").pop() ?? e.path;
    // In tree mode the directory is the heading above, so repeating it on every
    // row is the noise this view exists to remove.
    const dir = nested || !e.path.includes("/") ? "" : e.path.slice(0, e.path.lastIndexOf("/"));
    const letter = e.conflict ? "!" : e.untracked ? "U" : group === "staged" ? e.index : e.work;
    const actions =
      group === "staged"
        ? `<button class="t-icon" data-act="unstage" title="Unstage">${iconMinus}</button>`
        : group === "conflict"
          ? `<button class="t-icon" data-act="stage" title="Mark resolved">${iconCheck}</button>`
          : `<button class="t-icon" data-act="discard" title="Discard">${iconDiscard}</button>
             <button class="t-icon" data-act="stage" title="Stage">${iconPlus}</button>`;

    return `<div class="gp-row${nested ? " nested" : ""}" data-path="${esc(e.path)}" data-group="${group}" title="${esc(e.path)}">
      <span class="gp-name">${esc(name)}</span>
      <span class="gp-dir">${esc(startTrimmed(dir))}</span>
      <span class="gp-actions">${actions}</span>
      <span class="gp-mark dec-${group}">${esc(letter)}</span>
    </div>`;
  }

  // ── interaction ─────────────────────────────────────────────────────────

  /** The action buttons: staging, unstaging, discarding. */
  private async onGroupAction(e: MouseEvent): Promise<void> {
    const target = e.target as HTMLElement;

    const caret = target.closest<HTMLElement>("[data-collapse]");
    if (caret) {
      const group = caret.dataset.collapse as Section;
      if (this.collapsed.has(group)) this.collapsed.delete(group);
      else this.collapsed.add(group);
      saveCollapsed(this.collapsed);
      // The fingerprint below is what stops an unchanged status from redrawing;
      // collapsing changes nothing about the status, so it has to be cleared.
      this.renderedKey = "";
      this.render();
      return;
    }

    const stashBtn = target.closest<HTMLElement>("[data-stash-act]");
    if (stashBtn) {
      const ref = target.closest<HTMLElement>("[data-stash]")?.dataset.stash;
      if (ref) return this.stashAction(stashBtn.dataset.stashAct as "apply" | "pop" | "drop", ref);
    }

    const bulkBtn = target.closest<HTMLElement>("[data-bulk]");
    if (bulkBtn) {
      const group = bulkBtn.dataset.group as Group;
      const paths = this.groups()[group].map((x) => x.path);
      return this.apply(bulkBtn.dataset.bulk!, group, paths);
    }

    const actBtn = target.closest<HTMLElement>("[data-act]");
    const row = target.closest<HTMLElement>(".gp-row");
    if (!actBtn || !row) return;
    return this.apply(actBtn.dataset.act!, row.dataset.group as Group, [row.dataset.path!]);
  }

  /** Pressing the row itself shows the file. */
  private onGroupPress(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Buttons are handled on click, not here.
    if (target.closest("[data-act]") || target.closest("[data-bulk]") || target.closest("[data-stash-act]")) return;

    // A file inside an opened stash: shown as it was when the stash was made,
    // against the commit it was made on.
    const stashFile = target.closest<HTMLElement>("[data-stash-file]");
    if (stashFile) {
      const ref = stashFile.dataset.stashRef!;
      return this.cb.openDiff(stashFile.dataset.stashFile!, `${ref}^..${ref}`);
    }

    // A stash row opens to show what is in it.
    const stashRow = target.closest<HTMLElement>("[data-stash]");
    if (stashRow?.dataset.stash) return void this.toggleStash(stashRow.dataset.stash);

    const row = target.closest<HTMLElement>(".gp-row");
    if (!row?.dataset.path) return;
    const path = row.dataset.path;
    const group = row.dataset.group as Group;

    // Untracked files have no "before" side, so they open in the editor.
    //
    // Conflicts open there too, and for a stronger reason: the file on disk is
    // the one git left the markers in, and the editor is where `accept current`
    // / `accept incoming` / `accept both` live. Opening a conflict as a diff —
    // which is what this did — showed the marker lines as "added" text with no
    // way to act on them, so the one thing the row is for was reachable only by
    // finding the same file again in the explorer.
    if (group === "untracked" || group === "conflict") this.cb.openFile(path);
    else this.cb.openDiff(path, group === "staged" ? "staged" : "worktree");
  }

  private async apply(action: string, group: Group, paths: string[]): Promise<void> {
    if (!paths.length || this.busy) return;
    try {
      if (action === "stage") await this.agent.call("git.stage", { paths });
      else if (action === "unstage") await this.agent.call("git.unstage", { paths });
      else if (action === "discard") {
        const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
        const ok = await modalConfirm({
          title: `Discard changes in ${what}?`,
          detail:
            group === "untracked"
              ? "Untracked files are deleted outright — git has no copy to restore."
              : "The file goes back to its staged content. This cannot be undone.",
          okLabel: "discard",
          danger: true,
        });
        if (!ok) return;
        // `git checkout --` cannot restore a file git has never seen; deleting
        // it is what "discard" means for an untracked entry.
        if (group === "untracked") await this.agent.call("fs.delete", { paths });
        else await this.agent.call("git.discard", { paths });
      }
      await this.refresh();
      this.cb.afterChange();
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** What the branch still owes its remote: as arrows, as words, as a sentence
   *  — or null when it owes nothing.
   *
   *  One description for the two controls that report it, the arrows in the
   *  header and the reminder in the commit block. Before there was one control
   *  and it was hidden unless the branch had an upstream, so the branch with
   *  the most unpublished work on it — one that exists only on this machine —
   *  was the one that said nothing at all. */
  private syncState(): { arrows: string; words: string; title: string; unpushed: boolean } | null {
    const st = this.status;
    // A detached HEAD has nothing to publish and nowhere to put it.
    if (!st?.branch) return null;
    const n = (c: number): string => `${c} commit${c === 1 ? "" : "s"}`;
    if (!st.upstream) {
      // ahead and behind are both 0 without an upstream — there is nothing for
      // git to count against — so this reports the state, not an amount. And
      // only where there is somewhere to publish to: in a repository with no
      // remote, "publish" is an offer that cannot be taken.
      if (!this.hasRemote) return null;
      const title = `Push ${st.branch} to the remote and track it — it is on this machine only`;
      return { arrows: "publish", words: "publish branch", title, unpushed: true };
    }
    const { ahead, behind } = st;
    if (!ahead && !behind) return null;
    return {
      arrows: [behind ? `↓${behind}` : "", ahead ? `↑${ahead}` : ""].filter(Boolean).join(" "),
      words: behind && ahead ? `sync ↓${behind} ↑${ahead}` : ahead ? `push ${ahead}` : `pull ${behind}`,
      title:
        behind && ahead ? `Pull ${n(behind)} from ${st.upstream}, then push ${n(ahead)}`
        : behind ? `Pull ${n(behind)} from ${st.upstream}`
        : `Push ${n(ahead)} to ${st.upstream}`,
      unpushed: ahead > 0,
    };
  }

  /** Behind, ahead, or both — one press does the right thing in the right
   *  order. Pulling first is not a preference: pushing while behind is what
   *  produces the non-fast-forward rejection this saves people from. */
  private async sync(): Promise<void> {
    const behind = this.status?.behind ?? 0;
    if (behind) {
      await this.remote("pull", {});
      // Pull can stop on a conflict or refuse over local changes; either way
      // pushing on top of that would be the wrong next move.
      if ((this.status?.behind ?? 0) > 0) return;
    }
    // No upstream is the publish case: nothing to compare, everything to send.
    if ((this.status?.ahead ?? 0) > 0 || !this.status?.upstream) await this.push();
  }

  /** The message box grows with what is in it, and says how long the first
   *  line is once that starts to matter.
   *
   *  Two rows fixed was enough for a subject and nothing else: a body had to be
   *  written into a scrolling slot two lines tall. The 50/72 convention is
   *  reported, not enforced — it is a convention, and a tool that refused to
   *  commit over it would be wrong about some repositories. */
  private onMessageInput(): void {
    const box = this.$<HTMLTextAreaElement>(".js-message");
    // The complaint about an empty message answered itself the moment there is
    // one, so it goes as soon as typing starts.
    if (box.value.trim()) this.cb.dismiss(MSG_SCOPE);
    // Reset first: without it the box can only ever grow.
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 240)}px`;

    const subject = box.value.split("\n", 1)[0] ?? "";
    const len = this.$(".js-len");
    const over = subject.length > 72 ? "over" : subject.length > 50 ? "long" : "";
    len.textContent = over ? `${subject.length}` : "";
    len.title = over
      ? subject.length > 72
        ? "The subject is over 72 characters — git log and most review tools will cut it."
        : "Over 50 characters. Convention keeps the subject short and puts the detail in the body, after a blank line."
      : "";
    len.className = `gp-len js-len${over ? ` is-${over}` : ""}`;
  }

  /** The full message of HEAD — subject, then body. */
  private async lastMessage(): Promise<string | null> {
    try {
      const [head] = await this.agent.call<Commit[]>("git.log", { limit: 1 });
      if (!head) return null;
      const detail = await this.agent.call<CommitDetail>("git.commitDetail", { oid: head.oid });
      const body = detail.body.trim();
      return body ? `${head.subject}\n\n${body}` : head.subject;
    } catch {
      // Not being able to read it is not a reason to block the amend; the box
      // simply stays empty and git keeps the original message.
      return null;
    }
  }

  /** Recent messages, to reuse or to edit. Read from the log, so there is no
   *  private list to keep in step with what was actually committed. */
  private async messageHistory(e: MouseEvent): Promise<void> {
    const { x, y } = { x: e.clientX, y: e.clientY };
    let recent: Commit[] = [];
    try {
      recent = await this.agent.call<Commit[]>("git.log", { limit: 12 });
    } catch (err) {
      return this.cb.toast(err instanceof Error ? err.message : String(err), true);
    }
    const seen = new Set<string>();
    const items: MenuItem[] = [];
    for (const c of recent) {
      if (!c.subject.trim() || seen.has(c.subject)) continue;
      seen.add(c.subject);
      items.push({
        label: c.subject.length > 64 ? `${c.subject.slice(0, 63)}…` : c.subject,
        run: () => {
          const box = this.$<HTMLTextAreaElement>(".js-message");
          box.value = c.subject;
          this.onMessageInput();
          box.focus();
        },
      });
      if (items.length === 8) break;
    }
    if (!items.length) return this.cb.toast("No commits yet to take a message from.");
    showMenu(x, y, items);
  }

  /** The tail of a commit report: what is now waiting to be sent.
   *
   *  A commit is local, and the panel said nothing about that — the count sat
   *  in a pair of arrows in the header that nothing pointed at, and on a branch
   *  with no upstream it did not sit anywhere. Read after the commit, so the
   *  commit just made is in it. */
  private pushTail(): string {
    const st = this.status;
    if (!st?.branch) return "";
    if (!st.upstream) return this.hasRemote ? " · branch not published" : "";
    return st.ahead > 0 ? ` · ${st.ahead} to push` : "";
  }

  private async commit(amend: boolean, thenPush = false): Promise<void> {
    const box = this.$<HTMLTextAreaElement>(".js-message");
    // Amending with an empty box used to mean "keep git's message", which is
    // right, but the message was then invisible: you were replacing a commit
    // whose text you could not see. Now it is put in the box to be edited.
    if (amend && !box.value.trim()) {
      const previous = await this.lastMessage();
      if (previous) {
        box.value = previous;
        this.onMessageInput();
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
        return this.cb.toast("Previous message loaded — edit it and press amend again.");
      }
    }
    const message = box.value.trim();
    if (!message && !amend) return this.cb.toast("Commit message is required", true, MSG_SCOPE);

    // Nothing staged: git answers with the whole of `git status` and four
    // hints about commands to run in a terminal — in a web UI, to a person who
    // has just pressed a button labelled "commit". Ask instead.
    const g = this.groups();
    const stageable = [...g.changes, ...g.untracked, ...g.conflict];
    if (!amend && !g.staged.length) {
      if (!stageable.length) return this.cb.toast("Nothing to commit — no changes in the working tree", true);
      const ok = await modalConfirm({
        title: `Nothing is staged. Stage ${stageable.length} file${stageable.length === 1 ? "" : "s"} and commit?`,
        detail: "Everything currently listed as changed or untracked goes into this commit.",
        okLabel: "stage all and commit",
      });
      if (!ok) return;
      try {
        await this.agent.call("git.stage", { paths: [...new Set(stageable.map((e) => e.path))] });
      } catch (e) {
        return this.cb.toast(e instanceof Error ? e.message : String(e), true);
      }
    }

    const staged = amend ? 0 : this.groups().staged.length || stageable.length;
    try {
      // git prints "[develop 592633f] subject" and a file tally; with LC_ALL=C
      // in the agent that first line is stable enough to quote the hash out of.
      // Saying only "committed" left the one question a person asks next — did
      // it take, and what went in — answered nowhere but the log.
      const out = String(await this.agent.call<string>("git.commit", { message, amend }) ?? "");
      box.value = "";
      this.onMessageInput();
      const oid = /^\[[^\]]*?\s([0-9a-f]{7,40})\]/m.exec(out)?.[1];
      const files = staged ? ` · ${staged} file${staged === 1 ? "" : "s"}` : "";
      // Before the report, not after it: the commit is only part of the news.
      // The rest — how much is now waiting to be sent — is in the status this
      // reads, and reporting first meant quoting the count from before the
      // commit that had just changed it.
      await this.refresh();
      // git's own summary — the branch, the insert/delete tally, any mode
      // changes — goes to the log; the line above is what the toast holds.
      this.cb.report(`${amend ? "amended" : "committed"}${oid ? ` ${oid.slice(0, 7)}` : ""}${files}${this.pushTail()}`, out);
      this.cb.afterChange();
      // "and push" is the whole point of the shortcut, so a branch with no
      // upstream gets published rather than told it has no upstream.
      if (thenPush) await this.sync();
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  // ── branches ────────────────────────────────────────────────────────────

  /** The menu is now actions only — the list of branches lives in the picker,
   *  which can filter, show remote branches and tags, and say which branch is
   *  ahead of what. A flat menu could do none of that. */
  private branchMenu(e: MouseEvent): void {
    const current = this.status?.branch ?? null;
    const items: MenuItem[] = [
      { label: "Switch to…", hint: "checkout", run: () => void this.switchBranch() },
      { label: "Create branch…", run: () => void this.createBranch() },
      { label: "Create branch from…", run: () => void this.createBranch(true) },
      // Before deciding to merge or rebase, the question is usually what is
      // actually on the other branch — a release against main, a feature
      // against develop. That could only be answered by finding both tips in
      // the history graph and marking them for comparison one at a time.
      {
        label: "Compare with…",
        separated: true,
        disabled: !current,
        run: () =>
          void this.chooseThen(`Compare ${current} with which ref?`, async (ref) => {
            if (current) this.cb.compareRefs(current, ref);
          }),
      },
      { label: "Merge into current…", separated: true, run: () => void this.chooseThen("Merge which ref into the current branch?", (ref) => this.mergeChoosing(ref)) },
      { label: "Rebase current onto…", run: () => void this.chooseThen("Rebase the current branch onto…", (ref) => this.rebase(ref)) },
      { label: "Rename this branch…", separated: true, run: () => void this.renameBranch(current) },
      { label: "Publish this branch", run: () => void this.publishBranch(current) },
      { label: "Delete branch…", danger: true, run: () => void this.deleteBranch() },
      { label: "Delete remote branch…", danger: true, run: () => void this.deleteRemoteBranch() },
    ];
    showMenu(e.clientX, e.clientY, items);
  }

  /** The ref list as it is right now.
   *
   *  The panel's copy is from its last refresh, and a branch someone pushed a
   *  minute ago in another window is exactly the branch they are reaching for.
   *  One `git.branches` call is cheaper than a picker that quietly does not
   *  list what the user is looking at in a terminal beside it. */
  private async freshRefs(): Promise<Branch[]> {
    try {
      this.branches = await this.agent.call<Branch[]>("git.branches");
    } catch {
      /* keep the last known list — a stale picker beats no picker */
    }
    return this.branches;
  }

  /** Check out a branch — including a remote one, which creates the local
   *  tracking branch that `git checkout origin/x` would refuse to make. */
  private async switchBranch(): Promise<void> {
    const ref = await pickRef({
      title: "Switch to",
      refs: await this.freshRefs(),
      current: this.status?.branch,
      excludeCurrent: true,
      okLabel: "switch",
      hint: "A remote branch creates a local one that tracks it. A tag or a commit checks out detached.",
    });
    if (!ref) return;

    if (!(await this.clearTheWay(`switching to ${ref}`))) return;

    const remote = this.branches.find((b) => b.name === ref && b.remote);
    if (remote) {
      // origin/feature/x -> feature/x, unless that name is taken locally.
      const local = ref.replace(/^[^/]+\//, "");
      const taken = this.branches.some((b) => !b.remote && !b.tag && b.name === local);
      if (taken) return this.cb.toast(`${local} already exists locally — switch to it instead`, true);
      // `git switch -c <local> <origin/x>` both creates and checks out, and
      // sets the upstream because the start point is a remote branch.
      return this.run("git.branchCreate", { name: local, from: ref }, `switched to ${local}, tracking ${ref}`);
    }
    return this.run("git.checkout", { ref }, `switched to ${ref}`);
  }

  private async createBranch(fromRef = false): Promise<void> {
    let from: string | undefined;
    if (fromRef) {
      const base = await pickRef({
        title: "Create the branch from which ref?",
        refs: await this.freshRefs(),
        current: this.status?.branch,
        okLabel: "use this",
      });
      if (!base) return;
      from = base;
    }
    const name = await modalPrompt({
      title: from ? `New branch from ${from}` : "New branch",
      placeholder: "feature/my-change",
      okLabel: "create",
    });
    if (name) await this.run("git.branchCreate", { name, from }, `created ${name}${from ? ` from ${from}` : ""}`);
  }

  private async renameBranch(current: string | null): Promise<void> {
    if (!current) return this.cb.toast("HEAD is detached — there is no branch to rename", true);
    const to = await modalPrompt({ title: `Rename ${current} to`, value: current, okLabel: "rename" });
    if (to && to !== current) await this.run("git.branchRename", { from: current, to }, `renamed to ${to}`);
  }

  /** Push a branch that has no upstream yet and set it. Separate from the
   *  overflow menu's "Push and set upstream" because this is where someone
   *  looks for it: it is a thing you do to a branch. */
  private async publishBranch(current: string | null): Promise<void> {
    if (!current) return this.cb.toast("HEAD is detached — there is nothing to publish", true);
    if (this.status?.upstream) return this.cb.toast(`${current} already tracks ${this.status.upstream}`);
    await this.remote("push", { setUpstream: true, remote: "origin", ref: current });
  }

  private async deleteBranch(): Promise<void> {
    const name = await pickRef({
      title: "Delete which branch?",
      refs: await this.freshRefs(),
      kinds: ["local"],
      current: this.status?.branch,
      excludeCurrent: true, // git refuses to delete the branch you are on
      okLabel: "delete",
    });
    if (!name) return;
    try {
      await this.agent.call("git.branchDelete", { name });
      this.cb.toast(`deleted ${name}`);
    } catch (e) {
      // Only one failure has a second chance worth offering. Everything else —
      // a name that does not exist, a branch checked out in a worktree, an
      // agent that went away — used to be dressed up as "not fully merged" and
      // answered with a force-delete button.
      const message = e instanceof Error ? e.message : String(e);
      if (!/not fully merged/i.test(message)) {
        this.cb.toast(message, true);
        await this.refresh();
        return;
      }
      const force = await modalConfirm({
        title: `${name} is not fully merged. Delete anyway?`,
        detail: "Commits reachable only from this branch will be left unreferenced.",
        okLabel: "delete",
        danger: true,
      });
      if (force) return this.run("git.branchDelete", { name, force: true }, `force-deleted ${name}`);
    }
    await this.refresh();
  }

  /** Delete a branch on the remote. `git push <remote> --delete <branch>` in
   *  the UI, because otherwise the only way to tidy up a merged feature branch
   *  is to leave the app. */
  private async deleteRemoteBranch(): Promise<void> {
    const picked = await pickRef({
      title: "Delete which remote branch?",
      refs: await this.freshRefs(),
      kinds: ["remote"],
      okLabel: "delete on remote",
      hint: "This removes the branch on the server. The local copy, if any, stays.",
    });
    if (!picked) return;
    const [remote, ...rest] = picked.split("/");
    const branch = rest.join("/");
    if (!remote || !branch) return this.cb.toast(`${picked} is not a remote branch`, true);

    const ok = await modalConfirm({
      title: `Delete ${branch} on ${remote}?`,
      detail: "Anyone who has not fetched since will still have it locally. Recreating it means pushing again.",
      okLabel: "delete on remote",
      danger: true,
    });
    // `git push <remote> :<branch>` — the refspec with an empty source, which
    // is git\x27s own way of saying "delete that ref over there". Using it keeps
    // this to the arguments the agent already accepts, rather than a new
    // protocol flag that both agent implementations would have to grow.
    if (ok) await this.remote("push", { remote, ref: `:${branch}` });
  }

  /** Uncommitted work in the way of an operation that rewrites the worktree.
   *
   *  git's own answer is to refuse with "Your local changes to the following
   *  files would be overwritten … Please commit your changes or stash them",
   *  which used to arrive as a disappearing toast and left the user to work out
   *  both what to do and how to do it here. This asks first, and can do the
   *  stashing itself.
   *
   *  Returns false when the caller should not proceed.
   */
  private async clearTheWay(what: string): Promise<boolean> {
    const g = this.groups();
    // Untracked files are not in git's way for a checkout — it only refuses
    // over tracked changes it would have to overwrite.
    const dirty = g.staged.length + g.changes.length;
    if (!dirty) return true;

    const stash = await modalConfirm({
      title: `${dirty} uncommitted change${dirty === 1 ? "" : "s"} would be in the way of ${what}.`,
      detail: "Stashing puts them aside (including untracked files) so you can bring them back with “Pop latest stash”. Cancel to commit them first instead.",
      okLabel: "stash and continue",
    });
    // Backing out here abandons an operation the user already asked for, and
    // saying nothing about it is how "I pressed switch and nothing happened"
    // happens: the dialog closes, the branch does not change, and there is not
    // a line about it in the panel or the output log.
    if (!stash) {
      this.cb.toast(`${what} cancelled — the working tree was left as it is`);
      return false;
    }

    try {
      await this.agent.call("git.stash", { action: "push", message: `before ${what}` });
      this.cb.toast("changes stashed");
      await this.refresh();
      return true;
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
      return false;
    }
  }

  private async chooseThen(title: string, then: (ref: string) => Promise<void>): Promise<void> {
    const ref = await pickRef({
      title,
      refs: await this.freshRefs(),
      current: this.status?.branch,
      excludeCurrent: true,
      okLabel: "go",
    });
    if (ref) await then(ref);
  }

  /** Merge, after asking how.
   *
   *  The three strategies are not interchangeable and the workflow decides
   *  which one is correct: gitflow wants `--no-ff` so a feature stays visible
   *  as one merge in the history, trunk-based wants `--squash` so it lands as a
   *  single commit, and a fast-forward is what you want when the branch is just
   *  ahead. Before this the button did whichever git defaults to, which is the
   *  right answer for exactly one of those.
   *
   *  Asked per merge rather than remembered: unlike pull, this is a decision
   *  about one particular branch — a release merge and a tidy-up merge in the
   *  same repository want different answers.
   */
  private async mergeChoosing(ref: string): Promise<void> {
    const mode = await modalChoice<"default" | "no-ff" | "squash">({
      title: `Merge ${ref} into ${this.status?.branch ?? "the current branch"}?`,
      detail: "How the commits from that branch should land here.",
      options: [
        {
          value: "default",
          label: "Merge",
          detail: "Fast-forwards when it can, otherwise makes a merge commit. Git's default.",
        },
        {
          value: "no-ff",
          label: "Merge commit always (--no-ff)",
          detail: "Keeps the branch visible as one merge even when a fast-forward was possible. The gitflow default.",
        },
        {
          value: "squash",
          label: "Squash (--squash)",
          detail: "Puts the whole branch in the index as one set of changes, for you to commit as a single commit.",
        },
      ],
    });
    if (!mode) return;
    await this.merge(ref, mode);
  }

  private async merge(ref: string, mode: "default" | "no-ff" | "squash" = "default"): Promise<void> {
    try {
      const r = await this.agent.call<{ conflict: boolean; output: string }>("git.merge", {
        ref,
        noFf: mode === "no-ff",
        squash: mode === "squash",
      });
      // A conflict notice describes the repository, not the click, so it is
      // scoped: the banner takes over from here, and the toast comes down by
      // itself when the merge is finished or aborted.
      //
      // "merged" was also said for a merge that did nothing. Merging a branch
      // that is already an ancestor is the commonest thing to get wrong about
      // a branch — git says "Already up to date", and the UI used to swallow
      // it, leaving a panel that looks identical either way.
      this.cb.report(
        r.conflict ? "merge stopped with conflicts — resolve them below" : mergeOutcome(ref, r.output, mode),
        r.output,
        { isError: r.conflict, scope: r.conflict ? OP_SCOPE : undefined },
      );
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
    await this.refresh();
    this.cb.afterChange();
  }

  private async rebase(ref: string): Promise<void> {
    try {
      const r = await this.agent.call<{ conflict: boolean; output: string }>("git.rebase", { action: "start", ref });
      this.cb.report(
        r.conflict ? "rebase stopped with conflicts — resolve them below, then continue" : `rebased onto ${ref}`,
        r.output,
        { isError: r.conflict, scope: r.conflict ? OP_SCOPE : undefined },
      );
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
    await this.refresh();
    this.cb.afterChange();
  }

  // ── remotes and the overflow menu ───────────────────────────────────────

  private async moreMenu(e: MouseEvent): Promise<void> {
    const { x, y } = { x: e.clientX, y: e.clientY };
    const st = this.status;
    // Whatever the last status said. This used to be probed here by asking git
    // to resolve MERGE_HEAD and REBASE_HEAD — and REBASE_HEAD survives a
    // *finished* rebase, so the menu went on offering "Continue rebase" and
    // "Abort rebase" for the rest of the session, both of which could only
    // answer "fatal: no rebase in progress". The agent now reads the state git
    // actually keeps for the question (see git.ts: operation()).
    const op = st?.operation ?? null;

    const items: MenuItem[] = [];

    // Push and pull. "Push and set upstream" is only an answer when there is
    // no upstream; with one configured it was offering to redo what is done.
    if (st?.branch && !st.upstream) {
      items.push({
        label: "↑ Publish this branch (push -u origin)",
        run: () => void this.remote("push", { setUpstream: true, remote: "origin", ref: st.branch ?? undefined }),
      });
    }
    items.push({ label: "⇡ Force push (with lease)", run: () => void this.forcePush(), danger: true });

    // Remotes and tags: configuration rather than a step in today's work, so
    // they sit below the two things the panel is usually opened for.
    items.push({ label: "⇅ Remotes…", separated: true, run: () => void this.manageRemotes(x, y) });
    items.push({ label: "⚑ Create tag…", run: () => void this.createTag() });
    if (this.branches.some((b) => b.tag)) {
      items.push({ label: "⚑ Delete tag…", danger: true, run: () => void this.deleteTag() });
    }

    // Undo. Placed where it can be found in a hurry, and it is the only item
    // here that can reach something no other item can.
    items.push({ label: "↶ Undo the last operation…", separated: true, run: () => void this.undoMenu(x, y) });

    // Stash.
    items.push({ label: "⌷ Stash changes…", separated: true, run: () => void this.stash() });
    if (this.stashes.length) {
      items.push({
        label: `↥ Pop latest stash (${stashLabel(this.stashes[0].subject).text || this.stashes[0].ref})`,
        run: () => void this.stashAction("pop", this.stashes[0].ref),
      });
    }

    // What the pull button will do, and how to change it. Shown as the current
    // answer rather than as a submenu of three: the setting matters to people
    // who care about the shape of their history, and they want to see at a
    // glance which one is armed.
    items.push({
      label: `⤓ Pull strategy: ${PULL_LABELS[this.pull ?? "merge"]}${this.pull ? "" : " (not chosen yet)"}`,
      separated: true,
      run: () => void this.choosePullMode(),
    });

    // How the list is shown. Two settings, so they are a pair of toggles rather
    // than a submenu nobody would find.
    items.push(
      {
        label: this.view === "tree" ? "☰ View as list" : "⊞ View as tree",
        separated: true,
        run: () => this.setView(this.view === "tree" ? "list" : "tree"),
      },
      {
        label: this.sort === "status" ? "⇅ Sort by path" : "⇅ Sort by status",
        run: () => this.setSort(this.sort === "status" ? "name" : "status"),
      },
    );

    // Recovery. Shown only while there is something to recover from — the
    // banner above the file list carries the same three, which is where they
    // are meant to be found; these are for the hand that is already in the menu.
    if (op) {
      if (op.kind !== "merge") {
        items.push(
          { label: `▶ Continue ${op.kind}`, separated: true, run: () => void this.operationStep("continue", op) },
          { label: "↷ Skip this commit", run: () => void this.operationStep("skip", op) },
        );
      }
      items.push({
        label: `✕ Abort ${op.kind}`,
        separated: op.kind === "merge",
        danger: true,
        run: () => void this.operationStep("abort", op),
      });
    }

    showMenu(x, y, items);
  }

  private setView(view: "list" | "tree"): void {
    this.view = view;
    savePref(VIEW_KEY, view);
    this.renderedKey = "";
    this.render();
  }

  private setSort(sort: "name" | "status"): void {
    this.sort = sort;
    savePref(SORT_KEY, sort);
    this.renderedKey = "";
    this.render();
  }

  private async forcePush(): Promise<void> {
    const ok = await modalConfirm({
      title: "Force-push with --force-with-lease?",
      detail: "It refuses to overwrite commits this clone has not seen, but it will rewrite the remote branch.",
      okLabel: "force push",
      danger: true,
    });
    if (ok) await this.remote("push", { force: true });
  }

  private async push(): Promise<void> {
    // Without an upstream a bare `git push` fails with a long hint; set it here.
    if (this.status && !this.status.upstream && this.status.branch) {
      return this.remote("push", { setUpstream: true, remote: "origin", ref: this.status.branch });
    }
    return this.remote("push", {});
  }

  /** Pull, having settled what "pull" means here.
   *
   *  The question is only worth asking when the answer changes the history:
   *  with nothing local to replay, all three strategies fast-forward and are
   *  the same operation. So a straightforward "I am behind" pull just runs, and
   *  a divergence — the case where a merge commit appears out of nowhere — asks
   *  once and remembers. The choice is visible and changeable in the overflow
   *  menu afterwards. */
  private async doPull(): Promise<void> {
    const st = this.status;
    const diverged = (st?.ahead ?? 0) > 0 && (st?.behind ?? 0) > 0;
    let mode = this.pull;

    if (diverged && !mode) {
      const picked = await modalChoice<PullMode>({
        title: `Your branch and ${st?.upstream ?? "the remote"} have both moved on.`,
        detail: `${st?.ahead} local commit${st?.ahead === 1 ? "" : "s"}, ${st?.behind} on the remote. How should they be brought together?`,
        options: [
          {
            value: "rebase",
            label: "Rebase — replay my commits on top",
            detail: "Keeps the history linear. Rewrites your local commits, so do not use it on commits you have already shared.",
          },
          {
            value: "merge",
            label: "Merge — join the two with a merge commit",
            detail: "Nothing is rewritten; the history shows the branch coming back together.",
          },
          {
            value: "ff-only",
            label: "Fast-forward only — do nothing if it cannot",
            detail: "Refuses the pull and leaves the branch alone, so you can decide separately.",
          },
        ],
      });
      if (!picked) return;
      mode = picked;
      this.setPullMode(picked);
    }

    await this.remote("pull", { mode: mode ?? "merge" });
  }

  private async choosePullMode(): Promise<void> {
    const picked = await modalChoice<PullMode>({
      title: "What should Pull do with local commits?",
      detail: "Applies when your branch and its upstream have both moved on. It can be changed again at any time.",
      options: [
        { value: "rebase", label: "Rebase — replay my commits on top", detail: "Linear history; rewrites local commits." },
        { value: "merge", label: "Merge — join with a merge commit", detail: "Nothing is rewritten." },
        { value: "ff-only", label: "Fast-forward only", detail: "Refuses to pull when the branches have diverged." },
      ],
    });
    if (picked) this.setPullMode(picked);
  }

  private setPullMode(mode: PullMode): void {
    this.pullModes[this.folderKey] = mode;
    savePref(PULL_KEY, JSON.stringify(this.pullModes));
    this.showPullMode();
  }

  /** Say on the button itself which strategy is armed.
   *
   *  The tooltip alone was not enough: this is a setting that decides whether
   *  the branch gets a merge commit, it is remembered across sessions, and a
   *  tooltip has to be hunted for by someone who already suspects there is
   *  something to know. A two-letter tag next to the arrow is readable at a
   *  glance and costs the width of two characters. Nothing is shown until the
   *  choice has been made, so the button does not claim a strategy git has not
   *  been told about. */
  private showPullMode(): void {
    const btn = this.$<HTMLButtonElement>(".js-pull");
    btn.title = this.pull ? `Pull (${PULL_LABELS[this.pull]})` : "Pull";
    const tag = btn.querySelector<HTMLElement>(".gp-pull-mode") ?? (() => {
      const el = document.createElement("span");
      el.className = "gp-pull-mode";
      btn.appendChild(el);
      return el;
    })();
    tag.textContent = this.pull ? PULL_TAGS[this.pull] : "";
    tag.hidden = !this.pull;
  }

  private async remote(action: "fetch" | "pull" | "push", opts: Record<string, unknown>): Promise<void> {
    // A pull merges into the worktree, so it hits the same wall as a checkout.
    // fetch and push do not touch it and are left alone.
    if (action === "pull" && !(await this.clearTheWay("pulling"))) return;
    // A press while one of these is already running used to be swallowed in
    // silence: the flag returned early, nothing moved, and the panel looked
    // broken. Now the buttons are visibly out of service for the duration, and
    // the one that is running says what it is doing and offers to stop.
    if (this.busy) return;
    this.setBusy(action);

    const progress = this.$<HTMLElement>(".js-progress");
    const { id, promise } = this.agent.callTracked("git.remote", { action, ...opts }, (chunk) => {
      const line = (chunk as { progress?: string }).progress;
      if (line) this.$(".js-progress-text").textContent = line;
    });
    progress.querySelector(".js-cancel")!.addEventListener("click", () => {
      this.$(".js-progress-text").textContent = `stopping ${action}…`;
      void this.agent.call("cancel", { target: id }).catch(() => undefined);
    });

    // What the branch looked like before, so the report can be about what
    // moved rather than about the command having returned. "pull complete" is
    // true of a pull that brought nothing and of one that brought thirty
    // commits, and those are different pieces of news.
    const before = { ahead: this.status?.ahead ?? 0, behind: this.status?.behind ?? 0, upstream: this.status?.upstream ?? null };

    try {
      const r = (await promise) as { output?: string } | undefined;
      this.setBusy(null);
      await this.refresh();
      // The progress git streamed while this ran — which objects were counted,
      // which refs moved, what it rejected — kept where it can be read back.
      this.cb.report(this.remoteOutcome(action, before), r?.output);
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
      await this.refresh();
    } finally {
      this.setBusy(null);
      this.cb.afterChange();
    }
  }

  /** What a finished fetch/pull/push actually did, from the divergence it
   *  changed. Read from the status rather than parsed out of git's progress
   *  chatter: the counts are the same ones the panel already shows. */
  private remoteOutcome(
    action: "fetch" | "pull" | "push",
    before: { ahead: number; behind: number; upstream: string | null },
  ): string {
    const st = this.status;
    const upstream = st?.upstream ?? before.upstream;
    const where = upstream ? ` ${action === "push" ? "to" : "from"} ${upstream}` : "";
    const n = (count: number): string => `${count} commit${count === 1 ? "" : "s"}`;

    if (action === "fetch") {
      const found = (st?.behind ?? 0) - before.behind;
      return found > 0 ? `fetched — ${n(found)} to pull${where}` : "fetched — nothing new";
    }
    if (action === "pull") {
      const pulled = before.behind - (st?.behind ?? 0);
      return pulled > 0 ? `pulled ${n(pulled)}${where}` : "already up to date";
    }
    const pushed = before.ahead - (st?.ahead ?? 0);
    // A first push of a new branch has no "before" to compare against, so it
    // reports what it sent rather than a difference of nothing.
    return pushed > 0 ? `pushed ${n(pushed)}${where}` : before.ahead ? `pushed ${n(before.ahead)}${where}` : `pushed${where}`;
  }

  /** One place decides what "an operation is running" looks like. */
  private setBusy(action: string | null): void {
    this.busy = action !== null;
    const progress = this.$<HTMLElement>(".js-progress");
    progress.hidden = action === null;
    if (action) {
      progress.innerHTML = `<span class="js-progress-text">${esc(action)}…</span>
        <span class="t-spacer"></span>
        <button class="t-btn js-cancel" type="button">stop</button>`;
    }
    // Everything that talks to the remote, plus commit and amend: while one is
    // in flight the rest would only queue up behind it or fail.
    for (const sel of [".js-fetch", ".js-pull", ".js-push", ".js-more", ".js-commit", ".js-amend", ".js-unpushed"]) {
      this.$<HTMLButtonElement>(sel).disabled = this.busy;
    }
    this.host.classList.toggle("is-busy", this.busy);
  }

  /** Put the working tree aside under a name.
   *
   *  Naming it is the whole point: git's own default label is "WIP on main:
   *  <oid> <subject of HEAD>", which describes the commit underneath the stash
   *  and says nothing about what is in it. */
  private async stash(): Promise<void> {
    const g = this.groups();
    const count = g.staged.length + g.changes.length + g.untracked.length;
    if (!count) return this.cb.toast("Nothing to stash — the working tree is clean.");
    const message = await modalPrompt({
      title: `Stash ${count} change${count === 1 ? "" : "s"}`,
      hint: "Untracked files are included. Leave the message empty to let git name it.",
      placeholder: "what is in this stash",
      okLabel: "stash",
    });
    // An empty string is a real answer here ("name it yourself, git"); only a
    // cancelled dialog stops.
    if (message === null) return;
    await this.run("git.stash", { action: "push", message: message || undefined }, "changes stashed");
  }

  private async stashAction(action: "apply" | "pop" | "drop", ref: string): Promise<void> {
    if (action === "drop") {
      const entry = this.stashes.find((s) => s.ref === ref);
      const ok = await modalConfirm({
        title: `Drop ${ref}?`,
        detail: `“${stashLabel(entry?.subject ?? "").text || ref}” is deleted. A dropped stash is not on any branch, so there is nothing to restore it from.`,
        okLabel: "drop",
        danger: true,
      });
      if (!ok) return;
    }
    await this.run("git.stash", { action, ref }, `${ref} ${action === "drop" ? "dropped" : action === "pop" ? "popped" : "applied"}`);
  }

  /** Run one agent op, report it, then reload everything that may have moved. */
  // ── remotes ───────────────────────────────────────────────────────────
  //
  // Listing them was always possible; changing them was not, so adding a
  // remote meant a terminal — and the panel's whole claim is that ordinary git
  // does not.

  private async manageRemotes(x: number, y: number): Promise<void> {
    let remotes: { name: string; url: string }[] = [];
    try {
      remotes = await this.agent.call<{ name: string; url: string }[]>("git.remotes");
    } catch (e) {
      return this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
    const items: MenuItem[] = remotes.map((r) => ({
      // The URL is what tells two remotes apart, and it is long — so it is the
      // hint, where the menu will trim it, rather than part of the label.
      label: `⇅ ${r.name}`,
      hint: r.url,
      run: () => void this.remoteMenu(x, y, r),
    }));
    if (!remotes.length) items.push({ label: "No remotes configured", disabled: true, run: () => undefined });
    items.push({ label: "+ Add a remote…", separated: true, run: () => void this.addRemote() });
    showMenu(x, y, items);
  }

  private async remoteMenu(x: number, y: number, remote: { name: string; url: string }): Promise<void> {
    showMenu(x, y, [
      { label: `Fetch from ${remote.name}`, run: () => void this.remote("fetch", { remote: remote.name }) },
      { label: "Rename…", separated: true, run: () => void this.renameRemote(remote.name) },
      { label: "Remove", danger: true, run: () => void this.removeRemote(remote.name) },
    ]);
  }

  private async addRemote(): Promise<void> {
    const name = await modalPrompt({ title: "Add a remote", hint: "The short name you will type: origin, upstream, a fork.", placeholder: "origin", okLabel: "next" });
    if (!name) return;
    const url = await modalPrompt({
      title: `URL for ${name}`,
      hint: "https, ssh or git — a local path is not accepted.",
      placeholder: "https://github.com/you/project.git",
      okLabel: "add",
    });
    if (!url) return;
    await this.run("git.remoteAdmin", { action: "add", name, url }, `remote ${name} added`);
  }

  private async renameRemote(name: string): Promise<void> {
    const to = await modalPrompt({ title: `Rename ${name}`, value: name, okLabel: "rename" });
    if (!to || to === name) return;
    await this.run("git.remoteAdmin", { action: "rename", name, to }, `remote renamed to ${to}`);
  }

  private async removeRemote(name: string): Promise<void> {
    // Local only — it forgets the address and the remote-tracking branches, and
    // touches nothing on the server. Worth saying, because "remove remote"
    // reads like it might not be.
    const ok = await modalConfirm({
      title: `Remove the remote "${name}"?`,
      detail: `This forgets its address and its remote-tracking branches here. Nothing on the server changes.`,
      okLabel: "remove",
      danger: true,
    });
    if (!ok) return;
    await this.run("git.remoteAdmin", { action: "remove", name }, `remote ${name} removed`);
  }

  // ── tags ──────────────────────────────────────────────────────────────

  private async createTag(): Promise<void> {
    const name = await modalPrompt({ title: "New tag", placeholder: "v1.2.0", okLabel: "next" });
    if (!name) return;
    // A message makes it an annotated tag — an object with an author and a
    // date, which is what a release wants; without one it is a lightweight
    // pointer, which is what a bookmark wants.
    //
    // The dialog cannot tell an empty answer from a cancelled one (both come
    // back as null), so the second step does not offer a way out: the tag is
    // created either way, and skipping the message is how you choose the
    // lightweight kind. The hint says so rather than leaving it to be found.
    const message = await modalPrompt({
      title: `Tag ${name} at HEAD`,
      hint: "With a message it is an annotated tag; skip it for a lightweight one. Either way the tag is created.",
      placeholder: "release 1.2.0",
      okLabel: "create",
    });
    await this.run("git.tagCreate", { name, ref: "HEAD", message: message ?? "" }, `tag ${name} created`);
  }

  private async deleteTag(): Promise<void> {
    const refs = await this.freshRefs();
    const name = await pickRef({ title: "Delete which tag?", refs, kinds: ["tag"], okLabel: "delete" });
    if (!name) return;
    const ok = await modalConfirm({
      title: `Delete the tag "${name}"?`,
      detail: "Local only — a tag already pushed stays on the server.",
      okLabel: "delete",
      danger: true,
    });
    if (!ok) return;
    await this.run("git.tagDelete", { name }, `tag ${name} deleted`);
  }

  // ── undo, via the reflog ──────────────────────────────────────────────
  //
  // The menu above can throw work away — reset --hard, a bad merge, a rebase
  // that went sideways — and git remembers where HEAD was before each of them
  // even when nothing else does. This is that list, made pressable: the thing
  // most wanted at the moment it is least easy to reach for.

  private async undoMenu(x: number, y: number): Promise<void> {
    let entries: ReflogEntry[] = [];
    try {
      entries = await this.agent.call<ReflogEntry[]>("git.reflog", { limit: 25 });
    } catch (e) {
      return this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
    // The first entry is where HEAD is now — moving onto it is not an undo.
    const past = entries.slice(1);
    if (!past.length) return this.cb.toast("Nothing in the reflog to go back to.", true);
    showMenu(
      x,
      y,
      past.map((entry) => ({
        label: `${entry.oid.slice(0, 7)} · ${entry.action || "moved"}: ${
          entry.message.length > 48 ? `${entry.message.slice(0, 47)}…` : entry.message
        }`,
        hint: entry.selector,
        run: () => void this.resetTo(entry),
      })),
    );
  }

  private async resetTo(entry: ReflogEntry): Promise<void> {
    // A hard reset is what makes this an undo rather than a suggestion, and it
    // is also what makes it dangerous: it discards the working tree. Saying
    // exactly that, with the number of files at stake, is the least this owes
    // someone reaching for "undo" in a hurry.
    const dirty = (this.status?.entries ?? []).filter((e) => !e.ignored).length;
    const ok = await modalConfirm({
      title: `Move HEAD back to ${entry.oid.slice(0, 7)}?`,
      detail:
        `${entry.selector} — ${entry.action || "moved"}: ${entry.message}\n\n` +
        `This is a hard reset: the working tree goes back with it${
          dirty ? `, and ${dirty} uncommitted change${dirty === 1 ? "" : "s"} will be lost` : ""
        }. Anything committed stays reachable through the reflog.`,
      okLabel: "go back",
      danger: true,
    });
    if (!ok) return;
    await this.run("git.reset", { oid: entry.oid, mode: "hard" }, `HEAD is back at ${entry.oid.slice(0, 7)}`);
  }

  private async run(op: string, params: Record<string, unknown>, okMessage: string): Promise<void> {
    try {
      // Most of these answer with git's stdout; a few answer with an object
      // carrying it. Either way it is the transcript for the log.
      const result = await this.agent.call<unknown>(op, params);
      const output =
        typeof result === "string" ? result
        : typeof (result as { output?: unknown })?.output === "string" ? ((result as { output: string }).output)
        : undefined;
      this.cb.report(okMessage, output);
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
    // Adding or removing a remote is the one thing that changes the answer
    // refresh() caches, so it is the one thing that has to forget it — a
    // remote added through this panel has to reach the publish button.
    if (op === "git.remoteAdmin") this.remotesFor = null;
    await this.refresh();
    this.cb.afterChange();
  }
}
