/** Source-control panel: status, staging, commits, branches, remotes.
 *
 *  Every action is one call into the agent, which runs the system git. That is
 *  why rebase, revert and reset are here at all — they are not reimplemented,
 *  they are the real commands, so their semantics are git's and not an
 *  approximation of them.
 */
import type { AgentClient } from "./agent.ts";
import type { Branch, Commit, CommitDetail, GitStatus, ReflogEntry, StatusEntry } from "../../agent/protocol.ts";
import { esc, modalConfirm, modalPrompt, setHtmlKeepingScroll, showMenu, startTrimmed, type MenuItem } from "./ui.ts";
import { pickRef } from "./refpicker.ts";
import { iconBranch, iconCheck, iconDiscard, iconFetch, iconMinus, iconMore, iconPlus, iconPull, iconPush } from "./icons.ts";

export interface GitPanelCallbacks {
  /** kind: "worktree" (index vs disk), "staged" (HEAD vs index) or a commit oid. */
  openDiff(path: string, kind: string): void;
  openFile(path: string): void;
  toast(message: string, isError?: boolean): void;
  /** Something changed on disk or in refs — reload the tree and decorations. */
  afterChange(): void;
}

type Group = "conflict" | "staged" | "changes" | "untracked";

const GROUP_TITLES: Record<Group, string> = {
  conflict: "merge conflicts",
  staged: "staged changes",
  changes: "changes",
  untracked: "untracked",
};

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
  <div class="gp-commit">
    <textarea class="js-message" rows="2" placeholder="Message (Ctrl+Enter to commit)" spellcheck="false"></textarea>
    <div class="gp-commit-row">
      <button class="t-btn t-btn-primary js-commit" type="button">✓ commit</button>
      <button class="t-btn js-amend" type="button" title="Replace the last commit">amend</button>
      <button class="t-icon js-history" type="button" title="Recent commit messages">↺</button>
      <span class="t-spacer"></span>
      <span class="gp-len js-len" aria-live="off"></span>
    </div>
    <p class="gp-warn js-warn" hidden></p>
  </div>
  <div class="gp-groups js-groups"></div>
  <div class="gp-progress js-progress" hidden></div>`;

/** Collapsible sections: the four file groups plus the stash list. */
type Section = Group | "stash";

const COLLAPSED_KEY = "enc-scm-collapsed";
const VIEW_KEY = "enc-scm-view";
const SORT_KEY = "enc-scm-sort";

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

const savePref = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};

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
  private busy = false;
  /** Fingerprint of the rendered file list, so an unchanged status leaves the
   *  rows — and any click in flight over them — alone. */
  private renderedKey = "";
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
    this.$(".js-pull").addEventListener("click", () => void this.remote("pull", {}));
    this.$(".js-push").addEventListener("click", () => void this.push());
    this.$(".js-commit").addEventListener("click", () => void this.commit(false));
    this.$(".js-amend").addEventListener("click", () => void this.commit(true));
    this.$(".js-history").addEventListener("click", (e) => void this.messageHistory(e as MouseEvent));
    const box = this.$<HTMLTextAreaElement>(".js-message");
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.commit(false);
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
  }

  // ── data ────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (this.agent.state !== "online" || !this.agent.info?.gitVersion) {
      this.status = null;
      this.render();
      return;
    }
    try {
      const [status, branches, identity, stashes] = await Promise.all([
        this.agent.call<GitStatus>("git.status"),
        this.agent.call<Branch[]>("git.branches"),
        this.agent.call<{ name: string | null; email: string | null }>("git.identity"),
        // A repository with no stashes answers with an empty string, not an
        // error, so this never needs its own failure path.
        this.agent.call<string>("git.stash", { action: "list" }).catch(() => ""),
      ]);
      this.status = status;
      this.branches = branches;
      this.stashes = parseStashes(stashes);
      this.failure = null;

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
    set(".js-branch-name", st?.branch ?? (st ? "(detached)" : "—"));

    // The divergence is the most-used control in this panel, so it is a
    // button: it says what it will do and does it. It used to be a <span> —
    // two glyphs, no tooltip, nothing to press — while the actual pull and
    // push hid behind identical arrow icons further along the row.
    const syncBtn = this.$<HTMLButtonElement>(".js-sync");
    const ahead = st?.ahead ?? 0;
    const behind = st?.behind ?? 0;
    syncBtn.hidden = !st?.upstream || (!ahead && !behind);
    if (!syncBtn.hidden) {
      const parts = [behind ? `↓${behind}` : "", ahead ? `↑${ahead}` : ""].filter(Boolean);
      set(".js-sync", parts.join(" "));
      syncBtn.title =
        behind && ahead ? `Pull ${behind} commit${behind === 1 ? "" : "s"} from ${st!.upstream}, then push ${ahead}`
        : behind ? `Pull ${behind} commit${behind === 1 ? "" : "s"} from ${st!.upstream}`
        : `Push ${ahead} commit${ahead === 1 ? "" : "s"} to ${st!.upstream}`;
    }

    const g = this.groups();
    const total = g.conflict.length + g.staged.length + g.changes.length + g.untracked.length;
    const key = JSON.stringify([
      st === null,
      (["conflict", "staged", "changes", "untracked"] as Group[]).map((k) =>
        g[k].map((e) => [e.path, e.index, e.work]),
      ),
      this.stashes.map((s) => [s.ref, s.subject]),
      this.view,
      this.sort,
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
                return `<div class="gp-row gp-stash" data-stash="${esc(s.ref)}"
                  title="${esc(`${s.ref} — ${s.subject}`)}">
                  <span class="gp-name">${esc(text || "(no message)")}</span>
                  <span class="gp-dir">${esc([elsewhere, ago(s.time)].filter(Boolean).join(" · "))}</span>
                  <span class="gp-actions">
                    <button class="t-icon" data-stash-act="apply" title="Apply — keep the stash">↧</button>
                    <button class="t-icon" data-stash-act="pop" title="Pop — apply and remove">↥</button>
                    <button class="t-icon" data-stash-act="drop" title="Drop — delete this stash">${iconDiscard}</button>
                  </span>
                </div>`;
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
        <span>${GROUP_TITLES[group]}</span><span class="gp-count">${entries.length}</span>
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

    const row = target.closest<HTMLElement>(".gp-row");
    // A stash row shares the row class and has no path: it is a saved state,
    // not a file, and there is nothing to open in a diff. Its own buttons are
    // the only thing on it that does anything.
    if (!row?.dataset.path) return;
    const path = row.dataset.path;
    const group = row.dataset.group as Group;

    // Untracked files have no "before" side, so they open in the editor.
    if (group === "untracked") this.cb.openFile(path);
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
    if ((this.status?.ahead ?? 0) > 0) await this.push();
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

  private async commit(amend: boolean): Promise<void> {
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
    if (!message && !amend) return this.cb.toast("Commit message is required", true);

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

    try {
      await this.agent.call("git.commit", { message, amend });
      box.value = "";
      this.onMessageInput();
      this.cb.toast(amend ? "commit amended" : "committed");
      await this.refresh();
      this.cb.afterChange();
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
      { label: "Merge into current…", separated: true, run: () => void this.chooseThen("Merge which ref into the current branch?", (ref) => this.merge(ref)) },
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
    if (!stash) return false;

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

  private async merge(ref: string): Promise<void> {
    try {
      const r = await this.agent.call<{ conflict: boolean; output: string }>("git.merge", { ref });
      this.cb.toast(r.conflict ? "merge stopped with conflicts — resolve them below" : "merged", r.conflict);
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
    await this.refresh();
    this.cb.afterChange();
  }

  private async rebase(ref: string): Promise<void> {
    try {
      const r = await this.agent.call<{ conflict: boolean; output: string }>("git.rebase", { action: "start", ref });
      this.cb.toast(r.conflict ? "rebase stopped with conflicts — resolve, then Continue" : "rebased", r.conflict);
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
    await this.refresh();
    this.cb.afterChange();
  }

  // ── remotes and the overflow menu ───────────────────────────────────────

  /** Is a merge or a rebase half-finished?
   *
   *  `.git` is outside the jail on purpose — a page that can write
   *  `.git/hooks/*` runs code on this machine — so the state cannot be read as
   *  a file. It can be asked of git instead: `MERGE_HEAD` and `REBASE_HEAD`
   *  resolve only while the corresponding operation is in progress, so a log
   *  request for one either answers or fails, and that is the answer.
   *
   *  Probed when the menu opens, not on every refresh: the panel reloads on
   *  every watcher event, and two more git invocations per event is how a
   *  status poll turns into a busy loop.
   */
  private async inProgress(): Promise<{ merge: boolean; rebase: boolean }> {
    const alive = async (ref: string): Promise<boolean> =>
      this.agent
        .call("git.log", { ref, limit: 1 })
        .then(() => true)
        .catch(() => false);
    const [merge, rebase] = await Promise.all([alive("MERGE_HEAD"), alive("REBASE_HEAD")]);
    return { merge, rebase };
  }

  private async moreMenu(e: MouseEvent): Promise<void> {
    const { x, y } = { x: e.clientX, y: e.clientY };
    const st = this.status;
    const state = await this.inProgress();

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

    // Recovery. Shown only while there is something to recover from: these
    // four were always on the menu, four of seven items, and pressing one
    // outside a merge or rebase did nothing but produce an error toast.
    if (state.merge) {
      items.push({ label: "✕ Abort merge", separated: true, danger: true, run: () => void this.run("git.mergeAbort", {}, "merge aborted") });
    }
    if (state.rebase) {
      items.push(
        { label: "▶ Continue rebase", separated: true, run: () => void this.run("git.rebase", { action: "continue" }, "rebase continued") },
        { label: "↷ Skip this commit", run: () => void this.run("git.rebase", { action: "skip" }, "commit skipped") },
        { label: "✕ Abort rebase", danger: true, run: () => void this.run("git.rebase", { action: "abort" }, "rebase aborted") },
      );
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

    try {
      await promise;
      this.cb.toast(`${action} complete`);
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.setBusy(null);
      await this.refresh();
      this.cb.afterChange();
    }
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
    for (const sel of [".js-fetch", ".js-pull", ".js-push", ".js-more", ".js-commit", ".js-amend"]) {
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
      await this.agent.call(op, params);
      this.cb.toast(okMessage);
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
    await this.refresh();
    this.cb.afterChange();
  }
}
