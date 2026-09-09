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
import { attr, esc, modalPrompt, showMenu } from "./ui.ts";
import { fileIcon } from "./file-icons.ts";

const ROW = 22;
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
}

export interface TreeCallbacks {
  /** `preview` is true for a single click — the file opens on approval, in a
   *  reusable tab. A double click opens it for keeps. */
  onOpen(path: string, preview: boolean): void;
  onError(message: string): void;
  confirmDelete(paths: string[]): boolean;
  /** Show a diff between two arbitrary files in the workspace. */
  compare(left: string, right: string): void;
  /** Show a file against its committed version. */
  compareWithHead(path: string): void;
}

const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

export class FileTree {
  private root: TreeNode = { path: "", name: "", dir: true, depth: -1, expanded: true, loaded: false, children: [] };
  private rows: TreeNode[] = [];
  private selected = "";
  /** Path being dragged, and the directory currently highlighted as its target. */
  private dragging: string | null = null;
  private dropTarget: string | null = null;
  /** A repaint was requested while dragging and still owes the tree a redraw. */
  private paintPending = false;
  /** Directories whose listing is in flight, so a second press is not a second read. */
  private expanding = new Set<string>();
  /** First half of a "select for compare" pair, if one has been picked. */
  private compareBase: string | null = null;
  private status = new Map<string, StatusEntry>();
  /** Directories containing a change, so folders can carry a dot like VS Code. */
  private dirtyDirs = new Set<string>();
  /** Fingerprint of the decorations currently drawn, so an unchanged status
   *  costs nothing. */
  private statusKey = "";

  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly layer: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly ops: TreeOps,
    private readonly cb: TreeCallbacks,
  ) {
    host.classList.add("tree");
    host.innerHTML = `<div class="tree-viewport"><div class="tree-spacer"></div><div class="tree-layer"></div></div>`;
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

  private expandedPaths(): string[] {
    const out: string[] = [];
    const walk = (n: TreeNode): void => {
      if (!n.expanded) return;
      out.push(n.path);
      for (const c of n.children) if (c.dir) walk(c);
    };
    walk(this.root);
    return out;
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
    } catch (e) {
      this.cb.onError(e instanceof Error ? e.message : String(e));
    }
    this.rebuild();
  }

  private rebuild(): void {
    this.rows = [];
    const walk = (n: TreeNode): void => {
      for (const c of n.children) {
        this.rows.push(c);
        if (c.dir && c.expanded) walk(c);
      }
    };
    walk(this.root);
    this.spacer.style.height = `${this.rows.length * ROW}px`;
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
  }

  private rowHtml(n: TreeNode): string {
    const st = this.status.get(n.path);
    const mark = n.dir ? (this.dirtyDirs.has(n.path) ? "•" : "") : statusLetter(st);
    const cls = ["tree-row"];
    if (n.path === this.selected) cls.push("sel");
    if (n.path === this.dropTarget) cls.push("drop-into");
    if (st?.conflict) cls.push("dec-conflict");
    else if (st?.untracked) cls.push("dec-untracked");
    else if (st) cls.push("dec-modified");
    if (n.dir && this.dirtyDirs.has(n.path)) cls.push("dec-dirty");

    return `<div class="${cls.join(" ")}" draggable="true" data-path="${attr(n.path)}" style="padding-left:${4 + n.depth * 12}px">
      <span class="tree-caret">${n.dir ? (n.expanded ? "▾" : "▸") : ""}</span>
      <span class="tree-icon">${fileIcon(n.name, n.dir)}</span>
      <span class="tree-name">${esc(n.name)}</span>
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
    this.selected = path;
    for (const el of this.layer.querySelectorAll<HTMLElement>(".tree-row")) {
      el.classList.toggle("sel", el.dataset.path === path);
    }
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
    if (!this.dragging) return;
    const dir = this.dropDirFor(this.nodeFromEvent(e));
    if (dir === null) {
      this.setDropTarget(null);
      return;
    }
    // preventDefault is what actually makes this a valid drop target.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
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
    const dir = this.dropDirFor(this.nodeFromEvent(e));
    this.endDrag();
    if (!src || dir === null) return;

    const name = src.split("/").pop()!;
    const dest = join(dir, name);
    try {
      await this.ops.move(src, dest);
      // Both ends changed: the item left one directory and arrived in another.
      for (const p of [this.find(dirname(src)), this.find(dir)]) {
        if (p?.expanded) await this.expand(p, true);
      }
      this.selected = dest;
      this.rebuild();
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
    const items: [string, () => void][] = [
      ["New file", () => void this.create(target, false)],
      ["New folder", () => void this.create(target, true)],
    ];

    if (node !== this.root) {
      items.push(["Rename", () => void this.rename(node)], ["Delete", () => void this.remove(node)]);
    }
    items.push(["Copy path", () => void navigator.clipboard?.writeText(node.path)]);

    // Comparison is a two-step pick, the way VS Code does it: mark one file,
    // then choose the other. Only offered for files.
    if (!node.dir) {
      items.push(["Compare with HEAD", () => this.cb.compareWithHead(node.path)]);
      if (this.compareBase && this.compareBase !== node.path) {
        const base = this.compareBase;
        items.push([`Compare with "${base.split("/").pop()}"`, () => this.cb.compare(base, node.path)]);
      }
      items.push([
        this.compareBase === node.path ? "✓ Selected for compare" : "Select for compare",
        () => {
          this.compareBase = this.compareBase === node.path ? null : node.path;
        },
      ]);
    }
    showMenu(e.clientX, e.clientY, items);
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
      await this.ops.move(node.path, join(dirname(node.path), name));
      const parent = this.find(dirname(node.path)) ?? this.root;
      await this.expand(parent, true);
    } catch (e) {
      this.cb.onError(e instanceof Error ? e.message : String(e));
    }
  }

  private async remove(node: TreeNode): Promise<void> {
    if (node === this.root || !this.cb.confirmDelete([node.path])) return;
    try {
      await this.ops.remove([node.path]);
      const parent = this.find(dirname(node.path)) ?? this.root;
      await this.expand(parent, true);
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
