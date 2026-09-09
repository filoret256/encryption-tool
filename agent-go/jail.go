// Path containment for the agent.
//
// The agent listens on loopback and every request carries a path, so this is
// the file that keeps a malicious (or merely buggy) page from reading outside
// the folder the user opened. Two checks, both required:
//
//  1. lexical — reject absolute paths and any ".." segment before resolving,
//     so nothing can climb out via the string itself;
//  2. realpath — for paths that already exist, resolve symlinks and re-check
//     containment, so a symlink inside the workspace cannot point out of it.
//
// Everything on the wire is POSIX-style and relative to the root; conversion to
// native separators happens here and nowhere else.
package main

import (
	"path/filepath"
	"runtime"
	"strings"
)

type jailError struct{ path string }

func (e *jailError) Error() string   { return "Path escapes the workspace: " + e.path }
func (e *jailError) errCode() string { return "EPATH" }

type jail struct{ root string }

// openJail resolves the workspace root once, following symlinks, so every later
// containment test compares against a canonical path.
func openJail(dir string) (*jail, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	return &jail{root: real}, nil
}

// Windows paths are case-insensitive; comparing raw strings would let
// `C:\Work\repo\..\Other` slip past a case-mismatched prefix test.
func fold(p string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(p)
	}
	return p
}

func contains(root, abs string) bool {
	if fold(abs) == fold(root) {
		return true
	}
	rel, err := filepath.Rel(fold(root), fold(abs))
	if err != nil {
		return false // different volumes, which is as far outside as it gets
	}
	return rel != "" && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

// toAbs converts a wire path to an absolute native path. Use it for paths that
// may not exist yet (create, write, rename target).
func (j *jail) toAbs(wire string) (string, error) {
	rel := strings.Trim(strings.ReplaceAll(wire, "\x5c", "/"), "/")

	// A drive letter or an empty segment ("a//b") means the caller built the
	// path wrong; ".." is the one that actually escapes. Reject all three.
	if len(rel) >= 2 && rel[1] == ':' && isLetter(rel[0]) {
		return "", &jailError{wire}
	}
	if rel != "" {
		for _, seg := range strings.Split(rel, "/") {
			if seg == ".." || seg == "" {
				return "", &jailError{wire}
			}
		}
	}

	abs := filepath.Join(j.root, filepath.FromSlash(rel))
	if !contains(j.root, abs) {
		return "", &jailError{wire}
	}
	return abs, nil
}

// toAbsExisting is toAbs plus a symlink-aware re-check. Use it for paths that
// must already exist (read, stat, delete, rename source).
func (j *jail) toAbsExisting(wire string) (string, error) {
	abs, err := j.toAbs(wire)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		// ENOENT and friends surface from the actual operation, with the message
		// the operation itself would have produced.
		return abs, nil
	}
	if !contains(j.root, real) {
		return "", &jailError{wire}
	}
	return real, nil
}

// toWire converts an absolute native path back to a wire path.
func (j *jail) toWire(abs string) string {
	rel, err := filepath.Rel(j.root, abs)
	if err != nil {
		return filepath.ToSlash(abs)
	}
	return filepath.ToSlash(rel)
}

func isLetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}
