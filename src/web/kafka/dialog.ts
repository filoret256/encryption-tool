/** A modal over the page, for everything the kafka tab asks in a dialog.
 *
 *  It closes on Escape and on a click on the backdrop, keeps the focus inside,
 *  and gives it back to whatever opened it. The caller fills the form and wires
 *  its own buttons; `close` takes the dialog away and runs whatever the caller
 *  registered with `onClose`.
 */
import { markDialog, trapFocus } from "../code/ui.ts";

export interface Dialog {
  back: HTMLElement;
  form: HTMLFormElement;
  close: () => void;
  onClose: (cb: () => void) => void;
}

export function openDialog(html: string, wide = false): Dialog {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<form class="modal${wide ? " kf-send" : ""}">${html}</form>`;
  const form = back.querySelector<HTMLFormElement>("form")!;
  markDialog(form, form.querySelector(".modal-title"));
  const release = trapFocus(form);
  const closers: (() => void)[] = [];
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    release();
    for (const cb of closers) cb();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) close();
  });
  document.body.appendChild(back);
  return { back, form, close, onClose: (cb) => closers.push(cb) };
}
