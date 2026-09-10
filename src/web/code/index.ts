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
import { applyRowHeight, esc, modalConfirm, modalPrompt, showMenu, type MenuItem } from "./ui.ts";
import { draftsFor, dropDraft, putDraft } from "./drafts.ts";
import { OutputLog } from "./output.ts";
import { Commands } from "./commands.ts";
import { quickPick } from "./quickpick.ts";
import { iconBranch, iconFiles, iconHistory, iconNewFile, iconNewFolder, iconRefresh, iconSearch } from "./icons.ts";

export interface CodeContext {
  agent: AgentClient;
  isDark: () => boolean;
  /** A notice with somewhere to go: the summary is shown, and `onDetails`
   *  opens the output log at the entry it came from. */
  notify: (notice: { message: string; isError?: boolean; onDetails?: () => void }) => void;
  /** Clear the notification stack — the output log's "clear" empties both. */
  dismissNotices: () => void;
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
      <div class="offline-bar js-offline" hidden></div>
      <div class="conflict-bar js-hunk" hidden></div>
      <div class="conflict-bar js-disk-conflict" hidden></div>
      <div class="conflict-bar js-conflict" hidden></div>
      <div class="code-editor-host"></div>
      <div class="code-diff-host" hidden></div>
      <div class="js-output"></div>
    </div>
  </div>
  <div class="statusbar">
    <div class="sb-item code-path">no file</div>
    <div class="sb-item code-dirty"></div>
    <div class="t-spacer"></div>
    <div class="sb-item code-sync"></div>
    <div class="sb-item code-engine"></div>
    <button class="sb-item sb-button js-output-toggle" type="button" title="What git and the agent said (the output log)">output</button>
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

  // ── the output log ──
  // Every operation this tab performs on the user's behalf reports here, and
  // the toast becomes a one-line pointer at it rather than the only copy.
  const outputToggle = $<HTMLButtonElement>(".js-output-toggle");
  const output = new OutputLog($(".js-output"), {
    onVisibility: (open) => outputToggle.classList.toggle("is-active", open),
    // Anything that changes the entries changes what the status bar should
    // say, "clear" included — the count and the red were left behind by it.
    onChange: () => updateOutputBadge(),
    onCleared: () => ctx.dismissNotices(),
  });
  outputToggle.addEventListener("click", () => output.toggle());

  /** Say what happened, once, in both places.
   *
   *  `summary` is the line a person reads in passing; `detail` is everything
   *  the tool actually said — which for git is routinely a paragraph of hints
   *  and absolute paths. The toast gets the first, the log gets both, and an
   *  error toast carries a way to reach the second.
   */
  function report(op: string, summary: string, opts: { detail?: string; isError?: boolean } = {}): void {
    const level = opts.isError ? "error" : "info";
    // The badge follows from the log's own onChange hook, not from here — that
    // way it cannot be right for entries added through report() and stale for
    // everything else the log does.
    const entry = output.add(op, level, summary, opts.detail);
    ctx.notify({
      message: summary,
      isError: opts.isError,
      onDetails: opts.detail ? () => output.show(entry.id) : undefined,
    });
  }

  /** git speaks in paragraphs. The first line that carries a verb is what the
   *  toast shows; the rest is why the log exists. */
  function firstLine(text: string): string {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // The first line is rarely the point. A rejected push opens with "To
    // <url>" and a failed pull opens with a CRLF warning; what a person needs
    // is the line that says what went wrong. Look for it, and only fall back
    // to the top of the message when nothing announces itself.
    const verdict = lines.find((l) => /^(?:error|fatal)\b|\[rejected\]|\bAborting\b|\bfailed\b/i.test(l));
    const nonWarning = lines.find((l) => !/^warning:/i.test(l));
    return (verdict ?? nonWarning ?? lines[0] ?? text).slice(0, 200);
  }

  /** Report a failure: same shape everywhere, so no call site has to decide
   *  what a caught value looks like. */
  function reportError(op: string, e: unknown): void {
    const full = e instanceof Error ? e.message : String(e);
    report(op, firstLine(full), { detail: full.includes("\n") || full.length > 200 ? full : undefined, isError: true });
  }

  /** What the git, history and search panels call. They hand over whatever the
   *  agent said, in full; splitting it into a line and a transcript happens
   *  here so every panel gets the same treatment without knowing about it. */
  function panelReport(message: string, isError = false): void {
    const long = message.includes("\n") || message.length > 200;
    report("git", firstLine(message), { detail: long ? message : undefined, isError });
  }

