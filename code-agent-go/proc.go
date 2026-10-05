// Process helpers.
//
// Everything here spawns with an argv slice and never through a shell, so no
// part of a request can be interpreted as shell syntax. Git additionally runs
// with GIT_TERMINAL_PROMPT=0 — otherwise a fetch against a repo needing
// credentials blocks forever on a prompt nobody can see.
package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type runResult struct {
	code   int
	stdout string
	stderr string
}

// The most a git command may say before it is stopped.
//
// `run` and its kin read a command's whole output into memory, and nothing
// bounded it: `git.blob` of a 1 GB file from history, or a log asked for ten
// million commits, went into a buffer, then into a string, then into JSON, then
// into the frame — four copies, some GB, on the machine the editor runs on.
// Files on disk have always stopped at 4 MB (maxTextBytes); history did not.
//
// 64 MB is far past anything the panels can show — the biggest legitimate answer
// is a status of a very large tree — and the process is killed at the limit
// rather than read to its end and then refused. The TypeScript code-agent has the
// same number (src/code-agent/proc.ts): the two must fail alike.
const maxGitOutput = 64 << 20

// errOutputTooLarge is what a limited run reports when the process said more
// than it was allowed to. It is a sentinel so that a caller with a better
// message — a blob knows it is a file, and what its limit is — can say it.
var errOutputTooLarge = &gitError{"git's output is larger than the 64 MB limit"}

// How long a child process may run before it is killed, and how long a command
// that talks to a remote may be silent.
//
// Nothing bounded a child's lifetime. exec.CommandContext kills it when the
// *client* goes away and not otherwise, and GIT_TERMINAL_PROMPT=0 only stops
// git from asking for a password: a fetch against a connection that never opens
// stayed alive and held one of the four process slots — and four of those stop
// every search and every git operation, which from the page looks exactly like
// a frozen application.
//
// A read is bounded by its own work, and five minutes is far past the worst of
// it — a status of a very large tree is the slowest thing here, and it is
// seconds. A command that talks to a remote is bounded by somebody else's
// network, which is why it gets a longer allowance and why it also gets a
// window for silence: --progress makes a transfer talk continuously, so a
// command that has said nothing for three minutes is one whose connection has
// stopped carrying bytes, however patient the other end is.
//
// Variables rather than constants so that a test can shrink them: waiting five
// minutes is not a test. The TypeScript code-agent has the same numbers
// (src/code-agent/proc.ts): the two must fail alike.
var (
	readProcDeadline    = 5 * time.Minute
	networkProcDeadline = 20 * time.Minute
	networkIdleWindow   = 3 * time.Minute
)

// procTimeoutError is a child stopped for running past its deadline, or for
// going quiet. Its own type for two reasons: the wire code says which kind of
// failure this is — ETIMEDOUT, the same one the TypeScript code-agent sends —
// rather than the EGIT that a git failing on its own reports, and the message
// can name the command instead of repeating git's last words, which for a
// killed process are usually about a broken pipe.
type procTimeoutError struct {
	what    string
	minutes int
	idle    bool
}

func (e *procTimeoutError) Error() string {
	what := e.what
	if what == "" {
		what = "the command"
	}
	if e.idle {
		return fmt.Sprintf("%s said nothing for %d minutes and was stopped", what, e.minutes)
	}
	return fmt.Sprintf("%s did not finish within %d minutes and was stopped", what, e.minutes)
}

func (e *procTimeoutError) errCode() string { return "ETIMEDOUT" }

// networkGit are the git subcommands that talk to a remote, and so are bounded
// by a network rather than by a disk. Classified from the argv rather than
// passed in by each caller: the caller that forgot to say so would be the one
// that hangs.
var networkGit = map[string]bool{"fetch": true, "pull": true, "push": true, "ls-remote": true, "clone": true, "submodule": true}

// gitOptsWithValue take the next argv entry as their value. Only these can
// stand in front of a subcommand.
var gitOptsWithValue = map[string]bool{"-c": true, "-C": true, "--git-dir": true, "--work-tree": true, "--namespace": true, "--exec-path": true}

// gitSubcommand is the subcommand in an argv, or "" when this is not git.
//
// Not simply argv[1]: a read runs as `git --no-optional-locks log …`, and
// reading the option as the subcommand would classify every read as "not a
// remote" by accident rather than by rule.
func gitSubcommand(argv []string) string {
	if len(argv) == 0 {
		return ""
	}
	if base := filepath.Base(argv[0]); base != "git" && base != "git.exe" {
		return ""
	}
	for i := 1; i < len(argv); i++ {
		arg := argv[i]
		if gitOptsWithValue[arg] {
			i++
			continue
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		return arg
	}
	return ""
}

// idleWatcher kills a process that has stopped saying anything. A transfer
// prints progress continuously; a connection that has stopped carrying bytes
// prints nothing at all, and that is the difference this is for.
type idleWatcher struct {
	mu    sync.Mutex
	timer *time.Timer
	gen   int
	fired bool
	off   bool
	d     time.Duration
	kill  func()
}

func newIdleWatcher(d time.Duration, kill func()) *idleWatcher {
	w := &idleWatcher{d: d, kill: kill}
	w.arm()
	return w
}

// touch says the process is still talking, and starts the window again.
func (w *idleWatcher) touch() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.off {
		return
	}
	w.arm()
}

