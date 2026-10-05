package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// A listing asks about its entries in parallel, and a directory is not asked about at all. What
// has to stay the same is the answer: every entry, the order, a size and a time for files and
// none for directories.
func TestAListingKeepsItsAnswerWhenItsEntriesAreAskedAboutInParallel(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 300; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("f%03d.txt", i)), []byte("abc"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 20; i++ {
		if err := os.Mkdir(filepath.Join(root, fmt.Sprintf("d%02d", i)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	j, err := openJail(root)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := readDir(j, ".")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 320 {
		t.Fatalf("%d entries, want 320 (the .git directory is not listed)", len(entries))
	}
	for i, e := range entries {
		wantDir := i < 20
		if e.Dir != wantDir {
			t.Fatalf("entry %d (%s): dir is %v, want %v — directories come first", i, e.Name, e.Dir, wantDir)
		}
		if e.Dir && (e.Size != nil || e.Mtime != nil) {
			t.Fatalf("directory %s has a size or a time", e.Name)
		}
		if !e.Dir && (e.Size == nil || *e.Size != 3 || e.Mtime == nil) {
			t.Fatalf("file %s has no size of 3 and a time", e.Name)
		}
	}
	if entries[0].Name != "d00" || entries[20].Name != "f000.txt" || entries[319].Name != "f299.txt" {
		t.Fatalf("order is %s, %s, %s", entries[0].Name, entries[20].Name, entries[319].Name)
	}
}

// A symlink is still asked about, because stat follows it: a link to a directory is listed as one.
func TestALinkToADirectoryIsStillListedAsADirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "real"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "alias")); err != nil {
		t.Skip("this machine does not allow symbolic links:", err)
	}
	j, err := openJail(root)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := readDir(j, ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name == "alias" && (!e.Dir || !e.Link) {
			t.Fatalf("alias: dir %v, link %v, want both", e.Dir, e.Link)
		}
	}
}

func TestDeletingManyPathsRemovesThemAllAndChecksThemFirst(t *testing.T) {
	root := t.TempDir()
	var paths []string
	for i := 0; i < 200; i++ {
		name := fmt.Sprintf("f%03d.txt", i)
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, name)
	}
	j, err := openJail(root)
	if err != nil {
		t.Fatal(err)
	}
	// One path outside the workspace: nothing is removed, because every path is checked first.
	if err := deletePaths(j, append(append([]string{}, paths...), "../outside.txt")); err == nil {
		t.Fatal("a path outside the workspace was accepted")
	}
	if left, _ := os.ReadDir(root); len(left) != 200 {
		t.Fatalf("%d files left after a refused request, want all 200", len(left))
	}
	if err := deletePaths(j, paths); err != nil {
		t.Fatal(err)
	}
	if left, _ := os.ReadDir(root); len(left) != 0 {
		t.Fatalf("%d files left, want none", len(left))
	}
}
