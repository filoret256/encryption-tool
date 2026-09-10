/** One filtered list, used by everything that asks "which one?".
 *
 *  The command palette, quick open, and the ref picker are the same interaction
 *  three times over: a field you type into, a list that narrows as you do,
 *  arrow keys, Enter, Escape. Writing that three times would mean three sets of
 *  keyboard bugs, so it is written here and dressed differently by each caller.
 *
 *  Everything the caller wants to look distinctive — a "current" badge, an
 *  ahead/behind counter, a keyboard hint — arrives as `badges`, which is the
 *  one place a caller supplies markup. It must be escaped by the caller; the
 *  label and detail are inserted as text and cannot be.
 */
import { esc } from "./ui.ts";

export interface PickItem {
  /** What the promise resolves to when this row is chosen. */
  value: string;
  label: string;
  /** Secondary text, shown after the label — a path, a date, a shortcut. */
  detail?: string;
  /** Contiguous items sharing a section get one heading above them. */
  section?: string;
  /** Pre-escaped markup shown between label and detail. */
  badges?: string;
  /** What the filter matches against. Defaults to label + detail. */
  filterText?: string;
}

export interface QuickPickOptions {
  title: string;
  hint?: string;
  placeholder?: string;
  /** A fixed list, or one recomputed on every keystroke (quick open scores
   *  matches, so it cannot be filtered by substring here). */
  items: PickItem[] | ((query: string) => PickItem[]);
  okLabel?: string;
  /** With nothing matching, Enter resolves to whatever was typed. For refs
   *  that is a feature — a commit hash is a valid answer that is not in any
   *  list — and for a command palette it is nonsense. */
  freeText?: boolean;
  /** Cancel/confirm buttons. A palette has no use for them; a dialog that
   *  deletes a branch does. */
  buttons?: boolean;
}

/** Resolves to the chosen value, or null if the user backed out. */
export function quickPick(opts: QuickPickOptions): Promise<string | null> {
  const fixed = Array.isArray(opts.items) ? opts.items : null;
  const compute = typeof opts.items === "function" ? opts.items : null;

  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<form class="modal quick-pick" role="dialog" aria-modal="true">
      <p class="modal-title">${esc(opts.title)}</p>
      ${opts.hint ? `<p class="modal-hint">${esc(opts.hint)}</p>` : ""}
      <input class="t-input js-filter" autocomplete="off" spellcheck="false"
             placeholder="${esc(opts.placeholder ?? "type to filter")}" aria-label="${esc(opts.title)}" />
      <div class="pick-list js-list" role="listbox"></div>
      ${
        opts.buttons === false
          ? ""
          : `<div class="modal-row">
               <button type="button" class="t-btn cancel">cancel</button>
               <button type="submit" class="t-btn t-btn-primary">${esc(opts.okLabel ?? "choose")}</button>
             </div>`
      }
    </form>`;

    const form = back.querySelector<HTMLFormElement>("form")!;
    const filter = back.querySelector<HTMLInputElement>(".js-filter")!;
    const list = back.querySelector<HTMLElement>(".js-list")!;
    let shown: PickItem[] = [];
    let active = 0;

    const done = (value: string | null): void => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };

    const render = (): void => {
      const query = filter.value.trim();
      const needle = query.toLowerCase();
      shown = compute
        ? compute(query)
        : !needle
          ? fixed!
          : fixed!.filter((i) => (i.filterText ?? `${i.label} ${i.detail ?? ""}`).toLowerCase().includes(needle));
      if (active >= shown.length) active = Math.max(0, shown.length - 1);

      if (!shown.length) {
        list.innerHTML = `<p class="pick-empty">${
          opts.freeText && query
            ? `Nothing matches. Press Enter to use “${esc(query)}” as typed.`
            : "Nothing matches."
        }</p>`;
        return;
      }

      let section = "";
      list.innerHTML = shown
        .map((item, i) => {
          const header = item.section && item.section !== section ? `<div class="pick-section">${esc(item.section)}</div>` : "";
          section = item.section ?? section;
          return `${header}<div class="pick-row${i === active ? " active" : ""}" role="option"
               aria-selected="${i === active}" data-i="${i}">
            <span class="pick-label">${esc(item.label)}</span>
            ${item.badges ?? ""}
            <span class="t-spacer"></span>
            ${item.detail ? `<span class="pick-detail">${esc(item.detail)}</span>` : ""}
          </div>`;
        })
        .join("");
      list.querySelector(".pick-row.active")?.scrollIntoView({ block: "nearest" });
    };

    const choose = (): void => {
      const picked = shown[active]?.value ?? (opts.freeText ? filter.value.trim() : "");
      if (picked) done(picked);
    };

    const move = (delta: number): void => {
      if (!shown.length) return;
      active = Math.min(shown.length - 1, Math.max(0, active + delta));
      render();
    };

    function onKey(e: KeyboardEvent): void {
      if (!back.isConnected) return;
      switch (e.key) {
        case "Escape": e.preventDefault(); return done(null);
        case "ArrowDown": e.preventDefault(); return move(1);
        case "ArrowUp": e.preventDefault(); return move(-1);
        case "PageDown": e.preventDefault(); return move(8);
        case "PageUp": e.preventDefault(); return move(-8);
        case "Home": if (!filter.value) { e.preventDefault(); active = 0; render(); } return;
        case "End": if (!filter.value) { e.preventDefault(); active = shown.length - 1; render(); } return;
        case "Enter":
          // The list is not a form control, so Enter has to be claimed here for
          // the keyboard path to work when the buttons are absent.
          e.preventDefault();
          return choose();
        case "Tab": {
          // Focus stays inside: the field and the two buttons are all there is.
          const stops = [filter, ...back.querySelectorAll<HTMLElement>(".modal-row button")];
          const at = stops.indexOf(document.activeElement as HTMLElement);
          e.preventDefault();
          stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
          return;
        }
      }
    }

    filter.addEventListener("input", () => {
      active = 0;
      render();
    });
    list.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".pick-row");
      if (!row) return;
      active = Number(row.dataset.i);
      choose();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      choose();
    });
    back.querySelector(".cancel")?.addEventListener("click", () => done(null));
    back.addEventListener("click", (e) => {
      if (e.target === back) done(null);
    });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(back);
    render();
    filter.focus();
  });
}
