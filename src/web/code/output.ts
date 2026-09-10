/** The output log: everything the agent and git actually said.
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
}

/** Enough to cover a working session; old entries fall off the end rather than
 *  growing without bound in a tab that stays open for days. */
const MAX_ENTRIES = 500;

const two = (n: number): string => String(n).padStart(2, "0");
const clock = (t: number): string => {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

export class OutputLog {
  private entries: LogEntry[] = [];
  private nextId = 1;
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
      <div class="output-body" tabindex="0"></div>`;
    this.body = host.querySelector(".output-body")!;
    this.countEl = host.querySelector(".output-count")!;
    host.hidden = true;

    host.querySelector(".js-close")!.addEventListener("click", () => this.hide());
    host.querySelector(".js-clear")!.addEventListener("click", () => {
      this.entries = [];
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
    if (last && last.op === op && last.level === level && last.summary === summary && last.detail === detail) {
      last.repeat = (last.repeat ?? 1) + 1;
      last.time = Date.now();
      if (this.isOpen) this.render();
      this.hooks.onChange();
      return last;
    }
    const entry: LogEntry = { id: this.nextId++, time: Date.now(), op, level, summary, detail };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (this.isOpen) this.render();
    this.hooks.onChange();
    return entry;
  }

  show(focusId?: number): void {
    this.focusId = focusId ?? null;
    this.host.hidden = false;
    this.render();
    this.hooks.onVisibility(true);
  }

  hide(): void {
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

  private render(): void {
    this.countEl.textContent = this.entries.length ? `${this.entries.length} entries` : "";
    if (!this.entries.length) {
      this.body.innerHTML = `<p class="output-empty">Nothing yet. Everything git and the agent say lands here.</p>`;
      return;
    }
    this.body.innerHTML = this.entries
      .map(
        (e) => `<div class="output-entry ${e.level}" data-id="${e.id}">
          <div class="output-line">
            <span class="output-time">${clock(e.time)}</span>
            <span class="output-op">${esc(e.op)}</span>
            <span class="output-summary">${esc(e.summary)}</span>
            ${e.repeat && e.repeat > 1 ? `<span class="output-repeat">×${e.repeat}</span>` : ""}
          </div>
          ${e.detail ? `<pre class="output-detail">${esc(e.detail)}</pre>` : ""}
        </div>`,
      )
      .join("");

    // The newest entry is the one being read, unless "details" asked for a
    // particular one — then that is what the panel opens on.
    const target = this.focusId
      ? this.body.querySelector<HTMLElement>(`.output-entry[data-id="${this.focusId}"]`)
      : null;
    if (target) target.scrollIntoView({ block: "center" });
    else this.body.scrollTop = this.body.scrollHeight;
    this.focusId = null;
  }
}
