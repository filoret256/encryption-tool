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

const debounce = 120 * time.Millisecond

// Beyond this, send a single "everything" signal — the UI reloads wholesale.
const maxPaths = 400

type watcher struct {
	fsw      *fsnotify.Watcher
	root     string
	onChange func([]string)

	mu      sync.Mutex
	pending map[string]bool
	timer   *time.Timer
	closed  bool
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
		strings.HasPrefix(rel, ".git/lfs/")
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
					_ = w.addTree(ev.Name)
				}
			}
			w.push(w.rel(ev.Name))
		case _, ok := <-w.fsw.Errors:
			// A watcher that dies later must not take the agent down with it.
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
	if rel == gitSentinel || strings.HasPrefix(rel, ".git/") {
		if strings.HasPrefix(rel, ".git/objects/") || strings.HasPrefix(rel, ".git/logs/") ||
			strings.HasPrefix(rel, ".git/lfs/") || strings.HasSuffix(rel, ".lock") {
			return
		}
		rel = gitSentinel
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	w.pending[rel] = true
	if w.timer != nil {
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
