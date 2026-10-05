/** The lists in the side panel: clusters, topics, consumer groups, brokers.
 *
 *  Each is a view of the model and draws nothing the model does not hold.
 *  Clicking a row selects it; what to show for the selection is the main
 *  area's business (views.ts).
 *
 *  Each list is also a keyboard control: Tab reaches it, the arrow keys move a
 *  cursor over its rows, Enter opens the row under it. The cursor is not the
 *  selection — opening a topic asks the cluster for its messages, and holding
 *  the down arrow must not ask for every topic it passes.
 */
import type { ClusterState, GroupSummary, TopicSummary } from "../../kafka-agent/protocol.ts";
import { ROW_H, esc } from "../code/ui.ts";
import { VirtualList } from "../code/vlist.ts";
import { STATE_TEXT, SCHEMA_TEXT, formatCount } from "./format.ts";
import { iconEye, iconPlus } from "./icons.ts";
import type { KafkaModel, Load } from "./model.ts";
import { createTopicDialog } from "./write.ts";
import { registerSchemaDialog } from "./schema-write.ts";

export { STATE_TEXT };

/** The dot before a cluster's name: green when it answered, red when it did not,
 *  grey while nobody has asked. */
export function stateDot(state: ClusterState | "checking" | null): string {
  const cls = state === "connected" ? "ok" : state === "checking" || state === null ? "idle" : "bad";
  const title = state === "checking" ? "checking…" : state === null ? "not checked yet" : STATE_TEXT[state];
  return `<span class="kf-dot kf-dot-${cls}" role="img" aria-label="${esc(title)}" title="${esc(title)}"></span>`;
}

/** What to say in a list that has no rows: still loading, failed, or really empty. */
function stateNote<T>(load: Load<T>, empty: string): string {
  if (load.state === "loading" && load.data === null) return `<div class="kf-note">loading…</div>`;
  if (load.state === "error") {
    return `<div class="kf-note kf-note-bad">${esc(load.error)}<br><button class="t-btn js-retry" type="button">retry</button></div>`;
  }
  if (load.state === "idle") return `<div class="kf-note">${esc(empty)}</div>`;
  return "";
}

// ── the keyboard ──────────────────────────────────────────────────────────

const PAGE = 10;

/** What a key does to a list's cursor: the row it moves to, `"open"` for Enter or
 *  Space, or null when the key is not the list's to answer. */
export function listKey(e: KeyboardEvent, at: number, count: number): number | "open" | null {
  if (count === 0 || e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "ArrowDown": return Math.min(count - 1, at + 1);
    case "ArrowUp": return Math.max(0, at - 1);
    case "PageDown": return Math.min(count - 1, at + PAGE);
    case "PageUp": return Math.max(0, at - PAGE);
    case "Home": return 0;
    case "End": return count - 1;
    case "Enter":
    case " ": return "open";
  }
  return null;
}

/** Make an element a list the keyboard can drive, and give it its keys.
 *
 *  Focus stays on the element; the row under the cursor is named by
 *  aria-activedescendant, which is how a screen reader is told where the cursor is
 *  without the focus moving from row to row. Keys pressed on something inside the
 *  list — the retry button in a failed one — are that control's own. */
function makeListbox(el: HTMLElement, label: string, count: () => number, at: () => number, act: (to: number | "open") => void): void {
  el.tabIndex = 0;
  el.setAttribute("role", "listbox");
  el.setAttribute("aria-label", label);
  el.classList.add("kf-listbox");
  el.addEventListener("keydown", (ev) => {
    if (ev.target !== el) return;
    const to = listKey(ev, at(), count());
    if (to === null) return;
    ev.preventDefault();
    act(to);
  });
}

/** Move the cursor mark to row `id` inside `el` and bring the row into view. */
function markCursor(el: HTMLElement, id: string): void {
  for (const old of el.querySelectorAll(".kf-row.cur")) old.classList.remove("cur");
  const row = el.querySelector<HTMLElement>(`[id="${id}"]`);
  if (!row) return void el.removeAttribute("aria-activedescendant");
  row.classList.add("cur");
  el.setAttribute("aria-activedescendant", id);
  row.scrollIntoView({ block: "nearest" });
}

