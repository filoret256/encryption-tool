/** Virtual list: only the rows on screen are in the DOM.
 *
 *  Search across a large project routinely returns thousands of rows; putting
 *  them all in the DOM is what makes such a panel feel broken. Every row is the
 *  same height by default, which makes the whole thing arithmetic.
 *
 *  A list whose rows are not all the same height — the commit history, where an
 *  open commit is taller than the row it opened from — passes `variable`. Then
 *  the offsets come from a running total instead of from multiplication, and the
 *  heights are read back from the rows as they are rendered: a row's content is
 *  what decides how tall it is, and measuring it is the only honest answer. A
 *  row outside the window keeps the height it had the last time it was
 *  rendered, which is exact for every row the reader has looked at.
 */

const OVERSCAN = 8;

/** Rows whose height is not the same as their neighbours'. */
export interface VariableRows<T> {
  /** The height this row is laid out at, as last known. */
  heightOf(item: T, index: number): number;
  /** What a row turned out to be, measured after it was rendered. */
  measured(item: T, index: number, height: number): void;
}

export interface ListOptions<T> {
  /** Present when the rows are not all the same height. */
  variable?: VariableRows<T>;
  /** How many rows beyond the edge of the screen are kept drawn, on each side. Eight is for rows a
   *  line tall; a list whose rows can each be hundreds of lines pays for every one of them. */
  overscan?: number;
  /** Run once the rows are in the DOM, for anything that has to be applied to
   *  them after they exist — a width that cannot ride in a style="" attribute,
   *  which style-src no longer admits. */
  afterRender?: () => void;
}

/** Call `onResize` when `el` changes size. The observer lets itself go when `el`
 *  has left the document — removing an element is a resize, to nothing — so a tab
 *  that replaces its markup does not leave the old observers behind. Returns the
 *  disconnect, for an owner that tears down on purpose. */
export function observeSize(el: HTMLElement, onResize: () => void): () => void {
  const observer = new ResizeObserver(() => {
    if (!el.isConnected) return observer.disconnect();
    onResize();
  });
  observer.observe(el);
  return () => observer.disconnect();
}

/** A pool of row elements, reused between paints.
 *
 *  Painting used to replace the visible slice with `innerHTML`: every scroll
 *  event created, parsed and destroyed every row on screen, and several events
 *  in one frame did it several times over. Rows are elements and can be kept, so
 *  they are.
 *
 *  `window` also moves them: a scroll by one row rotates the pool by one, so the
 *  rows that keep their place keep their content, and only the row that came
 *  into view is built. A jump too far to rotate falls back to rebuilding all of
 *  them, which is what the content check does anyway.
 *
 *  `schedule` is the other half. A wheel, a drag or a held arrow key delivers
 *  several scroll events per frame, and only the last position is worth
 *  drawing: one paint per frame, always. */
export class RowPool {
  private rows: HTMLElement[] = [];
  private frame = 0;
  /** The item index the first pooled row holds. */
  private start = 0;

  constructor(private readonly layer: HTMLElement) {}

  /** Paint once, on the next frame. */
  schedule(paint: () => void): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      paint();
    });
  }

  /** Drop a scheduled paint — a paint happening now makes it stale. */
  cancel(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** The rows for `[from, from + count)`, in the layer, in order. `build` is
   *  called only for a row that is not already showing that index, or for every
   *  row when `all` is set. */
  window(from: number, count: number, build: (row: HTMLElement, index: number) => void, all = false): HTMLElement[] {
    const rows = this.take(count);
    const delta = from - this.start;
    if (delta > 0 && delta < rows.length) {
      const moved = rows.splice(0, delta);
      rows.push(...moved);
      for (const row of moved) this.layer.appendChild(row);
    } else if (delta < 0 && -delta < rows.length) {
      const moved = rows.splice(rows.length + delta, -delta);
      rows.unshift(...moved);
      // In one call: inserting them one by one before the first child put them
      // in reverse, and the DOM no longer matched `rows` — a scroll up by more
      // than one row left the list drawn upside down until it was cleared.
      this.layer.prepend(...moved);
    } else if (delta !== 0) {
      // Too far to rotate: every row is about to be rebuilt anyway.
      all = true;
    }
    this.start = from;
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k]!;
      const index = from + k;
      if (!all && row.dataset.i === String(index)) continue;
      build(row, index);
      row.dataset.i = String(index);
    }
    return rows;
  }

  /** Empty the layer. */
  clear(): void {
    for (const row of this.rows) row.remove();
    this.rows = [];
    this.start = 0;
  }

  private take(count: number): HTMLElement[] {
    while (this.rows.length < count) {
      const row = document.createElement("div");
      this.layer.appendChild(row);
      this.rows.push(row);
    }
    while (this.rows.length > count) this.rows.pop()!.remove();
    return this.rows;
  }
}

