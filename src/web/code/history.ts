/** Commit history: the log, per-commit file lists, and the commit context menu.
 *
 *  Loading is capped and extended on demand — `git log` on a large repository
 *  is fast, but shipping 50k commits through the socket and into the DOM is not.
 */
import type { AgentClient } from "./agent.ts";
import type { Commit, CommitDetail } from "../../agent/protocol.ts";
import { esc, modalConfirm, modalPrompt, setHtmlKeepingScroll, showMenu } from "./ui.ts";
import { computeGraph, continuationSvg, laneSvg, LANE_W, type GraphRow } from "./graph.ts";
import { iconRefresh } from "./icons.ts";

const PAGE = 100;

export interface HistoryCallbacks {
  openDiff(path: string, kind: string): void;
  toast(message: string, isError?: boolean): void;
  afterChange(): void;
}

const SHELL = `
  <div class="hist-head">
    <label class="hist-toggle"><input type="checkbox" class="js-all" checked /> all branches</label>
    <label class="hist-toggle"><input type="checkbox" class="js-graph" checked /> graph</label>
    <span class="t-spacer"></span>
    <button class="t-icon js-reload" type="button" title="Reload">${iconRefresh}</button>
  </div>
  <div class="hist-list js-list"></div>
  <button class="t-btn hist-more js-more" type="button" hidden>load more</button>`;

export class HistoryPanel {
  private commits: Commit[] = [];
  private graph: GraphRow[] = [];
  private limit = PAGE;
  private expanded: string | null = null;
  private details = new Map<string, CommitDetail>();
  /** Fingerprint of what is currently on screen; an unchanged log is not
   *  redrawn, so a click is never dropped because the row it landed on was
   *  replaced underneath it. */
  private renderedKey = "";

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
    this.$(".js-more").addEventListener("click", () => {
      this.limit += PAGE;
      void this.refresh();
    });
    // Acting on the press. This list rebuilds itself whenever a commit's files
    // arrive and on every watcher event, and a rebuild between mousedown and
    // mouseup means the browser never reports a click at all — which is how
    // clicks here came to feel like they only worked sometimes.
    this.$(".js-list").addEventListener("pointerdown", (e) => void this.onPress(e as PointerEvent));
    this.$(".js-list").addEventListener("contextmenu", (e) => this.onContextMenu(e as MouseEvent));
  }

  async refresh(): Promise<void> {
    if (this.agent.state !== "online" || !this.agent.info?.gitVersion) {
      this.commits = [];
      return this.render();
    }
    try {
      this.commits = await this.agent.call<Commit[]>("git.log", {
        limit: this.limit,
        all: this.$<HTMLInputElement>(".js-all").checked,
      });
      // A commit's diff is immutable, but a rebase rewrites oids, so a stale
      // entry can only ever be unreachable — drop what is no longer listed.
      const live = new Set(this.commits.map((c) => c.oid));
      for (const oid of [...this.details.keys()]) if (!live.has(oid)) this.details.delete(oid);
    } catch (e) {
      this.commits = [];
      if (!/not a git repository|does not have any commits/i.test(String(e))) {
        this.cb.toast(e instanceof Error ? e.message : String(e), true);
      }
    }
    this.render();
  }

  /** `anchorOid` is the commit the user just clicked. Expanding it, or
   *  collapsing whatever was open above it, changes the heights around it — so
   *  that row is pinned in place instead of the scroll offset. */
  private render(anchorOid?: string): void {
    const list = this.$(".js-list");
    if (!this.commits.length) {
      list.innerHTML = `<p class="gp-empty">No commits.</p>`;
      this.$(".js-more").hidden = true;
      return;
    }
    // The layout depends only on the commit list, so it is recomputed here
    // rather than in refresh() — the graph toggle re-renders without refetching.
    const withGraph = this.$<HTMLInputElement>(".js-graph").checked;
    const key = JSON.stringify([
      this.commits.map((c) => [c.oid, c.refs, c.subject]),
      this.expanded,
      this.expanded ? Boolean(this.details.get(this.expanded)) : null,
      withGraph,
    ]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    this.graph = withGraph ? computeGraph(this.commits) : [];
    setHtmlKeepingScroll(
      list,
      this.commits.map((c, i) => this.commitHtml(c, this.graph[i])).join(""),
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

  private commitHtml(c: Commit, row: GraphRow | undefined): string {
    const open = this.expanded === c.oid;
    const detail = this.details.get(c.oid);
    return `<div class="hist-item${open ? " open" : ""}" data-oid="${esc(c.oid)}">
      <div class="hist-row">
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
      ${open ? this.detailHtml(detail, row) : ""}
    </div>`;
  }

  private detailHtml(detail: CommitDetail | undefined, row: GraphRow | undefined): string {
    // The lanes continue alongside the expanded block so the graph is not cut
    // in half by opening a commit.
    // The gutter carries an explicit width and holds the SVG absolutely, so the
    // lanes stretch to whatever height the file list needs. Left in flow, an
    // <svg height="100%"> with no definite parent height falls back to its
    // intrinsic 150px and padded the block out with dead space.
    const gutter = row
      ? `<div class="hist-gutter" data-lanes="${row.columns}">${continuationSvg(row)}</div>`
      : "";
    if (!detail) return `<div class="hist-files">${gutter}<div class="hist-files-body"><span class="gp-empty">loading…</span></div></div>`;

    const body = detail.body.trim();
    return `<div class="hist-files">${gutter}<div class="hist-files-body">
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
    if (file) return this.cb.openDiff(file.dataset.path!, oid);

    // Only the header row toggles. The block below it is content to read, and
    // treating any click inside it as a toggle meant a click that missed a file
    // name collapsed the commit — which reads as the panel closing at random.
    if (!target.closest(".hist-row")) return;

    this.expanded = this.expanded === oid ? null : oid;
    this.render(oid);
    if (this.expanded && !this.details.has(oid)) {
      try {
        this.details.set(oid, await this.agent.call<CommitDetail>("git.commitDetail", { oid }));
      } catch (err) {
        this.cb.toast(err instanceof Error ? err.message : String(err), true);
      }
      // The file list replaces "loading…" and the block grows; the commit row
      // itself must not move while that happens.
      if (this.expanded === oid) this.render(oid);
    }
  }

  private onContextMenu(e: MouseEvent): void {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".hist-item");
    if (!item) return;
    e.preventDefault();
    const oid = item.dataset.oid!;
    const short = oid.slice(0, 7);

    showMenu(e.clientX, e.clientY, [
      ["Copy SHA", () => void navigator.clipboard?.writeText(oid)],
      ["Checkout this commit", () => void this.run("git.checkout", { ref: oid }, `checked out ${short} (detached)`)],
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
      const label = r.replace(/^tag: /, "");
      // A pill truncates when the panel is narrow and several refs land on one
      // commit, which is exactly when knowing the full name matters most.
      return `<span class="hist-ref ref-${kind}" title="${esc(label)}">${esc(label)}</span>`;
    });
  return `<span class="hist-refs">${chips.join("")}</span>`;
}

const shortName = (author: string): string => author.split(/\s+/)[0] ?? author;

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
