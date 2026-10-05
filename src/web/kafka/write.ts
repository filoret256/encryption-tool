/** The dialogs that change a cluster: send a message, change a topic, delete one.
 *
 *  Each names the cluster it is about, in the words of the tag the list shows, so
 *  nobody sends to prod believing it was dev. Whether the cluster may be changed at
 *  all is the agent's decision (READ_ONLY); these are only ever offered when it may,
 *  and if it says no after all — the configuration was reloaded under the page — the
 *  refusal is shown here, in the agent's own words.
 *
 *  The send dialog can wrap the value in an Ansible Vault or helm envelope before it
 *  is sent (vault.ts). That happens in this page: the agent is handed ciphertext.
 */
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import type {
  AlterConfigRow,
  ConfigEntry,
  DeleteGroupResult,
  DeleteRecordsResult,
  DeleteTopicResult,
  ProduceEncoding,
  ProduceHeader,
  ProduceResult,
  ProduceSchema,
  ResetRow,
  ResetTo,
} from "../../kafka-agent/protocol.ts";
import { cmBase, cmDark } from "../cm-theme.ts";
import { cspNonce } from "../csp.ts";
import { esc } from "../code/ui.ts";
import { openDialog } from "./dialog.ts";
import { SCHEMA_TEXT, formatCount, formatTime, toLocalInput } from "./format.ts";
import type { KafkaModel } from "./model.ts";
import { VAULT_FORMATS, VAULT_TEXT, encryptValue, type VaultFormat } from "./vault.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** "cluster prod" with the tag the lists give it. */
function clusterLine(model: KafkaModel): string {
  const writable = !model.readOnly;
  return `cluster <b>${esc(model.cluster ?? "")}</b> <span class="kf-tag${writable ? " kf-tag-warn" : ""}">${writable ? "writable" : "read-only"}</span>`;
}

// ── delete a topic ────────────────────────────────────────────────────────

/** Resolves to what the agent said, or null when the person backed out. The topic is
 *  deleted only after its name is typed out; the agent is given the same name and
 *  checks it again. */
export function deleteTopicDialog(model: KafkaModel, topic: string, messages: number | null): Promise<DeleteTopicResult | null> {
  return new Promise((resolve) => {
    const held =
      messages === null
        ? "Everything in it is deleted."
        : messages === 0
          ? "It holds no messages."
          : `It holds ${formatCount(messages)} message${messages === 1 ? "" : "s"}, and they are deleted with it.`;
    const d = openDialog(`
      <p class="modal-title">Delete the topic <b>${esc(topic)}</b>?</p>
      <p class="modal-hint">${clusterLine(model)}</p>
      <p class="modal-hint">${esc(held)} This cannot be undone. Consumers that read it will find it gone.</p>
      <label for="kf-del-name">Type the topic's name to confirm</label>
      <input id="kf-del-name" class="t-input js-name" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(topic)}" />
      <p class="modal-hint is-error js-err" hidden></p>
      <div class="modal-row">
        <button type="button" class="t-btn cancel">cancel</button>
        <button type="submit" class="t-btn t-btn-primary t-btn-danger js-ok" disabled>delete topic</button>
      </div>`);
    const name = d.form.querySelector<HTMLInputElement>(".js-name")!;
    const ok = d.form.querySelector<HTMLButtonElement>(".js-ok")!;
    const err = d.form.querySelector<HTMLElement>(".js-err")!;
    let busy = false;
    let result: DeleteTopicResult | null = null;
    d.onClose(() => resolve(result));

    name.addEventListener("input", () => (ok.disabled = busy || name.value !== topic));
    d.form.querySelector(".cancel")!.addEventListener("click", d.close);
    d.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy || name.value !== topic) return;
      busy = true;
      ok.disabled = name.disabled = true;
      ok.textContent = "deleting…";
      err.hidden = true;
      try {
        result = await model.deleteTopic(topic);
        d.close();
      } catch (ex) {
        busy = false;
        name.disabled = false;
        ok.textContent = "delete topic";
        ok.disabled = name.value !== topic;
        err.textContent = message(ex);
        err.hidden = false;
      }
    });
    name.focus();
  });
}

// ── send a message ────────────────────────────────────────────────────────

const ENCODINGS: ProduceEncoding[] = ["string", "json", "base64"];
const encodingSelect = (cls: string, label: string, value: ProduceEncoding = "string"): string =>
  `<select class="t-input ${cls}" aria-label="${esc(label)}">${ENCODINGS.map((e) => `<option${e === value ? " selected" : ""}>${e}</option>`).join("")}</select>`;

/** What a key or a value is written as: one answer to one question. The three encodings are
 *  how the typed text becomes bytes; a schema is the registry's way, an envelope is the
 *  page's — and a value can be only one of them, which is why this is one list and not
 *  three controls that each had to know about the others. */
const FORMAT_OPTIONS =
  ENCODINGS.map((e) => `<option value="${e}">${e}</option>`).join("") +
  `<option value="schema">schema…</option>` +
  VAULT_FORMATS.map((f) => `<option value="${f}">${VAULT_TEXT[f]}</option>`).join("");

/** The value's list is the key's, and one more: no value at all. A tombstone is an answer to
 *  "what is the value" like the rest, and it excludes the others — a choice among them, not a
 *  box beside a select that has to be kept from contradicting it. */
const VALUE_OPTIONS = FORMAT_OPTIONS + `<option value="tombstone">tombstone — no value</option>`;

const isVault = (format: string): format is VaultFormat => (VAULT_FORMATS as string[]).includes(format);
const isEncoding = (format: string): format is ProduceEncoding => (ENCODINGS as string[]).includes(format);

/** What hangs off the format select of one field: a subject and a version for a schema, a
 *  password for an envelope. Shown only for the format that needs it. */
const extraRow = (name: "key" | "value"): string => `
  <div class="kf-send-row js-extra-${name}" hidden>
    <select class="t-input js-subject" aria-label="Subject of the ${name}'s schema" hidden><option value="">choose a subject</option></select>
    <select class="t-input js-version" aria-label="Version of the ${name}'s schema" hidden></select>
    <input class="t-input js-pw" type="password" autocomplete="new-password" spellcheck="false" placeholder="password" aria-label="Password for the ${name}" hidden />
    <button type="button" class="t-btn js-see" title="Show the password" aria-label="Show the password" hidden>👁</button>
  </div>`;

