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
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
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

export class DiffView {
  private merge: MergeView | null = null;
  private single: EditorView | null = null;
  private pair: DiffPair | null = null;
  private mode: DiffMode = "split";

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
        <button class="t-btn js-mode" type="button">inline</button>
      </div>
      <div class="diff-body"></div>`;
    this.header = host.querySelector(".diff-head")!;
    this.body = host.querySelector(".diff-body")!;
    this.header.querySelector(".js-mode")!.addEventListener("click", () => {
      this.mode = this.mode === "split" ? "unified" : "split";
      this.render();
    });
  }

  show(pair: DiffPair): void {
    this.pair = pair;
    this.render();
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

  private base(path: string): Extension[] {
    const lang = grammarFor(path);
    return [
      lineNumbers(),
      theme,
      syntaxHighlighting(this.dark ? oneDarkHighlightStyle : defaultHighlightStyle),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      ...(lang ? [lang] : []),
    ];
  }

  private render(): void {
    const pair = this.pair;
    this.dispose();
    this.body.innerHTML = "";
    if (!pair) return;

    this.header.querySelector(".diff-path")!.textContent = pair.path;
    this.header.querySelector(".diff-labels")!.textContent = `${pair.beforeLabel} → ${pair.afterLabel}`;
    this.header.querySelector(".js-mode")!.textContent = this.mode === "split" ? "inline" : "side-by-side";

    if (pair.binary) {
      this.body.innerHTML = `<div class="diff-note">Binary file — no textual diff.</div>`;
      return;
    }
    if (pair.before === null && pair.after === null) {
      this.body.innerHTML = `<div class="diff-note">File does not exist on either side.</div>`;
      return;
    }

    const before = pair.before ?? "";
    const after = pair.after ?? "";
    if (before === after) {
      this.body.innerHTML = `<div class="diff-note">No changes (${esc(pair.beforeLabel)} and ${esc(pair.afterLabel)} are identical).</div>`;
      return;
    }

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
      this.single = new EditorView({
        parent: this.body,
        state: EditorState.create({
          doc: after,
          extensions: [
            unifiedMergeView({ original: before, mergeControls: false, collapseUnchanged: collapse }),
            ...this.base(pair.path),
          ],
        }),
      });
    }
  }
}
