/** Code tab: explorer, source control, history, editor and diff — wired to the
 *  local agent.
 *
 *  Loaded lazily; main.ts imports it by URL on the first switch to this tab so
 *  the grammar set never lands in the crypto tabs' bundle.
 */
import type { EditorState } from "@codemirror/state";
import { isAgentUrl, type AgentClient } from "./agent.ts";
import type { DiffPair, DirEntry, FileRead, FsChange, GitStatus } from "../../agent/protocol.ts";
import { CodeEditor } from "./editor.ts";
import { FileTree } from "./tree.ts";
import { GitPanel } from "./git-panel.ts";
import { HistoryPanel } from "./history.ts";
import { SearchPanel } from "./search-panel.ts";
import { DiffView } from "./diff.ts";
import { findConflicts } from "./conflicts.ts";
import { applyRowHeight, esc, modalConfirm, modalPrompt } from "./ui.ts";
import { iconBranch, iconFiles, iconHistory, iconNewFile, iconNewFolder, iconRefresh, iconSearch } from "./icons.ts";

export interface CodeContext {
  agent: AgentClient;
  isDark: () => boolean;
  toast: (message: string, isError?: boolean) => void;
  /** Called whenever agent state changes so the header badge can repaint. */
  onCapsChanged: () => void;
}

export interface CodeTab {
  setTheme(dark: boolean): void;
  connect(): Promise<void>;
  focus(): void;
  /** main.ts owns the agent client and forwards its state changes here. */
  onAgentState(): void;
}

type View = "explorer" | "search" | "scm" | "history";

/** Side-panel geometry, remembered between sessions. */
interface SideState {
  width: number;
  collapsed: boolean;
}
const SIDE_KEY = "enc-code-side";

function loadSide(): SideState {
  const fallback: SideState = { width: 260, collapsed: false };
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(SIDE_KEY) ?? "{}") as Partial<SideState>) };
  } catch {
    return fallback;
  }
}