/** The key or the value, as the dialog sees it: the format and what hangs off it. */
interface SendField {
  name: "key" | "value";
  fmt: HTMLSelectElement;
  extra: HTMLElement;
  subject: HTMLSelectElement;
  version: HTMLSelectElement;
  pw: HTMLInputElement;
  see: HTMLButtonElement;
}

export interface SendOptions {
  topic: string;
  /** The topic's partitions, for the "which one" list; empty when they are not known yet. */
  partitions: number[];
  dark: boolean;
  /** "show in the viewer" on the result. */
  onShow: (result: ProduceResult) => void;
}

export function sendMessageDialog(model: KafkaModel, opts: SendOptions): void {
  // One layout: a label on the left and its control on the right, for every field. The
  // buttons and the error line are outside what scrolls, so a short window cuts the form
  // and never the way to send it.
  const d = openDialog(
    `
    <p class="modal-title">Send a message to <b>${esc(opts.topic)}</b></p>
    <p class="modal-hint">${clusterLine(model)}</p>
    <div class="js-form kf-send-form">
      <div class="kf-send-grid">
        <label for="kf-send-part">partition</label>
        <select id="kf-send-part" class="t-input js-part"><option value="">automatic — from the key, else the cluster's choice</option>${opts.partitions.map((p) => `<option value="${p}">${p}</option>`).join("")}</select>
        <label for="kf-send-key">key</label>
        <div class="kf-send-col">
          <div class="kf-send-row"><input id="kf-send-key" class="t-input js-key" type="text" autocomplete="off" spellcheck="false" placeholder="empty: no key" /><select class="t-input js-fmt-key" aria-label="Format of the key">${FORMAT_OPTIONS}</select></div>
          ${extraRow("key")}
        </div>
        <label for="kf-send-value-fmt">value</label>
        <div class="kf-send-col">
          <div class="kf-send-row"><select id="kf-send-value-fmt" class="t-input js-fmt-value" aria-label="Format of the value">${VALUE_OPTIONS}</select></div>
          ${extraRow("value")}
        </div>
        <div class="kf-send-editor js-editor"></div>
        <label>headers</label>
        <div class="kf-send-col">
          <div class="js-headers kf-send-headers"></div>
          <button type="button" class="t-btn js-add-header">+ header</button>
        </div>
      </div>
      <p class="modal-hint js-note" hidden></p>
    </div>
    <div class="js-done kf-send-done" hidden></div>
    <div class="kf-send-foot">
      <p class="modal-hint is-error js-err" hidden></p>
      <div class="modal-row js-row">
        <button type="button" class="t-btn cancel">cancel</button>
        <button type="submit" class="t-btn t-btn-primary js-ok">send</button>
      </div>
    </div>`,
    true,
  );
  const $ = <T extends HTMLElement>(sel: string): T => d.form.querySelector<T>(sel)!;
  const err = $<HTMLElement>(".js-err");
  const ok = $<HTMLButtonElement>(".js-ok");
  const note = $<HTMLElement>(".js-note");

  const field = (name: "key" | "value"): SendField => {
    const extra = $<HTMLElement>(`.js-extra-${name}`);
    return {
      name,
      fmt: $<HTMLSelectElement>(`.js-fmt-${name}`),
      extra,
      subject: extra.querySelector<HTMLSelectElement>(".js-subject")!,
      version: extra.querySelector<HTMLSelectElement>(".js-version")!,
      pw: extra.querySelector<HTMLInputElement>(".js-pw")!,
      see: extra.querySelector<HTMLButtonElement>(".js-see")!,
    };
  };
  const keyField = field("key");
  const valueField = field("value");
  const fields = [keyField, valueField];
  /** Is the value "tombstone — no value"? */
  const tombstone = (): boolean => valueField.fmt.value === "tombstone";

  // ── the value ──
  const lang = new Compartment();
  const view = new EditorView({
    parent: $(".js-editor"),
    state: EditorState.create({
      doc: "",
      extensions: [
        EditorView.cspNonce.of(cspNonce),
        cmBase,
        cmDark(opts.dark),
        lang.of([]),
        lineNumbers(),
        history(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "Value of the message" }),
        keymap.of([{ key: "Mod-Enter", run: () => (d.form.requestSubmit(), true) }, ...defaultKeymap, ...historyKeymap]),
      ],
    }),
  });
  d.onClose(() => view.destroy());

  // ── what each choice means for the rest of the form ──
  // That the envelope is made in the page is the whole point: the agent is given ciphertext,
  // and there is nothing anywhere that would accept the password. A value written with a
  // schema is JSON, and the agent turns it into that schema's bytes behind the registry's
  // header — the serializing happens there, so a value that does not fit is refused before
  // anything is written; this side only says which schema means what.

  /** The version that is chosen, as words: the value of the select is -1 for the latest,
   *  which is the registry's own shorthand and not a version number. A subject whose
   *  versions are still on their way has none chosen yet. */
  const versionText = (ver: HTMLSelectElement): string => (ver.value === "" ? "no version yet" : ver.value === "-1" ? "latest" : `v${ver.value}`);

  /** What is said about the registry itself: no subjects, not answering, not configured. */
  let registryNote = "";

  const syncNote = (): void => {
    const bits: string[] = [];
    for (const f of fields) {
      const format = f.fmt.value;
      if (isVault(format) && !(f.name === "value" && tombstone())) {
        bits.push(
          `The ${f.name} is wrapped as ${VAULT_TEXT[format]} in this page before it is sent. The agent and the cluster see the envelope only, and the password is not sent to either.`,
        );
      }
    }
    const schemas = fields.filter((f) => f.fmt.value === "schema").map((f) => `the ${f.name} with ${f.subject.value || "a subject"} (${versionText(f.version)})`);
    if (schemas.length) {
      bits.push(
        `JSON is what is typed here. The agent writes ${schemas.join(" and ")} in that schema's own format, with the schema's id in front of the bytes. A value that does not fit the schema is refused, and nothing reaches the topic.`,
      );
    }
    if (tombstone()) bits.push("A tombstone sends no value, so there is nothing to wrap or to write with a schema.");
    note.textContent = [registryNote, ...bits].filter(Boolean).join("\n\n");
    note.hidden = note.textContent === "";
  };

  const sync = (): void => {
    // A tombstone has no text to type; the editor is not shown for it.
    $(".js-editor").hidden = tombstone();
    for (const f of fields) {
      const format = f.fmt.value;
      const schema = format === "schema";
      const vault = isVault(format);
      f.subject.hidden = !schema;
      f.version.hidden = !schema || f.subject.value === "";
      f.pw.hidden = f.see.hidden = !vault;
      f.extra.hidden = !(schema || vault) || (f.name === "value" && tombstone());
    }
    const typedAsJson = valueField.fmt.value === "json" || valueField.fmt.value === "schema";
    view.dispatch({ effects: lang.reconfigure(typedAsJson ? json() : []) });
    syncNote();
  };

  /** One subject's versions, asked for when it is picked: a registry has no request that
   *  answers for every subject at once (see srschema.go). */
  const fillVersions = async (f: SendField): Promise<void> => {
    const subject = f.subject.value;
    sync();
    if (subject === "") return;
    // An answer is kept only while the picker still says the subject it was asked for: the
    // agent's reply names the subject it was sent, so comparing with the reply compared it
    // with itself, and A's list landed under B.
    const current = (): boolean => f.subject.value === subject;
    f.version.disabled = true;
    f.version.innerHTML = `<option>loading…</option>`;
    try {
      const v = await model.registryVersions(subject);
      if (!current()) return; // another subject was picked while this was out
      const latest = v.versions[v.versions.length - 1];
      f.version.innerHTML =
        `<option value="-1">latest${latest ? ` — v${latest.version} (id ${latest.id})` : ""}</option>` +
        v.versions.map((x) => `<option value="${x.version}">v${x.version} · id ${x.id} · ${esc(x.type)}</option>`).join("");
      f.version.disabled = false;
      f.version.value = "-1";
    } catch (e) {
      if (!current()) return;
      f.version.innerHTML = `<option value="">—</option>`;
      f.version.disabled = true;
      registryNote = message(e);
    }
    // The note names the version, and until now it said "no version yet" for good.
    sync();
  };

  let wasTombstone = false;
  for (const f of fields) {
    f.fmt.addEventListener("change", () => {
      sync();
      // Back from "no value" to a value: the cursor goes where the value is typed.
      if (wasTombstone && !tombstone()) view.focus();
      wasTombstone = tombstone();
    });
    f.subject.addEventListener("change", () => void fillVersions(f));
    f.version.addEventListener("change", syncNote);
    f.see.addEventListener("click", () => {
      f.pw.type = f.pw.type === "password" ? "text" : "password";
    });
  }

  // The registry is asked when the dialog opens, and only where the cluster has one: a
  // cluster without one has nothing to write with. The option stays in the list and says why
  // it cannot be chosen, so the way to a schema is never a missing control.
  const schemaOptions = fields.map((f) => f.fmt.querySelector<HTMLOptionElement>(`option[value="schema"]`)!);
  const refuseSchema = (why: string): void => {
    for (const o of schemaOptions) {
      o.disabled = true;
      o.title = why;
    }
  };
  const registry = model.schemas.get(model.cluster!);
  if (registry === undefined || registry.state === "connected") {
    refuseSchema("Reading the registry's subjects…");
    void (async () => {
      try {
        const names = await model.registrySubjects();
        for (const f of fields) f.subject.insertAdjacentHTML("beforeend", names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join(""));
        if (names.length === 0) {
          refuseSchema("The registry holds no subjects yet");
          registryNote = "The registry holds no subjects yet: there is no schema to write with.";
        } else {
          for (const o of schemaOptions) {
            o.disabled = false;
            o.title = "";
          }
        }
      } catch (e) {
        // A registry that does not answer is worth a sentence: the person picked this
        // cluster expecting one.
        refuseSchema("The registry did not answer");
        registryNote = message(e);
      }
      sync();
    })();
  } else {
    registryNote = `The schema registry ${SCHEMA_TEXT[registry.state]}: ${registry.message ?? ""}`;
    refuseSchema(registryNote);
  }
  sync();

  // ── the headers ──
  const headers = $<HTMLElement>(".js-headers");
  const addHeader = (): void => {
    const row = document.createElement("div");
    row.className = "kf-send-row kf-send-header";
    row.innerHTML = `<input class="t-input js-hk" type="text" placeholder="name" aria-label="Header name" autocomplete="off" spellcheck="false" />
      <input class="t-input js-hv" type="text" placeholder="value" aria-label="Header value" autocomplete="off" spellcheck="false" />
      ${encodingSelect("js-he", "How the header value is encoded")}
      <button type="button" class="t-btn js-rm" aria-label="Remove this header" title="Remove">✕</button>`;
    row.querySelector(".js-rm")!.addEventListener("click", () => row.remove());
    headers.appendChild(row);
    row.querySelector<HTMLInputElement>(".js-hk")!.focus();
  };
  $(".js-add-header").addEventListener("click", addHeader);

  // ── sending ──
  const collect = (): ProduceHeader[] =>
    [...headers.querySelectorAll<HTMLElement>(".kf-send-header")]
      .map((row) => ({
        key: row.querySelector<HTMLInputElement>(".js-hk")!.value.trim(),
        value: row.querySelector<HTMLInputElement>(".js-hv")!.value,
        encoding: row.querySelector<HTMLSelectElement>(".js-he")!.value as ProduceEncoding,
      }))
      // A row left empty is a row nobody meant to send.
      .filter((h) => h.key !== "" || h.value !== "");

  d.form.querySelector(".cancel")!.addEventListener("click", d.close);
  // Ctrl+Enter sends from anywhere in the dialog. The value editor has its own binding;
  // this is what makes the gesture work from the header fields too, and the editor's
  // events are left to it so the send never happens twice for one key press.
  d.form.addEventListener("keydown", (e) => {
    if ((!e.ctrlKey && !e.metaKey) || e.key !== "Enter") return;
    if ((e.target as HTMLElement).closest(".cm-editor")) return;
    e.preventDefault();
    d.form.requestSubmit();
  });
  d.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (ok.disabled) return;
    const part = $<HTMLSelectElement>(".js-part").value;
    const key = $<HTMLInputElement>(".js-key").value;
    const refuse = (why: string, at?: HTMLElement): void => {
      err.textContent = why;
      err.hidden = false;
      at?.focus();
    };
    // A password is checked before the button is taken away: a missing one is a
    // sentence here, not a failed send. A key left empty and a tombstone have nothing to wrap.
    for (const f of fields) {
      const format = f.fmt.value;
      const wraps = isVault(format) && (f.name === "key" ? key !== "" : !tombstone());
      if (wraps && f.pw.value === "") return refuse(`A password is needed to wrap the ${f.name} as ${VAULT_TEXT[format as VaultFormat]}`, f.pw);
    }
    // A subject was picked but its versions did not arrive (or none was picked): the send
    // waits, rather than going out with a version nobody chose.
    const chosen = (f: SendField): ProduceSchema | string | null => {
      if (f.fmt.value !== "schema") return null;
      if (f.subject.value === "") return `Choose a subject to write the ${f.name} with`;
      const version = Number(f.version.value);
      if (!Number.isInteger(version) || version === 0 || version < -1) return `Choose a version of ${f.subject.value}`;
      return { subject: f.subject.value, version };
    };
    const valueSchema = chosen(valueField);
    if (typeof valueSchema === "string") return refuse(valueSchema, valueField.subject);
    const keySchema = chosen(keyField);
    if (typeof keySchema === "string") return refuse(keySchema, keyField.subject);
    ok.disabled = true;
    ok.textContent = "sending…";
    err.hidden = true;
    const keyFormat = keyField.fmt.value;
    const valueFormat = valueField.fmt.value;
    try {
      // The envelopes are made here, in this page: what the agent is handed is ciphertext,
      // and the password goes nowhere (vault.ts).
      let keyText: string | null = key === "" ? null : key;
      if (keyText !== null && isVault(keyFormat)) keyText = await encryptValue(keyFormat, keyText, keyField.pw.value);
      let value: string | null = tombstone() ? null : view.state.doc.toString();
      if (value !== null && isVault(valueFormat)) value = await encryptValue(valueFormat, value, valueField.pw.value);
      const r = await model.produce({
        topic: opts.topic,
        partition: part === "" ? null : Number(part),
        key: keyText,
        // An envelope is text, whatever the key was meant to be read as; a key written with a
        // schema is typed as it is, and the agent turns it into that schema's bytes.
        keyEncoding: isEncoding(keyFormat) ? keyFormat : "string",
        value,
        // The same for the value: a schema's is JSON in and the schema's bytes out.
        valueEncoding: isEncoding(valueFormat) ? valueFormat : valueFormat === "schema" ? "json" : "string",
        headers: collect(),
        schema: valueSchema,
        keySchema,
      });
      // The result replaces the form: where it landed is the answer to what was asked.
      $<HTMLElement>(".js-form").hidden = true;
      const done = $<HTMLElement>(".js-done");
      done.hidden = false;
      done.innerHTML = `<p class="modal-title">Sent to partition <b>${r.partition}</b>, offset <b>${esc(formatCount(r.offset))}</b>.</p>
        <p class="modal-hint">${esc(formatTime(r.timestamp))}</p>`;
      $<HTMLElement>(".js-row").innerHTML = `
        <button type="button" class="t-btn js-again">send another</button>
        <button type="button" class="t-btn js-show">show in the viewer</button>
        <button type="button" class="t-btn t-btn-primary js-close">close</button>`;
      $(".js-again").addEventListener("click", () => {
        d.close();
        sendMessageDialog(model, opts);
      });
      $(".js-show").addEventListener("click", () => {
        d.close();
        opts.onShow(r);
      });
      $(".js-close").addEventListener("click", d.close);
      $<HTMLButtonElement>(".js-show").focus();
    } catch (ex) {
      ok.disabled = false;
      ok.textContent = "send";
      err.textContent = message(ex);
      err.hidden = false;
    }
  });
  view.focus();
}