func (w *idleWatcher) stop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.off = true
	if w.timer != nil {
		w.timer.Stop()
	}
}

// expired reports whether the window is what ended the process, as opposed to
// the process failing on its own.
func (w *idleWatcher) expired() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.fired
}

// arm must be called with the lock held, or before the watcher is shared.
//
// A fresh timer per touch rather than one Reset: the generation is what makes a
// firing that was already on its way — and that a touch has just made
// irrelevant — do nothing. It is a handful of allocations per transfer, against
// killing a connection that has just come back to life.
func (w *idleWatcher) arm() {
	w.gen++
	gen := w.gen
	if w.timer != nil {
		w.timer.Stop()
	}
	w.timer = time.AfterFunc(w.d, func() { w.fire(gen) })
}

func (w *idleWatcher) fire(gen int) {
	w.mu.Lock()
	if w.off || gen != w.gen {
		w.mu.Unlock()
		return
	}
	w.fired = true
	w.off = true
	w.mu.Unlock()
	w.kill()
}

// touchWriter says "the process is still talking" on every write, which is what
// the idle window is measured against. A nil watcher — a command with no window
// — passes everything through.
type touchWriter struct {
	w    io.Writer
	idle *idleWatcher
}

func (t touchWriter) Write(p []byte) (int, error) {
	if t.idle != nil {
		t.idle.touch()
	}
	return t.w.Write(p)
}

// procContext bounds one child process: every command by a deadline, and one
// that talks to a remote by silence as well. The watcher is nil when there is
// no window to keep.
func procContext(ctx context.Context, argv []string) (context.Context, context.CancelFunc, *idleWatcher) {
	if !networkGit[gitSubcommand(argv)] {
		ctx, cancel := context.WithTimeout(ctx, readProcDeadline)
		return ctx, cancel, nil
	}
	ctx, cancel := context.WithTimeout(ctx, networkProcDeadline)
	return ctx, cancel, newIdleWatcher(networkIdleWindow, cancel)
}

// capBuffer collects a process's output up to a limit and then stops the process.
//
// Returning an error from Write is what stops exec's copying goroutine, but a
// child blocked on a full pipe does not learn of that on its own; onFull is the
// context's cancel, which kills it.
type capBuffer struct {
	buf      bytes.Buffer
	max      int
	onFull   func()
	overflow bool
}

func (c *capBuffer) Write(p []byte) (int, error) {
	if c.overflow || c.buf.Len()+len(p) > c.max {
		if !c.overflow {
			c.overflow = true
			c.onFull()
		}
		return 0, errOutputTooLarge
	}
	return c.buf.Write(p)
}

// tailBuffer keeps the start of stderr and quietly drops the rest: an error
// message is a few lines, and one that is not is not worth stopping git for.
type tailBuffer struct {
	buf bytes.Buffer
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	if room := t.max - t.buf.Len(); room > 0 {
		if len(p) > room {
			t.buf.Write(p[:room])
		} else {
			t.buf.Write(p)
		}
	}
	return len(p), nil
}

var defaultEnv = []string{
	"GIT_TERMINAL_PROMPT=0",
	// Keep git's output stable regardless of the user's locale and config.
	"LC_ALL=C",
	"GIT_PAGER=cat",
}

// Later entries win in os/exec, so appending is the same as spreading the
// overrides over the inherited environment.
func procEnv() []string { return append(os.Environ(), defaultEnv...) }

func command(ctx context.Context, argv []string, cwd string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...) // #nosec G204 -- argv is built by this package (git, rg), never through a shell, and every client-supplied value in it passed safeArg or a fixed list
	cmd.Dir = cwd
	cmd.Env = procEnv()
	cmd.Stdin = nil
	return cmd
}

// exitCode turns "the process ran and failed" into a code, and keeps "the
// process could not be started at all" an error — the caller must be able to
// tell a git that reported a problem from a git that is not installed.
func exitCode(err error) (int, error) {
	if err == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return -1, err
}

func run(ctx context.Context, argv []string, cwd string) (runResult, error) {
	return runStdin(ctx, argv, cwd, "")
}

// runStdin feeds the process and closes the pipe. `git apply` reads its patch
// that way and has no other way in — a patch is not an argv. An empty string
// leaves stdin closed from the start, which is what every other caller wants.
func runStdin(ctx context.Context, argv []string, cwd, stdin string) (runResult, error) {
	code, out, stderr, err := runLimited(ctx, argv, cwd, stdin, maxGitOutput)
	if err != nil {
		return runResult{}, err
	}
	return runResult{code: code, stdout: string(out), stderr: stderr}, nil
}