/** The typing field above a list: the down arrow steps into the list, Enter opens
 *  its first (or current) row, Escape empties the field. */
function filterKeys(input: HTMLInputElement, list: HTMLElement, open: () => void): void {
  input.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      list.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      open();
    } else if (e.key === "Escape" && input.value !== "") {
      e.preventDefault();
      input.value = "";
      input.dispatchEvent(new Event("input"));
    }
  });
}

/** Common to the four: a body that repaints from the model. */
abstract class SidePanel {
  constructor(
    protected readonly host: HTMLElement,
    protected readonly model: KafkaModel,
  ) {}
  abstract render(): void;
}

// ── clusters ──────────────────────────────────────────────────────────────

export class ClustersPanel extends SidePanel {
  private cursor = 0;
  /** The cluster the cursor last followed: it moves when the open one changes elsewhere. */
  private followed: string | null = null;

  constructor(host: HTMLElement, model: KafkaModel) {
    super(host, model);
    host.addEventListener("click", (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>("[data-cluster]");
      if (row) void model.open(row.dataset.cluster!);
    });
    makeListbox(
      host,
      "Clusters",
      () => model.clusters.length,
      () => this.cursor,
      (to) => {
        if (to === "open") return void model.open(model.clusters[this.cursor].name);
        this.cursor = to;
        markCursor(host, `kf-cluster-${to}`);
      },
    );
  }

  render(): void {
    const m = this.model;
    if (!m.clusters.length) {
      // An empty list means two things. With the agent there, it has no clusters; without it,
      // the list is empty because nobody was asked — and this panel stays in the page, under
      // the connect card, for a screen reader to read.
      this.paint(
        m.client.state === "online"
          ? `<div class="kf-note">The agent has no clusters. Describe some in its kafka-agent.yaml.</div>`
          : `<div class="kf-note">Not connected to a kafka-agent.</div>`,
      );
      return;
    }
    if (m.cluster !== this.followed) {
      this.followed = m.cluster;
      const open = m.clusters.findIndex((c) => c.name === m.cluster);
      if (open >= 0) this.cursor = open;
    }
    this.cursor = Math.min(this.cursor, m.clusters.length - 1);
    const html = m.clusters
      .map((c, i) => {
        const st = m.statuses.get(c.name);
        const dot = stateDot(m.checking.has(c.name) ? "checking" : (st?.state ?? null));
        const security = c.mechanism ? `${c.protocol} · ${c.mechanism}` : c.protocol;
        return `<div class="kf-row kf-cluster${c.name === m.cluster ? " sel" : ""}" id="kf-cluster-${i}" role="option" aria-selected="${c.name === m.cluster}" data-cluster="${esc(c.name)}" title="${esc(security)}">
          ${dot}<span class="kf-name">${esc(c.name)}</span>
          ${c.readOnly ? `<span class="kf-tag" title="The agent will not change anything on this cluster">read-only</span>` : `<span class="kf-tag kf-tag-warn" title="This cluster can be changed through the agent">writable</span>`}
        </div>`;
      })
      .join("");
    this.paint(html);
    markCursor(this.host, `kf-cluster-${this.cursor}`);
  }

  /** The model says something changed far more often than this list does: every status, every
   *  registry answer, every list of another view. The rows are replaced only when their markup
   *  is not what is already there — the clusters are a handful, so this is the whole of what a
   *  virtual list would have bought, without a second kind of list to keep right. */
  private lastHtml = "";
  private paint(html: string): void {
    if (html === this.lastHtml) return;
    this.lastHtml = html;
    this.host.innerHTML = html;
  }
}

// ── topics ────────────────────────────────────────────────────────────────

