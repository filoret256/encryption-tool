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

// Editor chrome follows the app theme via CSS variables; only the syntax-colour
// highlight style swaps between light/dark (see setTheme).
const baseTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--panel)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.5", overflow: "auto" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--text-muted)", borderRight: "1px solid var(--border)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  // Whitespace glyphs (·, →, ¬) share the muted colour so they don't distract.
  ".cm-highlightSpace:before, .cm-highlightTab, .cm-eol": { color: "var(--text-muted)", opacity: "0.6" },
  ".cm-eol": { paddingLeft: "1px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--active)",
  },
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

  constructor(private readonly tab: Tab, parent: HTMLElement, placeholderText: string) {
    const p = prefs[tab];
    const dark = localStorage.getItem("enc-theme") === "dark";
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [
          this.cLine.of(TabEditor.extensionFor("lineNumbers", p.lineNumbers)),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          yamlLang(),
          this.cHighlight.of(syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle)),
          this.cDark.of(EditorView.theme({}, { dark })),
          baseTheme,
          cmPlaceholder(placeholderText),
          search(),
          this.cWs.of(TabEditor.extensionFor("whitespace", p.whitespace)),
          this.cWrap.of(TabEditor.extensionFor("wrap", p.wrap)),
          this.cFold.of(TabEditor.extensionFor("fold", p.fold)),
          this.cLint.of([]),
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
        this.cDark.reconfigure(EditorView.theme({}, { dark })),
      ],
    });
  }
}