function saveSide(s: SideState): void {
  try {
    localStorage.setItem(SIDE_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

const SHELL = `
  <div class="toolbar code-toolbar">
    <span class="t-label">folder</span>
    <span class="code-root">not connected</span>
    <button class="t-btn js-connect" type="button">connect…</button>
    <button class="t-btn js-reload" type="button" data-requires="agent" title="Reload">${iconRefresh}</button>
    <div class="toolbar-sep"></div>
    <span class="t-label">branch</span>
    <span class="code-branch" data-requires="git">—</span>
    <div class="t-spacer"></div>
    <button class="t-btn t-btn-primary js-save" type="button">↓ save</button>
  </div>
  <div class="code-body">
    <nav class="code-rail">
      <button class="rail-btn active" type="button" data-view="explorer" title="Explorer">${iconFiles}</button>
      <button class="rail-btn" type="button" data-view="search" data-requires="agent" title="Search across the project">${iconSearch}</button>
      <button class="rail-btn" type="button" data-view="scm" data-requires="git" title="Source control">
        ${iconBranch}<span class="rail-badge js-scm-badge" hidden></span>
      </button>
      <button class="rail-btn" type="button" data-view="history" data-requires="git" title="History">${iconHistory}</button>
    </nav>
    <aside class="code-side" data-view="explorer">
      <div class="side-head">
        <span class="js-side-title">explorer</span>
        <span class="t-spacer"></span>
        <span class="act-explorer">
          <button class="t-icon js-newfile" type="button" data-requires="agent" title="New file">${iconNewFile}</button>
          <button class="t-icon js-newdir" type="button" data-requires="agent" title="New folder">${iconNewFolder}</button>
        </span>
      </div>
      <div class="side-views">
        <div class="side-view active" data-pane="explorer"><div class="code-tree"></div></div>
        <div class="side-view" data-pane="search"></div>
        <div class="side-view" data-pane="scm"></div>
        <div class="side-view" data-pane="history"></div>
      </div>
    </aside>
    <div class="code-splitter" title="Drag to resize · double-click to hide (Ctrl+B)"></div>
    <div class="code-main">
      <div class="code-tabs js-tabs" hidden></div>
      <div class="conflict-bar js-conflict" hidden></div>
      <div class="code-editor-host"></div>
      <div class="code-diff-host" hidden></div>
    </div>
  </div>
  <div class="statusbar">
    <div class="sb-item code-path">no file</div>
    <div class="sb-item code-dirty"></div>
    <div class="t-spacer"></div>
    <div class="sb-item code-sync"></div>
    <div class="sb-item code-engine"></div>
  </div>`;

export function mountCodeTab(host: HTMLElement, ctx: CodeContext): CodeTab {
  host.innerHTML = SHELL;
  // The lists below size their virtual-scroll geometry from ROW_H; this is what
  // makes the stylesheet use the same number rather than its own copy of it.
  applyRowHeight();
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;

  const { agent } = ctx;
  const rootLabel = $(".code-root");
  const branchLabel = $(".code-branch");
  const pathLabel = $(".code-path");
  const dirtyLabel = $(".code-dirty");
  const syncLabel = $(".code-sync");
  const engineLabel = $(".code-engine");
  const editorHost = $(".code-editor-host");
  const diffHost = $(".code-diff-host");

  // ── open tabs ──
  // Files and diffs share one strip, the way an editor is expected to work: a
  // diff is something you leave open and come back to, not a mode that swallows
  // the window and loses itself the moment a file is opened.
  //
  // Files keep one EditorState each, so every tab has its own cursor, scroll
  // offset and undo history. `baselines` holds what was last read or written,
  // which is what makes the dirty marker mean "changed" rather than "touched".
  interface FileTab {
    kind: "file";
    /** Tab identity. For a file this is its path. */
    id: string;
    path: string;
    readOnly: boolean;
    /** The file's own line ending. CodeMirror normalises everything to \n, so
     *  without restoring this on save every write to a CRLF file would rewrite
     *  every line and turn each save into a whole-file diff. */
    eol: "\n" | "\r\n";
  }
  interface DiffTab {
    kind: "diff";
    /** Derived from what is being compared, so re-opening the same diff focuses
     *  the tab it is already in instead of stacking duplicates. */
    id: string;
    label: string;
    title: string;
    pair: DiffPair;
  }
  type OpenTab = FileTab | DiffTab;

  const tabs: OpenTab[] = [];
  const states = new Map<string, EditorState>();
  const baselines = new Map<string, string>();
  /** Which tab is on screen. */
  let activeId: string | null = null;
  /** The preview tab, if there is one.
   *
   *  A single click opens a file "on approval": it takes one reusable slot in
   *  the strip instead of adding to it, so clicking through twenty files leaves
   *  one tab rather than twenty. Double-clicking it, or editing it, promotes it
   *  to an ordinary tab. Editing is what makes replacing the slot safe — a tab
   *  with unsaved work has already been promoted out of it. */
  let previewId: string | null = null;
  /** True while activate() swaps the editor's document, so the change that
   *  swap produces is not mistaken for the user typing. */
  let swappingState = false;
  /** The active tab's path when it is a file, null while a diff is shown — so
   *  saving, conflict handling and the watcher never act on a diff. */
  let openPath: string | null = null;
  let openReadOnly = false;
  /** When we last wrote the open file ourselves. The watcher echoes that write
   *  back, and reloading on it would reset the cursor to the top after every
   *  save — so changes arriving right after our own write are ignored. */
  let lastSelfWrite = 0;

  // ── editor + diff ──
  // Typing into a previewed file is what makes it worth keeping, so the first
  // real edit promotes it. `swappingState` keeps a tab switch — which also
  // replaces the document — from counting as one.
  const editor = new CodeEditor(editorHost, ctx.isDark(), () => void save(), () => {
    if (!swappingState) pin(openPath);
    onEditorChange();
  });
  const diff = new DiffView(diffHost, ctx.isDark());

  const saveBtn = $<HTMLButtonElement>(".js-save");

  /** Save is off unless there is a writable file on screen and an agent to
   *  write it with — and the button says which of those is missing. */
  function updateSaveEnabled(): void {
    const why =
      agent.state !== "online" ? "Requires the local agent"
      : openPath === null ? "No file open"
      : openReadOnly ? "This file is read-only"
      : "";
    saveBtn.disabled = why !== "";
    saveBtn.title = why || "Save the open file";
  }

  /** Nothing open: the editor holds only its placeholder, so it is dimmed and
   *  made read-only. Leaving it editable invited typing into a document that
   *  belongs to no file and could never be saved. */
  function showEmptyEditor(): void {
    editor.state = editor.newState("", "", true);
    editorHost.classList.add("is-empty");
    pathLabel.textContent = "no file";
    updateSaveEnabled();
  }

  function showEditor(): void {
    diffHost.hidden = true;
    editorHost.hidden = false;
    $(".js-tabs").hidden = tabs.length === 0;
  }
  function showDiff(): void {
    editorHost.hidden = true;
    diffHost.hidden = false;
    // The strip stays: a diff is one of the open tabs, not a takeover.
    $(".js-tabs").hidden = tabs.length === 0;
    $(".js-conflict").hidden = true;
  }

  const isDirty = (path: string | null): boolean =>
    path !== null && states.has(path) && baselines.get(path) !== (path === openPath ? editor.value : states.get(path)!.doc.toString());

  function onEditorChange(): void {
    const dirty = isDirty(openPath);
    dirtyLabel.textContent = dirty ? "● unsaved" : "";
    dirtyLabel.classList.toggle("is-dirty", dirty);
    renderTabs();
    renderConflictBar();
  }

  // ── conflicts ──
  // Paths git reports as conflicted. The markers themselves are already in the
  // file — the editor highlights them and offers the per-region actions; this
  // bar just tracks how many are left and stages the file once none are.
  const conflicted = new Set<string>();

  function renderConflictBar(): void {
    const bar = $(".js-conflict");
    const path = openPath;
    if (!path || !conflicted.has(path) || !diffHost.hidden) {
      bar.hidden = true;
      return;
    }
    const remaining = findConflicts(editor.state.doc).length;
    bar.hidden = false;
    bar.classList.toggle("resolved", remaining === 0);
    bar.innerHTML = remaining
      ? `<span>⚠ ${remaining} unresolved conflict${remaining === 1 ? "" : "s"} — choose a side above each one.</span>`
      : `<span>✓ No markers left in this file.</span>
         <button class="t-btn t-btn-primary js-resolve" type="button">save &amp; mark resolved</button>`;
    bar.querySelector(".js-resolve")?.addEventListener("click", () => void markResolved(path));
  }

  async function markResolved(path: string): Promise<void> {
    try {
      if (isDirty(path)) await save();
      await agent.call("git.resolve", { paths: [path] });
      ctx.toast(`${path} marked resolved`);
      await afterGitChange();
    } catch (e) {
      ctx.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  // ── panels ──
  const tree = new FileTree(
    $(".code-tree"),
    {
      readDir: (path) => agent.call<DirEntry[]>("fs.readdir", { path }),
      createFile: (path) => agent.call("fs.createFile", { path }).then(() => undefined),
      createDir: (path) => agent.call("fs.createDir", { path }).then(() => undefined),
      move: (from, to) => agent.call("fs.move", { from, to }).then(() => undefined),
      remove: (paths) => agent.call("fs.delete", { paths }).then(() => undefined),
    },
    {
      onOpen: (path, preview) => void open(path, false, preview),
      onError: (m) => ctx.toast(m, true),
      confirmDelete: (paths) =>
        modalConfirm({
          title: paths.length === 1 ? `Delete ${paths[0]}?` : `Delete ${paths.length} items?`,
          detail: "Removed from disk, not from git — there is nothing to restore it from unless it was committed.",
          okLabel: "delete",
          danger: true,
        }),
      compare: (left, right) => void compare(left, right),
      compareWithHead: (path) => void openDiff(path, "head"),
    },
  );

  const gitPanel = new GitPanel(host.querySelector<HTMLElement>('[data-pane="scm"]')!, agent, {
    openDiff: (path, kind) => void openDiff(path, kind),
    openFile: (path) => void open(path),
    toast: ctx.toast,
    afterChange: () => void afterGitChange(),
  });

  const history = new HistoryPanel(host.querySelector<HTMLElement>('[data-pane="history"]')!, agent, {
    openDiff: (path, kind) => void openDiff(path, kind),
    toast: ctx.toast,
    afterChange: () => void afterGitChange(),
  });

  const searchPanel = new SearchPanel(host.querySelector<HTMLElement>('[data-pane="search"]')!, agent, {
    openAt: (path, line, col) => void openAt(path, line, col),
    toast: ctx.toast,
    afterReplace: () => {
      void refreshStatus();
      void tree.refresh(["*"]);
    },
  });

  // ── the side panel: width, drag, collapse ──
  //
  // This was `resize: horizontal` on the panel itself, which gives a grip in
  // one corner, forgets the width on reload, cannot be driven from the keyboard
  // and cannot close the panel at all.
  const sideEl = $(".code-side");
  const splitter = $(".code-splitter");
  const side = loadSide();

  function applySide(): void {
    sideEl.style.width = `${side.width}px`;
    // Both go: with the panel closed a bare splitter is a handle attached to
    // nothing. The rail is how it comes back, as is Ctrl+B.
    sideEl.hidden = side.collapsed;
    splitter.hidden = side.collapsed;
  }
  function setCollapsed(collapsed: boolean): void {
    side.collapsed = collapsed;
    saveSide(side);
    applySide();
  }
  applySide();

  splitter.addEventListener("pointerdown", (e) => {
    const ev = e as PointerEvent;
    if (ev.button !== 0) return;
    ev.preventDefault(); // or the drag selects text across the editor
    splitter.setPointerCapture(ev.pointerId);
    splitter.classList.add("dragging");
    const startX = ev.clientX;
    const startWidth = sideEl.getBoundingClientRect().width;

    const onMove = (m: PointerEvent): void => {
      // Clamped: dragged to nothing, the panel would be gone with no handle
      // left to bring it back, and past half the window the editor becomes the
      // gutter instead.
      side.width = Math.round(Math.min(Math.max(startWidth + m.clientX - startX, 150), window.innerWidth * 0.6));
      sideEl.style.width = `${side.width}px`;
    };
    const onUp = (): void => {
      splitter.classList.remove("dragging");
      splitter.removeEventListener("pointermove", onMove);
      splitter.removeEventListener("pointerup", onUp);
      saveSide(side);
    };
    splitter.addEventListener("pointermove", onMove);
    splitter.addEventListener("pointerup", onUp);
  });

  splitter.addEventListener("dblclick", () => setCollapsed(true));

  document.addEventListener("keydown", (e) => {
    if (!host.classList.contains("active")) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      setCollapsed(!side.collapsed);
    }
  });

  // ── views ──
  function showView(view: View): void {
    // Picking a view from the rail while the panel is closed means "show me
    // this", not "switch the thing I cannot see".
    if (side.collapsed) setCollapsed(false);
    $(".code-side").dataset.view = view;
    $(".js-side-title").textContent = { explorer: "explorer", search: "search", scm: "source control", history: "history" }[view];
    for (const b of host.querySelectorAll<HTMLElement>(".rail-btn")) {
      b.classList.toggle("active", b.dataset.view === view);
    }
    for (const p of host.querySelectorAll<HTMLElement>(".side-view")) {
      p.classList.toggle("active", p.dataset.pane === view);
    }
    if (view === "search") searchPanel.focus();
    if (view === "scm") void gitPanel.refresh();
    if (view === "history") void history.refresh();
  }

  // ── tabs ──
  function renderTabs(): void {
    const bar = $(".js-tabs");
    bar.hidden = tabs.length === 0;
    bar.innerHTML = tabs
      .map((t) => {
        const file = t.kind === "file";
        const name = file ? (t.path.split("/").pop() ?? t.path) : t.label;
        const dirty = file && isDirty(t.path);
        const cls = ["code-tab", t.id === activeId ? "active" : "", dirty ? "dirty" : "",
          t.id === previewId ? "preview" : "", file ? "" : "is-diff"]
          .filter(Boolean)
          .join(" ");
        return `<div class="${cls}" data-id="${esc(t.id)}" title="${esc(file ? t.path : t.title)}">
          ${file ? "" : `<span class="code-tab-icon">⇄</span>`}
          <span class="code-tab-name">${esc(name)}</span>
          <button class="code-tab-close" type="button" title="Close">${dirty ? "●" : "✕"}</button>
        </div>`;
      })
      .join("");
  }

  function forget(tab: OpenTab): void {
    if (tab.kind !== "file") return;
    states.delete(tab.path);
    baselines.delete(tab.path);
  }

  /** Put a newly opened tab in the strip. A preview replaces the preview slot
   *  in place, keeping its position, rather than appending. */
  function placeTab(tab: OpenTab, preview: boolean): void {
    const existing = tabs.findIndex((t) => t.id === tab.id);
    if (existing !== -1) {
      tabs[existing] = tab;
    } else {
      const slot = preview && previewId !== null ? tabs.findIndex((t) => t.id === previewId) : -1;
      if (slot === -1) {
        tabs.push(tab);
      } else {
        forget(tabs[slot]);
        tabs[slot] = tab;
      }
    }
    if (preview) previewId = tab.id;
    else if (previewId === tab.id) previewId = null;
  }

  /** Promote the preview tab to a permanent one. */
  function pin(id: string | null): void {
    if (id === null || previewId !== id) return;
    previewId = null;
    renderTabs();
  }

  /** Stash the on-screen document against the tab it belongs to. */
  function stashActive(): void {
    if (openPath) states.set(openPath, editor.state);
  }

  function activate(id: string): void {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    stashActive();
    activeId = id;

    if (tab.kind === "diff") {
      openPath = null;
      openReadOnly = false;
      diff.show(tab.pair);
      pathLabel.textContent = tab.title;
      updateSaveEnabled();
      dirtyLabel.textContent = "";
      dirtyLabel.classList.remove("is-dirty");
      showDiff();
      renderTabs();
      return;
    }

    const state = states.get(tab.path);
    if (!state) return;
    openPath = tab.path;
    openReadOnly = tab.readOnly;
    swappingState = true;
    editor.state = state;
    swappingState = false;
    editorHost.classList.remove("is-empty");
    pathLabel.textContent = tab.path + (tab.readOnly ? "  (read-only)" : "");
    updateSaveEnabled();
    showEditor();
    renderTabs();
    renderConflictBar();
    onEditorChange();
    editor.focus();
  }

  async function closeTab(id: string): Promise<void> {
    const i = tabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const tab = tabs[i];
    if (tab.kind === "file") {
      if (isDirty(tab.path)) {
        const ok = await modalConfirm({
          title: `${tab.path} has unsaved changes. Close anyway?`,
          detail: "The edits are discarded; the file on disk is left as it is.",
          okLabel: "close without saving",
          danger: true,
        });
        if (!ok) return;
      }
      states.delete(tab.path);
      baselines.delete(tab.path);
    }
    // Awaiting the dialog above means the list can have moved under us.
    const at = tabs.findIndex((t) => t.id === id);
    if (at === -1) return;
    tabs.splice(at, 1);
    if (previewId === id) previewId = null;

    if (activeId !== id) return renderTabs();
    activeId = null;
    openPath = null;
    // Fall back to the neighbour, the way an editor is expected to.
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) return activate(next.id);
    diff.clear();
    showEmptyEditor();
    showEditor();
    renderTabs();
    renderConflictBar();
    onEditorChange();
  }

  $(".js-tabs").addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const id = el.closest<HTMLElement>(".code-tab")?.dataset.id;
    if (!id) return;
    if (el.closest(".code-tab-close")) void closeTab(id);
    else activate(id);
  });
  // Double-clicking a preview tab keeps it, the same gesture as in the tree.
  $(".js-tabs").addEventListener("dblclick", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".code-tab")?.dataset.id;
    if (id) pin(id);
  });
  // Middle-click closes, as everywhere else.
  $(".js-tabs").addEventListener("auxclick", (e) => {
    const ev = e as MouseEvent;
    if (ev.button !== 1) return;
    const id = (ev.target as HTMLElement).closest<HTMLElement>(".code-tab")?.dataset.id;
    if (id) {
      ev.preventDefault();
      void closeTab(id);
    }
  });

  // ── file IO ──
  /** Open a file in a tab, or focus the tab it is already in. `reload` forces a
   *  fresh read for a file that changed underneath us. */
  /** Each open request gets a number; only the newest may take the screen.
   *  Reads are round trips, so clicking quickly through the tree can land them
   *  out of order, and without this the file that answered last would win
   *  rather than the file clicked last. */
  let openSeq = 0;

  async function open(path: string, reload = false, preview = false): Promise<void> {
    if (states.has(path) && !reload) {
      // Already open: a deliberate open (double click) pins whatever is there.
      if (!preview) pin(path);
      activate(path);
      return;
    }
    const seq = ++openSeq;
    try {
      const file = await agent.call<FileRead>("fs.read", { path });
      const readOnly = file.binary || file.tooLarge;
      const raw = file.text ?? (file.binary ? "// binary file" : "// file too large to open");
      const eol: "\n" | "\r\n" = raw.includes("\r\n") ? "\r\n" : "\n";
      // Compare against the normalised text, since that is what the editor holds.
      const text = raw.replace(/\r\n/g, "\n");

      const superseded = seq !== openSeq;
      if (!superseded) stashActive();
      const tab: FileTab = { kind: "file", id: path, path, readOnly, eol };
      placeTab(tab, preview && !reload);
      states.set(path, editor.newState(path, text, readOnly));
      baselines.set(path, text);

      // A later click already won the screen. The tab still opens — nothing the
      // user asked for is dropped — it just does not steal focus.
      if (superseded) return renderTabs();
      openPath = null; // stashActive already ran; do not stash the old doc twice
      activate(path);
    } catch (e) {
      ctx.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** Open a file and put the cursor on a specific match. */
  async function openAt(path: string, line: number, col: number): Promise<void> {
    // Walking search results should not leave a tab behind for every hit.
    await open(path, false, true);
    if (openPath === path) editor.revealPosition(line, col);
  }

  // ── comparison ──
  const base = (path: string): string => path.split("/").pop() ?? path;

  /** Put a diff in the tab strip, or refresh and focus the one already there.
   *  The pair is kept on the tab, so switching away to a file and back redraws
   *  it without another round trip. */
  function showDiffTab(id: string, label: string, title: string, pair: DiffPair, preview = true): void {
    // Diffs pile up the same way files do — a commit with sixty files is sixty
    // clicks — so they share the preview slot.
    placeTab({ kind: "diff", id, label, title, pair }, preview);
    activate(id);
  }

  /** Diff two arbitrary files in the workspace — no git involved. */
  async function compare(left: string, right: string): Promise<void> {
    try {
      const [a, b] = await Promise.all([
        agent.call<FileRead>("fs.read", { path: left }),
        agent.call<FileRead>("fs.read", { path: right }),
      ]);
      showDiffTab(`cmp:${JSON.stringify([left, right])}`, `${base(left)} ↔ ${base(right)}`, `${left} ↔ ${right}`, {
        path: `${left} ↔ ${right}`,
        before: a.text,
        after: b.text,
        beforeLabel: left,
        afterLabel: right,
        binary: a.binary || b.binary,
      });
    } catch (e) {
      ctx.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function openDiff(path: string, kind: string): Promise<void> {
    try {
      const pair = await agent.call<DiffPair>("git.diff", { path, kind });
      // `kind` is either a named diff or a commit oid, and the label has to say
      // which — otherwise every commit's diff of the same file reads the same
      // in the strip. Keyed by kind too, so each gets its own tab.
      const what = /^[0-9a-f]{7,40}$/.test(kind) ? kind.slice(0, 7) : kind;
      showDiffTab(`diff:${kind}:${path}`, `${base(path)} (${what})`, `${path}  (diff · ${what})`, pair);
    } catch (e) {
      ctx.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function save(): Promise<void> {
    if (!openPath || openReadOnly || !isDirty(openPath)) return;
    const path = openPath;
    const text = editor.value;
    const tab = tabs.find((t): t is FileTab => t.kind === "file" && t.path === path);
    const eol = tab?.eol ?? "\n";
    try {
      await agent.call("fs.write", { path, text: eol === "\n" ? text : text.replace(/\n/g, "\r\n") });
      lastSelfWrite = Date.now();
      // What is on disk is now the baseline, so the tab stops showing dirty.
      baselines.set(path, text);
      onEditorChange();
      ctx.toast(`saved ${openPath}`);
      void refreshStatus();
    } catch (e) {
      ctx.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  // ── git status feeding the tree and the rail badge ──
  async function refreshStatus(): Promise<void> {
    if (agent.state !== "online" || !agent.info?.gitVersion) return;
    try {
      const st = await agent.call<GitStatus>("git.status");
      tree.setStatus(st.entries);
      branchLabel.textContent = st.branch ?? "(detached)";

      conflicted.clear();
      for (const e of st.entries) if (e.conflict) conflicted.add(e.path);
      renderConflictBar();

      const parts: string[] = [];
      if (st.ahead) parts.push(`↑${st.ahead}`);
      if (st.behind) parts.push(`↓${st.behind}`);
      if (st.upstream) parts.push(st.upstream);
      syncLabel.textContent = parts.join(" ");

      const badge = $<HTMLElement>(".js-scm-badge");
      const count = st.entries.filter((e) => !e.ignored).length;
      badge.textContent = String(count);
      badge.hidden = count === 0;
    } catch (e) {
      branchLabel.textContent = "—";
      if (!/not a git repository/i.test(String(e))) ctx.toast(String(e), true);
    }
  }

  /** A git operation moved refs or the worktree: everything derived is stale. */
  async function afterGitChange(): Promise<void> {
    await refreshStatus();
    await tree.refresh(["*"]);
    void history.refresh();
    // The open file may have been rewritten by a checkout or reset.
    if (openPath && !isDirty(openPath)) void open(openPath, true);
  }

  // ── agent lifecycle ──
  async function onOnline(): Promise<void> {
    rootLabel.textContent = agent.info?.root ?? "";
    rootLabel.title = agent.info?.root ?? "";
    engineLabel.textContent = agent.info?.ripgrep ? "rg" : "built-in search";
    await tree.load();
    await refreshStatus();
    void gitPanel.refresh();
    await agent.call("watch.start").catch(() => undefined);
  }

  function onOffline(): void {
    rootLabel.textContent = "not connected";
    branchLabel.textContent = "—";
    syncLabel.textContent = "";
    engineLabel.textContent = "";
    $<HTMLElement>(".js-scm-badge").hidden = true;
    tree.reset();
    diff.clear();
    // The tabs point at files on a machine we can no longer reach; keeping them
    // around would only offer to save into nothing.
    tabs.length = 0;
    states.clear();
    baselines.clear();
    conflicted.clear();
    activeId = null;
    previewId = null;
    openPath = null;
    openReadOnly = false;
    showEmptyEditor();
    renderTabs();
    renderConflictBar();
    showEditor();
  }

  /** `.git` reports changes on the directory itself, not only on the files
   *  inside it, so no path filter can tell a real commit from any git process
   *  briefly taking index.lock — and something doing that in a loop had three
   *  panels rebuilding several times a second. Coalesce to at most once a
   *  second, with a trailing run so the last burst is never the one missed. */
  let lastGitRefresh = 0;
  let gitRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function refreshGitViews(): void {
    const waited = Date.now() - lastGitRefresh;
    if (waited < 1000) {
      if (!gitRefreshTimer) {
        gitRefreshTimer = setTimeout(() => {
          gitRefreshTimer = null;
          refreshGitViews();
        }, 1000 - waited);
      }
      return;
    }
    lastGitRefresh = Date.now();
    void refreshStatus();
    void gitPanel.refresh();
    void history.refresh();
  }

  agent.on("fs.change", (data) => {
    const { paths } = data as FsChange;
    // The watcher collapses everything under .git into one sentinel.
    if (paths.includes(".git")) refreshGitViews();
    const fsPaths = paths.filter((p) => p !== ".git");
    if (fsPaths.length) {
      void tree.refresh(fsPaths);
      void refreshStatus();
      // Reload the open file only when the user has nothing to lose, and never
      // as an echo of the save we just performed.
      const echo = Date.now() - lastSelfWrite < 1000;
      if (openPath && !isDirty(openPath) && !echo && (fsPaths.includes(openPath) || fsPaths.includes("*"))) void open(openPath, true);
    }
  });

  // ── connect flow ──

  async function connectTo(url: string): Promise<void> {
    try {
      await agent.connect(url);
      ctx.toast("agent connected");
    } catch (e) {
      ctx.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** An agent URL sitting on the clipboard, if there is one, if we are allowed
   *  to look, and if the answer arrives quickly.
   *
   *  Strictly an optimisation. Reading the clipboard needs a permission the
   *  browser may prompt for, and Firefox does not offer it to pages at all, so
   *  every failure path just leaves the saved URL in the field. It runs inside
   *  the click that opened the dialog, which is the only moment the browsers
   *  that do allow it will.
   *
   *  The timeout is the part that is not optional. readText() does not reject
   *  while the permission prompt is up — it simply does not settle, and the
   *  prompt is a small bubble under the address bar that nobody is looking at,
   *  because they just clicked a button in the page. The dialog was awaiting
   *  this, so "connect…" did nothing at all, with no error and nothing to
   *  retry. Half a second and we open the dialog without the prefill. */
  async function clipboardUrl(): Promise<string | null> {
    try {
      const read = navigator.clipboard.readText();
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 500));
      const text = (await Promise.race([read, timeout]))?.trim();
      return text && isAgentUrl(text) ? text : null;
    } catch {
      return null;
    }
  }

  async function connect(): Promise<void> {
    const fromClipboard = await clipboardUrl();
    const url = await modalPrompt({
      title: "Local agent URL",
      value: fromClipboard ?? agent.savedUrl(),
      placeholder: "ws://127.0.0.1:5001/ws?token=…",
      hint: fromClipboard
        ? "Taken from your clipboard — the agent put it there when it started."
        : "Run `enc-tool agent` in the folder you want to edit, then paste the URL it prints.",
      okLabel: "connect",
    });
    if (!url) return;
    await connectTo(url);
  }

  // Paste anywhere on the tab to connect.
  //
  // The agent copies its URL to the clipboard as it starts, so this is the
  // other half of that: Ctrl+V, rather than open the dialog, clear the stale
  // URL, paste, confirm. Listening on the document because a paste fires at
  // whatever holds focus — usually <body> — and events bubble up, not down.
  //
  // Two guards keep it from stealing a paste that meant something else: it does
  // nothing while an agent is connected, when a pasted URL is far more likely
  // to be content the user is editing, and nothing when the caret is in a field
  // or in the editor. Text that is not an agent URL is left alone regardless.
  document.addEventListener("paste", (e) => {
    if (!host.classList.contains("active") || agent.state === "online") return;
    if ((e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable=true]")) return;
    const text = e.clipboardData?.getData("text")?.trim();
    if (!text || !isAgentUrl(text)) return;
    e.preventDefault();
    void connectTo(text);
  });

  // ── wiring ──
  $(".js-connect").addEventListener("click", () => void connect());
  $(".js-reload").addEventListener("click", () => {
    void tree.load();
    void refreshStatus();
    void gitPanel.refresh();
    void history.refresh();
  });
  $(".js-save").addEventListener("click", () => void save());
  $(".js-newfile").addEventListener("click", () => tree.createIn(false));
  $(".js-newdir").addEventListener("click", () => tree.createIn(true));
  for (const b of host.querySelectorAll<HTMLElement>(".rail-btn")) {
    b.addEventListener("click", () => showView(b.dataset.view as View));
  }

  // Only transitions matter: reconnect attempts fire repeatedly while offline.
  let wasOnline = false;
  const onAgentState = (): void => {
    const online = agent.state === "online";
    if (online !== wasOnline) {
      wasOnline = online;
      if (online) void onOnline();
      else onOffline();
    }
    updateSaveEnabled();
    ctx.onCapsChanged();
  };
  // Start in the empty state rather than an editable blank document.
  showEmptyEditor();
  onAgentState();

  return {
    setTheme: (dark) => {
      editor.setTheme(dark);
      diff.setTheme(dark);
    },
    connect,
    focus: () => editor.focus(),
    onAgentState,
  };
}
