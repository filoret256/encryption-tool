/** The output log: everything the code-agent and git actually said.
 *
 *  Before this, git spoke through a toast that held one line for 2.2 seconds.
 *  A rejected push is seven lines. A failed pull is a warning glued to an
 *  error. A commit with nothing staged is the whole of `git status` plus four
 *  hints. All of it went past too fast to read, could not be copied, and could
 *  not be brought back — so the answer to "what did it say?" was to leave the
 *  app and run the command in a terminal.
 *
 *  This is the other half of that: the toast stays a glance, and everything it
 *  had no room for lands here, in order, with a timestamp, until the session
 *  ends. It is deliberately not a terminal — nothing is typed into it — it is
 *  a transcript of what the app already did on the user's behalf.
 */
import { esc } from "./ui.ts";
import { VirtualList } from "./vlist.ts";

export type LogLevel = "info" | "error";

export interface LogEntry {
  id: number;
  time: number;
  /** What was being done: "git push", "fs.write", "search". */
  op: string;
  level: LogLevel;
  /** One line — the same text the toast showed. */
  summary: string;
  /** Everything else: raw stdout/stderr, exactly as it arrived. */
  detail?: string;
  /** How many times in a row this exact line arrived. */
  repeat?: number;
  /** What the entry weighs against the log's budget: its text, in characters. */
  size?: number;
  /** Lines in `detail`, counted once — the height of the row before it has been drawn. */
  lines?: number;
}

/** Enough to cover a working session; old entries fall off the end rather than
 *  growing without bound in a tab that stays open for days. */
const MAX_ENTRIES = 500;

/** The most the log holds, in characters of summary and detail. A count of entries is not a limit
 *  on memory: `detail` is the whole of what git printed, which the code-agent allows to be 64 MB,
 *  and five hundred of those is not a log. When the budget is passed the oldest entries go. */
const MAX_LOG_CHARS = 4 * 1024 * 1024;

/** The most one entry keeps of its `detail`: the start and the end, which is where a command says
 *  what it was doing and where it says why it failed, with a line saying how much is between. */
const DETAIL_HEAD = 48 * 1024;
const DETAIL_TAIL = 16 * 1024;

function clip(detail: string): string {
  if (detail.length <= DETAIL_HEAD + DETAIL_TAIL) return detail;
  const left = detail.length - DETAIL_HEAD - DETAIL_TAIL;
  return `${detail.slice(0, DETAIL_HEAD)}\n… ${left.toLocaleString("en-US")} characters left out …\n${detail.slice(detail.length - DETAIL_TAIL)}`;
}

const countLines = (text: string): number => {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
};

/** A row before it has been drawn: the line of the summary, and a box for the detail. Replaced by
 *  what the row measured when it was drawn, so this only has to be near. */
const LINE_H = 20;
const DETAIL_LINE_H = 15;
const estimate = (e: LogEntry): number => 8 + LINE_H + (e.detail ? 24 + (e.lines ?? 1) * DETAIL_LINE_H : 0);

