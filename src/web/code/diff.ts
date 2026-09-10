/** Diff viewer built on @codemirror/merge.
 *
 *  Two modes, both from the same package: side-by-side (MergeView) and inline
 *  (unifiedMergeView). Unchanged regions collapse so a two-line change in a
 *  2000-line file does not require scrolling to find it.
 *
 *  Everything here is read-only. Editing a diff is a separate feature from
 *  resolving a conflict, and conflicts are edited in the normal editor where
 *  git has already written the markers.
 */
import { EditorState, Text, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Chunk, MergeView, goToNextChunk, goToPreviousChunk, unifiedMergeView } from "@codemirror/merge";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import type { DiffPair } from "../../agent/protocol.ts";
import { grammarFor } from "./grammars.ts";
import { esc } from "./ui.ts";

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--panel)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "12.5px", lineHeight: "1.5" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--text-muted)", borderRight: "1px solid var(--border)" },
  "&.cm-focused": { outline: "none" },
});

export type DiffMode = "split" | "unified";

const MODE_KEY = "enc-diff-mode";

/** Side by side or inline — remembered, because it is a preference about how a
 *  person reads a diff, not about the diff. It used to reset on every reload. */
function loadMode(): DiffMode {
  try {
    return localStorage.getItem(MODE_KEY) === "unified" ? "unified" : "split";
  } catch {
    return "split";
  }
}

function saveMode(mode: DiffMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* private mode */
  }
}

export class DiffView {
  private merge: MergeView | null = null;
  private single: EditorView | null = null;
  private pair: DiffPair | null = null;
  private mode: DiffMode = loadMode();
  /** Where the reader is in the list of changes, so "next" means the next one
   *  after the last one they looked at. */
  private at = 0;
  private chunkCount = 0;
  /** Set while the working side may be edited — see show(). */
  private onEdit: ((text: string) => void) | undefined;

