/** Virtualized file explorer.
 *
 *  Rows are a fixed height and only the visible window is in the DOM — a repo
 *  with 20k files would otherwise put 20k nodes on the page and stall the tab.
 *  Directories load lazily on first expand, so opening a folder never walks the
 *  whole tree.
 *
 *  Virtualization is ~40 lines here rather than a dependency because the row
 *  height is constant, which is the only hard part of the general problem.
 */
import type { DirEntry, StatusEntry } from "../../agent/protocol.ts";
import { copyToClipboard, esc, modalPrompt, showMenu, ROW_H, type MenuItem } from "./ui.ts";
import { fileIcon } from "./file-icons.ts";

const ROW = ROW_H;
/** Rows rendered above and below the viewport to hide scroll tearing. */
const OVERSCAN = 8;

interface TreeNode {
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  expanded: boolean;
  loaded: boolean;
  children: TreeNode[];
}

export interface TreeOps {
  readDir(path: string): Promise<DirEntry[]>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
  /** Read a file's text, or null when it is binary or over the size cap. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Which of these paths git would ignore. Absent without git, in which case
   *  nothing is dimmed — an explorer that cannot ask must not guess. */
  checkIgnore?(paths: string[]): Promise<string[]>;
}

/** The last file operation, kept so it can be taken back.
 *
 *  Only the two that are reversible. A delete is a real delete — the agent has
 *  no trash — and the confirmation says so; offering "undo" for it would be a
 *  promise nothing here can keep. */
type Undoable =
  | { kind: "move"; from: string; to: string }
  | { kind: "create"; path: string; dir: boolean };

export interface TreeCallbacks {
  /** `preview` is true for a single click — the file opens on approval, in a
   *  reusable tab. A double click opens it for keeps. */
  onOpen(path: string, preview: boolean): void;
  onError(message: string): void;
  /** Says an action went through — used where the result is invisible, such as
   *  a copy to the clipboard. */
  notify(message: string, isError?: boolean): void;
  /** Absolute path of the folder the agent is serving, for "copy absolute
   *  path". Null while nothing is connected, in which case only the
   *  repository-relative path can be offered. */
  workspaceRoot(): string | null;
  confirmDelete(paths: string[]): Promise<boolean>;
  /** Show a diff between two arbitrary files in the workspace. */
  compare(left: string, right: string): void;
  /** List what differs between two folders in the workspace. */
  compareFolders(left: string, right: string): void;
  /** The "compare with" mark moved: null means nothing is marked. The tab
   *  shows it above the editor, because a mark nobody can see is a mark nobody
   *  trusts — which is exactly how this behaved before. */
  onCompareBase(path: string | null, isDir: boolean): void;
  /** Show a file against its committed version. */
  compareWithHead(path: string): void;
  /** List what changed under a folder since the last commit. */
  compareFolderWithHead(path: string): void;
  /** Show the log scoped to one path. */
  fileHistory(path: string): void;
  /** Show who last changed each line of a file. */
  blame(path: string): void;
  /** Open search scoped to this folder. */
  searchIn(path: string): void;
  /** Open the file and encrypt or decrypt it in place. */
  crypto(path: string, direction: "encrypt" | "decrypt"): void;
}

const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** The part of `a` that tells it apart from `b`.
 *
 *  Two files called values.yaml differ only in their directory, and two files
 *  in one directory differ only in their name. Showing the whole path is
 *  always correct and usually unreadable; showing the file name is short and
 *  often meaningless. This drops the leading segments the two paths share. */
export function distinguish(a: string, b: string): string {
  const left = a.split("/");
  const right = b.split("/");
  let same = 0;
  while (same < left.length - 1 && same < right.length - 1 && left[same] === right[same]) same++;
  return left.slice(same).join("/");
}
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

