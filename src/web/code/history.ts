/** Commit history: the log, per-commit file lists, and the commit context menu.
 *
 *  Loading is capped and extended on demand — `git log` on a large repository
 *  is fast, but shipping 50k commits through the socket and into the DOM is not.
 */
import type { AgentClient } from "./agent.ts";
import type { Commit, CommitDetail } from "../../agent/protocol.ts";
import { copyToClipboard, esc, modalConfirm, modalPrompt, setHtmlKeepingScroll, showMenu, startTrimmed, type MenuItem } from "./ui.ts";
import { computeGraph, continuationSvg, laneSvg, LANE_W, type GraphRow } from "./graph.ts";
import { iconRefresh } from "./icons.ts";

const PAGE = 100;
/** How far `reveal` will page looking for one commit — a thousand back, which
 *  is past anything a blame line realistically points at and short of walking a
 *  large repository end to end for a commit that is on another branch. */
const REVEAL_PAGES = 10;

/** Who and what a commit diff belongs to, so its two sides can be labelled with
 *  something a reader recognises instead of two near-identical hashes. */
export interface CommitAbout {
  subject: string;
  author: string;
  time: number;
  parentSubject?: string;
  parentOid?: string;
}

export interface HistoryCallbacks {
  openDiff(path: string, kind: string, about?: CommitAbout): void;
  toast(message: string, isError?: boolean): void;
  afterChange(): void;
  /** List what differs between two commits. */
  compareCommits(a: Commit, b: Commit): void;
}

/** A parsed filter line. Everything here is matched against the commits already
 *  loaded — see `matches()` for why that is said out loud in the UI. */
interface Filter {
  text: string[];
  author: string[];
  since?: number;
  until?: number;
}

/** `sort:` style prefixes, then whatever is left over as free text.
 *
 *  Deliberately small: `author:` and a date bound cover what people actually
 *  narrow a log by, and anything more elaborate is a `git log` invocation that
 *  a search box will always express worse than the command line does. */
function parseFilter(raw: string): Filter | null {
  const q = raw.trim();
  if (!q) return null;
  const f: Filter = { text: [], author: [] };
  for (const token of q.split(/\s+/)) {
    const m = /^(author|since|until):(.*)$/i.exec(token);
    if (!m || !m[2]) {
      f.text.push(token.toLowerCase());
      continue;
    }
    const key = m[1].toLowerCase();
    if (key === "author") f.author.push(m[2].toLowerCase());
    else {
      const t = Date.parse(m[2]) / 1000;
      // An unparseable date is treated as text rather than silently ignored:
      // "since:yesterday" should find nothing, not everything.
      if (Number.isNaN(t)) f.text.push(token.toLowerCase());
      else if (key === "since") f.since = t;
      else f.until = t;
    }
  }
  return f;
}

function matches(c: Commit, f: Filter): boolean {
  const hay = `${c.subject} ${c.author} ${c.email} ${c.refs}`.toLowerCase();
  if (!f.text.every((t) => hay.includes(t))) return false;
  if (!f.author.every((a) => `${c.author} ${c.email}`.toLowerCase().includes(a))) return false;
  if (f.since !== undefined && c.time < f.since) return false;
  if (f.until !== undefined && c.time > f.until) return false;
  return true;
}

/** Drop the stash and its plumbing from the log.
 *
 *  `git log --all` walks `refs/stash`, and a stash is not one commit but three:
 *  the stash itself plus two parents git makes to hold the index and the
 *  untracked files. They arrived in the middle of the real history as
 *  `On main: wip`, `index on main: cd1e044 …` and `untracked files on main:
 *  cd1e044 …`, with nothing to say they were a stash — and meanwhile the
 *  *second* stash was not shown at all, because only the top one carries a ref.
 *
 *  Filtered here rather than with `--exclude=refs/stash` in the agent because
 *  the ref decoration identifies the stash exactly, and its extra parents are
 *  reachable only through it: no guessing, and no change to a protocol the Go
 *  agent would also have to grow.
 *
 *  Stashes have a home of their own — the list in the source-control panel.
 */