// ── create a topic ────────────────────────────────────────────────────────

const CLEANUP = ["", "delete", "compact", "compact,delete"];

/** Parse "key=value" lines: what the page has no field for. A line that is not a setting is an error. */
function parseSettings(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 1) return `Other settings, line ${i + 1}: write it as name=value`;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** Create a topic. The cluster is asked first (validateOnly), so a mistake is a sentence in
 *  this dialog; `check` asks and stops there, `create` asks and then creates. */
export function createTopicDialog(model: KafkaModel): void {
  const d = openDialog(
    `
    <p class="modal-title">Create a topic</p>
    <p class="modal-hint">${clusterLine(model)}</p>
    <div class="kf-send-grid">
      <label for="kf-ct-name">name</label>
      <input id="kf-ct-name" class="t-input js-name" type="text" autocomplete="off" spellcheck="false" placeholder="orders.v2" />
      <label for="kf-ct-parts">partitions</label>
      <input id="kf-ct-parts" class="t-input js-parts" type="number" min="1" max="10000" value="1" />
      <label for="kf-ct-rf">replication</label>
      <input id="kf-ct-rf" class="t-input js-rf" type="number" min="1" value="1" title="How many brokers hold each partition; at most the number of brokers" />
      <label for="kf-ct-ret">retention.ms</label>
      <input id="kf-ct-ret" class="t-input js-ret" type="text" inputmode="numeric" autocomplete="off" placeholder="broker default (-1 keeps forever)" />
      <label for="kf-ct-clean">cleanup.policy</label>
      <select id="kf-ct-clean" class="t-input js-clean">${CLEANUP.map((c) => `<option value="${c}">${c === "" ? "broker default" : c}</option>`).join("")}</select>
      <label for="kf-ct-isr">min.insync.replicas</label>
      <input id="kf-ct-isr" class="t-input js-isr" type="text" inputmode="numeric" autocomplete="off" placeholder="broker default" />
      <label for="kf-ct-more">other settings</label>
      <textarea id="kf-ct-more" class="t-input js-more kf-textarea" rows="3" spellcheck="false" placeholder="one per line: max.message.bytes=2097152"></textarea>
    </div>
    <p class="modal-hint js-note" hidden></p>
    <p class="modal-hint is-error js-err" hidden></p>
    <div class="modal-row">
      <button type="button" class="t-btn cancel">cancel</button>
      <button type="button" class="t-btn js-check">check</button>
      <button type="submit" class="t-btn t-btn-primary js-ok">create</button>
    </div>`,
    true,
  );
  const $ = <T extends HTMLElement>(sel: string): T => d.form.querySelector<T>(sel)!;
  const err = $<HTMLElement>(".js-err");
  const note = $<HTMLElement>(".js-note");
  const buttons = [$<HTMLButtonElement>(".js-check"), $<HTMLButtonElement>(".js-ok")];

  const collect = (validateOnly: boolean): Parameters<KafkaModel["createTopic"]>[0] | string => {
    const configs = parseSettings($<HTMLTextAreaElement>(".js-more").value);
    if (typeof configs === "string") return configs;
    for (const [key, sel] of [
      ["retention.ms", ".js-ret"],
      ["min.insync.replicas", ".js-isr"],
      ["cleanup.policy", ".js-clean"],
    ] as const) {
      const v = $<HTMLInputElement>(sel).value.trim();
      if (v !== "") configs[key] = v;
    }
    return {
      topic: $<HTMLInputElement>(".js-name").value.trim(),
      partitions: Number($<HTMLInputElement>(".js-parts").value),
      replicationFactor: Number($<HTMLInputElement>(".js-rf").value),
      configs,
      validateOnly,
    };
  };

  const run = async (create: boolean): Promise<void> => {
    err.hidden = note.hidden = true;
    const first = collect(true);
    if (typeof first === "string") {
      err.textContent = first;
      err.hidden = false;
      return;
    }
    for (const b of buttons) b.disabled = true;
    try {
      const checked = await model.createTopic(first);
      if (!create) {
        note.textContent = `Good: the cluster would create ${checked.topic} with ${checked.partitions} partition${checked.partitions === 1 ? "" : "s"}, replication factor ${checked.replicationFactor}. Nothing has been created.`;
        note.hidden = false;
      } else {
        await model.createTopic({ ...first, validateOnly: false });
        d.close();
      }
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
  $<HTMLInputElement>(".js-name").focus();
}

// ── reset a consumer group's offsets ──────────────────────────────────────

const RESET_MODES: { value: ResetTo; label: string }[] = [
  { value: "earliest", label: "the beginning (earliest)" },
  { value: "latest", label: "the end (latest)" },
  { value: "timestamp", label: "a point in time" },
  { value: "offset", label: "an offset" },
  { value: "shift", label: "shift by N messages" },
];

export interface ResetOptions {
  group: string;
  /** Topics the group has offsets for. */
  topics: string[];
  /** The offsets moved: the page shows the group again. */
  onApplied: () => void;
}

/** Reset a group's offsets: choose, look at what would change, then apply. Applying is
 *  possible only for exactly what was previewed — changing a field puts the preview away. */
export function resetOffsetsDialog(model: KafkaModel, opts: ResetOptions): void {
  const d = openDialog(
    `
    <p class="modal-title">Reset offsets of <b>${esc(opts.group)}</b></p>
    <p class="modal-hint">${clusterLine(model)} · the group must have no running consumers</p>
    <div class="kf-send-grid">
      <label for="kf-rs-topic">topic</label>
      <select id="kf-rs-topic" class="t-input js-topic">${opts.topics.map((t) => `<option>${esc(t)}</option>`).join("")}</select>
      <label for="kf-rs-parts">partitions</label>
      <input id="kf-rs-parts" class="t-input js-parts" type="text" autocomplete="off" spellcheck="false" placeholder="all — or list some: 0, 2" />
      <label for="kf-rs-to">move to</label>
      <div class="kf-send-row"><select id="kf-rs-to" class="t-input js-to">${RESET_MODES.map((m) => `<option value="${m.value}">${m.label}</option>`).join("")}</select>
        <input class="t-input js-time" type="datetime-local" step="1" aria-label="Time" hidden />
        <input class="t-input js-num" type="number" step="1" aria-label="Value" hidden /></div>
    </div>
    <div class="js-preview kf-reset-preview" hidden></div>
    <p class="modal-hint is-error js-err" hidden></p>
    <div class="modal-row">
      <button type="button" class="t-btn cancel">cancel</button>
      <button type="button" class="t-btn js-preview-btn">preview</button>
      <button type="submit" class="t-btn t-btn-primary t-btn-danger js-ok" disabled>apply</button>
    </div>`,
    true,
  );
  const $ = <T extends HTMLElement>(sel: string): T => d.form.querySelector<T>(sel)!;
  const to = $<HTMLSelectElement>(".js-to");
  const time = $<HTMLInputElement>(".js-time");
  const num = $<HTMLInputElement>(".js-num");
  const err = $<HTMLElement>(".js-err");
  const preview = $<HTMLElement>(".js-preview");
  const ok = $<HTMLButtonElement>(".js-ok");
  const previewBtn = $<HTMLButtonElement>(".js-preview-btn");
  time.value = toLocalInput(Date.now() - 3600_000);

  const syncMode = (): void => {
    time.hidden = to.value !== "timestamp";
    num.hidden = to.value !== "offset" && to.value !== "shift";
    num.placeholder = to.value === "offset" ? "offset" : "e.g. -100";
    if (to.value === "offset" && num.value.startsWith("-")) num.value = "";
  };
  syncMode();
  // Any change puts the preview away: what is applied is what was shown, not what is on screen now.
  const stale = (): void => {
    preview.hidden = true;
    ok.disabled = true;
    err.hidden = true;
    shown = null;
  };
  let shown: string | null = null;
  for (const el of [$(".js-topic"), $(".js-parts"), to, time, num]) el.addEventListener("input", stale);
  to.addEventListener("change", syncMode);

  const collect = (dryRun: boolean): Parameters<KafkaModel["resetOffsets"]>[0] | string => {
    const parts = $<HTMLInputElement>(".js-parts").value.trim();
    let partitions: number[] | null = null;
    if (parts !== "") {
      partitions = parts.split(/[\s,]+/).filter(Boolean).map(Number);
      if (partitions.some((n) => !Number.isInteger(n) || n < 0)) return "Partitions: numbers separated by commas, or leave it empty for all";
    }
    const mode = to.value as ResetTo;
    let timestamp: number | null = null;
    if (mode === "timestamp") {
      timestamp = new Date(time.value).getTime();
      if (Number.isNaN(timestamp)) return "Pick a date and time";
    }
    let value: number | null = null;
    if (mode === "offset" || mode === "shift") {
      value = num.value.trim() === "" ? NaN : Number(num.value);
      if (!Number.isInteger(value)) return mode === "offset" ? "Type the offset" : "Type how many messages to move by";
    }
    return {
      group: opts.group,
      topic: $<HTMLSelectElement>(".js-topic").value,
      partitions,
      to: mode,
      timestamp,
      offset: mode === "offset" ? value : null,
      shift: mode === "shift" ? value : null,
      dryRun,
    };
  };

  const table = (rows: ResetRow[]): string => {
    const lag = (offset: number | null, r: ResetRow): string => formatCount(r.end - (offset ?? r.start));
    const changed = rows.filter((r) => r.before !== r.after).length;
    return `<table class="kf-table"><thead><tr><th>partition</th><th>was</th><th>will be</th><th>lag</th></tr></thead><tbody>${rows
      .map(
        (r) => `<tr><td>${r.partition}</td><td>${r.before === null ? '<span class="kf-muted" title="Nothing committed">—</span>' : esc(formatCount(r.before))}</td>
          <td><b>${esc(formatCount(r.after))}</b></td><td>${esc(lag(r.before, r))} → <b>${esc(lag(r.after, r))}</b></td></tr>`,
      )
      .join("")}</tbody></table>
      <p class="modal-hint">${changed === 0 ? "Nothing would change." : `${changed} of ${rows.length} partition${rows.length === 1 ? "" : "s"} would move.`}</p>`;
  };

  previewBtn.addEventListener("click", async () => {
    err.hidden = true;
    const p = collect(true);
    if (typeof p === "string") {
      err.textContent = p;
      err.hidden = false;
      return;
    }
    previewBtn.disabled = true;
    try {
      const r = await model.resetOffsets(p);
      preview.innerHTML = table(r.rows);
      preview.hidden = false;
      shown = JSON.stringify({ ...p, dryRun: false });
      ok.disabled = false;
    } catch (e) {
      stale();
      err.textContent = message(e);
      err.hidden = false;
    } finally {
      previewBtn.disabled = false;
    }
  });

  d.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = collect(false);
    if (ok.disabled || typeof p === "string" || JSON.stringify(p) !== shown) return;
    ok.disabled = previewBtn.disabled = true;
    ok.textContent = "applying…";
    try {
      await model.resetOffsets(p);
      d.close();
      opts.onApplied();
    } catch (ex) {
      err.textContent = message(ex);
      err.hidden = false;
      ok.textContent = "apply";
      ok.disabled = true; // the preview no longer stands: look again
      previewBtn.disabled = false;
    }
  });
  d.form.querySelector(".cancel")!.addEventListener("click", d.close);
  $<HTMLSelectElement>(".js-topic").focus();
}

