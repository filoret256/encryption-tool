/** Source-control panel: status, staging, commits, branches, remotes.
 *
 *  Every action is one call into the agent, which runs the system git. That is
 *  why rebase, revert and reset are here at all — they are not reimplemented,
 *  they are the real commands, so their semantics are git's and not an
 *  approximation of them.
 */
import type { AgentClient } from "./agent.ts";
import type { Branch, GitStatus, StatusEntry } from "../../agent/protocol.ts";
import { esc, modalPrompt, showMenu } from "./ui.ts";

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

const SHELL = `
  <div class="gp-head">
    <button class="t-btn js-branch" type="button" title="Branches">⑂ <span class="js-branch-name">—</span></button>
    <span class="gp-sync js-sync"></span>
    <span class="t-spacer"></span>
    <button class="t-icon js-fetch" type="button" title="Fetch">⟲</button>
    <button class="t-icon js-pull" type="button" title="Pull">↓</button>
    <button class="t-icon js-push" type="button" title="Push">↑</button>
    <button class="t-icon js-more" type="button" title="More actions">⋯</button>
  </div>
  <div class="gp-commit">
    <textarea class="js-message" rows="2" placeholder="Message (Ctrl+Enter to commit)" spellcheck="false"></textarea>
    <div class="gp-commit-row">
      <button class="t-btn t-btn-primary js-commit" type="button">✓ commit</button>
      <button class="t-btn js-amend" type="button" title="Replace the last commit">amend</button>
    </div>
    <p class="gp-warn js-warn" hidden></p>
  </div>
  <div class="gp-groups js-groups"></div>
  <div class="gp-progress js-progress" hidden></div>`;

