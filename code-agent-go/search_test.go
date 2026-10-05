// The fallback scan's bounds: how far it got, why it stopped, and that the
// whole scan is on a clock and not only each file. The JavaScript code-agent
// answers the same way (reason, scanned, candidates in SearchSummary), and
// scripts/code-agent-smoke.ts checks the two against each other over the wire.
package main

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeTree makes a workspace of `files` files, each holding `lines` lines with
// the word in them, and returns a jail on it. It has to be a git repository:
// the fallback lists its files with `git ls-files -co`, which outside one
// answers nothing at all.
func writeTree(t *testing.T, files, lines int) *jail {
	t.Helper()
	root := t.TempDir()
	body := strings.Repeat("a line with a needle in it\n", lines)
	for i := 0; i < files; i++ {
		dir := filepath.Join(root, "d", string(rune('a'+i%26)))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "f"+strconv.Itoa(i)+".txt"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if out, err := exec.Command("git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	return &jail{root: root}
}

func collect(t *testing.T, j *jail, o searchOpts, progress func(scanProgress)) searchSummary {
	t.Helper()
	return runSearch(context.Background(), j, o, false, func(searchHit) {}, progress)
}

func TestTheScanSaysHowFarItGot(t *testing.T) {
	j := writeTree(t, 30, 2)
	var last scanProgress
	got := collect(t, j, searchOpts{query: "needle"}, func(p scanProgress) { last = p })
	if got.Reason != nil {
		t.Errorf("a scan that reached the end reports %q", *got.Reason)
	}
	if got.Truncated {
		t.Error("a scan that reached the end is marked truncated")
	}
	if got.Scanned == nil || got.Candidates == nil {
		t.Fatal("the fallback scan did not report how far it got")
	}
	if *got.Candidates != 30 {
		t.Errorf("candidates = %d, want 30", *got.Candidates)
	}
	if *got.Scanned != 30 {
		t.Errorf("scanned = %d, want 30", *got.Scanned)
	}
	if got.Matches != 60 {
		t.Errorf("matches = %d, want 60", got.Matches)
	}
	// 30 files is under progressEvery, so nothing was reported while it ran; the
	// summary is where a scan this size says where it got to.
	if last != (scanProgress{}) {
		t.Errorf("progress was reported for a scan of 30 files: %+v", last)
	}
}

func TestAFinishedScanSaysNothingAboutStopping(t *testing.T) {
	j := writeTree(t, 4, 1)
	got := collect(t, j, searchOpts{query: "needle", maxMatches: 1}, nil)
	if got.Reason == nil || *got.Reason != "matches" {
		t.Errorf("a scan stopped at the cap reports %v, want matches", got.Reason)
	}
	if !got.Truncated {
		t.Error("a scan stopped at the cap is not marked truncated")
	}
}

func TestTheScanStopsAtItsOwnDeadline(t *testing.T) {
	j := writeTree(t, 400, 400)
	// A live deadline that runs out while the scan is working, rather than one
	// that is already spent: what is under test is the check inside the loop.
	ctx, stop := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer stop()
	got := fallbackSearch(ctx, j, searchOpts{query: "needle"}, 5000, func(searchHit) {}, nil)
	if got.Reason == nil || *got.Reason != "time" {
		t.Fatalf("reason = %v, want time", got.Reason)
	}
	if !got.Truncated {
		t.Error("a scan stopped by the deadline is not marked truncated")
	}
	if got.Scanned == nil || *got.Scanned >= 400 {
		t.Errorf("scanned = %v of 400 — the deadline stopped nothing", got.Scanned)
	}
}

// The bound the finding is about: one slow-enough file is not the whole story,
// and the sum of the files is what the caller waits for.
func TestTheWholeScanIsBounded(t *testing.T) {
	was := scanLimit
	scanLimit = 40 * time.Millisecond
	defer func() { scanLimit = was }()

	j := writeTree(t, 400, 400)
	started := time.Now()
	got := collect(t, j, searchOpts{query: "needle"}, nil)
	took := time.Since(started)
	if got.Reason == nil || *got.Reason != "time" {
		t.Fatalf("reason = %v, want time", got.Reason)
	}
	// The scan checks the clock between files, so it overshoots by at most one
	// file: generous, but nothing like the minutes an unbounded scan would take.
	if took > 2*time.Second {
		t.Errorf("the scan ran for %v with a 40 ms deadline", took)
	}
}

func TestProgressArrivesWhileTheScanRuns(t *testing.T) {
	was := progressEvery
	progressEvery = 10
	defer func() { progressEvery = was }()

	j := writeTree(t, 45, 1)
	seen := []int{}
	collect(t, j, searchOpts{query: "needle"}, func(p scanProgress) {
		seen = append(seen, p.scanned)
		if p.candidates != 45 {
			t.Errorf("progress says %d candidates, want 45", p.candidates)
		}
	})
	if len(seen) != 4 {
		t.Fatalf("progress was reported %d times, want 4: %v", len(seen), seen)
	}
	for i, n := range seen {
		if n != (i+1)*10 {
			t.Errorf("progress %d says %d files", i, n)
		}
	}
}
