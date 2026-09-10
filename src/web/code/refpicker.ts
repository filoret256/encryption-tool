/** Pick a ref: a branch, a remote branch, or a tag.
 *
 *  What this replaces: a text field. "Merge which branch into the current one?"
 *  opened `modalPrompt`, with every branch in the repository crammed into the
 *  hint line under it as a comma-separated string. On a repository with fifty
 *  branches that hint is unreadable, so the name was typed from memory, and a
 *  typo came back as an error from git — which, at the time, lived in a toast
 *  for 2.2 seconds.
 *
 *  Everything that takes a ref uses this: merge, rebase, checkout, delete,
 *  "create a branch from…". Which is also why it lists tags and remote
 *  branches — git takes those wherever it takes a branch, and the old menu,
 *  built from local branches alone, quietly decided otherwise.
 *
 *  The list, the filtering and the keyboard belong to quickpick.ts; what is
 *  here is what makes a ref a ref rather than a generic row.
 */
import type { Branch } from "../../agent/protocol.ts";
import { quickPick, type PickItem } from "./quickpick.ts";
import { esc } from "./ui.ts";

export interface PickRefOptions {
  title: string;
  /** Everything the agent listed. Filtered per `kinds` below. */
  refs: Branch[];
  /** Which sections to offer. Deleting a branch, for instance, has no business
   *  showing tags. */
  kinds?: Array<"local" | "remote" | "tag">;
  /** Marked as "current" and, when `excludeCurrent`, left out entirely — you
   *  cannot merge a branch into itself. */
  current?: string | null;
  excludeCurrent?: boolean;
  okLabel?: string;
  /** Shown under the title. One line, no more. */
  hint?: string;
}

const SECTIONS: Record<string, string> = {
  local: "branches",
  remote: "remote branches",
  tag: "tags",
};

const kindOf = (b: Branch): "local" | "remote" | "tag" => (b.tag ? "tag" : b.remote ? "remote" : "local");

/** "2h", "3d", "5mo" — the same shape the history uses. */
function ago(seconds: number): string {
  if (!seconds) return "";
  const d = Math.max(0, Date.now() / 1000 - seconds);
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d`;
  if (d < 86400 * 365) return `${Math.floor(d / (86400 * 30))}mo`;
  return `${Math.floor(d / (86400 * 365))}y`;
}

/** Resolves to the chosen ref name, or null if the user backed out. */
export function pickRef(opts: PickRefOptions): Promise<string | null> {
  const kinds = opts.kinds ?? ["local", "remote", "tag"];
  // Grouped first, sorted second. Sorting the whole list by date and then
  // printing a heading whenever the kind changed produced four headings for
  // three kinds — sections have to be contiguous to be sections at all.
  const order: Record<string, number> = { local: 0, remote: 1, tag: 2 };
  const items: PickItem[] = opts.refs
    .filter((b) => kinds.includes(kindOf(b)))
    .filter((b) => !(opts.excludeCurrent && b.name === opts.current))
    .sort(
      (a, b) =>
        order[kindOf(a)] - order[kindOf(b)] ||
        // Inside a section: the current branch, then whatever moved most
        // recently — which is almost always what someone is looking for.
        Number(b.name === opts.current) - Number(a.name === opts.current) ||
        b.time - a.time,
    )
    .map((b) => {
      const track = [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : ""].filter(Boolean).join(" ");
      return {
        value: b.name,
        label: b.name,
        section: SECTIONS[kindOf(b)],
        detail: ago(b.time),
        badges:
          (b.name === opts.current ? `<span class="pick-badge">current</span>` : "") +
          (track ? `<span class="pick-track">${esc(track)}</span>` : ""),
      };
    });

  return quickPick({
    title: opts.title,
    hint: opts.hint,
    placeholder: "type to filter — or paste any ref",
    items,
    okLabel: opts.okLabel ?? "choose",
    // A ref that is not in the list is still a ref: a commit hash, `HEAD~3`, a
    // tag on a remote nobody has fetched.
    freeText: true,
  });
}
