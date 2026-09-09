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
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
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
	cmd := command(ctx, argv, cwd)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	code, err := exitCode(cmd.Run())
	if err != nil {
		return runResult{}, err
	}
	return runResult{code: code, stdout: out.String(), stderr: errb.String()}, nil
}

// runBytes is the byte-exact variant — blobs may be binary, and decoding them
// as UTF-8 first would corrupt the content before we get a chance to detect it.
func runBytes(ctx context.Context, argv []string, cwd string) (int, []byte, string, error) {
	cmd := command(ctx, argv, cwd)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	code, err := exitCode(cmd.Run())
	if err != nil {
		return 0, nil, "", err
	}
	return code, out.Bytes(), errb.String(), nil
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
