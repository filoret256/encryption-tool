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
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type jailError struct{ reason, path string }

func (e *jailError) Error() string   { return e.reason + ": " + e.path }
func (e *jailError) errCode() string { return "EPATH" }

func escapes(p string) *jailError { return &jailError{"Path escapes the workspace", p} }

func insideGitDir(p string) *jailError { return &jailError{"Path is inside the git directory", p} }

// errUnreadableLink is returned when a path component is a reparse point whose
// target cannot be read. It is not "the path does not exist" and must never be
// treated as one: an unreadable link is a link this code cannot vouch for, and
// the containment check exists precisely to refuse what it cannot vouch for.
var errUnreadableLink = errors.New("cannot resolve link")

// resolveLinks canonicalises a path, following every kind of link.
//
// filepath.EvalSymlinks is not enough on Windows. An NTFS *junction* — which
// any unprivileged process can create with `mklink /J` — is a reparse point
// that Go reports from os.Lstat as ModeIrregular rather than ModeSymlink, and
// that EvalSymlinks hands back unchanged instead of resolving. Both halves of
// the containment check were therefore blind to it: a junction inside the
// workspace pointing anywhere on the disk let a write land outside, while every
// string involved stayed inside and every lexical check passed. The TypeScript
// agent refuses these, because Node's lstat reports a junction as a symlink and
// realpath resolves it; the two implementations disagreed, and the
// cross-implementation smoke test is what surfaced it.
//
// os.Readlink *does* read a junction's target, so reparse points are expanded
// here first and EvalSymlinks is left to finish the job on ordinary symlinks.
func resolveLinks(p string) (string, error) {
	// The cap mirrors what the kernel does for symlink chains: a loop of links
	// must terminate as an error rather than as a hang.
	for i := 0; i < 40; i++ {
		next, expanded, err := expandReparse(p)
		if err != nil {
			return "", err
		}
		if !expanded {
			return filepath.EvalSymlinks(p)
		}
		p = next
	}
	return "", errUnreadableLink
}

// expandReparse replaces the first reparse point on the path with its target.
//
// Component by component from the volume root, because any directory on the way
// may be a link out — not just the last one.
func expandReparse(p string) (string, bool, error) {
	vol := filepath.VolumeName(p)
	rest := strings.Trim(filepath.ToSlash(strings.TrimPrefix(p, vol)), "/")
	if rest == "" {
		return p, false, nil
	}
	parts := strings.Split(rest, "/")
	prefix := vol + string(filepath.Separator)
	for i, seg := range parts {
		prefix = filepath.Join(prefix, seg)
		fi, err := os.Lstat(prefix)
		if err != nil {
			// This component does not exist yet, so neither it nor anything
			// below it can be a link. Callers that care about non-existence
			// handle it themselves.
			return p, false, nil
		}
		// ModeIrregular as well as ModeSymlink: that is how a junction arrives.
		if fi.Mode()&(os.ModeSymlink|os.ModeIrregular) == 0 {
			continue
		}
		target, rerr := os.Readlink(prefix)
		if rerr != nil {
			return "", false, errUnreadableLink
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(prefix), target)
		}
		return filepath.Join(append([]string{target}, parts[i+1:]...)...), true, nil
	}
	return p, false, nil
}

// isGitDirName reports whether a path segment names the git directory.
//
// The git directory is machinery, not content: a client that can write
// .git/config or .git/hooks/* runs commands on this machine the next time git
// is invoked — and the agent invokes git on its own, to refresh the status
// panel, so it need not even wait for the user. Nothing the editor legitimately
// does goes through here; git itself is reached with the git.* ops instead.
//
// Matched the way git's own protections match it: case-insensitively (the
// segment is the same directory on a case-insensitive filesystem), ignoring
// the trailing dots and spaces Windows strips before opening a file, and
// including the NTFS 8.3 short name.
func isGitDirName(seg string) bool {
	s := strings.TrimRight(strings.ToLower(seg), ". ")
	return s == ".git" || s == "git~1"
}

type jail struct{ root string }

// openJail resolves the workspace root once, following symlinks, so every later
// containment test compares against a canonical path.
func openJail(dir string) (*jail, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	real, err := resolveLinks(abs)
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
		return "", escapes(wire)
	}
	if rel != "" {
		for _, seg := range strings.Split(rel, "/") {
			if seg == ".." || seg == "" {
				return "", escapes(wire)
			}
			if isGitDirName(seg) {
				return "", insideGitDir(wire)
			}
		}
	}

	abs := filepath.Join(j.root, filepath.FromSlash(rel))
	if !contains(j.root, abs) {
		return "", escapes(wire)
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
	real, err := resolveLinks(abs)
	if err != nil {
		// A link we cannot read is refused; anything else (ENOENT and friends)
		// surfaces from the actual operation, with the message the operation
		// itself would have produced.
		if errors.Is(err, errUnreadableLink) {
			return "", escapes(wire)
		}
		return abs, nil
	}
	if !contains(j.root, real) {
		return "", escapes(wire)
	}
	return real, nil
}

// toAbsForWrite is toAbs plus the symlink checks a write needs. Use it for
// every operation that creates or replaces something: write, create, mkdir,
// and the destination of a rename.
//
// toAbsExisting resolves a path that must already exist, so it was never
// reached by the operations that make one — and that is exactly where the
// escape was: os.WriteFile and its friends follow a symlink, so a link
// committed to the repository (`notes.txt -> ~/.ssh/authorized_keys`) is a
// write outside the workspace even though every string involved stayed inside
// it, and every lexical check passes.
//
// Two resolutions, because one does not cover the other:
//
//  1. the leaf, via Lstat — a link is followed only when its target is inside
//     the workspace, which keeps editing an in-workspace link working, the way
//     reading through one already does. A dangling link is refused outright:
//     there is no target to check, and following it would create the file at
//     the far end;
//  2. the deepest ancestor that exists, via EvalSymlinks — any directory on the
//     way may itself be a link out, and the segments below the deepest existing
//     one cannot be links, because they do not exist yet.
//
// Note for renames: rename(2) replaces a symlink rather than following it, so
// resolving the leaf makes a move onto an existing link land on its target
// instead. Both stay inside the workspace, and one rule for every write is
// worth more here than matching that corner exactly.
func (j *jail) toAbsForWrite(wire string) (string, error) {
	abs, err := j.toAbs(wire)
	if err != nil {
		return "", err
	}

	// ModeIrregular as well as ModeSymlink — see resolveLinks: that is how a
	// Windows junction arrives, and it was the half of this check that a
	// junction walked straight past.
	if info, lerr := os.Lstat(abs); lerr == nil && info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
		real, rerr := resolveLinks(abs)
		if rerr != nil || !contains(j.root, real) {
			return "", escapes(wire)
		}
		abs = real
	}

	for dir := filepath.Dir(abs); ; {
		if real, rerr := resolveLinks(dir); rerr == nil {
			if !contains(j.root, real) {
				return "", escapes(wire)
			}
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break // reached the volume root without finding anything that exists
		}
		dir = parent
	}

	return abs, nil
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
