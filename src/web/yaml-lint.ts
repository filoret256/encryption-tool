/** YAML validity diagnostics, shared by the CodeMirror linter (inline squiggles)
 *  and the toolbar badge. Uses the `yaml` lib, which reports errors with offset
 *  ranges that map straight onto CodeMirror Diagnostic positions. */
import { parseDocument } from "yaml";
import type { Diagnostic } from "@codemirror/lint";

export function yamlDiagnostics(text: string): Diagnostic[] {
  if (!text.trim()) return [];
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
