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
  /** A question the notice asks: one button per answer. The notice goes when one is pressed. */
  actions?: { label: string; run: () => void }[];
  /** Stays until dismissed even when it is not an error: a question waits for its answer. */
  sticky?: boolean;
  /** What state this notice is about, when it is about one.
   *
   *  An error may not expire on a timer — but it may stop being true. "merge
   *  stopped with conflicts — resolve them below" is a fact about the
   *  repository, and once the merge is committed it is a red box making a claim
   *  that is no longer so, sitting over the editor until someone closes it by
   *  hand. Whoever knows the state went away calls `dismissScope` with the same
   *  tag; nothing else is touched. */
  scope?: string;
}

/** How long a success stays up. Long enough to read six words. */
const LINGER_MS = 2600;
/** Beyond this the stack becomes wallpaper; the oldest dismissible one goes. */
const MAX_VISIBLE = 4;
/** Errors are not evicted to make room for successes, but they do not get to
 *  fill the window either: past this many, the oldest goes. Nothing is lost —
 *  every notice is also a line in the output log, which is where a backlog of
 *  failures belongs. */
const MAX_ERRORS = 3;

export interface Notifier {
  show(notice: Notice): void;
  /** Take everything off the screen. Used by the output log's "clear": a
   *  notice and a log entry are two views of one event, and clearing the
   *  transcript while the error it describes still hangs over the editor is
   *  half a job. */
  dismissAll(): void;
  /** Take down the notices tagged with this scope, because what they describe
   *  is no longer the case. */
  dismissScope(scope: string): void;
}

export function mountNotifier(host: HTMLElement): Notifier {
  host.className = "toasts";
  // Polite, not assertive: most of what lands here is confirmation, and
  // interrupting a screen-reader user mid-sentence to say "saved" is rude.
  // Errors override this per element, below.
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");

  // A success's fade-out timer, by notice: a notice taken down early takes its timer with it.
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const drop = (el: HTMLElement): void => {
    clearTimeout(timers.get(el));
    timers.delete(el);
    el.remove();
  };

  const trim = (): void => {
    const all = [...host.children] as HTMLElement[];
    const errors = all.filter((el) => el.classList.contains("error"));
    // A run of failures — a fetch that fails on every retry, a status the code-agent
    // cannot answer — used to stack without limit, because errors were exempt
    // from eviction entirely. They still outrank successes; they just have a
    // ceiling now.
    if (errors.length > MAX_ERRORS) drop(errors[0]);
    const left = [...host.children] as HTMLElement[];
    if (left.length <= MAX_VISIBLE) return;
    const evictable = left.filter((el) => !el.classList.contains("error"));
    drop(evictable[0] ?? left[0]);
  };

  return {
    show({ message, isError = false, onDetails, actions, sticky = false, scope }: Notice): void {
      // The same failure usually arrives several times at once: the status,
      // the log and the file list all ask git independently, and one broken
      // ref answers all three. Four identical stacked errors say nothing the
      // first one did not — so a repeat counts up on the notice already there.
      // A question is never folded into the one before it: each has its own answer to give.
      const key = `${isError ? "e" : "i"}:${message}${actions ? Math.random() : ""}`;
      const last = host.lastElementChild as HTMLElement | null;
      if (last && last.dataset.key === key) {
        const seen = Number(last.dataset.count ?? "1") + 1;
        last.dataset.count = String(seen);
        // The repeat may carry a scope the first one did not, and it is the
        // one notice on screen: it has to be dismissible by whatever tagged it.
        if (scope) last.dataset.scope = scope;
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
      if (scope) el.dataset.scope = scope;
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
          drop(el);
          onDetails();
        });
        el.appendChild(more);
      }

      for (const action of actions ?? []) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "toast-action";
        button.textContent = action.label;
        button.addEventListener("click", () => {
          drop(el);
          action.run();
        });
        el.appendChild(button);
      }

      // Errors get a real close button; successes get one too, for anyone who
      // wants the screen back before the timer.
      const close = document.createElement("button");
      close.type = "button";
      close.className = "toast-close";
      close.setAttribute("aria-label", "Dismiss");
      close.textContent = "✕";
      close.addEventListener("click", () => drop(el));
      el.appendChild(close);

      host.appendChild(el);
      trim();

      if (!isError && !sticky) timers.set(el, setTimeout(() => drop(el), LINGER_MS));
    },

    dismissAll(): void {
      for (const el of [...host.children] as HTMLElement[]) drop(el);
    },

    dismissScope(scope: string): void {
      for (const el of [...host.children] as HTMLElement[]) {
        if (el.dataset.scope === scope) drop(el);
      }
    },
  };
}
