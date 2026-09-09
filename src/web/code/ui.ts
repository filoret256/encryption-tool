/** Small DOM helpers shared by the code tab: escaping, context menu, modal
 *  prompt. `window.prompt` is unavailable in an installed PWA window, so the
 *  modal is not a stylistic choice. */

export const esc = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export const attr = (s: string): string => esc(s).replace(/"/g, "&quot;");

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
