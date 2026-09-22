/** The chrome every CodeMirror in this app shares.
 *
 *  There are three of them — the fixed YAML editor of the crypto tabs
 *  (editor.ts), the file editor of the code tab (code/editor.ts) and the diff
 *  (code/diff.ts) — and each used to carry its own copy of these rules. The
 *  copies drifted: the same file selected in the editor and in the diff did not
 *  look the same, the diff had no selection colour of its own at all, and the
 *  one the crypto editor asked for was never applied while it had focus (see
 *  the selection rules below for why).
 *
 *  What lives here is what all three should answer the same way: the surface,
 *  the gutters, the cursor, the selection and the highlights derived from it.
 *  What legitimately differs — font size, height, the whitespace glyphs only
 *  one of them draws — stays with the editor it belongs to, which adds its own
 *  theme after this one and so wins where the two touch the same rule.
 */
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** The tint over the line the cursor is on.
 *
 *  Translucent, and that is the whole point. CodeMirror draws the selection in
 *  a layer *behind* the content (`.cm-selectionLayer` is at z-index -1), while
 *  the current-line highlight is a line decoration inside it — so an opaque
 *  line background hides the selection on exactly the line the cursor is on,
 *  which is every line anyone has just selected something on. A tint composites
 *  over the selection instead of replacing it; CodeMirror's own default avoids
 *  the same trap the same way (#cceeff44). Built from --text rather than fixed,
 *  so one value serves both themes. */
const ACTIVE_LINE = "color-mix(in srgb, var(--text) 6%, transparent)";

export const cmBase: Extension = EditorView.theme({
  "&": { backgroundColor: "var(--panel)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.5" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--text-muted)", borderRight: "1px solid var(--border)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-activeLine": { backgroundColor: ACTIVE_LINE },
  ".cm-activeLineGutter": { backgroundColor: ACTIVE_LINE },
  ".cm-selectionBackground": { background: "color-mix(in srgb, var(--sel) 55%, transparent)" },
  // The long selector is not decoration: CodeMirror's own rule for the focused
  // selection is `&dark.cm-focused > .cm-scroller > .cm-selectionLayer …`, and
  // a shorter one loses to it on specificity — silently, and only in the
  // focused editor, which is the only one anybody looks at. Same shape as the
  // one-dark theme uses, for the same reason.
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { background: "var(--sel)" },
  ".cm-content ::selection": { background: "var(--sel)" },
  // Other occurrences of what is selected. Derived from the selection colour
  // and weaker than it: this used to be @codemirror/search's stock green, which
  // belonged to no palette here and — being a mark decoration, i.e. above the
  // selection layer — was the brightest thing on screen while the selection it
  // was derived from was the one thing not visible at all. The outline is what
  // carries it: a wash this weak disappears on a light background, and turning
  // the wash up would make an occurrence look as selected as the selection,
  // which is the thing being fixed.
  ".cm-selectionMatch": {
    background: "color-mix(in srgb, var(--sel) 40%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--sel) 80%, transparent)",
    borderRadius: "2px",
  },
  // Same reasoning for the find panel's matches, stock yellow and orange
  // otherwise: the current one is the accent, the rest are a wash of it.
  ".cm-searchMatch": {
    background: "color-mix(in srgb, var(--accent) 26%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    background: "color-mix(in srgb, var(--accent) 50%, transparent)",
    outline: "1px solid var(--accent)",
  },
});

/** Which way the theme faces, for CodeMirror's own styles.
 *
 *  Everything CodeMirror paints itself — the find panel, the completion popup,
 *  tooltips, the scrollbar — is keyed on `&dark`, and without this an editor in
 *  a dark window keeps the light ones. It is a theme, so an editor that can be
 *  switched has to hold it in a compartment and reconfigure it; swapping the
 *  syntax highlighting alone is only half of "dark". */
export function cmDark(dark: boolean): Extension {
  return EditorView.theme({}, { dark });
}