export class TopicsPanel extends SidePanel {
  private readonly list: VirtualList<TopicSummary>;
  private readonly listEl: HTMLElement;
  private readonly note: HTMLElement;
  private readonly count: HTMLElement;
  private readonly newBtn: HTMLButtonElement;
  private filter = "";
  private internal = false;
  private shown: TopicSummary[] = [];
  private cursor = 0;
  /** The topic the cursor last followed, so a change of selection made elsewhere moves it. */
  private followed = "";

  constructor(host: HTMLElement, model: KafkaModel) {
    super(host, model);
    host.innerHTML = `
      <div class="kf-filter">
        <input class="t-input js-filter" type="search" placeholder="filter topics" spellcheck="false" autocomplete="off" aria-label="Filter topics" />
        <button class="t-btn kf-iconbtn js-internal" type="button" aria-pressed="false" aria-label="Show internal topics" title="Show internal topics (__consumer_offsets and the like)">${iconEye}</button>
        <button class="t-btn kf-iconbtn js-new" type="button" aria-label="Create a topic" title="Create a topic" hidden>${iconPlus}</button>
      </div>
      <div class="kf-note js-note"></div>
      <div class="kf-count js-count" aria-live="polite"></div>
      <div class="js-list kf-list"></div>`;
    this.note = host.querySelector(".js-note")!;
    this.count = host.querySelector(".js-count")!;
    this.listEl = host.querySelector(".js-list")!;
    this.list = new VirtualList<TopicSummary>(this.listEl, ROW_H, (t, i) => this.row(t, i));
    this.list.onClick((t, i) => {
      this.cursor = i;
      model.select({ kind: "topic", name: t.name });
    });
    makeListbox(
      this.listEl,
      "Topics",
      () => this.shown.length,
      () => this.cursor,
      (to) => {
        if (to === "open") return this.open();
        this.cursor = to;
        this.list.scrollToIndex(to);
        this.markCursor();
      },
    );

    const filter = host.querySelector<HTMLInputElement>(".js-filter")!;
    filter.addEventListener("input", () => {
      this.filter = filter.value.trim().toLowerCase();
      // Typing starts a new list: the cursor goes to its top, and stays there rather
      // than jumping back to the open topic.
      this.cursor = 0;
      this.followed = this.selectedName();
      this.render();
    });
    filterKeys(filter, this.listEl, () => this.open());
    const internal = host.querySelector<HTMLButtonElement>(".js-internal")!;
    internal.addEventListener("click", () => {
      this.internal = !this.internal;
      internal.classList.toggle("is-active", this.internal);
      internal.setAttribute("aria-pressed", String(this.internal));
      this.render();
    });
    host.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".js-retry")) void model.loadTopics();
    });
    this.newBtn = host.querySelector<HTMLButtonElement>(".js-new")!;
    this.newBtn.addEventListener("click", () => createTopicDialog(model));
  }

  private selectedName(): string {
    const sel = this.model.selection;
    return sel.kind === "topic" ? sel.name : "";
  }

  private open(): void {
    const t = this.shown[this.cursor];
    if (t) this.model.select({ kind: "topic", name: t.name });
  }

  private markCursor(): void {
    this.listEl.setAttribute("aria-activedescendant", `kf-topic-${this.cursor}`);
  }

  private row(t: TopicSummary, i: number): string {
    const sel = this.selectedName() === t.name;
    const warn = t.underReplicated > 0 ? `<span class="kf-tag kf-tag-warn" title="${t.underReplicated} partition(s) with fewer in-sync replicas than replicas">under-replicated</span>` : "";
    return `<div class="kf-row${sel ? " sel" : ""}${i === this.cursor ? " cur" : ""}" id="kf-topic-${i}" role="option" aria-selected="${sel}" title="${esc(t.name)}">
      <span class="kf-name${t.internal ? " kf-internal" : ""}">${esc(t.name)}</span>${warn}
      <span class="kf-meta">${t.partitions}p · ${esc(formatCount(t.messages))}</span></div>`;
  }

  render(): void {
    const load = this.model.topics;
    // Creating is offered only where the cluster may be changed.
    this.newBtn.hidden = this.model.readOnly || !this.model.cluster;
    this.note.innerHTML = stateNote(load, "");
    this.note.hidden = this.note.innerHTML === "";
    this.shown = (load.data ?? []).filter(
      (t) => (this.internal || !t.internal) && (this.filter === "" || t.name.toLowerCase().includes(this.filter)),
    );
    this.count.textContent = load.data ? `${this.shown.length} of ${load.data.length} topics` : "";

    // A topic chosen somewhere else (the go-to picker, a link from a group) is where
    // the cursor should be the next time the list is entered.
    const name = this.selectedName();
    let scrollTo = -1;
    if (name !== this.followed) {
      this.followed = name;
      scrollTo = this.shown.findIndex((t) => t.name === name);
      if (scrollTo >= 0) this.cursor = scrollTo;
    }
    this.cursor = Math.min(this.cursor, Math.max(0, this.shown.length - 1));
    this.list.setItems(this.shown);
    if (scrollTo >= 0) this.list.scrollToIndex(scrollTo);
    this.markCursor();
  }
}

