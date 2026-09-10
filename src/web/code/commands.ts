/** The command registry, the palette, and the keyboard.
 *
 *  Before this the code tab had exactly two shortcuts — Ctrl+B for the side
 *  panel and Ctrl+Enter in the commit box — and everything else was a button
 *  you had to find with the mouse. Worse, Ctrl+S only saved while the caret was
 *  inside the editor: click a file in the tree, press Ctrl+S, and the browser
 *  offered to save the *page*, because nothing on the tab had claimed the key.
 *
 *  So actions are declared once, in one place, with an id, a title and
 *  optionally a key. From that single declaration comes the palette, the
 *  keyboard, and — for anything that needs it later — a menu entry. The rule
 *  is: if it is worth a shortcut it is worth a palette entry, because a
 *  shortcut nobody can discover is a shortcut nobody uses.
 */
import { quickPick, type PickItem } from "./quickpick.ts";

export interface Command {
  /** Stable, dotted, and never shown to anyone: "file.save", "view.explorer". */
  id: string;
  /** What the palette lists. Sentence case, verb first. */
  title: string;
  /** Grouping in the palette: "file", "git", "view", "go". */
  category?: string;
  /** Chord, in the notation `matches()` below understands: "Mod+S",
   *  "Mod+Shift+P", "Alt+ArrowLeft". Mod is Ctrl, or Cmd on a Mac. */
  key?: string;
  /** False means "not right now" — no palette entry, no keyboard. A command
   *  that cannot run must not be reachable, or the palette becomes a list of
   *  ways to produce an error. */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "Mod+Shift+P" as a person reads it on this platform. */
export function keyLabel(key: string): string {
  return key
    .split("+")
    .map((part) => {
      if (part === "Mod") return isMac ? "⌘" : "Ctrl";
      if (part === "Shift") return isMac ? "⇧" : "Shift";
      if (part === "Alt") return isMac ? "⌥" : "Alt";
      if (part.startsWith("Arrow")) return part.slice(5);
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(isMac ? "" : "+");
}

/** Does this event match the chord? */
function matches(e: KeyboardEvent, key: string): boolean {
  const parts = key.split("+");
  const want = parts[parts.length - 1].toLowerCase();
  const mod = parts.includes("Mod");
  const shift = parts.includes("Shift");
  const alt = parts.includes("Alt");

  const pressedMod = isMac ? e.metaKey : e.ctrlKey;
  if (pressedMod !== mod) return false;
  if (e.shiftKey !== shift) return false;
  if (e.altKey !== alt) return false;
  // `code` rather than `key` for letters: with Shift held, `key` is uppercase,
  // and on a non-Latin layout it is not a Latin letter at all — a shortcut has
  // to keep working when someone is typing Russian.
  if (want.length === 1 && /[a-z]/.test(want)) return e.code === `Key${want.toUpperCase()}`;
  return e.key.toLowerCase() === want;
}

export class Commands {
  private list: Command[] = [];

  add(...commands: Command[]): void {
    this.list.push(...commands);
  }

  /** Everything that could run right now. */
  available(): Command[] {
    return this.list.filter((c) => !c.when || c.when());
  }

  find(id: string): Command | undefined {
    return this.list.find((c) => c.id === id);
  }

  async run(id: string): Promise<void> {
    const command = this.find(id);
    if (!command || (command.when && !command.when())) return;
    await command.run();
  }

  /** The key handler. Returns true when the event was consumed, so the caller
   *  knows to stop the browser from acting on it as well. */
  handleKey(e: KeyboardEvent): boolean {
    for (const command of this.available()) {
      if (command.key && matches(e, command.key)) {
        void command.run();
        return true;
      }
    }
    return false;
  }

  /** Ctrl+Shift+P. Lists what is possible, with the keys that do it directly —
   *  which is how anyone finds out those keys exist. */
  async palette(): Promise<void> {
    const items: PickItem[] = this.available().map((c) => ({
      value: c.id,
      label: c.title,
      section: c.category,
      detail: c.key ? keyLabel(c.key) : undefined,
      filterText: `${c.category ?? ""} ${c.title}`,
    }));
    const id = await quickPick({
      title: "Commands",
      placeholder: "type a command",
      items,
      buttons: false,
    });
    if (id) await this.run(id);
  }
}
