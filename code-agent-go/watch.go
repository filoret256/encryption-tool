// Filesystem watcher feeding live explorer updates.
//
// Node hands out one recursive watch and hides three different kernel
// mechanisms behind it. Here the recursion is explicit: every directory under
// the root gets its own watch, and directories created later are added as their
// creation event arrives. That is the price of dropping the runtime, and it is
// also why the .git subtrees we discard anyway are never watched at all —
// .git/objects alone would multiply the watch count on a large repository.
//
// Events are debounced and deduplicated: a single `git checkout` can touch
// thousands of paths, and forwarding each one would be worse than useless.
package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Emitted instead of the individual paths under .git — the UI reacts to it by
// refreshing status and branches, and never shows git internals in the tree.
const gitSentinel = ".git"

// Sent as well as gitSentinel when what changed was HEAD or a ref.
//
// A change under .git is one signal, because git touches the directory
// constantly and nothing on the client needs to tell those apart — except one
// thing: the history panel is commits and the refs that point at them, and
// staging a file rewrites .git/index and leaves both alone. Without this every
// stage re-read every loaded commit. The two sentinels are not exclusive: a
// ref change carries both, an index change only the first.
const gitRefsSentinel = ".git#refs"

// movesRefs reports whether a path under .git is HEAD or a ref, which is
// everything that can change what the history panel shows. packed-refs is where
// a gc puts them, so it counts.
func movesRefs(rel string) bool {
	return rel == ".git/HEAD" || rel == ".git/packed-refs" || strings.HasPrefix(rel, ".git/refs/")
}

const debounce = 120 * time.Millisecond

// The longest a change may wait before it is reported, however busy the tree.
//
// The debounce alone restarts on every event, so a build or an install that
// touches a file every 50 ms held the report back for as long as it ran — the
// tree and the status showed nothing until it finished, then everything at
// once. Past this, the timer that is already armed is left to fire.
const maxWait = time.Second

// Directories whose contents are neither edited by hand nor worth a refresh:
// dependency and cache trees, tens of thousands of files that change in bursts
// (an install rewrites the lot). Watching them cost a kernel watch per
// directory — on Linux that is the inotify limit, which the rest of the
// machine's editors share — a walk of all of them at start, and an event storm
// on every install, all for changes nobody asked to see.
//
// Events *inside* one are not reported and it is not descended into. The folder
// itself appearing or going is still reported, by the watch on its parent, so
// the tree shows it. Matched by name at any depth: a monorepo has one per
// package.
var heavyDirs = map[string]bool{
	"node_modules":  true,
	".venv":         true,
	"__pycache__":   true,
	".tox":          true,
	".mypy_cache":   true,
	".pytest_cache": true,
	".gradle":       true,
}

// inHeavyDir reports whether a slash-separated path lies in a heavy directory.
// With includeLast the final segment counts too — the question "should this
// directory be watched" — and without it only its ancestors do — the question
// "is this event inside one".
func inHeavyDir(rel string, includeLast bool) bool {
	segs := strings.Split(rel, "/")
	if !includeLast {
		segs = segs[:len(segs)-1]
	}
	for _, s := range segs {
		if heavyDirs[s] {
			return true
		}
	}
	return false
}

// Beyond this, send a single "everything" signal — the UI reloads wholesale.
const maxPaths = 400

type watcher struct {
	fsw      *fsnotify.Watcher
	root     string
	onChange func([]string)

	mu      sync.Mutex
	pending map[string]bool
	// When the oldest unreported change arrived, for maxWait.
	first  time.Time
	timer  *time.Timer
	closed bool
}

// watcherSupported probes the mechanism without walking the tree, so a large
// repository does not pay for the capability check at startup.
func watcherSupported(root string) bool {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return false
	}
	defer w.Close()
	return w.Add(root) == nil
}

func startWatcher(root string, onChange func([]string)) *watcher {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil
	}
	w := &watcher{fsw: fsw, root: root, onChange: onChange, pending: map[string]bool{}}
	if err := w.addTree(root); err != nil {
		fsw.Close()
		return nil
	}
	go w.loop()
	return w
}