// ── schema subjects ───────────────────────────────────────────────────────

/** The registry's subjects: what the schema browser is a list of. Names only — what a
 *  subject's versions are is asked for when it is opened, because the registry charges one
 *  request per version for it (see srschema.go). */
export class SubjectsPanel extends SidePanel {
  private readonly list: VirtualList<string>;
  private readonly listEl: HTMLElement;
  private readonly note: HTMLElement;
  private readonly count: HTMLElement;
  private readonly newBtn: HTMLButtonElement;
  private filter = "";
  private shown: string[] = [];
  private cursor = 0;
  private followed = "";

  constructor(host: HTMLElement, model: KafkaModel) {
    super(host, model);
    host.innerHTML = `
      <div class="kf-filter">
        <input class="t-input js-filter" type="search" placeholder="filter subjects" spellcheck="false" autocomplete="off" aria-label="Filter subjects" />
        <button class="t-btn js-new" type="button" title="Register a schema: a new version, or a subject the registry has never had" hidden>+ new</button>
      </div>
      <div class="kf-note js-note"></div>
      <div class="kf-count js-count" aria-live="polite"></div>
      <div class="js-list kf-list"></div>`;
    this.note = host.querySelector(".js-note")!;
    this.count = host.querySelector(".js-count")!;
    this.listEl = host.querySelector(".js-list")!;
    this.list = new VirtualList<string>(this.listEl, ROW_H, (name, i) => this.row(name, i));
    this.list.onClick((name, i) => {
      this.cursor = i;
      model.select({ kind: "subject", name });
    });
    makeListbox(
      this.listEl,
      "Schema subjects",
      () => this.shown.length,
      () => this.cursor,
      (to) => {
        if (to === "open") return this.open();
        this.cursor = to;
        this.list.scrollToIndex(to);
        this.markCursor();
      },
    );
    const filter = host.querySelector<HTMLInputElement>(".js-filter")!;
    filter.addEventListener("input", () => {
      this.filter = filter.value.trim().toLowerCase();
      this.cursor = 0;
      this.followed = this.selectedName();
      this.render();
    });
    filterKeys(filter, this.listEl, () => this.open());
    this.newBtn = host.querySelector<HTMLButtonElement>(".js-new")!;
    this.newBtn.addEventListener("click", () => registerSchemaDialog(model, { subject: "", onRegistered: () => undefined }));
    host.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".js-retry")) void model.loadSubjects();
    });
  }

  private selectedName(): string {
    const sel = this.model.selection;
    return sel.kind === "subject" ? sel.name : "";
  }

  private open(): void {
    const name = this.shown[this.cursor];
    if (name) this.model.select({ kind: "subject", name });
  }

  private markCursor(): void {
    this.listEl.setAttribute("aria-activedescendant", `kf-subject-${this.cursor}`);
  }

  private row(name: string, i: number): string {
    const sel = this.selectedName() === name;
    return `<div class="kf-row${sel ? " sel" : ""}${i === this.cursor ? " cur" : ""}" id="kf-subject-${i}" role="option" aria-selected="${sel}" title="${esc(name)}">
      <span class="kf-name">${esc(name)}</span></div>`;
  }

  render(): void {
    const m = this.model;
    const status = m.cluster ? m.schemas.get(m.cluster) : null;
    // Writing a schema is a write, and a write is offered only where the agent allows one.
    this.newBtn.hidden = m.readOnly || !m.cluster || (status !== null && status !== undefined && status.state === "not_configured");
    // A cluster without a registry says so here rather than showing an empty list: the
    // list would be a lie about what the registry holds.
    if (m.cluster && status && status.state !== "connected") {
      this.note.innerHTML = status.state === "not_configured"
        ? `<div class="kf-note">This cluster has no Schema Registry. Add <span class="kf-mono">schemaRegistry</span> to it in the agent's kafka-agent.yaml.</div>`
        : `<div class="kf-note kf-note-bad">The schema registry ${esc(SCHEMA_TEXT[status.state])}: ${esc(status.message ?? "")}<br><button class="t-btn js-retry" type="button">retry</button></div>`;
      this.note.hidden = false;
      this.count.textContent = "";
      this.shown = [];
      this.list.setItems([]);
      return;
    }
    const load = m.subjects;
    this.note.innerHTML = stateNote(load, "No subjects.");
    this.note.hidden = this.note.innerHTML === "";
    this.shown = (load.data ?? []).filter((name) => this.filter === "" || name.toLowerCase().includes(this.filter));
    this.count.textContent = load.data ? `${this.shown.length} of ${load.data.length} subjects` : "";

    const name = this.selectedName();
    let scrollTo = -1;
    if (name !== this.followed) {
      this.followed = name;
      scrollTo = this.shown.indexOf(name);
      if (scrollTo >= 0) this.cursor = scrollTo;
    }
    this.cursor = Math.min(this.cursor, Math.max(0, this.shown.length - 1));
    this.list.setItems(this.shown);
    if (scrollTo >= 0) this.list.scrollToIndex(scrollTo);
    this.markCursor();
  }
}

