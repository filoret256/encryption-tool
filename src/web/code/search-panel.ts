/** Project-wide search and replace.
 *
 *  The scan itself happens in the agent (ripgrep when present, a `git ls-files`
 *  walk otherwise) and streams back hit by hit, so results fill in instead of
 *  arriving all at once at the end. Replace is done here rather than in the
 *  agent because it has to respect which individual matches the user dismissed,
 *  which only the result list knows.
 */
import type { AgentClient } from "./agent.ts";
import type { FileRead, SearchHit, SearchSummary } from "../../agent/protocol.ts";
import { VirtualList } from "./vlist.ts";
import { esc, modalConfirm, showMenu } from "./ui.ts";
import { iconClose, iconReplace } from "./icons.ts";
import { ROW_H as SHARED_ROW_H } from "./ui.ts";

export interface SearchCallbacks {
  openAt(path: string, line: number, col: number): void;
  toast(message: string, isError?: boolean): void;
  /** Something worth keeping happened; `detail` is for the output log. */
  report(summary: string, detail?: string): void;
  /** Files on disk changed — the tree and git status are stale. */
  afterReplace(): void;
}

type Row =
  | { kind: "file"; path: string; count: number }
  | { kind: "hit"; path: string; hit: SearchHit; key: string };

export interface Options {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  preserveCase: boolean;
}

const OPTS_KEY = "enc-search-opts";
const RECENT_KEY = "enc-search-recent";
/** Enough to get back to this morning's query, short enough to stay a list a
 *  person can read rather than scroll. */
const MAX_RECENT = 10;

