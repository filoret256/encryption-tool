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
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, getChunks, goToNextChunk, goToPreviousChunk, unifiedMergeView } from "@codemirror/merge";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import type { DiffPair } from "../../code-agent/protocol.ts";
import { grammarFor } from "./grammars.ts";
import { cmBase, cmDark } from "../cm-theme.ts";
import { cspNonce } from "../csp.ts";
import { esc, startTrimmed } from "./ui.ts";

// Everything but the type size comes from cmBase now. A diff is read, not
// written, so it is set a notch smaller than the editor — two panes have to fit
// side by side — but a selection made in it to copy a line out should look like
// a selection made anywhere else, and before this it had no colour of its own.
const theme = EditorView.theme({
  ".cm-scroller": { fontSize: "12.5px" },
});

export type DiffMode = "split" | "unified";

/** Staging one change at a time, offered by whoever opened the diff.
 *
 *  Only the two diffs that have an index side can supply this: "index →
 *  working tree" stages, "HEAD → index" unstages. Every other diff compares two
 *  things already committed, and there is nothing to stage. */
export interface HunkAction {
  /** The verb, shown on the button: "stage" or "unstage". */
  label: string;
  /** Act on the change at this 0-based index, counted the way the view counts
   *  them. Rejecting is how the caller reports a patch git would not take. */
  apply(index: number): Promise<void>;
}

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
  /** The window is too narrow for two columns. Overrides the stored mode
   *  without replacing it: widen the window and the preference comes back. */
  private narrow = false;
  /** Where the reader is in the list of changes, so "next" means the next one
   *  after the last one they looked at. */
  private at = 0;
  private chunkCount = 0;
  /** How many changes the last pair had, by the pair: a redraw for the width of the window, or
   *  for the mode, shows the number at once instead of waiting for the view to count again. */
  private counted: { before: string; after: string; n: number } | null = null;
  /** The colours of the editors, which a change of theme swaps in place. Rebuilding the view for it
   *  meant the diff of both files was worked out again to draw the same changes in other colours. */
  private readonly cDark = new Compartment();
  private readonly cHighlight = new Compartment();
  /** Set while the working side may be edited — see show(). */
  private onEdit: ((text: string) => void) | undefined;
  /** What "stage this change" does here, when the caller offers it. */
  private hunk: HunkAction | undefined;
  /** Set when the caller can show the same pair the other way round. */
  private onSwap: (() => void) | undefined;

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
        <button class="t-btn js-hunk-apply" type="button" hidden></button>
        <button class="t-icon js-swap" type="button" title="Swap the sides" hidden>⇄</button>
        <span class="kf-seg" role="group" aria-label="Layout">
          <button class="t-btn js-mode-split" type="button" aria-pressed="true">split</button>
          <button class="t-btn js-mode-inline" type="button" aria-pressed="false">inline</button>
        </span>
      </div>
      <div class="diff-columns js-columns" hidden>
        <span class="diff-col js-col-a"></span>
        <span class="diff-col js-col-b"></span>
      </div>
      <div class="diff-body"></div>`;
    this.header = host.querySelector(".diff-head")!;
    this.body = host.querySelector(".diff-body")!;
    // Each button states the layout it gives, so the pair shows the current one. Choosing
    // split while the window is forcing inline sets the *preference*, which takes effect the
    // moment there is room for it again.
    const choose = (mode: DiffMode): void => {
      if (this.mode === mode && !this.narrow) return;
      this.mode = mode;
      saveMode(mode);
      this.render();
    };
    this.header.querySelector(".js-mode-split")!.addEventListener("click", () => choose("split"));
    this.header.querySelector(".js-mode-inline")!.addEventListener("click", () => choose("unified"));
    this.header.querySelector(".js-swap")!.addEventListener("click", () => this.onSwap?.());
    this.header.querySelector(".js-hunk-apply")!.addEventListener("click", () => void this.applyCurrentHunk());
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

  /** Tie the two halves' horizontal scrolling together.
   *
   *  MergeView keeps the vertical offsets aligned itself, but each editor
   *  carries its own horizontal scrollbar — so comparing two long lines meant
   *  scrolling one side, reading, scrolling the other side to the same place by
   *  eye, and reading again. Whichever side is moved now drags the other with
   *  it; a flag stops the two from pushing each other back and forth. */
  private linkHorizontalScroll(): void {
    const scrollers = [...this.body.querySelectorAll<HTMLElement>(".cm-scroller")];
    if (scrollers.length !== 2) return;
    let syncing = false;
    for (const from of scrollers) {
      from.addEventListener(
        "scroll",
        () => {
          if (syncing) return;
          syncing = true;
          for (const to of scrollers) {
            if (to !== from && to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
          }
          // Released after the scroll events this write produced have been
          // dispatched; clearing it synchronously would let them through.
          requestAnimationFrame(() => {
            syncing = false;
          });
        },
        { passive: true },
      );
    }
  }

  private updateModeButton(): void {
    const split = this.header.querySelector<HTMLButtonElement>(".js-mode-split")!;
    const inline = this.header.querySelector<HTMLButtonElement>(".js-mode-inline")!;
    const effective = this.effectiveMode;
    for (const [btn, on] of [[split, effective === "split"], [inline, effective !== "split"]] as const) {
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
    // What a button has to say, in order of what the reader needs: that the window is the
    // reason for the current shape; that per-chunk buttons live in the inline view; and
    // otherwise what the layout is.
    const forced = this.narrow && this.mode === "split";
    split.title = forced
      ? "The window is too narrow for two columns — widen it to get side-by-side back"
      : "Side by side: the older text on the left, the newer on the right";
    inline.title = this.onEdit && effective === "split" ? "Inline, to revert individual changes" : "Inline: one column, the changes in place";
    split.classList.toggle("is-forced", forced);
  }

  /** What the view actually draws, which is the stored preference unless the
   *  window has no room for two columns. */
  private get effectiveMode(): DiffMode {
    return this.narrow ? "unified" : this.mode;
  }

  /** Told by the shell when the window crosses the width where two columns
   *  stop being readable. */
  setNarrow(narrow: boolean): void {
    if (this.narrow === narrow) return;
    this.narrow = narrow;
    // Only worth redrawing when a pair is on screen and the shape changes.
    if (this.pair && this.mode === "split") this.render();
    else this.updateModeButton();
  }

  /** `onEdit` turns the working side into something you can change: the inline
   *  view then draws accept/reject buttons over every chunk, and reverting one
   *  is how you undo a single change out of twenty without touching the rest.
   *  Nothing is written to disk here — the caller decides what to do with the
   *  text it is handed.
   *
   *  `hunk` adds the other half of working one change at a time: staging it.
   *  The caller says what the verb is — "stage" against the working tree,
   *  "unstage" against the index — and is handed the index of the change the
   *  reader is standing on. */
  show(pair: DiffPair, onEdit?: (text: string) => void, onSwap?: () => void, hunk?: HunkAction): void {
    this.pair = pair;
    this.onEdit = onEdit;
    this.onSwap = onSwap;
    this.hunk = hunk;
    this.at = 0;
    this.render();
  }

  /** Stage (or unstage) the change the reader is on.
   *
   *  Deliberately tied to the navigation rather than to a button per band: the
   *  count and the ▲▼ pair already say which change is current, and one verb in
   *  the header is a shorter path than twenty buttons down the page — the more
   *  so in side-by-side, where the package draws no per-chunk controls at all.
   */
  private async applyCurrentHunk(): Promise<void> {
    if (!this.hunk || !this.at) return;
    this.header.querySelector<HTMLButtonElement>(".js-hunk-apply")!.disabled = true;
    try {
      // `at` is 1-based because it is a position in a list a human is reading.
      await this.hunk.apply(this.at - 1);
    } finally {
      // Not `disabled = false`: applying redraws the view against the new index,
      // which puts the reader back at "no change selected" — and re-enabling
      // the button here would offer to stage whichever one that is not.
      this.updateHunkButton();
    }
  }

  private updateHunkButton(): void {
    const button = this.header.querySelector<HTMLButtonElement>(".js-hunk-apply")!;
    button.hidden = !this.hunk || this.chunkCount === 0;
    if (button.hidden) return;
    button.textContent = this.at ? `${this.hunk!.label} this change` : `${this.hunk!.label} a change`;
    // Nothing is selected until the reader has stepped to a change, and a
    // button that would act on "the first one, probably" is worse than one that
    // says to pick.
    button.disabled = !this.at;
    button.title = this.at
      ? `${this.hunk!.label} change ${this.at} of ${this.chunkCount}`
      : "Pick a change with ▲ ▼ first";
  }

  /** Move to the next (or previous) change and say where we are.
   *
   *  "n changes" and a way to walk them is the difference between reading a
   *  diff and hunting through one: with unchanged regions collapsed, a long
   *  file shows a handful of bands and no indication of how many more are
   *  below. */
  private step(delta: number): void {
    if (!this.chunkCount) return;
    const view = this.effectiveMode === "split" ? this.merge?.b : this.single;
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
    this.updateHunkButton();
  }

  clear(): void {
    this.pair = null;
    this.dispose();
    this.body.innerHTML = "";
  }

  setTheme(dark: boolean): void {
    this.dark = dark;
    const effects = [this.cDark.reconfigure(cmDark(dark)), this.cHighlight.reconfigure(this.highlight())];
    for (const view of [this.merge?.a, this.merge?.b, this.single]) view?.dispatch({ effects });
  }

  private highlight(): Extension {
    return syntaxHighlighting(this.dark ? oneDarkHighlightStyle : defaultHighlightStyle);
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
      // Every editor of a diff carries the nonce itself. The <style> a view mounts is admitted by it,
      // and whichever view mounts first is the one that decides whether the styles are dropped: the
      // schema diff (kafka-diff.js) has no other editor on the page to have done it before.
      EditorView.cspNonce.of(cspNonce),
      cmBase,
      theme,
      // In compartments, so that a theme switch changes the colours of the views that are there.
      this.cDark.of(cmDark(this.dark)),
      this.cHighlight.of(this.highlight()),
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
    this.updateModeButton();

    this.chunkCount = 0;
    this.updateCount();
    this.header.querySelector<HTMLElement>(".js-swap")!.hidden = !this.onSwap;

    // Which column is which. The header said it once, in a sentence, above a
    // view that scrolls — so halfway down a long file the only way to tell the
    // sides apart was the colours, which say "removed/added" and not "yours/
    // theirs". These sit over the columns and stay there.
    const columns = this.host.querySelector<HTMLElement>(".js-columns")!;
    const twoColumns = this.effectiveMode === "split" && pair.before !== null && pair.after !== null && !pair.binary;
    columns.hidden = !twoColumns;
    if (twoColumns) {
      // startTrimmed: these headers truncate at the start, and a label
      // beginning with a neutral character would otherwise be reordered.
      this.host.querySelector<HTMLElement>(".js-col-a")!.textContent = startTrimmed(pair.beforeLabel);
      this.host.querySelector<HTMLElement>(".js-col-b")!.textContent = startTrimmed(pair.afterLabel);
    }

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
    // Normalised before deciding "identical": a file that differs only by CRLF
    // or by a trailing newline is not a difference anyone asked about, and the
    // strict comparison this used to do let such a file through as a diff —
    // two identical-looking columns, no highlighting, and nothing saying why.
    const normalise = (s: string): string => s.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    // Two copies of both texts, to compare them — only when they could be equal after it. A text
    // with no carriage return and the same run of newlines at its end is changed by normalising
    // in no way at all, so then they are the same exactly when they are the same already.
    const trailing = (s: string): number => {
      let n = 0;
      while (n < s.length && s.charCodeAt(s.length - 1 - n) === 10) n++;
      return n;
    };
    const couldMatch = before.includes("\r") || after.includes("\r") || trailing(before) !== trailing(after);
    if (before === after || (couldMatch && normalise(before) === normalise(after))) {
      const onlyWhitespace = before !== after;
      this.body.innerHTML = `<div class="diff-note">No changes — ${esc(pair.beforeLabel)} and ${esc(pair.afterLabel)} are identical${
        onlyWhitespace ? ", apart from line endings" : ""
      }.</div>`;
      return;
    }

    // The number of changes is the view's own, read once it exists (below): it used to be worked
    // out here from both whole texts, and then again by the view. A pair seen before has it already.
    const seen = this.counted;
    if (seen && seen.before === before && seen.after === after) {
      this.chunkCount = seen.n;
      this.updateCount();
    }

    // collapseUnchanged keeps long files navigable; margin leaves a few lines of
    // context around every change so a hunk is never shown without its bearings.
    const collapse = { margin: 3, minSize: 6 };

    if (this.effectiveMode === "split") {
      this.merge = new MergeView({
        a: { doc: before, extensions: this.base(pair.path) },
        b: { doc: after, extensions: this.base(pair.path) },
        parent: this.body,
        collapseUnchanged: collapse,
        highlightChanges: true,
        gutter: true,
      });
      this.linkHorizontalScroll();
      this.chunkCount = this.merge.chunks.length;
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
      this.chunkCount = getChunks(this.single.state)?.chunks.length ?? 0;
    }
    this.counted = { before, after, n: this.chunkCount };
    this.updateCount();
  }
}
