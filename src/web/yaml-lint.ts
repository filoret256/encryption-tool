/** YAML validity diagnostics, shared by the CodeMirror linter (inline squiggles)
 *  and the toolbar badge. Uses the `yaml` lib, which reports errors with offset
 *  ranges that map straight onto CodeMirror Diagnostic positions. */
import { parseDocument } from "yaml";
import type { Diagnostic } from "@codemirror/lint";

/** The longest text the page checks, in characters.
 *
 *  The `yaml` library parses in more than linear time — measured on lines of `key: value`:
 *  64 KB takes 54 ms, 128 KB 146 ms, 256 KB 0.6 s, 1 MB 10 s, 2 MB 56 s — and this runs on the
 *  thread that draws, after every pause in typing. A 2 MB file with the check on was a minute of
 *  a page that answered nothing. Above this the text is not parsed, and the badge says so rather
 *  than say "valid". */
export const YAML_LINT_MAX = 128 * 1024;

export const yamlTooLarge = (text: string): boolean => text.length > YAML_LINT_MAX;

/** The last answer. Two things ask about one text — the toolbar badge, on its pause after a
 *  keystroke, and the editor's linter, on its own timer — and each parsed it for itself. Whoever
 *  asks second gets the first one's answer; a text that is not the same is parsed again. The
 *  array is shared, so neither may change it. */
let last: { text: string; result: Diagnostic[] } | null = null;
let parses = 0;

/** How many times a text has been parsed, for the test that says it is once. */
export const yamlParseCount = (): number => parses;

export function yamlDiagnostics(text: string): Diagnostic[] {
  if (!text.trim() || yamlTooLarge(text)) return [];
  if (last && last.text === text) return last.result;
  const result = parse(text);
  last = { text, result };
  return result;
}

function parse(text: string): Diagnostic[] {
  parses++;
  let doc;
  try {
    doc = parseDocument(text, { prettyErrors: false });
  } catch {
    return [];
  }
  return doc.errors.map((e) => {
    const [from, to] = e.pos;
    return { from, to: Math.max(to, from + 1), severity: "error" as const, message: e.message };
  });
}
