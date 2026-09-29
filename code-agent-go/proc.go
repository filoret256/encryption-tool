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
	"os"
	"os/exec"
	"strings"
	"sync"
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
func runLimited(ctx context.Context, argv []string, cwd, stdin string, max int) (int, []byte, string, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := command(ctx, argv, cwd)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out := &capBuffer{max: max, onFull: cancel}
	errb := &tailBuffer{max: 1 << 20}
	cmd.Stdout = out
	cmd.Stderr = errb
	code, err := exitCode(cmd.Run())
	// Checked before the error: a process killed for saying too much exits with
	// a failure of its own, which is not what went wrong.
	if out.overflow {
		return 0, nil, "", errOutputTooLarge
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
// there, and a full pipe buffer would deadlock the child.
func runLines(ctx context.Context, argv []string, cwd string, onStderr func(string), onLine func(string)) (int, error) {
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

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if onStderr == nil {
			// Still drained, just not reported: an undrained pipe is a deadlock.
			_, _ = bufio.NewReader(stderr).WriteTo(discard{})
			return
		}
		// Progress uses \r as a line terminator; treat both as breaks.
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		sc.Split(splitCRLF)
		for sc.Scan() {
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
		onLine(sc.Text())
	}
	scanErr := sc.Err()

	wg.Wait()
	code, err := exitCode(cmd.Wait())
	if err != nil {
		return 0, err
	}
	if scanErr != nil {
		return code, scanErr
	}
	return code, nil
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
