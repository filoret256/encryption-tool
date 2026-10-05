/** Save what a topic's message list holds as a JSON Lines file (K-46).
 *
 *  One message per line, one JSON object per line: that is a file a person reads in an
 *  editor, `jq` reads a line at a time, and a log shipper takes whole — and it survives a
 *  message whose value is not text, because every value says how it was written.
 *
 *  The file is made in this page and handed to the browser as a download. Nothing is asked
 *  of the agent: the messages are already here, and an agent that could write files would
 *  be an agent that writes files.
 */
import type { KafkaMessage } from "../../kafka-agent/protocol.ts";
import { esc } from "../code/ui.ts";
import { openDialog } from "./dialog.ts";
import { decode, formatCount } from "./format.ts";
import type { KafkaModel } from "./model.ts";

/** Which messages go in the file: the whole list, or the one that is open. */
export type ExportSource = "list" | "selected";

/** How a value is written: as the viewer reads it, or as the bytes the topic holds. */
export type ExportMode = "viewer" | "bytes";

/** One value of a line, with the word for how it was written. */
interface Written {
  value: string | null;
  encoding: "null" | "text" | "json" | "hex" | "base64";
}

function write(b64: string | null, mode: ExportMode): Written {
  if (b64 === null) return { value: null, encoding: "null" }; // a tombstone, or no key
  if (mode === "bytes") return { value: b64, encoding: "base64" };
  // The text of a JSON value as it is, without the indent the viewer adds: the file keeps what
  // the topic holds, and a number in it is the number that was sent.
  const d = decode(b64, "auto", false);
  if (d === null) return { value: null, encoding: "null" };
  return { value: d.text, encoding: d.as };
}

/** One message as one line. JSON.stringify escapes what has to be escaped, so a value
 *  with a line break in it stays one line — which is the whole of the format. */
export function jsonLine(topic: string, m: KafkaMessage, mode: ExportMode): string {
  const key = write(m.key, mode);
  const value = write(m.value, mode);
  return JSON.stringify({
    topic,
    partition: m.partition,
    offset: m.offset,
    // Both: the number is what a program reads, the text is what a person reads.
    timestamp: m.timestamp,
    time: new Date(m.timestamp).toISOString(),
    key: key.value,
    keyEncoding: key.encoding,
    value: value.value,
    valueEncoding: value.encoding,
    headers: m.headers.map((h) => {
      const written = write(h.value, mode);
      return { name: h.key, value: written.value, encoding: written.encoding };
    }),
    // The value shown is a prefix of a large one (see protocol.ts): a reader has to know
    // that, or a short value would look like the whole message.
    truncated: m.truncated,
  });
}

/** The file: one line per message, oldest first within a partition, and a newline at the
 *  end of the last line. What the list shows may be newest-first (a read from the end, or
 *  a live view); a saved file is read from its start, so it is put in reading order. No
 *  messages is an empty file, not a file of one newline. */
export function jsonLines(topic: string, messages: KafkaMessage[], mode: ExportMode): string {
  const ordered = [...messages].sort((a, b) => a.partition - b.partition || a.offset - b.offset);
  if (ordered.length === 0) return "";
  return ordered.map((m) => jsonLine(topic, m, mode)).join("\n") + "\n";
}

/** A filename that says which cluster and topic it is, and when it was saved. */
export function exportName(cluster: string | null, topic: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${clean(cluster ?? "kafka")}-${clean(topic)}-${stamp}.jsonl`;
}

/** Hand text to the browser as a download. The blob URL is let go of afterwards, and not
 *  at once: revoking it while the download is starting cancels it in some browsers. */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface ExportOptions {
  topic: string;
  /** Every message the list holds. */
  messages: KafkaMessage[];
  /** The one that is open, when one is: what "only this message" means. */
  selected: KafkaMessage | null;
}

/** Ask what to save, then save it. */
export function exportMessagesDialog(model: KafkaModel, opts: ExportOptions): void {
  const n = opts.messages.length;
  const cut = opts.messages.filter((m) => m.truncated).length;
  const open = opts.selected
    ? `<option value="selected">only the open message — partition ${opts.selected.partition}, offset ${esc(formatCount(opts.selected.offset))}</option>`
    : "";
  const d = openDialog(
    `
    <p class="modal-title">Save ${n} message${n === 1 ? "" : "s"} as a JSON Lines file</p>
    <p class="modal-hint">cluster <b>${esc(model.cluster ?? "")}</b> · topic <b>${esc(opts.topic)}</b></p>
    <label for="kf-ex-what">what to save</label>
    <select id="kf-ex-what" class="t-input js-what">
      <option value="list">every message in the list (${n})</option>
      ${open}
    </select>
    <label for="kf-ex-how">how to write the values</label>
    <select id="kf-ex-how" class="t-input js-how">
      <option value="viewer">as the viewer reads them — text, JSON, hex or base64, each one named</option>
      <option value="bytes">as the bytes are — base64, exactly what the topic holds</option>
    </select>
    <p class="modal-hint">One message per line, one JSON object per line, oldest first within each partition.
      Every line names the topic, partition, offset, time, and how its key, value and headers were written, so a
      reader knows what each field is without being told.</p>
    ${cut ? `<p class="modal-hint is-warn">${cut} of them ${cut === 1 ? "has a value" : "have values"} cut at the agent's 256 KiB: a prefix is what is saved. Open one and use “load full message” first to save it whole.</p>` : ""}
    <p class="modal-hint is-error js-err" hidden></p>
    <div class="modal-row">
      <button type="button" class="t-btn cancel">cancel</button>
      <button type="submit" class="t-btn t-btn-primary js-ok">save</button>
    </div>`,
    true,
  );
  const $ = <T extends HTMLElement>(sel: string): T => d.form.querySelector<T>(sel)!;
  d.form.querySelector(".cancel")!.addEventListener("click", d.close);
  d.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const source = $<HTMLSelectElement>(".js-what").value as ExportSource;
    const mode = $<HTMLSelectElement>(".js-how").value as ExportMode;
    const chosen = source === "selected" && opts.selected ? [opts.selected] : opts.messages;
    try {
      // Made whole, in one string, before the download starts: a live view may add a
      // message while this runs, and a file that changes as it is written is not a file.
      downloadText(exportName(model.cluster, opts.topic), jsonLines(opts.topic, chosen, mode));
    } catch (ex) {
      const err = $<HTMLElement>(".js-err");
      err.textContent = ex instanceof Error ? ex.message : String(ex);
      err.hidden = false;
      return;
    }
    model.log("messages.export", `${opts.topic}: saved ${chosen.length} message${chosen.length === 1 ? "" : "s"} as JSON Lines (${mode === "bytes" ? "base64" : "as read"})`);
    d.close();
  });
  $<HTMLSelectElement>(".js-what").focus();
}