export class VirtualList<T> {
  private items: T[] = [];
  /** Where each row starts, and where the last one ends. Empty while every row
   *  is the same height and the arithmetic is a multiplication. */
  private offsets: number[] = [];
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly pool: RowPool;
  private readonly variable?: VariableRows<T>;
  private readonly afterRender?: () => void;
  private readonly overscan: number;
  /** The content of the rows changed without the list changing — a filter, a
   *  detail that arrived. Every pooled row is rebuilt on the next paint. */
  private stale = true;
  private paintedFrom = -1;
  private paintedCount = -1;

  constructor(
    host: HTMLElement,
    private readonly rowHeight: number,
    private readonly renderRow: (item: T, index: number) => string,
    options: ListOptions<T> = {},
  ) {
    this.variable = options.variable;
    this.afterRender = options.afterRender;
    this.overscan = options.overscan ?? OVERSCAN;
    host.classList.add("vlist");
    // The stylesheet needs to know: a row of its own height is positioned and
    // sized differently from one that shares --vlist-row-h with its neighbours.
    if (this.variable) host.classList.add("vlist-var");
    host.innerHTML = `<div class="vlist-viewport"><div class="vlist-spacer"></div><div class="vlist-layer"></div></div>`;
    this.viewport = host.querySelector(".vlist-viewport")!;
    this.spacer = host.querySelector(".vlist-spacer")!;
    this.layer = host.querySelector(".vlist-layer")!;
    this.pool = new RowPool(this.layer);
    // Every row is the same height, so it rides on the layer as a custom
    // property instead of a style="" attribute per row — which style-src no
    // longer admits. Styles assigned from script are not restricted at all.
    this.layer.style.setProperty("--vlist-row-h", `${rowHeight}px`);
    // Both of these fire several times per frame while the reader scrolls; the
    // pool is what makes that one paint.
    this.viewport.addEventListener("scroll", () => this.pool.schedule(() => this.paint()), { passive: true });
    this.stopObserving = observeSize(this.viewport, () => this.pool.schedule(() => this.paint()));
  }

  private readonly stopObserving: () => void;

  /** Stop watching the size. The scroll and click listeners sit on the viewport,
   *  which goes with the list. */
  dispose(): void {
    this.stopObserving();
  }

  /** Replace the rows. `anchorIndex` is the row the reader just acted on: it is
   *  held where it is on screen, because what an expansion changes is the height
   *  of everything below it, not the scroll offset. */
  setItems(items: T[], anchorIndex = -1): void {
    const anchor = this.anchorTop(anchorIndex);
    this.items = items;
    this.stale = true;
    this.measure();
    this.draw();
    this.holdAnchor(anchorIndex, anchor);
  }

  /** Repaint in place — used when row content changes but the list does not. */
  refresh(anchorIndex = -1): void {
    const anchor = this.anchorTop(anchorIndex);
    this.stale = true;
    this.draw();
    this.holdAnchor(anchorIndex, anchor);
  }

  /** Scroll by the least that brings a row into view, and paint it: the row may not
   *  be in the DOM yet, and a keyboard cursor has to land on something that exists. */
  scrollToIndex(index: number): void {
    const top = this.topOf(index);
    const bottom = index + 1 <= this.items.length ? this.topOf(index + 1) : top + this.rowHeight;
    const v = this.viewport;
    if (top < v.scrollTop) v.scrollTop = top;
    else if (bottom > v.scrollTop + v.clientHeight) v.scrollTop = bottom - v.clientHeight;
    this.draw();
  }

  scrollToTop(): void {
    this.viewport.scrollTop = 0;
    this.draw();
  }