const two = (n: number): string => String(n).padStart(2, "0");
const clock = (t: number): string => {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

export class OutputLog {
  private entries: LogEntry[] = [];
  private nextId = 1;
  /** What the entries weigh together, kept as they come and go. */
  private chars = 0;
  /** What each drawn row turned out to be, by entry. */
  private readonly heights = new Map<number, number>();
  private readonly list: VirtualList<LogEntry>;
  private readonly viewport: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly countEl: HTMLElement;
  /** Entry to scroll to when the panel next opens, set by "details". */
  private focusId: number | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly hooks: {
      /** The panel opened or closed. */
      onVisibility(open: boolean): void;
      /** The entries changed — added, cleared, or aged out. Anything showing a
       *  count or an error state outside this panel is now wrong until it is
       *  told; "clear" leaving a red `output 12` in the status bar is exactly
       *  what happens when it is not. */
      onChange(): void;
      /** "clear" specifically — the transcript was thrown away deliberately,
       *  so the notices describing the same events go with it. */
      onCleared(): void;
    },
    /** What the panel says while it has nothing: each tab has its own sources. */
    private readonly emptyText = "Nothing yet. Everything git and the code-agent say lands here.",
  ) {
    host.classList.add("output-log");
    host.innerHTML = `
      <div class="output-head">
        <span class="output-title">output</span>
        <span class="output-count"></span>
        <span class="t-spacer"></span>
        <button class="t-btn js-copy" type="button">copy all</button>
        <button class="t-btn js-clear" type="button">clear</button>
        <button class="t-btn js-close" type="button" aria-label="Close the output log">✕</button>
      </div>
      <div class="output-body"></div>
      <p class="output-empty" hidden></p>`;
    this.body = host.querySelector(".output-body")!;
    this.emptyEl = host.querySelector(".output-empty")!;
    this.emptyEl.textContent = emptyText;
    // Only the rows on screen are in the page: with every entry as markup, each new line rebuilt all
    // five hundred of them, on the thread that types.
    this.list = new VirtualList<LogEntry>(this.body, LINE_H, (e) => this.rowHtml(e), {
      variable: {
        heightOf: (e) => this.heights.get(e.id) ?? estimate(e),
        measured: (e, _i, height) => {
          if (this.heights.get(e.id) !== height) this.heights.set(e.id, height);
        },
      },
      // An entry can be hundreds of lines tall, and each one kept drawn off screen is laid out too.
      overscan: 2,
    });
    // The scrolling box is the list's own, so that is what takes the keyboard.
    this.viewport = this.body.querySelector<HTMLElement>(".vlist-viewport")!;
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute("role", "log");
    this.viewport.setAttribute("aria-label", "Output log");
    this.countEl = host.querySelector(".output-count")!;
    host.hidden = true;

    host.querySelector(".js-close")!.addEventListener("click", () => this.hide());
    host.querySelector(".js-clear")!.addEventListener("click", () => {
      this.entries = [];
      this.chars = 0;
      this.heights.clear();
      this.cancelRender();
      this.render();
      this.hooks.onChange();
      this.hooks.onCleared();
    });
    host.querySelector(".js-copy")!.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.asText()).catch(() => undefined);
    });
  }

  get isOpen(): boolean {
    return !this.host.hidden;
  }

  /** Record something. Returns the entry so a caller can point a toast at it.
   *
   *  A repeat of the line already at the bottom counts up instead of stacking:
   *  one failing git call is asked for by the status, the log and the file
   *  list, and a watcher that fires on `.git` brings all three back around
   *  again — which fills the log with the same sentence and buries the
   *  operation before it. */
  add(op: string, level: LogLevel, summary: string, detail?: string): LogEntry {
    const last = this.entries[this.entries.length - 1];
    // The entry holds the clipped detail, so a repeat of a long one is compared with its own clip.
    if (last && last.op === op && last.level === level && last.summary === summary && last.detail === (detail === undefined ? undefined : clip(detail))) {
      last.repeat = (last.repeat ?? 1) + 1;
      last.time = Date.now();
      if (this.isOpen) this.scheduleRender();
      this.hooks.onChange();
      return last;
    }
    const kept = detail === undefined ? undefined : clip(detail);
    const entry: LogEntry = {
      id: this.nextId++,
      time: Date.now(),
      op,
      level,
      summary,
      detail: kept,
      size: summary.length + (kept?.length ?? 0),
      lines: kept ? countLines(kept) : 0,
    };
    this.entries.push(entry);
    this.chars += entry.size!;
    // Over the count or over the budget, the oldest go — but never the one just added.
    while (this.entries.length > 1 && (this.entries.length > MAX_ENTRIES || this.chars > MAX_LOG_CHARS)) {
      const old = this.entries.shift()!;
      this.chars -= old.size ?? 0;
      this.heights.delete(old.id);
    }
    if (this.isOpen) this.scheduleRender();
    this.hooks.onChange();
    return entry;
  }

  show(focusId?: number): void {
    this.focusId = focusId ?? null;
    this.host.hidden = false;
    this.wasOpen = false;
    this.cancelRender();
    this.render();
    this.hooks.onVisibility(true);
  }

  hide(): void {
    this.cancelRender();
    this.host.hidden = true;
    this.hooks.onVisibility(false);
  }

  toggle(): void {
    if (this.isOpen) this.hide();
    else this.show();
  }

  /** How many errors are on record — the status bar shows this so a failure
   *  that scrolled past is still visible somewhere. */
  get errorCount(): number {
    return this.entries.filter((e) => e.level === "error").length;
  }

  private asText(): string {
    return this.entries
      .map((e) => `[${clock(e.time)}] ${e.op}: ${e.summary}${e.repeat && e.repeat > 1 ? ` (×${e.repeat})` : ""}${e.detail ? `\n${e.detail}` : ""}`)
      .join("\n\n");
  }

  /** Draw at the next frame, once however many entries arrived before it: a command that logs ten
   *  lines in a row drew the list ten times, and each draw is the rows on screen laid out again. */
  private frame = 0;
  private scheduleRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.isOpen) this.render();
    });
  }
  private cancelRender(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private rowHtml(e: LogEntry): string {
    return `<div class="output-entry ${e.level}" data-id="${e.id}">
          <div class="output-line">
            <span class="output-time">${clock(e.time)}</span>
            <span class="output-op">${esc(e.op)}</span>
            <span class="output-summary">${esc(e.summary)}</span>
            ${e.repeat && e.repeat > 1 ? `<span class="output-repeat">×${e.repeat}</span>` : ""}
          </div>
          ${e.detail ? `<pre class="output-detail">${esc(e.detail)}</pre>` : ""}
        </div>`;
  }

  private render(): void {
    this.countEl.textContent = this.entries.length ? `${this.entries.length} entries` : "";
    this.emptyEl.hidden = this.entries.length > 0;
    this.body.hidden = this.entries.length === 0;
    if (!this.entries.length) {
      this.list.setItems([]);
      return;
    }
    // A reader who has scrolled up to something is left there: following the newest line is for
    // someone who is at the bottom. Opening the panel, or "details", is a fresh look.
    const v = this.viewport;
    const atEnd = v.scrollTop + v.clientHeight >= v.scrollHeight - 40;
    this.list.setItems(this.entries);

    // The newest entry is the one being read, unless "details" asked for a
    // particular one — then that is what the panel opens on.
    const target = this.focusId === null ? -1 : this.entries.findIndex((e) => e.id === this.focusId);
    if (target >= 0) this.list.scrollToIndex(target);
    else if (atEnd || !this.wasOpen) this.list.scrollToIndex(this.entries.length - 1);
    this.wasOpen = true;
    this.focusId = null;
  }

  /** Whether the list has been drawn since the panel was last opened. */
  private wasOpen = false;
}