export class GitPanel {
  private status: GitStatus | null = null;
  private branches: Branch[] = [];
  private busy = false;

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
    this.$(".js-more").addEventListener("click", (e) => this.moreMenu(e as MouseEvent));
    this.$(".js-fetch").addEventListener("click", () => void this.remote("fetch", {}));
    this.$(".js-pull").addEventListener("click", () => void this.remote("pull", {}));
    this.$(".js-push").addEventListener("click", () => void this.push());
    this.$(".js-commit").addEventListener("click", () => void this.commit(false));
    this.$(".js-amend").addEventListener("click", () => void this.commit(true));
    this.$<HTMLTextAreaElement>(".js-message").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.commit(false);
      }
    });
    this.$(".js-groups").addEventListener("click", (e) => void this.onGroupClick(e as MouseEvent));
  }

  // ── data ────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    if (this.agent.state !== "online" || !this.agent.info?.gitVersion) {
      this.status = null;
      this.render();
      return;
    }
    try {
      const [status, branches, identity] = await Promise.all([
        this.agent.call<GitStatus>("git.status"),
        this.agent.call<Branch[]>("git.branches"),
        this.agent.call<{ name: string | null; email: string | null }>("git.identity"),
      ]);
      this.status = status;
      this.branches = branches;

      // git refuses to commit without an identity; say so before the failure.
      const warn = this.$<HTMLElement>(".js-warn");
      const missing = !identity.name || !identity.email;
      warn.hidden = !missing;
      warn.textContent = missing ? "git user.name / user.email are not set — commits will fail." : "";
    } catch (e) {
      this.status = null;
      if (!/not a git repository/i.test(String(e))) this.cb.toast(String(e), true);
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
    this.$(".js-branch-name").textContent = st?.branch ?? (st ? "(detached)" : "—");

    const sync: string[] = [];
    if (st?.ahead) sync.push(`↑${st.ahead}`);
    if (st?.behind) sync.push(`↓${st.behind}`);
    this.$(".js-sync").textContent = sync.join(" ");

    const g = this.groups();
    const total = g.conflict.length + g.staged.length + g.changes.length + g.untracked.length;
    this.$(".js-groups").innerHTML = !st
      ? `<p class="gp-empty">Not a git repository.</p>`
      : total === 0
        ? `<p class="gp-empty">No changes.</p>`
        : (["conflict", "staged", "changes", "untracked"] as Group[])
            .filter((k) => g[k].length)
            .map((k) => this.groupHtml(k, g[k]))
            .join("");
  }

  private groupHtml(group: Group, entries: StatusEntry[]): string {
    const bulk =
      group === "staged"
        ? `<button class="t-icon" data-bulk="unstage" data-group="${group}" title="Unstage all">−</button>`
        : group === "conflict"
          ? `<button class="t-icon" data-bulk="stage" data-group="${group}" title="Mark all resolved">✓</button>`
          : `<button class="t-icon" data-bulk="stage" data-group="${group}" title="Stage all">+</button>
             <button class="t-icon" data-bulk="discard" data-group="${group}" title="Discard all">↺</button>`;

    return `<section class="gp-group">
      <header class="gp-group-head">
        <span>${GROUP_TITLES[group]}</span><span class="gp-count">${entries.length}</span>
        <span class="t-spacer"></span>${bulk}
      </header>
      ${entries.map((e) => this.rowHtml(group, e)).join("")}
    </section>`;
  }

  private rowHtml(group: Group, e: StatusEntry): string {
    const name = e.path.split("/").pop() ?? e.path;
    const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    const letter = e.conflict ? "!" : e.untracked ? "U" : group === "staged" ? e.index : e.work;
    const actions =
      group === "staged"
        ? `<button class="t-icon" data-act="unstage" title="Unstage">−</button>`
        : group === "conflict"
          ? `<button class="t-icon" data-act="stage" title="Mark resolved">✓</button>`
          : `<button class="t-icon" data-act="discard" title="Discard">↺</button>
             <button class="t-icon" data-act="stage" title="Stage">+</button>`;

    return `<div class="gp-row" data-path="${esc(e.path).replace(/"/g, "&quot;")}" data-group="${group}" title="${esc(e.path)}">
      <span class="gp-name">${esc(name)}</span>
      <span class="gp-dir">${esc(dir)}</span>
      <span class="gp-actions">${actions}</span>
      <span class="gp-mark dec-${group}">${esc(letter)}</span>
    </div>`;
  }

  // ── interaction ─────────────────────────────────────────────────────────

  private async onGroupClick(e: MouseEvent): Promise<void> {
    const target = e.target as HTMLElement;

    const bulkBtn = target.closest<HTMLElement>("[data-bulk]");
    if (bulkBtn) {
      const group = bulkBtn.dataset.group as Group;
      const paths = this.groups()[group].map((x) => x.path);
      return this.apply(bulkBtn.dataset.bulk!, group, paths);
    }

    const row = target.closest<HTMLElement>(".gp-row");
    if (!row) return;
    const path = row.dataset.path!;
    const group = row.dataset.group as Group;

    const actBtn = target.closest<HTMLElement>("[data-act]");
    if (actBtn) return this.apply(actBtn.dataset.act!, group, [path]);

    // Plain click opens the diff — untracked files have no "before" side, so
    // they open in the editor instead.
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
        if (!confirm(`Discard changes in ${what}? This cannot be undone.`)) return;
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

  private async commit(amend: boolean): Promise<void> {
    const box = this.$<HTMLTextAreaElement>(".js-message");
    const message = box.value.trim();
    if (!message && !amend) return this.cb.toast("Commit message is required", true);
    try {
      await this.agent.call("git.commit", { message, amend });
      box.value = "";
      this.cb.toast(amend ? "commit amended" : "committed");
      await this.refresh();
      this.cb.afterChange();
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  // ── branches ────────────────────────────────────────────────────────────

  private branchMenu(e: MouseEvent): void {
    const current = this.status?.branch;
    const locals = this.branches.filter((b) => !b.remote);
    const items: [string, () => void][] = [
      ["＋ Create branch…", () => void this.createBranch()],
      ...locals.map<[string, () => void]>((b) => [
        `${b.name === current ? "● " : "   "}${b.name}`,
        () => void this.run("git.checkout", { ref: b.name }, `switched to ${b.name}`),
      ]),
      ["⇄ Merge branch into current…", () => void this.pickRef("Merge which branch into the current one?", (ref) => this.merge(ref))],
      ["⤺ Rebase current onto…", () => void this.pickRef("Rebase the current branch onto…", (ref) => this.rebase(ref))],
      ["✕ Delete branch…", () => void this.deleteBranch()],
    ];
    showMenu(e.clientX, e.clientY, items);
  }

  private async createBranch(): Promise<void> {
    const name = await modalPrompt({ title: "New branch", placeholder: "feature/my-change", okLabel: "create" });
    if (name) await this.run("git.branchCreate", { name }, `created ${name}`);
  }

  private async deleteBranch(): Promise<void> {
    const name = await modalPrompt({ title: "Delete branch", hint: "Unmerged branches are refused; confirm to force." });
    if (!name) return;
    try {
      await this.agent.call("git.branchDelete", { name });
      this.cb.toast(`deleted ${name}`);
    } catch {
      if (confirm(`${name} is not fully merged. Delete anyway?`)) {
        await this.run("git.branchDelete", { name, force: true }, `force-deleted ${name}`);
        return;
      }
    }
    await this.refresh();
  }

  private async pickRef(title: string, then: (ref: string) => Promise<void>): Promise<void> {
    const ref = await modalPrompt({
      title,
      hint: this.branches.map((b) => b.name).join(", "),
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

  private moreMenu(e: MouseEvent): void {
    showMenu(e.clientX, e.clientY, [
      ["↑ Push and set upstream", () => void this.remote("push", { setUpstream: true, remote: "origin", ref: this.status?.branch ?? undefined })],
      ["⇡ Force push (with lease)", () => { if (confirm("Force-push with --force-with-lease?")) void this.remote("push", { force: true }); }],
      ["⌷ Stash changes", () => void this.stash("push")],
      ["⌷ Pop latest stash", () => void this.stash("pop")],
      ["✕ Abort merge", () => void this.run("git.mergeAbort", {}, "merge aborted")],
      ["▶ Continue rebase", () => void this.run("git.rebase", { action: "continue" }, "rebase continued")],
      ["✕ Abort rebase", () => void this.run("git.rebase", { action: "abort" }, "rebase aborted")],
    ]);
  }

  private async push(): Promise<void> {
    // Without an upstream a bare `git push` fails with a long hint; set it here.
    if (this.status && !this.status.upstream && this.status.branch) {
      return this.remote("push", { setUpstream: true, remote: "origin", ref: this.status.branch });
    }
    return this.remote("push", {});
  }

  private async remote(action: "fetch" | "pull" | "push", opts: Record<string, unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const progress = this.$<HTMLElement>(".js-progress");
    progress.hidden = false;
    progress.textContent = `${action}…`;
    try {
      await this.agent.call("git.remote", { action, ...opts }, (chunk) => {
        const line = (chunk as { progress?: string }).progress;
        if (line) progress.textContent = line;
      });
      this.cb.toast(`${action} complete`);
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.busy = false;
      progress.hidden = true;
      await this.refresh();
      this.cb.afterChange();
    }
  }

  private async stash(action: "push" | "pop"): Promise<void> {
    await this.run("git.stash", { action }, action === "push" ? "changes stashed" : "stash popped");
  }

  /** Run one agent op, report it, then reload everything that may have moved. */
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
