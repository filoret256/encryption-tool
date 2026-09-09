/** Fixed-height virtual list.
 *
 *  Search across a large project routinely returns thousands of rows; putting
 *  them all in the DOM is what makes such a panel feel broken. Constant row
 *  height is the only assumption, and it makes the whole thing arithmetic.
 */

const OVERSCAN = 8;

export class VirtualList<T> {
  private items: T[] = [];
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly layer: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly rowHeight: number,
    private readonly renderRow: (item: T, index: number) => string,
  ) {
    host.classList.add("vlist");
    host.innerHTML = `<div class="vlist-viewport"><div class="vlist-spacer"></div><div class="vlist-layer"></div></div>`;
    this.viewport = host.querySelector(".vlist-viewport")!;
    this.spacer = host.querySelector(".vlist-spacer")!;
    this.layer = host.querySelector(".vlist-layer")!;
    this.viewport.addEventListener("scroll", () => this.paint(), { passive: true });
    new ResizeObserver(() => this.paint()).observe(this.viewport);
  }

  setItems(items: T[]): void {
    this.items = items;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    this.paint();
  }

  /** Repaint in place — used when row content changes but the list does not. */
  refresh(): void {
    this.paint();
  }

  scrollToTop(): void {
    this.viewport.scrollTop = 0;
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

  private paint(): void {
    const count = Math.ceil(this.viewport.clientHeight / this.rowHeight) + OVERSCAN * 2;
    const first = Math.max(0, Math.floor(this.viewport.scrollTop / this.rowHeight) - OVERSCAN);
    const slice = this.items.slice(first, first + count);

    this.layer.style.transform = `translateY(${first * this.rowHeight}px)`;
    this.layer.innerHTML = slice
      .map(
        (item, k) =>
          `<div class="vlist-row" data-i="${first + k}" style="height:${this.rowHeight}px">${this.renderRow(item, first + k)}</div>`,
      )
      .join("");
  }
}