  function updateOutputBadge(): void {
    const errors = output.errorCount;
    outputToggle.textContent = errors ? `output ${errors}` : "output";
    outputToggle.classList.toggle("has-errors", errors > 0);
  }

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
    /** Tab identity — a number, not the path.
     *
     *  It used to be the path, and that made a tab and a file on disk the same
     *  thing: renaming in the explorer left the tab pointing at a name that no
     *  longer existed, and the next Ctrl+S wrote the buffer back under it —
     *  two files where the user had asked for one. Deleting was worse, because
     *  the save silently resurrected what had just been thrown away.
     *
     *  With an identity of its own, a tab is a document that happens to know
     *  where it currently lives. `path` moves when the file moves; `missing`
     *  says the file is gone while the work in the buffer is not. */
    id: string;
    path: string;
    readOnly: boolean;
    /** The file's own line ending. CodeMirror normalises everything to \n, so
     *  without restoring this on save every write to a CRLF file would rewrite
     *  every line and turn each save into a whole-file diff. */
    eol: "\n" | "\r\n";
    /** The file was deleted or moved away underneath us. The buffer stays; the
     *  tab says so, and saving asks before writing the file back into being. */
    missing?: boolean;
  }
  interface DiffTab {
    kind: "diff";
    /** The working-tree file this diff writes back to, when it may be edited.
     *  Only "index → working tree" qualifies: every other diff compares two
     *  things that are already committed, and there is nothing to write. */
    editablePath?: string;
    /** Text the reader has produced by reverting chunks or typing, not yet on
     *  disk. Cleared by saving or by leaving the tab. */
    pending?: string;
    /** Derived from what is being compared, so re-opening the same diff focuses
     *  the tab it is already in instead of stacking duplicates. */
    id: string;
    label: string;
    title: string;
    pair: DiffPair;
  }
  type OpenTab = FileTab | DiffTab;

  const tabs: OpenTab[] = [];
  /** Keyed by tab id, never by path — see FileTab.id. */
  const states = new Map<string, EditorState>();
  const baselines = new Map<string, string>();
  let nextTabId = 1;
  const newTabId = (): string => `f${nextTabId++}`;

  const fileTabs = (): FileTab[] => tabs.filter((t): t is FileTab => t.kind === "file");
  /** The tab a path is open in, if any. A path is in at most one tab: `open()`
   *  focuses the existing one rather than making a second. */
  const tabForPath = (path: string): FileTab | undefined => fileTabs().find((t) => t.path === path && !t.missing);
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
  /** The file tab on screen, or null while a diff is shown — so saving,
   *  conflict handling and the watcher never act on a diff. */
  let openFile: FileTab | null = null;
  /** When we last wrote the open file ourselves. The watcher echoes that write
   *  back, and reloading on it would reset the cursor to the top after every
   *  save — so changes arriving right after our own write are ignored. */
  let lastSelfWrite = 0;

  // ── editor + diff ──
  // Typing into a previewed file is what makes it worth keeping, so the first
  // real edit promotes it. `swappingState` keeps a tab switch — which also
  // replaces the document — from counting as one.
  const editor = new CodeEditor(editorHost, ctx.isDark(), () => void save(), () => {
    if (!swappingState) pin(openFile?.id ?? null);
    onEditorChange();
  });
  const diff = new DiffView(diffHost, ctx.isDark());

  const saveBtn = $<HTMLButtonElement>(".js-save");

  /** Save is off unless there is a writable file on screen and an agent to
   *  write it with — and the button says which of those is missing. */
  function updateSaveEnabled(): void {
    const why =
      agent.state !== "online" ? "Requires the local agent"
      : openFile === null ? "No file open"
      : openFile.readOnly ? "This file is read-only"
      : "";
    saveBtn.disabled = why !== "";
    saveBtn.title = why || (openFile?.missing ? "Save — the file is gone from disk and will be created again" : "Save the open file");
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
    // The hunk bar belongs to a diff; leaving it up over the editor would offer
    // to write a file the reader is no longer looking at.
    $(".js-hunk").hidden = true;
    $(".js-tabs").hidden = tabs.length === 0;
  }
  function showDiff(): void {
    editorHost.hidden = true;
    diffHost.hidden = false;
    // The strip stays: a diff is one of the open tabs, not a takeover.
    $(".js-tabs").hidden = tabs.length === 0;
    $(".js-conflict").hidden = true;
    $(".js-disk-conflict").hidden = true;
  }

  /** Has this tab's buffer moved away from what was last read or written?
   *
   *  The tab on screen is compared against the live editor, every other one
   *  against its stashed state — the stash is only refreshed on a tab switch,
   *  so for the active tab it is always one step behind. */
  const isDirty = (tab: FileTab | null | undefined): boolean =>
    !!tab && states.has(tab.id) && baselines.get(tab.id) !== (tab.id === openFile?.id ? editor.value : states.get(tab.id)!.doc.toString());

  function onEditorChange(): void {
    const dirty = isDirty(openFile);
    dirtyLabel.textContent = dirty ? "● unsaved" : "";
    dirtyLabel.classList.toggle("is-dirty", dirty);
    renderTabs();
    renderConflictBar();
    renderOfflineBar();
    scheduleDraft();
  }

  // ── drafts ──
  // What is typed but not written lives in one place otherwise: this page. A
  // reload, a crash, or a laptop lid takes it. So a dirty buffer is mirrored
  // into IndexedDB shortly after it stops changing, and dropped the moment it
  // reaches disk. See drafts.ts for why it is not localStorage.
  let draftTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleDraft(): void {
    if (draftTimer) clearTimeout(draftTimer);
    // Long enough that typing never queues a write per keystroke, short enough
    // that what is lost to a crash is a sentence, not a session.
    draftTimer = setTimeout(() => {
      draftTimer = null;
      const tab = openFile;
      const root = boundRoot;
      if (!tab || !root) return;
      if (isDirty(tab)) void putDraft(root, tab.path, editor.value);
      else void dropDraft(root, tab.path);
    }, 800);
  }

  /** Drafts for this workspace that no open tab already accounts for.
   *
   *  Offered, never restored behind the user's back: a draft can be older than
   *  the file it belongs to, and quietly replacing what is on disk with a
   *  forgotten buffer is its own kind of data loss. */
  async function offerDrafts(root: string): Promise<void> {
    const stored = (await draftsFor(root)).filter((d) => !tabForPath(d.path));
    if (!stored.length) return;

    const names = stored.slice(0, 3).map((d) => d.path).join(", ");
    const ok = await modalConfirm({
      title: stored.length === 1 ? `Restore unsaved changes to ${stored[0].path}?` : `Restore unsaved changes to ${stored.length} files?`,
      detail: `Kept in this browser when the agent went away${stored.length > 1 ? `: ${names}${stored.length > 3 ? ", …" : ""}` : ""}. Restoring reopens ${stored.length === 1 ? "it" : "them"} with your edits, unsaved — nothing is written until you save.`,
      okLabel: "restore",
    });
    if (!ok) {
      for (const d of stored) void dropDraft(root, d.path);
      return;
    }

    for (const draft of stored) await restoreDraft(draft);
    renderTabs();
    onEditorChange();
  }

  /** Reopen one draft.
   *
   *  The file it belongs to may still be on disk, in which case it is read
   *  first — that gives the tab a baseline, so the draft shows as unsaved
   *  rather than as the truth — or it may be gone, which is precisely the case
   *  worth keeping a draft for. Then the tab opens on the buffer alone, marked
   *  missing, and saving it asks before recreating the file. */
  async function restoreDraft(draft: { path: string; text: string }): Promise<void> {
    const onDisk = await agent.call<FileRead>("fs.read", { path: draft.path }).catch(() => null);
    const readOnly = Boolean(onDisk?.binary || onDisk?.tooLarge);
    const raw = onDisk?.text ?? null;
    const eol: "\n" | "\r\n" = raw?.includes("\r\n") ? "\r\n" : "\n";

    const tab: FileTab = {
      kind: "file",
      id: newTabId(),
      path: draft.path,
      readOnly,
      eol,
      missing: onDisk === null,
    };
    placeTab(tab, false);
    states.set(tab.id, editor.newState(draft.path, draft.text, readOnly));
    // The baseline is what is on disk — or, for a file that is gone, something
    // the buffer cannot equal, so the tab stays honest about being unsaved.
    baselines.set(tab.id, raw?.replace(/\r\n/g, "\n") ?? `${draft.text} `);
    activate(tab.id);
  }

  // ── conflicts ──
  // Paths git reports as conflicted. The markers themselves are already in the
  // file — the editor highlights them and offers the per-region actions; this
  // bar just tracks how many are left and stages the file once none are.
  const conflicted = new Set<string>();

  // ── the file moved while we were not watching ──
  // Tab ids whose buffer is dirty *and* whose file on disk changed underneath
  // it — the case a reconnect can produce, because nothing was watching while
  // the agent was gone. Neither side may be thrown away without asking.
  const conflictingTabs = new Set<string>();

  function renderDiskConflictBar(): void {
    const bar = $(".js-disk-conflict");
    const tab = openFile;
    if (!tab || !conflictingTabs.has(tab.id) || !diffHost.hidden) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.innerHTML = `<span>⚠ ${esc(tab.path)} changed on disk while the agent was away, and this buffer has unsaved edits.</span>
      <button class="t-btn js-disk-compare" type="button">compare</button>
      <button class="t-btn js-disk-mine" type="button">keep mine</button>
      <button class="t-btn js-disk-theirs" type="button">use the file on disk</button>`;
    bar.querySelector(".js-disk-compare")!.addEventListener("click", () => void compareWithBuffer(tab));
    bar.querySelector(".js-disk-mine")!.addEventListener("click", () => {
      // Keeping mine settles nothing on disk — it only stops asking. The tab
      // stays dirty, and the next save is an ordinary overwrite.
      conflictingTabs.delete(tab.id);
      renderDiskConflictBar();
      renderTabs();
    });
    bar.querySelector(".js-disk-theirs")!.addEventListener("click", () => {
      conflictingTabs.delete(tab.id);
      baselines.set(tab.id, ""); // force the reload past the isDirty guard
      void open(tab.path, true);
    });
  }

  /** The bar over an edited diff.
   *
   *  Reverting a chunk changes the text in front of you, not the file: nothing
   *  reaches disk until this says so. Silent writes from a diff view would be
   *  the one place in the app where looking at something changed it.
   */
  function renderHunkBar(tab: DiffTab): void {
    const bar = $(".js-hunk");
    if (!tab.editablePath || tab.pending === undefined || tab.pending === tab.pair.after) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.innerHTML = `<span>Changes reverted in this view — not written yet.</span>
      <button class="t-btn t-btn-primary js-hunk-save" type="button">write ${esc(tab.editablePath)}</button>
      <button class="t-btn js-hunk-undo" type="button">put it back</button>`;
    bar.querySelector(".js-hunk-save")!.addEventListener("click", () => void writeHunkEdits(tab));
    bar.querySelector(".js-hunk-undo")!.addEventListener("click", () => {
      tab.pending = undefined;
      diff.show(tab.pair, (text) => {
        tab.pending = text;
        renderHunkBar(tab);
      });
      renderHunkBar(tab);
    });
  }

  async function writeHunkEdits(tab: DiffTab): Promise<void> {
    if (!tab.editablePath || tab.pending === undefined) return;
    const path = tab.editablePath;
    // The file keeps its own line endings, the same way an ordinary save does.
    const openTab = tabForPath(path);
    const eol = openTab?.eol ?? "\n";
    try {
      await agent.call("fs.write", { path, text: eol === "\n" ? tab.pending : tab.pending.replace(/\n/g, "\r\n") });
      lastSelfWrite = Date.now();
      report("save", `wrote ${path}`);
      // What is on disk is the new right-hand side, so the view is rebuilt
      // against it: otherwise the header keeps counting changes that are no
      // longer there.
      tab.pair = { ...tab.pair, after: tab.pending };
      tab.pending = undefined;
      if (activeId === tab.id) {
        diff.show(tab.pair, (text) => {
          tab.pending = text;
          renderHunkBar(tab);
        });
      }
      renderHunkBar(tab);
      void refreshStatus();
      // The file may be open in a tab of its own; that buffer is now behind.
      if (openTab && !isDirty(openTab)) void open(path, true);
    } catch (e) {
      reportError("fs.write", e);
    }
  }

  /** Show what is on disk against what is in the buffer. Read-only, like every
   *  other diff here — the point is to decide, not to merge in place. */
  async function compareWithBuffer(tab: FileTab): Promise<void> {
    try {
      const file = await agent.call<FileRead>("fs.read", { path: tab.path });
      const buffer = tab.id === openFile?.id ? editor.value : (states.get(tab.id)?.doc.toString() ?? "");
      showDiffTab(
        `buffer:${tab.id}`,
        `${base(tab.path)} (disk ↔ yours)`,
        `${tab.path}  (on disk ↔ unsaved buffer)`,
        {
          path: tab.path,
          before: file.text?.replace(/\r\n/g, "\n") ?? null,
          after: buffer,
          beforeLabel: "on disk",
          afterLabel: "your unsaved buffer",
          binary: file.binary,
        },
        false,
      );
    } catch (e) {
      reportError("agent", e);
    }
  }

  function renderConflictBar(): void {
    const bar = $(".js-conflict");
    const path = openFile?.path ?? null;
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
      if (isDirty(tabForPath(path))) await save();
      await agent.call("git.resolve", { paths: [path] });
      report("git resolve", `${path} marked resolved`);
      await afterGitChange();
    } catch (e) {
      reportError("git resolve", e);
    }
  }

  // ── panels ──
  const tree = new FileTree(
    $(".code-tree"),
    {
      readDir: (path) => agent.call<DirEntry[]>("fs.readdir", { path }),
      createFile: (path) => agent.call("fs.createFile", { path }).then(() => undefined),
      createDir: (path) => agent.call("fs.createDir", { path }).then(() => undefined),
      // The open tabs are told directly rather than left to hear it from the
      // watcher: the watcher reports "something under this directory changed",
      // which cannot tell a rename from a delete-and-create, and guessing wrong
      // costs the user their buffer.
      move: (from, to) =>
        agent.call("fs.move", { from, to }).then(() => {
          retargetTabs(from, to);
        }),
      remove: (paths) =>
        agent.call("fs.delete", { paths }).then(() => {
          for (const tab of fileTabs()) {
            if (paths.some((p) => tab.path === p || tab.path.startsWith(`${p}/`))) markMissing(tab);
          }
        }),
    },
    {
      onOpen: (path, preview) => void open(path, false, preview),
      onError: (m) => panelReport(m, true),
      notify: (m, isError) => report("explorer", m, { isError }),
      workspaceRoot: () => agent.info?.root ?? null,
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
    toast: panelReport,
    afterChange: () => void afterGitChange(),
  });

  const history = new HistoryPanel(host.querySelector<HTMLElement>('[data-pane="history"]')!, agent, {
    openDiff: (path, kind) => void openDiff(path, kind),
    toast: panelReport,
    afterChange: () => void afterGitChange(),
  });

  const searchPanel = new SearchPanel(host.querySelector<HTMLElement>('[data-pane="search"]')!, agent, {
    openAt: (path, line, col) => void openAt(path, line, col),
    toast: panelReport,
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

  // The keyboard, in one place. Every chord comes from a registered command
  // (see commands.ts), so nothing can be bound without also being findable in
  // the palette. Captured, because CodeMirror has its own keymap and would
  // otherwise swallow anything it recognises before the tab sees it.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!host.classList.contains("active")) return;
      // A dialog is on screen: it owns the keyboard until it closes.
      if (document.querySelector(".modal-back")) return;
      if (commands.handleKey(e)) e.preventDefault();
    },
    true,
  );

  // ── commands ──
  // Declared once; the palette, the keyboard and (later) any menu all read
  // from here. Chords avoid what a browser will not give up: Ctrl+W, Ctrl+Tab
  // and Ctrl+PageUp/Down belong to Chrome and cannot be intercepted by a page,
  // so the editor's own tab handling lives on Alt.
  const commands = new Commands();
  commands.add(
    { id: "file.save", title: "Save the open file", category: "file", key: "Mod+S", run: () => void save() },
    {
      id: "file.quickOpen",
      title: "Go to file…",
      category: "go",
      key: "Mod+P",
      when: () => agent.state === "online",
      run: () => void quickOpenFile(),
    },
    { id: "view.palette", title: "Show all commands", category: "view", key: "Mod+Shift+P", run: () => void commands.palette() },
    { id: "view.sidebar", title: "Toggle the side panel", category: "view", key: "Mod+B", run: () => setCollapsed(!side.collapsed) },
    { id: "view.explorer", title: "Show the explorer", category: "view", key: "Mod+Shift+E", run: () => showView("explorer") },
    {
      id: "view.search",
      title: "Search across the project",
      category: "view",
      key: "Mod+Shift+F",
      when: () => agent.state === "online",
      run: () => showView("search"),
    },
    {
      id: "view.scm",
      title: "Show source control",
      category: "view",
      key: "Mod+Shift+G",
      when: () => Boolean(agent.info?.gitVersion),
      run: () => showView("scm"),
    },
    {
      id: "view.history",
      title: "Show history",
      category: "view",
      key: "Mod+Shift+H",
      when: () => Boolean(agent.info?.gitVersion),
      run: () => showView("history"),
    },
    { id: "view.output", title: "Show the output log", category: "view", run: () => output.show() },
    {
      id: "tab.close",
      title: "Close the open tab",
      category: "file",
      key: "Alt+W",
      when: () => activeId !== null,
      run: () => void closeTab(activeId!),
    },
    { id: "tab.next", title: "Next tab", category: "go", key: "Alt+PageDown", when: () => tabs.length > 1, run: () => stepTab(1) },
    { id: "tab.prev", title: "Previous tab", category: "go", key: "Alt+PageUp", when: () => tabs.length > 1, run: () => stepTab(-1) },
    {
      id: "editor.gotoLine",
      title: "Go to line…",
      category: "go",
      key: "Mod+G",
      when: () => openFile !== null,
      run: () => void gotoLine(),
    },
    {
      id: "file.reveal",
      title: "Reveal the open file in the explorer",
      category: "go",
      when: () => openFile !== null,
      run: () => void revealOpenFile(),
    },
    { id: "tree.collapse", title: "Collapse all folders", category: "view", when: () => agent.state === "online", run: () => tree.collapseAll() },
    { id: "tree.filter", title: "Filter the explorer by name", category: "view", when: () => agent.state === "online", run: () => tree.focusFilter() },
  );

  /** Move `delta` tabs along the strip, wrapping. */
  function stepTab(delta: number): void {
    const at = tabs.findIndex((t) => t.id === activeId);
    if (at === -1) return;
    activate(tabs[(at + delta + tabs.length) % tabs.length].id);
  }

  async function gotoLine(): Promise<void> {
    const total = editor.state.doc.lines;
    const answer = await modalPrompt({ title: `Go to line (1–${total})`, placeholder: "line number", okLabel: "go" });
    const line = Number(answer);
    if (!Number.isFinite(line) || line < 1) return;
    editor.revealPosition(Math.min(line, total), 0);
  }

  async function revealOpenFile(): Promise<void> {
    if (!openFile) return;
    showView("explorer");
    await tree.reveal(openFile.path);
  }

  // ── quick open ──
  // A file list the tree does not have: it loads directories one at a time, on
  // demand, which is right for a tree and useless for "type three letters and
  // open it". So the workspace is walked once, breadth-first, and kept until
  // something on disk changes.
  //
  // The skip list is not .gitignore — the agent would have to be asked, per
  // directory, which is a protocol it does not have. These are the directories
  // that are build output or dependencies in every ecosystem this tool is
  // pointed at, and skipping them is the difference between an index that
  // takes a moment and one that walks 40k files nobody wanted to open.
  const WALK_SKIP = new Set([".git", "node_modules", "dist", "build", "out", "target", "vendor", "coverage", ".venv", "venv", "__pycache__", ".next", ".cache"]);
  const WALK_CAP = 20000;
  let fileIndex: string[] | null = null;
  let indexing: Promise<string[]> | null = null;

  function invalidateFileIndex(): void {
    fileIndex = null;
    indexing = null;
  }

  async function listFiles(): Promise<string[]> {
    if (fileIndex) return fileIndex;
    if (indexing) return indexing;
    indexing = (async () => {
      const found: string[] = [];
      const queue: string[] = [""];
      while (queue.length && found.length < WALK_CAP) {
        const dir = queue.shift()!;
        let entries: DirEntry[];
        try {
          entries = await agent.call<DirEntry[]>("fs.readdir", { path: dir });
        } catch {
          continue; // a directory that vanished mid-walk is not an error worth stopping for
        }
        for (const e of entries) {
          const path = dir ? `${dir}/${e.name}` : e.name;
          if (e.dir) {
            if (!WALK_SKIP.has(e.name)) queue.push(path);
          } else if (found.length < WALK_CAP) {
            found.push(path);
          }
        }
      }
      fileIndex = found;
      return found;
    })();
    return indexing;
  }

  /** Rank a path against what has been typed. Subsequence matching, the way
   *  every quick open works: "wcdx" finds "web/code/index.ts". */
  function score(path: string, query: string): number {
    if (!query) return 0;
    const haystack = path.toLowerCase();
    const needle = query.toLowerCase();
    const direct = haystack.lastIndexOf(needle);
    // A contiguous match wins, and one in the file name beats one in a
    // directory further up.
    if (direct !== -1) return 1000 - (haystack.length - direct);
    let at = -1;
    for (const ch of needle) {
      at = haystack.indexOf(ch, at + 1);
      if (at === -1) return -1;
    }
    return 500 - haystack.length;
  }

  async function quickOpenFile(): Promise<void> {
    const all = await listFiles();
    const truncated = all.length >= WALK_CAP;
    const path = await quickPick({
      title: "Go to file",
      hint: truncated ? `Showing the first ${WALK_CAP} files found.` : undefined,
      placeholder: "type part of a path",
      buttons: false,
      items: (query) => {
        const ranked = query
          ? all
              .map((p) => ({ p, s: score(p, query) }))
              .filter((r) => r.s >= 0)
              .sort((a, b) => b.s - a.s)
          : all.slice(0, 50).map((p) => ({ p, s: 0 }));
        return ranked.slice(0, 50).map(({ p }) => ({
          value: p,
          label: p.split("/").pop() ?? p,
          detail: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "",
          filterText: p,
        }));
      },
    });
    if (path) await open(path, false, false);
  }

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
        const file = t.kind === "file" ? t : null;
        const name = file ? (file.path.split("/").pop() ?? file.path) : (t as DiffTab).label;
        const dirty = isDirty(file);
        const cls = ["code-tab", t.id === activeId ? "active" : "", dirty ? "dirty" : "",
          t.id === previewId ? "preview" : "", file ? "" : "is-diff",
          file?.missing ? "missing" : ""]
          .filter(Boolean)
          .join(" ");
        const title = file
          ? file.missing
            ? `${file.path} — deleted on disk; the buffer is still open`
            : file.path
          : (t as DiffTab).title;
        return `<div class="${cls}" data-id="${esc(t.id)}" title="${esc(title)}">
          ${file ? "" : `<span class="code-tab-icon">⇄</span>`}
          <span class="code-tab-name">${esc(name)}</span>
          <button class="code-tab-close" type="button" title="Close">${dirty ? "●" : "✕"}</button>
        </div>`;
      })
      .join("");
  }

  function forget(tab: OpenTab): void {
    if (tab.kind !== "file") return;
    states.delete(tab.id);
    baselines.delete(tab.id);
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
    if (openFile) states.set(openFile.id, editor.state);
  }

  function activate(id: string): void {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    stashActive();
    activeId = id;

    if (tab.kind === "diff") {
      openFile = null;
      diff.show(
        tab.pair,
        tab.editablePath
          ? (text) => {
              tab.pending = text;
              renderHunkBar(tab);
            }
          : undefined,
      );
      renderHunkBar(tab);
      pathLabel.textContent = tab.title;
      updateSaveEnabled();
      dirtyLabel.textContent = "";
      dirtyLabel.classList.remove("is-dirty");
      showDiff();
      renderTabs();
      return;
    }

    const state = states.get(tab.id);
    if (!state) return;
    openFile = tab;
    swappingState = true;
    editor.state = state;
    swappingState = false;
    editorHost.classList.remove("is-empty");
    pathLabel.textContent = tab.path + (tab.readOnly ? "  (read-only)" : "") + (tab.missing ? "  (deleted on disk)" : "");
    updateSaveEnabled();
    showEditor();
    renderTabs();
    renderConflictBar();
    renderDiskConflictBar();
    onEditorChange();
    editor.focus();
  }

  async function closeTab(id: string): Promise<void> {
    const i = tabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const tab = tabs[i];
    if (tab.kind === "file") {
      if (isDirty(tab)) {
        const ok = await modalConfirm({
          title: `${tab.path} has unsaved changes. Close anyway?`,
          detail: tab.missing
            ? "This file is already gone from disk, so the buffer is the only copy of these edits."
            : "The edits are discarded; the file on disk is left as it is.",
          okLabel: "close without saving",
          danger: true,
        });
        if (!ok) return;
      }
      forget(tab);
      conflictingTabs.delete(tab.id);
      if (boundRoot) void dropDraft(boundRoot, tab.path);
    }
    // Awaiting the dialog above means the list can have moved under us.
    const at = tabs.findIndex((t) => t.id === id);
    if (at === -1) return;
    tabs.splice(at, 1);
    if (previewId === id) previewId = null;

    if (activeId !== id) return renderTabs();
    activeId = null;
    openFile = null;
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

  /** Reads in flight, by path.
   *
   *  A double click is two opens of the same file a moment apart, and the
   *  second one starts while the first is still waiting on `fs.read` — so
   *  looking only at the tabs that exist *now* let it open a second tab for a
   *  file that was already on its way. (It used to collapse by accident,
   *  because the tab id was the path.) The second caller waits for the first
   *  and then does what it came to do: pin, and take the screen. */
  const opening = new Map<string, Promise<void>>();

  async function open(path: string, reload = false, preview = false): Promise<void> {
    const already = tabForPath(path);
    if (already && !reload) {
      // Already open: a deliberate open (double click) pins whatever is there.
      if (!preview) pin(already.id);
      activate(already.id);
      return;
    }
    const inflight = opening.get(path);
    if (inflight && !reload) {
      await inflight;
      const tab = tabForPath(path);
      if (!tab) return;
      if (!preview) pin(tab.id);
      activate(tab.id);
      return;
    }
    const run = readIntoTab(path, reload, preview, already);
    opening.set(path, run);
    try {
      await run;
    } finally {
      if (opening.get(path) === run) opening.delete(path);
    }
  }

  async function readIntoTab(path: string, reload: boolean, preview: boolean, already: FileTab | undefined): Promise<void> {
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
      // A reload keeps the tab it is refreshing — its id, its place in the
      // strip and, if it is the active one, the screen.
      const tab: FileTab = already
        ? { ...already, readOnly, eol, missing: false }
        : { kind: "file", id: newTabId(), path, readOnly, eol };
      placeTab(tab, preview && !reload);
      states.set(tab.id, editor.newState(path, text, readOnly));
      baselines.set(tab.id, text);

      // A later click already won the screen. The tab still opens — nothing the
      // user asked for is dropped — it just does not steal focus.
      if (superseded) return renderTabs();
      openFile = null; // stashActive already ran; do not stash the old doc twice
      activate(tab.id);
    } catch (e) {
      reportError("agent", e);
    }
  }

  /** Open a file and put the cursor on a specific match. */
  async function openAt(path: string, line: number, col: number): Promise<void> {
    // Walking search results should not leave a tab behind for every hit.
    await open(path, false, true);
    if (openFile?.path === path) editor.revealPosition(line, col);
  }

  // ── comparison ──
  const base = (path: string): string => path.split("/").pop() ?? path;

  /** Put a diff in the tab strip, or refresh and focus the one already there.
   *  The pair is kept on the tab, so switching away to a file and back redraws
   *  it without another round trip. */
  function showDiffTab(id: string, label: string, title: string, pair: DiffPair, preview = true, editablePath?: string): void {
    // Diffs pile up the same way files do — a commit with sixty files is sixty
    // clicks — so they share the preview slot.
    placeTab({ kind: "diff", id, label, title, pair, editablePath }, preview);
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
      reportError("agent", e);
    }
  }

  async function openDiff(path: string, kind: string): Promise<void> {
    try {
      const pair = await agent.call<DiffPair>("git.diff", { path, kind });
      // "worktree" is index vs the file on disk, so the right-hand side *is*
      // the file: reverting a chunk there is a real edit that can be written
      // back. Everything else (staged, a commit) compares two recorded states.
      const editablePath = kind === "worktree" ? path : undefined;
      // `kind` is either a named diff or a commit oid, and the label has to say
      // which — otherwise every commit's diff of the same file reads the same
      // in the strip. Keyed by kind too, so each gets its own tab.
      const what = /^[0-9a-f]{7,40}$/.test(kind) ? kind.slice(0, 7) : kind;
      showDiffTab(`diff:${kind}:${path}`, `${base(path)} (${what})`, `${path}  (diff · ${what})`, pair, true, editablePath);
    } catch (e) {
      reportError("agent", e);
    }
  }

  async function save(): Promise<void> {
    const tab = openFile;
    if (!tab || tab.readOnly || !isDirty(tab)) return;

    // Writing a file the user deleted brings it back, and that is exactly the
    // surprise this used to spring: the tab still pointed at the old path, so
    // Ctrl+S recreated what had just been thrown away. Now it asks.
    if (tab.missing) {
      const ok = await modalConfirm({
        title: `${tab.path} is no longer on disk. Save it back?`,
        detail: "The file was deleted or moved after it was opened. Saving writes this buffer to that path again.",
        okLabel: "save and recreate",
      });
      if (!ok) return;
    }

    const { path, eol } = tab;
    const text = editor.value;
    try {
      await agent.call("fs.write", { path, text: eol === "\n" ? text : text.replace(/\n/g, "\r\n") });
      lastSelfWrite = Date.now();
      // What is on disk is now the baseline, so the tab stops showing dirty.
      baselines.set(tab.id, text);
      if (boundRoot) void dropDraft(boundRoot, path);
      conflictingTabs.delete(tab.id);
      tab.missing = false;
      updateSaveEnabled();
      onEditorChange();
      report("save", `saved ${path}`);
      void refreshStatus();
    } catch (e) {
      reportError("agent", e);
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
      if (!/not a git repository/i.test(String(e))) reportError("git status", e);
    }
  }

  /** A git operation moved refs or the worktree: everything derived is stale. */
  async function afterGitChange(): Promise<void> {
    await refreshStatus();
    await tree.refresh(["*"]);
    void history.refresh();
    // The open file may have been rewritten by a checkout or reset.
    if (openFile && !isDirty(openFile)) void open(openFile.path, true);
  }

  // ── agent lifecycle ──

  /** The workspace the open tabs belong to. Paths are relative to it, so tabs
   *  and drafts only mean anything while it is the folder on the other end. */
  let boundRoot: string | null = null;

  async function onOnline(): Promise<void> {
    const root = agent.info?.root ?? "";
    // The same button now covers disconnecting and switching folders, so it
    // stops claiming there is nothing connected.
    $(".js-connect").textContent = "folder…";
    rootLabel.textContent = root;
    rootLabel.title = root;
    engineLabel.textContent = agent.info?.ripgrep ? "rg" : "built-in search";
    rememberWorkspace(agent.savedUrl(), root);
    renderOfflineBar();

    // A different folder on the other end means every open path now points at
    // something else. Keeping the tabs would leave saves aimed at whatever
    // happens to sit at the same relative path over here.
    if (boundRoot !== null && boundRoot !== root) await dropTabsFromOtherRoot(boundRoot, root);
    boundRoot = root;

    await tree.load();
    await refreshStatus();
    void gitPanel.refresh();
    await agent.call("watch.start").catch(() => undefined);

    // Reconnected to the same folder: the files may have moved on without us.
    for (const tab of fileTabs()) void reconcileAfterReconnect(tab);
    void offerDrafts(root);
  }

  function onOffline(): void {
    $(".js-connect").textContent = "connect…";
    rootLabel.textContent = "not connected";
    branchLabel.textContent = "—";
    syncLabel.textContent = "";
    engineLabel.textContent = "";
    $<HTMLElement>(".js-scm-badge").hidden = true;
    tree.reset();
    diff.clear();
    conflicted.clear();
    // The tabs stay. They used to be thrown away here, along with every
    // unsaved edit in them, on nothing more than a dropped socket — an agent
    // restart, a sleeping laptop, a pulled cable. The buffers are the user
    // work; the connection is not. Saving is already disabled without an agent
    // (updateSaveEnabled), the bar below says so, and drafts.ts has a copy of
    // anything dirty in case the page itself goes too.
    renderOfflineBar();
    renderTabs();
    renderConflictBar();
    updateSaveEnabled();
  }

  /** The strip above the editor while there is no agent. */
  function renderOfflineBar(): void {
    const bar = $(".js-offline");
    const offline = agent.state !== "online";
    bar.hidden = !offline || tabs.length === 0;
    if (bar.hidden) return;
    const unsaved = fileTabs().filter((t) => isDirty(t)).length;
    bar.textContent = unsaved
      ? `Agent disconnected — ${unsaved} file${unsaved === 1 ? "" : "s"} with unsaved changes ${unsaved === 1 ? "is" : "are"} kept here and in this browser. Reconnect to save.`
      : "Agent disconnected — the open files stay as they are. Reconnect to save or reload them.";
  }

  /** Reconnected to a different folder: the old tabs describe paths that no
   *  longer mean what they say. Clean ones just go; unsaved ones are worth a
   *  question, because closing them is the one thing that loses work. */
  async function dropTabsFromOtherRoot(previous: string, next: string): Promise<void> {
    const unsaved = fileTabs().filter((t) => isDirty(t));
    if (unsaved.length) {
      const ok = await modalConfirm({
        title: `${unsaved.length} unsaved file${unsaved.length === 1 ? "" : "s"} belong${unsaved.length === 1 ? "s" : ""} to ${previous}`,
        detail: `You are now connected to ${next}. Closing them discards those edits — the drafts stay in this browser until that folder is opened again.`,
        okLabel: "close them",
        danger: true,
      });
      // Said no: the drafts are already stored, so the honest thing is to close
      // them anyway rather than pretend a tab aimed at another machine is live.
      if (!ok) report("drafts", "the edits stay as drafts for that folder");
    }
    tabs.length = 0;
    states.clear();
    baselines.clear();
    activeId = null;
    previewId = null;
    openFile = null;
    showEmptyEditor();
    renderTabs();
    showEditor();
  }

  /** One open tab, after the agent came back: is the file still there, and did
   *  it change while we were away? */
  async function reconcileAfterReconnect(tab: FileTab): Promise<void> {
    if (!isDirty(tab)) return void syncWithDisk(tab);

    const onDisk = await agent
      .call<FileRead>("fs.read", { path: tab.path })
      .then((f) => f.text?.replace(/\r\n/g, "\n") ?? null)
      .catch(() => null);

    if (onDisk === null) return markMissing(tab);
    const buffer = tab.id === openFile?.id ? editor.value : states.get(tab.id)?.doc.toString();
    if (onDisk === baselines.get(tab.id) || onDisk === buffer) return; // nothing moved under us
    conflictingTabs.add(tab.id);
    renderTabs();
    if (tab.id === openFile?.id) renderDiskConflictBar();
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
    if (!fsPaths.length) return;

    void tree.refresh(fsPaths);
    void refreshStatus();
    // Never react to the echo of the save we just performed.
    const echo = Date.now() - lastSelfWrite < 1000;
    if (echo) return;
    const touched = (path: string): boolean => fsPaths.includes(path) || fsPaths.includes("*");
    for (const tab of fileTabs()) if (touched(tab.path)) void syncWithDisk(tab);
  });

  /** A watched path under an open tab changed. Two questions, in order: is the
   *  file still there, and should the buffer be refreshed from it?
   *
   *  The first one is why this exists. A file deleted or renamed outside the
   *  app used to leave a tab that looked perfectly healthy and would write
   *  itself back to the old path on the next save. */
  async function syncWithDisk(tab: FileTab): Promise<void> {
    const exists = await agent
      .call<{ dir: boolean }>("fs.stat", { path: tab.path })
      .then(() => true)
      .catch(() => false);

    if (!exists) return markMissing(tab);
    if (tab.missing) {
      // Something put it back — a git checkout, an editor elsewhere, an undo.
      tab.missing = false;
      renderTabs();
      if (tab.id === openFile?.id) {
        pathLabel.textContent = tab.path + (tab.readOnly ? "  (read-only)" : "");
        updateSaveEnabled();
      }
    }
    // Reload only the tab on screen, and only when there is nothing to lose.
    if (tab.id === openFile?.id && !isDirty(tab)) void open(tab.path, true);
  }

  /** The file behind a tab is gone. The buffer is not: it stays open, marked,
   *  and saving it asks first (see save()). */
  function markMissing(tab: FileTab): void {
    if (tab.missing) return;
    tab.missing = true;
    renderTabs();
    if (tab.id === openFile?.id) {
      pathLabel.textContent = `${tab.path}  (deleted on disk)`;
      updateSaveEnabled();
      report("watch", `${tab.path} is gone from disk — the tab keeps your copy`, { isError: true });
    }
  }

  /** The explorer moved something. Every tab under it follows: a rename is not
   *  a new document, and the tab that was open before it should be the tab that
   *  is open after. */
  function retargetTabs(from: string, to: string): void {
    let moved = 0;
    for (const tab of fileTabs()) {
      const under = tab.path === from || tab.path.startsWith(`${from}/`);
      if (!under) continue;
      tab.path = to + tab.path.slice(from.length);
      tab.missing = false;
      moved++;
    }
    if (!moved) return;
    renderTabs();
    if (openFile) {
      pathLabel.textContent = openFile.path + (openFile.readOnly ? "  (read-only)" : "");
      updateSaveEnabled();
    }
  }

  // ── connect flow ──

  async function connectTo(url: string): Promise<void> {
    try {
      await agent.connect(url);
      report("agent", "agent connected");
    } catch (e) {
      reportError("agent", e);
    }
  }

  // ── recent workspaces ──
  // Switching between two repositories used to mean finding the right
  // `ws://127.0.0.1:5001/ws?token=…` again — a string nobody recognises on
  // sight, for a folder they know by name. So the folders that have been open
  // are remembered by name, and the URL is an implementation detail again.
  interface Recent {
    url: string;
    /** The absolute path the agent reported, which is what a person recognises. */
    root: string;
    at: number;
  }
  const RECENTS_KEY = "enc-agent-recents";
  const MAX_RECENTS = 6;

  function loadRecents(): Recent[] {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]") as Recent[];
      return Array.isArray(raw) ? raw.filter((r) => r?.url && r?.root) : [];
    } catch {
      return [];
    }
  }

  function rememberWorkspace(url: string, root: string): void {
    if (!url || !root) return;
    // Keyed by folder, not by URL: the agent prints a new token every start, and
    // six entries for one folder is not a list of recent workspaces.
    const rest = loadRecents().filter((r) => r.root !== root);
    const next = [{ url, root, at: Date.now() }, ...rest].slice(0, MAX_RECENTS);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
      /* private mode: the list is a convenience, not state anything depends on */
    }
  }

  const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

  /** The connect button opens this rather than the URL prompt: disconnecting,
   *  reopening a folder and pasting a fresh URL are three different intentions,
   *  and only the last one needs a text field. */
  function connectMenu(e: MouseEvent): void {
    const items: MenuItem[] = [];
    if (agent.state === "online") {
      const root = agent.info?.root ?? "";
      items.push({
        label: `Disconnect from ${folderName(root)}`,
        run: () => {
          agent.disconnect();
          report("agent", `disconnected from ${root || "the agent"}`);
        },
      });
    }
    for (const r of loadRecents()) {
      if (agent.state === "online" && r.root === agent.info?.root) continue;
      items.push({
        label: folderName(r.root),
        hint: ago(r.at),
        separated: items.length === (agent.state === "online" ? 1 : 0),
        run: () => void connectTo(r.url),
      });
    }
    items.push({ label: "Connect to another agent…", separated: items.length > 0, run: () => void connect() });
    showMenu(e.clientX, e.clientY, items);
  }

  /** "2h", "3d" — the same shorthand the history uses. */
  function ago(at: number): string {
    const d = Math.max(0, (Date.now() - at) / 1000);
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
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
  $(".js-connect").addEventListener("click", (e) => connectMenu(e as MouseEvent));
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
