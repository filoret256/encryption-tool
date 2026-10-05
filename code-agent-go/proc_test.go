package main

import (
	"bytes"
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestHelperProcess is not a test: it is the process the tests below run, the
// standard way to get a child with a chosen behaviour without depending on
// what the machine has installed. It writes ENC_TEST_BYTES bytes and exits.
//
// ENC_TEST_SLEEP is the other child worth having: one that says nothing and
// does not end, which is what a fetch against a connection that never opens
// looks like from here.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("ENC_TEST_HELPER") != "1" {
		return
	}
	if d := os.Getenv("ENC_TEST_SLEEP"); d != "" {
		secs, _ := strconv.Atoi(d)
		time.Sleep(time.Duration(secs) * time.Second)
		os.Exit(0)
	}
	n, _ := strconv.Atoi(os.Getenv("ENC_TEST_BYTES"))
	chunk := bytes.Repeat([]byte("x"), 64<<10)
	for written := 0; written < n; written += len(chunk) {
		if _, err := os.Stdout.Write(chunk); err != nil {
			os.Exit(3) // the reader went away, which is what the limit is for
		}
	}
	os.Exit(0)
}

func helper(t *testing.T, n int) []string {
	t.Helper()
	t.Setenv("ENC_TEST_HELPER", "1")
	t.Setenv("ENC_TEST_BYTES", strconv.Itoa(n))
	return []string{os.Args[0], "-test.run=^TestHelperProcess$"}
}

// sleepyHelper is a child that writes nothing and runs for `secs` seconds.
func sleepyHelper(t *testing.T, secs int) []string {
	t.Helper()
	t.Setenv("ENC_TEST_HELPER", "1")
	t.Setenv("ENC_TEST_SLEEP", strconv.Itoa(secs))
	return []string{os.Args[0], "-test.run=^TestHelperProcess$"}
}

// shorten makes the deadlines small for the length of one test: waiting five
// minutes is not a test. Restored on the way out, because the variables are
// package-wide.
func shorten(t *testing.T, d time.Duration) {
	t.Helper()
	read, network, idle := readProcDeadline, networkProcDeadline, networkIdleWindow
	readProcDeadline, networkProcDeadline, networkIdleWindow = d, d, d
	t.Cleanup(func() { readProcDeadline, networkProcDeadline, networkIdleWindow = read, network, idle })
}

func TestRunLimitedStopsAProcessThatSaysTooMuch(t *testing.T) {
	const max = 1 << 20

	// Under, and exactly at, the limit: returned whole.
	for _, n := range []int{max / 2, max} {
		_, out, _, err := runLimited(context.Background(), helper(t, n), t.TempDir(), "", max)
		if err != nil || len(out) != n {
			t.Fatalf("%d bytes with a limit of %d: got %d bytes, err %v", n, max, len(out), err)
		}
	}

	// Over: refused, not truncated — a cut-off blob would be shown as the file.
	_, out, _, err := runLimited(context.Background(), helper(t, max+1), t.TempDir(), "", max)
	if err != errOutputTooLarge || out != nil {
		t.Fatalf("%d bytes with a limit of %d: got %d bytes, err %v, want errOutputTooLarge", max+1, max, len(out), err)
	}
}

func TestRunLimitedKillsTheProcessInsteadOfReadingItToTheEnd(t *testing.T) {
	// A gigabyte, against a limit of one megabyte. Read to the end this takes
	// seconds and a gigabyte of memory; stopped at the limit it is over at once.
	argv := helper(t, 1<<30)
	started := time.Now()
	_, _, _, err := runLimited(context.Background(), argv, t.TempDir(), "", 1<<20)
	if err != errOutputTooLarge {
		t.Fatalf("err = %v, want errOutputTooLarge", err)
	}
	if took := time.Since(started); took > 5*time.Second {
		t.Fatalf("stopping the process took %v; it was read on instead of killed", took)
	}
}

