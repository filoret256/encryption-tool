/** Writing to a Schema Registry from the page (K-47): a new version of a subject, and the
 *  compatibility level a subject is held to.
 *
 *  Both are changes, and the agent refuses them on a read-only cluster with the same words
 *  it uses for every other write; the page offers them only where the cluster may be
 *  changed. The registry is the side that decides what compatibility means, so its own
 *  message is what is shown — and the register dialog asks it first (`schemas.check`, a
 *  read), so that the answer is on screen before the write, not after.
 */
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import type { CompatibilitySet, RegisteredSchema } from "../../kafka-agent/protocol.ts";
import { cmBase, cmDark } from "../cm-theme.ts";
import { cspNonce } from "../csp.ts";
import { esc } from "../code/ui.ts";
import { openDialog } from "./dialog.ts";
import type { KafkaModel } from "./model.ts";
import { COMPATIBILITY_LEVELS, COMPATIBILITY_TEXT, SCHEMA_TYPES, compatibilityText, parseReferences } from "./schema-text.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface RegisterOptions {
  /** The subject to write a version of; empty for a new one. */
  subject: string;
  /** The cluster may be changed: the caller checks it, and this is what it decided. */
  onRegistered: (r: RegisteredSchema) => void;
}

/** Register one version of one subject: the schema's text, its format, and the schemas it
 *  is written in terms of. **check** asks the registry whether it would take it and writes
 *  nothing; **register** writes it. */
export function registerSchemaDialog(model: KafkaModel, opts: RegisterOptions): void {
  const d = openDialog(
    `
    <p class="modal-title">Register a schema</p>
    <p class="modal-hint">cluster <b>${esc(model.cluster ?? "")}</b> <span class="kf-tag kf-tag-warn">writable</span> · the registry keeps every version: this adds one, and changes nothing that is already there</p>
    <div class="kf-send-grid">
      <label for="kf-sr-subject">subject</label>
      <input id="kf-sr-subject" class="t-input js-subject" type="text" autocomplete="off" spellcheck="false" placeholder="orders-value" value="${esc(opts.subject)}" />
      <label for="kf-sr-type">format</label>
      <select id="kf-sr-type" class="t-input js-type">${SCHEMA_TYPES.map((t) => `<option>${t}</option>`).join("")}</select>
      <label for="kf-sr-refs">references</label>
      <textarea id="kf-sr-refs" class="t-input js-refs kf-textarea" rows="2" spellcheck="false" placeholder="one per line, only when the schema imports another: name subject version"></textarea>
    </div>
    <label>schema</label>
    <div class="kf-schema-edit js-editor"></div>
    <p class="modal-hint js-note" hidden></p>
    <p class="modal-hint is-error js-err" hidden></p>
    <div class="modal-row">
      <button type="button" class="t-btn cancel">cancel</button>
      <button type="button" class="t-btn js-check">check</button>
      <button type="submit" class="t-btn t-btn-primary js-ok">register</button>
    </div>`,
    true,
  );
  const $ = <T extends HTMLElement>(sel: string): T => d.form.querySelector<T>(sel)!;
  const subject = $<HTMLInputElement>(".js-subject");
  const type = $<HTMLSelectElement>(".js-type");
  const refs = $<HTMLTextAreaElement>(".js-refs");
  const note = $<HTMLElement>(".js-note");
  const err = $<HTMLElement>(".js-err");
  const buttons = [$<HTMLButtonElement>(".js-check"), $<HTMLButtonElement>(".js-ok")];

  // A .proto has no grammar in this bundle, and Avro and JSON Schema are JSON: the editor
  // says which by what it colours.
  const lang = new Compartment();
  const view = new EditorView({
    parent: $(".js-editor"),
    state: EditorState.create({
      doc: "",
      extensions: [
        EditorView.cspNonce.of(cspNonce),
        cmBase,
        cmDark(model.dark),
        lang.of(json()),
        lineNumbers(),
        history(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "The schema" }),
        keymap.of([{ key: "Mod-Enter", run: () => (d.form.requestSubmit(), true) }, ...defaultKeymap, ...historyKeymap]),
      ],
    }),
  });
  d.onClose(() => view.destroy());
  type.addEventListener("change", () => view.dispatch({ effects: lang.reconfigure(type.value === "PROTOBUF" ? [] : json()) }));
  // Ctrl+Enter registers from anywhere in the dialog; the schema editor keeps its own keys,
  // so a newline is a newline and the dialog is only sent when it was asked for.
  d.form.addEventListener("keydown", (e) => {
    if ((!e.ctrlKey && !e.metaKey) || e.key !== "Enter") return;
    if ((e.target as HTMLElement).closest(".cm-editor")) return;
    e.preventDefault();
    d.form.requestSubmit();
  });

  const collect = (): Parameters<KafkaModel["registerSchema"]>[0] | string => {
    const name = subject.value.trim();
    if (name === "") return "Name the subject";
    const text = view.state.doc.toString().trim();
    if (text === "") return "The schema is empty";
    const references = parseReferences(refs.value);
    if (typeof references === "string") return references;
    return { subject: name, schema: text, type: type.value, references };
  };

  const run = async (register: boolean): Promise<void> => {
    err.hidden = note.hidden = true;
    const first = collect();
    if (typeof first === "string") {
      err.textContent = first;
      err.hidden = false;
      return;
    }
    for (const b of buttons) b.disabled = true;
    try {
      if (!register) {
        // A registry that will not answer about the subject — one it has never had, say —
        // is not a reason to refuse to register: the register itself checks compatibility,
        // and its refusal is the one that matters. So this is said as a note, not an error.
        try {
          const checked = await model.checkSchemaCompatibility({ ...first, version: -1 });
          note.textContent = checked.compatible
            ? `The registry would take this schema as the next version of ${first.subject}. Nothing has been written.`
            : `The registry would refuse it: ${checked.messages.join(" ") || "it did not say why"}`;
          note.classList.toggle("is-warn", !checked.compatible);
        } catch (e) {
          note.textContent = `The registry would not answer about ${first.subject}: ${message(e)} Registering is still possible — the registry checks compatibility itself and refuses in its own words.`;
          note.classList.add("is-warn");
        }
        note.hidden = false;
        return;
      }
      const got = await model.registerSchema(first);
      d.close();
      opts.onRegistered(got);
    } catch (e) {
      err.textContent = message(e);
      err.hidden = false;
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  };
  $(".js-check").addEventListener("click", () => void run(false));
  d.form.addEventListener("submit", (e) => {
    e.preventDefault();
    void run(true);
  });
  d.form.querySelector(".cancel")!.addEventListener("click", d.close);
  subject.focus();
}

