/** The words of a Schema Registry, apart from the dialog that uses them (K-47).
 *
 *  How a reference is written down, what each compatibility level means, and how a level is
 *  named when it is the registry's default rather than the subject's own. None of this
 *  needs the page: it is text in and text out, which is why it lives here and not inside
 *  the dialog module — `bun run kafka-web:smoke` checks it without a browser.
 */
import type { SchemaReference, SchemaType } from "../../kafka-agent/protocol.ts";

/** The formats this build of the agent can write; the registry knows these three. */
export const SCHEMA_TYPES: SchemaType[] = ["AVRO", "PROTOBUF", "JSON"];

/** Every level the registry knows, least strict first: that is the order in which they
 *  cost a person something, and the order the registry itself lists them in. */
export const COMPATIBILITY_LEVELS = ["NONE", "BACKWARD", "BACKWARD_TRANSITIVE", "FORWARD", "FORWARD_TRANSITIVE", "FULL", "FULL_TRANSITIVE"];

/** What each level means, in the words of who may write next: the registry checks a new
 *  version against it, and these are the changes it will and will not take. */
export const COMPATIBILITY_TEXT: Record<string, string> = {
  NONE: "no check at all: any version is taken, however little it has to do with the last",
  BACKWARD: "a new version may add fields and drop optional ones; a reader using the new schema can read what the old one wrote",
  BACKWARD_TRANSITIVE: "the same, and checked against every earlier version, not only the last",
  FORWARD: "a new version may drop fields and add optional ones; a reader using the old schema can read what the new one writes",
  FORWARD_TRANSITIVE: "the same, and checked against every earlier version, not only the last",
  FULL: "both directions, so neither side needs the other to change first",
  FULL_TRANSITIVE: "both directions, and checked against every earlier version, not only the last",
};

/** The name a subject's level reads as, with the registry's default behind the empty one. */
export function compatibilityText(own: string | null, fallback: string | null): string {
  return own ?? (fallback ? `registry default (${fallback})` : "registry default");
}

/** References as the registry wants them: one `name subject version` per line, which is
 *  what a person copies out of a .proto's import. A line that is not one is returned as a
 *  sentence with the number of the line, because that is what has to be fixed. */
export function parseReferences(text: string): SchemaReference[] | string {
  const out: SchemaReference[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 3) return `References, line ${i + 1}: write it as name subject version`;
    const version = Number(parts[2]);
    if (!Number.isInteger(version) || version < 1) return `References, line ${i + 1}: the version is a whole number, 1 or more`;
    out.push({ name: parts[0], subject: parts[1], version });
  }
  return out;
}

/** A schema as it is shown and compared.
 *
 *  The registry keeps an Avro or JSON Schema as the one line it was registered with, and a
 *  diff of two one-line texts is one changed line from end to end. Written out with two spaces
 *  of indent, the same two versions differ in the lines that changed. A text that is not JSON
 *  (a .proto, or something the registry accepted that this cannot read) is returned as it is. */
export function prettySchema(type: string, text: string): string {
  if (type !== "AVRO" && type !== "JSON") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The two versions of a diff in the order they were registered: the older on the left, the
 *  newer on the right, whichever of them was open and whichever was clicked. */
export function diffOrder(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}
