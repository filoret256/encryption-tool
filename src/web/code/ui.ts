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

/** Put text on the clipboard and say so.
 *
 *  Silence was the whole problem: "Copy path" wrote and reported nothing, so a
 *  miss — the menu item that did not take the click, a clipboard the browser
 *  refused in a page without focus — was indistinguishable from a copy that
 *  worked, and you only found out on paste. `writeText` also rejects rather
 *  than throwing synchronously, so the failure had nowhere to surface at all.
 *
 *  `what` names the thing, not the value: paths and hashes are long, and the
 *  toast holds one line. */
export async function copyToClipboard(text: string, what: string, notify: (message: string, isError?: boolean) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify(`${what} copied`);
  } catch {
    notify(`could not copy the ${what.toLowerCase()} — the browser refused clipboard access`, true);
  }
}

/** One floating menu at a time, reused for every right-click. */
/** A menu item. `danger` paints it as destructive and separates it from what
 *  comes before, so "Delete" cannot be reached by muscle memory aimed at
 *  "Rename"; `hint` shows the key that does the same thing without the menu. */
export interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
  hint?: string;
  /** A rule above this item. Use it to break a long menu into groups. */
  separated?: boolean;
}

/** Anything callers may hand to showMenu: the old pair form still works. */
export type MenuEntry = MenuItem | [string, () => void];

const asItem = (entry: MenuEntry): MenuItem => (Array.isArray(entry) ? { label: entry[0], run: entry[1] } : entry);

export function showMenu(x: number, y: number, entries: MenuEntry[]): void {
  document.querySelector(".ctx-menu")?.remove();
  const items = entries.map(asItem);
  // Where focus was, so Escape (or picking something) can put it back rather
  // than dropping the keyboard user at the top of the document.
  const opener = document.activeElement as HTMLElement | null;

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.setAttribute("role", "menu");
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const close = (restoreFocus: boolean): void => {
    menu.remove();
    document.removeEventListener("keydown", onKey, true);
    if (restoreFocus) opener?.focus?.();
  };

  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    if (item.danger) b.classList.add("danger");
    if (item.separated) b.classList.add("separated");
    const label = document.createElement("span");
    label.textContent = item.label;
    b.appendChild(label);
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "ctx-hint";
      hint.textContent = item.hint;
      b.appendChild(hint);
    }
    b.addEventListener("click", () => {
      close(false); // the action decides where focus goes next
      item.run();
    });
    buttons.push(b);
    menu.appendChild(b);
  }

  const move = (delta: number): void => {
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (at + delta + buttons.length) % buttons.length;
    buttons[at === -1 ? (delta > 0 ? 0 : buttons.length - 1) : next]?.focus();
  };

  // Captured, so the tree's own key handling does not act on keys meant for
  // the menu that is on top of it.
  function onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "Escape": e.preventDefault(); return close(true);
      case "ArrowDown": e.preventDefault(); return move(1);
      case "ArrowUp": e.preventDefault(); return move(-1);
      case "Home": e.preventDefault(); return buttons[0]?.focus();
      case "End": e.preventDefault(); return buttons[buttons.length - 1]?.focus();
      case "Tab": e.preventDefault(); return move(e.shiftKey ? -1 : 1);
    }
  }
  document.addEventListener("keydown", onKey, true);

  document.body.appendChild(menu);
  // Keep it on screen when opened near the right or bottom edge.
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = `${innerWidth - r.width - 4}px`;
  if (r.bottom > innerHeight) menu.style.top = `${innerHeight - r.height - 4}px`;
  buttons[0]?.focus();
  setTimeout(() => document.addEventListener("click", () => close(false), { once: true }));
}

/** Hold the keyboard inside a dialog, and give it back when the dialog goes.
 *
 *  Without this, Tab walked straight out of the modal and into the page behind
 *  it — the editor, the tree, the toolbar — while the backdrop still covered
 *  everything, so the focus ring was somewhere the user could not see and
 *  Enter did something they could not predict. Every dialog here asks about
 *  work that cannot be undone, which makes that worse than untidy.
 *
 *  Returns the cleanup, which also restores focus to whatever opened it.
 */
function trapFocus(container: HTMLElement): () => void {
  const opener = document.activeElement as HTMLElement | null;
  const focusable = (): HTMLElement[] =>
    [...container.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
      (el) => !el.hasAttribute("disabled"),
    );

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Tab") return;
    const items = focusable();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    // Wrap at both ends rather than letting the browser leave the dialog.
    if (e.shiftKey && (active === first || !container.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !container.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    opener?.focus?.();
  };
}

/** Mark a dialog for assistive technology: it is a dialog, it is modal, and
 *  this is what it is called. */
function markDialog(form: HTMLElement, labelledBy: HTMLElement | null): void {
  form.setAttribute("role", "dialog");
  form.setAttribute("aria-modal", "true");
  if (labelledBy) {
    labelledBy.id ||= `dlg-${Math.random().toString(36).slice(2, 8)}`;
    form.setAttribute("aria-labelledby", labelledBy.id);
  }
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

    const form = back.querySelector<HTMLElement>("form")!;
    markDialog(form, form.querySelector(".modal-title"));
    const release = trapFocus(form);

    const done = (v: boolean): void => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      release();
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
    const form = back.querySelector<HTMLElement>("form")!;
    markDialog(form, form.querySelector("label"));
    const release = trapFocus(form);

    const done = (v: string | null): void => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      release();
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
