/** Turning one change in a diff back into a patch git will apply.
 *
 *  Staging a single hunk is `git apply --cached` with a unified diff on stdin —
 *  there is no "stage lines 40 to 52" in git's porcelain. The agent grew
 *  `git.applyPatch` for the delivery; this is the half that has to write a
 *  patch git accepts, which is stricter than it looks:
 *
 *    - the line counts in `@@` must match the body exactly, or the patch is
 *      rejected outright;
 *    - a range of zero lines starts at the line *before* it, not at its own
 *      first line, so an insertion at the top of a file is `-0,0`;
 *    - a file whose last line has no newline needs `\ No newline at end of
 *      file` after that line, on whichever side lacks it, or git applies the
 *      patch and silently adds one.
 *
 *  The chunks come from the same `Chunk.build` the diff view draws with, so
 *  hunk *n* here is the band the reader is looking at and not an
 *  approximation of it.
 */
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

/** Lines of context on each side of a hunk.
 *
 *  Three is what git itself defaults to, and the number matters: `git apply`
 *  locates a hunk by its context, so a patch built with none is a patch git has
 *  to guess the position of. */
const CONTEXT = 3;

/** A file as git counts it: lines, and whether the last one is terminated.
 *
 *  `"a\nb\n"` is two lines with a newline after the second; `"a\nb"` is two
 *  lines without one. Splitting on "\n" cannot tell them apart on its own —
 *  the first produces a trailing "" that is not a line at all. */
function gitLines(text: string): { lines: string[]; eol: boolean } {
  if (text === "") return { lines: [], eol: true };
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") {
    parts.pop();
    return { lines: parts, eol: true };
  }
  return { lines: parts, eol: false };
}

const NO_EOL = "\\ No newline at end of file";

interface Range {
  /** 0-based, half-open, in git lines. */
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** The chunks of a diff as line ranges, in the order the view shows them.
 *
 *  `Chunk.build` reports document offsets over the text as CodeMirror holds it,
 *  which includes the empty trailing "line" a terminated file ends with. The
 *  conversion below goes through the *last character* of a range rather than
 *  its end offset, because a chunk ends at the start of the following line and
 *  asking which line that offset is in would name one line too many.
 */
function ranges(before: string, after: string, lenA: number, lenB: number): Range[] {
  const docA = Text.of(before.split("\n"));
  const docB = Text.of(after.split("\n"));
  const out: Range[] = [];
  for (const c of Chunk.build(docA, docB)) {
    const a0 = docA.lineAt(c.fromA).number - 1;
    const b0 = docB.lineAt(c.fromB).number - 1;
    const a1 = c.toA > c.fromA ? docA.lineAt(c.toA - 1).number : a0;
    const b1 = c.toB > c.fromB ? docB.lineAt(c.toB - 1).number : b0;
    // Clamped: a chunk reaching the end of a terminated file covers that
    // trailing empty element, which is not a line git has a number for.
    out.push({ a0: Math.min(a0, lenA), a1: Math.min(a1, lenA), b0: Math.min(b0, lenB), b1: Math.min(b1, lenB) });
  }
  // A chunk that clamps away to nothing on both sides is the trailing element
  // and nothing else — there is no line in it to stage.
  return out.filter((r) => r.a1 > r.a0 || r.b1 > r.b0);
}

/** One patch per change, in the order the diff view shows them.
 *
 *  `before` and `after` are the two sides exactly as they came from the agent.
 *  Which is which matters: staging means "make the index look like the
 *  worktree", so `before` is the index side and `after` the worktree side, and
 *  the same patch reversed is what unstages it.
 */
export function hunkPatches(path: string, before: string, after: string): string[] {
  const a = gitLines(before);
  const b = gitLines(after);
  const header = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];

  return ranges(before, after, a.lines.length, b.lines.length).map(({ a0, a1, b0, b1 }) => {
    // Before the change the two files are identical, so one leading-context
    // length serves both sides.
    const lead = Math.min(CONTEXT, a0, b0);
    const tailA = Math.min(CONTEXT, a.lines.length - a1);
    const tail = Math.min(tailA, b.lines.length - b1);

    const startA = a0 - lead;
    const startB = b0 - lead;
    const countA = a1 - a0 + lead + tail;
    const countB = b1 - b0 + lead + tail;

    const body: string[] = [];
    for (let i = startA; i < a0; i++) body.push(` ${a.lines[i]}`);
    for (let i = a0; i < a1; i++) {
      body.push(`-${a.lines[i]}`);
      // The marker sits directly after the line it describes, which is this one
      // only when it is the file's last and the file does not end in a newline.
      if (i === a.lines.length - 1 && !a.eol) body.push(NO_EOL);
    }
    for (let i = b0; i < b1; i++) {
      body.push(`+${b.lines[i]}`);
      if (i === b.lines.length - 1 && !b.eol) body.push(NO_EOL);
    }
    for (let i = 0; i < tail; i++) {
      body.push(` ${a.lines[a1 + i]}`);
      // A context line is shared, so one marker covers both sides — but only if
      // both sides really do end here unterminated.
      if (a1 + i === a.lines.length - 1 && !a.eol && !b.eol) body.push(NO_EOL);
    }

    // A zero-length range is written at the line before it: "-0,0" for a file
    // that had nothing, "-12,0" for an insertion after line 12.
    const at = (start: number, count: number): string => `${count === 0 ? start : start + 1},${count}`;
    const hunk = `@@ -${at(startA, countA)} +${at(startB, countB)} @@`;
    return [...header, hunk, ...body, ""].join("\n");
  });
}
