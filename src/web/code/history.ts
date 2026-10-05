/** Commit history: the log, per-commit file lists, and the commit context menu.
 *
 *  Loading is capped and extended on demand — `git log` on a large repository
 *  is fast, but shipping 50k commits through the socket and into the DOM is not.
 */
import type { CodeAgentClient } from "./code-agent.ts";
import type { BranchList, Commit, CommitDetail, GitStatus } from "../../code-agent/protocol.ts";
import { copyToClipboard, esc, modalConfirm, modalPrompt, ROW_H, showMenu, startTrimmed, type MenuItem } from "./ui.ts";
import { computeGraph, continuationSvg, laneSvg, LANE_W, type GraphRow } from "./graph.ts";
import { debounce } from "./debounce.ts";
import { VirtualList } from "./vlist.ts";
import { iconRefresh } from "./icons.ts";
import { OP_SCOPE } from "./git-panel.ts";
import { pickRef } from "./refpicker.ts";
import { singleFlight } from "./singleflight.ts";

const PAGE = 100;
/** How far `reveal` will page looking for one commit — a thousand back, which
 *  is past anything a blame line realistically points at and short of walking a
 *  large repository end to end for a commit that is on another branch. */
const REVEAL_PAGES = 10;

/** The most commits the panel holds.
 *
 *  It is a window, not the history: `git log` on a large repository has twenty
 *  thousand commits in it, and holding them all costs the reader nothing but
 *  memory — the graph is a pass over every loaded commit, and a refresh re-reads
 *  the whole window because a rebase can rewrite any of it. Twenty pages is far
 *  past what anyone scrolls through looking for something; scoping the log to a
 *  path is how you go deeper, and the panel says so when the limit is reached. */
const MAX_LOADED = 2000;

/** How many commits of a fresh first page must match the top of what is loaded before the
 *  rest of the loaded list is trusted to be what it was. */
const MIN_OVERLAP = 10;

/** What the offsets assume an open commit's block is worth before it has been
 *  rendered once. Every open commit was clicked while it was on screen, so it is
 *  measured immediately; this is only what the very first paint of one uses. */
const DETAIL_GUESS = 200;

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
  /** `scope` marks a notice that describes a state rather than an event, so it
   *  can come down when that state passes — see notify.ts. */
  toast(message: string, isError?: boolean, scope?: string): void;
  afterChange(): void;
  /** List what differs between two commits. */
  compareCommits(a: Commit, b: Commit): void;
  /** The same, for two named refs — branches or tags. */
  compareRefs(left: string, right: string): void;
  /** Put text in the source-control message box and show it — used after a
   *  squash, which leaves the changes staged and the message to be written. */
  prefillCommitMessage(text: string): void;
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

/** A commit's searchable text, lower-cased once: every keystroke asks about every loaded commit,
 *  and building and lower-casing four fields for each of them each time was most of the cost. */
const hayCache = new WeakMap<Commit, string>();