// ── ACLs ──────────────────────────────────────────────────────────────────

/** The principals the ACL list mentions, with how many ACLs each has: the index to the
 *  table on the right, and a way to filter it by one login (K-44). */
export class AclsPanel extends SidePanel {
  private readonly list: VirtualList<{ principal: string; count: number }>;
  private readonly listEl: HTMLElement;
  private readonly note: HTMLElement;
  private readonly count: HTMLElement;
  private shown: { principal: string; count: number }[] = [];
  private cursor = 0;

  constructor(host: HTMLElement, model: KafkaModel) {
    super(host, model);
    host.innerHTML = `
      <div class="kf-note js-note"></div>
      <div class="kf-count js-count" aria-live="polite"></div>
      <div class="js-list kf-list"></div>`;
    this.note = host.querySelector(".js-note")!;
    this.count = host.querySelector(".js-count")!;
    this.listEl = host.querySelector(".js-list")!;
    this.list = new VirtualList<{ principal: string; count: number }>(this.listEl, ROW_H, (p, i) => this.row(p, i));
    this.list.onClick((p, i) => {
      this.cursor = i;
      this.pick(p.principal);
    });
    // The picked principal is shown in the list; nothing else in the panel changes with it.
    model.subscribeACLFilter(() => this.list.refresh());
    makeListbox(
      this.listEl,
      "ACL principals",
      () => this.shown.length,
      () => this.cursor,
      (to) => {
        if (to === "open") {
          const p = this.shown[this.cursor];
          if (p) this.pick(p.principal);
          return;
        }
        this.cursor = to;
        this.list.scrollToIndex(to);
        this.listEl.setAttribute("aria-activedescendant", `kf-acl-${to}`);
      },
    );
    host.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".js-retry")) void model.loadACLs();
    });
  }

  /** A principal picked here is that principal, exactly: "User:alice" is not also
   *  "User:alice-ci". The same one twice is a filter nobody meant to ask for, so it clears. */
  private pick(principal: string): void {
    const on = this.model.aclFilter.exact && this.model.aclFilter.principal === principal;
    this.model.setACLFilter({ principal: on ? "" : principal, exact: !on });
  }

  private row(p: { principal: string; count: number }, i: number): string {
    const sel = this.model.aclFilter.exact && this.model.aclFilter.principal === p.principal;
    return `<div class="kf-row${sel ? " sel" : ""}${i === this.cursor ? " cur" : ""}" id="kf-acl-${i}" role="option" aria-selected="${sel}" title="${esc(p.principal)}">
      <span class="kf-name">${esc(p.principal)}</span>
      <span class="kf-meta">${p.count}</span></div>`;
  }

  render(): void {
    const load = this.model.acls;
    this.note.innerHTML = stateNote(load, "This cluster has no ACLs.");
    this.note.hidden = this.note.innerHTML === "";
    const counts = new Map<string, number>();
    for (const a of load.data ?? []) counts.set(a.principal, (counts.get(a.principal) ?? 0) + 1);
    this.shown = [...counts.entries()].map(([principal, count]) => ({ principal, count })).sort((a, b) => a.principal.localeCompare(b.principal));
    this.count.textContent = load.data ? `${this.shown.length} principal${this.shown.length === 1 ? "" : "s"}` : "";
    this.cursor = Math.min(this.cursor, Math.max(0, this.shown.length - 1));
    this.list.setItems(this.shown);
    this.listEl.setAttribute("aria-activedescendant", `kf-acl-${this.cursor}`);
  }
}

