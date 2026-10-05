/** The messages of one topic: ask for some, see them listed, open one — or follow
 *  the topic live, with what is written from now on arriving at the top.
 *
 *  Reading never joins a consumer group, so looking at a topic commits nothing
 *  and cannot start a rebalance in somebody's application; the agent reads up
 *  to where each partition ended when the request began and stops. A filter is
 *  applied by the agent, so it can look through a great deal more than it sends.
 *
 *  A value is bytes until the reader decides what they are (format.ts). The
 *  agent cuts a very large one at 256 KiB and says so; "load full message" asks
 *  for the rest. A value that says it is an Ansible Vault or helm envelope can be
 *  opened here, with the password staying in this page (vault.ts).
 */
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import type {
  ConsumeFrom,
  ConsumeParams,
  ConsumeResult,
  DecodedValue,
  KafkaMessage,
  MessageBatch,
  TailParams,
  TopicDetail,
} from "../../kafka-agent/protocol.ts";
import { cmBase, cmDark } from "../cm-theme.ts";
import { cspNonce } from "../csp.ts";
import { ROW_H, esc } from "../code/ui.ts";
import { VirtualList } from "../code/vlist.ts";
import { MAX_LIVE_BYTES, listChars, trimToBudget } from "./buffer.ts";
import { openDialog } from "./dialog.ts";
import { exportMessagesDialog } from "./export.ts";
import { iconCopy, iconPlay, iconStop } from "./icons.ts";
import { type Decoding, decode, formatBytes, formatCount, formatTime, hasSchemaHeader, preview, schemaIdOf, shown, toLocalInput } from "./format.ts";
import { reindentJSON } from "./json-text.ts";
import { showMenu } from "../code/ui.ts";
import type { KafkaModel } from "./model.ts";
import { listKey } from "./side.ts";
import { VAULT_FORMATS, VAULT_TEXT, decryptValue, detectVault, type VaultFormat } from "./vault.ts";
import { sendMessageDialog } from "./write.ts";

const STOPPED: Record<ConsumeResult["stopped"], string> = {
  end: "reached the end of the topic",
  limit: "stopped at the limit",
  "scan-limit": "stopped after scanning 100,000 messages — narrow the filter or start closer to what you want",
  window: "the window the agent reads before sorting filled up — narrow the filter or ask for fewer",
  idle: "the cluster stopped delivering — what is left may be transaction markers, or a broker that stalled",
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** JSON as the viewer shows it: one field per line. A value that will not parse is shown as
 *  it came — the schema said it was JSON, and pretending otherwise here would hide it. */
function prettyJSON(text: string): string {
  return reindentJSON(text) ?? text;
}

/** The least the list and the message panel keep when the divider is dragged. */
const MIN_LIST = 90;
const MIN_DETAIL = 140;
const LIST_HEIGHT_KEY = "enc-kafka-list-height";

function loadListHeight(): number | null {
  try {
    const n = Number(localStorage.getItem(LIST_HEIGHT_KEY));
    return Number.isFinite(n) && n >= MIN_LIST ? n : null;
  } catch {
    return null;
  }
}

function saveListHeight(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(LIST_HEIGHT_KEY);
    else localStorage.setItem(LIST_HEIGHT_KEY, String(px));
  } catch {
    /* private mode: a preference, not state anything depends on */
  }
}

export class MessagesPanel {
  readonly el: HTMLElement;

  private readonly list: VirtualList<KafkaMessage>;
  private readonly status: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly go: HTMLButtonElement;
  private readonly modeRead: HTMLButtonElement;
  private readonly modeLive: HTMLButtonElement;
  /** What the one start button does: read what the topic holds, or follow it. */
  private mode: "read" | "live" = "read";
  private readonly pauseBtn: HTMLButtonElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly exportBtn: HTMLButtonElement;
  private unsubscribe: (() => void) | null = null;
  /** The topic's partitions, once known: what "send" offers to pick from. */
  private partitionIds: number[] = [];
  private readonly fromSel: HTMLSelectElement;
  private readonly partSel: HTMLSelectElement;
  private readonly offsetIn: HTMLInputElement;
  private readonly timeIn: HTMLInputElement;
  private readonly limitSel: HTMLSelectElement;
  private readonly filterIn: HTMLInputElement;
  private readonly regexBtn: HTMLButtonElement;
  private readonly caseBtn: HTMLButtonElement;