  private readonly header: HTMLElement;
  private readonly body: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private dark: boolean,
  ) {
    host.classList.add("diff-view");
    host.innerHTML = `
      <div class="diff-head">
        <span class="diff-path"></span>
        <span class="diff-labels"></span>
        <span class="t-spacer"></span>
        <span class="diff-count js-count"></span>
        <button class="t-icon js-prev" type="button" title="Previous change (Shift+F7)">▲</button>
        <button class="t-icon js-next" type="button" title="Next change (F7)">▼</button>
        <button class="t-btn js-mode" type="button">inline</button>
      </div>
      <div class="diff-body"></div>`;
    this.header = host.querySelector(".diff-head")!;
    this.body = host.querySelector(".diff-body")!;
    this.header.querySelector(".js-mode")!.addEventListener("click", () => {
      this.mode = this.mode === "split" ? "unified" : "split";
      saveMode(this.mode);
      this.render();
    });
    this.header.querySelector(".js-next")!.addEventListener("click", () => this.step(1));
    this.header.querySelector(".js-prev")!.addEventListener("click", () => this.step(-1));
    // F7 is what every diff viewer uses, and the pair is the only way to walk a
    // long file without hunting for the next coloured band by eye.
    host.addEventListener("keydown", (e) => {
      if (e.key !== "F7") return;
      e.preventDefault();
      this.step(e.shiftKey ? -1 : 1);
    });
  }

  /** `onEdit` turns the working side into something you can change: the inline
   *  view then draws accept/reject buttons over every chunk, and reverting one
   *  is how you undo a single change out of twenty without touching the rest.
   *  Nothing is written to disk here — the caller decides what to do with the
   *  text it is handed. */
  show(pair: DiffPair, onEdit?: (text: string) => void): void {
    this.pair = pair;
    this.onEdit = onEdit;
    this.at = 0;
    this.render();
  }

  /** Move to the next (or previous) change and say where we are.
   *
   *  "n changes" and a way to walk them is the difference between reading a
   *  diff and hunting through one: with unchanged regions collapsed, a long
   *  file shows a handful of bands and no indication of how many more are
   *  below. */
  private step(delta: number): void {
    if (!this.chunkCount) return;
    const view = this.mode === "split" ? this.merge?.b : this.single;
    if (!view) return;
    const command = delta > 0 ? goToNextChunk : goToPreviousChunk;
    if (!command({ state: view.state, dispatch: (tr) => view.dispatch(tr) })) {
      // Past the end: wrap, which is what F7 does everywhere else.
      view.dispatch({ selection: { anchor: delta > 0 ? 0 : view.state.doc.length } });
      command({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    }
    view.focus();
    this.at = Math.min(this.chunkCount, Math.max(1, this.at + delta)) || 1;
    this.updateCount();
  }

  private updateCount(): void {
    const el = this.header.querySelector<HTMLElement>(".js-count")!;
    const nav = this.header.querySelectorAll<HTMLButtonElement>(".js-next, .js-prev");
    el.textContent = this.chunkCount
      ? this.at
        ? `${this.at} of ${this.chunkCount} change${this.chunkCount === 1 ? "" : "s"}`
        : `${this.chunkCount} change${this.chunkCount === 1 ? "" : "s"}`
      : "";
    for (const b of nav) b.disabled = this.chunkCount === 0;
  }

  clear(): void {
    this.pair = null;
    this.dispose();
    this.body.innerHTML = "";
  }

  setTheme(dark: boolean): void {
    this.dark = dark;
    if (this.pair) this.render();
  }

  private dispose(): void {
    this.merge?.destroy();
    this.merge = null;
    this.single?.destroy();
    this.single = null;
  }

  private base(path: string, editable = false): Extension[] {
    const lang = grammarFor(path);
    return [
      lineNumbers(),
      theme,
      syntaxHighlighting(this.dark ? oneDarkHighlightStyle : defaultHighlightStyle),
      // Read-only unless the caller asked for the working side to be editable:
      // a diff is normally something you read, and an accidental keystroke in
      // one should not become a change to a file.
      ...(editable ? [] : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
      ...(lang ? [lang] : []),
    ];
  }

  private render(): void {
    const pair = this.pair;
    this.dispose();
    this.body.innerHTML = "";
    if (!pair) return;

    // One file compared against a version of itself: the path, then what the
    // two sides are ("HEAD → working tree"). Two different files: the labels
    // are the paths, so printing `path` as well said the same thing twice —
    // `a ⇄ b` followed immediately by `a → b`.
    const pathEl = this.header.querySelector<HTMLElement>(".diff-path")!;
    const labelEl = this.header.querySelector<HTMLElement>(".diff-labels")!;
    const twoFiles = pair.path.includes(pair.beforeLabel) && pair.path.includes(pair.afterLabel);
    // With two files the pair *is* the heading, and it goes in the prominent
    // slot rather than the muted one the sides normally use.
    pathEl.textContent = twoFiles ? `${pair.beforeLabel} → ${pair.afterLabel}` : pair.path;
    labelEl.textContent = twoFiles ? "" : `${pair.beforeLabel} → ${pair.afterLabel}`;
    labelEl.hidden = twoFiles;
    this.header.querySelector(".js-mode")!.textContent = this.mode === "split" ? "inline" : "side-by-side";
    // The per-chunk buttons only exist in the inline view, so say where they
    // are rather than letting someone conclude the feature is missing.
    const modeBtn = this.header.querySelector<HTMLButtonElement>(".js-mode")!;
    modeBtn.title = this.onEdit && this.mode === "split" ? "Switch to inline to revert individual changes" : "Switch the diff layout";

    this.chunkCount = 0;
    this.updateCount();

    if (pair.binary) {
      this.body.innerHTML = `<div class="diff-note">Binary file — no textual diff.</div>`;
      return;
    }
    if (pair.before === null && pair.after === null) {
      this.body.innerHTML = `<div class="diff-note">File does not exist on either side.</div>`;
      return;
    }

    // A file that exists on one side only — added, or deleted — has nothing to
    // align against. Coercing the missing side to "" and handing that to
    // MergeView is not merely wasteful: an empty document on one side hangs the
    // tab outright. Show the content itself, which is also what someone opening
    // a new file out of a commit actually wants to read.
    if (pair.before === null || pair.after === null) {
      const added = pair.before === null;
      const text = (added ? pair.after : pair.before) ?? "";
      const lines = text === "" ? 0 : text.split("\n").length;
      const note = document.createElement("div");
      note.className = `diff-note diff-note-${added ? "added" : "removed"}`;
      note.textContent = added
        ? `New file — ${lines} line${lines === 1 ? "" : "s"} added.`
        : `File deleted — ${lines} line${lines === 1 ? "" : "s"} removed.`;
      this.body.append(note);

      const holder = document.createElement("div");
      holder.className = "diff-single";
      this.body.append(holder);
      this.single = new EditorView({
        parent: holder,
        state: EditorState.create({ doc: text, extensions: this.base(pair.path) }),
      });
      return;
    }

    const before = pair.before;
    const after = pair.after;
    if (before === after) {
      this.body.innerHTML = `<div class="diff-note">No changes (${esc(pair.beforeLabel)} and ${esc(pair.afterLabel)} are identical).</div>`;
      return;
    }

    // How many changes there are, counted the same way the view groups them,
    // so the number matches what the reader is about to walk through.
    this.chunkCount = Chunk.build(Text.of(before.split("\n")), Text.of(after.split("\n"))).length;
    this.updateCount();

    // collapseUnchanged keeps long files navigable; margin leaves a few lines of
    // context around every change so a hunk is never shown without its bearings.
    const collapse = { margin: 3, minSize: 6 };

    if (this.mode === "split") {
      this.merge = new MergeView({
        a: { doc: before, extensions: this.base(pair.path) },
        b: { doc: after, extensions: this.base(pair.path) },
        parent: this.body,
        collapseUnchanged: collapse,
        highlightChanges: true,
        gutter: true,
      });
    } else {
      const editable = Boolean(this.onEdit);
      this.single = new EditorView({
        parent: this.body,
        state: EditorState.create({
          doc: after,
          extensions: [
            // mergeControls are the accept/reject buttons the package draws
            // over each chunk. They rewrite the document, so they only make
            // sense on a side that may be written back.
            unifiedMergeView({ original: before, mergeControls: editable, collapseUnchanged: collapse }),
            ...this.base(pair.path, editable),
            ...(editable
              ? [
                  EditorView.updateListener.of((u) => {
                    if (u.docChanged) this.onEdit?.(u.state.doc.toString());
                  }),
                ]
              : []),
          ],
        }),
      });
    }
  }
}
