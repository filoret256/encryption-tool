/** Small DOM helpers shared by the code tab: escaping, context menu, modal
 *  prompt. `window.prompt` is unavailable in an installed PWA window, so the
 *  modal is not a stylistic choice. */

/** Escape a value for HTML — text content and attribute values alike.
 *
 *  All five characters, not the three that text nodes strictly need. There used
 *  to be two functions here, `esc` for text and `attr` for attributes, and the
 *  wrong one kept getting picked: `title="${esc(path)}"` appeared in four
 *  separate panels, and a file path is the most attacker-influenceable string
 *  in this app — a repository can be cloned with a file named
 *  `" onmouseover=… x="` and the editor will happily list it.
 *
 *  Splitting by context was the mistake. An entity decodes identically in both
 *  places, so escaping quotes in text costs nothing but a few bytes, while a
 *  single escaper cannot be applied in the wrong place. The apostrophe is here
 *  for the same reason: single-quoted attributes are legal HTML, and the next
 *  person to write one should not have to know that this function assumed
 *  double quotes.
 */
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/** The height of one row in every list the code tab draws, in pixels.
 *
 *  Four places need this number and three of them are arithmetic, not styling:
 *  the explorer and the search results size a virtual-scroll spacer by it, and
 *  the history graph draws its lanes on a canvas exactly this tall. A row whose
 *  CSS height disagrees with the number used to place it does not look wrong —
 *  it drifts, a pixel per row, until the rows and what is drawn beside them are
 *  visibly out of step.
 *
 *  It was duplicated in all four, and the history had drifted to 26 while the
 *  rest stayed at 22. So it is stated here and pushed into CSS by applyRowHeight
 *  below, rather than written down again in the stylesheet and hoped about. */
export const ROW_H = 22;

/** Publish ROW_H to CSS as --row. Called once, when the code tab mounts; the
 *  stylesheet carries the same value as its own default, so the tab still looks
 *  right in the moment before the code chunk has finished loading. */
export function applyRowHeight(): void {
  document.documentElement.style.setProperty("--row", `${ROW_H}px`);
}

/** Replace a scrollable container's contents without throwing the reader back
 *  to the top.
 *
 *  Assigning innerHTML resets scrollTop. In a list you click through — commits,
 *  changed files — that means the row you just clicked jumps off screen, which
 *  reads as "the click did nothing"; you click again, now on whatever moved
 *  under the cursor. Panels that rebuild themselves in place must not do that.
 *
 *  Pass `anchor` — a selector for the row the user just acted on — when the
 *  rebuild changes heights above it. Holding that row still is what people
 *  actually perceive as "nothing moved"; holding scrollTop is not, because
 *  collapsing a long block higher up shifts everything under the cursor.
 */
export function setHtmlKeepingScroll(el: HTMLElement, html: string, anchor?: string): void {
  const anchorTop = anchor ? el.querySelector(anchor)?.getBoundingClientRect().top : undefined;
  const { scrollTop, scrollLeft } = el;

  el.innerHTML = html;

  // Reading a layout property first. Straight after an innerHTML assignment the
  // new content has not been laid out, so scrollHeight is still 0 and any
  // scrollTop we assign is clamped to 0 — the very jump this exists to prevent.
  void el.scrollHeight;
  if (scrollTop) el.scrollTop = scrollTop;
  if (scrollLeft) el.scrollLeft = scrollLeft;

  if (anchorTop !== undefined) {
    const movedTo = el.querySelector(anchor!)?.getBoundingClientRect().top;
    if (movedTo !== undefined) el.scrollTop += movedTo - anchorTop;
  }
}

/** One floating menu at a time, reused for every right-click. */
export function showMenu(x: number, y: number, items: [string, () => void][]): void {
  document.querySelector(".ctx-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  for (const [label, action] of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => {
      menu.remove();
      action();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  // Keep it on screen when opened near the right or bottom edge.
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = `${innerWidth - r.width - 4}px`;
  if (r.bottom > innerHeight) menu.style.top = `${innerHeight - r.height - 4}px`;
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }));
}

export interface ConfirmOptions {
  /** The question. Shown at reading size, not as a field label — it is the one
   *  thing in the dialog the user has to actually read. */
  title: string;
  /** The consequence, spelled out. "This cannot be undone" belongs here, as
   *  does the count of what is about to go. */
  detail?: string;
  okLabel?: string;
  /** Paints the confirming button as destructive and puts the initial focus on
   *  cancel, so Enter — on a dialog that appeared under a cursor already
   *  heading for the primary button — does not throw work away. */
  danger?: boolean;
}

/** Themed replacement for `window.confirm`.
 *
 *  Not a stylistic choice, for the same reason `modalPrompt` is not: native
 *  dialogs are unreliable in an installed PWA window. Every caller is an
 *  irreversible action — discard, delete, reset --hard, replace across a whole
 *  project — and a confirmation that may never appear is worse than none at
 *  all, because the code carries on as though the user had agreed to it.
 */
export function modalConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<form class="modal">
      <p class="modal-title">${esc(opts.title)}</p>
      ${opts.detail ? `<p class="modal-hint">${esc(opts.detail)}</p>` : ""}
      <div class="modal-row">
        <button type="button" class="t-btn cancel">cancel</button>
        <button type="submit" class="t-btn t-btn-primary${opts.danger ? " t-btn-danger" : ""}">${esc(opts.okLabel ?? "ok")}</button>
      </div></form>`;

    const done = (v: boolean): void => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") done(false);
    };

    back.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      done(true);
    });
    back.querySelector(".cancel")!.addEventListener("click", () => done(false));
    back.addEventListener("click", (e) => {
      if (e.target === back) done(false);
    });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(back);
    back.querySelector<HTMLButtonElement>(opts.danger ? ".cancel" : "[type=submit]")!.focus();
  });
}

export interface PromptOptions {
  title: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  okLabel?: string;
}

export function modalPrompt(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<form class="modal">
      <label>${esc(opts.title)}</label>
      <input class="t-input" value="${esc(opts.value ?? "")}" placeholder="${esc(opts.placeholder ?? "")}"
             autocomplete="off" spellcheck="false" />
      ${opts.hint ? `<p class="modal-hint">${esc(opts.hint)}</p>` : ""}
      <div class="modal-row">
        <button type="button" class="t-btn cancel">cancel</button>
        <button type="submit" class="t-btn t-btn-primary">${esc(opts.okLabel ?? "ok")}</button>
      </div></form>`;

    const input = back.querySelector("input")!;
    const done = (v: string | null): void => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") done(null);
    };

    back.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      done(input.value.trim() || null);
    });
    back.querySelector(".cancel")!.addEventListener("click", () => done(null));
    back.addEventListener("click", (e) => {
      if (e.target === back) done(null);
    });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(back);
    input.focus();
    input.select();
  });
}
