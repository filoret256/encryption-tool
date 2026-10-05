/** The main area: what is shown for whatever is selected in the side panel.
 *
 *  A view is an element that fills itself in from the agent when it is made and
 *  says nothing until it has something to say. It owns its requests, and a
 *  request that finishes after the view was replaced is ignored — the model
 *  cannot help with that, because these answers are not in it.
 */
import type {
  AclEntry,
  BrokerList,
  ConfigEntry,
  GroupDetail,
  SchemaVersionText,
  SubjectVersions,
  TopicDetail,
} from "../../kafka-agent/protocol.ts";
import { json } from "@codemirror/lang-json";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { esc } from "../code/ui.ts";
// A type only: the class itself is a bundle of its own, see loadDiffView.
import type { DiffView } from "../code/diff.ts";
import { cmBase, cmDark } from "../cm-theme.ts";
import { cspNonce } from "../csp.ts";
import { SCHEMA_TEXT, formatBytes, formatCount, plural } from "./format.ts";
import { iconCopy } from "./icons.ts";
import type { KafkaModel } from "./model.ts";
import { MessagesPanel } from "./messages.ts";
import { compatibilityControl, registerSchemaDialog } from "./schema-write.ts";
import { diffOrder, prettySchema } from "./schema-text.ts";
import { STATE_TEXT, groupState, stateDot } from "./side.ts";
import { addPartitionsDialog, alterConfigsDialog, deleteGroupDialog, deleteRecordsDialog, deleteTopicDialog, resetOffsetsDialog } from "./write.ts";