// ── consumer groups ───────────────────────────────────────────────────────

const GROUP_STATE_CLASS: Record<string, string> = { Stable: "ok", Empty: "idle", Dead: "bad", PreparingRebalance: "warn", CompletingRebalance: "warn" };

export function groupState(state: string): string {
  return `<span class="kf-tag kf-tag-${GROUP_STATE_CLASS[state] ?? "idle"}">${esc(state || "unknown")}</span>`;
}

export class GroupsPanel extends SidePanel {
  private readonly list: VirtualList<GroupSummary>;
  private readonly listEl: HTMLElement;
  private readonly note: HTMLElement;
  private readonly count: HTMLElement;
  private filter = "";
  private shown: GroupSummary[] = [];
  private cursor = 0;
  private followed = "";

  constructor(host: HTMLElement, model: KafkaModel) {
    super(host, model);
    // The topics' arrangement: a filter, a note, a count, and a list that draws only the rows on
    // screen. A cluster with thousands of groups used to build every row on every keystroke.
    host.innerHTML = `
      <div class="kf-filter"><input class="t-input js-filter" type="search" placeholder="filter groups" spellcheck="false" autocomplete="off" aria-label="Filter consumer groups" /></div>
      <div class="kf-note js-note"></div>
      <div class="kf-count js-count" aria-live="polite"></div>
      <div class="js-list kf-list"></div>`;
    this.note = host.querySelector(".js-note")!;
    this.count = host.querySelector(".js-count")!;
    this.listEl = host.querySelector(".js-list")!;
    this.list = new VirtualList<GroupSummary>(this.listEl, ROW_H, (g, i) => this.row(g, i));
    this.list.onClick((g, i) => {
      this.cursor = i;
      model.select({ kind: "group", name: g.name });
    });
    makeListbox(
      this.listEl,
      "Consumer groups",
      () => this.shown.length,
      () => this.cursor,
      (to) => {
        if (to === "open") return this.open();
        this.cursor = to;
        this.list.scrollToIndex(to);
        markCursor(this.listEl, `kf-group-${to}`);
      },
    );
    const filter = host.querySelector<HTMLInputElement>(".js-filter")!;
    filter.addEventListener("input", () => {
      this.filter = filter.value.trim().toLowerCase();
      this.cursor = 0;
      this.followed = this.selectedName();
      this.render();
    });
    filterKeys(filter, this.listEl, () => this.open());
    host.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".js-retry")) void model.loadGroups();
    });
  }

  private selectedName(): string {
    const sel = this.model.selection;
    return sel.kind === "group" ? sel.name : "";
  }

  private open(): void {
    const g = this.shown[this.cursor];
    if (g) this.model.select({ kind: "group", name: g.name });
  }

  private row(g: GroupSummary, i: number): string {
    const sel = this.selectedName() === g.name;
    const lag = g.lag === null ? "" : `<span class="kf-meta${g.lag > 0 ? " kf-lag" : ""}" title="Messages the group has yet to read">lag ${esc(formatCount(g.lag))}</span>`;
    return `<div class="kf-row${sel ? " sel" : ""}${i === this.cursor ? " cur" : ""}" id="kf-group-${i}" role="option" aria-selected="${sel}" title="${esc(g.name)}">
      <span class="kf-name">${esc(g.name)}</span>${groupState(g.state)}${lag}</div>`;
  }

  render(): void {
    const load = this.model.groups;
    const none = load.state === "ready" && load.data!.length === 0;
    this.note.innerHTML = none ? "No consumer groups on this cluster." : stateNote(load, "");
    this.note.hidden = this.note.innerHTML === "";
    this.shown = (load.data ?? []).filter((g) => this.filter === "" || g.name.toLowerCase().includes(this.filter));
    this.count.textContent = load.data && load.data.length ? `${this.shown.length} of ${load.data.length} groups` : "";
    const name = this.selectedName();
    let scrollTo = -1;
    if (name !== this.followed) {
      this.followed = name;
      scrollTo = this.shown.findIndex((g) => g.name === name);
      if (scrollTo >= 0) this.cursor = scrollTo;
    }
    this.cursor = Math.min(this.cursor, Math.max(0, this.shown.length - 1));
    this.list.setItems(this.shown);
    if (scrollTo >= 0) this.list.scrollToIndex(scrollTo);
    markCursor(this.listEl, `kf-group-${this.cursor}`);
  }
}