// addTree watches dir and everything below it. Individual failures are
// tolerated: on Linux the inotify watch limit is reachable on a big tree, and
// partial live updates beat none.
func (w *watcher) addTree(dir string) error {
	if err := w.fsw.Add(dir); err != nil {
		return err
	}
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() || path == dir {
			return nil //nolint:nilerr // an unreadable subtree is skipped, not fatal
		}
		if w.skipTree(path) {
			return filepath.SkipDir
		}
		_ = w.fsw.Add(path)
		return nil
	})
}

// skipTree reports directories whose events are discarded anyway, so they are
// never watched in the first place.
func (w *watcher) skipTree(abs string) bool {
	rel := w.rel(abs)
	return rel == ".git/objects" || rel == ".git/logs" || rel == ".git/lfs" ||
		strings.HasPrefix(rel, ".git/objects/") || strings.HasPrefix(rel, ".git/logs/") ||
		strings.HasPrefix(rel, ".git/lfs/") || inHeavyDir(rel, true)
}

func (w *watcher) rel(abs string) string {
	rel, err := filepath.Rel(w.root, abs)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(rel)
}

func (w *watcher) loop() {
	for {
		select {
		case ev, ok := <-w.fsw.Events:
			if !ok {
				return
			}
			// A directory that appears after startup needs its own watch, or
			// everything created inside it later goes unseen.
			if ev.Has(fsnotify.Create) {
				if info, err := os.Stat(ev.Name); err == nil && info.IsDir() && !w.skipTree(ev.Name) {
					// Off this goroutine: walking a tree that was just dropped
					// in (a clone, an unpack) can take long enough that the
					// kernel's event queue overflows behind it, and the events
					// it drops are exactly the ones that say what changed.
					go func(dir string) { _ = w.addTree(dir) }(ev.Name)
				}
			}
			w.push(w.rel(ev.Name))
		case _, ok := <-w.fsw.Errors:
			// A watcher that dies later must not take the code-agent down with it.
			if !ok {
				return
			}
		}
	}
}

func (w *watcher) push(rel string) {
	if rel == "" || strings.HasPrefix(rel, "..") {
		return
	}

	// .git churns constantly (index.lock, loose objects); collapse it all into
	// one signal, and drop the noisiest subtrees entirely.
	refs := false
	if rel == gitSentinel || strings.HasPrefix(rel, ".git/") {
		if strings.HasPrefix(rel, ".git/objects/") || strings.HasPrefix(rel, ".git/logs/") ||
			strings.HasPrefix(rel, ".git/lfs/") || strings.HasSuffix(rel, ".lock") {
			return
		}
		refs = movesRefs(rel)
		rel = gitSentinel
	}

	// Inside a dependency or cache tree: not reported. The event for the folder
	// itself has one segment fewer and is not caught here.
	if inHeavyDir(rel, false) {
		return
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	if len(w.pending) == 0 {
		w.first = time.Now()
	}
	w.pending[rel] = true
	if refs {
		w.pending[gitRefsSentinel] = true
	}
	if w.timer != nil {
		if time.Since(w.first) >= maxWait {
			return // it has waited long enough: let the armed timer fire
		}
		w.timer.Stop()
	}
	w.timer = time.AfterFunc(debounce, w.flush)
}

func (w *watcher) flush() {
	w.mu.Lock()
	w.timer = nil
	if w.closed || len(w.pending) == 0 {
		w.mu.Unlock()
		return
	}
	var paths []string
	if len(w.pending) > maxPaths {
		paths = []string{"*"}
	} else {
		paths = make([]string, 0, len(w.pending))
		for p := range w.pending {
			paths = append(paths, p)
		}
	}
	w.pending = map[string]bool{}
	w.mu.Unlock()

	w.onChange(paths)
}

func (w *watcher) close() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	w.mu.Unlock()
	_ = w.fsw.Close()
}