/** A thing on screen in the main area. */
export interface View {
  el: HTMLElement;
  /** Called when the view is replaced, so it can stop what it started. */
  dispose(): void;
  /** The page is no longer looking at this view (another browser tab) though it is
   *  still there: stop what only makes sense while watched — a live tail. */
  suspend?(): void;
  setTheme?(dark: boolean): void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A view that can be told it was replaced, so a late answer knows to be quiet. */
function live(): { alive: () => boolean; kill: () => void } {
  let on = true;
  return { alive: () => on, kill: () => (on = false) };
}

function view(className: string, html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `kf-view ${className}`;
  el.innerHTML = html;
  return el;
}

function fail(error: string): string {
  return `<div class="kf-note kf-note-bad">${esc(error)}</div>`;
}

const fact = (label: string, value: string): string => `<div class="kf-fact"><span class="kf-fact-l">${esc(label)}</span><span class="kf-fact-v">${value}</span></div>`;

// ── nothing selected ──────────────────────────────────────────────────────

export function emptyView(text: string): View {
  return { el: view("kf-empty", `<div class="kf-note">${esc(text)}</div>`), dispose: () => undefined };
}

/** No cluster is open: the clusters the agent offers, as a table — what each one is, whether it
 *  answers, whether it can be changed, and whether it has a registry — and a click opens one.
 *  An empty area with a sentence in it made the first step a guess. */
export function clustersView(model: KafkaModel): View {
  if (!model.clusters.length) return emptyView("The agent has no clusters. Describe some in its kafka-agent.yaml.");
  const rows = model.clusters
    .map((c) => {
      const st = model.statuses.get(c.name);
      const state = model.checking.has(c.name) ? "checking" : (st?.state ?? null);
      const reg = model.schemas.get(c.name);
      const registry = !reg
        ? `<span class="kf-muted">…</span>`
        : reg.state === "connected"
          ? "connected"
          : reg.state === "not_configured"
            ? `<span class="kf-muted">not configured</span>`
            : `<span class="kf-lag">${esc(SCHEMA_TEXT[reg.state])}</span>`;
      return `<tr class="kf-clickrow js-open" data-cluster="${esc(c.name)}" tabindex="0" role="button" aria-label="Open ${esc(c.name)}">
        <td>${stateDot(state)} <b>${esc(c.name)}</b></td>
        <td>${st ? esc(STATE_TEXT[st.state]) : `<span class="kf-muted">${state === "checking" ? "checking…" : "not checked"}</span>`}</td>
        <td>${c.readOnly ? `<span class="kf-tag">read-only</span>` : `<span class="kf-tag kf-tag-warn">writable</span>`}</td>
        <td>${registry}</td></tr>`;
    })
    .join("");
  const el = view(
    "kf-clusters",
    `<div class="kf-title"><h2>Clusters</h2><span class="kf-facts-inline">${model.clusters.length} from the agent — pick one to open it</span></div>
    <table class="kf-table kf-clusters-table"><thead><tr><th>cluster</th><th>state</th><th>access</th><th>schema registry</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
  const open = (ev: Event): void => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".js-open");
    if (row) void model.open(row.dataset.cluster!);
  };
  el.addEventListener("click", open);
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      open(ev);
    }
  });
  return { el, dispose: () => undefined };
}

// ── the cluster ───────────────────────────────────────────────────────────

export function clusterView(model: KafkaModel): View {
  const c = model.entry;
  if (!c) return emptyView("Pick a cluster on the left.");
  const st = model.status;
  const reg = model.schemas.get(c.name);
  const checking = model.checking.has(c.name);

  const state = checking ? "checking" : (st?.state ?? null);
  // The state dot and the access tag are in the toolbar and in the list on the left; a third
  // copy in this heading said nothing the other two did not.
  const head = `<div class="kf-title"><h2>${esc(c.name)}</h2></div>`;

  let body: string;
  if (checking && !st) body = `<div class="kf-note">connecting…</div>`;
  else if (!st) body = `<div class="kf-note">Not checked yet.</div>`;
  else if (st.state !== "connected") {
    body = `<div class="kf-status kf-status-bad"><b>${esc(STATE_TEXT[st.state])}</b><p>${esc(st.message ?? "")}</p>
      <button class="t-btn js-recheck" type="button">check again</button></div>`;
  } else {
    // The Schema Registry is a service of its own beside the cluster: its own URL, login
    // and stores. It is shown with its own words, and a registry that is not configured
    // is a fact, not a fault (see sr.go).
    const registryFact = !reg
      ? fact("schema registry", `<span class="kf-muted">…</span>`)
      : reg.state === "connected"
        ? fact(
            "schema registry",
            esc(`connected${reg.mode ? ` · ${reg.mode}` : ""}${reg.compatibility ? ` · ${reg.compatibility}` : ""}${reg.subjects === null ? "" : ` · ${reg.subjects} subject${reg.subjects === 1 ? "" : "s"}`}`),
          )
        : fact("schema registry", reg.state === "not_configured" ? `<span class="kf-muted">not configured</span>` : `<span class="kf-lag">${esc(SCHEMA_TEXT[reg.state])}</span>`);
    body = `<div class="kf-facts">
      ${fact("state", `connected`)}
      ${fact("cluster id", esc(st.clusterId ?? "—"))}
      ${fact("brokers", esc(String(st.brokers ?? "—")))}
      ${fact("controller", esc(st.controller === null ? "—" : `broker ${st.controller}`))}
      ${fact("kafka", esc(st.version ?? "—"))}
      ${fact("security", esc(c.mechanism ? `${c.protocol} · ${c.mechanism}` : c.protocol))}
      ${registryFact}
    </div>
    ${reg && reg.state !== "connected" && reg.state !== "not_configured" ? `<div class="kf-note kf-note-bad">schema registry: ${esc(reg.message ?? SCHEMA_TEXT[reg.state])}</div>` : ""}`;
  }

  const el = view("kf-cluster", head + body);
  el.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest(".js-recheck")) void model.refresh();
  });
  return { el, dispose: () => undefined };
}

// ── configuration entries ─────────────────────────────────────────────────

/** A table of a broker's or a topic's settings, with a filter and a switch that
 *  hides what is only the default. `action`, when given, is the one thing that may
 *  be done to them — changing a topic's settings — offered beside the filter. */
function configTable(
  host: HTMLElement,
  load: () => Promise<ConfigEntry[]>,
  life: ReturnType<typeof live>,
  failed: (e: unknown) => void,
  action?: { label: string; title: string; run: () => void; writable: () => boolean },
): void {
  host.innerHTML = `<div class="kf-note">loading…</div>`;
  void load().then(
    (entries) => {
      if (!life.alive()) return;
      host.innerHTML = `
        <div class="kf-bar">
          <input class="t-input js-filter" type="search" placeholder="filter settings" spellcheck="false" autocomplete="off" aria-label="Filter settings" />
          <button class="t-btn js-changed is-active" type="button" title="Show only settings somebody changed">changed only</button>
          <span class="t-spacer"></span>
          ${action ? `<button class="t-btn js-act" type="button" title="${esc(action.title)}" data-write${action.writable() ? "" : " hidden"}>${esc(action.label)}</button>` : ""}
          <span class="kf-count js-count"></span>
        </div>
        <div class="kf-scroll"><table class="kf-table"><thead><tr><th>name</th><th>value</th><th>source</th></tr></thead><tbody class="js-rows"></tbody></table></div>`;
      const rows = host.querySelector<HTMLElement>(".js-rows")!;
      const count = host.querySelector<HTMLElement>(".js-count")!;
      const filter = host.querySelector<HTMLInputElement>(".js-filter")!;
      const toggle = host.querySelector<HTMLButtonElement>(".js-changed")!;
      if (action) host.querySelector<HTMLElement>(".js-act")!.addEventListener("click", action.run);
      let changedOnly = true;
      const paint = (): void => {
        const f = filter.value.trim().toLowerCase();
        const shown = entries.filter((e) => (!changedOnly || !e.isDefault) && (f === "" || e.name.toLowerCase().includes(f) || (e.value ?? "").toLowerCase().includes(f)));
        count.textContent = `${shown.length} of ${entries.length}`;
        if (shown.length === 0) {
          // Say why, and how to see the rest: an empty table looks like a failure.
          rows.innerHTML = `<tr><td colspan="3" class="kf-muted">${
            changedOnly && f === "" ? "Nothing here differs from the defaults — turn off “changed only” to see every setting." : "No setting matches."
          }</td></tr>`;
          return;
        }
        rows.innerHTML = shown
          .map((e) => {
            const value = e.sensitive ? `<span class="kf-muted" title="A sensitive value: the agent never reads it out">••••••••</span>` : e.value === null ? `<span class="kf-muted">null</span>` : esc(e.value);
            return `<tr><td class="kf-mono">${esc(e.name)}${e.readOnly ? ` <span class="kf-tag" title="Cannot be changed while the broker runs">read-only</span>` : ""}</td><td class="kf-mono kf-wrap">${value}</td><td class="kf-muted">${esc(e.source)}</td></tr>`;
          })
          .join("");
      };
      filter.addEventListener("input", paint);
      toggle.addEventListener("click", () => {
        changedOnly = !changedOnly;
        toggle.classList.toggle("is-active", changedOnly);
        paint();
      });
      paint();
    },
    (e) => {
      if (!life.alive()) return;
      host.innerHTML = fail(message(e));
      failed(e);
    },
  );
}

// ── a schema subject ──────────────────────────────────────────────────────

/** One subject of the cluster's Schema Registry: its versions, its own compatibility and
 *  mode, the text of one version, and a diff of two of them (K-43).
 *
 *  Nothing here is cached in the model: a subject is opened rarely, and its versions cost
 *  one registry request per version (see srschema.go). The diff is the same component the
 *  code tab uses, so a schema diff reads like a file diff.
 *
 *  What is on screen follows three things: `shown` (the version being read), `diffing` (the
 *  pair being compared, or null) and the theme. A change of the theme or of the level
 *  touches only what it changes — the editors are recoloured, the level is written where it
 *  is — so a diff somebody is reading is still there afterwards. */
/** The diff view, fetched on the first comparison: its bundle carries every grammar (V-23), in a chunk it shares with the code tab (X-11).
 *  The specifier is built at run time so that the bundler leaves it as a runtime import: with
 *  `--minify` a plain constant is folded into the call and then fails to resolve. */
async function loadDiffView(): Promise<typeof DiffView> {
  const url = ["", "public", "kafka-diff.js"].join("/");
  const mod = (await import(url)) as typeof import("../kafka-diff.ts");
  return mod.DiffView;
}

export function subjectView(model: KafkaModel, name: string, dark: boolean): View {
  const life = live();
  const cluster = model.cluster!;
  const el = view("kf-subject", `<div class="kf-note">loading…</div>`);
  let versions: SubjectVersions | null = null;
  const texts = new Map<number, SchemaVersionText>();
  let shown: SchemaVersionText | null = null;
  let diff: DiffView | null = null;
  /** Which fill of the body a late-arriving diff chunk belongs to: a chunk that comes after the
   *  person has gone elsewhere is dropped instead of drawn into someone else's markup. */
  let diffFill = 0;
  let diffing: [number, number] | null = null;
  let textView: EditorView | null = null;
  let isDark = dark;
  /** Which comparison was asked for last: an answer for an earlier one is not drawn. */
  let diffSeq = 0;
  /** Why the last change did not go through, in the registry's own words. What is written
   *  from here changes somebody else's registry, so a failure has to be on screen. */
  let failure = "";
  /** Colour of the single text, reconfigured on a theme change instead of rebuilding it. */
  const cDark = new Compartment();
  const cHighlight = new Compartment();
  const highlight = (d: boolean): Extension => syntaxHighlighting(d ? oneDarkHighlightStyle : defaultHighlightStyle);

  /** What the registry holds for a version, laid out to be read and compared. */
  const readable = (t: SchemaVersionText): string => prettySchema(t.type, t.schema);

  /** The single schema text: a read-only editor, JSON-highlighted for Avro and the JSON
   *  format, plain for a .proto (this bundle has no protobuf grammar). */
  const textPane = (): string => {
    if (!shown) return `<div class="kf-note">Pick a version.</div>`;
    const refs = shown.references.length
      ? `<p class="modal-hint">references: ${shown.references.map((r) => `${esc(r.name)} → ${esc(r.subject)} v${r.version}`).join(", ")}</p>`
      : "";
    return `<div class="kf-bar">
        <span class="kf-mono">v${shown.version} · id ${shown.id} · ${esc(shown.type)}</span>
        <span class="t-spacer"></span>
        <button class="t-btn js-copy" type="button" title="Copy the schema">${iconCopy}</button>
      </div>${refs}<div class="kf-scroll kf-schema-text js-text"></div>`;
  };

  /** The note for a failed change, in place: a repaint would take the diff with it. */
  const showFailure = (why: string): void => {
    failure = why;
    el.querySelector(".js-failure")?.remove();
    if (!why) return;
    const note = document.createElement("div");
    note.className = "kf-note kf-note-bad js-failure";
    note.textContent = why;
    el.querySelector(".kf-title")?.after(note);
  };

  /** Everything, from what is known. Called when the versions, the open version or the
   *  compared pair change — never for a theme or a level. */
  const paint = (): void => {
    if (!versions) return;
    dropEditors();
    const rows = versions.versions
      .map((v) => {
        const open = shown?.version === v.version;
        const paired = diffing !== null && (diffing[0] === v.version || diffing[1] === v.version);
        // The open version is what the others are compared with: comparing it with itself
        // is not a question, so it has no button.
        const compare = open
          ? ""
          : `<button class="t-btn js-compare" type="button" data-version="${v.version}" title="Compare this version with v${shown?.version ?? "the one shown"}">compare</button>`;
        return `<div class="kf-row js-version${open ? " sel" : ""}${paired ? " pair" : ""}" data-version="${v.version}" role="button" tabindex="0"${paired ? ` aria-current="true"` : ""}>
          <span class="kf-name">v${v.version}</span>
          <span class="kf-meta">id ${v.id} · ${esc(v.type)}</span>
          <span class="t-spacer"></span>${compare}
        </div>`;
      })
      .join("");
    // Where the cluster may be changed, the level is a control rather than a fact; the
    // registry's default — which a subject with no level of its own follows — is its first
    // choice, and compatibilityControl names it with the level that default currently is.
    const facts = `${versions.versions.length} version${versions.versions.length === 1 ? "" : "s"}${
      model.readOnly && versions.compatibility ? ` · ${esc(versions.compatibility)}` : ""
    }${versions.mode ? ` · ${esc(versions.mode)}` : ""}`;
    el.innerHTML = `
      <div class="kf-title"><h2>${esc(name)}</h2>
        <span class="kf-facts-inline">${facts}</span>
        <span class="t-spacer"></span>
        ${model.readOnly ? "" : `<span class="kf-compat-host js-compat-host"></span>`}
        ${model.readOnly ? "" : `<button class="t-btn js-new-version" type="button" title="Register a new version of this subject">new version…</button>`}
        <button class="t-btn js-close-diff" type="button" hidden>close the diff</button>
      </div>
      <div class="kf-schema">
        <div class="kf-schema-list">${rows}</div>
        <div class="kf-schema-body js-body"></div>
      </div>`;
    if (!model.readOnly) {
      el.querySelector<HTMLElement>(".js-compat-host")!.append(
        compatibilityControl(
          model,
          name,
          versions.compatibility,
          (level) => {
            if (versions) versions.compatibility = level;
            showFailure("");
          },
          showFailure,
        ),
      );
    }
    showFailure(failure);
    attach();
    mountBody();
  };

  /** The buttons that hang off the whole view. */
  const attach = (): void => {
    for (const row of el.querySelectorAll<HTMLElement>(".js-version")) {
      const pick = (): void => void showVersion(Number(row.dataset.version));
      row.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".js-compare")) return; // its own handler
        pick();
      });
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          pick();
        }
      });
    }
    for (const b of el.querySelectorAll<HTMLElement>(".js-compare")) {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const other = Number(b.dataset.version);
        if (shown) void showDiff(shown.version, other);
      });
    }
    el.querySelector(".js-close-diff")?.addEventListener("click", () => {
      diffing = null;
      paint();
    });
    const close = el.querySelector<HTMLButtonElement>(".js-close-diff");
    if (close) close.hidden = !diffing;
    el.querySelector(".js-new-version")?.addEventListener("click", () =>
      registerSchemaDialog(model, {
        subject: name,
        onRegistered: () => {
          // The new version is what the person just wrote: show it, rather than leaving
          // them on the version they were reading.
          void load();
        },
      }),
    );
  };

  /** Fill the body: the diff when a pair is being compared, otherwise the open version. */
  const mountBody = (): void => {
    const body = el.querySelector<HTMLElement>(".js-body");
    if (!body) return;
    const fill = ++diffFill;
    if (diffing) {
      const [a, b] = diffing;
      const before = texts.get(a);
      const after = texts.get(b);
      if (!before || !after) return;
      body.innerHTML = `<div class="js-diff kf-schema-diff"><div class="kf-note">loading the diff…</div></div>`;
      const diffHost = body.querySelector<HTMLElement>(".js-diff")!;
      void loadDiffView().then(
        (DiffViewClass) => {
          if (fill !== diffFill) return;
          diffHost.replaceChildren();
          diff = new DiffViewClass(diffHost, isDark);
          // The path is what the diff's language is read from: an Avro or JSON Schema is JSON,
          // and a .proto has no grammar here, so it is shown as it is.
          const jsonish = before.type === "AVRO" || before.type === "JSON";
          diff.show({
            path: jsonish ? `${name}.json` : name,
            before: readable(before),
            after: readable(after),
            beforeLabel: `v${a} (id ${before.id})`,
            afterLabel: `v${b} (id ${after.id})`,
            binary: false,
          });
        },
        (e: unknown) => {
          if (fill !== diffFill) return;
          diffHost.textContent = `could not load the diff: ${e instanceof Error ? e.message : String(e)}`;
        },
      );
      return;
    }
    body.innerHTML = textPane();
    const host = body.querySelector<HTMLElement>(".js-text");
    if (host && shown) {
      const language = shown.type === "PROTOBUF" ? [] : json();
      textView = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: readable(shown),
          extensions: [
            EditorView.cspNonce.of(cspNonce),
            cmBase,
            cDark.of(cmDark(isDark)),
            cHighlight.of(highlight(isDark)),
            language,
            lineNumbers(),
            EditorView.lineWrapping,
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ],
        }),
      });
    }
    body.querySelector(".js-copy")?.addEventListener("click", () => {
      void navigator.clipboard?.writeText(textView?.state.doc.toString() ?? "").catch(() => undefined);
    });
  };

  /** Let go of the editors before their markup is replaced. */
  const dropEditors = (): void => {
    diffFill++; // a diff chunk still on its way is no longer wanted
    diff?.clear();
    diff = null;
    textView?.destroy();
    textView = null;
  };

  const fetchVersion = async (version: number): Promise<SchemaVersionText> => {
    const known = texts.get(version);
    if (known) return known;
    const text = await model.client.op("schemas.version", { cluster, subject: name, version });
    texts.set(version, text);
    return text;
  };

  const showVersion = async (version: number): Promise<void> => {
    let text: SchemaVersionText;
    try {
      text = await fetchVersion(version);
    } catch (e) {
      if (life.alive()) model.logError("schemas.version", e);
      return;
    }
    if (!life.alive()) return;
    diffing = null;
    diffSeq++;
    shown = text;
    paint();
  };

  const showDiff = async (a: number, b: number): Promise<void> => {
    if (a === b) return;
    const seq = ++diffSeq;
    try {
      await Promise.all([fetchVersion(a), fetchVersion(b)]);
    } catch (e) {
      if (!life.alive() || seq !== diffSeq) return;
      model.logError("schemas.version", e);
      // In the view, not only in the log: a click that answers nothing looks like a dead button.
      dropEditors();
      diffing = null;
      paint();
      const body = el.querySelector<HTMLElement>(".js-body");
      if (body) body.insertAdjacentHTML("afterbegin", fail(`Could not read v${a} and v${b} to compare them: ${message(e)}`));
      return;
    }
    if (!life.alive() || seq !== diffSeq) return;
    // Older on the left, newer on the right, whichever was open and whichever was clicked.
    diffing = diffOrder(a, b);
    paint();
  };

  /** Read the subject again and show its newest version: asked for when the view is made,
   *  and after a registration, where the newest version is the one just written (K-47). */
  const load = async (): Promise<void> => {
    let v: SubjectVersions;
    try {
      v = await model.client.op("schemas.versions", { cluster, subject: name });
    } catch (e) {
      if (life.alive()) {
        el.innerHTML = `<div class="kf-title"><h2>${esc(name)}</h2></div>${fail(message(e))}`;
        model.logError("schemas.versions", e);
      }
      return;
    }
    if (!life.alive()) return;
    versions = v;
    paint();
    if (v.versions.length === 0) return;
    await showVersion(v.versions[v.versions.length - 1].version);
  };

  void load();

  return {
    el,
    dispose: () => {
      dropEditors();
      life.kill();
    },
    // The editors are recoloured where they stand. Rebuilding the page for this took the
    // diff with it, and the person was back at the single text.
    setTheme: (d) => {
      isDark = d;
      diff?.setTheme(d);
      textView?.dispatch({ effects: [cDark.reconfigure(cmDark(d)), cHighlight.reconfigure(highlight(d))] });
    },
  };
}

// ── ACLs ──────────────────────────────────────────────────────────────────

/** Every ACL the login may see, as a table with a filter (K-44). Read-only: this agent has
 *  no op that creates or deletes an ACL.
 *
 *  The table follows the model itself, so a repaint costs the filter nothing: only the
 *  table is rebuilt, never the inputs. */
/** One row per resource, with the operations that share it as a list: "READ, WRITE on topic
 *  orders" was two rows that differed in one cell. What else is the same — the pattern, the
 *  permission and the host — keeps allow and deny apart. */
function byResource(list: AclEntry[]): { acl: AclEntry; operations: string[] }[] {
  const rows = new Map<string, { acl: AclEntry; operations: string[] }>();
  for (const a of list) {
    const key = [a.resourceType, a.resourceName, a.patternType, a.permission, a.host].join("\u0000");
    const row = rows.get(key);
    if (row) row.operations.push(a.operation);
    else rows.set(key, { acl: a, operations: [a.operation] });
  }
  return [...rows.values()];
}

export function aclView(model: KafkaModel): View {
  const el = view("kf-acls", "");
  let off: (() => void) | null = null;
  let offFilter: (() => void) | null = null;
  el.innerHTML = `
    <div class="kf-title"><h2>ACLs</h2>
      <span class="kf-facts-inline js-count"></span>
    </div>
    <div class="kf-filter">
      <input class="t-input js-principal" type="search" placeholder="filter by principal" spellcheck="false" autocomplete="off" aria-label="Filter by principal" />
      <input class="t-input js-resource" type="search" placeholder="filter by resource" spellcheck="false" autocomplete="off" aria-label="Filter by resource" />
    </div>
    <div class="kf-scroll kf-acl-table js-table"></div>`;
  const table = el.querySelector<HTMLElement>(".js-table")!;
  const count = el.querySelector<HTMLElement>(".js-count")!;
  const principalInput = el.querySelector<HTMLInputElement>(".js-principal")!;
  const resourceInput = el.querySelector<HTMLInputElement>(".js-resource")!;

  /** What the filter says now: the inputs are the truth while somebody types in them. */
  const filters = (): { principal: string; resource: string } => ({
    principal: principalInput.value.trim().toLowerCase(),
    resource: resourceInput.value.trim().toLowerCase(),
  });

  const paint = (): void => {
    // A filter set from the panel (a principal picked in it) lands in the input, and the
    // input is only written when it differs — writing it while somebody types would move
    // their cursor.
    const wanted = model.aclFilter;
    if (principalInput.value !== wanted.principal) principalInput.value = wanted.principal;
    if (resourceInput.value !== wanted.resource) resourceInput.value = wanted.resource;

    const load = model.acls;
    const all = load.data ?? [];
    const f = filters();
    // A principal picked in the panel is matched whole; one typed in the box, as a part.
    const exact = model.aclFilter.exact;
    const shown = all.filter(
      (a) =>
        (f.principal === "" || (exact ? a.principal.toLowerCase() === f.principal : a.principal.toLowerCase().includes(f.principal))) &&
        (f.resource === "" || a.resourceName.toLowerCase().includes(f.resource) || a.resourceType.toLowerCase().includes(f.resource)),
    );
    count.textContent = all.length ? `${all.length} ACL${all.length === 1 ? "" : "s"}${f.principal || f.resource ? ` · ${shown.length} shown` : ""}` : "";
    // Grouped by principal: what a person came to the page for is what one login may do,
    // and a flat table of a hundred rows does not answer that.
    const byPrincipal = new Map<string, AclEntry[]>();
    for (const a of shown) {
      const list = byPrincipal.get(a.principal) ?? [];
      list.push(a);
      byPrincipal.set(a.principal, list);
    }
    table.innerHTML =
      load.state === "loading" && !all.length
        ? `<div class="kf-note">loading…</div>`
        : load.state === "error"
          ? fail(load.error)
          : shown.length === 0
            ? `<div class="kf-note">${
                all.length === 0
                  ? "This cluster has no ACLs. Kafka lets everyone in when none are set — unless the broker runs with allow.everyone.if.no.acl.found=false."
                  : "No ACL matches the filter."
              }</div>`
            : [...byPrincipal.entries()]
                .map(
                  ([who, list]) => `
        <div class="kf-acl-group">
          <h3 class="kf-h3">${esc(who)} <span class="kf-muted">· ${list.length} ACL${list.length === 1 ? "" : "s"}</span></h3>
          <table class="kf-table kf-acls"><thead><tr>
            <th>resource</th><th>name</th><th>pattern</th><th>operations</th><th>permission</th><th>host</th>
          </tr></thead><tbody>
            ${byResource(list)
              .map(
                ({ acl: a, operations }) => `<tr${a.permission === "deny" ? ` class="kf-acl-deny"` : ""}>
              <td class="kf-muted">${esc(a.resourceType)}</td>
              <td class="kf-mono kf-wrap">${esc(a.resourceName)}</td>
              <td class="kf-muted">${esc(a.patternType)}</td>
              <td><span class="kf-ops">${operations.map((o) => `<span class="kf-tag">${esc(o)}</span>`).join("")}</span></td>
              <td><span class="kf-tag kf-tag-${a.permission === "deny" ? "bad" : "ok"}">${esc(a.permission)}</span></td>
              <td class="kf-mono kf-muted">${esc(a.host)}</td></tr>`,
              )
              .join("")}
          </tbody></table>
        </div>`,
                )
                .join("");
  };

  // One repaint per keystroke: the model tells the listeners below, and that is the only paint.
  // Typing in the principal box is a part of a name, so it ends an exact pick from the panel.
  principalInput.addEventListener("input", () => model.setACLFilter({ principal: principalInput.value, exact: false }));
  resourceInput.addEventListener("input", () => model.setACLFilter({ resource: resourceInput.value }));

  paint();
  off = model.subscribe(() => paint());
  offFilter = model.subscribeACLFilter(() => paint());
  return {
    el,
    dispose: () => {
      off?.();
      off = null;
      offFilter?.();
      offFilter = null;
    },
  };
}

// ── a broker ──────────────────────────────────────────────────────────────

export function brokerView(model: KafkaModel, id: number): View {
  const life = live();
  const b = (model.brokers.data as BrokerList | null)?.brokers.find((x) => x.id === id);
  const el = view(
    "kf-broker",
    `<div class="kf-title"><h2>broker ${id}</h2>${b?.controller ? `<span class="kf-tag kf-tag-ok">controller</span>` : ""}</div>
     ${b ? `<div class="kf-facts">${fact("address", esc(`${b.host}:${b.port}`))}${fact("rack", esc(b.rack ?? "—"))}</div>` : ""}
     <h3 class="kf-h3">configuration</h3><div class="kf-fill js-config"></div>`,
  );
  const cluster = model.cluster!;
  configTable(el.querySelector(".js-config")!, () => model.client.op("brokers.config", { cluster, broker: id }), life, (e) => model.logError("brokers.config", e));
  return { el, dispose: life.kill };
}

// ── a consumer group ──────────────────────────────────────────────────────

export function groupView(model: KafkaModel, name: string): View {
  const life = live();
  const el = view("kf-group", `<div class="kf-title"><h2>${esc(name)}</h2></div><div class="kf-note">loading…</div>`);
  const cluster = model.cluster!;

  let detail: GroupDetail | null = null;
  const load = (): void => void model.client.op("groups.describe", { cluster, group: name }).then(
    (g: GroupDetail) => {
      if (!life.alive()) return;
      detail = g;
      const members = g.members.length
        ? `<table class="kf-table"><thead><tr><th>client</th><th>host</th><th>member id</th><th>assigned</th></tr></thead><tbody>${g.members
            .map(
              (m) => `<tr><td>${esc(m.clientId)}</td><td class="kf-muted">${esc(m.host)}</td><td class="kf-mono kf-muted kf-wrap">${esc(m.memberId)}</td>
              <td class="kf-mono">${m.assignments.map((a) => `${esc(a.topic)} ${a.partitions.map((p) => `#${p}`).join(" ")}`).join("<br>")}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : `<div class="kf-note">No members: nobody is reading as this group right now.</div>`;
      const byId = new Map(g.members.map((m) => [m.memberId, m.clientId]));
      const lag = g.lag.length
        ? `<table class="kf-table"><thead><tr><th>topic</th><th>partition</th><th>committed</th><th>end</th><th>lag</th><th>member</th></tr></thead><tbody>${g.lag
            .map(
              (r) => `<tr><td><a href="#" class="js-topic" data-topic="${esc(r.topic)}">${esc(r.topic)}</a></td><td>${r.partition}</td>
              <td>${r.committed === null ? `<span class="kf-muted" title="Nothing committed for this partition">—</span>` : esc(formatCount(r.committed))}</td>
              <td>${esc(formatCount(r.end))}</td><td class="${r.lag > 0 ? "kf-lag" : ""}">${esc(formatCount(r.lag))}</td>
              <td class="kf-muted">${r.member === null ? "" : esc(byId.get(r.member) ?? r.member)}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : `<div class="kf-note">This group has committed nothing and holds no partitions.</div>`;
      // Offered only where the cluster may be changed; possible only while nobody is in the group.
      const idle = g.state === "Empty";
      const why = idle ? "" : `Not while the group is ${esc(g.state)}: stop its consumers first`;
      const reset = model.readOnly
        ? ""
        : `<span class="t-spacer"></span><button class="t-btn t-btn-quiet-danger js-reset" type="button"${idle ? "" : " disabled"} title="${idle ? "Move this group's offsets — with a preview first" : why}">reset offsets…</button>`;
      const remove = model.readOnly
        ? ""
        : `<button class="t-btn t-btn-quiet-danger js-delgroup" type="button"${idle ? "" : " disabled"} title="${idle ? "Delete this group and the offsets it committed" : why}">delete group…</button>`;
      el.innerHTML = `<div class="kf-title"><h2>${esc(g.name)}</h2>${groupState(g.state)}${reset}${remove}</div>
        <div class="kf-facts">${fact("protocol", esc(g.protocolType + (g.protocol ? ` · ${g.protocol}` : "")))}${fact("coordinator", `broker ${g.coordinator}`)}${fact("total lag", `<b class="${g.totalLag > 0 ? "kf-lag" : ""}">${esc(formatCount(g.totalLag))}</b>`)}</div>
        <h3 class="kf-h3">members · ${g.members.length}</h3>${members}<h3 class="kf-h3">offsets</h3>${lag}`;
    },
    (e) => {
      if (!life.alive()) return;
      el.innerHTML = `<div class="kf-title"><h2>${esc(name)}</h2></div>${fail(message(e))}`;
      model.logError("groups.describe", e);
    },
  );
  load();

  el.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest(".js-reset") && detail) {
      const topics = [...new Set(detail.lag.map((r) => r.topic))];
      if (topics.length === 0) return void model.notify?.("This group has no committed offsets to reset", true);
      resetOffsetsDialog(model, { group: name, topics, onApplied: load });
      return;
    }
    if ((ev.target as HTMLElement).closest(".js-delgroup") && detail) {
      const held = detail.lag.filter((r) => r.committed !== null);
      deleteGroupDialog(model, name, held.length, new Set(held.map((r) => r.topic)).size, () => void model.loadGroups());
      return;
    }
    const a = (ev.target as HTMLElement).closest<HTMLElement>(".js-topic");
    if (!a) return;
    ev.preventDefault();
    model.setView("topics");
    model.select({ kind: "topic", name: a.dataset.topic! });
  });
  return { el, dispose: life.kill };
}

// ── a topic ───────────────────────────────────────────────────────────────

type TopicTab = "messages" | "partitions" | "config";

export function topicView(model: KafkaModel, name: string, dark: boolean, tab: TopicTab = "messages"): View {
  const life = live();
  const cluster = model.cluster!;
  const el = view(
    "kf-topic",
    `<div class="kf-title"><h2>${esc(name)}</h2><span class="kf-facts-inline js-facts"></span><span class="t-spacer"></span><button class="t-btn t-btn-quiet-danger js-delete" type="button" title="Delete this topic and everything in it" data-write hidden>delete topic</button></div>
     <div class="kf-tabs" role="tablist" aria-label="Topic">
       <button class="kf-tab" data-tab="messages" role="tab" type="button">messages</button>
       <button class="kf-tab" data-tab="partitions" role="tab" type="button">partitions</button>
       <button class="kf-tab" data-tab="config" role="tab" type="button">config</button>
     </div>
     <div class="kf-tabbody js-body"></div>`,
  );
  const body = el.querySelector<HTMLElement>(".js-body")!;
  const facts = el.querySelector<HTMLElement>(".js-facts")!;

  let detail: TopicDetail | null = null;
  let detailError = "";
  let messages: MessagesPanel | null = null;
  let current: TopicTab = tab;
  let isDark = dark;

  // Offered only where the cluster may be changed — and not for the cluster's own topics.
  // Every write button carries `data-write` and is shown or hidden by one place, so a
  // reload that turns the cluster read-only under an open page reaches all of them.
  const writable = (): boolean => !model.readOnly && !name.startsWith("__") && detail?.internal !== true;
  const syncWrites = (): void => {
    for (const b of el.querySelectorAll<HTMLElement>("[data-write]")) b.hidden = !writable();
  };
  const unsubscribe = model.subscribe(syncWrites);
  const deleteBtn = el.querySelector<HTMLButtonElement>(".js-delete")!;
  const count = (d: TopicDetail): number => d.partitions.reduce((n, p) => n + (p.end - p.start), 0);
  deleteBtn.addEventListener("click", async () => {
    // What it holds now, not when the page was opened: a message sent since would be
    // deleted while the dialog said the topic was empty.
    let held: number | null = detail ? count(detail) : (model.topics.data?.find((t) => t.name === name)?.messages ?? null);
    try {
      held = count(await model.client.op("topics.describe", { cluster, topic: name }));
    } catch {
      /* the last known count stands */
    }
    void deleteTopicDialog(model, name, held);
  });

  /** Read the topic again — its partitions and their offsets have moved, or its settings
   *  have — and paint whichever tab is open from what comes back. */
  const loadDetail = (): void => {
    void model.client.op("topics.describe", { cluster, topic: name }).then(
      (d) => {
        if (!life.alive()) return;
        detail = d;
        detailError = "";
        syncWrites();
        const total = d.partitions.reduce((n, p) => n + (p.end - p.start), 0);
        const size = d.partitions.every((p) => p.size !== null) ? d.partitions.reduce((n, p) => n + (p.size ?? 0), 0) : null;
        facts.innerHTML = `${esc(plural(d.partitions.length, "partition"))} · RF ${Math.max(...d.partitions.map((p) => p.replicas.length), 0)} · ${esc(plural(total, "message"))} · ${esc(formatBytes(size))}`;
        show(current);
      },
      (e) => {
        if (!life.alive()) return;
        detailError = message(e);
        model.logError("topics.describe", e);
        show(current);
      },
    );
  };

  /** The counters under the name, from the list on the left: what the topic holds changes when
   *  something is sent to it, and the list is read again then — so these follow it, instead of
   *  keeping the numbers from when the page was opened. */
  let shownMessages: number | null = null;
  const paintSummary = (): void => {
    const summary = model.topics.data?.find((t) => t.name === name);
    if (!summary || summary.messages === shownMessages) return;
    // The first paint is only the list's numbers, until the topic's own answer comes; after
    // that a change in the count means the partitions' offsets have moved too.
    const first = shownMessages === null;
    shownMessages = summary.messages;
    facts.innerHTML = `${esc(plural(summary.partitions, "partition"))} · RF ${summary.replicationFactor} · ${esc(plural(summary.messages, "message"))} · ${esc(formatBytes(summary.size))}`;
    if (!first) loadDetail();
  };
  paintSummary();
  const unsubscribeFacts = model.subscribe(paintSummary);

  // The two things that change a topic that is already there live beside the data they
  // act on: the partitions pane, and the settings pane.
  const onPartitionsClick = (ev: Event): void => {
    const t = ev.target as HTMLElement;
    if (t.closest(".js-addparts")) {
      addPartitionsDialog(model, name, detail?.partitions.length ?? model.topics.data?.find((t) => t.name === name)?.partitions ?? 1, loadDetail);
      return;
    }
    if (t.closest(".js-truncate")) {
      deleteRecordsDialog(model, name, (detail?.partitions ?? []).map((p) => ({ id: p.id, start: p.start, end: p.end })), loadDetail);
    }
  };

  const show = (which: TopicTab): void => {
    current = which;
    for (const b of el.querySelectorAll<HTMLElement>(".kf-tab")) {
      b.classList.toggle("active", b.dataset.tab === which);
      b.setAttribute("aria-selected", String(b.dataset.tab === which));
      // Only the current tab is in the tab order; the arrows move between them.
      b.tabIndex = b.dataset.tab === which ? 0 : -1;
    }
    if (which !== "messages") {
      messages?.hide();
    }
    if (which === "messages") {
      if (!messages) {
        messages = new MessagesPanel(model, name, isDark);
        body.appendChild(messages.el);
      }
      for (const other of body.querySelectorAll<HTMLElement>(":scope > .kf-pane")) other.hidden = true;
      messages.show(detail);
      return;
    }
    for (const other of body.querySelectorAll<HTMLElement>(":scope > .kf-pane")) other.hidden = true;
    // The config pane is filled in again every time it is shown rather than kept: those
    // are the settings `change settings…` writes, and what is on screen must be what the
    // cluster holds afterwards.
    if (which === "config") body.querySelector<HTMLElement>(':scope > .kf-pane[data-pane="config"]')?.remove();
    let pane = body.querySelector<HTMLElement>(`:scope > .kf-pane[data-pane="${which}"]`);
    if (!pane) {
      pane = document.createElement("div");
      pane.className = "kf-pane kf-fill";
      pane.dataset.pane = which;
      body.appendChild(pane);
      if (which === "config") {
        configTable(pane, () => model.client.op("topics.config", { cluster, topic: name }), life, (e) => model.logError("topics.config", e), {
          label: "change settings…",
          title: "Change this topic's settings — with a preview of the difference first",
          writable,
          run: () => {
            void model.client.op("topics.config", { cluster, topic: name }).then(
              (entries) => {
                if (life.alive()) alterConfigsDialog(model, name, entries, () => show("config"));
              },
              (e) => model.logError("topics.config", e),
            );
          },
        });
      } else {
        pane.addEventListener("click", onPartitionsClick);
        pane.innerHTML = partitionsHtml(detail, detailError, writable());
      }
    }
    pane.hidden = false;
    if (which === "partitions") pane.innerHTML = partitionsHtml(detail, detailError, writable());
    syncWrites();
  };

  const tabs = el.querySelector<HTMLElement>(".kf-tabs")!;
  tabs.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>(".kf-tab");
    if (b) show(b.dataset.tab as TopicTab);
  });
  tabs.addEventListener("keydown", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const all = [...tabs.querySelectorAll<HTMLElement>(".kf-tab")];
    const at = all.findIndex((b) => b.dataset.tab === current);
    const to = ev.key === "ArrowRight" ? at + 1 : ev.key === "ArrowLeft" ? at - 1 : ev.key === "Home" ? 0 : ev.key === "End" ? all.length - 1 : -1;
    if (to < 0) return;
    ev.preventDefault();
    const next = all[(to + all.length) % all.length];
    show(next.dataset.tab as TopicTab);
    next.focus();
  });

  loadDetail();
  show(current);
  syncWrites();

  return {
    el,
    dispose: () => {
      unsubscribe();
      unsubscribeFacts();
      life.kill();
      messages?.dispose();
    },
    suspend: () => messages?.suspend(),
    setTheme: (d) => {
      isDark = d;
      messages?.setTheme(d);
    },
  };
}