  /** Click handler receiving the item the row was built from. */
  onClick(cb: (item: T, index: number, target: HTMLElement, ev: MouseEvent) => void): void {
    this.viewport.addEventListener("click", (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>(".vlist-row");
      if (!row) return;
      const i = Number(row.dataset.i);
      const item = this.items[i];
      if (item !== undefined) cb(item, i, ev.target as HTMLElement, ev);
    });
  }

  private topOf(index: number): number {
    return this.offsets.length ? (this.offsets[index] ?? 0) : index * this.rowHeight;
  }

  private anchorTop(index: number): number | undefined {
    if (index < 0) return undefined;
    return this.layer.querySelector<HTMLElement>(`.vlist-row[data-i="${index}"]`)?.getBoundingClientRect().top;
  }

  private holdAnchor(index: number, before: number | undefined): void {
    if (index < 0 || before === undefined) return;
    const after = this.anchorTop(index);
    if (after === undefined) return;
    if (after !== before) this.viewport.scrollTop += after - before;
  }

  /** Turn the per-row heights into offsets. */
  private measure(): void {
    if (!this.variable) {
      this.offsets = [];
      this.spacer.style.height = `${this.items.length * this.rowHeight}px`;
      return;
    }
    const offsets = new Array<number>(this.items.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < this.items.length; i++) {
      offsets[i + 1] = offsets[i]! + Math.max(1, this.variable.heightOf(this.items[i]!, i));
    }
    this.offsets = offsets;
    this.spacer.style.height = `${offsets[this.items.length]!}px`;
  }

  /** The last row that starts at or above `top`. */
  private firstVisible(top: number): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.offsets[mid + 1] ?? 0) <= top) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, this.items.length - 1);
  }

  /** Draw now, whatever the frame clock says: what a caller has just changed is
   *  expected to be on screen when it asks for it. */
  private draw(): void {
    this.pool.cancel();
    this.paint();
  }

  private paint(): void {
    const height = this.viewport.clientHeight || this.rowHeight * 10;
    const top = this.viewport.scrollTop;
    const stale = this.stale;
    this.stale = false;

    if (!this.variable) {
      const count = Math.ceil(height / this.rowHeight) + this.overscan * 2;
      const first = Math.max(0, Math.floor(top / this.rowHeight) - this.overscan);
      const to = Math.min(this.items.length, first + count);
      // Nothing moved and nothing changed: a scroll of a few pixels inside one
      // row costs nothing at all.
      if (!stale && first === this.paintedFrom && to - first === this.paintedCount) return;
      this.paintedFrom = first;
      this.paintedCount = to - first;
      this.layer.style.transform = `translateY(${first * this.rowHeight}px)`;
      this.pool.window(
        first,
        to - first,
        (row, i) => {
          row.className = "vlist-row";
          row.innerHTML = this.renderRow(this.items[i]!, i);
        },
        stale,
      );
      this.afterRender?.();
      return;
    }

    const first = this.items.length ? this.firstVisible(top) : 0;
    let last = first;
    while (last < this.items.length && (this.offsets[last] ?? 0) < top + height) last++;
    const from = Math.max(0, first - this.overscan);
    const to = Math.min(this.items.length, last + this.overscan);
    if (!stale && from === this.paintedFrom && to - from === this.paintedCount) return;
    this.paintedFrom = from;
    this.paintedCount = to - from;
    // Rows carry their own offset, so the layer's transform has nothing left to
    // do — and a transform here would move every measurement below it.
    this.layer.style.transform = "none";
    const rows = this.pool.window(
      from,
      to - from,
      (row, i) => {
        row.className = "vlist-row";
        row.innerHTML = this.renderRow(this.items[i]!, i);
      },
      stale,
    );
    this.afterRender?.();

    // One read of the whole batch, then one write: reading each row's height
    // after the content above lays everything out once, and the rows are then
    // placed from what they turned out to be rather than from what was
    // predicted. A row that is not on screen keeps its last measured height, so
    // the list only ever gets more accurate as the reader scrolls.
    let changed = false;
    for (const row of rows) {
      const i = Number(row.dataset.i);
      const h = row.offsetHeight;
      const was = (this.offsets[i + 1] ?? 0) - (this.offsets[i] ?? 0);
      this.variable.measured(this.items[i]!, i, h);
      if (h !== was) changed = true;
    }
    if (changed) this.measure();
    for (const row of rows) row.style.top = `${this.offsets[Number(row.dataset.i)] ?? 0}px`;
  }
}
