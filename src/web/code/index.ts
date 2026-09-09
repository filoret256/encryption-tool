/** Code tab: explorer, source control, history, editor and diff — wired to the
 *  local agent.
 *
 *  Loaded lazily; main.ts imports it by URL on the first switch to this tab so
 *  the grammar set never lands in the crypto tabs' bundle.
 */
import type { EditorState } from "@codemirror/state";
import type { AgentClient } from "./agent.ts";
import type { DiffPair, DirEntry, FileRead, FsChange, GitStatus } from "../../agent/protocol.ts";
import { CodeEditor } from "./editor.ts";
import { FileTree } from "./tree.ts";
import { GitPanel } from "./git-panel.ts";
import { HistoryPanel } from "./history.ts";
import { SearchPanel } from "./search-panel.ts";
import { DiffView } from "./diff.ts";
import { findConflicts } from "./conflicts.ts";
import { attr, esc, modalPrompt } from "./ui.ts";

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

const SHELL = `
  <div class="toolbar code-toolbar">
    <span class="t-label">folder</span>
    <span class="code-root">not connected</span>
    <button class="t-btn js-connect" type="button">connect…</button>
    <button class="t-btn js-reload" type="button" data-requires="agent" title="Reload">⟳</button>
    <div class="toolbar-sep"></div>
    <span class="t-label">branch</span>
    <span class="code-branch" data-requires="git">—</span>
    <div class="t-spacer"></div>
    <button class="t-btn t-btn-primary js-save" type="button" data-requires="agent">↓ save</button>
  </div>
  <div class="code-body">
    <nav class="code-rail">
      <button class="rail-btn active" type="button" data-view="explorer" title="Explorer">🗀</button>
      <button class="rail-btn" type="button" data-view="search" data-requires="agent" title="Search across the project">⌕</button>
      <button class="rail-btn" type="button" data-view="scm" data-requires="git" title="Source control">
        ⑂<span class="rail-badge js-scm-badge" hidden></span>
      </button>
      <button class="rail-btn" type="button" data-view="history" data-requires="git" title="History">⌛</button>
    </nav>
    <aside class="code-side" data-view="explorer">
      <div class="side-head">
        <span class="js-side-title">explorer</span>
        <span class="t-spacer"></span>
        <span class="act-explorer">
          <button class="t-icon js-newfile" type="button" data-requires="agent" title="New file">🗎+</button>
          <button class="t-icon js-newdir" type="button" data-requires="agent" title="New folder">🗀+</button>
        </span>
      </div>
      <div class="side-views">
        <div class="side-view active" data-pane="explorer"><div class="code-tree"></div></div>
        <div class="side-view" data-pane="search"></div>
        <div class="side-view" data-pane="scm"></div>
        <div class="side-view" data-pane="history"></div>
      </div>
    </aside>
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
  /** The active tab's path when it is a file, null while a diff is shown — so
   *  saving, conflict handling and the watcher never act on a diff. */
  let openPath: string | null = null;
  let openReadOnly = false;
  /** When we last wrote the open file ourselves. The watcher echoes that write
   *  back, and reloading on it would reset the cursor to the top after every
   *  save — so changes arriving right after our own write are ignored. */
  let lastSelfWrite = 0;

  // ── editor + diff ──
  const editor = new CodeEditor(editorHost, ctx.isDark(), () => void save(), () => onEditorChange());
  const diff = new DiffView(diffHost, ctx.isDark());

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
      onOpen: (path) => void open(path),
      onError: (m) => ctx.toast(m, true),
      confirmDelete: (paths) => confirm(`Delete ${paths.join(", ")}? This cannot be undone.`),
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

  // ── views ──
  function showView(view: View): void {
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
        const cls = ["code-tab", t.id === activeId ? "active" : "", dirty ? "dirty" : "", file ? "" : "is-diff"]
          .filter(Boolean)
          .join(" ");
        return `<div class="${cls}" data-id="${attr(t.id)}" title="${esc(file ? t.path : t.title)}">
          ${file ? "" : `<span class="code-tab-icon">⇄</span>`}
          <span class="code-tab-name">${esc(name)}</span>
          <button class="code-tab-close" type="button" title="Close">${dirty ? "●" : "✕"}</button>
        </div>`;
      })
      .join("");
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
    editor.state = state;
    pathLabel.textContent = tab.path + (tab.readOnly ? "  (read-only)" : "");
    showEditor();
    renderTabs();
    renderConflictBar();
    onEditorChange();
    editor.focus();
  }

  function closeTab(id: string): void {
    const i = tabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const tab = tabs[i];
    if (tab.kind === "file") {
      if (isDirty(tab.path) && !confirm(`${tab.path} has unsaved changes. Close anyway?`)) return;
      states.delete(tab.path);
      baselines.delete(tab.path);
    }
    tabs.splice(i, 1);

    if (activeId !== id) return renderTabs();
    activeId = null;
    openPath = null;
    // Fall back to the neighbour, the way an editor is expected to.
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) return activate(next.id);
    diff.clear();
    editor.state = editor.newState("", "", false);
    pathLabel.textContent = "no file";
    showEditor();
    renderTabs();
    renderConflictBar();
    onEditorChange();
  }

  $(".js-tabs").addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const id = el.closest<HTMLElement>(".code-tab")?.dataset.id;
    if (!id) return;
    if (el.closest(".code-tab-close")) closeTab(id);
    else activate(id);
  });
  // Middle-click closes, as everywhere else.
  $(".js-tabs").addEventListener("auxclick", (e) => {
    const ev = e as MouseEvent;
    if (ev.button !== 1) return;
    const id = (ev.target as HTMLElement).closest<HTMLElement>(".code-tab")?.dataset.id;
    if (id) {
      ev.preventDefault();
      closeTab(id);
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

  async function open(path: string, reload = false): Promise<void> {
    if (states.has(path) && !reload) return activate(path);
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
      const existing = tabs.findIndex((t) => t.id === path);
      if (existing === -1) tabs.push(tab);
      else tabs[existing] = tab;
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
    await open(path);
    if (openPath === path) editor.revealPosition(line, col);
  }

  // ── comparison ──
  const base = (path: string): string => path.split("/").pop() ?? path;

  /** Put a diff in the tab strip, or refresh and focus the one already there.
   *  The pair is kept on the tab, so switching away to a file and back redraws
   *  it without another round trip. */
  function showDiffTab(id: string, label: string, title: string, pair: DiffPair): void {
    const tab: DiffTab = { kind: "diff", id, label, title, pair };
    const existing = tabs.findIndex((t) => t.id === id);
    if (existing === -1) tabs.push(tab);
    else tabs[existing] = tab;
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
    openPath = null;
    editor.state = editor.newState("", "", false);
    pathLabel.textContent = "no file";
    renderTabs();
    renderConflictBar();
    showEditor();
  }

  agent.on("fs.change", (data) => {
    const { paths } = data as FsChange;
    // The watcher collapses everything under .git into one sentinel.
    if (paths.includes(".git")) {
      void refreshStatus();
      void gitPanel.refresh();
      void history.refresh();
    }
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
  async function connect(): Promise<void> {
    const url = await modalPrompt({
      title: "Local agent URL",
      value: agent.savedUrl(),
      placeholder: "ws://127.0.0.1:5001/ws?token=…",
      hint: "Run `enc-tool agent` in the folder you want to edit, then paste the URL it prints.",
      okLabel: "connect",
    });
    if (!url) return;
    try {
      await agent.connect(url);
      ctx.toast("agent connected");
    } catch (e) {
      ctx.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

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
    ctx.onCapsChanged();
  };
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