/** The partitions of a topic, with the two things that can be done to them: more
 *  partitions, and a truncation of one partition's log. Both are offered only where the
 *  cluster may be changed; `data-write` is how the view hides them all at once. */
function partitionsHtml(d: TopicDetail | null, error: string, writable: boolean): string {
  if (error) return fail(error);
  if (!d) return `<div class="kf-note">loading…</div>`;
  const bar = `<div class="kf-bar">
      <span class="kf-count js-count">${esc(plural(d.partitions.length, "partition"))}</span>
      <span class="t-spacer"></span>
      <button class="t-btn js-addparts" type="button" title="Give this topic more partitions — Kafka never takes them away" data-write${writable ? "" : " hidden"}>add partitions…</button>
      <button class="t-btn t-btn-quiet-danger js-truncate" type="button" title="Delete the records of one partition below an offset" data-write${writable ? "" : " hidden"}>delete records…</button>
    </div>`;
  return `${bar}<div class="kf-scroll"><table class="kf-table"><thead><tr><th>partition</th><th>leader</th><th>replicas</th><th>in sync</th><th>start</th><th>end</th><th>messages</th><th>size</th></tr></thead><tbody>${d.partitions
    .map((p) => {
      const behind = p.isr.length < p.replicas.length;
      return `<tr><td>${p.id}</td><td>${p.leader < 0 ? `<span class="kf-tag kf-tag-bad">none</span>` : p.leader}</td><td>${p.replicas.join(", ")}</td>
        <td>${behind ? `<span class="kf-tag kf-tag-warn" title="Fewer in-sync replicas than replicas">${p.isr.join(", ") || "none"}</span>` : p.isr.join(", ")}</td>
        <td>${esc(formatCount(p.start))}</td><td>${esc(formatCount(p.end))}</td><td>${esc(formatCount(p.end - p.start))}</td><td>${esc(formatBytes(p.size))}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}