// ── change a topic's settings ─────────────────────────────────────────────

/** The settings somebody set on this topic: what a change is made of. Everything else is
 *  the cluster's default, and is reached by adding a setting by name. */
const setHere = (entries: ConfigEntry[]): ConfigEntry[] => entries.filter((e) => !e.isDefault && !e.sensitive);

/** Change a topic's settings, one by one, leaving the rest alone.
 *
 *  The rows are what the topic holds that somebody set, with a tick that takes a setting
 *  back to the cluster's default, and a field for one the cluster has never been told.
 *  **preview** asks the agent what the difference would be and has the cluster check the
 *  settings (`ValidateOnly`); **apply** works only on exactly what was previewed. */
export function alterConfigsDialog(model: KafkaModel, topic: string, entries: ConfigEntry[], onApplied: () => void): void {
  const here = setHere(entries);
  const row = (e: ConfigEntry): string => `
    <div class="kf-send-row js-set" data-name="${esc(e.name)}" data-before="${esc(e.value ?? "")}">
      <span class="kf-mono kf-set-name" title="${esc(e.name)}">${esc(e.name)}</span>
      ${
        e.readOnly
          ? `<span class="kf-mono kf-wrap">${esc(e.value ?? "—")}</span><span class="kf-tag" title="The cluster does not allow changing this while it runs">read-only</span>`
          : `<input class="t-input js-v" type="text" value="${esc(e.value ?? "")}" aria-label="${esc(e.name)}" spellcheck="false" autocomplete="off" />
             <label class="kf-check" title="Take it off the topic: the cluster's default applies again"><input type="checkbox" class="js-def" /> default</label>`
      }
    </div>`;
  const d = openDialog(
    `
    <p class="modal-title">Settings of <b>${esc(topic)}</b></p>
    <p class="modal-hint">${clusterLine(model)} · only what is changed here is written; every other setting is left as it is</p>
    <label>settings this topic holds</label>
    <div class="kf-settings js-settings">${here.map(row).join("")}</div>
    ${here.some((e) => !e.readOnly) ? "" : `<p class="modal-hint">Nothing here differs from the cluster's defaults.</p>`}
    <label>another setting</label>
    <div class="kf-send-row js-add">
      <input class="t-input js-name" type="text" placeholder="name, e.g. max.message.bytes" aria-label="Setting name" spellcheck="false" autocomplete="off" />
      <input class="t-input js-value" type="text" placeholder="value — empty puts it back to the cluster's default" aria-label="Setting value" spellcheck="false" autocomplete="off" />
    </div>
    <div class="js-preview kf-reset-preview" hidden></div>
    <p class="modal-hint is-error js-err" hidden></p>
    <div class="modal-row">
      <button type="button" class="t-btn cancel">cancel</button>
      <button type="button" class="t-btn js-preview-btn">preview</button>
      <button type="submit" class="t-btn t-btn-primary js-ok" disabled>apply</button>
    </div>`,
    true,
  );
  const $ = <T extends HTMLElement>(sel: string): T => d.form.querySelector<T>(sel)!;
  const err = $<HTMLElement>(".js-err");
  const preview = $<HTMLElement>(".js-preview");
  const ok = $<HTMLButtonElement>(".js-ok");
  const previewBtn = $<HTMLButtonElement>(".js-preview-btn");
  const added = $<HTMLElement>(".js-add");
  let shown: string | null = null;

  // Any change puts the preview away: what is applied is what was shown, not what is on screen now.
  const stale = (): void => {
    preview.hidden = true;
    ok.disabled = true;
    err.hidden = true;
    shown = null;
  };
  d.form.addEventListener("input", stale);

  const collect = (dryRun: boolean): Parameters<KafkaModel["alterTopicConfigs"]>[0] | string => {
    const configs: Record<string, string | null> = {};
    for (const el of d.form.querySelectorAll<HTMLElement>(".js-set")) {
      const value = el.querySelector<HTMLInputElement>(".js-v");
      const back = el.querySelector<HTMLInputElement>(".js-def");
      if (!value || !back) continue; // read-only: shown, not offered
      const name = el.dataset.name!;
      if (back.checked) configs[name] = null;
      else if (value.value !== el.dataset.before) configs[name] = value.value;
    }
    const name = $<HTMLInputElement>(".js-name").value.trim();
    const value = $<HTMLInputElement>(".js-value").value;
    if (name !== "") configs[name] = value === "" ? null : value;
    if (Object.keys(configs).length === 0) return "Nothing was changed: edit a value, tick “default”, or name another setting";
    return { topic, configs, dryRun };
  };

  const table = (rows: AlterConfigRow[]): string =>
    `<table class="kf-table"><thead><tr><th>setting</th><th>was</th><th>will be</th></tr></thead><tbody>${rows
      .map(
        (r) => `<tr><td class="kf-mono kf-wrap">${esc(r.name)}</td>
        <td class="kf-mono kf-wrap">${r.before === null ? `<span class="kf-muted" title="The cluster does not know this setting">—</span>` : esc(r.before)}${
          r.fromDefault ? ` <span class="kf-muted" title="Only the cluster's default so far">(default)</span>` : ""
        }</td>
        <td class="kf-mono kf-wrap"><b>${r.after === null ? `<span class="kf-muted">cluster default</span>` : esc(r.after)}</b></td></tr>`,
      )
      .join("")}</tbody></table>
      <p class="modal-hint">${
        rows.length === 0
          ? "Nothing would change: the topic already holds every value asked for."
          : `${rows.length} setting${rows.length === 1 ? "" : "s"} would be written on the topic.`
      }</p>`;

  previewBtn.addEventListener("click", async () => {
    err.hidden = true;
    const p = collect(true);
    if (typeof p === "string") {
      err.textContent = p;
      err.hidden = false;
      return;
    }
    previewBtn.disabled = true;
    try {
      const r = await model.alterTopicConfigs(p);
      preview.innerHTML = table(r.rows);
      preview.hidden = false;
      // Nothing to write is not something to apply: leave the button as it was.
      shown = r.rows.length === 0 ? null : JSON.stringify({ ...p, dryRun: false });
      ok.disabled = r.rows.length === 0;
    } catch (e) {
      stale();
      err.textContent = message(e);
      err.hidden = false;
    } finally {
      previewBtn.disabled = false;
    }
  });

  d.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = collect(false);
    if (ok.disabled || typeof p === "string" || JSON.stringify(p) !== shown) return;
    ok.disabled = previewBtn.disabled = true;
    ok.textContent = "writing…";
    try {
      await model.alterTopicConfigs(p);
      d.close();
      onApplied();
    } catch (ex) {
      err.textContent = message(ex);
      err.hidden = false;
      ok.textContent = "apply";
      ok.disabled = true; // the preview no longer stands: look again
      previewBtn.disabled = false;
    }
  });
  d.form.querySelector(".cancel")!.addEventListener("click", d.close);
  const first = d.form.querySelector<HTMLInputElement>(".js-v") ?? added.querySelector<HTMLInputElement>(".js-name");
  first?.focus();
}

// ── add partitions ────────────────────────────────────────────────────────

/** Raise a topic's partition count. The count is the total afterwards, which is what the
 *  Kafka CLI means by it too; the cluster is asked first (`validateOnly`) so a count it
 *  will not take is a sentence in this dialog. */
export function addPartitionsDialog(model: KafkaModel, topic: string, current: number, onApplied: () => void): void {
  const d = openDialog(`
    <p class="modal-title">Add partitions to <b>${esc(topic)}</b></p>
    <p class="modal-hint">${clusterLine(model)}</p>
    <div class="kf-send-grid">
      <label for="kf-ap-now">partitions now</label>
      <div class="kf-mono" id="kf-ap-now">${current}</div>
      <label for="kf-ap-to">partitions after</label>
      <input id="kf-ap-to" class="t-input js-to" type="number" min="${current + 1}" step="1" value="${current + 1}" />
    </div>
    <p class="modal-hint is-warn">Kafka only adds partitions: it never removes them. Which partition a key goes to is the
      hash of the key modulo the number of partitions, so after this the messages of one key can be spread over more
      partitions and their order is no longer the order they were written in.</p>
    <p class="modal-hint js-note" hidden></p>
    <p class="modal-hint is-error js-err" hidden></p>
    <div class="modal-row">
      <button type="button" class="t-btn cancel">cancel</button>
      <button type="button" class="t-btn js-check">check</button>
      <button type="submit" class="t-btn t-btn-primary js-ok">add partitions</button>
    </div>`);
  const $ = <T extends HTMLElement>(sel: string): T => d.form.querySelector<T>(sel)!;
  const err = $<HTMLElement>(".js-err");
  const note = $<HTMLElement>(".js-note");
  const buttons = [$<HTMLButtonElement>(".js-check"), $<HTMLButtonElement>(".js-ok")];
  const collect = (validateOnly: boolean): Parameters<KafkaModel["addPartitions"]>[0] => ({
    topic,
    partitions: Number($<HTMLInputElement>(".js-to").value),
    validateOnly,
  });

  const run = async (add: boolean): Promise<void> => {
    err.hidden = note.hidden = true;
    const first = collect(true);
    if (!Number.isInteger(first.partitions) || first.partitions < 1) {
      err.textContent = "Partitions: a whole number, one or more";
      err.hidden = false;
      return;
    }
    for (const b of buttons) b.disabled = true;
    try {
      const checked = await model.addPartitions(first);
      if (!add) {
        note.textContent = `Good: the cluster would give ${checked.topic} ${checked.to} partitions (it has ${checked.from}). Nothing has been added.`;
        note.hidden = false;
      } else {
        await model.addPartitions({ ...first, validateOnly: false });
        d.close();
        onApplied();
      }
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
  $<HTMLInputElement>(".js-to").focus();
}

// ── delete records ────────────────────────────────────────────────────────

/** One partition of a topic, as the dialog needs it: where its log starts and ends now. */
export interface PartitionBounds {
  id: number;
  start: number;
  end: number;
}

/** Drop the records of one partition below an offset — the cluster's DeleteRecords. The
 *  count is worked out from the bounds the page last read, so what the dialog says will go
 *  is what the log held a moment ago; the agent checks the offset against the log again and
 *  refuses one past its end. Like deleting a topic, the name is typed to confirm. */
export function deleteRecordsDialog(model: KafkaModel, topic: string, partitions: PartitionBounds[], onApplied: (r: DeleteRecordsResult) => void): void {
  const options = partitions.map((p) => `<option value="${p.id}">partition ${p.id} — offsets ${p.start}–${p.end}</option>`).join("");
  const d = openDialog(`
    <p class="modal-title">Delete records of <b>${esc(topic)}</b></p>
    <p class="modal-hint">${clusterLine(model)}</p>
    <div class="kf-send-grid">
      <label for="kf-dr-part">partition</label>
      <select id="kf-dr-part" class="t-input js-part">${options}</select>
      <label for="kf-dr-off">delete below offset</label>
      <input id="kf-dr-off" class="t-input js-off" type="number" min="-1" step="1" value="${partitions[0]?.start ?? 0}" />
    </div>
    <p class="modal-hint js-what"></p>
    <p class="modal-hint is-warn">The records go for good, and only in this partition: what a consumer already read is
      unaffected, and one that starts now begins after them. -1 deletes everything the partition holds.</p>
    <label for="kf-dr-name">Type the topic's name to confirm</label>
    <input id="kf-dr-name" class="t-input js-name" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(topic)}" />
    <p class="modal-hint is-error js-err" hidden></p>
    <div class="modal-row">
      <button type="button" class="t-btn cancel">cancel</button>
      <button type="submit" class="t-btn t-btn-primary t-btn-danger js-ok" disabled>delete records</button>
    </div>`);
  const $ = <T extends HTMLElement>(sel: string): T => d.form.querySelector<T>(sel)!;
  const part = $<HTMLSelectElement>(".js-part");
  const off = $<HTMLInputElement>(".js-off");
  const name = $<HTMLInputElement>(".js-name");
  const ok = $<HTMLButtonElement>(".js-ok");
  const what = $<HTMLElement>(".js-what");
  const err = $<HTMLElement>(".js-err");
  let busy = false;

  // What the offset would delete, said before anything is asked of the cluster.
  const say = (): void => {
    const p = partitions.find((x) => x.id === Number(part.value));
    const at = Number(off.value);
    if (!p || !Number.isInteger(at)) {
      what.textContent = "";
      return;
    }
    const to = at === -1 ? p.end : Math.min(Math.max(at, p.start), p.end);
    const n = to - p.start;
    what.textContent =
      n <= 0
        ? `Partition ${p.id} holds offsets ${p.start}–${p.end}: nothing would be deleted.`
        : `Partition ${p.id} holds offsets ${p.start}–${p.end}: this deletes ${n} record${n === 1 ? "" : "s"}, and it starts at ${to} afterwards.`;
  };
  say();
  part.addEventListener("change", say);
  off.addEventListener("input", say);
  const sync = (): void => {
    ok.disabled = busy || name.value !== topic;
  };
  name.addEventListener("input", sync);
  d.form.querySelector(".cancel")!.addEventListener("click", d.close);

  d.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || name.value !== topic) return;
    const at = Number(off.value);
    if (!Number.isInteger(at) || at < -1) {
      err.textContent = "An offset of 0 or more, or -1 for everything in the partition";
      err.hidden = false;
      return;
    }
    busy = true;
    ok.disabled = name.disabled = off.disabled = part.disabled = true;
    ok.textContent = "deleting…";
    err.hidden = true;
    try {
      const r = await model.deleteRecords({ topic, partition: Number(part.value), offset: at, confirm: topic });
      d.close();
      onApplied(r);
    } catch (ex) {
      busy = false;
      name.disabled = off.disabled = part.disabled = false;
      ok.textContent = "delete records";
      sync();
      err.textContent = message(ex);
      err.hidden = false;
    }
  });
  name.focus();
}

// ── delete a consumer group ───────────────────────────────────────────────

/** Delete a consumer group and the offsets it committed. Offered only for a group in state
 *  `Empty` — a member would go on committing, and the cluster refuses it anyway — and the
 *  name is typed to confirm, as for a topic. */
export function deleteGroupDialog(model: KafkaModel, group: string, offsets: number, topics: number, onDeleted: (r: DeleteGroupResult) => void): void {
  const held =
    offsets === 0
      ? "It has committed no offsets."
      : `It has committed offsets for ${offsets} partition${offsets === 1 ? "" : "s"} of ${topics} topic${topics === 1 ? "" : "s"}.`;
  const d = openDialog(`
    <p class="modal-title">Delete the consumer group <b>${esc(group)}</b>?</p>
    <p class="modal-hint">${clusterLine(model)}</p>
    <p class="modal-hint">${esc(held)} Deleting it removes them: a consumer that starts with this group id again begins
      where its own configuration says, not where this group left off. Nothing in the topics themselves is deleted.</p>
    <label for="kf-dg-name">Type the group's name to confirm</label>
    <input id="kf-dg-name" class="t-input js-name" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(group)}" />
    <p class="modal-hint is-error js-err" hidden></p>
    <div class="modal-row">
      <button type="button" class="t-btn cancel">cancel</button>
      <button type="submit" class="t-btn t-btn-primary t-btn-danger js-ok" disabled>delete group</button>
    </div>`);
  const $ = <T extends HTMLElement>(sel: string): T => d.form.querySelector<T>(sel)!;
  const name = $<HTMLInputElement>(".js-name");
  const ok = $<HTMLButtonElement>(".js-ok");
  const err = $<HTMLElement>(".js-err");
  let busy = false;
  name.addEventListener("input", () => (ok.disabled = busy || name.value !== group));
  d.form.querySelector(".cancel")!.addEventListener("click", d.close);
  d.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || name.value !== group) return;
    busy = true;
    ok.disabled = name.disabled = true;
    ok.textContent = "deleting…";
    err.hidden = true;
    try {
      const r = await model.deleteGroup(group);
      d.close();
      onDeleted(r);
    } catch (ex) {
      busy = false;
      name.disabled = false;
      ok.textContent = "delete group";
      ok.disabled = name.value !== group;
      err.textContent = message(ex);
      err.hidden = false;
    }
  });
  name.focus();
}
