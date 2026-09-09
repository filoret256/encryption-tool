/** Merge-conflict resolution inside the editor.
 *
 *  When a merge or rebase stops, git has already written the conflict markers
 *  into the working file. So there is nothing to reconstruct: this parses what
 *  git wrote, colours the two sides, and offers the three actions that resolve
 *  a region — take ours, take theirs, or keep both. Accepting rewrites the
 *  region in the document like any other edit, which means undo works and the
 *  file is saved through the normal path.
 *
 *  Both marker styles are handled: the default one and diff3's, which inserts a
 *  `|||||||` base section between the two sides.
 */
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

export interface ConflictRegion {
  /** Document offsets covering the whole region, markers included. */
  from: number;
  to: number;
  /** Text of each side, without the marker lines. */
  ours: string;
  theirs: string;
  base: string | null;
  oursLabel: string;
  theirsLabel: string;
}

// The trailing \r? matters: git writes CRLF on Windows, and JavaScript treats
// \r as a line terminator, so `.` never matches it and an unanchored `$` would
// not either. CodeMirror normalises line endings, but this parser is also used
// on raw file text.
const OURS = /^<{7}(?: (.*?))?\r?$/;
const BASE = /^\|{7}(?: (.*?))?\r?$/;
const SPLIT = /^={7}\r?$/;
const THEIRS = /^>{7}(?: (.*?))?\r?$/;

/** Parse every conflict region in a document. Malformed or unterminated
 *  regions are skipped rather than guessed at — a half-understood conflict is
 *  worse than none. */
export function findConflicts(doc: { lines: number; line(n: number): { from: number; to: number; text: string } }): ConflictRegion[] {
  const out: ConflictRegion[] = [];
  let n = 1;

  while (n <= doc.lines) {
    const start = doc.line(n);
    const opening = OURS.exec(start.text);
    if (!opening) {
      n++;
      continue;
    }

    const oursLines: string[] = [];
    const baseLines: string[] = [];
    const theirsLines: string[] = [];
    let section: "ours" | "base" | "theirs" = "ours";
    let theirsLabel = "";
    let end = -1;

    let i = n + 1;
    for (; i <= doc.lines; i++) {
      const line = doc.line(i);
      if (OURS.test(line.text)) break; // a nested opener means this one is malformed
      if (BASE.test(line.text)) {
        section = "base";
        continue;
      }
      if (SPLIT.test(line.text)) {
        section = "theirs";
        continue;
      }
      const closing = THEIRS.exec(line.text);
      if (closing) {
        theirsLabel = closing[1] ?? "";
        end = i;
        break;
      }
      (section === "ours" ? oursLines : section === "base" ? baseLines : theirsLines).push(line.text);
    }

    if (end === -1) {
      n++; // unterminated: leave it alone
      continue;
    }

    out.push({
      from: start.from,
      to: doc.line(end).to,
      ours: oursLines.join("\n"),
      theirs: theirsLines.join("\n"),
      base: baseLines.length ? baseLines.join("\n") : null,
      oursLabel: opening[1] ?? "current",
      theirsLabel: theirsLabel || "incoming",
    });
    n = end + 1;
  }
  return out;
}

class ActionsWidget extends WidgetType {
  constructor(private readonly region: ConflictRegion) {
    super();
  }

  /** Two widgets are equal when they resolve the same text, so CodeMirror can
   *  reuse the DOM instead of rebuilding it on every keystroke elsewhere. */
  eq(other: ActionsWidget): boolean {
    return (
      this.region.from === other.region.from &&
      this.region.ours === other.region.ours &&
      this.region.theirs === other.region.theirs
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cf-actions";

    const add = (label: string, title: string, replacement: string): void => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cf-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("mousedown", (e) => {
        // mousedown, not click: the editor would otherwise move the selection
        // into the region before the handler runs.
        e.preventDefault();
        view.dispatch({ changes: { from: this.region.from, to: this.region.to, insert: replacement } });
      });
      bar.appendChild(b);
    };

    const { ours, theirs, oursLabel, theirsLabel } = this.region;
    add("accept current", `Keep ${oursLabel}`, ours);
    add("accept incoming", `Keep ${theirsLabel}`, theirs);
    add("accept both", "Keep both sides, current first", ours + (ours && theirs ? "\n" : "") + theirs);
    return bar;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const lineDeco = {
  ours: Decoration.line({ class: "cf-ours" }),
  base: Decoration.line({ class: "cf-base" }),
  theirs: Decoration.line({ class: "cf-theirs" }),
  marker: Decoration.line({ class: "cf-marker" }),
};

function build(state: EditorState): DecorationSet {
  const { doc } = state;
  const builder = new RangeSetBuilder<Decoration>();

  for (const region of findConflicts(doc)) {
    builder.add(region.from, region.from, Decoration.widget({ widget: new ActionsWidget(region), block: true, side: -1 }));

    // Walk the region line by line so each one gets the colour of its side.
    let side: keyof typeof lineDeco = "marker";
    let pos = region.from;
    while (pos <= region.to) {
      const line = doc.lineAt(pos);
      if (OURS.test(line.text) || THEIRS.test(line.text)) side = "marker";
      else if (BASE.test(line.text)) side = "marker";
      else if (SPLIT.test(line.text)) side = "marker";

      builder.add(line.from, line.from, lineDeco[side]);

      // The next line belongs to whichever section this marker opened.
      if (OURS.test(line.text)) side = "ours";
      else if (BASE.test(line.text)) side = "base";
      else if (SPLIT.test(line.text)) side = "theirs";

      if (line.to >= region.to) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** Highlight conflict regions and offer the resolution actions. Harmless on a
 *  file with no markers — it simply produces no decorations.
 *
 *  A StateField rather than a ViewPlugin: the action bars are block widgets,
 *  and CodeMirror refuses those from a plugin because they change line heights
 *  after measuring. That also means the whole document is scanned rather than
 *  just the viewport, which is fine — a conflicted file is one someone is in
 *  the middle of resolving, not a generated megabyte.
 */
export function conflictHighlighter(): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => build(state),
    update: (deco, tr) => (tr.docChanged ? build(tr.state) : deco),
    provide: (field) => EditorView.decorations.from(field),
  });
}
