/** Notifications.
 *
 *  What this replaces: one `<div id="toast">` whose text was overwritten by
 *  whatever spoke last and which cleared itself after 2.2 seconds — including
 *  when what it was holding was a seven-line rejection from git. Two things
 *  were wrong with that, and both cost people work:
 *
 *   - a second message erased the first, so "saved" routinely wiped an error
 *     nobody had read yet;
 *   - errors expired on a timer. An error is not an announcement, it is
 *     something the user has to act on, and it has no business vanishing on
 *     its own.
 *
 *  So: a stack rather than a slot; successes fade, errors stay until dismissed;
 *  and anything with more to say carries a "details" button that opens the
 *  output log (see code/output.ts) instead of trying to be the log itself.
 *
 *  Screen readers were told nothing at all before. The stack is a polite live
 *  region, and each error is an alert inside it, which is the difference
 *  between "there is a new message when you get a moment" and "this one now".
 */

export interface Notice {
  message: string;
  isError?: boolean;
  /** Opens the output log at the entry this notice came from. */
  onDetails?: () => void;
}

/** How long a success stays up. Long enough to read six words. */
const LINGER_MS = 2600;
/** Beyond this the stack becomes wallpaper; the oldest dismissible one goes. */
const MAX_VISIBLE = 4;

export interface Notifier {
  show(notice: Notice): void;
  /** Take everything off the screen. Used by the output log's "clear": a
   *  notice and a log entry are two views of one event, and clearing the
   *  transcript while the error it describes still hangs over the editor is
   *  half a job. */
  dismissAll(): void;
}

export function mountNotifier(host: HTMLElement): Notifier {
  host.className = "toasts";
  // Polite, not assertive: most of what lands here is confirmation, and
  // interrupting a screen-reader user mid-sentence to say "saved" is rude.
  // Errors override this per element, below.
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");

  const trim = (): void => {
    const all = [...host.children] as HTMLElement[];
    if (all.length <= MAX_VISIBLE) return;
    // Errors are not evicted to make room — they are the ones worth keeping.
    const evictable = all.filter((el) => !el.classList.contains("error"));
    (evictable[0] ?? all[0]).remove();
  };

  return {
    show({ message, isError = false, onDetails }: Notice): void {
      // The same failure usually arrives several times at once: the status,
      // the log and the file list all ask git independently, and one broken
      // ref answers all three. Four identical stacked errors say nothing the
      // first one did not — so a repeat counts up on the notice already there.
      const key = `${isError ? "e" : "i"}:${message}`;
      const last = host.lastElementChild as HTMLElement | null;
      if (last && last.dataset.key === key) {
        const seen = Number(last.dataset.count ?? "1") + 1;
        last.dataset.count = String(seen);
        const tally = last.querySelector<HTMLElement>(".toast-count") ?? (() => {
          const badge = document.createElement("span");
          badge.className = "toast-count";
          last.querySelector(".toast-text")!.after(badge);
          return badge;
        })();
        tally.textContent = `×${seen}`;
        return;
      }

      const el = document.createElement("div");
      el.dataset.key = key;
      el.className = "toast" + (isError ? " error" : "");
      if (isError) el.setAttribute("role", "alert");

      const text = document.createElement("span");
      text.className = "toast-text";
      text.textContent = message;
      el.appendChild(text);

      if (onDetails) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "toast-action";
        more.textContent = "details";
        more.addEventListener("click", () => {
          el.remove();
          onDetails();
        });
        el.appendChild(more);
      }

      // Errors get a real close button; successes get one too, for anyone who
      // wants the screen back before the timer.
      const close = document.createElement("button");
      close.type = "button";
      close.className = "toast-close";
      close.setAttribute("aria-label", "Dismiss");
      close.textContent = "✕";
      close.addEventListener("click", () => el.remove());
      el.appendChild(close);

      host.appendChild(el);
      trim();

      if (!isError) setTimeout(() => el.remove(), LINGER_MS);
    },

    dismissAll(): void {
      host.replaceChildren();
    },
  };
}
