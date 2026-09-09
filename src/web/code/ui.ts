/** Small DOM helpers shared by the code tab: escaping, context menu, modal
 *  prompt. `window.prompt` is unavailable in an installed PWA window, so the
 *  modal is not a stylistic choice. */

export const esc = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export const attr = (s: string): string => esc(s).replace(/"/g, "&quot;");

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
      <input class="t-input" value="${attr(opts.value ?? "")}" placeholder="${attr(opts.placeholder ?? "")}"
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
