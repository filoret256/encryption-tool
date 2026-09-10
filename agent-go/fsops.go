// Filesystem operations exposed to the explorer.
//
// Thin wrappers over the os package — the value here is that every path goes
// through the jail first and that reads classify binary/oversized content
// instead of handing the editor a mangled string.
package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

// Above this a file opens as read-only "too large" rather than in the editor.
// CodeMirror copes with a few MB, but the round trip over the socket does not.
const maxTextBytes = 4 * 1024 * 1024

// A NUL byte in the first block is the same heuristic git itself uses.
const sniffBytes = 8000

func isBinary(b []byte) bool {
	n := len(b)
	if n > sniffBytes {
		n = sniffBytes
	}
	for i := 0; i < n; i++ {
		if b[i] == 0 {
			return true
		}
	}
	return false
}

func readDir(j *jail, path string) ([]dirEntry, error) {
	abs, err := j.toAbsExisting(path)
	if err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(abs)
	if err != nil {
		return nil, nodeFsError(err, "scandir", abs)
	}

	out := make([]dirEntry, 0, len(ents))
	for _, d := range ents {
		// The jail refuses to open anything under the git directory, so listing
		// it would only offer the explorer a row that errors when clicked.
		if isGitDirName(d.Name()) {
			continue
		}
		link := d.Type()&fs.ModeSymlink != 0
		e := dirEntry{Name: d.Name(), Dir: d.IsDir(), Link: link}

		// Stat follows symlinks, so a link to a directory sorts with directories.
		// A failure here is a broken link or a race with an external delete —
		// list the entry anyway.
		if st, err := os.Stat(filepath.Join(abs, d.Name())); err == nil {
			e.Dir = st.IsDir()
			if !e.Dir {
				size, mtime := st.Size(), st.ModTime().UnixMilli()
				e.Size, e.Mtime = &size, &mtime
			}
		}
		out = append(out, e)
	}

	// Directories first, then natural order by name — matches VS Code's explorer.
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].Dir != out[b].Dir {
			return out[a].Dir
		}
		return naturalCompare(out[a].Name, out[b].Name) < 0
	})
	return out, nil
}

func readTextFile(j *jail, path string) (*fileRead, error) {
	abs, err := j.toAbsExisting(path)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, nodeFsError(err, "stat", abs)
	}
	mtime := st.ModTime().UnixMilli()
	if st.Size() > maxTextBytes {
		return &fileRead{Text: nil, Size: st.Size(), Mtime: mtime, Binary: false, TooLarge: true}, nil
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil, nodeFsError(err, "open", abs)
	}
	if isBinary(b) {
		return &fileRead{Text: nil, Size: st.Size(), Mtime: mtime, Binary: true, TooLarge: false}, nil
	}
	text := string(b)
	return &fileRead{Text: &text, Size: st.Size(), Mtime: mtime, Binary: false, TooLarge: false}, nil
}

func writeTextFile(j *jail, path, text string) (map[string]int64, error) {
	abs, err := j.toAbsForWrite(path)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(abs, []byte(text), 0o644); err != nil {
		return nil, nodeFsError(err, "open", abs)
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, nodeFsError(err, "stat", abs)
	}
	return map[string]int64{"mtime": st.ModTime().UnixMilli()}, nil
}

func createFile(j *jail, path string) error {
	abs, err := j.toAbsForWrite(path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nodeFsError(err, "mkdir", filepath.Dir(abs))
	}
	// O_EXCL fails if it already exists — never silently truncate someone's file.
	f, err := os.OpenFile(abs, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return nodeFsError(err, "open", abs)
	}
	return f.Close()
}

func createDir(j *jail, path string) error {
	abs, err := j.toAbsForWrite(path)
	if err != nil {
		return err
	}
	return nodeFsError(os.MkdirAll(abs, 0o755), "mkdir", abs)
}

func movePath(j *jail, from, to string) error {
	src, err := j.toAbsExisting(from)
	if err != nil {
		return err
	}
	dst, err := j.toAbsForWrite(to)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return nodeFsError(err, "mkdir", filepath.Dir(dst))
	}
	// Node names both ends of a failed rename; so does this.
	return nodeFsError(os.Rename(src, dst), "rename", src+"' -> '"+dst)
}