function withoutStash(commits: Commit[]): Commit[] {
  const drop = new Set<string>();
  for (const c of commits) {
    if (!/\brefs\/stash\b/.test(c.refs)) continue;
    drop.add(c.oid);
    // parents[0] is the commit the stash was made on — real history, kept.
    for (const p of c.parents.slice(1)) drop.add(p);
  }
  return drop.size ? commits.filter((c) => !drop.has(c.oid)) : commits;
}

const SHELL = `
  <div class="hist-head">
    <label class="hist-toggle"><input type="checkbox" class="js-all" checked /> all branches</label>
    <label class="hist-toggle"><input type="checkbox" class="js-graph" checked /> graph</label>
    <span class="t-spacer"></span>
    <button class="t-icon js-reload" type="button" title="Reload">${iconRefresh}</button>
  </div>
  <div class="hist-scope js-scope" hidden></div>
  <div class="hist-filter">
    <input class="js-filter" type="search" placeholder="filter: text, author:name, since:2026-01"
           aria-label="Filter the loaded commits" />
    <span class="hist-filter-count js-count"></span>
  </div>
  <div class="hist-compare js-compare" hidden></div>
  <div class="hist-list js-list"></div>
  <button class="t-btn hist-more js-more" type="button" hidden>load more</button>`;

export class HistoryPanel {
  private commits: Commit[] = [];
  private graph: GraphRow[] = [];
  /** How many commits are loaded. Not a request size any more: "load more" asks
   *  for one page past this, and only a refresh re-reads the window. */
  private limit = PAGE;
  private loadingMore = false;
  /** Which commits are open.
   *
   *  A set, not one oid: comparing what two commits touched is the ordinary
   *  reason to open a commit at all, and opening the second used to close the
   *  first — so the comparison had to be done from memory. */
  private expanded = new Set<string>();
  /** When set, the log is the history of this one path.
   *
   *  Scoping, not filtering: git walks the whole history for it, so a file
   *  last touched two thousand commits ago is still found. That is the
   *  difference between this and the text filter below, and why the two are
   *  shown as different things in the header. */
  private path: string | null = null;
  /** The parsed filter line, or null when the box is empty. */
  private filter: Filter | null = null;
  /** The commit marked as one half of a comparison — the same two-step pick the
   *  explorer uses for files, so there is one gesture to learn, not two. */
  private compareBase: string | null = null;
  private details = new Map<string, CommitDetail>();
  /** Fingerprint of what is currently on screen; an unchanged log is not
   *  redrawn, so a click is never dropped because the row it landed on was
   *  replaced underneath it. */
  private renderedKey = "";
  /** Why the log is not on screen, when the answer is not simply "there is
   *  none". Kept apart from `commits` because the two used to be conflated:
   *  any failure emptied the list, and an empty list says "No commits." */
  private failure: string | null = null;

  private readonly $: <T extends HTMLElement>(sel: string) => T;

  constructor(
    private readonly host: HTMLElement,
    private readonly agent: AgentClient,
    private readonly cb: HistoryCallbacks,
  ) {
    host.classList.add("hist");
    host.innerHTML = SHELL;
    this.$ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;

    this.$(".js-all").addEventListener("change", () => void this.refresh());
    this.$(".js-graph").addEventListener("change", () => this.render());
    this.$(".js-reload").addEventListener("click", () => void this.refresh());
    this.$(".js-more").addEventListener("click", () => void this.loadMore());
    // Acting on the press. This list rebuilds itself whenever a commit's files
    // arrive and on every watcher event, and a rebuild between mousedown and
    // mouseup means the browser never reports a click at all — which is how
    // clicks here came to feel like they only worked sometimes.
    this.$(".js-list").addEventListener("pointerdown", (e) => void this.onPress(e as PointerEvent));
    this.$(".js-list").addEventListener("contextmenu", (e) => this.onContextMenu(e as MouseEvent));

    // The filter runs over what is already loaded, so it costs nothing per
    // keystroke and needs no debounce — which is the point of doing it here
    // rather than sending every keystroke to `git log --grep`.
    this.$(".js-filter").addEventListener("input", (e) => {
      this.filter = parseFilter((e.target as HTMLInputElement).value);
      this.render();
    });
    this.$(".js-filter").addEventListener("keydown", (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      this.$<HTMLInputElement>(".js-filter").value = "";
      this.filter = null;
      this.render();
    });
  }

