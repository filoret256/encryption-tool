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
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  codeFolding,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { grammarFor } from "./grammars.ts";
import { conflictHighlighter } from "./conflicts.ts";
import { blameGutter, hasBlame, setBlame, type BlameLine } from "./blame.ts";
import { cspNonce } from "../csp.ts";

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
    /** A blame line was clicked: the oid of the commit it came from. */
    private readonly onBlamePick: (oid: string) => void = () => {},
    /** The cursor moved, or the document under it changed. */
    private readonly onCursor: () => void = () => {},
  ) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: "", extensions: this.extensions(null, false) }),
    });
  }

  private extensions(lang: Extension | null, readOnly: boolean): Extension[] {
    return [
      // First, so CodeMirror has it before it mounts a single style module.
      EditorView.cspNonce.of(cspNonce),
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      codeFolding(),
      foldGutter(),
      autocompletion(),
      // A completion source of last resort. Several of the eighteen grammars
      // here carry none of their own — Dockerfile, ini, the legacy stream
      // modes — and in those the popup would never open at all. Words already
      // in the file are a poor completion set and a much better one than none.
      // Language-provided sources still take precedence where they exist.
      EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
      search(),
      highlightSelectionMatches(),
      placeholder("Select a file in the explorer"),
      // Inert unless git has written conflict markers into the file.
      conflictHighlighter(),
      // Inert until `setBlame` carries rows in; the gutter draws nothing
      // without them, so every document can afford to have it.
      blameGutter(this.onBlamePick),
      this.cLang.of(lang ? [lang] : []),
      this.cTheme.of(syntaxHighlighting(this.dark ? oneDarkHighlightStyle : defaultHighlightStyle)),
      this.cReadOnly.of(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      theme,
      // Order matters: closeBrackets claims Backspace over an auto-inserted
      // pair, and completion claims Escape and the arrow keys while its popup
      // is open — both would otherwise be taken by the default keymap first.
      keymap.of([
        // Ctrl/Cmd+S must not fall through to the browser's save-page dialog.
        { key: "Mod-s", preventDefault: true, run: () => (this.onSave(), true) },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...foldKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) this.onChange();
        // Selection moves without the document changing — that is most of what
        // a cursor position readout reports.
        if (u.docChanged || u.selectionSet) this.onCursor();
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

  /** Show blame beside the document on screen, or clear it with null.
   *
   *  Per document, not per editor: the rows live in the state, so a tab switch
   *  takes its own blame with it and cannot inherit the previous file's. */
  setBlame(rows: BlameLine[] | null): void {
    this.view.dispatch({ effects: setBlame.of(rows) });
  }

  get blaming(): boolean {
    return hasBlame(this.view);
  }

  /** Where the cursor is, 1-based, as a person counts.
   *
   *  The column is counted in characters, not bytes: a byte column is a thing
   *  a tool knows and a person does not. */
  get cursor(): { line: number; col: number; selected: number } {
    const { state } = this.view;
    const main = state.selection.main;
    const line = state.doc.lineAt(main.head);
    return { line: line.number, col: main.head - line.from + 1, selected: main.to - main.from };
  }

  /** Swap the syntax highlighting of the document on screen.
   *
   *  Through the same compartment the constructor sets up, so this is a
   *  reconfiguration rather than a new state — the buffer, the cursor and the
   *  undo history all stay. */
  setLanguage(lang: Extension | null): void {
    this.view.dispatch({ effects: this.cLang.reconfigure(lang ? [lang] : []) });
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

  /** Replace the whole document in one transaction.
   *
   *  One transaction, so a whole-file reformat is a single undo step rather
   *  than something the reader has to unpick line by line. */
  replaceAll(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
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