const loadRecent = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const rememberQuery = (q: string): void => {
  if (!q.trim()) return;
  try {
    const next = [q, ...loadRecent().filter((x) => x !== q)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
};
const ROW_H = SHARED_ROW_H;
const DEBOUNCE_MS = 300;
/** Results are repainted on a timer, not per hit: a broad query can stream
 *  thousands of matches and re-rendering on each one would stall the tab. */
const PAINT_MS = 100;

const SHELL = `
  <div class="sp-form">
    <div class="sp-line">
      <input class="t-input js-query" placeholder="Search" spellcheck="false" autocomplete="off" />
      <button class="sp-tog js-recent" type="button" title="Recent searches">↺</button>
      <button class="sp-tog js-case" type="button" title="Match case">Aa</button>
      <button class="sp-tog js-word" type="button" title="Match whole word">ab</button>
      <button class="sp-tog js-regex" type="button" title="Use regular expression">.*</button>
    </div>
    <div class="sp-line">
      <input class="t-input js-replace" placeholder="Replace" spellcheck="false" autocomplete="off" />
      <button class="sp-tog js-preserve" type="button" title="Preserve case">AB</button>
      <button class="t-icon js-replace-all" type="button" title="Replace all">${iconReplace}</button>
    </div>
    <details class="sp-globs">
      <summary>files to include / exclude</summary>
      <input class="t-input js-include" placeholder="e.g. src/**" spellcheck="false" autocomplete="off" />
      <input class="t-input js-exclude" placeholder="e.g. **/dist" spellcheck="false" autocomplete="off" />
    </details>
  </div>
  <div class="sp-summary js-summary"></div>
  <div class="sp-results js-results"></div>`;

export class SearchPanel {
  private results = new Map<string, SearchHit[]>();
  private collapsed = new Set<string>();
  private dismissed = new Set<string>();
  private rows: Row[] = [];
  /** Where F4 is in the result list. */
  private at = -1;
  /** The last summary from the agent, kept so the line can be recomputed as
   *  matches are dismissed — it used to keep claiming the original number
   *  after half the hits had been waved away. */
  private summary: SearchSummary | null = null;
  /** Set by the stop button while a replace is running. */
  private cancelReplace = false;
  private list: VirtualList<Row>;

  private opts: Options;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private paintTimer: ReturnType<typeof setTimeout> | null = null;
  /** Request id of the scan whose hits we still accept. */
  private activeId = 0;
  private matches = 0;

  private readonly $: <T extends HTMLElement>(sel: string) => T;

  constructor(
    private readonly host: HTMLElement,
    private readonly agent: AgentClient,
    private readonly cb: SearchCallbacks,
  ) {
    host.classList.add("sp");
    host.innerHTML = SHELL;
    this.$ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
    this.opts = loadOptions();

    this.list = new VirtualList<Row>(this.$(".js-results"), ROW_H, (row) => this.rowHtml(row));
    this.list.onClick((row, _i, target) => void this.onRowClick(row, target));

    for (const [sel, key] of [
      [".js-case", "matchCase"],
      [".js-word", "wholeWord"],
      [".js-regex", "regex"],
      [".js-preserve", "preserveCase"],
    ] as [string, keyof Options][]) {
      this.$(sel).addEventListener("click", () => {
        this.opts[key] = !this.opts[key];
        saveOptions(this.opts);
        this.paintToggles();
        if (key !== "preserveCase") this.schedule();
      });
    }

    for (const sel of [".js-query", ".js-include", ".js-exclude"]) {
      this.$(sel).addEventListener("input", () => this.schedule());
    }
    this.$(".js-query").addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void this.run();
    });
    // Typing a replacement changes what the rows say, not what was found: the
    // list is repainted, the scan is not repeated.
    this.$(".js-replace").addEventListener("input", () => this.list.refresh());
    this.$(".js-replace-all").addEventListener("click", () => void this.replace([...this.results.keys()]));
    this.$(".js-recent").addEventListener("click", (e) => this.recentMenu(e as MouseEvent));

    this.paintToggles();
  }

  focus(): void {
    this.$<HTMLInputElement>(".js-query").focus();
    this.$<HTMLInputElement>(".js-query").select();
  }

  /** Put a query in the box and run it — used by the palette and by "search in
   *  this folder" from the explorer. */
  searchFor(query: string, include?: string): void {
    this.$<HTMLInputElement>(".js-query").value = query;
    if (include !== undefined) {
      this.$<HTMLInputElement>(".js-include").value = include;
      // The include field lives in a collapsed <details>; setting it silently
      // would scope the search to something the reader cannot see.
      this.host.querySelector<HTMLDetailsElement>(".sp-globs")?.setAttribute("open", "");
    }
    this.focus();
    void this.run();
  }

  /** The replacement settings, or undefined while the replace box is empty —
   *  in which case the rows are just results and nothing is previewed. */
  private previewOpts(): { replacement: string; regex: RegExp | null; preserveCase: boolean } | undefined {
    const replacement = this.$<HTMLInputElement>(".js-replace").value;
    if (!replacement) return undefined;
    const query = this.$<HTMLInputElement>(".js-query").value;
    if (!query) return undefined;
    let regex: RegExp | null = null;
    if (this.opts.regex) {
      if (!isValidRegex(query, this.opts)) return undefined;
      regex = new RegExp(patternSource(query, this.opts), this.opts.matchCase ? "" : "i");
    }
    return { replacement, regex, preserveCase: this.opts.preserveCase };
  }

  private recentMenu(e: MouseEvent): void {
    const recent = loadRecent();
    if (!recent.length) return this.cb.toast("No searches yet in this browser.");
    showMenu(
      e.clientX,
      e.clientY,
      recent.map((q) => ({
        label: q.length > 48 ? `${q.slice(0, 47)}…` : q,
        run: () => this.searchFor(q),
      })),
    );
  }

  /** Walk the hits from the keyboard. F4 is what every editor binds to it, and
   *  without it a long result list is a mouse-only object. */
  step(delta: number): void {
    const hits = this.rows.filter((r): r is Extract<Row, { kind: "hit" }> => r.kind === "hit");
    if (!hits.length) return;
    this.at = (this.at + delta + hits.length) % hits.length;
    const row = hits[this.at];
    this.cb.openAt(row.path, row.hit.line, row.hit.col);
  }

  /** Called when the panel becomes visible or files changed underneath it. */
  rerun(): void {
    if (this.$<HTMLInputElement>(".js-query").value) void this.run();
  }

  private paintToggles(): void {
    const map: [string, keyof Options][] = [
      [".js-case", "matchCase"],
      [".js-word", "wholeWord"],
      [".js-regex", "regex"],
      [".js-preserve", "preserveCase"],
    ];
    for (const [sel, key] of map) this.$(sel).classList.toggle("is-active", this.opts[key]);
  }

  // ── running the scan ────────────────────────────────────────────────────

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.run(), DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    if (this.debounce) clearTimeout(this.debounce);
    const query = this.$<HTMLInputElement>(".js-query").value;

    // Supersede whatever is still scanning; the agent stops it at the next hit.
    if (this.activeId) void this.agent.call("cancel", { target: this.activeId }).catch(() => undefined);
    this.results.clear();
    this.dismissed.clear();
    this.matches = 0;
    this.rebuild();

    if (!query || this.agent.state !== "online") {
      this.setSummary(query ? "agent is not connected" : "");
      return;
    }
    if (this.opts.regex && !isValidRegex(query, this.opts)) {
      this.setSummary("invalid regular expression");
      return;
    }
    this.setSummary("searching…");
    this.at = -1;
    // Remembered once the query is known to be runnable, so a half-typed
    // regular expression does not end up in the list.
    rememberQuery(query);

    const { id, promise } = this.agent.callTracked<SearchSummary>(
      "search",
      {
        query,
        matchCase: this.opts.matchCase,
        wholeWord: this.opts.wholeWord,
        regex: this.opts.regex,
        include: this.$<HTMLInputElement>(".js-include").value || undefined,
        exclude: this.$<HTMLInputElement>(".js-exclude").value || undefined,
      },
      (chunk) => {
        if (id !== this.activeId) return; // a later scan already took over
        const hit = (chunk as { hit?: SearchHit }).hit;
        if (!hit) return;
        const list = this.results.get(hit.path);
        if (list) list.push(hit);
        else this.results.set(hit.path, [hit]);
        this.matches += Math.max(1, hit.ranges.length);
        this.schedulePaint();
      },
    );
    this.activeId = id;

    try {
      const summary = await promise;
      if (id !== this.activeId) return;
      // Drop a queued repaint: its "searching…" text would land after this
      // final summary and leave the panel looking stuck.
      if (this.paintTimer) clearTimeout(this.paintTimer);
      this.paintTimer = null;
      this.summary = summary;
      this.rebuild();
      this.renderSummary();
    } catch (e) {
      if (this.paintTimer) clearTimeout(this.paintTimer);
      this.paintTimer = null;
      if (id === this.activeId) this.setSummary(e instanceof Error ? e.message : String(e));
    }
  }

  private schedulePaint(): void {
    if (this.paintTimer) return;
    this.paintTimer = setTimeout(() => {
      this.paintTimer = null;
      if (!this.activeId) return;
      this.rebuild();
      this.setSummary(`searching… ${this.matches} in ${this.results.size} files`);
    }, PAINT_MS);
  }

  private setSummary(text: string): void {
    this.summary = null;
    this.$(".js-summary").textContent = text;
  }

  /** The count as it stands now.
   *
   *  Counted off the rows rather than off the agent's total, so dismissing a
   *  match changes the number. Reporting what the scan found while the list
   *  shows something else is the summary disagreeing with the thing it
   *  summarises; the scan's own total is still named when the two differ, since
   *  "3 of 57" is the useful shape of that sentence. */
  private renderSummary(): void {
    const s = this.summary;
    if (!s) return;
    let matches = 0;
    let files = 0;
    for (const row of this.rows) {
      if (row.kind !== "file") continue;
      files++;
      matches += row.count;
    }
    const el = this.$(".js-summary");
    if (matches === 0) {
      el.textContent = s.matches === 0 ? "no results" : `all ${s.matches} results dismissed`;
      return;
    }
    el.textContent =
      `${matches}${matches < s.matches ? ` of ${s.matches}` : ""} result${matches === 1 ? "" : "s"}` +
      ` in ${files} file${files === 1 ? "" : "s"}` +
      (s.truncated ? " (truncated)" : "") +
      ` · ${s.engine}`;
  }

  // ── rows ────────────────────────────────────────────────────────────────

  private rebuild(): void {
    this.rows = [];
    for (const [path, hits] of this.results) {
      const live = hits.filter((h) => !this.dismissed.has(hitKey(path, h)));
      if (!live.length) continue;
      this.rows.push({ kind: "file", path, count: live.length });
      if (this.collapsed.has(path)) continue;
      for (const hit of live) this.rows.push({ kind: "hit", path, hit, key: hitKey(path, hit) });
    }
    this.list.setItems(this.rows);
    this.renderSummary();
  }

  private rowHtml(row: Row): string {
    if (row.kind === "file") {
      const name = row.path.split("/").pop() ?? row.path;
      const dir = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "";
      return `<div class="sp-file" data-path="${esc(row.path)}" title="${esc(row.path)}">
        <span class="sp-caret">${this.collapsed.has(row.path) ? "▸" : "▾"}</span>
        <span class="sp-fname">${esc(name)}</span>
        <span class="sp-fdir">${esc(dir)}</span>
        <span class="sp-count">${row.count}</span>
        <span class="sp-acts">
          <button class="t-icon" data-act="replace-file" title="Replace in this file">${iconReplace}</button>
          <button class="t-icon" data-act="dismiss-file" title="Dismiss file">${iconClose}</button>
        </span>
      </div>`;
    }
    // The rendered line is trimmed twice over — indentation dropped, a window
    // taken around the first match, a hard cap at 200 characters — so on a long
    // line what is on screen can be a fragment with the context cut off both
    // ends. The title carries the line as it actually is.
    return `<div class="sp-hit" data-path="${esc(row.path)}" data-key="${esc(row.key)}" title="${esc(hitTitle(row.path, row.hit))}">
      <span class="sp-lineno">${row.hit.line}</span>
      <span class="sp-text">${hitHtml(row.hit, this.previewOpts())}</span>
      <span class="sp-acts"><button class="t-icon" data-act="dismiss-hit" title="Dismiss match">${iconClose}</button></span>
    </div>`;
  }

  private async onRowClick(row: Row, target: HTMLElement): Promise<void> {
    const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;

    if (act === "dismiss-file") {
      for (const h of this.results.get(row.path) ?? []) this.dismissed.add(hitKey(row.path, h));
      return this.rebuild();
    }
    if (act === "replace-file") return this.replace([row.path]);
    if (act === "dismiss-hit" && row.kind === "hit") {
      this.dismissed.add(row.key);
      return this.rebuild();
    }

    if (row.kind === "file") {
      if (this.collapsed.has(row.path)) this.collapsed.delete(row.path);
      else this.collapsed.add(row.path);
      return this.rebuild();
    }
    this.cb.openAt(row.path, row.hit.line, row.hit.col);
  }

  // ── replace ─────────────────────────────────────────────────────────────

  private async replace(paths: string[]): Promise<void> {
    const replacement = this.$<HTMLInputElement>(".js-replace").value;
    const live = paths
      .map((p) => [p, (this.results.get(p) ?? []).filter((h) => !this.dismissed.has(hitKey(p, h)))] as const)
      .filter(([, hits]) => hits.length);
    if (!live.length) return this.cb.toast("nothing to replace", true);

    const total = live.reduce((n, [, hits]) => n + hits.reduce((m, h) => m + h.ranges.length, 0), 0);
    const ok = await modalConfirm({
      title: `Replace ${total} match${total === 1 ? "" : "es"} across ${live.length} file${live.length === 1 ? "" : "s"}?`,
      detail: "The files are written on disk. Undo works only in files you have open in the editor.",
      okLabel: "replace all",
      danger: true,
    });
    if (!ok) return;

    const single = this.opts.regex ? new RegExp(patternSource(this.$<HTMLInputElement>(".js-query").value, this.opts), this.opts.matchCase ? "" : "i") : null;
    let files = 0;
    let done = 0;
    let skipped = 0;
    const written: string[] = [];

    // A replace across a monorepo is a sequence of writes with no upper bound
    // on how long it takes, and it used to happen behind a silent panel. Now it
    // says where it is and can be stopped — between files, so a file is never
    // left half written.
    this.cancelReplace = false;
    const bar = this.$(".js-summary");
    const showProgress = (): void => {
      bar.innerHTML = `<span>replacing… ${files}/${live.length} files</span>
        <button class="t-btn js-stop-replace" type="button">stop</button>`;
      bar.querySelector(".js-stop-replace")!.addEventListener("click", () => {
        this.cancelReplace = true;
        bar.textContent = "stopping…";
      });
    };
    showProgress();

    for (const [path, hits] of live) {
      if (this.cancelReplace) break;
      try {
        const file = await this.agent.call<FileRead>("fs.read", { path });
        if (file.text === null) {
          skipped += hits.length;
          continue;
        }
        // Split keeping the separators so CRLF files are written back unchanged.
        const parts = file.text.split(/(\r?\n)/);
        let touched = 0;

        for (const hit of hits) {
          const idx = (hit.line - 1) * 2;
          // The file may have moved on since the scan; only touch lines that
          // are still byte-for-byte what was matched.
          if (parts[idx] !== hit.text) {
            skipped += hit.ranges.length;
            continue;
          }
          const applied = replaceInLine(parts[idx], hit.ranges, replacement, {
            regex: single,
            preserveCase: this.opts.preserveCase,
          });
          parts[idx] = applied.line;
          touched += applied.count;
        }

        if (touched) {
          await this.agent.call("fs.write", { path, text: parts.join("") });
          files++;
          done += touched;
          written.push(`${path} — ${touched}`);
          showProgress();
        }
      } catch (e) {
        this.cb.toast(`${path}: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }

    const stopped = this.cancelReplace;
    this.cancelReplace = false;
    const headline =
      `replaced ${done} in ${files} file${files === 1 ? "" : "s"}` +
      (skipped ? `, ${skipped} skipped (changed on disk)` : "") +
      (stopped ? " — stopped early" : "");
    // The file list goes to the output log rather than a toast: twenty paths
    // are not something to read in two seconds, and after a replace across a
    // project "which files did that touch" is the next question.
    this.cb.report(headline, written.join("\n") || undefined);
    this.cb.afterReplace();
    void this.run();
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

const hitKey = (path: string, hit: SearchHit): string => `${path}:${hit.line}:${hit.col}`;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Apply the replacement to every matched range of one line.
 *
 *  Ranges are processed right to left so the offsets of the earlier ones stay
 *  valid as the line grows or shrinks. When the search used a regex, the
 *  replacement is applied to the matched text alone: that keeps `$1` backrefs
 *  working without re-scanning the line (which would also hit matches the user
 *  dismissed).
 */
export function replaceInLine(
  line: string,
  ranges: [number, number][],
  replacement: string,
  opts: { regex: RegExp | null; preserveCase: boolean },
): { line: string; count: number } {
  let out = line;
  let count = 0;
  for (const [s, e] of [...ranges].sort((a, b) => b[0] - a[0])) {
    if (s < 0 || e > out.length || e <= s) continue;
    const matched = out.slice(s, e);
    let rep = opts.regex ? matched.replace(opts.regex, replacement) : replacement;
    if (opts.preserveCase) rep = preserveCase(matched, rep);
    out = out.slice(0, s) + rep + out.slice(e);
    count++;
  }
  return { line: out, count };
}

/** What one matched fragment becomes — the same two steps `replaceInLine` takes,
 *  so the preview cannot drift from what the write will do. */
function renderReplacement(
  matched: string,
  o: { replacement: string; regex: RegExp | null; preserveCase: boolean },
): string {
  let rep = o.regex ? matched.replace(o.regex, o.replacement) : o.replacement;
  if (o.preserveCase) rep = preserveCase(matched, rep);
  return rep;
}

/** The regex source the agent searched with, rebuilt here so replace behaves
 *  identically to the scan. */
export function patternSource(query: string, o: Options): string {
  const src = o.regex ? query : escapeRe(query);
  return o.wholeWord ? `\\b(?:${src})\\b` : src;
}

function isValidRegex(query: string, o: Options): boolean {
  try {
    new RegExp(patternSource(query, o));
    return true;
  } catch {
    return false;
  }
}

/** VS Code's "preserve case": carry the casing shape of what was matched over
 *  to the replacement. Not available in CodeMirror or ripgrep — this is the
 *  whole implementation. */
export function preserveCase(found: string, replacement: string): string {
  if (!found || !replacement) return replacement;
  const hasLetters = /[a-z]/i.test(found);
  if (!hasLetters) return replacement;

  if (found === found.toUpperCase() && found !== found.toLowerCase()) return replacement.toUpperCase();
  if (found === found.toLowerCase()) return replacement.toLowerCase();
  // Title case: first letter upper, remainder lower.
  if (found[0] === found[0].toUpperCase() && found.slice(1) === found.slice(1).toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement; // mixed / camelCase — leave the replacement as typed
}

/** What hovering a result says: where it is, and the whole line.
 *
 *  Capped, because a minified bundle is one line of half a megabyte and a
 *  tooltip that long is worse than none. */
function hitTitle(path: string, hit: SearchHit): string {
  const MAX = 600;
  const line = hit.text.trim();
  return `${path}:${hit.line}\n${line.length > MAX ? `${line.slice(0, MAX)}…` : line}`;
}

/** One result line, with the matches marked and long lines trimmed around the
 *  first hit so the interesting part is visible without scrolling. */
/** One result line, with the matches marked — and, when a replacement is being
 *  typed, with what each match is about to become.
 *
 *  "Replace all" writes to files that are not open, so the only chance to see
 *  what it does is before it does it. A capture group in a regular expression
 *  is exactly where that matters most: `$1` is a promise the box cannot keep
 *  until it is applied to the line. */
function hitHtml(hit: SearchHit, preview?: { replacement: string; regex: RegExp | null; preserveCase: boolean }): string {
  const MAX = 200;
  let text = hit.text;
  let ranges = hit.ranges.map(([s, e]) => [s, e] as [number, number]);

  const shift = (n: number): void => {
    text = text.slice(n);
    ranges = ranges.map(([s, e]) => [s - n, e - n]);
  };

  shift(text.length - text.trimStart().length); // drop indentation
  let prefix = "";
  const first = ranges[0]?.[0] ?? 0;
  if (first > 60) {
    shift(first - 40);
    prefix = "…";
  }
  let suffix = "";
  if (text.length > MAX) {
    text = text.slice(0, MAX);
    suffix = "…";
  }

  let out = "";
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s >= text.length || e <= s) continue;
    const end = Math.min(e, text.length);
    const matched = text.slice(s, end);
    out += esc(text.slice(pos, s));
    if (preview) {
      const to = renderReplacement(matched, preview);
      // Both halves, so the reader compares them instead of taking the new one
      // on trust. An unchanged match shows once, not twice.
      out +=
        to === matched
          ? `<mark>${esc(matched)}</mark>`
          : `<mark class="from">${esc(matched)}</mark><mark class="to">${esc(to)}</mark>`;
    } else {
      out += `<mark>${esc(matched)}</mark>`;
    }
    pos = end;
  }
  return prefix + out + esc(text.slice(pos)) + suffix;
}

function loadOptions(): Options {
  const fallback: Options = { matchCase: false, wholeWord: false, regex: false, preserveCase: false };
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(OPTS_KEY) ?? "{}") as Partial<Options>) };
  } catch {
    return fallback;
  }
}

function saveOptions(o: Options): void {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify(o));
  } catch {
    /* private mode */
  }
}