// A child with no deadline of its own used to run until the code-agent was
// restarted, holding one of the four process slots — and four of those stop
// every search and every git operation.
func TestAChildThatNeverEndsIsStoppedAtItsDeadline(t *testing.T) {
	shorten(t, 300*time.Millisecond)

	started := time.Now()
	_, _, _, err := runLimited(context.Background(), sleepyHelper(t, 60), t.TempDir(), "", 1<<20)
	if errCodeOf(err) != "ETIMEDOUT" {
		t.Fatalf("err = %v (code %s), want ETIMEDOUT", err, errCodeOf(err))
	}
	if !strings.Contains(err.Error(), "did not finish within 1 minutes and was stopped") {
		t.Errorf("the message does not say what happened: %q", err)
	}
	if took := time.Since(started); took > 10*time.Second {
		t.Fatalf("the deadline took %v to fire", took)
	}

	// And the same for the streaming reader, which is what a fetch uses.
	started = time.Now()
	if _, err := runLines(context.Background(), sleepyHelper(t, 60), t.TempDir(), nil, func(string) {}); errCodeOf(err) != "ETIMEDOUT" {
		t.Fatalf("runLines: err = %v (code %s), want ETIMEDOUT", err, errCodeOf(err))
	}
	if took := time.Since(started); took > 10*time.Second {
		t.Fatalf("the deadline took %v to fire on a streamed command", took)
	}
}

// A command that talks to a remote is bounded by silence as well as by a
// deadline: --progress makes a transfer talk continuously, so one that has said
// nothing at all is one whose connection has stopped carrying bytes.
func TestTheIdleWindowSparesAProcessThatKeepsTalking(t *testing.T) {
	var killed bool
	var mu sync.Mutex
	w := newIdleWatcher(200*time.Millisecond, func() {
		mu.Lock()
		killed = true
		mu.Unlock()
	})
	defer w.stop()

	for i := 0; i < 6; i++ {
		time.Sleep(80 * time.Millisecond)
		w.touch()
	}
	mu.Lock()
	spared := !killed
	mu.Unlock()
	if !spared {
		t.Fatal("a process that kept talking was killed")
	}
	if w.expired() {
		t.Fatal("a process that kept talking reports that it timed out")
	}

	// Silence, on the other hand, is the evidence the window is for.
	silent := newIdleWatcher(150*time.Millisecond, func() {
		mu.Lock()
		killed = true
		mu.Unlock()
	})
	defer silent.stop()
	if !waitFor(func() bool {
		mu.Lock()
		defer mu.Unlock()
		return killed
	}, 5*time.Second) {
		t.Fatal("a process that went quiet was not killed")
	}
	if !silent.expired() {
		t.Fatal("the idle window did not report that it fired")
	}
}

func waitFor(ok func() bool, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if ok() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return ok()
}

// The classification the two deadlines hang on: a read runs as
// `git --no-optional-locks log …`, so argv[1] is not the subcommand.
func TestWhichGitCommandsTalkToARemote(t *testing.T) {
	cases := []struct {
		argv []string
		want string
	}{
		{[]string{"git", "--no-optional-locks", "log", "-n", "10"}, "log"},
		{[]string{"git", "--no-optional-locks", "status"}, "status"},
		{[]string{"git", "fetch", "--prune", "--progress"}, "fetch"},
		{[]string{"git", "-c", "a=b", "push", "origin"}, "push"},
		{[]string{"git", "-C", "/somewhere", "pull"}, "pull"},
		{[]string{"rg", "--json", "-e", "pattern"}, ""},
		{[]string{"git"}, ""},
		{[]string{}, ""},
	}
	for _, c := range cases {
		if got := gitSubcommand(c.argv); got != c.want {
			t.Errorf("gitSubcommand(%v) = %q, want %q", c.argv, got, c.want)
		}
	}
	for _, op := range []string{"fetch", "pull", "push", "ls-remote", "clone", "submodule"} {
		if !networkGit[op] {
			t.Errorf("%s is not classified as talking to a remote", op)
		}
	}
	for _, op := range []string{"log", "status", "blame", "diff", "show"} {
		if networkGit[op] {
			t.Errorf("%s is classified as talking to a remote", op)
		}
	}
}