  /** The two header toggles, for saving and restoring a session. They are the
   *  only settings in this panel that outlive a single question. */
  get options(): { all: boolean; graph: boolean } {
    return {
      all: this.$<HTMLInputElement>(".js-all").checked,
      graph: this.$<HTMLInputElement>(".js-graph").checked,
    };
  }

  setOptions(o: { all?: boolean; graph?: boolean }): void {
    if (o.all !== undefined) this.$<HTMLInputElement>(".js-all").checked = o.all;
    if (o.graph !== undefined) this.$<HTMLInputElement>(".js-graph").checked = o.graph;
    // The fingerprint below suppresses identical redraws, and a toggle changes
    // nothing about the commits themselves.
    this.renderedKey = "";
  }

  /** Show the history of one path only. */
  scopeTo(path: string | null): void {
    if (this.path === path) return;
    this.path = path;
    this.limit = PAGE;
    this.expanded.clear();
    void this.refresh();
  }

  /** Open the panel on one commit: expand it and put it on screen. */
  async reveal(oid: string): Promise<void> {
    // A blame line can name a commit older than the loaded window, and landing
    // on "nothing here" would read as the click having failed. Paging forward
    // is what reaches it; before `skip` existed this raised a limit it then
    // compared against itself, and never loaded anything at all.
    //
    // Bounded, because the commit may simply not be on this branch — walking a
    // hundred thousand commits to discover that helps nobody.
    for (let pages = 0; pages < REVEAL_PAGES && !this.commits.some((c) => c.oid === oid); pages++) {
      const before = this.commits.length;
      await this.loadMore();
      if (this.commits.length === before) break; // the log ended
    }
    if (!this.commits.some((c) => c.oid === oid)) {
      this.cb.toast(`${oid.slice(0, 7)} is not in the history being shown.`, true);
      return;
    }
    // A filter that hides the commit we were asked to show is not doing anyone
    // a favour.
    if (this.filter && !matches(this.commits.find((c) => c.oid === oid)!, this.filter)) {
      this.$<HTMLInputElement>(".js-filter").value = "";
      this.filter = null;
    }
    this.expanded.add(oid);
    this.render();
    await this.loadDetail(oid);
    this.$(".js-list").querySelector(`.hist-item[data-oid="${oid}"]`)?.scrollIntoView({ block: "center" });
  }

  /** One page of the log.
   *
   *  `skip` is why "load more" is a page rather than a bigger request: before
   *  it existed the panel raised its limit and re-asked for the whole window,
   *  so reaching the tenth page walked the first nine again — in git, over the
   *  socket, and through the parser — every time. */
  private page(limit: number, skip: number): Promise<Commit[]> {
    return this.agent.call<Commit[]>("git.log", {
      limit,
      skip,
      // `--all` and a path are not contradictory, but the answer to "who
      // changed this file" is rarely "and also on every other branch" — so
      // scoping to a path walks the current branch unless asked otherwise.
      all: this.path ? false : this.$<HTMLInputElement>(".js-all").checked,
      path: this.path ?? undefined,
    });
  }

  /** Add the next page to what is already on screen.
   *
   *  Deliberately not a refresh: the commits above are reachable history and do
   *  not change under a scroll. Anything that *does* move them — a commit, a
   *  rebase, a branch switch — arrives as a refresh, which re-reads the window
   *  whole because at that point it has to. */
  private async loadMore(): Promise<void> {
    if (this.loadingMore) return;
    this.loadingMore = true;
    const button = this.$<HTMLButtonElement>(".js-more");
    button.disabled = true;
    button.textContent = "loading…";
    try {
      const next = withoutStash(await this.page(PAGE, this.commits.length));
      // Appending is only safe while the oids are still distinct; a concurrent
      // rewrite could hand back one already shown, and a duplicated row is a
      // worse answer than a missing one.
      const seen = new Set(this.commits.map((c) => c.oid));
      this.commits = [...this.commits, ...next.filter((c) => !seen.has(c.oid))];
      // `limit` is "how many were asked for", which is what render() compares
      // the list against to decide whether the button has anywhere left to go:
      // a short page means the log ended, so leave it one above what arrived.
      // A full page means there may be more, so leave the two equal.
      this.limit = this.commits.length + (next.length === PAGE ? 0 : 1);
      this.renderedKey = "";
      this.render();
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.loadingMore = false;
      button.disabled = false;
      button.textContent = "load more";
    }
  }