// runLimited runs a command and returns what it wrote, unless that is more than
// max bytes — then the process is killed and the error is errOutputTooLarge.
//
// A command is also killed for running past its deadline: see procContext.
func runLimited(ctx context.Context, argv []string, cwd, stdin string, max int) (int, []byte, string, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	ctx, stopTimeout, idle := procContext(ctx, argv)
	defer stopTimeout()
	if idle != nil {
		defer idle.stop()
	}
	cmd := command(ctx, argv, cwd)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out := &capBuffer{max: max, onFull: cancel}
	errb := &tailBuffer{max: 1 << 20}
	cmd.Stdout = touchWriter{out, idle}
	cmd.Stderr = touchWriter{errb, idle}
	code, err := exitCode(cmd.Run())
	// Checked before the error: a process killed for saying too much, or for
	// running too long, exits with a failure of its own, which is not what went
	// wrong.
	if out.overflow {
		return 0, nil, "", errOutputTooLarge
	}
	if timeoutErr := timeoutOf(ctx, idle, argv); timeoutErr != nil {
		return 0, nil, "", timeoutErr
	}
	if err != nil {
		return 0, nil, "", err
	}
	return code, out.buf.Bytes(), errb.buf.String(), nil
}

// runLines streams stdout line by line. Used for search hits and transfer
// progress so the UI fills in as results arrive instead of after the exit.
//
// onStderr, when set, drains stderr concurrently: git writes transfer progress
// there, and a full pipe buffer would deadlock the child — and that progress is
// also what the idle window of a fetch is measured against.
func runLines(ctx context.Context, argv []string, cwd string, onStderr func(string), onLine func(string)) (int, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	ctx, stopTimeout, idle := procContext(ctx, argv)
	defer stopTimeout()
	if idle != nil {
		defer idle.stop()
	}
	cmd := command(ctx, argv, cwd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return 0, err
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	touch := func() {
		if idle != nil {
			idle.touch()
		}
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if onStderr == nil {
			// Still drained, just not reported: an undrained pipe is a deadlock.
			_, _ = bufio.NewReader(stderr).WriteTo(touchWriter{discard{}, idle})
			return
		}
		// Progress uses \r as a line terminator; treat both as breaks.
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		sc.Split(splitCRLF)
		for sc.Scan() {
			touch()
			if line := sc.Text(); line != "" {
				onStderr(line)
			}
		}
	}()

	sc := bufio.NewScanner(stdout)
	// ripgrep emits one JSON object per line, and a long line in a minified
	// file overflows the 64 KB default.
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for sc.Scan() {
		touch()
		onLine(sc.Text())
	}
	scanErr := sc.Err()

	wg.Wait()
	code, err := exitCode(cmd.Wait())
	if timeoutErr := timeoutOf(ctx, idle, argv); timeoutErr != nil {
		return 0, timeoutErr
	}
	if err != nil {
		return 0, err
	}
	if scanErr != nil {
		return code, scanErr
	}
	return code, nil
}

// timeoutOf reports the deadline as the failure, if that is what ended the
// process: either the context ran out or the idle window fired. Nil when the
// process stopped for a reason of its own.
//
// The message names the command, so it is built here rather than taken from the
// sentinel — and it says exactly what the TypeScript code-agent says, because a
// page that showed one wording against one agent and another against the other
// would be two behaviours, not one.
func timeoutOf(ctx context.Context, idle *idleWatcher, argv []string) error {
	stopped := errors.Is(ctx.Err(), context.DeadlineExceeded)
	if idle != nil && idle.expired() {
		stopped = true
	}
	if !stopped {
		return nil
	}
	what := strings.Join(argv[1:], " ")
	if len(what) > 120 {
		what = what[:120] + "…"
	}
	if idle != nil && idle.expired() {
		return &procTimeoutError{what: what, minutes: max(1, int(networkIdleWindow.Minutes())), idle: true}
	}
	minutes := readProcDeadline
	if networkGit[gitSubcommand(argv)] {
		minutes = networkProcDeadline
	}
	return &procTimeoutError{what: what, minutes: max(1, int(minutes.Minutes()))}
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// splitCRLF is bufio.ScanLines with a lone \r also ending a line.
func splitCRLF(data []byte, atEOF bool) (int, []byte, error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		// Consume \r\n as a single break rather than reporting a blank line.
		if data[i] == '\r' && i+1 < len(data) && data[i+1] == '\n' {
			return i + 2, data[:i], nil
		}
		if data[i] == '\r' && i+1 == len(data) && !atEOF {
			return 0, nil, nil // wait: the \n may still be coming
		}
		return i + 1, data[:i], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// probe reports an executable's first version line, or nil when it is absent.
func probe(ctx context.Context, argv []string) *string {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	r, err := run(ctx, argv, cwd)
	if err != nil || r.code != 0 {
		return nil
	}
	line := strings.TrimSpace(strings.SplitN(r.stdout, "\n", 2)[0])
	if line == "" {
		return nil
	}
	return &line
}