  private messages: KafkaMessage[] = [];
  private selected: KafkaMessage | null = null;
  private decoding: Decoding = "auto";
  /** The plaintext of the selected message's value, once somebody opened it with a
   *  password. It belongs to that one message: another selection drops it. */
  private plain: { text: string; format: VaultFormat } | null = null;
  /** A value that carries a schema, and what came of reading it (K-42). One message's:
   *  `for` says which, so a late answer is not painted over another message. */
  private schema: { for: KafkaMessage; state: "reading" | "read" | "failed"; json?: string; info?: DecodedValue; error?: string } | null = null;
  /** The reader picked another way to read the selected message than its schema. Belongs to
   *  that message, like the schema itself. */
  private schemaOff = false;
  /** What a schema's value was read as, by message: the table says it without asking again. */
  private readonly decoded = new WeakMap<KafkaMessage, DecodedValue>();
  /** The editor's box, hidden while no message is selected. */
  private editorHost: HTMLElement | null = null;
  /** The messages whose schema reading has already failed into the output log. */
  private readonly decodeLogged = new WeakSet<KafkaMessage>();
  private running: { id: number; live: boolean } | null = null;
  /** Live view: paused (arrivals are held, not shown), what is held, how many the agent dropped. */
  private paused = false;
  private held: KafkaMessage[] = [];
  private skipped = 0;
  /** How many messages the memory budget has taken off the shown list since it
   *  was last filled. A count cap alone never had to say this, because what it
   *  dropped arrived after what it kept; a byte budget can drop a message the
   *  reader asked for, so it is counted and reported. */
  private trimmed = 0;
  private started = false;
  private detailKnown = false;

  private view: EditorView | null = null;
  private readonly themeSlot = new Compartment();
  private readonly langSlot = new Compartment();
  /** A read has been started in this panel: the button is "read again" from then on. */
  private hasRead = false;
  private readonly splitEl: HTMLElement;
  private readonly tableEl: HTMLElement;