  async refresh(): Promise<void> {
    if (this.agent.state !== "online" || !this.agent.info?.gitVersion) {
      this.commits = [];
      return this.render();
    }
    try {
      // The whole loaded window, because a refresh means the refs moved and the
      // pages already shown may not say what they said before.
      this.commits = withoutStash(await this.page(Math.max(this.limit, PAGE), 0));
      this.failure = null;
      // A commit's diff is immutable, but a rebase rewrites oids, so a stale
      // entry can only ever be unreachable — drop what is no longer listed.
      const live = new Set(this.commits.map((c) => c.oid));
      for (const oid of [...this.details.keys()]) if (!live.has(oid)) this.details.delete(oid);
    } catch (e) {
      this.commits = [];
      const message = e instanceof Error ? e.message : String(e);
      // A repository with no commits yet is not a failure. Anything else is —
      // and reporting it as "No commits." is how one broken entry under
      // refs/remotes made a repository with a hundred commits read as empty.
      const empty = /not a git repository|does not have any commits/i.test(message);
      this.failure = empty ? null : message;
      if (!empty) this.cb.toast(message, true);
    }
    this.render();
  }

  /** `anchorOid` is the commit the user just clicked. Expanding it, or
   *  collapsing whatever was open above it, changes the heights around it — so
   *  that row is pinned in place instead of the scroll offset. */
  private render(anchorOid?: string): void {
    const list = this.$(".js-list");
    this.renderScope();
    this.renderCompareBar();
    if (!this.commits.length) {
      list.innerHTML = this.failure
        ? `<div class="panel-error">
             <p class="panel-error-title">The history could not be loaded.</p>
             <pre>${esc(this.failure)}</pre>
             <button class="t-btn js-retry" type="button">try again</button>
           </div>`
        : `<p class="gp-empty">No commits.</p>`;
      list.querySelector(".js-retry")?.addEventListener("click", () => void this.refresh());
      this.$(".js-more").hidden = true;
      // The fingerprint below suppresses an identical redraw; an error state
      // has to be able to redraw itself once the cause is gone.
      this.renderedKey = "";
      return;
    }
    // The layout depends only on the commit list, so it is recomputed here
    // rather than in refresh() — the graph toggle re-renders without refetching.
    const withGraph = this.$<HTMLInputElement>(".js-graph").checked;
    // The filter hides rows; it must not renumber the graph, so the lanes are
    // computed over the whole log and the shown rows keep their own lane.
    const shown = this.filter ? this.commits.filter((c) => matches(c, this.filter!)) : this.commits;
    this.reportCount(shown.length);
    const key = JSON.stringify([
      this.commits.map((c) => [c.oid, c.refs, c.subject]),
      [...this.expanded].map((oid) => [oid, Boolean(this.details.get(oid))]),
      shown.length === this.commits.length ? null : shown.map((c) => c.oid),
      this.compareBase,
      withGraph,
    ]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    // A filtered log is a list of separate commits, not a connected history:
    // drawing lanes between rows with others hidden between them would join
    // commits that are not parent and child. So the graph goes while filtering.
    this.graph = withGraph && !this.filter ? computeGraph(this.commits) : [];
    const laneOf = new Map(this.commits.map((c, i) => [c.oid, this.graph[i]]));
    setHtmlKeepingScroll(
      list,
      shown.length
        ? shown.map((c) => this.commitHtml(c, laneOf.get(c.oid))).join("")
        : `<p class="gp-empty">Nothing in the loaded history matches. “load more” widens what is searched.</p>`,
      anchorOid ? `.hist-item[data-oid="${anchorOid}"] .hist-row` : undefined,
    );
    // The gutter width cannot be a style="" attribute any more (style-src has
    // no 'unsafe-inline'), so it rides in data-lanes and is applied here, once
    // the rows are in the DOM.
    for (const gutter of list.querySelectorAll<HTMLElement>(".hist-gutter")) {
      gutter.style.width = `${Number(gutter.dataset.lanes) * LANE_W}px`;
    }
    this.$(".js-more").hidden = this.commits.length < this.limit;
  }

  /** How much of the log the filter is actually looking at.
   *
   *  This is the honest half of filtering client-side: "no matches" means "not
   *  in the hundred commits loaded", and saying so is the difference between a
   *  useful answer and a wrong one. */
  private reportCount(shown: number): void {
    const el = this.$(".js-count");
    el.textContent = this.filter ? `${shown} of ${this.commits.length} loaded` : "";
  }

  private renderScope(): void {
    const bar = this.$(".js-scope");
    bar.hidden = this.path === null;
    if (this.path === null) return;
    bar.innerHTML = `<span class="hist-scope-label">history of</span>
      <span class="hist-scope-path" title="${esc(this.path)}">${esc(this.path)}</span>
      <span class="t-spacer"></span>
      <button class="t-icon js-scope-off" type="button" aria-label="Show the whole history again">✕</button>`;
    bar.querySelector(".js-scope-off")!.addEventListener("click", () => this.scopeTo(null));
  }

  private renderCompareBar(): void {
    const bar = this.$(".js-compare");
    bar.hidden = this.compareBase === null;
    if (this.compareBase === null) return;
    const c = this.commits.find((x) => x.oid === this.compareBase);
    bar.innerHTML = `<span class="hist-scope-label">compare with</span>
      <span class="hist-scope-path" title="${esc(this.compareBase)}">${esc(this.compareBase.slice(0, 7))}${
        c ? ` · ${esc(c.subject)}` : ""
      }</span>
      <span class="t-spacer"></span>
      <button class="t-icon js-compare-off" type="button" aria-label="Clear the comparison mark">✕</button>`;
    bar.querySelector(".js-compare-off")!.addEventListener("click", () => {
      this.compareBase = null;
      this.render();
    });
  }

  private async loadDetail(oid: string): Promise<void> {
    if (this.details.has(oid)) return;
    try {
      this.details.set(oid, await this.agent.call<CommitDetail>("git.commitDetail", { oid }));
    } catch (err) {
      this.cb.toast(err instanceof Error ? err.message : String(err), true);
    }
    // The file list replaces "loading…" and the block grows; the commit row
    // itself must not move while that happens.
    if (this.expanded.has(oid)) this.render(oid);
  }

  private commitHtml(c: Commit, row: GraphRow | undefined): string {
    const open = this.expanded.has(c.oid);
    const detail = this.details.get(c.oid);
    // Everything the row has no width for. The row shows a first name and "2h";
    // who that is and when that was were not recoverable from anywhere in the
    // panel, not even on hover.
    const full = `${c.subject}\n\n${c.author} <${c.email}>\n${absolute(c.time)} (${ago(c.time)})\n${c.oid}`;
    return `<div class="hist-item${open ? " open" : ""}" data-oid="${esc(c.oid)}">
      <div class="hist-row" title="${esc(full)}">
        ${row ? laneSvg(row) : `<span class="hist-dot">${c.parents.length > 1 ? "◆" : "●"}</span>`}
        <!-- After the lane, never before it: the graph is drawn against a fixed
             gutter width that the continuation SVG below has to line up with,
             and anything inserted ahead of it shifts one and not the other. -->
        <span class="hist-caret" aria-hidden="true">${open ? "▾" : "▸"}</span>
        ${refsHtml(c.refs)}
        <span class="hist-subject">${esc(c.subject)}</span>
        <span class="hist-meta">${esc(shortName(c.author))} · ${ago(c.time)}</span>
        <span class="hist-oid">${c.oid.slice(0, 7)}</span>
      </div>
      ${open ? this.detailHtml(c, detail, row) : ""}
    </div>`;
  }

  private detailHtml(c: Commit, detail: CommitDetail | undefined, row: GraphRow | undefined): string {
    // The lanes continue alongside the expanded block so the graph is not cut
    // in half by opening a commit.
    // The gutter carries an explicit width and holds the SVG absolutely, so the
    // lanes stretch to whatever height the file list needs. Left in flow, an
    // <svg height="100%"> with no definite parent height falls back to its
    // intrinsic 150px and padded the block out with dead space.
    const gutter = row
      ? `<div class="hist-gutter" data-lanes="${row.columns}">${continuationSvg(row)}</div>`
      : "";
    // The identity line is known from the log itself, so it is shown at once
    // rather than after `git.commitDetail` comes back — and it is where the
    // things the row has no room for finally get said in full: surname, email,
    // and the date as a date, not as "2h".
    const who = `<div class="hist-who">
      <span class="hist-who-name" title="${esc(`${c.author} <${c.email}>`)}">${esc(c.author)} &lt;${esc(c.email)}&gt;</span>
      <span class="hist-who-when" title="${esc(ago(c.time))} ago">${esc(absolute(c.time))} · ${ago(c.time)} ago</span>
    </div>`;
    if (!detail) return `<div class="hist-files">${gutter}<div class="hist-files-body">${who}<span class="gp-empty">loading…</span></div></div>`;

    const body = detail.body.trim();
    return `<div class="hist-files">${gutter}<div class="hist-files-body">
      ${who}
      ${body ? `<pre class="hist-body">${esc(body)}</pre>` : ""}
      ${detail.files
        .map(
          (f) => `<div class="hist-file" data-path="${esc(f.path)}" title="${esc(f.path)}">
            <span class="hist-status st-${esc(f.status)}">${f.status}</span>
            <span class="hist-fname">${esc(f.path)}</span>
            <span class="hist-stat">${f.binary ? "bin" : `+${f.added} −${f.deleted}`}</span>
          </div>`,
        )
        .join("")}
    </div></div>`;
  }

  private async onPress(e: PointerEvent): Promise<void> {
    // Left button only; the right one belongs to the context menu.
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>(".hist-item");
    if (!item) return;
    const oid = item.dataset.oid!;

    const file = target.closest<HTMLElement>(".hist-file");
    if (file) return this.cb.openDiff(file.dataset.path!, oid, this.about(oid));

    // Only the header row toggles. The block below it is content to read, and
    // treating any click inside it as a toggle meant a click that missed a file
    // name collapsed the commit — which reads as the panel closing at random.
    if (!target.closest(".hist-row")) return;

    if (this.expanded.has(oid)) this.expanded.delete(oid);
    else this.expanded.add(oid);
    this.render(oid);
    if (this.expanded.has(oid)) await this.loadDetail(oid);
  }

  /** The commit's own description, plus its parent's when the parent happens to
   *  be in the loaded log — a first parent that is off the end of the page is
   *  not worth a round trip just to name the left-hand column. */
  private about(oid: string): CommitAbout | undefined {
    const c = this.commits.find((x) => x.oid === oid);
    if (!c) return undefined;
    const parentOid = c.parents[0];
    const parent = parentOid ? this.commits.find((x) => x.oid === parentOid) : undefined;
    return { subject: c.subject, author: c.author, time: c.time, parentOid, parentSubject: parent?.subject };
  }

  private onContextMenu(e: MouseEvent): void {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".hist-item");
    if (!item) return;
    e.preventDefault();
    const oid = item.dataset.oid!;
    const short = oid.slice(0, 7);

    const base = this.compareBase;
    const marked = base === oid;
    const items: MenuItem[] = [
      // Both lengths, both confirmed. The short one is what goes in a message
      // or a chat, the full one is what a script or a `git show` wants, and
      // trimming the long one by hand is the kind of thing people get wrong.
      { label: `Copy SHA (${short})`, run: () => void copyToClipboard(short, "SHA", this.cb.toast) },
      { label: "Copy full SHA", run: () => void copyToClipboard(oid, "Full SHA", this.cb.toast) },
    ];

    // The same two-step pick as files in the explorer, for the same reason:
    // "compare two commits" has no single-click gesture that is not a guess
    // about which two.
    if (base !== null && !marked) {
      const a = this.commits.find((c) => c.oid === base);
      const b = this.commits.find((c) => c.oid === oid);
      if (a && b) {
        items.push({
          label: `Compare with ${base.slice(0, 7)}`,
          separated: true,
          run: () => {
            this.compareBase = null;
            this.render();
            // Older first, so the diff reads forwards however they were picked.
            const [from, to] = a.time <= b.time ? [a, b] : [b, a];
            this.cb.compareCommits(from, to);
          },
        });
      }
    }
    items.push({
      label: marked ? "✓ Selected for compare — click to clear" : "Select for compare",
      separated: base === null || marked,
      run: () => {
        this.compareBase = marked ? null : oid;
        this.render();
      },
    });

    showMenu(e.clientX, e.clientY, [
      ...items,
      { label: "Checkout this commit", separated: true, run: () => void this.run("git.checkout", { ref: oid }, `checked out ${short} (detached)`) },
      ["Create branch here…", () => void this.branchHere(oid)],
      ["Revert this commit", () => void this.run("git.revert", { oid }, `reverted ${short}`)],
      ["Cherry-pick onto current", () => void this.run("git.cherryPick", { oid }, `cherry-picked ${short}`)],
      ["Reset — keep changes staged (soft)", () => void this.reset(oid, "soft")],
      ["Reset — keep changes (mixed)", () => void this.reset(oid, "mixed")],
      ["Reset — discard changes (hard)", () => void this.reset(oid, "hard")],
    ]);
  }