export class FileTree {
  private root: TreeNode = { path: "", name: "", dir: true, depth: -1, expanded: true, loaded: false, children: [] };
  private rows: TreeNode[] = [];
  private selected = "";
  /** Everything selected, including `selected` itself, which is the anchor a
   *  Shift-click ranges from. Bulk delete and drag act on this. */
  private marked = new Set<string>();
  /** Name filter. Rows that do not match are hidden; their parents stay so the
   *  match keeps its context. */
  private filter = "";
  private readonly filterBox: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  /** Path being dragged, and the directory currently highlighted as its target. */
  private dragging: string | null = null;
  private dropTarget: string | null = null;
  /** A repaint was requested while dragging and still owes the tree a redraw. */
  private paintPending = false;
  /** Directories whose listing is in flight, so a second press is not a second read. */
  private expanding = new Set<string>();
  /** First half of a "select for compare" pair, if one has been picked.
   *
   *  Changed only through setCompareBase() below: the mark has to be visible
   *  in three places at once (the row, the bar above the editor, the menu),
   *  and a field assigned from four call sites kept two of them wrong. */
  private compareBase: string | null = null;
  private compareBaseDir = false;
  /** The last reversible file operation. One deep: this is a safety net for
   *  the drop that landed in the wrong folder, not an edit history. */
  private lastOp: Undoable | null = null;
  private status = new Map<string, StatusEntry>();
  /** Directories containing a change, so folders can carry a dot like VS Code. */
  private dirtyDirs = new Set<string>();
  /** Fingerprint of the decorations currently drawn, so an unchanged status
   *  costs nothing. */
  private statusKey = "";
  /** Paths git ignores, filled in per directory as it is listed.
   *
   *  Not from `git status`: without `--ignored` it says nothing about them, and
   *  with it, it lists every file inside node_modules — tens of thousands of
   *  entries to dim three folders. `git check-ignore` asked once per directory
   *  answers the same question in one spawn per folder actually on screen. */
  private ignored = new Set<string>();

  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly layer: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly ops: TreeOps,
    private readonly cb: TreeCallbacks,
  ) {
    host.classList.add("tree");
    host.innerHTML = `<div class="tree-filter" hidden>
        <input class="t-input js-tree-filter" placeholder="filter by name" autocomplete="off" spellcheck="false"
               aria-label="Filter the explorer by name" />
        <button class="t-icon js-tree-filter-clear" type="button" aria-label="Clear the filter">✕</button>
      </div>
      <div class="tree-viewport"><div class="tree-spacer"></div><div class="tree-layer"></div></div>`;
    this.filterBox = host.querySelector(".tree-filter")!;
    this.filterInput = host.querySelector(".js-tree-filter")!;
    this.filterInput.addEventListener("input", () => {
      this.filter = this.filterInput.value.trim().toLowerCase();
      this.rebuild();
    });
    this.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.clearFilter();
      // Down arrow hands the keyboard to the list without losing the filter.
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.viewport.focus();
      }
    });
    host.querySelector(".js-tree-filter-clear")!.addEventListener("click", () => this.clearFilter());
    this.viewport = host.querySelector(".tree-viewport")!;
    this.spacer = host.querySelector(".tree-spacer")!;
    this.layer = host.querySelector(".tree-layer")!;

    this.viewport.addEventListener("scroll", () => this.paint(), { passive: true });
    this.viewport.addEventListener("dragstart", (e) => this.onDragStart(e));
    this.viewport.addEventListener("dragover", (e) => this.onDragOver(e));
    this.viewport.addEventListener("dragleave", (e) => this.onDragLeave(e));
    this.viewport.addEventListener("drop", (e) => void this.onDrop(e));
    this.viewport.addEventListener("dragend", () => this.endDrag());
    // Acting on the press, not on `click`. Every row is draggable, and a press
    // that moves even a couple of pixels before release makes the browser start
    // a drag and swallow the click entirely — which is why clicking quickly
    // through the tree used to do nothing every other time.
    this.viewport.addEventListener("pointerdown", (e) => this.onPress(e));
    this.viewport.addEventListener("dblclick", (e) => this.onDblClick(e));
    this.viewport.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.viewport.tabIndex = 0;
    this.viewport.addEventListener("keydown", (e) => this.onKey(e));
    new ResizeObserver(() => this.paint()).observe(this.viewport);
  }

  // ── data ────────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    this.root.children = [];
    this.root.loaded = false;
    await this.expand(this.root);
  }

  reset(): void {
    this.statusKey = "";
    // The mark belongs to a workspace. Carried into another one it points at a
    // path that means something else there, which is how "Compare with
    // \x27values.yaml\x27" once produced an ENOENT for a file in a folder nobody
    // had open any more.
    if (this.compareBase) this.setCompareBase(null);
    // Same reasoning: "build/ is ignored" is a fact about one repository, and
    // carried into the next one it dims a folder nobody's .gitignore mentions.
    this.ignored.clear();
    this.root = { path: "", name: "", dir: true, depth: -1, expanded: true, loaded: false, children: [] };
    this.rows = [];
    this.layer.innerHTML = "";
    this.spacer.style.height = "0px";
  }

  setStatus(entries: StatusEntry[]): void {
    // Status arrives far more often than it changes: a build writing files, or
    // any git process taking .git/index.lock, wakes the watcher several times a
    // second. Repainting on each one replaces every row, which cancels drags
    // and makes the browser drop double clicks — both clicks have to land on
    // the same element for one to be reported. So redraw only on a difference.
    const key = JSON.stringify(entries.map((e) => [e.path, e.index, e.work, e.untracked, e.conflict, e.ignored]));
    if (key === this.statusKey) return;
    this.statusKey = key;

    this.status = new Map(entries.map((e) => [e.path, e]));
    this.dirtyDirs.clear();
    for (const e of entries) {
      if (e.ignored) continue;
      for (let d = dirname(e.path); d; d = dirname(d)) this.dirtyDirs.add(d);
    }
    this.paint();
  }

  /** Reload the directories touched by a watcher event. "*" reloads everything
   *  that is currently expanded. */
  async refresh(paths: string[]): Promise<void> {
    const dirs = new Set(paths.includes("*") ? this.expandedPaths() : paths.map(dirname));
    for (const d of dirs) {
      const node = this.find(d);
      if (node?.expanded) await this.expand(node, true);
    }
    this.rebuild();
  }

  /** Which folders are open, so a session can be put back the way it was. */
  expandedPaths(): string[] {
    const out: string[] = [];
    const walk = (n: TreeNode): void => {
      if (!n.expanded) return;
      out.push(n.path);
      for (const c of n.children) if (c.dir) walk(c);
    };
    walk(this.root);
    return out;
  }

  /** Re-open folders that were open last time.
   *
   *  Shallowest first, because a child cannot be expanded before its parent has
   *  been read. Anything that has since been renamed or deleted is skipped in
   *  silence — a restored session is a convenience, and failing loudly over a
   *  folder somebody moved would be worse than quietly opening one fewer. */
  async restoreExpanded(paths: string[]): Promise<void> {
    for (const p of [...paths].sort((a, b) => a.split("/").length - b.split("/").length)) {
      if (!p) continue;
      const node = this.find(p);
      if (node?.dir && !node.expanded) await this.expand(node).catch(() => undefined);
    }
    this.rebuild();
  }

  private find(path: string): TreeNode | null {
    if (path === "") return this.root;
    let node: TreeNode | null = this.root;
    for (const seg of path.split("/")) {
      node = node.children.find((c) => c.name === seg) ?? null;
      if (!node) return null;
    }
    return node;
  }

  private async expand(node: TreeNode, force = false): Promise<void> {
    if (node.loaded && !force) {
      node.expanded = true;
      return this.rebuild();
    }
    try {
      const entries = await this.ops.readDir(node.path);
      const previous = new Map(node.children.map((c) => [c.name, c]));
      node.children = entries
        // .git is machinery, not content; the git panel surfaces what matters.
        .filter((e) => !(node.depth === -1 && e.name === ".git"))
        .map((e) => {
          const kept = previous.get(e.name);
          return kept && kept.dir === e.dir
            ? kept
            : { path: join(node.path, e.name), name: e.name, dir: e.dir, depth: node.depth + 1, expanded: false, loaded: false, children: [] };
        });
      node.loaded = true;
      node.expanded = true;
      // Not awaited: the folder opens now, and the dimming lands a moment later
      // when git has answered. A listing that waited for it would be a folder
      // that opens slowly to say the same thing.
      void this.markIgnored(node);
    } catch (e) {
      this.cb.onError(e instanceof Error ? e.message : String(e));
    }
    this.rebuild();
  }

  /** Ask git which of a listed folder's entries it ignores, and repaint if the
   *  answer changed anything. Silent on failure: dimming is a hint, and a
   *  repository mid-rebase or a git that is not there should cost a toast for
   *  the operation the user asked for, not for a decoration. */
  private async markIgnored(node: TreeNode): Promise<void> {
    if (!this.ops.checkIgnore || !node.children.length) return;
    const paths = node.children.map((c) => c.path);
    let answer: string[];
    try {
      answer = await this.ops.checkIgnore(paths);
    } catch {
      return;
    }
    const wanted = new Set(answer);
    let changed = false;
    for (const p of paths) {
      const has = this.ignored.has(p);
      if (wanted.has(p) === has) continue;
      if (has) this.ignored.delete(p);
      else this.ignored.add(p);
      changed = true;
    }
    if (changed) this.paint();
  }

  /** Is this path dimmed? Directly ignored, or inside something that is —
   *  git reports an ignored directory and says nothing about its contents, and
   *  a folder greyed out above rows that are not would read as a bug. */
  private isIgnored(path: string): boolean {
    if (this.ignored.has(path)) return true;
    for (let d = dirname(path); d; d = dirname(d)) if (this.ignored.has(d)) return true;
    return false;
  }

  private rebuild(): void {
    this.rows = [];
    const needle = this.filter;

    // With a filter on, a directory earns its place by containing a match —
    // otherwise filtering a tree either hides the matches (their parents are
    // gone) or shows everything (the parents match nothing).
    const keep = (n: TreeNode): boolean => {
      if (!needle) return true;
      if (n.name.toLowerCase().includes(needle)) return true;
      return n.dir && n.children.some(keep);
    };

    const walk = (n: TreeNode): void => {
      for (const c of n.children) {
        if (!keep(c)) continue;
        this.rows.push(c);
        // A filter expands what it matches inside: the point is to see the
        // hits, not to be told a folder somewhere below has one.
        if (c.dir && (c.expanded || (needle && c.loaded))) walk(c);
      }
    };
    walk(this.root);
    this.spacer.style.height = `${this.rows.length * ROW}px`;
    this.paint();
  }

  /** Set (or clear) the thing marked for comparison, and make it visible.
   *
   *  Files and folders share one mark, because having two would mean the user
   *  has to know which of them they armed. `isDir` travels with it so the menu
   *  can decline to offer a folder against a file — a comparison that has no
   *  meaning and used to be offered anyway. */
  setCompareBase(path: string | null, isDir = false): void {
    this.compareBase = path;
    this.compareBaseDir = path !== null && isDir;
    this.paint();
    this.cb.onCompareBase(path, this.compareBaseDir);
  }

  get comparingFrom(): string | null {
    return this.compareBase;
  }

  /** Open the filter field. */
  focusFilter(): void {
    this.filterBox.hidden = false;
    this.filterInput.focus();
    this.filterInput.select();
  }

  private clearFilter(): void {
    this.filter = "";
    this.filterInput.value = "";
    this.filterBox.hidden = true;
    this.rebuild();
    this.viewport.focus();
  }

  /** Fold everything shut. The root stays open — it is the tree. */
  collapseAll(): void {
    const walk = (n: TreeNode): void => {
      for (const c of n.children) {
        if (!c.dir) continue;
        c.expanded = false;
        walk(c);
      }
    };
    walk(this.root);
    this.rebuild();
  }

  /** Show a path in the tree: expand what it takes to get there, select it,
   *  and scroll it into view. Used by "reveal the open file", because a file
   *  opened from search or from the change list was invisible in the explorer
   *  until someone found it by hand. */
  async reveal(path: string): Promise<void> {
    const parts = path.split("/");
    let node: TreeNode | null = this.root;
    for (let i = 0; i < parts.length - 1 && node; i++) {
      const dir: TreeNode | undefined = node.children.find((c) => c.name === parts[i] && c.dir);
      if (!dir) break;
      if (!dir.loaded || !dir.expanded) await this.expand(dir);
      node = dir;
    }
    this.rebuild();
    const at = this.rows.findIndex((n) => n.path === path);
    if (at === -1) return;
    this.select(path);
    this.scrollTo(at);
    this.paint();
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private paint(): void {
    // A repaint replaces every row element. Doing that while the browser is
    // dragging one of them cancels the drag — and a repaint can be triggered at
    // any moment by a git status refresh or a watcher event. Defer instead.
    if (this.dragging) {
      this.paintPending = true;
      return;
    }
    const top = this.viewport.scrollTop;
    const count = Math.ceil(this.viewport.clientHeight / ROW) + OVERSCAN * 2;
    const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
    const slice = this.rows.slice(first, first + count);

    this.layer.style.transform = `translateY(${first * ROW}px)`;
    this.layer.innerHTML = slice.map((n) => this.rowHtml(n)).join("");
    // The indent cannot be a style="" attribute any more (style-src has no
    // 'unsafe-inline'), so it rides in data-depth and is applied here.
    for (const row of this.layer.querySelectorAll<HTMLElement>(".tree-row")) {
      row.style.paddingLeft = `${4 + Number(row.dataset.depth) * 12}px`;
    }
  }

  private rowHtml(n: TreeNode): string {
    const st = this.status.get(n.path);
    const mark = n.dir ? (this.dirtyDirs.has(n.path) ? "•" : "") : statusLetter(st);
    const cls = ["tree-row"];
    if (this.marked.has(n.path)) cls.push("sel");
    if (n.path === this.compareBase) cls.push("compare-base");
    if (n.path === this.dropTarget) cls.push("drop-into");
    if (st?.conflict) cls.push("dec-conflict");
    else if (st?.untracked) cls.push("dec-untracked");
    else if (st) cls.push("dec-modified");
    if (n.dir && this.dirtyDirs.has(n.path)) cls.push("dec-dirty");
    // Last, so it dims whatever the row otherwise says: an ignored file that
    // shows as untracked is the pair of facts a build folder always has.
    if (this.isIgnored(n.path)) cls.push("dec-ignored");

    return `<div class="${cls.join(" ")}" draggable="true" data-path="${esc(n.path)}" data-depth="${n.depth}">
      <span class="tree-caret">${n.dir ? (n.expanded ? "▾" : "▸") : ""}</span>
      <span class="tree-icon">${fileIcon(n.name, n.dir)}</span>
      <span class="tree-name">${esc(n.name)}</span>
      ${n.path === this.compareBase ? `<span class="tree-compare" title="Marked for comparison">⇄</span>` : ""}
      <span class="tree-mark">${mark}</span>
    </div>`;
  }

  // ── interaction ─────────────────────────────────────────────────────────

  private nodeFromEvent(e: Event): TreeNode | null {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    return row ? this.find(row.dataset.path ?? "") : null;
  }

  private onPress(e: PointerEvent): void {
    // Left button only: the right button opens the context menu, and the
    // middle one must not expand a folder behind the user's back.
    if (e.button !== 0) return;
    // A drag that ended outside the viewport can leave `dragging` set, which
    // freezes every repaint. A fresh press means no drag is in progress.
    if (this.dragging) this.endDrag();

    const node = this.nodeFromEvent(e);
    if (!node) return;

    // Ctrl and Shift extend the selection instead of opening anything: with
    // several rows marked, the next Delete or drag acts on all of them. Without
    // this, removing twenty generated files meant twenty confirmations.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      if (e.shiftKey) this.markRange(node.path);
      else this.toggleMark(node.path);
      for (const el of this.layer.querySelectorAll<HTMLElement>(".tree-row")) {
        el.classList.toggle("sel", this.marked.has(el.dataset.path ?? ""));
      }
      this.viewport.focus();
      return;
    }

    this.setSelected(node.path);
    if (!node.dir) {
      this.cb.onOpen(node.path, true);
      return;
    }
    if (node.expanded) {
      node.expanded = false;
      this.rebuild();
      return;
    }
    // Reading a directory is a round trip; a second press before it lands
    // would issue the same read again and repaint twice.
    if (this.expanding.has(node.path)) return;
    this.expanding.add(node.path);
    void this.expand(node).finally(() => this.expanding.delete(node.path));
  }

  // ── drag & drop ─────────────────────────────────────────────────────────

  private onDragStart(e: DragEvent): void {
    const node = this.nodeFromEvent(e);
    if (!node) return;
    this.dragging = node.path;
    e.dataTransfer?.setData("text/plain", node.path);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  /** Move the selection highlight without repainting.
   *
   *  A repaint replaces every row element, and the browser only reports a
   *  dblclick when both clicks land on the *same* node — so repainting on the
   *  first press meant a double click in the tree could never be seen at all.
   *  Selection is one class; toggle it where it is. */
  private setSelected(path: string): void {
    this.select(path);
    for (const el of this.layer.querySelectorAll<HTMLElement>(".tree-row")) {
      el.classList.toggle("sel", this.marked.has(el.dataset.path ?? ""));
    }
  }

  /** Replace the selection with one row. */
  private select(path: string): void {
    this.selected = path;
    this.marked = new Set([path]);
  }

  /** Ctrl-click: add or remove one row without disturbing the rest. */
  private toggleMark(path: string): void {
    if (this.marked.has(path) && this.marked.size > 1) this.marked.delete(path);
    else this.marked.add(path);
    this.selected = path;
  }

  /** Shift-click: everything between the anchor and here, as displayed. */
  private markRange(path: string): void {
    const from = this.rows.findIndex((n) => n.path === this.selected);
    const to = this.rows.findIndex((n) => n.path === path);
    if (from === -1 || to === -1) return this.select(path);
    const [lo, hi] = from < to ? [from, to] : [to, from];
    this.marked = new Set(this.rows.slice(lo, hi + 1).map((n) => n.path));
  }

  /** What a bulk action applies to, in the order the tree shows them. */
  private selection(): string[] {
    const order = new Map(this.rows.map((n, i) => [n.path, i]));
    return [...this.marked].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  /** Where a drop would land: into a directory, or into a file's parent. */
  private dropDirFor(node: TreeNode | null): string | null {
    if (!this.dragging) return null;
    const target = node ? (node.dir ? node : this.find(dirname(node.path))) : this.root;
    if (!target) return null;

    const src = this.dragging;
    // Moving something into the folder it already sits in is a no-op, and
    // moving a folder into itself or its own subtree would destroy it.
    if (dirname(src) === target.path) return null;
    if (target.path === src || target.path.startsWith(src + "/")) return null;
    return target.path;
  }

  private onDragOver(e: DragEvent): void {
    // Files from outside the browser: any folder is a valid landing place, and
    // there is no source path to check against.
    if (!this.dragging) {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const node = this.nodeFromEvent(e);
      const target = node ? (node.dir ? node : this.find(dirname(node.path))) : this.root;
      this.setDropTarget(target?.path ?? "");
      return;
    }
    const dir = this.dropDirFor(this.nodeFromEvent(e));
    if (dir === null) {
      this.setDropTarget(null);
      return;
    }
    // preventDefault is what actually makes this a valid drop target.
    e.preventDefault();
    // The cursor says which of the two is about to happen, so the modifier is
    // not something you have to remember you are holding.
    if (e.dataTransfer) e.dataTransfer.dropEffect = e.ctrlKey || e.metaKey ? "copy" : "move";
    this.setDropTarget(dir);
  }

  private onDragLeave(e: DragEvent): void {
    // Only clear when the pointer actually leaves the tree, not when it crosses
    // between two rows inside it.
    if (!this.viewport.contains(e.relatedTarget as Node | null)) this.setDropTarget(null);
  }

  private setDropTarget(path: string | null): void {
    if (this.dropTarget === path) return;
    this.dropTarget = path;
    // Toggled in place rather than through paint(): repainting replaces the row
    // elements, and replacing the one the browser is dragging cancels the drag.
    for (const el of this.layer.querySelectorAll<HTMLElement>(".tree-row")) {
      el.classList.toggle("drop-into", el.dataset.path === path);
    }
  }

  /** Clear drag state and flush any repaint that was held back during it. */
  private endDrag(): void {
    this.setDropTarget(null);
    this.dragging = null;
    if (this.paintPending) {
      this.paintPending = false;
      this.paint();
    }
  }

  private async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    const src = this.dragging;
    const node = this.nodeFromEvent(e);
    const files = [...(e.dataTransfer?.files ?? [])];
    // Ctrl (Cmd on a Mac) turns a move into a copy, the way every file manager
    // does it. Read on the drop, not on the drag, because it can be pressed or
    // released mid-drag.
    const copy = e.ctrlKey || e.metaKey;

    if (!src && files.length) {
      // From outside the browser: the target directory is worked out the same
      // way, but without a source path there is nothing for dropDirFor to
      // reject, so it is resolved here.
      const target = node ? (node.dir ? node : this.find(dirname(node.path))) : this.root;
      this.endDrag();
      if (target) await this.importFiles(files, target);
      return;
    }

    const dir = this.dropDirFor(node);
    this.endDrag();
    if (!src || dir === null) return;

    const name = src.split("/").pop()!;
    const dest = join(dir, name);
    try {
      if (copy) await this.copyTo(src, dest);
      else {
        await this.ops.move(src, dest);
        this.lastOp = { kind: "move", from: src, to: dest };
      }
      // Both ends changed: the item left one directory and arrived in another.
      for (const p of [this.find(dirname(src)), this.find(dir)]) {
        if (p?.expanded) await this.expand(p, true);
      }
      this.selected = dest;
      this.rebuild();
      if (copy) this.cb.notify(`copied to ${dest}`);
    } catch (err) {
      this.cb.onError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Copy one file.
   *
   *  Read then write, because that is what the agent offers. It means a folder
   *  and a binary cannot be copied this way, and both are refused by name
   *  rather than half-done: a copy that silently produced an empty file would
   *  be worse than one that did not happen. */
  private async copyTo(src: string, dest: string): Promise<void> {
    const node = this.find(src);
    if (node?.dir) throw new Error(`${src} is a folder — copying folders is not supported yet, only files.`);
    const text = await this.ops.readText(src);
    if (text === null) throw new Error(`${src} is binary or too large to copy through the editor.`);
    const path = await this.freeName(dest);
    await this.ops.writeText(path, text);
    this.lastOp = { kind: "create", path, dir: false };
  }

  /** `values.yaml` → `values copy.yaml` → `values copy 2.yaml`, so a copy never
   *  overwrites what it was dropped next to. */
  private async freeName(dest: string): Promise<string> {
    if (!(await this.ops.exists(dest))) return dest;
    const dot = dest.lastIndexOf(".");
    const slash = dest.lastIndexOf("/");
    const [stem, ext] = dot > slash ? [dest.slice(0, dot), dest.slice(dot)] : [dest, ""];
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
      if (!(await this.ops.exists(candidate))) return candidate;
    }
    throw new Error(`Too many copies of ${dest} already.`);
  }

  /** Files dragged in from the desktop.
   *
   *  Text only, and said so: `fs.write` takes a string, so an image or an
   *  archive dropped here would arrive mangled. Refusing by name is the honest
   *  answer until the agent can take bytes. */
  private async importFiles(files: File[], target: TreeNode): Promise<void> {
    const skipped: string[] = [];
    let added = 0;
    for (const file of files) {
      try {
        const text = await file.text();
        // A NUL byte is the same test the agent uses to call a file binary.
        if (text.includes("\0")) {
          skipped.push(file.name);
          continue;
        }
        const path = await this.freeName(join(target.path, file.name));
        await this.ops.writeText(path, text);
        this.lastOp = { kind: "create", path, dir: false };
        added++;
      } catch (err) {
        this.cb.onError(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (target.expanded) await this.expand(target, true);
    this.rebuild();
    if (added) this.cb.notify(`added ${added} file${added === 1 ? "" : "s"} to ${target.path || "the workspace root"}`);
    if (skipped.length) {
      this.cb.onError(`Not added — binary files cannot be written through the editor: ${skipped.join(", ")}`);
    }
  }

  /** Reverse the last move or creation. */
  async undoLast(): Promise<void> {
    const op = this.lastOp;
    if (!op) return this.cb.notify("Nothing to undo — no file has been moved or created in this session.");
    this.lastOp = null;
    try {
      if (op.kind === "move") {
        await this.ops.move(op.to, op.from);
        this.cb.notify(`moved back to ${op.from}`);
      } else {
        await this.ops.remove([op.path]);
        this.cb.notify(`removed ${op.path}`);
      }
      await this.load();
    } catch (err) {
      this.cb.onError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Double click keeps the file: the tab stops being a preview. */
  private onDblClick(e: MouseEvent): void {
    const node = this.nodeFromEvent(e);
    if (node && !node.dir) this.cb.onOpen(node.path, false);
  }

  private onKey(e: KeyboardEvent): void {
    const i = this.rows.findIndex((n) => n.path === this.selected);
    const move = (to: number): void => {
      const n = this.rows[Math.max(0, Math.min(this.rows.length - 1, to))];
      if (!n) return;
      this.selected = n.path;
      this.scrollTo(this.rows.indexOf(n));
      this.paint();
    };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); return move(i + 1);
      case "ArrowUp": e.preventDefault(); return move(i - 1);
      case "ArrowRight": {
        const n = this.rows[i];
        if (n?.dir && !n.expanded) void this.expand(n);
        else move(i + 1);
        return;
      }
      case "ArrowLeft": {
        const n = this.rows[i];
        if (n?.dir && n.expanded) {
          n.expanded = false;
          this.rebuild();
        } else if (n) {
          this.selected = dirname(n.path);
          this.paint();
        }
        return;
      }
      case "Enter": {
        const n = this.rows[i];
        if (n && !n.dir) this.cb.onOpen(n.path, false);
        else if (n) void this.expand(n);
        return;
      }
      case "F2":
        if (this.rows[i]) void this.rename(this.rows[i]);
        return;
      case "Delete":
        if (this.rows[i]) void this.remove(this.rows[i]);
        return;
    }
  }

  private scrollTo(index: number): void {
    const top = index * ROW;
    const { scrollTop, clientHeight } = this.viewport;
    if (top < scrollTop) this.viewport.scrollTop = top;
    else if (top + ROW > scrollTop + clientHeight) this.viewport.scrollTop = top + ROW - clientHeight;
  }

  // ── context menu ────────────────────────────────────────────────────────

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const node = this.nodeFromEvent(e) ?? this.root;
    this.selected = node.path;
    this.paint();

    const target = node.dir ? node : this.find(dirname(node.path)) ?? this.root;
    const items: MenuItem[] = [
      { label: "New file", run: () => void this.create(target, false) },
      { label: "New folder", run: () => void this.create(target, true) },
    ];

    if (node !== this.root) {
      // Both keys already work on the focused row; the menu is where people
      // find that out. Delete is separated and marked, so it cannot be reached
      // by a hand aiming at Rename.
      items.push(
        { label: "Rename", hint: "F2", run: () => void this.rename(node), separated: true },
        { label: "Delete", hint: "Del", run: () => void this.remove(node), danger: true },
      );
    }
    // Two paths, because the two are wanted for different things: the relative
    // one goes into a commit message, a review comment or a glob; the absolute
    // one goes into a terminal on this machine. Guessing which was meant is
    // what made "Copy path" quietly useless half the time.
    items.push({ label: "Copy path", run: () => void copyToClipboard(node.path, "Path", this.cb.notify), separated: true });
    const root = this.cb.workspaceRoot();
    if (root) {
      const sep = root.includes("\\") ? "\\" : "/";
      const absolute = root.replace(/[\\/]$/, "") + sep + node.path.split("/").join(sep);
      items.push({ label: "Copy absolute path", run: () => void copyToClipboard(absolute, "Absolute path", this.cb.notify) });
    }

    // Comparison is a two-step pick, the way VS Code does it: mark one thing,
    // then choose the other. Folders work the same way as files — the pair is
    // just answered with a list of what differs instead of a diff.
    if (node !== this.root || node.dir) {
      const base = this.compareBase;
      const marked = base === node.path;
      const pairable = base !== null && !marked && this.compareBaseDir === node.dir;

      // History first: "when did this change" is asked far more often than
      // "how does this differ from that", and it used to be answerable only in
      // a terminal even though the agent could already answer it.
      items.push({ label: "File history", run: () => this.cb.fileHistory(node.path), separated: true });
      if (!node.dir) items.push({ label: "Blame", run: () => this.cb.blame(node.path) });
      // Scoping a search used to mean knowing that the include field takes a
      // glob and writing `roles/common/**` into it by hand.
      if (node.dir) items.push({ label: "Search in this folder…", run: () => this.cb.searchIn(node.path) });
      // The other half of the product, finally reachable from the files it is
      // for. Both directions are offered rather than guessed: the tree knows a
      // name, not whether the contents carry a vault header.
      if (!node.dir) {
        items.push(
          { label: "Encrypt this file…", separated: true, run: () => this.cb.crypto(node.path, "encrypt") },
          { label: "Decrypt this file…", run: () => this.cb.crypto(node.path, "decrypt") },
        );
      }

      items.push(
        node.dir
          ? { label: "Compare folder with HEAD", run: () => this.cb.compareFolderWithHead(node.path), separated: true }
          : { label: "Compare with HEAD", run: () => this.cb.compareWithHead(node.path), separated: true },
      );
      if (pairable) {
        // The distinguishing part of the path, not the bare name: the whole
        // point of this is comparing prod/values.yaml against
        // stage/values.yaml, and `Compare with "values.yaml"` says nothing.
        items.push({
          label: `Compare with ${distinguish(base!, node.path)}`,
          run: () => (node.dir ? this.cb.compareFolders(base!, node.path) : this.cb.compare(base!, node.path)),
        });
      } else if (base !== null && !marked) {
        // Saying why is better than the menu quietly lacking the item the user
        // came for: they marked something, and this is not its kind.
        items.push({
          label: this.compareBaseDir ? "Compare with — a folder is marked" : "Compare with — a file is marked",
          run: () => {},
          disabled: true,
        });
      }
      items.push({
        label: marked
          ? "✓ Selected for compare — click to clear"
          : node.dir
            ? "Select folder for compare"
            : "Select for compare",
        run: () => this.setCompareBase(marked ? null : node.path, node.dir),
      });
    }

    // Shift+F10 and the Menu key raise a contextmenu event with no useful
    // coordinates (0,0 in Chromium), so a keyboard user would get the menu in
    // the corner of the window. Put it on the row instead.
    const row = (e.target as HTMLElement).closest?.(".tree-row") as HTMLElement | null;
    const anchor = row?.getBoundingClientRect();
    const fromKeyboard = e.clientX === 0 && e.clientY === 0;
    showMenu(
      fromKeyboard && anchor ? anchor.left + 12 : e.clientX,
      fromKeyboard && anchor ? anchor.bottom : e.clientY,
      items,
    );
  }

  /** Toolbar entry point: create inside the selection, or inside its parent
   *  when a file is selected — the same rule VS Code uses. */
  createIn(dir: boolean): void {
    const sel = this.find(this.selected) ?? this.root;
    const target = sel.dir ? sel : this.find(dirname(sel.path)) ?? this.root;
    void this.create(target, dir);
  }

  private async create(parent: TreeNode, dir: boolean): Promise<void> {
    const name = await modalPrompt({ title: dir ? "New folder" : "New file", placeholder: "name" });
    if (!name) return;
    try {
      const path = join(parent.path, name);
      if (dir) await this.ops.createDir(path);
      else await this.ops.createFile(path);
      this.lastOp = { kind: "create", path, dir };
      await this.expand(parent, true);
      this.selected = path;
      if (!dir) this.cb.onOpen(path, false);
    } catch (e) {
      this.cb.onError(e instanceof Error ? e.message : String(e));
    }
  }

  private async rename(node: TreeNode): Promise<void> {
    if (node === this.root) return;
    const name = await modalPrompt({ title: "Rename", value: node.name });
    if (!name || name === node.name) return;
    try {
      const to = join(dirname(node.path), name);
      await this.ops.move(node.path, to);
      this.lastOp = { kind: "move", from: node.path, to };
      const parent = this.find(dirname(node.path)) ?? this.root;
      await this.expand(parent, true);
    } catch (e) {
      this.cb.onError(e instanceof Error ? e.message : String(e));
    }
  }

  private async remove(node: TreeNode): Promise<void> {
    if (node === this.root) return;
    // Everything marked goes, not just the row under the cursor — but only if
    // that row is part of the selection. Right-clicking outside a selection
    // means "this one", the way every file manager behaves.
    const paths = this.marked.has(node.path) ? this.selection().filter(Boolean) : [node.path];
    if (!paths.length || !(await this.cb.confirmDelete(paths))) return;
    try {
      await this.ops.remove(paths);
      // One reload per affected directory rather than per file.
      for (const dir of new Set(paths.map(dirname))) {
        const parent = this.find(dir) ?? this.root;
        if (parent.expanded) await this.expand(parent, true);
      }
      this.marked = new Set();
      this.rebuild();
    } catch (e) {
      this.cb.onError(e instanceof Error ? e.message : String(e));
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function statusLetter(e: StatusEntry | undefined): string {
  if (!e) return "";
  if (e.conflict) return "!";
  if (e.untracked) return "U";
  const w = e.work !== "." ? e.work : e.index;
  return w === "." ? "" : w;
}
