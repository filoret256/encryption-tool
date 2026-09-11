/** Code tab: explorer, source control, history, editor and diff — wired to the
 *  local agent.
 *
 *  Loaded lazily; main.ts imports it by URL on the first switch to this tab so
 *  the grammar set never lands in the crypto tabs' bundle.
 */
import type { EditorState } from "@codemirror/state";
import { isAgentUrl, type AgentClient } from "./agent.ts";
import type { AgentInfo, Commit, CommitDetail, DiffPair, DirEntry, FileRead, FsChange, GitStatus } from "../../agent/protocol.ts";
import { CodeEditor } from "./editor.ts";
import { distinguish, FileTree } from "./tree.ts";
import { GitPanel } from "./git-panel.ts";
import { absolute as absoluteTime, HistoryPanel } from "./history.ts";
import { grammarFor, languageOf, LANGUAGES } from "./grammars.ts";
import { SearchPanel } from "./search-panel.ts";
import { DiffView, type HunkAction } from "./diff.ts";
import { hunkPatches } from "./hunkpatch.ts";
import { findConflicts } from "./conflicts.ts";
import { applyRowHeight, copyToClipboard, esc, modalConfirm, modalPrompt, showMenu, type MenuItem } from "./ui.ts";
import { draftsFor, dropDraft, putDraft } from "./drafts.ts";
import { OutputLog } from "./output.ts";
import { Commands, keyLabel } from "./commands.ts";
import { quickPick } from "./quickpick.ts";
import { compareFolders, type EntryState, type FolderEntry } from "./foldercompare.ts";
import type { BlameLine } from "./blame.ts";
import { ansible } from "../../crypto/index.ts";
import { indentOfLine, isVaultFile, schemeName, schemes, unwrapVaultBlock, vaultBlock, type Scheme } from "./vault.ts";
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
  /** Open the "get agent" popover in the header. */
  getAgent: () => void;
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
      <div class="code-tabstrip">
        <div class="code-tabs js-tabs" hidden></div>
        <button class="t-icon js-tab-list" type="button" title="All open tabs" hidden>⌄</button>
      </div>
      <nav class="code-crumbs js-crumbs" hidden aria-label="Path of the open file"></nav>
      <div class="offline-bar js-offline" hidden></div>
      <div class="compare-bar js-compare" hidden></div>
      <div class="compare-bar js-blame" hidden></div>
      <div class="compare-bar js-vault" hidden></div>
      <div class="compare-bar js-window" hidden></div>
      <div class="conflict-bar js-hunk" hidden></div>
      <div class="conflict-bar js-disk-conflict" hidden></div>
      <div class="conflict-bar js-conflict" hidden></div>
      <div class="code-editor-host"></div>
      <div class="code-welcome js-welcome" hidden></div>
      <div class="code-diff-host" hidden></div>
      <div class="code-folder-host" hidden></div>
      <div class="js-output"></div>
    </div>
  </div>
  <div class="statusbar">
    <div class="sb-item code-path">no file</div>
    <div class="sb-item code-dirty"></div>
    <div class="t-spacer"></div>
    <button class="sb-item sb-button js-sb-pos" type="button" hidden></button>
    <button class="sb-item sb-button js-sb-indent" type="button" hidden></button>
    <button class="sb-item sb-button js-sb-eol" type="button" hidden></button>
    <div class="sb-item js-sb-lang" hidden></div>
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
  const folderHost = $(".code-folder-host");

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
    /** `eol` was changed in this tab and not yet written. See isDirty. */
    eolChanged?: boolean;
    /** The file was deleted or moved away underneath us. The buffer stays; the
     *  tab says so, and saving asks before writing the file back into being. */
    missing?: boolean;
    /** Set when the tab holds a slice of a file too large to open whole.
     *
     *  What used to happen here was "// file too large to open" and nothing
     *  else — a 300 MB log could not be looked at at all. A window can: it is
     *  read-only for the obvious reason that writing a slice back would truncate
     *  everything around it, and the bar above the editor says which bytes
     *  these are and moves to the next ones. */
    window?: { offset: number; length: number; size: number; eof: boolean };
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
    /** Present on the two diffs that have an index on one side, which are the
     *  only two where staging a single change means anything: "index → working
     *  tree" stages it, "HEAD → index" takes it back out. */
    staging?: { path: string; reverse: boolean };
    /** The two workspace files this tab compares, when that is what it is.
     *  Lets the sides be swapped without picking them again. */
    comparing?: { left: string; right: string };
    /** Derived from what is being compared, so re-opening the same diff focuses
     *  the tab it is already in instead of stacking duplicates. */
    id: string;
    label: string;
    title: string;
    pair: DiffPair;
  }
  /** The result of comparing two folders — a list, not a document.
   *
   *  It is a tab rather than a panel because it is a finding worth keeping:
   *  you work through the differing files one by one, opening each pair, and
   *  every one of those lands in its own diff tab. A panel would have been
   *  replaced by the first file you opened from it. */
  interface FolderTab {
    kind: "folder";
    id: string;
    label: string;
    title: string;
    /** What is being compared. All three produce the same list of paths in the
     *  same four states; they differ in where the two sides come from and
     *  therefore in what opening a row means. */
    mode: "folders" | "head" | "commits";
    /** The left-hand folder — for "head", the folder being examined. */
    left: string;
    /** The right-hand folder; null unless the mode is "folders". */
    right: string | null;
    /** The two commits, oldest first, when the mode is "commits". */
    revs?: { from: Commit; to: Commit };
    /** What to call each side in the header. Not derived from `left`/`right`,
     *  because against HEAD the committed version is the left-hand side while
     *  the folder being examined is the right — deriving it got that backwards
     *  and labelled the working tree as the thing it was being compared to. */
    leftName: string;
    rightName: string;
    state: "running" | "done" | "failed";
    error?: string;
    entries: FolderEntry[];
    truncated: boolean;
    /** Are identical files listed? Off by default — the answer to "what is
     *  different" should not open with three hundred rows saying "same". */
    showSame: boolean;
  }
  type OpenTab = FileTab | DiffTab | FolderTab;

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
  const editor = new CodeEditor(
    editorHost,
    ctx.isDark(),
    () => void save(),
    () => {
      if (!swappingState) pin(openFile?.id ?? null);
      onEditorChange();
    },
    (oid) => void revealCommit(oid),
    () => renderStatusSegments(),
  );
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
    // The accent belongs to the thing worth pressing. On an empty screen the
    // brightest element used to be a blue "save" that saved nothing, while the
    // one route into the setup — "get agent" — was a muted chip.
    saveBtn.classList.toggle("t-btn-primary", !saveBtn.disabled);
    saveBtn.title = why || (openFile?.missing ? "Save — the file is gone from disk and will be created again" : "Save the open file");
    renderWelcome();
  }

  /** The first screen, as a sequence rather than a blank editor.
   *
   *  "Select a file in the explorer" is the wrong sentence when there is no
   *  explorer to select from and no agent to provide one — it reads as an
   *  instruction the reader has already failed to follow. What is actually
   *  needed is three steps, and this is where they belong. */
  function renderWelcome(): void {
    const el = $(".js-welcome");
    const show = agent.state !== "online" && tabs.length === 0;
    el.hidden = !show;
    editorHost.classList.toggle("is-welcome", show);
    if (!show || el.dataset.built) return;
    el.dataset.built = "1";
    el.innerHTML = `<div class="welcome">
      <h2>Open a project folder</h2>
      <p>The editor works on files on this machine. A small local agent serves one
         folder to this page over a loopback socket — nothing is uploaded.</p>
      <ol>
        <li><b>Get the agent.</b> One binary, no installer.
            <button class="t-btn js-welcome-get" type="button">get agent</button></li>
        <li><b>Run it in your project folder.</b>
            <code>enc-tool-agent</code> — it prints a <code>ws://127.0.0.1:…</code> URL.</li>
        <li><b>Paste that URL here.</b>
            <button class="t-btn t-btn-primary js-welcome-connect" type="button">connect…</button></li>
      </ol>
      <p class="welcome-note">The crypto tabs above need none of this — they run entirely in the browser.</p>
    </div>`;
    el.querySelector(".js-welcome-get")!.addEventListener("click", () => ctx.getAgent());
    el.querySelector(".js-welcome-connect")!.addEventListener("click", () => void connect());
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
    renderStatusSegments();
    diffHost.hidden = true;
    folderHost.hidden = true;
    editorHost.hidden = false;
    // The hunk bar belongs to a diff; leaving it up over the editor would offer
    // to write a file the reader is no longer looking at.
    $(".js-hunk").hidden = true;
    $(".js-tabs").hidden = tabs.length === 0;
  }
  function showDiff(): void {
    renderStatusSegments();
    editorHost.hidden = true;
    folderHost.hidden = true;
    diffHost.hidden = false;
    // The strip stays: a diff is one of the open tabs, not a takeover.
    $(".js-tabs").hidden = tabs.length === 0;
    $(".js-conflict").hidden = true;
    $(".js-disk-conflict").hidden = true;
    $(".js-blame").hidden = true;
    $(".js-vault").hidden = true;
    $(".js-window").hidden = true;
  }
  function showFolder(): void {
    renderStatusSegments();
    editorHost.hidden = true;
    diffHost.hidden = true;
    folderHost.hidden = false;
    $(".js-tabs").hidden = tabs.length === 0;
    $(".js-hunk").hidden = true;
    $(".js-conflict").hidden = true;
    $(".js-disk-conflict").hidden = true;
    $(".js-blame").hidden = true;
    $(".js-vault").hidden = true;
    $(".js-window").hidden = true;
  }

  /** Has this tab's buffer moved away from what was last read or written?
   *
   *  The tab on screen is compared against the live editor, every other one
   *  against its stashed state — the stash is only refreshed on a tab switch,
   *  so for the active tab it is always one step behind. */
  const isDirty = (tab: FileTab | null | undefined): boolean =>
    !!tab &&
    states.has(tab.id) &&
    // A line-ending change touches every line of the file without touching a
    // single character of the buffer — CodeMirror holds \n either way. It is
    // still an unsaved change, and saying otherwise would let it be closed
    // without a word.
    (tab.eolChanged === true ||
      baselines.get(tab.id) !== (tab.id === openFile?.id ? editor.value : states.get(tab.id)!.doc.toString()));

  function onEditorChange(): void {
    const dirty = isDirty(openFile);
    dirtyLabel.textContent = dirty ? "● unsaved" : "";
    dirtyLabel.classList.toggle("is-dirty", dirty);
    renderTabs();
    renderConflictBar();
    renderOfflineBar();
    // Blame describes the last commit. The moment the buffer moves away from
    // it, the bar has to say so — waiting for a tab switch to notice would
    // leave the gutter looking current while it no longer is.
    if (openFile && blaming.has(openFile.id)) renderBlameBar();
    renderVaultBar();
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
      readText: (path) => agent.call<FileRead>("fs.read", { path }).then((f) => f.text),
      writeText: (path, text) => agent.call("fs.write", { path, text }).then(() => undefined),
      // A stat that throws is the answer "no", which is the only thing the
      // caller wants to know.
      exists: (path) => agent.call("fs.stat", { path }).then(() => true).catch(() => false),
      // Without git there is nothing to ask, and an explorer that cannot ask
      // must not guess — so this answers "none of them" rather than dimming.
      checkIgnore: (paths) =>
        agent.info?.gitVersion ? agent.call<string[]>("git.checkIgnore", { paths }) : Promise.resolve([]),
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
      compareFolders: (left, right) => void compareFolderTree(left, right),
      onCompareBase: (path, isDir) => renderCompareBar(path, isDir),
      compareWithHead: (path) => void openDiff(path, "head"),
      compareFolderWithHead: (path) => void compareFolderWithHead(path),
      fileHistory: (path) => showFileHistory(path),
      blame: (path) => void blameFile(path),
      searchIn: (path) => {
        showView("search");
        searchPanel.searchFor("", `${path}/**`);
      },
      crypto: (path, direction) =>
        void open(path, false, false).then(() => {
          // The operation works on the buffer, so the file has to be in one.
          if (openFile?.path === path) return cryptoWholeFile(direction);
        }),
    },
  );

  const gitPanel = new GitPanel(host.querySelector<HTMLElement>('[data-pane="scm"]')!, agent, {
    openDiff: (path, kind) => void openDiff(path, kind),
    openFile: (path) => void open(path),
    toast: panelReport,
    afterChange: () => void afterGitChange(),
  });

  const history = new HistoryPanel(host.querySelector<HTMLElement>('[data-pane="history"]')!, agent, {
    openDiff: (path, kind, about) => void openDiff(path, kind, about),
    compareCommits: (a, b) => void compareCommits(a, b),
    toast: panelReport,
    afterChange: () => void afterGitChange(),
  });

  const searchPanel = new SearchPanel(host.querySelector<HTMLElement>('[data-pane="search"]')!, agent, {
    openAt: (path, line, col) => void openAt(path, line, col),
    toast: panelReport,
    report: (summary, detail) => report("replace", summary, { detail }),
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

  /** The one rule about how wide the panel may be.
   *
   *  It used to live only inside the drag handler, so a width chosen on a
   *  1440px monitor was restored verbatim on a 760px laptop: the panel took
   *  more than half the window and the editor became the gutter. The stored
   *  number is a preference, not a measurement — it has to be read against the
   *  window it is being applied to. */
  const clampWidth = (w: number): number => Math.round(Math.min(Math.max(w, 150), window.innerWidth * 0.6));

  function applySide(): void {
    // Not written back to storage: narrowing the window for an hour should not
    // lose the width the user picked for their monitor.
    sideEl.style.width = `${clampWidth(side.width)}px`;
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

  /** Below this the two columns of a side-by-side diff are about fifty
   *  characters between them — two narrow ribbons of clipped text. Inline is
   *  the readable shape at that width, so the view switches to it and says so
   *  in the mode button rather than leaving the reader to work it out. */
  const NARROW = 820;

  const onViewportChange = (): void => {
    applySide();
    diff.setNarrow(window.innerWidth < NARROW);
  };
  onViewportChange();
  window.addEventListener("resize", onViewportChange);

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
    {
      id: "tree.undo",
      title: "Undo the last file move or creation",
      category: "file",
      when: () => agent.state === "online",
      run: () => void tree.undoLast(),
    },
    { id: "tree.filter", title: "Filter the explorer by name", category: "view", when: () => agent.state === "online", run: () => tree.focusFilter() },
    {
      id: "compare.select",
      title: "Mark the open file for comparison",
      category: "go",
      when: () => openFile !== null,
      run: () => tree.setCompareBase(openFile!.path),
    },
    {
      id: "compare.with",
      title: "Compare the open file with…",
      category: "go",
      when: () => openFile !== null && agent.state === "online",
      run: () => void pickCompareTarget(openFile!.path),
    },
    {
      id: "search.next",
      title: "Next search result",
      category: "go",
      key: "F4",
      when: () => agent.state === "online",
      run: () => searchPanel.step(1),
    },
    {
      id: "search.prev",
      title: "Previous search result",
      category: "go",
      key: "Shift+F4",
      when: () => agent.state === "online",
      run: () => searchPanel.step(-1),
    },
    {
      id: "crypto.encryptFile",
      title: "Encrypt the open file…",
      category: "file",
      when: () => openFile !== null,
      run: () => void cryptoWholeFile("encrypt"),
    },
    {
      id: "crypto.decryptFile",
      title: "Decrypt the open file…",
      category: "file",
      when: () => openFile !== null,
      run: () => void cryptoWholeFile("decrypt"),
    },
    {
      id: "crypto.encryptSelection",
      title: "Encrypt the selection as !vault…",
      category: "file",
      when: () => openFile !== null,
      run: () => void encryptSelection(),
    },
    {
      id: "crypto.decryptSelection",
      title: "Decrypt the selected !vault block…",
      category: "file",
      when: () => openFile !== null,
      run: () => void decryptSelection(),
    },
    {
      id: "git.blame",
      title: "Blame the open file",
      category: "go",
      when: () => openFile !== null && agent.state === "online",
      run: () => void toggleBlame(),
    },
    {
      id: "git.fileHistory",
      title: "History of the open file",
      category: "go",
      when: () => openFile !== null && agent.state === "online",
      run: () => showFileHistory(openFile!.path),
    },
    {
      id: "compare.folders",
      title: "Compare two folders…",
      category: "go",
      when: () => agent.state === "online",
      run: () => void pickFolderPair(),
    },
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
    saveSession();
    for (const p of host.querySelectorAll<HTMLElement>(".side-view")) {
      p.classList.toggle("active", p.dataset.pane === view);
    }
    if (view === "search") searchPanel.focus();
    if (view === "scm") void gitPanel.refresh();
    if (view === "history") void history.refresh();
  }

  // ── tabs ──
  /** The path of the open file, one clickable segment per folder.
   *
   *  The tab says `main.yml`; a repository with four roles has four of those.
   *  The status bar carries the full path but it is a line of grey text at the
   *  bottom of the window, and nothing in it is a target — so "where am I" and
   *  "show me that folder" were two different problems with no answer here. */
  function renderCrumbs(): void {
    const nav = $(".js-crumbs");
    const tab = openFile;
    nav.hidden = !tab;
    if (!tab) return;
    const parts = tab.path.split("/");
    nav.innerHTML = parts
      .map((seg, i) => {
        const path = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return `<button class="crumb${last ? " is-file" : ""}" type="button" data-path="${esc(path)}"
          data-dir="${last ? "" : "1"}" title="${esc(path)}">${esc(seg)}</button>`;
      })
      .join(`<span class="crumb-sep" aria-hidden="true">›</span>`);
    for (const el of nav.querySelectorAll<HTMLElement>(".crumb")) {
      el.addEventListener("click", () => {
        const path = el.dataset.path!;
        // A folder reveals itself in the explorer; the file itself offers the
        // other files beside it, which is the question a breadcrumb's last
        // segment is asked in every editor that has one.
        if (el.dataset.dir) void revealInTree(path);
        else void siblingsMenu(el, path);
      });
    }
  }

  /** The files next to this one, from the breadcrumb. */
  async function siblingsMenu(anchor: HTMLElement, path: string): Promise<void> {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    let entries: DirEntry[];
    try {
      entries = await agent.call<DirEntry[]>("fs.readdir", { path: dir });
    } catch (e) {
      return reportError("explorer", e);
    }
    const r = anchor.getBoundingClientRect();
    showMenu(
      r.left,
      r.bottom,
      entries
        .filter((e) => !e.dir)
        .slice(0, 40)
        .map((e) => ({
          label: e.name,
          run: () => void open(dir ? `${dir}/${e.name}` : e.name, false, true),
        })),
    );
  }

  function renderTabs(): void {
    saveSession();
    const bar = $(".js-tabs");
    bar.hidden = tabs.length === 0;
    bar.innerHTML = tabs
      .map((t) => {
        const file = t.kind === "file" ? t : null;
        const name = t.kind === "file" ? (t.path.split("/").pop() ?? t.path) : t.label;
        const dirty = isDirty(file);
        const cls = ["code-tab", t.id === activeId ? "active" : "", dirty ? "dirty" : "",
          t.id === previewId ? "preview" : "", file ? "" : "is-diff",
          file?.missing ? "missing" : ""]
          .filter(Boolean)
          .join(" ");
        const title = t.kind === "file"
          ? t.missing
            ? `${t.path} — deleted on disk; the buffer is still open`
            : t.path
          : t.title;
        return `<div class="${cls}" draggable="true" data-id="${esc(t.id)}" title="${esc(title)}">
          ${file ? "" : `<span class="code-tab-icon">${t.kind === "folder" ? "🗀" : "⇄"}</span>`}
          <span class="code-tab-name">${esc(name)}</span>
          <button class="code-tab-close" type="button" title="Close">${dirty ? "●" : "✕"}</button>
        </div>`;
      })
      .join("");
    // The overflow button appears only when the strip actually cannot show
    // everything, which is the moment it stops being possible to find a tab by
    // looking at it.
    const overflow = $<HTMLButtonElement>(".js-tab-list");
    overflow.hidden = tabs.length === 0 || bar.scrollWidth <= bar.clientWidth + 1;
    renderCrumbs();
  }

  /** Anything that changes the strip, the tree or the view writes the session
   *  back — debounced, so a burst of openings is one write. */
  function forget(tab: OpenTab): void {
    if (tab.kind !== "file") return;
    states.delete(tab.id);
    baselines.delete(tab.id);
    blaming.delete(tab.id);
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

    if (tab.kind === "folder") {
      openFile = null;
      renderFolderTab(tab);
      pathLabel.textContent = tab.title;
      updateSaveEnabled();
      dirtyLabel.textContent = "";
      dirtyLabel.classList.remove("is-dirty");
      showFolder();
      renderTabs();
      return;
    }

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
        tab.comparing ? () => void swapCompare(tab) : undefined,
        hunkActionFor(tab),
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
    renderBlameBar();
    renderVaultBar();
    renderWindowBar();
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

  // A strip with a dozen tabs on it needs the same bulk actions every editor
  // has, and "why is this one in italics" needs answering somewhere other than
  // the source.
  $(".js-tabs").addEventListener("contextmenu", (e) => {
    const ev = e as MouseEvent;
    const id = (ev.target as HTMLElement).closest<HTMLElement>(".code-tab")?.dataset.id;
    if (!id) return;
    ev.preventDefault();
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    const others = tabs.filter((t) => t.id !== id);
    const saved = tabs.filter((t) => t.kind !== "file" || !isDirty(t));

    const items: MenuItem[] = [
      { label: "Close", hint: keyLabel("Alt+W"), run: () => void closeTab(id) },
      { label: `Close others (${others.length})`, run: () => void closeMany(others.map((t) => t.id)) },
      { label: `Close saved (${saved.length})`, run: () => void closeMany(saved.map((t) => t.id)) },
      { label: "Close all", run: () => void closeMany(tabs.map((t) => t.id)) },
    ];
    if (tab.kind === "file") {
      items.push(
        { label: "Copy path", separated: true, run: () => void copyToClipboard(tab.path, "Path", (m, isError) => report("editor", m, { isError })) },
        { label: "Reveal in explorer", run: () => void revealInTree(tab.path) },
        { label: "File history", run: () => showFileHistory(tab.path) },
      );
    }
    if (id === previewId) {
      // The italic has meant "this slot gets reused" since the first version
      // and said so nowhere. Now the menu says it, and offers the way out.
      items.push({ label: "Keep this tab open (it is a preview)", separated: true, run: () => pin(id) });
    }
    showMenu(ev.clientX, ev.clientY, items);
  });

  // Every open tab, by name, when the strip has run out of room.
  $(".js-tab-list").addEventListener("click", (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(
      Math.max(4, r.right - 240),
      r.bottom,
      tabs.map((t) => ({
        label:
          (t.id === activeId ? "✓ " : "   ") +
          (t.kind === "file" ? t.path : t.title) +
          (t.kind === "file" && isDirty(t) ? " ●" : ""),
        run: () => activate(t.id),
      })),
    );
  });

  // Dragging tabs into the order you want them. The strip is the one place
  // where position carries meaning the tool does not assign.
  let dragTab: string | null = null;
  $(".js-tabs").addEventListener("dragstart", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".code-tab");
    if (!el) return;
    dragTab = el.dataset.id ?? null;
    (e as DragEvent).dataTransfer?.setData("text/plain", dragTab ?? "");
  });
  $(".js-tabs").addEventListener("dragover", (e) => {
    if (!dragTab) return;
    e.preventDefault();
    const over = (e.target as HTMLElement).closest<HTMLElement>(".code-tab");
    for (const el of host.querySelectorAll<HTMLElement>(".code-tab")) {
      el.classList.toggle("drop-before", el === over && el.dataset.id !== dragTab);
    }
  });
  $(".js-tabs").addEventListener("drop", (e) => {
    e.preventDefault();
    const over = (e.target as HTMLElement).closest<HTMLElement>(".code-tab")?.dataset.id;
    const from = tabs.findIndex((t) => t.id === dragTab);
    const to = tabs.findIndex((t) => t.id === over);
    dragTab = null;
    for (const el of host.querySelectorAll<HTMLElement>(".code-tab")) el.classList.remove("drop-before");
    if (from === -1 || to === -1 || from === to) return;
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    renderTabs();
  });
  $(".js-tabs").addEventListener("dragend", () => {
    dragTab = null;
    for (const el of host.querySelectorAll<HTMLElement>(".code-tab")) el.classList.remove("drop-before");
  });

  /** Close a list of tabs, oldest first, asking once per unsaved buffer. */
  async function closeMany(ids: string[]): Promise<void> {
    for (const id of ids) await closeTab(id);
  }

  async function revealInTree(path: string): Promise<void> {
    showView("explorer");
    await tree.reveal(path);
  }

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

  /** How much of an oversized file to fetch at a time.
   *
   *  A megabyte is roughly ten thousand lines of log — enough that paging is
   *  rare, small enough that the round trip and the editor both stay quick. */
  const WINDOW_BYTES = 1024 * 1024;

  async function readIntoTab(path: string, reload: boolean, preview: boolean, already: FileTab | undefined): Promise<void> {
    const seq = ++openSeq;
    try {
      let file = await agent.call<FileRead>("fs.read", { path });
      // Too large to open whole is not the same as impossible to read: ask for
      // the first window instead of showing a placeholder.
      let window: FileTab["window"];
      if (file.tooLarge) {
        const slice = await agent
          .call<FileRead>("fs.read", { path, offset: 0, length: WINDOW_BYTES })
          .catch(() => null);
        if (slice?.text !== null && slice !== null) {
          file = slice;
          window = { offset: slice.offset, length: WINDOW_BYTES, size: slice.size, eof: slice.eof };
        }
      }
      // A window is read-only for the same reason a binary file is: what is on
      // screen is not the whole document, and writing it back would be a
      // truncation rather than a save.
      const readOnly = file.binary || file.tooLarge || window !== undefined;
      const raw = file.text ?? (file.binary ? "// binary file" : "// file too large to open");
      const eol: "\n" | "\r\n" = raw.includes("\r\n") ? "\r\n" : "\n";
      // Compare against the normalised text, since that is what the editor holds.
      const text = raw.replace(/\r\n/g, "\n");

      const superseded = seq !== openSeq;
      if (!superseded) stashActive();
      // A reload keeps the tab it is refreshing — its id, its place in the
      // strip and, if it is the active one, the screen.
      const tab: FileTab = already
        ? { ...already, readOnly, eol, missing: false, window }
        : { kind: "file", id: newTabId(), path, readOnly, eol, window };
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
  function showDiffTab(
    id: string,
    label: string,
    title: string,
    pair: DiffPair,
    preview = true,
    editablePath?: string,
    comparing?: { left: string; right: string },
    staging?: { path: string; reverse: boolean },
  ): void {
    // Diffs pile up the same way files do — a commit with sixty files is sixty
    // clicks — so they share the preview slot.
    placeTab({ kind: "diff", id, label, title, pair, editablePath, comparing, staging }, preview);
    activate(id);
  }

  /** "Stage this change" for a diff that has an index on one side.
   *
   *  The patch is built in the browser from the two sides already on screen —
   *  see hunkpatch.ts — and applied with `git apply --cached`, which is the
   *  only way git offers to move part of a file into the index. The worktree is
   *  never touched either way, so an open buffer of the same file does not move
   *  under the person reading it.
   */
  function hunkActionFor(tab: DiffTab): HunkAction | undefined {
    if (!tab.staging) return undefined;
    const { path, reverse } = tab.staging;
    return {
      label: reverse ? "unstage" : "stage",
      apply: async (index) => {
        const patches = hunkPatches(path, tab.pair.before ?? "", tab.pair.after ?? "");
        const patch = patches[index];
        if (!patch) return reportError("stage", new Error("That change is no longer in the diff — reopen it."));
        try {
          await agent.call("git.applyPatch", { patch, reverse });
          report("git", `${reverse ? "unstaged" : "staged"} change ${index + 1} of ${path}`);
          // Both sides moved: the index is what changed, and it is one side of
          // this very diff. Re-reading it is what keeps the count honest.
          const fresh = await agent.call<DiffPair>("git.diff", { path, kind: reverse ? "staged" : "worktree" });
          tab.pair = fresh;
          if (activeId === tab.id) diff.show(fresh, undefined, undefined, hunkActionFor(tab));
          void refreshStatus();
          void gitPanel.refresh();
        } catch (e) {
          reportError("git.applyPatch", e);
        }
      },
    };
  }

  /** The bar that says what is marked for comparison.
   *
   *  "Select for compare" used to change nothing anyone could see: the row
   *  looked the same, the status bar said "no file", and the only way to find
   *  out what was marked was to open the menu on the file you suspected. So
   *  the mark now has a place on screen, with the path spelled out and a way
   *  to drop it.
   */
  function renderCompareBar(path: string | null, isDir = false): void {
    const bar = $(".js-compare");
    bar.hidden = path === null;
    if (path === null) return;
    bar.innerHTML = `<span class="compare-label">compare ${isDir ? "folder" : ""} with</span>
      <span class="compare-path" title="${esc(path)}">${esc(path)}</span>
      <span class="t-spacer"></span>
      <button class="t-btn js-compare-open" type="button">pick the other ${isDir ? "folder" : "file"}…</button>
      <button class="t-icon js-compare-clear" type="button" aria-label="Clear the comparison mark">✕</button>`;
    bar.querySelector(".js-compare-open")!.addEventListener("click", () => void pickCompareTarget(path, isDir));
    bar.querySelector(".js-compare-clear")!.addEventListener("click", () => tree.setCompareBase(null));
  }

  /** The second half of the pair, chosen from a list rather than by hunting
   *  through the tree for the file you meant. */
  async function pickCompareTarget(left: string, isDir = false): Promise<void> {
    const files = await listFiles();
    // The walk indexes files, so the folder list is what their paths imply —
    // which is also exactly the set of folders that have anything in them.
    const all = isDir
      ? [...new Set(files.flatMap((p) => {
          const parts = p.split("/").slice(0, -1);
          return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
        }))].sort()
      : files;
    const other = await quickPick({
      title: `Compare ${left} with`,
      placeholder: `type part of a ${isDir ? "folder" : "path"}`,
      buttons: false,
      items: (query) =>
        all
          .filter((p) => p !== left && (!query || p.toLowerCase().includes(query.toLowerCase())))
          .slice(0, 50)
          .map((p) => ({ value: p, label: p.split("/").pop() ?? p, detail: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "", filterText: p })),
    });
    if (!other) return;
    if (isDir) await compareFolderTree(left, other);
    else await compare(left, other);
  }

  /** Diff two arbitrary files in the workspace — no git involved. */
  async function compare(left: string, right: string): Promise<void> {
    try {
      const [a, b] = await Promise.all([
        agent.call<FileRead>("fs.read", { path: left }),
        agent.call<FileRead>("fs.read", { path: right }),
      ]);
      // The tab is named by what tells the two apart — `prod/values.yaml ↔
      // stage/values.yaml`, not `values.yaml ↔ values.yaml`, which is what two
      // open comparisons used to look like in the strip.
      const label = `${distinguish(left, right)} ↔ ${distinguish(right, left)}`;
      showDiffTab(
        `cmp:${JSON.stringify([left, right])}`,
        label,
        `${left} ↔ ${right}`,
        {
          path: `${left} ↔ ${right}`,
          before: a.text,
          after: b.text,
          beforeLabel: left,
          afterLabel: right,
          binary: a.binary || b.binary,
        },
        // Not a preview. A comparison took two deliberate steps to set up, and
        // the preview slot is for clicking through a list — the next diff used
        // to take its place and there was no way back to it.
        false,
        undefined,
        { left, right },
      );
      // The pair is made; keeping the mark would offer to compare against it
      // again for the rest of the session, which is how it came to point at
      // files from workspaces nobody had open any more.
      tree.setCompareBase(null);
    } catch (e) {
      reportError("agent", e);
    }
  }

  /** Show the same two files the other way round. */
  async function swapCompare(tab: DiffTab): Promise<void> {
    if (!tab.comparing) return;
    await compare(tab.comparing.right, tab.comparing.left);
  }

  /** Both halves of a folder comparison, for people who came from the palette
   *  rather than from a right-click in the tree. */
  async function pickFolderPair(): Promise<void> {
    const files = await listFiles();
    const folders = [...new Set(files.flatMap((p) => {
      const parts = p.split("/").slice(0, -1);
      return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    }))].sort();
    const left = await quickPick({
      title: "Compare folders — the first one",
      placeholder: "type part of a folder",
      buttons: false,
      items: (query) =>
        folders
          .filter((p) => !query || p.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 50)
          .map((p) => ({ value: p, label: p.split("/").pop() ?? p, detail: p, filterText: p })),
    });
    if (left) await pickCompareTarget(left, true);
  }

  // ── encryption, in the editor ──
  // The two halves of this product used to be two tabs that had never been
  // introduced. Encrypting the file you were looking at went through the
  // clipboard in nine steps; encrypting one *value* inside a YAML file — which
  // is what people actually do — was not possible at all.
  //
  // Nothing is written to disk here: the buffer changes and Ctrl+S is still the
  // thing that writes. That keeps one rule about when a file is touched, and it
  // means an encryption you did not mean is one Ctrl+Z away.

  /** Ask for a password for one operation. Never stored, anywhere. */
  async function askPassword(title: string, confirm: boolean): Promise<string | null> {
    return modalPrompt({
      title,
      password: true,
      confirm,
      placeholder: "vault password",
      okLabel: confirm ? "encrypt" : "decrypt",
      hint: confirm
        ? "Typed twice because nothing checks it: a mistyped password produces a file that cannot be opened again."
        : "The password is used for this operation and not kept.",
    });
  }

  /** Which of the two schemes, when the text does not say. */
  async function askScheme(): Promise<Scheme | null> {
    const pick = await quickPick({
      title: "Encrypt with",
      placeholder: "",
      buttons: false,
      items: [
        { value: "ansible", label: "Ansible Vault", detail: "$ANSIBLE_VAULT;1.1;AES256 — reads with the ansible-vault CLI" },
        { value: "helm", label: "helm-encrypt", detail: "this tool's own AES-256-CBC envelope" },
      ],
    });
    return (pick as Scheme | null) ?? null;
  }

  /** Encrypt or decrypt the whole open buffer. */
  async function cryptoWholeFile(direction: "encrypt" | "decrypt"): Promise<void> {
    const tab = openFile;
    if (!tab) return;
    const text = editor.value;
    if (!text.trim()) return report("crypto", "Nothing to encrypt — the file is empty.", { isError: true });

    // A file that already carries the header answers the scheme question by
    // itself, which is one fewer thing to get wrong when decrypting.
    const scheme: Scheme | null =
      direction === "decrypt" && isVaultFile(text) ? "ansible" : await askScheme();
    if (!scheme) return;
    const password = await askPassword(
      `${direction === "encrypt" ? "Encrypt" : "Decrypt"} ${tab.path} with ${schemeName[scheme]}`,
      direction === "encrypt",
    );
    if (!password) return;

    try {
      const out = await schemes[scheme][direction](text.trim(), password);
      editor.replaceAll(direction === "encrypt" ? `${out}\n` : out);
      report("crypto", `${tab.path} ${direction}ed with ${schemeName[scheme]} — not saved yet (Ctrl+S), and Ctrl+Z puts it back`);
    } catch (e) {
      reportError("crypto", e);
    }
  }

  /** `ansible-vault encrypt_string`, on the selection.
   *
   *  The common shape in real repositories: one secret inside a file that stays
   *  readable. The envelope is indented under a `!vault |` tag so the YAML
   *  parser reads it back as a single scalar. */
  async function encryptSelection(): Promise<void> {
    const tab = openFile;
    if (!tab) return;
    const { state } = editor.view;
    const sel = state.selection.main;
    if (sel.empty) {
      return report("crypto", "Select the value to encrypt first.", { isError: true });
    }
    const value = state.sliceDoc(sel.from, sel.to);
    const password = await askPassword(`Encrypt the selection as !vault`, true);
    if (!password) return;
    try {
      const envelope = await ansible.encrypt(value.trim(), password);
      const line = state.doc.lineAt(sel.from);
      const block = vaultBlock(envelope, indentOfLine(line.text));
      editor.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: block } });
      report("crypto", `selection encrypted as !vault — not saved yet (Ctrl+S), and Ctrl+Z puts it back`);
    } catch (e) {
      reportError("crypto", e);
    }
  }

  /** The reverse: a `!vault |` block back to its plain value. */
  async function decryptSelection(): Promise<void> {
    const tab = openFile;
    if (!tab) return;
    const { state } = editor.view;
    const sel = state.selection.main;
    if (sel.empty) return report("crypto", "Select the !vault block to decrypt first.", { isError: true });
    const chunk = state.sliceDoc(sel.from, sel.to);
    const envelope = unwrapVaultBlock(chunk) ?? (isVaultFile(chunk) ? chunk.trim() : null);
    if (!envelope) {
      return report("crypto", "That selection is not a !vault block or a vault envelope.", { isError: true });
    }
    const password = await askPassword("Decrypt the selected !vault block", false);
    if (!password) return;
    try {
      const plain = await ansible.decrypt(envelope, password);
      editor.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: plain } });
      report("crypto", "selection decrypted — not saved yet (Ctrl+S), and Ctrl+Z puts it back");
    } catch (e) {
      reportError("crypto", e);
    }
  }

  /** The bar offering to decrypt a file that turned out to be a vault.
   *
   *  Opening `group_vars/prod/vault.yml` used to fill the editor with eighty
   *  lines of hex and leave the reader to work out what it was. */
  function renderVaultBar(): void {
    const bar = $(".js-vault");
    const tab = openFile;
    const encrypted = tab !== null && !isDirty(tab) && isVaultFile(editor.value);
    bar.hidden = !encrypted;
    if (!encrypted) return;
    bar.innerHTML = `<span class="compare-label">ansible vault</span>
      <span class="compare-path">this file is encrypted</span>
      <span class="t-spacer"></span>
      <button class="t-btn js-vault-decrypt" type="button">decrypt…</button>`;
    bar.querySelector(".js-vault-decrypt")!.addEventListener("click", () => void cryptoWholeFile("decrypt"));
  }

  const bytes = (n: number): string =>
    n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB`
    : `${n} bytes`;

  /** The bar over a file being read a window at a time.
   *
   *  It has to say two things at once: that this is not the whole file — so
   *  nobody reads the last line on screen as the last line of the log — and how
   *  to get to the rest of it. */
  function renderWindowBar(): void {
    const bar = $(".js-window");
    const tab = openFile;
    const w = tab?.window;
    bar.hidden = !w;
    if (!tab || !w) return;
    const from = w.offset;
    const to = Math.min(w.offset + w.length, w.size);
    bar.innerHTML = `<span class="compare-label">large file</span>
      <span class="compare-path">showing ${bytes(from)}–${bytes(to)} of ${bytes(w.size)}, read-only</span>
      <span class="t-spacer"></span>
      <button class="t-btn js-win-start" type="button" title="Jump to the start">⇤ start</button>
      <button class="t-btn js-win-prev" type="button">◀ earlier</button>
      <button class="t-btn js-win-next" type="button">later ▶</button>
      <button class="t-btn js-win-end" type="button" title="Jump to the end">end ⇥</button>`;
    const at = (offset: number): void => void readWindow(tab, offset);
    bar.querySelector<HTMLButtonElement>(".js-win-start")!.disabled = from === 0;
    bar.querySelector<HTMLButtonElement>(".js-win-prev")!.disabled = from === 0;
    bar.querySelector<HTMLButtonElement>(".js-win-next")!.disabled = w.eof;
    bar.querySelector<HTMLButtonElement>(".js-win-end")!.disabled = w.eof;
    bar.querySelector(".js-win-start")!.addEventListener("click", () => at(0));
    bar.querySelector(".js-win-prev")!.addEventListener("click", () => at(Math.max(0, from - w.length)));
    // From where this window ends, not from where it was asked to start: the
    // agent may have moved the start forward off a half character.
    bar.querySelector(".js-win-next")!.addEventListener("click", () => at(to));
    bar.querySelector(".js-win-end")!.addEventListener("click", () => at(Math.max(0, w.size - w.length)));
  }

  /** Move a large file's window and redraw the buffer under it. */
  async function readWindow(tab: FileTab, offset: number): Promise<void> {
    try {
      const slice = await agent.call<FileRead>("fs.read", { path: tab.path, offset, length: WINDOW_BYTES });
      tab.window = { offset: slice.offset, length: WINDOW_BYTES, size: slice.size, eof: slice.eof };
      const text = (slice.text ?? "").replace(/\r\n/g, "\n");
      states.set(tab.id, editor.newState(tab.path, text, true));
      baselines.set(tab.id, text);
      if (activeId === tab.id) {
        editor.state = states.get(tab.id)!;
        editor.focus();
      }
      renderWindowBar();
    } catch (e) {
      reportError("fs.read", e);
    }
  }

  // ── the status bar's document segments ──
  // What someone editing a stranger's file in a mixed repository looks for:
  // where the cursor is, what the line endings are, what the indentation is,
  // and what the thing is being highlighted as. All four were absent, and the
  // first three are settings this tab already tracks — they were simply never
  // shown, so there was nowhere to change them either.

  /** Language forced by the reader, per tab id. Not persisted: it is a decision
   *  about one look at one file, and a file whose extension says `.yaml` should
   *  not open as Python tomorrow because it once was. */
  const forcedLanguage = new Map<string, string>();

  /** Leading whitespace, as the file actually uses it.
   *
   *  Guessed, and labelled as a guess by being derived rather than configured:
   *  the smallest indent step that appears more than once is what an editor can
   *  honestly say about a file it did not write. */
  function detectIndent(text: string): { kind: "tab" | "space"; width: number } {
    let tabs = 0;
    const widths = new Map<number, number>();
    let previous = 0;
    for (const line of text.split("\n", 4000)) {
      const lead = /^[ \t]*/.exec(line)![0];
      if (!lead || !line.slice(lead.length)) continue; // blank lines say nothing
      if (lead.includes("\t")) {
        tabs++;
        continue;
      }
      const step = lead.length - previous;
      if (step > 0) widths.set(step, (widths.get(step) ?? 0) + 1);
      previous = lead.length;
    }
    let best = 0;
    let bestCount = 0;
    for (const [w, c] of widths) {
      if (c > bestCount || (c === bestCount && w < best)) {
        best = w;
        bestCount = c;
      }
    }
    if (tabs > bestCount) return { kind: "tab", width: 1 };
    return { kind: "space", width: best || 2 };
  }

  function renderStatusSegments(): void {
    const pos = $<HTMLButtonElement>(".js-sb-pos");
    const eolEl = $<HTMLButtonElement>(".js-sb-eol");
    const indentEl = $<HTMLButtonElement>(".js-sb-indent");
    const langEl = $<HTMLElement>(".js-sb-lang");
    const tab = openFile;
    for (const el of [pos, eolEl, indentEl, langEl]) el.hidden = tab === null;
    if (!tab) return;

    const { line, col, selected } = editor.cursor;
    pos.textContent = selected ? `Ln ${line}, Col ${col} (${selected} selected)` : `Ln ${line}, Col ${col}`;
    pos.title = "Go to line (Ctrl+G)";

    eolEl.textContent = tab.eol === "\r\n" ? "CRLF" : "LF";
    eolEl.title = `Line endings — click to write this file with ${tab.eol === "\r\n" ? "LF" : "CRLF"} instead`;

    const indent = detectIndent(editor.value);
    indentEl.textContent = indent.kind === "tab" ? "Tab" : `Spaces: ${indent.width}`;
    indentEl.title = "Indentation, as this file uses it — click to convert it";

    const forced = forcedLanguage.get(tab.id);
    langEl.textContent = forced ?? languageOf(tab.path);
    langEl.title = forced ? `Highlighting as ${forced} (chosen for this tab)` : "Syntax highlighting — click to change it";
    langEl.classList.toggle("is-forced", forced !== undefined);
  }

  /** Rewrite the buffer's line endings. Marks it dirty rather than writing:
   *  changing every line of a file is an edit, and it goes through Ctrl+S like
   *  any other. */
  function switchEol(): void {
    const tab = openFile;
    if (!tab) return;
    tab.eol = tab.eol === "\r\n" ? "\n" : "\r\n";
    // Nothing in the buffer changes: CodeMirror holds LF either way, and the
    // tab's eol is only consulted on write. isDirty is told separately, so the
    // change is visible and closing the tab still asks about it.
    tab.eolChanged = !tab.eolChanged;
    onEditorChange();
    renderStatusSegments();
    report("editor", `${tab.path} will be saved with ${tab.eol === "\r\n" ? "CRLF" : "LF"} line endings`);
  }

  /** Convert leading whitespace throughout the buffer. */
  async function convertIndent(): Promise<void> {
    const tab = openFile;
    if (!tab) return;
    const current = detectIndent(editor.value);
    const choice = await quickPick({
      title: `Indentation — this file uses ${current.kind === "tab" ? "tabs" : `${current.width} spaces`}`,
      placeholder: "convert the whole file to",
      buttons: false,
      items: [
        { value: "tab", label: "Tabs", detail: "one tab per level" },
        { value: "2", label: "Spaces: 2" },
        { value: "4", label: "Spaces: 4" },
        { value: "8", label: "Spaces: 8" },
      ],
    });
    if (!choice) return;
    const unit = choice === "tab" ? "\t" : " ".repeat(Number(choice));
    const converted = editor.value
      .split("\n")
      .map((l) => {
        const lead = /^[ \t]*/.exec(l)![0];
        if (!lead) return l;
        // Count levels in the file's own terms, then re-emit them in the new
        // unit. Anything that is not a whole number of levels is left as it is:
        // a continuation line aligned under an opening bracket is deliberate.
        const levels = current.kind === "tab" ? lead.replace(/ /g, "").length : lead.length / current.width;
        if (!Number.isInteger(levels)) return l;
        return unit.repeat(levels) + l.slice(lead.length);
      })
      .join("\n");
    if (converted === editor.value) return report("editor", "Indentation is already that.");
    editor.replaceAll(converted);
    renderStatusSegments();
  }

  async function pickLanguage(): Promise<void> {
    const tab = openFile;
    if (!tab) return;
    const choice = await quickPick({
      title: "Syntax highlighting for this tab",
      placeholder: "type a language",
      buttons: false,
      items: LANGUAGES.map((l) => ({ value: l.name, label: l.name })),
    });
    if (!choice) return;
    const ext = LANGUAGES.find((l) => l.name === choice)?.ext ?? "";
    editor.setLanguage(ext ? grammarFor(`x.${ext}`) : null);
    if (choice === languageOf(tab.path)) forcedLanguage.delete(tab.id);
    else forcedLanguage.set(tab.id, choice);
    renderStatusSegments();
  }

  $(".js-sb-pos").addEventListener("click", () => void gotoLine());
  $(".js-sb-eol").addEventListener("click", () => switchEol());
  $(".js-sb-indent").addEventListener("click", () => void convertIndent());
  $(".js-sb-lang").addEventListener("click", () => void pickLanguage());

  // ── blame and file history ──
  // The agent has answered `git.blame` and `git.log {path}` from the start and
  // nothing ever called either, so "when did this line change" was a question
  // you left the tool to answer.

  /** Tabs currently showing blame, by tab id.
   *
   *  Blame belongs to a document, and the rows live in that document's editor
   *  state — but the bar above the editor is one element shared by every tab,
   *  so it needs to be told which tab it is describing. */
  const blaming = new Map<string, { path: string; stale: boolean }>();

  async function toggleBlame(): Promise<void> {
    const tab = openFile;
    if (!tab) return;
    if (blaming.has(tab.id)) {
      blaming.delete(tab.id);
      editor.setBlame(null);
      renderBlameBar();
      return;
    }
    try {
      const rows = await agent.call<BlameLine[]>("git.blame", { path: tab.path });
      if (openFile?.id !== tab.id) return; // the reader moved on while git ran
      editor.setBlame(rows);
      // Blame describes the committed file. An edited buffer has lines that
      // commit never had, so the rows below the first edit line up with
      // nothing — said once, in the bar, rather than left to be discovered.
      blaming.set(tab.id, { path: tab.path, stale: isDirty(tab) });
      renderBlameBar();
      report("git blame", `blamed ${tab.path}`, { detail: `${rows.length} line(s)` });
    } catch (e) {
      reportError("git blame", e);
    }
  }

  /** Blame a file from the explorer: open it first, since blame is a gutter
   *  beside the text and there is nothing to put it beside otherwise. */
  async function blameFile(path: string): Promise<void> {
    await open(path, false, false);
    if (openFile?.path !== path) return; // the open failed and already said so
    if (!blaming.has(openFile.id)) await toggleBlame();
  }

  /** Keep the bar in step with whatever tab is on screen. */
  function renderBlameBar(): void {
    const bar = $(".js-blame");
    const state = openFile ? blaming.get(openFile.id) : undefined;
    bar.hidden = !state;
    if (!state || !openFile) return;
    const dirty = isDirty(openFile);
    bar.innerHTML = `<span class="compare-label">blame</span>
      <span class="compare-path">${
        dirty
          ? "the buffer has unsaved edits — these lines are the last commit's, and no longer line up"
          : "click a line to open the commit it came from"
      }</span>
      <span class="t-spacer"></span>
      <button class="t-btn js-blame-history" type="button">file history</button>
      <button class="t-icon js-blame-off" type="button" aria-label="Turn blame off">✕</button>`;
    bar.classList.toggle("is-warn", dirty);
    bar.querySelector(".js-blame-history")!.addEventListener("click", () => showFileHistory(state.path));
    bar.querySelector(".js-blame-off")!.addEventListener("click", () => void toggleBlame());
  }

  /** Scope the history panel to one path, and show it. */
  function showFileHistory(path: string): void {
    showView("history");
    history.scopeTo(path);
  }

  /** Open the history panel with one commit expanded and scrolled to. */
  async function revealCommit(oid: string): Promise<void> {
    showView("history");
    await history.reveal(oid);
  }

  // ── folder comparison ──
  // Two environment folders, or one folder against what is committed. The
  // result is a list of paths in three states; every row opens the pair in the
  // ordinary diff view, so this adds a way to *find* the differences without
  // adding a second way to read them.

  /** Compare two folders in the workspace. */
  async function compareFolderTree(left: string, right: string): Promise<void> {
    const tab: FolderTab = {
      kind: "folder",
      id: `dircmp:${JSON.stringify([left, right])}`,
      label: `${distinguish(left, right)} ↔ ${distinguish(right, left)}`,
      title: `${left} ↔ ${right}`,
      mode: "folders",
      left,
      right,
      leftName: left,
      rightName: right,
      state: "running",
      entries: [],
      truncated: false,
      showSame: false,
    };
    placeTab(tab, false);
    activate(tab.id);
    tree.setCompareBase(null);

    try {
      const result = await compareFolders(
        {
          readDir: (path) => agent.call<DirEntry[]>("fs.readdir", { path }),
          read: (path) => agent.call<FileRead>("fs.read", { path }),
        },
        left,
        right,
      );
      tab.entries = result.entries;
      tab.truncated = result.truncated;
      tab.state = "done";
      const differing = result.entries.filter((e) => e.state !== "same").length;
      report("compare", `${left} ↔ ${right}: ${differing || "no"} difference${differing === 1 ? "" : "s"}`);
    } catch (e) {
      tab.state = "failed";
      tab.error = e instanceof Error ? e.message : String(e);
      reportError("compare", e);
    }
    // The reader may well have moved on while a few hundred files were read.
    if (activeId === tab.id) renderFolderTab(tab);
    renderTabs();
  }

  /** Compare a folder against the committed version of itself.
   *
   *  This is git's own answer rather than a walk: `git status` already knows
   *  which files under a path were added, deleted or changed, and asking it
   *  costs one call instead of reading the folder twice. */
  async function compareFolderWithHead(folder: string): Promise<void> {
    const tab: FolderTab = {
      kind: "folder",
      id: `dirhead:${JSON.stringify(folder)}`,
      label: `${folder.split("/").pop() ?? folder} ↔ HEAD`,
      title: `${folder} ↔ HEAD`,
      mode: "head",
      left: folder,
      right: null,
      leftName: "HEAD (last commit)",
      rightName: `${folder} (on disk)`,
      state: "running",
      entries: [],
      truncated: false,
      showSame: false,
    };
    placeTab(tab, false);
    activate(tab.id);

    try {
      const st = await agent.call<GitStatus>("git.status");
      const prefix = `${folder}/`;
      tab.entries = st.entries
        .filter((row) => row.path.startsWith(prefix) && !row.ignored)
        .map((row) => {
          const rel = row.path.slice(prefix.length);
          // Either column can carry the letter: staged and unstaged changes are
          // both changes as far as "is this folder what was committed?" goes.
          const codes = row.index + row.work;
          // Untracked and added files exist here and not in HEAD; deleted ones
          // the other way round. "left" is HEAD, matching the diff that opens.
          if (row.untracked || codes.includes("A")) return { rel, state: "right" as const, rightPath: row.path };
          if (codes.includes("D")) return { rel, state: "left" as const, leftPath: row.path };
          return { rel, state: "differs" as const, leftPath: row.path, rightPath: row.path };
        })
        .sort((a, b) => a.rel.localeCompare(b.rel));
      tab.state = "done";
      report("compare", `${folder} ↔ HEAD: ${tab.entries.length || "no"} change${tab.entries.length === 1 ? "" : "s"}`);
    } catch (e) {
      tab.state = "failed";
      tab.error = e instanceof Error ? e.message : String(e);
      reportError("git status", e);
    }
    if (activeId === tab.id) renderFolderTab(tab);
    renderTabs();
  }

  /** What changed between two commits.
   *
   *  There is no `git diff A B --name-status` in the protocol, so the path set
   *  is built from the commits on either side of the pair — `A..B` and `B..A`,
   *  so two divergent branches are covered and not just a fast-forward — and
   *  then each path is settled by reading its blob at both ends. That last step
   *  is what makes the answer exact rather than "touched at some point": a file
   *  changed and changed back reports as identical, which is the truth.
   */
  async function compareCommits(from: Commit, to: Commit): Promise<void> {
    const a7 = from.oid.slice(0, 7);
    const b7 = to.oid.slice(0, 7);
    const tab: FolderTab = {
      kind: "folder",
      id: `revcmp:${from.oid}:${to.oid}`,
      label: `${a7} ↔ ${b7}`,
      title: `${a7} ${from.subject} ↔ ${b7} ${to.subject}`,
      mode: "commits",
      left: from.oid,
      right: null,
      revs: { from, to },
      leftName: `${a7} · ${from.subject}`,
      rightName: `${b7} · ${to.subject}`,
      state: "running",
      entries: [],
      truncated: false,
      showSame: false,
    };
    placeTab(tab, false);
    activate(tab.id);

    try {
      // Both directions: a path touched only on the older commit's own branch
      // is still a difference between the two, and `A..B` alone would miss it.
      const [ahead, behind] = await Promise.all([
        agent.call<Commit[]>("git.log", { ref: `${from.oid}..${to.oid}`, limit: REV_WALK }),
        agent.call<Commit[]>("git.log", { ref: `${to.oid}..${from.oid}`, limit: REV_WALK }),
      ]);
      const between = [...ahead, ...behind];
      const details = await Promise.all(
        between.map((c) => agent.call<CommitDetail>("git.commitDetail", { oid: c.oid }).catch(() => null)),
      );
      const paths = new Set<string>();
      for (const d of details) {
        for (const f of d?.files ?? []) {
          paths.add(f.path);
          if (f.from) paths.add(f.from); // a rename is two paths, and both moved
        }
      }

      const blob = (rev: string, path: string): Promise<{ text: string | null; binary: boolean } | null> =>
        agent.call<{ text: string | null; binary: boolean }>("git.blob", { rev, path }).catch(() => null);
      const normalise = (s: string | null): string => (s ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");

      const entries: FolderEntry[] = [];
      for (const rel of [...paths].sort()) {
        const [x, y] = await Promise.all([blob(from.oid, rel), blob(to.oid, rel)]);
        // `git.blob` answers with a null text for a path the commit does not
        // have, which is how "only on one side" is told from "empty file".
        const inA = x !== null && (x.text !== null || x.binary);
        const inB = y !== null && (y.text !== null || y.binary);
        if (inA && !inB) entries.push({ rel, state: "left", leftPath: rel });
        else if (!inA && inB) entries.push({ rel, state: "right", rightPath: rel });
        else if (inA && inB) {
          const same = x!.binary || y!.binary ? x!.binary === y!.binary : normalise(x!.text) === normalise(y!.text);
          entries.push({ rel, state: same ? "same" : "differs", leftPath: rel, rightPath: rel });
        }
      }
      tab.entries = entries;
      tab.truncated = ahead.length >= REV_WALK || behind.length >= REV_WALK;
      tab.state = "done";
      const differing = entries.filter((e) => e.state !== "same").length;
      report("compare", `${a7} ↔ ${b7}: ${differing || "no"} file${differing === 1 ? "" : "s"} differ`);
    } catch (e) {
      tab.state = "failed";
      tab.error = e instanceof Error ? e.message : String(e);
      reportError("compare", e);
    }
    if (activeId === tab.id) renderFolderTab(tab);
    renderTabs();
  }

  /** Past this many commits on one side, the pair is far enough apart that the
   *  question is really "what changed on this branch", and reading every
   *  commit's file list to answer it is the wrong shape of call. */
  const REV_WALK = 200;

  /** One file, as it stood at two commits. */
  async function compareRevs(path: string, from: Commit, to: Commit): Promise<void> {
    const a7 = from.oid.slice(0, 7);
    const b7 = to.oid.slice(0, 7);
    try {
      const [a, b] = await Promise.all([
        agent.call<{ text: string | null; binary: boolean }>("git.blob", { rev: from.oid, path }),
        agent.call<{ text: string | null; binary: boolean }>("git.blob", { rev: to.oid, path }),
      ]);
      showDiffTab(
        `revdiff:${from.oid}:${to.oid}:${path}`,
        `${base(path)} (${a7}…${b7})`,
        `${path}\n\n${a7} · ${from.subject}\n${b7} · ${to.subject}`,
        {
          path,
          before: a.text,
          after: b.text,
          beforeLabel: `${a7} · ${from.subject}`,
          afterLabel: `${b7} · ${to.subject}`,
          binary: a.binary || b.binary,
        },
        false,
      );
    } catch (e) {
      reportError("git blob", e);
    }
  }

  const FOLDER_BADGE: Record<EntryState, string> = { left: "−", right: "+", differs: "≠", same: "=" };

  /** What each state is called, in the words that fit the comparison at hand:
   *  between two folders a file is on one side or the other, but against HEAD
   *  the same three states are the ones git already has names for. */
  const stateWord = (tab: FolderTab, state: EntryState): string => {
    if (tab.mode === "folders") {
      return { left: "only on the left", right: "only on the right", differs: "differs", same: "identical" }[state];
    }
    return { left: "deleted", right: "new", differs: "modified", same: "unchanged" }[state];
  };

  /** The same states after a number, where the row wording does not read as
   *  English: "2 differs" is not a count of anything. */
  const countWord = (tab: FolderTab, state: EntryState): string =>
    tab.mode === "folders"
      ? { left: "only left", right: "only right", differs: "differ", same: "identical" }[state]
      : stateWord(tab, state);

  function renderFolderTab(tab: FolderTab): void {
    if (tab.state === "running") {
      folderHost.innerHTML = `<div class="dircmp"><p class="dircmp-note">Comparing ${esc(tab.leftName)} with ${esc(tab.rightName)}…</p></div>`;
      return;
    }
    if (tab.state === "failed") {
      folderHost.innerHTML = `<div class="dircmp"><p class="dircmp-note is-error">Could not compare these folders: ${esc(tab.error ?? "unknown error")}</p></div>`;
      return;
    }

    const counts = { left: 0, right: 0, differs: 0, same: 0 };
    for (const e of tab.entries) counts[e.state]++;
    const shown = tab.entries.filter((e) => tab.showSame || e.state !== "same");

    // The header says which side is which *by name*, because "left" and
    // "right" mean nothing an hour later when the tab is still open.
    const head = `<div class="dircmp-head">
      <span class="dircmp-side"><b>−</b> ${esc(tab.leftName)}</span>
      <span class="dircmp-side"><b>+</b> ${esc(tab.rightName)}</span>
      <span class="t-spacer"></span>
      <span class="dircmp-counts">${(["differs", "left", "right", "same"] as const)
        .filter((s) => s !== "same" || counts.same)
        .map((s) => `${counts[s]} ${countWord(tab, s)}`)
        .join(" · ")}</span>
      ${counts.same ? `<label class="dircmp-toggle"><input type="checkbox" class="js-show-same"${tab.showSame ? " checked" : ""}> show identical</label>` : ""}
      <button class="t-btn js-dircmp-swap" type="button"${tab.mode === "folders" ? "" : " hidden"}>swap sides</button>
      <button class="t-btn js-dircmp-again" type="button">re-run</button>
    </div>`;

    const note = tab.truncated
      ? `<p class="dircmp-note is-warn">More than 4000 files on one side — this list is partial. Compare a folder further in.</p>`
      : "";

    const body = shown.length
      ? `<div class="dircmp-list" role="list">${shown
          .map((e, i) => {
            const word = stateWord(tab, e.state);
            const openable = e.state === "differs";
            return `<div class="dircmp-row ${e.state}${openable ? " openable" : ""}" role="listitem" data-i="${i}"
              tabindex="0" title="${esc(e.rel)} — ${word}${openable ? " · click to see the difference" : ""}">
              <span class="dircmp-badge" aria-hidden="true">${FOLDER_BADGE[e.state]}</span>
              <span class="dircmp-path">${esc(e.rel)}</span>
              <span class="dircmp-word">${word}</span>
            </div>`;
          })
          .join("")}</div>`
      : `<p class="dircmp-note">${
          counts.same && !tab.showSame
            ? `No differences — all ${counts.same} files match. Tick “show identical” to list them.`
            : tab.mode === "head"
              ? `Nothing under ${esc(tab.left)} has changed since the last commit.`
              : tab.mode === "commits"
                ? "These two commits leave every file the same."
                : "Both folders are empty."
        }</p>`;

    folderHost.innerHTML = `<div class="dircmp">${head}${note}${body}</div>`;

    folderHost.querySelector(".js-show-same")?.addEventListener("change", () => {
      tab.showSame = !tab.showSame;
      renderFolderTab(tab);
    });
    folderHost.querySelector(".js-dircmp-again")!.addEventListener("click", () => {
      if (tab.mode === "commits" && tab.revs) void compareCommits(tab.revs.from, tab.revs.to);
      else if (tab.mode === "head") void compareFolderWithHead(tab.left);
      else if (tab.right !== null) void compareFolderTree(tab.left, tab.right);
    });
    folderHost.querySelector(".js-dircmp-swap")?.addEventListener("click", () => {
      if (tab.right !== null) void compareFolderTree(tab.right, tab.left);
    });

    const openRow = (i: number): void => {
      const entry = shown[i];
      if (!entry || entry.state !== "differs") return;
      // Against HEAD there is one path and two versions of it; between two
      // folders there are two paths. Both end up in the same diff view.
      if (tab.mode === "head") void openDiff(entry.leftPath!, "head");
      else if (tab.mode === "commits" && tab.revs) void compareRevs(entry.rel, tab.revs.from, tab.revs.to);
      else void compare(entry.leftPath!, entry.rightPath!);
    };
    for (const row of folderHost.querySelectorAll<HTMLElement>(".dircmp-row")) {
      const i = Number(row.dataset.i);
      row.addEventListener("click", () => openRow(i));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openRow(i);
        }
      });
    }
  }

  /** What a commit diff is a diff *of*, when the caller knows.
   *
   *  The agent can only answer `04b43473^ → 04b43473`, because a blob read is
   *  all it was asked for. The history panel has the subject, the author and
   *  the date in hand already, so it passes them down rather than making the
   *  reader decode two near-identical hashes and a caret. */
  interface DiffAbout {
    subject: string;
    author: string;
    time: number;
    /** Subject of the parent, when it is in the loaded log. */
    parentSubject?: string;
    parentOid?: string;
  }

  async function openDiff(path: string, kind: string, about?: DiffAbout): Promise<void> {
    try {
      const pair = await agent.call<DiffPair>("git.diff", { path, kind });
      if (about) {
        const short = kind.slice(0, 7);
        // "before" is the parent commit, named as one. `<oid>^` is correct and
        // unreadable: a junior reads the caret as a typo in the hash next to it.
        pair.beforeLabel = about.parentOid
          ? `${about.parentOid.slice(0, 7)} · ${about.parentSubject ?? "parent commit"}`
          : "before this commit";
        pair.afterLabel = `${short} · ${about.subject}`;
      }
      // "worktree" is index vs the file on disk, so the right-hand side *is*
      // the file: reverting a chunk there is a real edit that can be written
      // back. Everything else (staged, a commit) compares two recorded states.
      const editablePath = kind === "worktree" ? path : undefined;
      // The same two sides, read the other way: one of them is the index, so
      // one change out of twenty can be moved across without staging the file.
      const staging =
        kind === "worktree" ? { path, reverse: false }
        : kind === "staged" ? { path, reverse: true }
        : undefined;
      // `kind` is either a named diff or a commit oid, and the label has to say
      // which — otherwise every commit's diff of the same file reads the same
      // in the strip. Keyed by kind too, so each gets its own tab.
      const what = /^[0-9a-f]{7,40}$/.test(kind) ? kind.slice(0, 7) : kind;
      // The hover text spells the commit out; the strip cannot hold it.
      const title = about
        ? `${path}\n\n${what} · ${about.subject}\n${about.author} · ${absoluteTime(about.time)}`
        : `${path}  (diff · ${what})`;
      showDiffTab(`diff:${kind}:${path}`, `${base(path)} (${what})`, title, pair, true, editablePath, undefined, staging);
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
      tab.eolChanged = false;
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

  // ── session ──
  // What was on screen last time. Width, folded SCM groups and search options
  // were already remembered, which only made the rest more conspicuous: the
  // tabs, which folder was open and which view you were in all reset on every
  // reload, so coming back to a repository meant reopening four files by hand.
  //
  // Keyed by workspace root, because none of it means anything anywhere else.
  interface Session {
    open: string[];
    active: string | null;
    expanded: string[];
    view: View;
    histAll: boolean;
    histGraph: boolean;
  }
  const SESSION_KEY = "enc-code-sessions";
  /** A handful of workspaces, so localStorage does not accumulate every folder
   *  the tool has ever been pointed at. */
  const MAX_SESSIONS = 8;

  const loadSessions = (): Record<string, Session> => {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}") as Record<string, Session>;
    } catch {
      return {};
    }
  };

  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Restoring opens tabs and expands folders, which is exactly what the save
   *  hooks listen for — without this the restore would write its own progress
   *  back over the session it is still reading. */
  let restoringSession = false;

  function saveSession(): void {
    if (restoringSession || !boundRoot) return;
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(writeSession, 400);
  }

  function writeSession(): void {
    sessionTimer = null;
    const root = boundRoot;
    if (!root) return;
    try {
      const all = loadSessions();
      const active = tabs.find((t) => t.id === activeId);
      all[root] = {
        open: fileTabs().filter((t) => !t.missing).map((t) => t.path),
        active: active?.kind === "file" ? active.path : null,
        expanded: tree.expandedPaths(),
        view: ($(".code-side").dataset.view as View) ?? "explorer",
        histAll: history.options.all,
        histGraph: history.options.graph,
      };
      // Oldest out first — insertion order is close enough to recency here,
      // because the current root is re-inserted on every save.
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete all[k];
      localStorage.setItem(SESSION_KEY, JSON.stringify(all));
    } catch {
      /* private mode, or the quota — neither is worth interrupting anyone for */
    }
  }

  // Folders opened in the tree do not go through any of the hooks above, and a
  // reload right after expanding one would lose it. The page going away is the
  // last moment anything can be written, so everything is flushed here.
  window.addEventListener("pagehide", () => {
    if (!restoringSession) writeSession();
  });

  async function restoreSession(root: string): Promise<void> {
    const saved = loadSessions()[root];
    if (!saved) return;
    restoringSession = true;
    try {
      history.setOptions({ all: saved.histAll, graph: saved.histGraph });
      if (saved.view) showView(saved.view);
      await tree.restoreExpanded(saved.expanded ?? []);
      // Only files that are still there, and never over tabs the user has
      // already opened in this session — reconnecting should not duplicate
      // what is on screen.
      for (const path of saved.open ?? []) {
        if (tabForPath(path)) continue;
        await open(path, false, false).catch(() => undefined);
      }
      const back = saved.active ? tabForPath(saved.active) : undefined;
      if (back) activate(back.id);
    } finally {
      restoringSession = false;
    }
    saveSession();
  }

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
    await restoreSession(root);
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
      const message = e instanceof Error ? e.message : String(e);
      // One agent serves one tab unless it was started otherwise. That is a
      // deliberate default, and the way past it is a flag documented only in
      // the README — so the refusal now carries the command itself.
      if (/already serving another tab/i.test(message)) await offerAllowMultiple(url);
    }
  }

  /** Hand over the exact command that lifts the one-tab restriction.
   *
   *  A toast cannot hold something you have to retype into a terminal, and
   *  "see the README" is the answer that sent people to the README. */
  async function offerAllowMultiple(url: string): Promise<void> {
    const root = loadRecents().find((r) => r.url === url)?.root;
    const command = root ? `enc-tool-agent --allow-multiple --root "${root}"` : "enc-tool-agent --allow-multiple";
    const ok = await modalConfirm({
      title: "That agent is already serving another tab",
      detail: `Close the other tab, or restart the agent so it accepts more than one:\n\n${command}`,
      okLabel: "copy the command",
    });
    if (ok) await copyToClipboard(command, "Command", (m, isError) => report("agent", m, { isError }));
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
    if (agent.state === "online") {
      items.push({
        label: "Open a different folder in this agent…",
        hint: "no restart",
        separated: items.length > 0,
        run: () => void changeRoot(),
      });
    }
    items.push({ label: "Connect to another agent…", separated: items.length > 0, run: () => void connect() });
    showMenu(e.clientX, e.clientY, items);
  }

  /** Point the running agent at another folder.
   *
   *  Switching projects used to mean stopping the agent and starting a second
   *  one, which is a terminal round trip for something the editor can ask for.
   *  The agent decides whether it may: by default only within the folder it was
   *  started on, and wider only where the person who started it said so with
   *  --allow-root. So this asks, and reports the refusal in those terms rather
   *  than pretending the path was wrong.
   */
  async function changeRoot(): Promise<void> {
    const current = agent.info?.root ?? "";
    const path = await modalPrompt({
      title: "Open a different folder",
      hint: "An absolute path on the machine the agent runs on. The agent will refuse anything outside what it was allowed at startup (--allow-root).",
      value: current,
      okLabel: "open",
    });
    if (!path || path === current) return;
    try {
      const info = await agent.call<AgentInfo>("agent.setRoot", { path });
      agent.info = info;
      report("agent", `workspace is now ${info.root}`);
      // Everything on screen describes the old folder. The tabs are the only
      // part worth keeping a decision about, so they are closed the same way
      // disconnecting closes them — a buffer whose path means something else
      // now is worse than no buffer.
      // onOnline() is exactly this work: it rebinds the root, drops tabs that
      // belonged to the old one, reloads the tree, status and panels, and
      // restarts the watcher.
      await onOnline();
    } catch (e) {
      reportError("agent.setRoot", e);
    }
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
      // Masked by default: this URL carries the agent's token, and the dialog
      // is open precisely when someone is sharing a screen or pasting a
      // screenshot into a ticket. The eye shows it when the port needs reading.
      password: true,
      hint: fromClipboard
        ? "Taken from your clipboard — the agent put it there when it started. It contains the agent's token, so it is hidden until you show it."
        : "Run `enc-tool agent` in the folder you want to edit, then paste the URL it prints. It contains a token, so it is hidden until you show it.",
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
