/** CodeMirror instance for the code tab.
 *
 *  Separate from src/web/editor.ts: that one is a fixed YAML editor for the
 *  crypto tabs, this one swaps grammars per file (see grammars.ts).
 *
 *  It holds exactly one document at a time. The tab bar lives in index.ts and
 *  keeps an EditorState per open file, swapping them through `state` — that way
 *  each tab keeps its own cursor, scroll position and undo history, which is
 *  the whole point of having tabs rather than just re-reading the file.
 */
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { grammarFor } from "./grammars.ts";
import { conflictHighlighter } from "./conflicts.ts";

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--panel)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.5", overflow: "auto" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--text-muted)", borderRight: "1px solid var(--border)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-activeLine": { backgroundColor: "var(--bg)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg)" },
});

export class CodeEditor {
  readonly view: EditorView;
  private cLang = new Compartment();
  private cTheme = new Compartment();
  private cReadOnly = new Compartment();

  constructor(
    parent: HTMLElement,
    private dark: boolean,
    private readonly onSave: () => void,
    /** Fired on every document change; the tab bar recomputes dirtiness. */
    private readonly onChange: () => void,
  ) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: "", extensions: this.extensions(null, false) }),
    });
  }

  private extensions(lang: Extension | null, readOnly: boolean): Extension[] {
    return [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      search(),
      highlightSelectionMatches(),
      placeholder("Select a file in the explorer"),
      // Inert unless git has written conflict markers into the file.
      conflictHighlighter(),
      this.cLang.of(lang ? [lang] : []),
      this.cTheme.of(syntaxHighlighting(this.dark ? oneDarkHighlightStyle : defaultHighlightStyle)),
      this.cReadOnly.of(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      theme,
      keymap.of([
        // Ctrl/Cmd+S must not fall through to the browser's save-page dialog.
        { key: "Mod-s", preventDefault: true, run: () => (this.onSave(), true) },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) this.onChange();
      }),
    ];
  }

  get value(): string {
    return this.view.state.doc.toString();
  }

  /** The live state of the document on screen, for stashing against a tab. */
  get state(): EditorState {
    return this.view.state;
  }

  /** Put a previously stashed tab back on screen. A stashed state still carries
   *  whatever theme was current when it was stashed, so re-apply it here. */
  set state(state: EditorState) {
    this.view.setState(state);
    this.applyTheme();
  }

  /** Build a fresh state for a file. Fresh rather than a big change
   *  transaction, so undo cannot walk back into the previous document. */
  newState(path: string, text: string, readOnly: boolean): EditorState {
    return EditorState.create({ doc: text, extensions: this.extensions(grammarFor(path), readOnly) });
  }

  setTheme(dark: boolean): void {
    this.dark = dark;
    this.applyTheme();
  }

  private applyTheme(): void {
    this.view.dispatch({
      effects: this.cTheme.reconfigure(syntaxHighlighting(this.dark ? oneDarkHighlightStyle : defaultHighlightStyle)),
    });
  }

  focus(): void {
    this.view.focus();
  }

  /** Put the cursor on a 1-based line / 0-based column and scroll it into the
   *  middle of the viewport — used when jumping from a search result. */
  revealPosition(line: number, col: number): void {
    const doc = this.view.state.doc;
    const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const pos = Math.min(target.from + col, target.to);
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    this.view.focus();
  }
}