/** Ask before a level is written. A select that wrote on change would put "no check at
 *  all" one stray click away from a registry somebody else's services depend on, so the
 *  choice is only a choice until the dialog is answered. */
function confirmLevel(model: KafkaModel, subject: string, level: string, own: string | null, fallback: string | null): Promise<boolean> {
  const to = level === "" ? compatibilityText(null, fallback) : level;
  const meaning = level === "" ? "the registry's own default, which may change later" : (COMPATIBILITY_TEXT[level] ?? "");
  const d = openDialog(`
    <p class="modal-title">Hold <b>${esc(subject)}</b> to <b>${esc(to)}</b>?</p>
    <p class="modal-hint">cluster <b>${esc(model.cluster ?? "")}</b> · now <b>${esc(compatibilityText(own, fallback))}</b></p>
    <p class="modal-hint">This is what a new version of the subject is checked against before the registry takes it: ${esc(meaning)}.
      Nothing already registered is checked again, and no schema is changed.</p>
    <div class="modal-row">
      <button type="button" class="t-btn cancel">cancel</button>
      <button type="submit" class="t-btn t-btn-primary js-ok">set the level</button>
    </div>`);
  return new Promise((resolve) => {
    let answer = false;
    d.onClose(() => resolve(answer));
    d.form.querySelector(".cancel")!.addEventListener("click", d.close);
    d.form.addEventListener("submit", (e) => {
      e.preventDefault();
      answer = true;
      d.close();
    });
    d.form.querySelector<HTMLButtonElement>(".js-ok")!.focus();
  });
}

/** The compatibility control of one subject: the level it is held to, with the registry's
 *  default as the first choice. A change is confirmed before it is written, and what the
 *  caller gets back is the level in force, which is what the header shows. */
export function compatibilityControl(
  model: KafkaModel,
  subject: string,
  own: string | null,
  onChanged: (level: string | null) => void,
  onError: (why: string) => void,
): HTMLElement {
  const fallback = model.cluster ? (model.schemas.get(model.cluster)?.compatibility ?? null) : null;
  const box = document.createElement("span");
  box.className = "kf-compat";
  box.innerHTML = `<span class="kf-muted js-compat-kind" title="What a new version is checked against: the level this subject has of its own, or the registry's default"></span>
    <select class="t-input js-compat" aria-label="Compatibility level of ${esc(subject)}">
      <option value="">${esc(compatibilityText(null, fallback))}</option>
      ${COMPATIBILITY_LEVELS.map((l) => `<option value="${l}"${l === own ? " selected" : ""}>${l}</option>`).join("")}
    </select>`;
  const select = box.querySelector<HTMLSelectElement>(".js-compat")!;
  const kind = box.querySelector<HTMLElement>(".js-compat-kind")!;
  const say = (): void => {
    // The select says which it is ("registry default (BACKWARD)", or the level): the label
    // said "registry default" a second time (I-08). Whose it is stays in the tooltip.
    kind.textContent = "compatibility";
    kind.title = own === null ? "This subject has no level of its own: the registry's default applies" : "The level this subject has of its own";
  };
  say();
  let busy = false;
  select.addEventListener("change", async () => {
    if (busy) return;
    const was = own ?? "";
    const wanted = select.value;
    if (wanted === was) return;
    if (!(await confirmLevel(model, subject, wanted, own, fallback))) {
      select.value = was; // nothing was asked for, and nothing was written
      return;
    }
    busy = true;
    select.disabled = true;
    try {
      const r: CompatibilitySet = await model.setCompatibility({ subject, level: wanted });
      own = wanted === "" ? null : r.level;
      say();
      onChanged(own);
    } catch (e) {
      onError(message(e));
      select.value = was;
    } finally {
      busy = false;
      select.disabled = false;
    }
  });
  return box;
}