  constructor(
    private readonly model: KafkaModel,
    private readonly topic: string,
    private dark: boolean,
  ) {
    this.el = document.createElement("div");
    this.el.className = "kf-pane kf-messages";
    this.el.dataset.pane = "messages";
    this.el.innerHTML = `
      <div class="kf-bar kf-msgbar">
        <div class="kf-msgread">
          <span class="kf-seg" role="group" aria-label="Mode">
            <button class="t-btn js-mode-read is-active" type="button" aria-pressed="true" title="Read what the topic holds now">read</button>
            <button class="t-btn js-mode-live" type="button" aria-pressed="false" title="Follow the topic: what is written from now on appears at the top, as it happens">live</button>
          </span>
          <select class="t-input js-from" aria-label="Where to start">
            <option value="end">newest</option><option value="start">oldest</option>
            <option value="offset">from offset</option><option value="time">from time</option>
          </select>
          <select class="t-input js-part" aria-label="Partition"><option value="">all partitions</option></select>
          <input class="t-input js-offset kf-narrow" type="number" min="0" placeholder="offset" hidden aria-label="Offset" />
          <input class="t-input js-time" type="datetime-local" step="1" hidden aria-label="Time" />
          <select class="t-input js-limit" aria-label="How many messages">
            <option>50</option><option selected>100</option><option>500</option><option>1000</option>
          </select>
          <input class="t-input js-filter kf-grow" type="search" placeholder="filter key or value" spellcheck="false" autocomplete="off" aria-label="Filter messages" />
          <span class="kf-seg" role="group" aria-label="Filter options">
            <button class="t-btn js-regex" type="button" title="Treat the filter as a regular expression">.*</button>
            <button class="t-btn js-case" type="button" title="Match case">Aa</button>
          </span>
          <button class="t-btn t-btn-primary js-go" type="button">${iconPlay} start</button>
          <button class="t-btn js-pause" type="button" title="Hold new messages back while you read; they are kept" hidden>pause</button>
        </div>
        <div class="kf-msgwrite">
          <button class="t-btn js-export" type="button" title="Save these messages as a JSON Lines file" hidden>save .jsonl</button>
          <button class="t-btn js-send" type="button" title="Send a message to this topic" hidden>send…</button>
        </div>
      </div>
      <div class="kf-msgstatus js-status"></div>
      <div class="kf-split">
        <div class="kf-msgtable">
          <div class="kf-mhead"><span>part</span><span>offset</span><span>time</span><span>key</span><span>value</span></div>
          <div class="kf-mlist js-list"></div>
        </div>
        <div class="kf-hsplit js-hsplit" role="separator" aria-orientation="horizontal" aria-label="Resize the message panel" tabindex="0" title="Drag to resize · double-click to put it back"></div>
        <div class="kf-msgdetail js-detail"><div class="kf-note">Select a message to read it.</div></div>
      </div>`;
    const $ = <T extends HTMLElement>(sel: string): T => this.el.querySelector<T>(sel)!;
    this.status = $(".js-status");
    this.detail = $(".js-detail");
    this.splitEl = $(".kf-split");
    this.tableEl = $(".kf-msgtable");
    this.setupSplitter($(".js-hsplit"));
    this.go = $(".js-go");
    this.modeRead = $(".js-mode-read");
    this.modeLive = $(".js-mode-live");
    this.pauseBtn = $(".js-pause");
    this.sendBtn = $(".js-send");
    this.exportBtn = $(".js-export");
    this.fromSel = $(".js-from");
    this.partSel = $(".js-part");
    this.offsetIn = $(".js-offset");
    this.timeIn = $(".js-time");
    this.limitSel = $(".js-limit");
    this.filterIn = $(".js-filter");
    this.regexBtn = $(".js-regex");
    this.caseBtn = $(".js-case");
    this.timeIn.value = toLocalInput(Date.now() - 3600_000);

    const listEl = $(".js-list");
    this.list = new VirtualList<KafkaMessage>(listEl, ROW_H, (m, i) => this.row(m, i));
    this.list.onClick((m) => this.select(m));
    // The arrow keys read through the messages: unlike the side lists, moving is
    // opening here — a message is already in the page, and looking at the next one
    // costs nothing.
    listEl.tabIndex = 0;
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", "Messages");
    listEl.classList.add("kf-listbox");
    listEl.addEventListener("keydown", (ev) => {
      if (ev.target !== listEl) return;
      const at = this.selected ? this.messages.indexOf(this.selected) : -1;
      const to = listKey(ev, at, this.messages.length);
      if (to === null || to === "open") return;
      ev.preventDefault();
      this.select(this.messages[to]);
      this.list.scrollToIndex(to);
      listEl.setAttribute("aria-activedescendant", `kf-msg-${to}`);
    });

    this.fromSel.addEventListener("change", () => this.syncFrom());
    this.regexBtn.addEventListener("click", () => this.regexBtn.classList.toggle("is-active"));
    this.caseBtn.addEventListener("click", () => this.caseBtn.classList.toggle("is-active"));
    this.go.addEventListener("click", () => (this.running ? this.halt() : this.start()));
    this.modeRead.addEventListener("click", () => this.setMode("read"));
    this.modeLive.addEventListener("click", () => this.setMode("live"));
    this.pauseBtn.addEventListener("click", () => this.togglePause());
    // Offered only where the cluster may be changed, and kept true when that changes (a reload
    // of the agent's configuration can flip it while this is open).
    const syncWrite = (): void => {
      this.sendBtn.hidden = this.model.readOnly;
    };
    syncWrite();
    this.unsubscribe = this.model.subscribe(syncWrite);
    this.sendBtn.addEventListener("click", () =>
      sendMessageDialog(this.model, { topic: this.topic, partitions: this.partitionIds, dark: this.dark, onShow: (r) => this.showAt(r.partition, r.offset) }),
    );
    // Saving is a read: it is offered whether the cluster may be changed or not.
    this.exportBtn.addEventListener("click", () =>
      exportMessagesDialog(this.model, { topic: this.topic, messages: this.messages, selected: this.selected }),
    );
    this.filterIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.start();
    });
    this.syncFrom();
    this.paintGo(false);
  }

  /** Start in the mode that is chosen. Both restart what was running. */
  private start(): void {
    if (this.mode === "live") this.startLive();
    else this.run();
  }

  /** read | live. What only a read has a use for — where to start, how many — is put away
   *  while the mode is live, and the one start button follows. */
  private setMode(mode: "read" | "live"): void {
    if (mode === this.mode) return;
    if (this.running) this.halt();
    this.mode = mode;
    for (const [btn, on] of [[this.modeRead, mode === "read"], [this.modeLive, mode === "live"]] as const) {
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
    for (const el of [this.fromSel, this.offsetIn, this.timeIn, this.limitSel]) el.disabled = mode === "live";
    this.pauseBtn.hidden = true;
    this.paintGo(false);
  }

  /** The start button, and stop when something is running. A read that has been made is not
   *  made a second time by "start": the button says it reads again (I-12). */
  private paintGo(running: boolean): void {
    const again = !running && this.mode === "read" && this.hasRead;
    this.go.innerHTML = running ? `${iconStop} stop` : `${iconPlay} ${again ? "read again" : "start"}`;
    this.go.title = running ? "Stop" : this.mode === "live" ? "Follow the topic from now on (Enter in the filter)" : "Read messages (Enter in the filter)";
  }

  // ── the form ────────────────────────────────────────────────────────────

  /** Only what the chosen start needs is on show. */
  private syncFrom(): void {
    const from = this.fromSel.value as ConsumeFrom;
    this.offsetIn.hidden = from !== "offset";
    this.timeIn.hidden = from !== "time";
    // An offset means nothing without a partition to be an offset in.
    if (from === "offset" && this.partSel.value === "" && this.partSel.options.length > 1) this.partSel.selectedIndex = 1;
  }

  /** Called whenever the tab is shown, with the topic's partitions once known. */
  show(detail: TopicDetail | null): void {
    this.el.hidden = false;
    if (detail && !this.detailKnown) {
      this.detailKnown = true;
      this.partitionIds = detail.partitions.map((p) => p.id);
      const keep = this.partSel.value;
      this.partSel.innerHTML =
        `<option value="">all partitions</option>` +
        detail.partitions.map((p) => `<option value="${p.id}">partition ${p.id} (${esc(formatCount(p.end - p.start))})</option>`).join("");
      this.partSel.value = keep;
      this.syncFrom();
    }
    if (!this.started) {
      this.started = true;
      this.mountEditor();
      this.run();
    }
  }

  hide(): void {
    this.el.hidden = true;
    this.suspend();
  }

  /** The page moved away from these messages — another tab, another topic: a live
   *  view stops, since nobody is looking at what it would go on collecting. A
   *  finite read is left to finish. */
  suspend(): void {
    if (this.running?.live) this.halt();
  }

  setTheme(dark: boolean): void {
    this.dark = dark;
    this.view?.dispatch({ effects: this.themeSlot.reconfigure(cmDark(dark)) });
  }

  /** Read from one offset of one partition — where a message just sent landed. */
  showAt(partition: number, offset: number): void {
    if (![...this.partSel.options].some((o) => o.value === String(partition))) {
      this.partSel.add(new Option(`partition ${partition}`, String(partition)));
    }
    this.fromSel.value = "offset";
    this.partSel.value = String(partition);
    this.offsetIn.value = String(offset);
    this.syncFrom();
    this.run();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.halt();
    this.view?.destroy();
    this.view = null;
  }

  // ── reading ─────────────────────────────────────────────────────────────

  private params(): ConsumeParams | string {
    const from = this.fromSel.value as ConsumeFrom;
    const p: ConsumeParams = {
      cluster: this.model.cluster!,
      topic: this.topic,
      from,
      limit: Number(this.limitSel.value),
    };
    if (this.partSel.value !== "") p.partitions = [Number(this.partSel.value)];
    if (from === "offset") {
      if (this.partSel.value === "") return "Starting from an offset needs a partition — pick one.";
      const n = Number(this.offsetIn.value);
      if (this.offsetIn.value === "" || !Number.isInteger(n) || n < 0) return "Enter the offset to start from.";
      p.offset = n;
    }
    if (from === "time") {
      const t = new Date(this.timeIn.value).getTime();
      if (!Number.isFinite(t)) return "Enter the time to start from.";
      p.timestamp = t;
    }
    Object.assign(p, this.filterParams());
    return p;
  }

  /** The filter, as both a consume and a tail take it. */
  private filterParams(): Pick<ConsumeParams, "filter" | "regex" | "caseSensitive"> {
    const filter = this.filterIn.value;
    if (filter === "") return {};
    return {
      filter,
      regex: this.regexBtn.classList.contains("is-active"),
      caseSensitive: this.caseBtn.classList.contains("is-active"),
    };
  }

  private run(): void {
    const params = this.params();
    if (typeof params === "string") return this.say(params, true);
    this.halt();
    this.messages = [];
    this.selected = null;
    this.plain = null;
    this.schema = null;
    this.trimmed = 0;
    this.list.setItems([]);
    this.syncExport();
    this.showDetail(null);
    this.say("reading…", false);
    this.hasRead = true;
    this.setRunning(true);

    const call = this.model.client.opTracked("messages.consume", params, (batch) => {
      this.messages.push(...batch.messages);
      this.trimmed += trimToBudget(this.messages, true);
      this.list.setItems(this.messages);
      this.syncExport();
      this.say(`reading… ${formatCount(this.messages.length)}${this.weight()}`, false);
    });
    const mine = { id: call.id, live: false };
    this.running = mine;
    call.promise.then(
      (r) => {
        if (this.running !== mine) return;
        this.setRunning(false);
        const n = formatCount(r.matched);
        // Two budgets, and both are said out loud: the agent drops matches to
        // stay inside the window it sorts, and this tab drops messages to stay
        // inside its own. A page that quietly showed 94 of 1,000 would be lying
        // by omission.
        const dropped = r.skipped
          ? ` · ${formatCount(r.skipped)} dropped to stay inside the agent's window`
          : "";
        const kept = this.trimmed
          ? ` · only ${formatCount(this.messages.length)} kept — this tab holds at most ${formatBytes(MAX_LIVE_BYTES * 2)} of messages`
          : "";
        const outcome = `${n} message${r.matched === 1 ? "" : "s"} · scanned ${formatCount(r.scanned)} · ${STOPPED[r.stopped]}${dropped}${kept}`;
        this.say(outcome, false);
        this.model.log("messages.consume", `${this.topic}: ${outcome}`);
      },
      (e: Error & { code?: string }) => {
        if (this.running !== mine) return; // superseded: a newer run owns the status
        this.setRunning(false);
        this.say(e.code === "ECANCELED" ? `stopped · ${formatCount(this.messages.length)} messages` : message(e), e.code !== "ECANCELED");
        if (e.code !== "ECANCELED") this.model.logError("messages.consume", e);
      },
    );
  }

  private halt(): void {
    if (!this.running) return;
    const { id, live } = this.running;
    this.running = null;
    this.setRunning(false);
    if (live) {
      this.setLive(false);
      this.say(`stopped · ${formatCount(this.messages.length + this.held.length)} messages followed`, false);
      this.held = [];
    }
    this.model.client.cancel(id);
  }

  private setRunning(on: boolean): void {
    this.paintGo(on);
  }

  /** Saving is offered only when there is something to save. Called wherever the list
   *  changes: a read filling up, a live view taking arrivals, a new read clearing it. */
  private syncExport(): void {
    this.exportBtn.hidden = this.messages.length === 0;
  }

  // ── live ────────────────────────────────────────────────────────────────

  /** Following: pause is offered, and the start button is stop. */
  private setLive(on: boolean): void {
    this.pauseBtn.hidden = !on;
    this.pauseBtn.textContent = "pause";
    this.paintGo(on);
  }

  private startLive(): void {
    const p: TailParams = { cluster: this.model.cluster!, topic: this.topic, ...this.filterParams() };
    if (this.partSel.value !== "") p.partitions = [Number(this.partSel.value)];
    this.halt();
    this.messages = [];
    this.selected = null;
    this.plain = null;
    this.schema = null;
    this.held = [];
    this.skipped = 0;
    this.trimmed = 0;
    this.paused = false;
    this.list.setItems([]);
    this.syncExport();
    this.showDetail(null);
    this.setLive(true);
    this.say("live · waiting for new messages…", false);

    const call = this.model.client.opTracked("messages.tail", p, (batch) => this.onLive(batch));
    const mine = { id: call.id, live: true };
    this.running = mine;
    call.promise.then(
      () => {
        if (this.running !== mine) return;
        this.running = null;
        this.setLive(false);
        this.say("the cluster closed the connection — live view ended", true);
        this.model.logError("messages.tail", new Error(`${this.topic}: the cluster closed the connection — live view ended`));
      },
      (e: Error & { code?: string }) => {
        if (this.running !== mine) return; // stopped on purpose: halt() has said so
        this.running = null;
        this.setLive(false);
        this.say(message(e), true);
        this.model.logError("messages.tail", e);
      },
    );
  }

  private onLive(batch: MessageBatch): void {
    // A batch that was already on its way when the view was stopped: the stop has
    // said its piece, and this must not overwrite it.
    if (!this.running?.live) return;
    this.skipped += batch.skipped;
    if (this.paused) {
      this.held.push(...batch.messages);
      // Held messages are kept under the same budget as the ones on screen: a
      // pause on a busy topic used to be the way to hold a gigabyte.
      this.trimmed += trimToBudget(this.held, true);
      this.pauseBtn.textContent = `resume (${formatCount(this.held.length)} new)`;
      return;
    }
    this.addLive(batch.messages);
  }

  /** What the two lists weigh, for the status line. The budget above is what
   *  decides how much a live view keeps, so the number it is spent against is
   *  worth showing. */
  private weight(): string {
    const bytes = (listChars(this.messages) + listChars(this.held)) * 2;
    return bytes ? ` · ${formatBytes(bytes)} held` : "";
  }

  /** New messages go on top, newest first, and the far end is trimmed to the window. */
  private addLive(incoming: KafkaMessage[]): void {
    if (incoming.length) {
      this.messages = incoming.slice().reverse().concat(this.messages);
      this.trimmed += trimToBudget(this.messages, false);
      this.list.setItems(this.messages);
      this.syncExport();
    }
    // Both counts mean the same thing to a reader — what the topic wrote and
    // this page did not keep — so they are said once, together.
    const dropped = this.skipped + this.trimmed;
    const faster = dropped
      ? ` · ${formatCount(dropped)} dropped — the topic is faster than this page can show`
      : "";
    this.say(
      this.messages.length
        ? `live · ${formatCount(this.messages.length)} shown${faster}${this.weight()}`
        : "live · waiting for new messages…",
      false,
    );
  }

  private togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) {
      this.pauseBtn.textContent = "resume";
      this.pauseBtn.classList.add("is-active");
      this.say(`live · paused · ${formatCount(this.messages.length)} shown${this.weight()}`, false);
      return;
    }
    this.pauseBtn.textContent = "pause";
    this.pauseBtn.classList.remove("is-active");
    const held = this.held;
    this.held = [];
    this.addLive(held);
  }

  private say(text: string, bad: boolean): void {
    this.status.textContent = text;
    this.status.classList.toggle("kf-note-bad", bad);
  }

  // ── the list ────────────────────────────────────────────────────────────

  private row(m: KafkaMessage, i: number): string {
    const sel = this.selected === m;
    return `<div class="kf-mrow${sel ? " sel" : ""}" id="kf-msg-${i}" role="option" aria-selected="${sel}"><span>${m.partition}</span><span>${esc(formatCount(m.offset))}</span>
      <span title="${esc(new Date(m.timestamp).toISOString())}">${esc(formatTime(m.timestamp))}</span>
      <span class="kf-mkey">${m.key === null ? `<span class="kf-muted">null</span>` : esc(preview(m.key, 60))}</span>
      <span class="kf-mval">${this.valueCell(m)}</span></div>`;
  }

  /** The VALUE column. A value that carries a schema is said as what it is — `AVRO · id 2`, and
   *  what it held once it has been read — and not as the hex of its bytes, which no one can read. */
  private valueCell(m: KafkaMessage): string {
    if (m.value === null) return `<span class="kf-muted">null (tombstone)</span>`;
    const id = schemaIdOf(m.value);
    if (id === null || !this.registryAnswers()) return esc(preview(m.value));
    const read = this.decoded.get(m);
    if (!read) return `<span class="kf-muted">schema · id ${id}</span>`;
    const head = read.json.replace(/\s+/g, " ").trim();
    return `<span class="kf-muted">${esc(read.schemaType)} · id ${read.schemaId} ·</span> ${esc(head.length > 160 ? `${head.slice(0, 160)}…` : head)}`;
  }

  private select(m: KafkaMessage): void {
    // What was opened — with a password, or with a schema — belongs to the message it was
    // opened for.
    if (m !== this.selected) {
      this.plain = null;
      this.schema = null;
      this.schemaOff = false;
    }
    this.selected = m;
    this.list.refresh();
    this.showDetail(m);
  }

  // ── one message ─────────────────────────────────────────────────────────

  private mountEditor(): void {
    // Made when the tab is first shown, not in the constructor: a CodeMirror
    // view created inside an element that is not on the page has no size to
    // measure, and paints nothing until it is asked to again.
    const host = document.createElement("div");
    host.className = "kf-editor";
    this.detail.replaceChildren();
    const meta = document.createElement("div");
    meta.className = "kf-meta-block";
    this.detail.append(meta, host);
    this.editorHost = host;
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          // Without the nonce the policy refuses CodeMirror's stylesheet, and the
          // editor draws as unstyled blocks.
          EditorView.cspNonce.of(cspNonce),
          cmBase,
          this.themeSlot.of(cmDark(this.dark)),
          this.langSlot.of([]),
          lineNumbers(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
    });
    this.showDetail(this.selected);
  }

  private setValue(text: string, asJson: boolean): void {
    if (!this.view) return;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      effects: this.langSlot.reconfigure(asJson ? json() : []),
    });
  }

  /** The list takes the whole height until a message is chosen; then the message panel opens
   *  under it, with a divider to drag. The height of the list is remembered, as the side
   *  panel's width is (X-08). */
  private setupSplitter(bar: HTMLElement): void {
    const apply = (px: number | null): void => {
      this.tableEl.style.flexBasis = px === null ? "" : `${px}px`;
    };
    apply(loadListHeight());
    const current = (): number => this.tableEl.getBoundingClientRect().height;
    const clamp = (px: number): number => Math.round(Math.max(MIN_LIST, Math.min(px, this.splitEl.getBoundingClientRect().height - MIN_DETAIL)));
    bar.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault(); // or the drag selects the text beside it
      bar.setPointerCapture(ev.pointerId);
      bar.classList.add("dragging");
      const startY = ev.clientY;
      const start = current();
      let height = start;
      const onMove = (m: PointerEvent): void => {
        height = clamp(start + m.clientY - startY);
        apply(height);
      };
      const onUp = (): void => {
        bar.classList.remove("dragging");
        bar.removeEventListener("pointermove", onMove);
        bar.removeEventListener("pointerup", onUp);
        saveListHeight(height);
      };
      bar.addEventListener("pointermove", onMove);
      bar.addEventListener("pointerup", onUp);
    });
    bar.addEventListener("dblclick", () => {
      apply(null);
      saveListHeight(null);
    });
    bar.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
      ev.preventDefault();
      const height = clamp(current() + (ev.key === "ArrowDown" ? 24 : -24));
      apply(height);
      saveListHeight(height);
    });
  }

  private showDetail(m: KafkaMessage | null): void {
    // Opened before it is measured: an editor in a box that is not shown has no size.
    this.splitEl.classList.toggle("has-detail", m !== null);
    const meta = this.detail.querySelector<HTMLElement>(".kf-meta-block");
    if (!meta || !this.view) return;
    // Nothing selected: a sentence, and no editor — an empty one with a line number in it
    // reads as a message that is blank.
    if (this.editorHost) this.editorHost.hidden = m === null;
    if (!m) {
      meta.innerHTML = `<div class="kf-note">Select a message to read it.</div>`;
      this.setValue("", false);
      return;
    }
    this.view.requestMeasure();
    const headers = m.headers.length
      ? `<table class="kf-table kf-headers"><tbody>${m.headers.map((h) => `<tr><td class="kf-mono kf-muted">${esc(h.key)}</td><td class="kf-mono kf-wrap">${h.value === null ? `<span class="kf-muted">null</span>` : esc(shown(h.value))}</td></tr>`).join("")}</tbody></table>`
      : "";
    // What the value can be opened as: its own label says so, or — with a truncated
    // value — nothing, because half an envelope cannot be authenticated.
    const readable = m.value === null || m.truncated ? null : (detectVault(decode(m.value, "text")?.text ?? null) ?? "");
    const open = this.plain
      ? `<span class="kf-tag kf-tag-ok" title="Opened in this page; the password was not sent anywhere">${esc(VAULT_TEXT[this.plain.format])} · open</span>
         <button class="t-btn js-lock" type="button" title="Show the value as it is stored">close it</button>`
      : readable === null
        ? ""
        : readable === ""
          ? // Not an envelope by its own label: a bare base64 string could be one, but a button
            // that asks for a password on every ordinary message is noise. It stays reachable.
            `<button class="t-btn js-more" type="button" aria-haspopup="menu" aria-label="More actions" title="More actions">…</button>`
          : `<button class="t-btn js-open" type="button" title="Open the value here — the password stays in this page">decrypt ${esc(VAULT_TEXT[readable])}…</button>`;
    // And what it is, when it carries a schema: which schema, from where, and what it held.
    const mine = this.schema?.for === m ? this.schema : null;
    // The schema's reading is what is shown, unless the reader picked another one.
    const schemaActive = mine?.state === "read" && mine.json !== undefined && !this.schemaOff;
    const schema = !mine
      ? ""
      : mine.state === "reading"
        ? `<span class="kf-tag" title="Reading the schema the value carries from the registry">schema…</span>`
        : mine.state === "read" && mine.info
          ? `<span class="kf-tag kf-tag-ok" title="Read with the schema the value carries: what is shown is what the message holds">${esc(
              [mine.info.schemaType, mine.info.subject ? `${mine.info.subject}${mine.info.version === null ? "" : ` v${mine.info.version}`}` : `id ${mine.info.schemaId}`, mine.info.message ?? ""]
                .filter(Boolean)
                .join(" · "),
            )}</span>`
          : `<span class="kf-tag kf-tag-bad" title="The value carries a schema, and reading it did not work">schema failed</span>`;
    meta.innerHTML = `
      <div class="kf-bar">
        <span class="kf-mono">partition ${m.partition} · offset ${esc(formatCount(m.offset))}</span>
        <span class="kf-muted" title="${esc(new Date(m.timestamp).toISOString())}">${esc(formatTime(m.timestamp))}</span>
        <span class="kf-grow"></span>
        ${schema}
        <select class="t-input js-decode" aria-label="Show the value as" title="Show the value as">
          ${schemaActive || (mine?.state === "read" && mine.json !== undefined) ? `<option value="schema"${schemaActive ? " selected" : ""}>schema</option>` : ""}
          ${(["auto", "text", "json", "hex", "base64"] as Decoding[]).map((d) => `<option value="${d}"${!schemaActive && d === this.decoding ? " selected" : ""}>${d}</option>`).join("")}
        </select>
        ${open}
        <button class="t-btn js-copy" type="button" title="Copy the value">${iconCopy}</button>
      </div>
      <div class="kf-kv"><span class="kf-fact-l">key</span><span class="kf-mono kf-wrap">${m.key === null ? `<span class="kf-muted">null</span>` : esc(shown(m.key))}</span>
        <span class="kf-fact-l">size</span><span>${esc(formatBytes(m.valueSize))} value · ${esc(formatBytes(m.keySize))} key</span></div>
      ${headers}
      ${mine?.state === "failed" ? `<div class="kf-note kf-note-warn">The value carries a schema, and it could not be read: ${esc(mine.error ?? "")} What is shown is the value itself.</div>` : ""}
      ${m.truncated ? `<div class="kf-note kf-note-warn">Only the first ${esc(formatBytes(m.value ? Math.floor((m.value.length * 3) / 4) : 0))} of the ${esc(formatBytes(m.valueSize))} value is shown. <button class="t-btn js-full" type="button">load full message</button></div>` : ""}`;

    const paint = (): void => {
      if (this.plain) return this.setValue(this.plain.text, false);
      if (this.schema?.for === m && this.schema.state === "read" && this.schema.json !== undefined && !this.schemaOff) {
        return this.setValue(prettyJSON(this.schema.json), true);
      }
      const d = decode(m.value, this.decoding);
      this.setValue(d === null ? "" : d.text, d?.as === "json");
    };
    paint();

    // A value that carries a schema is read with it, without being asked (K-42): the
    // registry's schema is what those bytes mean, and showing them as text or hex is not
    // showing the message. What comes back replaces the bytes until it is closed again.
    //
    // Only where the cluster has a registry that answers: a zero first byte is also
    // what plain binary values start with, and on a cluster with no registry the
    // reading could only fail — a red tag, a request and a log line on every click,
    // about a schema the value never had.
    if (hasSchemaHeader(m.value) && !m.truncated && m.value !== null && this.registryAnswers()) {
      if (this.schema?.for !== m) {
        this.schema = { for: m, state: "reading" };
        void this.readSchema(m);
      }
    } else if (this.schema?.for !== m) {
      this.schema = null;
    }
    meta.querySelector<HTMLSelectElement>(".js-decode")!.addEventListener("change", (e) => {
      const chosen = (e.target as HTMLSelectElement).value;
      if (chosen === "schema") {
        this.schemaOff = false;
      } else {
        this.decoding = chosen as Decoding;
        this.schemaOff = true;
      }
      paint();
    });
    meta.querySelector(".js-copy")!.addEventListener("click", () => {
      void navigator.clipboard?.writeText(this.view?.state.doc.toString() ?? "").catch(() => undefined);
    });
    meta.querySelector(".js-full")?.addEventListener("click", () => void this.loadFull(m));
    meta.querySelector(".js-open")?.addEventListener("click", () => this.openValue(m, readable === null || readable === "" ? null : readable));
    meta.querySelector(".js-lock")?.addEventListener("click", () => {
      this.plain = null;
      this.showDetail(m);
    });
    meta.querySelector<HTMLElement>(".js-more")?.addEventListener("click", (ev) => {
      const at = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      showMenu(at.left, at.bottom + 2, [{ label: "decrypt…", run: () => this.openValue(m, null) }]);
    });
  }

  /** Read one message's value with the schema it carries. The answer belongs to the message
   *  it was asked about: a late one is dropped. */
  /** The open cluster has a Schema Registry, and it answered the last time it was asked. */
  private registryAnswers(): boolean {
    const cluster = this.model.cluster;
    return cluster !== null && this.model.schemas.get(cluster)?.state === "connected";
  }

  private async readSchema(m: KafkaMessage): Promise<void> {
    let read: DecodedValue | null = null;
    let failure = "";
    try {
      read = await this.model.decodeValue(m.value!);
    } catch (e) {
      failure = message(e);
      // Once per message: going back to a message that could not be read reads it
      // again, and the log is not the place to count the clicks.
      if (!this.decodeLogged.has(m)) {
        this.decodeLogged.add(m);
        this.model.logError("messages.decode", e);
      }
    }
    if (this.schema?.for !== m) return; // another message was selected while this was out
    this.schema = read ? { for: m, state: "read", json: read.json, info: read } : { for: m, state: "failed", error: failure };
    if (read) {
      this.decoded.set(m, read);
      this.list.refresh();
    }
    if (this.selected === m) this.showDetail(m);
  }

  /** Ask for a password and open the value with it.
   *
   *  The decryption runs on WebCrypto right here: the password is not sent to the
   *  agent, to this app's server, or to the cluster — none of them is even told that
   *  the value was read. The plaintext replaces the ciphertext on screen until it is
   *  closed again, and never enters the list, the log or the clipboard by itself. */
  private openValue(m: KafkaMessage, guessed: VaultFormat | null): void {
    const ciphertext = decode(m.value, "text")?.text ?? "";
    const d = openDialog(`
      <p class="modal-title">Open the value of partition ${m.partition}, offset ${esc(formatCount(m.offset))}</p>
      <p class="modal-hint">The password is used in this page only: it is not sent to the agent, to the server or to the cluster.</p>
      <label for="kf-open-format">Format</label>
      <select id="kf-open-format" class="t-input js-format">${VAULT_FORMATS.map((f) => `<option value="${f}"${f === guessed ? " selected" : ""}>${VAULT_TEXT[f]}</option>`).join("")}</select>
      <label for="kf-open-pw">Password</label>
      <div class="modal-field">
        <input id="kf-open-pw" class="t-input js-pw" type="password" autocomplete="current-password" spellcheck="false" />
        <button type="button" class="t-icon js-see" title="Show the password" aria-label="Show the password">👁</button>
      </div>
      <p class="modal-hint is-error js-err" hidden></p>
      <div class="modal-row">
        <button type="button" class="t-btn cancel">cancel</button>
        <button type="submit" class="t-btn t-btn-primary js-ok">decrypt</button>
      </div>`);
    const $ = <T extends HTMLElement>(sel: string): T => d.form.querySelector<T>(sel)!;
    const pw = $<HTMLInputElement>(".js-pw");
    const err = $<HTMLElement>(".js-err");
    const ok = $<HTMLButtonElement>(".js-ok");
    $(".js-see").addEventListener("click", () => {
      pw.type = pw.type === "password" ? "text" : "password";
    });
    d.form.querySelector(".cancel")!.addEventListener("click", d.close);
    d.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const format = $<HTMLSelectElement>(".js-format").value as VaultFormat;
      if (pw.value === "") {
        err.textContent = "Type the password";
        err.hidden = false;
        return;
      }
      ok.disabled = true;
      err.hidden = true;
      try {
        const text = await decryptValue(format, ciphertext, pw.value);
        this.plain = { text, format };
        d.close();
        this.showDetail(m);
      } catch (ex) {
        err.textContent = message(ex);
        err.hidden = false;
      } finally {
        ok.disabled = false;
      }
    });
    pw.focus();
  }

  private async loadFull(m: KafkaMessage): Promise<void> {
    try {
      const full = await this.model.client.op("messages.get", {
        cluster: this.model.cluster!,
        topic: this.topic,
        partition: m.partition,
        offset: m.offset,
      });
      // Deliberately not trimmed to the budget afterwards: this is one message
      // the reader asked for in so many words, and dropping older ones to pay
      // for it would answer a request for one message by taking away others.
      // The status line says what the list weighs, so the trade is visible.
      const i = this.messages.indexOf(m);
      if (i >= 0) this.messages[i] = full;
      if (this.selected === m) {
        this.selected = full;
        // The rest of the value arrived: an envelope opened from a prefix is not the
        // envelope that is here now.
        this.plain = null;
        // The rest of the value arrived: what was read from a prefix was read from a
        // prefix, and the whole of it is read again.
        this.schema = null;
        this.schemaOff = false;
        this.list.refresh();
        this.showDetail(full);
      }
    } catch (e) {
      this.say(message(e), true);
      this.model.logError("messages.get", e);
    }
  }
}
