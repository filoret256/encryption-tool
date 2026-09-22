/** CodeMirror 6 editor wrapper — one instance per tab. Editor-agnostic API so
 *  main.ts never touches CM internals. Replaces the heavyweight Monaco wrapper. */
import { Compartment, EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  drawSelection,
  highlightWhitespace,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  bracketMatching,
  codeFolding,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { linter, lintGutter } from "@codemirror/lint";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { yamlDiagnostics } from "./yaml-lint.ts";
import { cspNonce } from "./csp.ts";
import { cmBase, cmDark } from "./cm-theme.ts";
import { prefersDark } from "./theme.ts";

export type Tab = "ansible" | "helm";
export interface ViewPrefs {
  lineNumbers: boolean;
  whitespace: boolean;
  wrap: boolean;
  fold: boolean;
}

const PREFS_KEY = "enc-cm-prefs";

function loadPrefs(): Record<Tab, ViewPrefs> {
  const defaults: ViewPrefs = { lineNumbers: true, whitespace: false, wrap: false, fold: true };
  const fallback: Record<Tab, ViewPrefs> = { ansible: { ...defaults }, helm: { ...defaults } };
  try {
    // Merged per tab, not at the top level. A shallow spread replaces each
    // stored tab object wholesale, so every preference added after someone's
    // first visit would arrive as undefined for exactly the people who have
    // been using the app longest.
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") as Partial<Record<Tab, Partial<ViewPrefs>>>;
    return {
      ansible: { ...defaults, ...stored.ansible },
      helm: { ...defaults, ...stored.helm },
    };
  } catch {
    return fallback;
  }
}

const prefs = loadPrefs();
function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

// Editor chrome follows the app theme via CSS variables; the surface, gutters,
// cursor and selection are cmBase, shared with the code tab and the diff, and
// what is left here is this editor's own. The selection used to be a rule of
// its own asking for var(--active) through a short selector — which, it turns
// out, CodeMirror's own focused-selection rule outranks, so the colour applied
// only while the editor was *not* focused. cmBase carries the selector shape
// that works, and the same colour as everywhere else.
const baseTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { fontSize: "13px", overflow: "auto" },
  // Whitespace glyphs (·, →, ¬) share the muted colour so they don't distract.
  ".cm-highlightSpace:before, .cm-highlightTab, .cm-eol": { color: "var(--text-muted)", opacity: "0.6" },
  ".cm-eol": { paddingLeft: "1px" },
});

// `highlightWhitespace()` only renders spaces (·) and tabs (→); CM6 has no
// built-in newline glyph. This plugin draws a muted ␊ (U+240A, the Unicode
// "control picture" for the 0x0A line-feed byte) at every line break so the
// "show whitespace" toggle reveals end-of-line characters too. CM normalises all
// line endings to LF on input, so there is never a stray CR (0x0D) to mark.
class EolWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-eol";
    el.textContent = "␊";
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}
const eolDeco = Decoration.widget({ widget: new EolWidget(), side: 1 });

const showEol = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const { doc } = view.state;
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = doc.lineAt(pos);
          if (line.number < doc.lines) builder.add(line.to, line.to, eolDeco); // skip final line (no trailing newline)
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

// Bundled so the single "ws" toggle reveals spaces, tabs and newlines together.
const whitespaceView = [highlightWhitespace(), showEol];

// Folding: the gutter arrows, the state field they act on, and the keyboard
// commands, together — with the toggle off none of the three should be present.
const foldView = [codeFolding(), foldGutter(), keymap.of(foldKeymap)];

const yamlLinter = linter((view) => yamlDiagnostics(view.state.doc.toString()));

export class TabEditor {
  readonly view: EditorView;
  private cLine = new Compartment();
  private cWrap = new Compartment();
  private cWs = new Compartment();
  private cFold = new Compartment();
  private cLint = new Compartment();
  private cHighlight = new Compartment();
  private cDark = new Compartment();
  private changeCb: (() => void) | null = null;

