/** How the kafka tab writes things down: sizes, counts, times, and the bytes of
 *  a message as something a person can read.
 *
 *  Keys and values arrive as base64 (src/kafka-agent/protocol.ts) because a
 *  Kafka value is not text until somebody decides it is. Deciding is done here,
 *  in the page, so that the same message can be read as text, as JSON, as hex
 *  or as base64 without asking the agent again.
 */
import type { ClusterState, SchemaState } from "../../kafka-agent/protocol.ts";
import { reindentJSON } from "./json-text.ts";

/** A word for a cluster state, for a tooltip or a line of the log. */
export const STATE_TEXT: Record<ClusterState, string> = {
  connected: "connected",
  unreachable: "unreachable",
  tls_failed: "TLS failed",
  auth_failed: "login failed",
  config_error: "configuration error",
};

/** The same for a Schema Registry, which has its own URL, login and stores (K-41). */
export const SCHEMA_TEXT: Record<SchemaState, string> = {
  not_configured: "not configured",
  connected: "connected",
  auth_failed: "login refused",
  unreachable: "unreachable",
  tls_failed: "TLS failed",
  error: "refused",
};

export function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** 1234567 → "1,234,567": counts are compared by eye, and the digits need grouping. */
export function formatCount(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

/** "1 partition", "2 partitions": a count and its noun, agreeing. */
export const plural = (n: number, noun: string): string => `${formatCount(n)} ${noun}${n === 1 ? "" : "s"}`;

const two = (n: number): string => String(n).padStart(2, "0");

/** A moment in the reader's own time zone, to the millisecond: "2026-01-02 03:04:05.678". */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** The value of a <input type="datetime-local"> for a moment, in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// ── bytes ─────────────────────────────────────────────────────────────────

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** The bytes as UTF-8, or null if they are not — the difference between text
 *  and something that would show as a row of replacement characters. */
export function asText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type Decoding = "auto" | "text" | "json" | "hex" | "base64";

export interface Decoded {
  /** What is shown. */
  text: string;
  /** How it was read, for the label and for the editor's language. */
  as: "text" | "json" | "hex" | "base64";
}

/** Read bytes the way the reader asked. "auto" is JSON when it parses as JSON,
 *  text when it is valid UTF-8, hex otherwise.
 *
 *  JSON is laid out in lines for the viewer without its numbers being read as doubles
 *  (json-text.ts). `indent: false` keeps the text of the value as it is, for a file. */
export function decode(b64: string | null, how: Decoding, indent = true): Decoded | null {
  if (b64 === null) return null;
  const bytes = fromBase64(b64);
  if (how === "base64") return { text: b64, as: "base64" };
  if (how === "hex") return { text: toHex(bytes), as: "hex" };
  const text = asText(bytes);
  if (text === null) return { text: toHex(bytes), as: "hex" };
  if (how === "text") return { text, as: "text" };
  // A bare number or string parses as JSON and is not what anyone means by it.
  const first = text.trimStart()[0];
  if (first === "{" || first === "[") {
    const laidOut = reindentJSON(text);
    if (laidOut !== null) return { text: indent ? laidOut : text, as: "json" };
  }
  return { text, as: "text" };
}

/** One line of a value, for a table cell: control characters made visible, cut at `max`. */
export function preview(b64: string | null, max = 240): string {
  if (b64 === null) return "";
  // Only the head of a value is looked at: a table row shows a line, and the
  // whole of a 256 KiB value is not worth decoding to draw it.
  const head = b64.length > max * 4 ? b64.slice(0, Math.ceil((max * 4) / 4) * 4) : b64;
  const bytes = fromBase64(head);
  // Not the strict decoder: the cut may fall inside a character, and that must
  // not turn a line of text into hex. A replacement character anywhere but the
  // very end is the real sign of bytes that are not text.
  const decoded = new TextDecoder("utf-8").decode(bytes);
  const text = head === b64 ? decoded : decoded.replace(/�$/, "");
  if (text.includes("�") || /[\u0000-\u0008\u000e-\u001f]/.test(text)) return toHex(bytes.subarray(0, Math.floor(max / 3)));
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** A base64 string in the page's own terms, for a header value or a key. */
export function shown(b64: string | null): string {
  if (b64 === null) return "";
  const bytes = fromBase64(b64);
  return asText(bytes) ?? toHex(bytes);
}

/** The id of the schema a Confluent wire value names: the four bytes after the zero byte. */
export function schemaIdOf(b64: string | null): number | null {
  if (!hasSchemaHeader(b64)) return null;
  const bytes = fromBase64(b64!.slice(0, 8));
  return ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
}

/** Does this value carry a schema? A Confluent wire value starts with one zero byte and the
 *  schema's four-byte id, so the first byte is the whole of the test the page can make. */
export function hasSchemaHeader(b64: string | null): boolean {
  if (b64 === null || b64.length < 8) return false;
  const bytes = fromBase64(b64.slice(0, 8));
  return bytes.length >= 5 && bytes[0] === 0;
}