  private async branchHere(oid: string): Promise<void> {
    const name = await modalPrompt({ title: "New branch at this commit", okLabel: "create" });
    if (name) await this.run("git.branchCreate", { name, from: oid }, `created ${name}`);
  }

  private async reset(oid: string, mode: "soft" | "mixed" | "hard"): Promise<void> {
    if (mode === "hard") {
      const ok = await modalConfirm({
        title: `Reset --hard to ${oid.slice(0, 7)}?`,
        detail: "Every uncommitted change in the working tree is discarded, staged or not.",
        okLabel: "reset --hard",
        danger: true,
      });
      if (!ok) return;
    }
    await this.run("git.reset", { oid, mode }, `reset --${mode} to ${oid.slice(0, 7)}`);
  }

  private async run(op: string, params: Record<string, unknown>, okMessage: string): Promise<void> {
    try {
      await this.agent.call(op, params);
      this.cb.toast(okMessage);
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
    await this.refresh();
    this.cb.afterChange();
  }
}

// ── formatting ────────────────────────────────────────────────────────────

/** "HEAD -> main, origin/main, tag: v2" as chips. */
function refsHtml(refs: string): string {
  if (!refs.trim()) return "";
  const chips = refs
    .split(", ")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const kind = r.startsWith("tag: ") ? "tag" : r.includes("HEAD") ? "head" : r.includes("/") ? "remote" : "local";
      // "tag: " and "HEAD -> " are prefixes the chip already says by its
      // colour, and in a 260px panel they were spending the pill's whole width
      // to repeat it: `HEAD -> main` came out as `…ain`. The full decoration
      // stays in the tooltip.
      const label = r.replace(/^tag: /, "").replace(/^HEAD -> /, "");
      // A pill truncates when the panel is narrow and several refs land on one
      // commit, which is exactly when knowing the full name matters most — so
      // what survives the cut is the end of the name, where refs differ.
      // A tag is not a branch and must not be told apart by hue alone: the two
      // were the same green pill, and `v1.2.0` beside `main` was a shade of
      // difference on a release day. Tags get a square end and a marker.
      const mark = kind === "tag" ? `<span class="hist-ref-mark" aria-hidden="true">⌗</span>` : "";
      return `<span class="hist-ref ref-${kind}" title="${esc(r)}">${mark}<span class="hist-ref-name">${esc(startTrimmed(label))}</span></span>`;
    });
  return `<span class="hist-refs">${chips.join("")}</span>`;
}

const shortName = (author: string): string => author.split(/\s+/)[0] ?? author;

/** The date as a date. `ago()` is the right thing in a dense list and the wrong
 *  thing the moment someone asks "was that before or after the incident?" —
 *  "3mo" cannot answer that and a timestamp can. Local time, because the
 *  question is always asked against the reader's own calendar. */
export function absolute(seconds: number): string {
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return "unknown date";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ago(seconds: number): string {
  const d = Math.max(0, Date.now() / 1000 - seconds);
  const steps: [number, string][] = [
    [60, "s"],
    [3600, "m"],
    [86400, "h"],
    [86400 * 30, "d"],
    [86400 * 365, "mo"],
  ];
  if (d < 60) return `${Math.floor(d)}s`;
  for (let i = 1; i < steps.length; i++) {
    if (d < steps[i][0]) return `${Math.floor(d / steps[i - 1][0])}${steps[i][1]}`;
  }
  return `${Math.floor(d / (86400 * 365))}y`;
}
