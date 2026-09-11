/** Blame: who last touched each line, in a gutter beside it.
 *
 *  The agent has answered `git.blame` since the first version; nothing in the
 *  UI ever asked. "When and why did this line change" was a question you left
 *  the tool to answer, which for the one person on the team who lives in commit
 *  history made the editor a read-only viewer.
 *
 *  Two things make a blame gutter readable rather than noisy. Runs of the same
 *  commit are labelled once, at their first line — a file written in one sitting
 *  is otherwise the same name repeated forty times. And consecutive runs
 *  alternate a faint tint, so the blocks are visible as blocks without a border
 *  per line.
 *
 *  Blame describes the *committed* file. A buffer with unsaved edits has lines
 *  the last commit never had, so the caller is expected to say so rather than
 *  let the gutter imply otherwise.
 */
import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";

export interface BlameLine {
  oid: string;
  author: string;
  /** Author time, seconds since epoch. */
  time: number;
  /** 1-based line in the committed file. */
  line: number;
  /** Subject of the commit the line came from — shown on hover, so the gutter
   *  can answer "which change was this" without opening anything. */
  summary: string;
}

/** Rows for the open document, or null to take the gutter away. */
export const setBlame = StateEffect.define<BlameLine[] | null>();

/** Indexed by line so the gutter's per-line lookup is not a linear scan: a
 *  4000-line file redrawn on every scroll made that measurable. */
interface Blame {
  byLine: Map<number, BlameLine>;
  /** Which tint each commit gets — alternating, in the order runs appear. */
  shade: Map<string, 0 | 1>;
}

const blameField = StateField.define<Blame | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setBlame)) continue;
      if (!e.value) return null;
      const byLine = new Map<number, BlameLine>();
      const shade = new Map<string, 0 | 1>();
      let last = "";
      let next: 0 | 1 = 0;
      for (const row of e.value) {
        byLine.set(row.line, row);
        // A new run of a different commit flips the tint. The same commit
        // coming back later keeps the shade it was given first, so a file is
        // not a barcode.
        if (row.oid !== last) {
          if (!shade.has(row.oid)) {
            shade.set(row.oid, next);
            next = next === 0 ? 1 : 0;
          }
          last = row.oid;
        }
      }
      return { byLine, shade };
    }
    return value;
  },
});

class BlameMarker extends GutterMarker {
  constructor(
    private readonly row: BlameLine,
    private readonly first: boolean,
    private readonly shade: 0 | 1,
  ) {
    super();
  }

  override eq(other: BlameMarker): boolean {
    return other.row.oid === this.row.oid && other.first === this.first;
  }

  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = `cm-blame-cell shade-${this.shade}${this.first ? " first" : ""}`;
    // Everything the gutter has no width for. What the cell can show is a
    // first name and an age; the question it raises — *which change was this* —
    // needed a click and a lost reading position to answer, and the answer was
    // already in the reply git sent.
    el.title = [
      this.row.summary || "(no subject)",
      `${this.row.oid.slice(0, 8)} · ${this.row.author}`,
      absoluteDay(this.row.time),
      "Click to open this commit",
    ].join("\n");
    // Only the first line of a run is labelled; the rest carry the tint alone.
    el.textContent = this.first ? `${short(this.row.author)} ${when(this.row.time)}` : "";
    return el;
  }
}

/** Not-yet-committed lines. Blame reports these with the all-zero oid. */
const UNCOMMITTED = /^0+$/;

/** The date as a date, for the tooltip — where there is room to be unambiguous
 *  and no reason not to be. */
const absoluteDay = (seconds: number): string => {
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime())
    ? "unknown date"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

const when = (seconds: number): string => {
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return "?";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).slice(2)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** First name only: the gutter is narrow, and the full name is in the tooltip. */
const short = (author: string): string => author.split(/\s+/)[0] ?? author;

/** The blame gutter. `onPick` gets the oid of the commit a line came from. */
export function blameGutter(onPick: (oid: string) => void) {
  return [
    blameField,
    gutter({
      class: "cm-blame",
      lineMarker(view, block) {
        const blame = view.state.field(blameField, false);
        if (!blame) return null;
        const n = view.state.doc.lineAt(block.from).number;
        const row = blame.byLine.get(n);
        if (!row) return null;
        const prev = blame.byLine.get(n - 1);
        return new BlameMarker(row, prev?.oid !== row.oid, blame.shade.get(row.oid) ?? 0);
      },
      // Without this the gutter never appears for an empty document and, more
      // to the point, never re-measures when blame arrives.
      lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(setBlame))),
      domEventHandlers: {
        mousedown(view, block) {
          const blame = view.state.field(blameField, false);
          if (!blame) return false;
          const row = blame.byLine.get(view.state.doc.lineAt(block.from).number);
          if (!row || UNCOMMITTED.test(row.oid)) return false;
          onPick(row.oid);
          return true;
        },
      },
    }),
    EditorView.baseTheme({
      ".cm-blame": { cursor: "pointer" },
      ".cm-blame .cm-blame-cell": {
        display: "block",
        // "Alice 26-01-15" is fourteen characters; at thirteen every date in
        // the gutter ended in an ellipsis, which is the one part of the label
        // that has to be read exactly.
        width: "15ch",
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        paddingRight: "6px",
        fontSize: "0.85em",
        opacity: "0.75",
      },
      // The tint is what makes a run of lines read as one commit without a
      // repeated label or a rule between every pair of lines.
      ".cm-blame .cm-blame-cell.shade-1": { backgroundColor: "rgba(127, 127, 127, 0.14)" },
      ".cm-blame .cm-blame-cell.first": { opacity: "1" },
    }),
  ];
}

/** Is the gutter currently showing anything? */
export const hasBlame = (view: EditorView): boolean => view.state.field(blameField, false) != null;