// ── brokers ───────────────────────────────────────────────────────────────

export class BrokersPanel extends SidePanel {
  private cursor = 0;
  private followed = -1;

  constructor(host: HTMLElement, model: KafkaModel) {
    super(host, model);
    host.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest(".js-retry")) return void model.loadBrokers();
      const row = t.closest<HTMLElement>("[data-broker]");
      if (row) {
        this.cursor = Number(row.dataset.i);
        model.select({ kind: "broker", id: Number(row.dataset.broker) });
      }
    });
    const brokers = () => model.brokers.data?.brokers ?? [];
    makeListbox(
      host,
      "Brokers",
      () => brokers().length,
      () => this.cursor,
      (to) => {
        if (to === "open") return model.select({ kind: "broker", id: brokers()[this.cursor].id });
        this.cursor = to;
        markCursor(host, `kf-broker-${to}`);
      },
    );
  }

  render(): void {
    const load = this.model.brokers;
    const note = stateNote(load, "");
    const sel = this.model.selection;
    const brokers = load.data?.brokers ?? [];
    const id = sel.kind === "broker" ? sel.id : -1;
    if (id !== this.followed) {
      this.followed = id;
      const at = brokers.findIndex((b) => b.id === id);
      if (at >= 0) this.cursor = at;
    }
    this.cursor = Math.min(this.cursor, Math.max(0, brokers.length - 1));
    const rows = brokers
      .map((b, i) => {
        const on = sel.kind === "broker" && sel.id === b.id;
        return `<div class="kf-row${on ? " sel" : ""}" id="kf-broker-${i}" role="option" aria-selected="${on}" data-i="${i}" data-broker="${b.id}" title="${esc(`${b.host}:${b.port}`)}">
          <span class="kf-name">${b.id} · ${esc(b.host)}:${b.port}</span>
          ${b.controller ? `<span class="kf-tag kf-tag-ok" title="The controller">controller</span>` : ""}
          ${b.rack ? `<span class="kf-meta">${esc(b.rack)}</span>` : ""}</div>`;
      })
      .join("");
    this.host.innerHTML = note + rows;
    markCursor(this.host, `kf-broker-${this.cursor}`);
  }
}
