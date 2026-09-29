package main

import (
	"bytes"
	"context"
	"os"
	"strconv"
	"testing"
	"time"
)

// TestHelperProcess is not a test: it is the process the tests below run, the
// standard way to get a child with a chosen behaviour without depending on
// what the machine has installed. It writes ENC_TEST_BYTES bytes and exits.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("ENC_TEST_HELPER") != "1" {
		return
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