  /** `readOnly` is for the result pane in two-pane mode: it holds output, and
   *  typing into it would produce something neither side accounts for. */
  constructor(private readonly tab: Tab, parent: HTMLElement, placeholderText: string, readOnly = false) {
    const p = prefs[tab];
    // Same answer main.ts starts from, including "no choice yet — ask the
    // system"; reading the key directly meant this editor built itself light
    // and was corrected a moment later by the first applyTheme().
    const dark = prefersDark();
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [
          // First, so CodeMirror has it before it mounts a single style module.
          EditorView.cspNonce.of(cspNonce),
          this.cLine.of(TabEditor.extensionFor("lineNumbers", p.lineNumbers)),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          yamlLang(),
          this.cHighlight.of(syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle)),
          this.cDark.of(cmDark(dark)),
          // Shared chrome first, this editor's own after it: where both name
          // the same rule, the one that comes later is the one that applies.
          cmBase,
          baseTheme,
          cmPlaceholder(placeholderText),
          search(),
          this.cWs.of(TabEditor.extensionFor("whitespace", p.whitespace)),
          this.cWrap.of(TabEditor.extensionFor("wrap", p.wrap)),
          this.cFold.of(TabEditor.extensionFor("fold", p.fold)),
          this.cLint.of([]),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          // closeBrackets first: it owns Backspace over an auto-inserted pair,
          // which the default keymap would otherwise take.
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged || u.selectionSet) this.changeCb?.();
          }),
        ],
      }),
    });
  }

  get value(): string {
    return this.view.state.doc.toString();
  }
  set value(v: string) {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: v } });
  }

  get lineCount(): number {
    return this.view.state.doc.lines;
  }
  selectionLength(): number {
    return this.view.state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0);
  }

  /** The selected text, or "" when nothing is selected. One range: encrypting
   *  several disjoint selections into one envelope would produce something
   *  that decrypts to a concatenation nobody asked for. */
  get selectedText(): string {
    const r = this.view.state.selection.main;
    return r.empty ? "" : this.view.state.sliceDoc(r.from, r.to);
  }

  /** Put text where the selection is, leaving the rest of the document alone. */
  replaceSelection(text: string): void {
    const r = this.view.state.selection.main;
    this.view.dispatch({ changes: { from: r.from, to: r.to, insert: text } });
  }

  focus(): void {
    this.view.focus();
  }
  /** Re-measure after the tab becomes visible (CM lays out lazily when hidden). */
  refresh(): void {
    this.view.requestMeasure();
  }
  onChange(cb: () => void): void {
    this.changeCb = cb;
  }

  /** What a preference switches on. Stated once, so the constructor and the
   *  toggle cannot drift — which a chain of ternaries in each was inviting. */
  private static extensionFor(kind: keyof ViewPrefs, on: boolean): Extension {
    if (!on) return [];
    switch (kind) {
      case "lineNumbers":
        return lineNumbers();
      case "whitespace":
        return whitespaceView;
      case "wrap":
        return EditorView.lineWrapping;
      case "fold":
        return foldView;
    }
  }

  toggle(kind: keyof ViewPrefs): boolean {
    const p = prefs[this.tab];
    p[kind] = !p[kind];
    savePrefs();
    const compartment: Record<keyof ViewPrefs, Compartment> = {
      lineNumbers: this.cLine,
      whitespace: this.cWs,
      wrap: this.cWrap,
      fold: this.cFold,
    };
    this.view.dispatch({ effects: compartment[kind].reconfigure(TabEditor.extensionFor(kind, p[kind])) });
    return p[kind];
  }
  isOn(kind: keyof ViewPrefs): boolean {
    return prefs[this.tab][kind];
  }

  /** Toggle live YAML validity squiggles + gutter markers. */
  setLint(on: boolean): void {
    this.view.dispatch({ effects: this.cLint.reconfigure(on ? [yamlLinter, lintGutter()] : []) });
  }

  openFind(): void {
    openSearchPanel(this.view); // CM's panel includes replace fields
  }

  setTheme(dark: boolean): void {
    this.view.dispatch({
      effects: [
        this.cHighlight.reconfigure(syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle)),
        this.cDark.reconfigure(cmDark(dark)),
      ],
    });
  }
}