function matches(c: Commit, f: Filter): boolean {
  let hay = hayCache.get(c);
  if (hay === undefined) {
    hay = `${c.subject} ${c.author} ${c.email} ${c.refs}`.toLowerCase();
    hayCache.set(c, hay);
  }
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
 *  Filtered here rather than with `--exclude=refs/stash` in the code-agent because
 *  the ref decoration identifies the stash exactly, and its extra parents are
 *  reachable only through it: no guessing, and no change to a protocol the Go
 *  code-agent would also have to grow.
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
  <div class="hist-view">
    <div class="hist-list js-list"></div>
    <div class="hist-note js-note" hidden></div>
  </div>
  <button class="t-btn hist-more js-more" type="button" hidden>load more</button>`;

export class HistoryPanel {
  private commits: Commit[] = [];
  /** Bumped whenever `commits` is replaced. What the lane map and the layout
   *  cache are keyed on, instead of a JSON fingerprint of every commit: the old
   *  key was rebuilt on every render, and a render happens on every watcher
   *  event. */
  private listVersion = 0;
  /** The rows on screen after the filter, which is what the list holds and what
   *  an anchor index is counted in. */
  private shown: Commit[] = [];
  /** How tall an open commit's block turned out to be, per commit. Measured from
   *  the rendered rows, because what an open commit holds — a wrapped message, a
   *  list of changed files — is what decides its height. */
  private readonly detailHeights = new Map<string, number>();
  /** The lane of each commit for the current log and graph toggle. */
  private lanesFor: { version: number; graph: boolean; byOid: Map<string, GraphRow | undefined> } | null = null;
  private readonly list: VirtualList<Commit>;
  /** The graph toggle, kept: `lanes()` is asked for a lane per row rendered, and
   *  a querySelector per row per paint is not worth the saved field. */
  private readonly graphToggle: HTMLInputElement;
  /** How many commits are loaded. Not a request size any more: "load more" asks
   *  for one page past this, and only a refresh re-reads the window. */
  private limit = PAGE;
  private loadingMore = false;
  /** Which question `commits` answers: the path and `--all`. A refresh may join a fresh first page
   *  to the loaded list only when the question is the same; another question has another list. */
  private loadedKey = "";
  /** The next refresh reads the whole window. Set by the reload button, whose job is to say that
   *  nothing already shown is to be believed. */
  private fullNext = false;
  /** Which `reveal` is current. A newer one, a new scope, a full reload: the older one stops paging. */
  private revealSeq = 0;
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
  /** Which parent a merge commit is being read against, per commit — so a
   *  refresh of the log does not silently put the list back to parent 1. */
  private parentChoice = new Map<string, number>();
  /** Why the log is not on screen, when the answer is not simply "there is
   *  none". Kept apart from `commits` because the two used to be conflated:
   *  any failure emptied the list, and an empty list says "No commits." */
  private failure: string | null = null;

  private readonly $: <T extends HTMLElement>(sel: string) => T;

  constructor(
    private readonly host: HTMLElement,
    private readonly codeAgent: CodeAgentClient,
    private readonly cb: HistoryCallbacks,
  ) {
    host.classList.add("hist");
    host.innerHTML = SHELL;
    this.$ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
    this.graphToggle = this.$<HTMLInputElement>(".js-graph");

    // The list is virtual: only the rows on screen exist, which is what makes a
    // window of two thousand commits cost the same as a window of fifty. Rows
    // are not all the same height here — an open commit is taller than the row
    // it opened from — so the list measures them as it renders them, and the
    // panel remembers what each open block turned out to be.
    this.list = new VirtualList<Commit>(this.$(".js-list"), ROW_H, (c) => this.commitHtml(c), {
      variable: {
        heightOf: (c) => ROW_H + (this.expanded.has(c.oid) ? (this.detailHeights.get(c.oid) ?? DETAIL_GUESS) : 0),
        measured: (c, _i, height) => {
          if (!this.expanded.has(c.oid)) return;
          const block = Math.max(0, height - ROW_H);
          if (this.detailHeights.get(c.oid) !== block) this.detailHeights.set(c.oid, block);
        },
      },
      // The gutter width cannot be a style="" attribute (style-src has no
      // 'unsafe-inline'), so it rides in data-lanes and is applied to the rows
      // once they exist — which, for a virtual list, is after every paint.
      afterRender: () => this.applyLaneWidths(),
    });

    this.$(".js-all").addEventListener("change", () => void this.refresh());
    this.$(".js-graph").addEventListener("change", () => this.render());
    this.$(".js-reload").addEventListener("click", () => {
      this.fullNext = true;
      void this.refresh();
    });
    this.$(".js-more").addEventListener("click", () => void this.loadMore());
    // Acting on the press. This list rebuilds itself whenever a commit's files
    // arrive and on every watcher event, and a rebuild between mousedown and
    // mouseup means the browser never reports a click at all — which is how
    // clicks here came to feel like they only worked sometimes.
    this.$(".js-list").addEventListener("pointerdown", (e) => void this.onPress(e as PointerEvent));
    this.$(".js-list").addEventListener("contextmenu", (e) => this.onContextMenu(e as MouseEvent));

    // The filter runs over what is already loaded, which is the point of doing it here rather
    // than sending every keystroke to `git log --grep`. It still walks every loaded commit and
    // draws the list, so it waits for a pause in the typing.
    const applyFilter = debounce(() => {
      this.filter = parseFilter(this.$<HTMLInputElement>(".js-filter").value);
      this.render();
    }, 120);
    this.$(".js-filter").addEventListener("input", () => applyFilter());
    this.$(".js-filter").addEventListener("keydown", (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key !== "Escape") return;
      applyFilter.cancel();
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
    this.render();
  }

  /** Show the history of one path only. */
  scopeTo(path: string | null): void {
    if (this.path === path) return;
    this.revealSeq++;
    this.path = path;
    this.limit = PAGE;
    this.expanded.clear();
    void this.refresh();
  }

  /** Open the panel on one commit: expand it and put it on screen. */
  async reveal(oid: string): Promise<void> {
    // Paging for a commit is work for the row that asked. Another click on a blame line, or a
    // change of what the panel shows, makes this one's answer worth nothing — it stops after the
    // page in flight rather than walking nine more.
    const seq = ++this.revealSeq;
    // A blame line can name a commit older than the loaded window, and landing
    // on "nothing here" would read as the click having failed. Paging forward
    // is what reaches it; before `skip` existed this raised a limit it then
    // compared against itself, and never loaded anything at all.
    //
    // Bounded, because the commit may simply not be on this branch — walking a
    // hundred thousand commits to discover that helps nobody.
    for (let pages = 0; pages < REVEAL_PAGES && seq === this.revealSeq && !this.commits.some((c) => c.oid === oid); pages++) {
      const before = this.commits.length;
      await this.loadMore();
      if (this.commits.length === before) break; // the log ended
    }
    if (seq !== this.revealSeq) return;
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
    this.render(oid);
    await this.loadDetail(oid);
    // The row may not be in the DOM yet — the list holds only what is on screen
    // — so it is the index, not a selector, that brings it into view.
    const at = this.shown.findIndex((c) => c.oid === oid);
    if (at >= 0) this.list.scrollToIndex(at);
  }

  /** One page of the log.
   *
   *  `skip` is why "load more" is a page rather than a bigger request: before
   *  it existed the panel raised its limit and re-asked for the whole window,
   *  so reaching the tenth page walked the first nine again — in git, over the
   *  socket, and through the parser — every time. */
  private page(limit: number, skip: number): Promise<Commit[]> {
    return this.codeAgent.call<Commit[]>("git.log", {
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
    // The window has to end somewhere: see MAX_LOADED. The button says so, so
    // this is only the guard behind it.
    if (this.commits.length >= MAX_LOADED) return this.showMore();
    this.loadingMore = true;
    const button = this.$<HTMLButtonElement>(".js-more");
    button.disabled = true;
    button.textContent = "loading…";
    try {
      const next = withoutStash(await this.page(Math.min(PAGE, MAX_LOADED - this.commits.length), this.commits.length));
      // Appending is only safe while the oids are still distinct; a concurrent
      // rewrite could hand back one already shown, and a duplicated row is a
      // worse answer than a missing one.
      const seen = new Set(this.commits.map((c) => c.oid));
      this.commits = [...this.commits, ...next.filter((c) => !seen.has(c.oid))];
      this.listVersion++;
      // `limit` is "how many were asked for", which is what render() compares
      // the list against to decide whether the button has anywhere left to go:
      // a short page means the log ended, so leave it one above what arrived.
      // A full page means there may be more, so leave the two equal.
      this.limit = this.commits.length + (next.length === PAGE ? 0 : 1);
      this.render();
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.loadingMore = false;
      button.disabled = false;
      this.showMore();
    }
  }

  /** Reload the history. Coalesced — one load in flight, one behind it — because
   *  every change under `.git` asks for it and it re-reads the whole window that
   *  is loaded. A caller still gets an answer from a load that began after it
   *  asked. */
  readonly refresh = singleFlight(() => this.load());

  private async load(): Promise<void> {
    if (this.codeAgent.state !== "online" || !this.codeAgent.info?.gitVersion) {
      this.commits = [];
      this.listVersion++;
      return this.render();
    }
    try {
      const key = JSON.stringify([this.path, this.path ? false : this.$<HTMLInputElement>(".js-all").checked]);
      const full = this.fullNext || key !== this.loadedKey || this.commits.length <= PAGE;
      this.fullNext = false;
      const joined = full ? null : await this.refreshHead();
      if (joined) {
        this.commits = joined;
      } else {
        // The whole loaded window: a rewritten history (a rebase, a reset) can change any of it, and
        // so can another question than the one that was loaded — and never more than the panel holds.
        this.commits = withoutStash(await this.page(Math.min(Math.max(this.limit, PAGE), MAX_LOADED), 0));
      }
      this.loadedKey = key;
      this.listVersion++;
      this.failure = null;
      // A commit's diff is immutable, but a rebase rewrites oids, so a stale
      // entry can only ever be unreachable — drop what is no longer listed.
      const live = new Set(this.commits.map((c) => c.oid));
      for (const oid of [...this.details.keys()]) if (!live.has(oid)) this.details.delete(oid);
      for (const oid of [...this.detailHeights.keys()]) if (!live.has(oid)) this.detailHeights.delete(oid);
    } catch (e) {
      this.commits = [];
      this.listVersion++;
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

  /** Read only the first page and join it to what is already loaded.
   *
   *  A refresh happens on every change under `.git`, and in the usual one — a commit, a pull, a
   *  checkout — what is new is at the top and the rest is what it was. Asking for the whole loaded
   *  window again (up to two thousand commits, over the socket, through git and the parser) to
   *  learn that was most of what a refresh cost once the reader had paged a few times.
   *
   *  The first page is fetched and looked for in the loaded list. If its older part is the top of
   *  that list, commit for commit, the new commits are put in front of the rest. If it is not — a
   *  rebase, a reset, a different branch — null is returned and the caller reads the window whole.
   *  What this does not refresh is a label on a commit further down (a tag or branch that moved
   *  there): the reload button reads the window whole for that. */
  private async refreshHead(): Promise<Commit[] | null> {
    const head = withoutStash(await this.page(PAGE, 0));
    const old = this.commits;
    if (!head.length) return null;
    const at = new Map(old.map((c, i) => [c.oid, i] as const));
    let joinAtHead = -1;
    let joinAtOld = -1;
    for (let j = 0; j < head.length; j++) {
      const i = at.get(head[j].oid);
      if (i !== undefined) {
        joinAtHead = j;
        joinAtOld = i;
        break;
      }
    }
    if (joinAtHead < 0) return null;
    const overlap = head.length - joinAtHead;
    for (let k = 0; k < overlap; k++) if (old[joinAtOld + k]?.oid !== head[joinAtHead + k].oid) return null;
    if (overlap < Math.min(MIN_OVERLAP, head.length)) return null;
    const merged = [...head.slice(0, joinAtHead), ...old.slice(joinAtOld)].slice(0, MAX_LOADED);
    // Keep `limit` meaning what it meant: a log that had ended still has one more than what is held.
    const ended = this.limit > old.length;
    this.limit = merged.length + (ended ? 1 : 0);
    return merged;
  }

  /** `anchorOid` is the commit the user just clicked. Expanding it, or
   *  collapsing whatever was open above it, changes the heights around it — so
   *  that row is pinned in place instead of the scroll offset.
   *
   *  What this no longer does is build the whole list: the rows are virtual, and
   *  this only tells the list what to show. The fingerprint that used to guard
   *  against redrawing an unchanged log was a JSON string over every loaded
   *  commit, rebuilt on every render — a render happens on every watcher event —
   *  so what remains of it is a cheap comparison of the panel's own state. */
  private render(anchorOid?: string): void {
    const list = this.$(".js-list");
    const note = this.$(".js-note");
    this.renderScope();
    this.renderCompareBar();
    if (!this.commits.length) {
      // The note lives outside the list: the list is a virtual one, and it owns
      // everything inside itself.
      list.hidden = true;
      note.hidden = false;
      note.innerHTML = this.failure
        ? `<div class="panel-error">
             <p class="panel-error-title">The history could not be loaded.</p>
             <pre>${esc(this.failure)}</pre>
             <button class="t-btn js-retry" type="button">try again</button>
           </div>`
        : `<p class="gp-empty">No commits.</p>`;
      note.querySelector(".js-retry")?.addEventListener("click", () => void this.refresh());
      this.$(".js-more").hidden = true;
      return;
    }
    if (!note.hidden) {
      note.hidden = true;
      note.replaceChildren();
      list.hidden = false;
    }

    // The filter hides rows; it must not renumber the graph, so the lanes are
    // computed over the whole log and the shown rows keep their own lane.
    const shown = this.filter ? this.commits.filter((c) => matches(c, this.filter!)) : this.commits;
    this.shown = shown;
    this.reportCount(shown.length);
    const anchor = anchorOid ? shown.findIndex((c) => c.oid === anchorOid) : -1;
    this.list.setItems(shown, anchor);
    this.showMore();
  }

  /** The lane of each commit, for the current log and graph toggle.
   *
   *  A filtered log is a list of separate commits, not a connected history:
   *  drawing lanes between rows with others hidden between them would join
   *  commits that are not parent and child. So the graph goes while filtering.
   *
   *  Cached, because it is one entry per loaded commit and a render happens on
   *  every watcher event. */
  private lanes(): Map<string, GraphRow | undefined> {
    const on = this.graphToggle.checked && !this.filter;
    if (this.lanesFor && this.lanesFor.version === this.listVersion && this.lanesFor.graph === on) return this.lanesFor.byOid;
    const graph = on ? computeGraph(this.commits) : [];
    const byOid = new Map<string, GraphRow | undefined>(this.commits.map((c, i) => [c.oid, graph[i]]));
    this.lanesFor = { version: this.listVersion, graph: on, byOid };
    return byOid;
  }

  /** The rows are in the DOM now, so the width the graph needs can be applied.
   *  A style="" attribute would have said it in the markup; style-src no longer
   *  admits one. */
  private applyLaneWidths(): void {
    for (const gutter of this.$(".js-list").querySelectorAll<HTMLElement>(".hist-gutter")) {
      gutter.style.width = `${Number(gutter.dataset.lanes) * LANE_W}px`;
    }
  }

  /** Whether there is anywhere left to go, and what to say when there is not. */
  private showMore(): void {
    const button = this.$<HTMLButtonElement>(".js-more");
    if (this.commits.length >= MAX_LOADED) {
      button.hidden = false;
      button.disabled = true;
      button.textContent = `${MAX_LOADED.toLocaleString("en-US")} commits loaded — the panel stops here. Scope the history to a path to go deeper.`;
      return;
    }
    button.disabled = false;
    button.textContent = "load more";
    button.hidden = this.commits.length < this.limit;
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

  private async loadDetail(oid: string, parent?: number): Promise<void> {
    // A parent asked for explicitly re-reads, because the answer is different.
    if (this.details.has(oid) && parent === undefined) return;
    const side = parent ?? this.parentChoice.get(oid) ?? 1;
    try {
      this.details.set(oid, await this.codeAgent.call<CommitDetail>("git.commitDetail", { oid, parent: side }));
      this.parentChoice.set(oid, side);
    } catch (err) {
      this.cb.toast(err instanceof Error ? err.message : String(err), true);
    }
    // The file list replaces "loading…" and the block grows; the commit row
    // itself must not move while that happens.
    if (this.expanded.has(oid)) this.render(oid);
  }

  private commitHtml(c: Commit): string {
    const open = this.expanded.has(c.oid);
    const detail = this.details.get(c.oid);
    const row = this.lanes().get(c.oid);
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
    // A merge has two answers to "what changed here", and the panel used to
    // give only the first one without saying so. Against the first parent the
    // list is what the merge brought into the branch; against the second it is
    // what the branch looked like from the other side — the question a release
    // merge is normally opened for.
    const sides =
      c.parents.length > 1
        ? `<div class="hist-parents">
             <span class="hist-parents-label">merge of ${c.parents.length} parents — showing changes against</span>
             ${c.parents
               .map(
                 (p, i) =>
                   `<button type="button" class="hist-parent${(detail.parent ?? 1) === i + 1 ? " active" : ""}"
                      data-parent="${i + 1}" data-oid="${esc(c.oid)}"
                      title="${esc(`Diff this merge against parent ${i + 1} (${p.slice(0, 8)})`)}">${
                     i === 0 ? "parent 1 · the branch merged into" : `parent ${i + 1} · the branch merged in`
                   }</button>`,
               )
               .join("")}
           </div>`
        : "";
    return `<div class="hist-files">${gutter}<div class="hist-files-body">
      ${who}
      ${body ? `<pre class="hist-body">${esc(body)}</pre>` : ""}
      ${sides}
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

    // Switching which parent a merge is diffed against.
    const side = target.closest<HTMLElement>(".hist-parent");
    if (side) {
      const want = Number(side.dataset.parent);
      if (want !== (this.details.get(oid)?.parent ?? 1)) await this.loadDetail(oid, want);
      return;
    }

    const file = target.closest<HTMLElement>(".hist-file");
    if (file) {
      // For a merge, name both ends: the file's own `<oid>^` is parent 1
      // whichever side the list is currently showing.
      const commit = this.commits.find((x) => x.oid === oid);
      const parent = this.details.get(oid)?.parent ?? 1;
      const kind =
        commit && commit.parents.length > 1 ? `${commit.parents[parent - 1]}..${oid}` : oid;
      return this.cb.openDiff(file.dataset.path!, kind, this.about(oid));
    }

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

    // Right-clicking the branch or tag chip asks about that ref, not about the
    // commit underneath it: "what is on release/1.1.0 that is not on main" is a
    // question about two names, and answering it by hunting for both tips in
    // the graph is how it had to be done before.
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".hist-ref");
    const refName = chip?.dataset.ref;
    if (refName) {
      items.push({
        label: `Compare ${refName} with…`,
        separated: true,
        run: () => void this.compareRefWith(refName),
      });
    }

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
      // Tidying up your own commits before they go anywhere. `git rebase -i` is
      // the usual home for this, and it needs an interactive editor the browser
      // has no way to provide — so the two operations people actually reach for
      // are offered directly, built out of commands that need no editor at all.
      {
        label: "Reword this commit…",
        separated: true,
        disabled: this.commits[0]?.oid !== oid,
        run: () => void this.reword(oid),
      },
      { label: "Squash the commits from here to the tip…", run: () => void this.squashToHere(oid) },
      { label: "Checkout this commit", separated: true, run: () => void this.run("git.checkout", { ref: oid }, `checked out ${short} (detached)`) },
      ["Create branch here…", () => void this.branchHere(oid)],
      ["Revert this commit", () => void this.run("git.revert", { oid }, `reverted ${short}`)],
      ["Cherry-pick onto current", () => void this.run("git.cherryPick", { oid }, `cherry-picked ${short}`)],
      ["Reset — keep changes staged (soft)", () => void this.reset(oid, "soft")],
      ["Reset — keep changes (mixed)", () => void this.reset(oid, "mixed")],
      ["Reset — discard changes (hard)", () => void this.reset(oid, "hard")],
    ]);
  }

  /** Change the message of the newest commit.
   *
   *  Only the newest: that one is `git commit --amend`, which needs nothing but
   *  a message. Rewording an older commit is `git rebase -i`, which needs an
   *  editor this page cannot give it — so the item is shown greyed on older
   *  commits rather than missing, because "why can I not rename this one" is a
   *  question worth answering in the menu.
   */
  private async reword(oid: string): Promise<void> {
    const current = this.commits.find((c) => c.oid === oid);
    const message = await modalPrompt({
      title: "Reword the last commit",
      hint: "Replaces the commit, so its hash changes. If it has been pushed, the remote will need a force-push.",
      value: current?.subject ?? "",
      okLabel: "reword",
    });
    if (!message || message === current?.subject) return;
    await this.run("git.commit", { message, amend: true }, `reworded ${oid.slice(0, 7)}`);
  }

  /** Fold every commit from this one up to the tip into a single commit.
   *
   *  `git reset --soft <parent>` plus a commit: the same result as an
   *  interactive rebase whose entries are all `squash`, reached without a todo
   *  file. The changes are left staged and the message box is filled with the
   *  subjects being folded together; the commit itself is the user's press, so
   *  there is a step between "I meant to tidy up" and a rewritten branch.
   */
  private async squashToHere(oid: string): Promise<void> {
    const short = oid.slice(0, 7);
    let range: Commit[];
    try {
      range = await this.codeAgent.call<Commit[]>("git.log", { ref: `${oid}~1..HEAD`, limit: 200 });
    } catch {
      // No parent — this is the root commit, and there is nothing to reset to.
      this.cb.toast(`${short} has no parent, so there is nothing to squash it into.`, true);
      return;
    }
    if (!range.some((c) => c.oid === oid)) {
      this.cb.toast(`${short} is not on the current branch — switch to a branch that contains it first.`, true);
      return;
    }
    if (range.length < 2) {
      this.cb.toast(`${short} is already the only commit here — nothing to squash.`, true);
      return;
    }

    // Anything already on the upstream is history other people may have. The
    // status knows how far ahead the branch is; beyond that point, squashing
    // rewrites commits that have been published.
    const st = await this.codeAgent.call<GitStatus>("git.status").catch(() => null);
    const published = st?.upstream ? Math.max(0, range.length - (st.ahead ?? 0)) : 0;
    const dirty = (st?.entries ?? []).filter((e) => !e.untracked && !e.ignored).length;

    const ok = await modalConfirm({
      title: `Squash ${range.length} commits into one?`,
      detail: [
        `Everything from ${short} to the tip of ${st?.branch ?? "this branch"} becomes a single commit.`,
        "The changes are staged for you and the message box is filled in — nothing is committed until you press commit.",
        dirty ? `${dirty} uncommitted change${dirty === 1 ? "" : "s"} in the working tree will be staged along with them.` : "",
        published
          ? `${published} of these commits ${published === 1 ? "is" : "are"} already on ${st?.upstream} — squashing them rewrites history others may have pulled.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      okLabel: "squash",
      danger: published > 0,
    });
    if (!ok) return;

    try {
      await this.codeAgent.call("git.reset", { oid: `${oid}~1`, mode: "soft" });
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
      return;
    }
    // Oldest first, so the folded message reads in the order the work happened.
    const subjects = [...range].reverse().map((c) => c.subject);
    this.cb.prefillCommitMessage([subjects[0], "", ...subjects.slice(1).map((s) => `* ${s}`)].join("\n"));
    this.cb.toast(`${range.length} commits staged as one — write the message and commit`);
    await this.refresh();
    this.cb.afterChange();
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

  /** Pick the other side of a ref comparison.
   *
   *  The branch list is fetched here rather than held on the panel: it is one
   *  call, made when a menu item is chosen, and a copy kept up to date through
   *  every checkout and fetch for the sake of one menu would be the wrong
   *  trade. */
  private async compareRefWith(left: string): Promise<void> {
    try {
      const list = await this.codeAgent.call<BranchList>("git.branches");
      const right = await pickRef({
        title: `Compare ${left} with which ref?`,
        hint: "Lists what is on each side that is not on the other.",
        refs: list.refs,
        current: left,
        excludeCurrent: true,
        okLabel: "compare",
      });
      if (right) this.cb.compareRefs(left, right);
    } catch (e) {
      this.cb.toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  private async run(op: string, params: Record<string, unknown>, okMessage: string): Promise<void> {
    try {
      await this.codeAgent.call(op, params);
      this.cb.toast(okMessage);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A cherry-pick or revert that stops on a conflict leaves the repository
      // in a state the source-control banner now owns; this notice describes
      // that state, so it is tagged to come down with it rather than sit there
      // red once the conflict has been dealt with.
      const stopped = /conflict|could not apply|after resolving/i.test(message);
      this.cb.toast(message, true, stopped ? OP_SCOPE : undefined);
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
      // The bare name — no "tag: ", no "HEAD -> " — is what git takes as a ref,
      // and what the context menu compares against.
      return `<span class="hist-ref ref-${kind} ref-w${Math.min(label.length, 12) + (kind === "tag" ? 3 : 0)}" data-ref="${esc(label)}" title="${esc(r)}">${mark}<span class="hist-ref-name">${esc(startTrimmed(label))}</span></span>`;
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
