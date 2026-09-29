/** Filesystem watcher feeding live explorer updates.
 *
 *  Recursive fs.watch is native on Windows and macOS; on Linux it depends on
 *  the kernel/runtime and may throw, in which case the code-agent reports
 *  `watch: false` in code-agent.info and the UI hides its live-update indicator
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

/** Sent as well as GIT_SENTINEL when what changed was HEAD or a ref.
 *
 *  A change under .git is one signal, because git touches the directory
 *  constantly and nothing on the client needs to tell those apart — except one
 *  thing: the history panel is commits and the refs that point at them, and
 *  staging a file rewrites .git/index and leaves both alone. Without this every
 *  stage re-read every loaded commit. The two sentinels are not exclusive: a ref
 *  change carries both, an index change only the first. code-agent-go/watch.go is the
 *  same. */
export const GIT_REFS_SENTINEL = ".git#refs";

/** HEAD or a ref — everything that can change what the history panel shows.
 *  packed-refs is where a gc puts them, so it counts. */
const movesRefs = (rel: string): boolean => rel === ".git/HEAD" || rel === ".git/packed-refs" || rel.startsWith(".git/refs/");

const DEBOUNCE_MS = 120;

/** The longest a change may wait before it is reported, however busy the tree.
 *
 *  The debounce alone restarts on every event, so a build or an install that
 *  touches a file every 50 ms held the report back for as long as it ran — the
 *  tree and the status showed nothing until it finished, then everything at
 *  once. Past this, the timer that is already armed is left to fire. */
const MAX_WAIT_MS = 1000;

/** Directories whose contents are neither edited by hand nor worth a refresh:
 *  dependency and cache trees, tens of thousands of files that change in bursts
 *  (an install rewrites the lot). Events *inside* one are not reported. The
 *  folder itself appearing or going is still reported, so the tree shows it.
 *  Matched by name at any depth: a monorepo has one per package.
 *
 *  The same list as code-agent-go/watch.go, where it also keeps the directories from
 *  being watched at all — here `fs.watch` is recursive and has no way to be told
 *  to skip one, so the events are dropped on arrival instead. */
const HEAVY_DIRS = new Set(["node_modules", ".venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".gradle"]);

/** Does a path lie inside a heavy directory? Its own last segment does not count:
 *  that event is the folder itself. */
const insideHeavyDir = (rel: string): boolean => rel.split("/").slice(0, -1).some((seg) => HEAVY_DIRS.has(seg));
/** Beyond this, send a single "everything" signal — the UI reloads wholesale. */
const MAX_PATHS = 400;

export class Watcher {
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest unreported change arrived, for MAX_WAIT_MS. */
  private firstAt = 0;

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
      // A watcher that dies later must not take the code-agent down with it.
      w.watcher.on("error", () => w.close());
      return w;
    } catch {
      return null; // recursive watching unsupported on this platform
    }
  }

  private push(filename: string): void {
    const rel = relative(this.root, `${this.root}${sep}${filename}`).split(sep).join("/");
    if (!rel || rel.startsWith("..")) return;
    // Asked before anything is added: a Set does not grow when the same file
    // changes again, so its size cannot say when the wait began.
    const wasEmpty = this.pending.size === 0;

    // .git churns constantly (index.lock, loose objects); collapse it all into
    // one signal, and drop the noisiest subtrees entirely.
    if (rel === ".git" || rel.startsWith(".git/")) {
      if (/^\.git\/(objects|logs|lfs)\//.test(rel) || rel.endsWith(".lock")) return;
      this.pending.add(GIT_SENTINEL);
      if (movesRefs(rel)) this.pending.add(GIT_REFS_SENTINEL);
    } else {
      if (insideHeavyDir(rel)) return;
      this.pending.add(rel);
    }

    if (wasEmpty) this.firstAt = Date.now();
    if (this.timer) {
      if (Date.now() - this.firstAt >= MAX_WAIT_MS) return; // it has waited long enough
      clearTimeout(this.timer);
    }
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