func deletePaths(j *jail, paths []string) error {
	for _, p := range paths {
		abs, err := j.toAbsExisting(p)
		if err != nil {
			return err
		}
		if err := os.RemoveAll(abs); err != nil {
			return nodeFsError(err, "unlink", abs)
		}
	}
	return nil
}

func statPath(j *jail, path string) (map[string]any, error) {
	abs, err := j.toAbsExisting(path)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, nodeFsError(err, "stat", abs)
	}
	return map[string]any{
		"dir":   st.IsDir(),
		"size":  st.Size(),
		"mtime": st.ModTime().UnixMilli(),
	}, nil
}

// errnoName maps an os error onto the Node-style code the browser client has
// always received, so the two implementations report failures identically.
func errnoName(err error) string {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "ENOENT"
	case errors.Is(err, fs.ErrExist):
		return "EEXIST"
	case errors.Is(err, fs.ErrPermission):
		return "EACCES"
	case errors.Is(err, fs.ErrInvalid):
		return "EINVAL"
	}
	return ""
}

type fsError struct {
	code string
	msg  string
}

func (e *fsError) Error() string   { return e.msg }
func (e *fsError) errCode() string { return e.code }

var nodeErrText = map[string]string{
	"ENOENT": "no such file or directory",
	"EEXIST": "file already exists",
	"EACCES": "permission denied",
	"EINVAL": "invalid argument",
}

// nodeFsError rewords an os error the way Node's fs module words it —
// "ENOENT: no such file or directory, stat 'C:\...'" — because that string is
// not an implementation detail: it goes into a toast the user reads. The
// syscall name is passed in rather than taken from the error, since Go and
// Node disagree about which call failed (os.ReadDir reports "open" where Node
// reports "scandir").
//
// Anything outside the table keeps its Go message; inventing a Node phrasing
// for an error Node has no phrasing for would be worse than the truth.
func nodeFsError(err error, syscall, path string) error {
	if err == nil {
		return nil
	}
	code := errnoName(err)
	text, known := nodeErrText[code]
	if !known {
		return err
	}
	return &fsError{code: code, msg: fmt.Sprintf("%s: %s, %s '%s'", code, text, syscall, path)}
}

// naturalCompare approximates Intl.Collator(numeric, sensitivity:"base"):
// digit runs compare as numbers and letters compare case-insensitively, so
// "file2" precedes "file10" and "README" sorts next to "readme". It is an
// approximation — full ICU collation would mean shipping ICU — and it differs
// from the TypeScript agent only on accented characters in the same folder.
func naturalCompare(a, b string) int {
	ar, br := []rune(a), []rune(b)
	i, j := 0, 0
	for i < len(ar) && j < len(br) {
		if unicode.IsDigit(ar[i]) && unicode.IsDigit(br[j]) {
			si, sj := i, j
			for i < len(ar) && unicode.IsDigit(ar[i]) {
				i++
			}
			for j < len(br) && unicode.IsDigit(br[j]) {
				j++
			}
			// Compare without leading zeros: longer run wins, then lexically,
			// which is numeric order without parsing into a bounded integer.
			na := strings.TrimLeft(string(ar[si:i]), "0")
			nb := strings.TrimLeft(string(br[sj:j]), "0")
			if len(na) != len(nb) {
				if len(na) < len(nb) {
					return -1
				}
				return 1
			}
			if c := strings.Compare(na, nb); c != 0 {
				return c
			}
			continue
		}
		ca, cb := unicode.ToLower(ar[i]), unicode.ToLower(br[j])
		if ca != cb {
			if ca < cb {
				return -1
			}
			return 1
		}
		i++
		j++
	}
	if len(ar)-i != len(br)-j {
		if len(ar)-i < len(br)-j {
			return -1
		}
		return 1
	}
	// Equal ignoring case: fall back to the raw bytes so the order is stable.
	return strings.Compare(a, b)
}
