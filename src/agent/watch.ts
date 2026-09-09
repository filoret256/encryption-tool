/** Filesystem watcher feeding live explorer updates.
 *
 *  Recursive fs.watch is native on Windows and macOS; on Linux it depends on
 *  the kernel/runtime and may throw, in which case the agent reports
 *  `watch: false` in agent.info and the UI hides its live-update indicator
 *  rather than silently going stale.
 *
 *  Events are debounced and deduplicated: a single `git checkout` can touch
 *  thousands of paths, and forwarding each one would be worse than useless.
 */
import { watch, type FSWatcher } from "node:fs";
import { relative, sep } from "node:path";

/** Emitted instead of the individual paths under .git — the UI reacts to it by
 *  refreshing status and branches, and never shows git internals in the tree. */
export const GIT_SENTINEL = ".git";

const DEBOUNCE_MS = 120;
/** Beyond this, send a single "everything" signal — the UI reloads wholesale. */
const MAX_PATHS = 400;

export class Watcher {
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly root: string,
    private readonly onChange: (paths: string[]) => void,
  ) {}

  static start(root: string, onChange: (paths: string[]) => void): Watcher | null {
    const w = new Watcher(root, onChange);
    try {
      w.watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename) w.push(String(filename));
      });
      // A watcher that dies later must not take the agent down with it.
      w.watcher.on("error", () => w.close());
      return w;
    } catch {
      return null; // recursive watching unsupported on this platform
    }
  }

  private push(filename: string): void {
    const rel = relative(this.root, `${this.root}${sep}${filename}`).split(sep).join("/");
    if (!rel || rel.startsWith("..")) return;

    // .git churns constantly (index.lock, loose objects); collapse it all into
    // one signal, and drop the noisiest subtrees entirely.
    if (rel === ".git" || rel.startsWith(".git/")) {
      if (/^\.git\/(objects|logs|lfs)\//.test(rel) || rel.endsWith(".lock")) return;
      this.pending.add(GIT_SENTINEL);
    } else {
      this.pending.add(rel);
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  private flush(): void {
    this.timer = null;
    if (!this.pending.size) return;
    const paths = this.pending.size > MAX_PATHS ? ["*"] : [...this.pending];
    this.pending.clear();
    this.onChange(paths);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
