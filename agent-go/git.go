// Git queries — a thin, parsing-only layer over the system `git` binary.
//
// Every format string here was verified against git 2.55; the machine-readable
// variants (`--porcelain=v2 -z`, `for-each-ref` with %00, `--raw --numstat -z`)
// are used specifically because they are NUL-delimited and therefore safe for
// paths containing spaces or newlines.
package main

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

type gitError struct{ msg string }

func (e *gitError) Error() string {
	if s := strings.TrimSpace(e.msg); s != "" {
		return s
	}
	return "git failed"
}
func (e *gitError) errCode() string { return "EGIT" }

// %x1e between records, %x1f between fields — neither can occur in a ref name,
// an author name or a subject line.
const (
	recSep = "\x1e"
	fldSep = "\x1f"
	logFmt = "%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s"
)

func gitOut(ctx context.Context, cwd string, args ...string) (string, error) {
	r, err := run(ctx, append([]string{"git"}, args...), cwd)
	if err != nil {
		return "", err
	}
	if r.code != 0 {
		if r.stderr != "" {
			return "", &gitError{r.stderr}
		}
		return "", &gitError{r.stdout}
	}
	return r.stdout, nil
}

// field is a bounds-safe index; git omits trailing fields on some records and
// a missing one is empty, never a crash.
func field(parts []string, i int) string {
	if i < len(parts) {
		return parts[i]
	}
	return ""
}

// splitAt splits on sep at most n times, leaving the remainder in the last
// slot — git puts the path last precisely so it can contain the separator.
func splitAt(s, sep string, n int) []string { return strings.SplitN(s, sep, n+1) }

// repoRoot is the absolute path of the repository containing cwd, or "" when
// there is none.
func repoRoot(ctx context.Context, cwd string) string {
	r, err := run(ctx, []string{"git", "rev-parse", "--show-toplevel"}, cwd)
	if err != nil || r.code != 0 {
		return ""
	}
	return strings.TrimSpace(r.stdout)
}

// ── status ────────────────────────────────────────────────────────────────

var aheadBehind = regexp.MustCompile(`^\+(-?\d+) -(-?\d+)$`)

func gitStatusOf(ctx context.Context, cwd string) (*gitStatus, error) {
	out, err := gitOut(ctx, cwd, "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	f := strings.Split(out, "\x00")
	st := &gitStatus{Entries: []statusEntry{}}

	for i := 0; i < len(f); i++ {
		rec := f[i]
		if rec == "" {
			continue
		}

		if strings.HasPrefix(rec, "# ") {
			key, val, _ := strings.Cut(rec[2:], " ")
			switch key {
			case "branch.oid":
				if val != "(initial)" {
					st.Oid = strPtr(val)
				}
			case "branch.head":
				if val != "(detached)" {
					st.Branch = strPtr(val)
				}
			case "branch.upstream":
				st.Upstream = strPtr(val)
			case "branch.ab":
				if m := aheadBehind.FindStringSubmatch(val); m != nil {
					st.Ahead, _ = strconv.Atoi(m[1])
					st.Behind, _ = strconv.Atoi(m[2])
				}
			}
			continue
		}

		var e *statusEntry
		switch rec[0] {
		case '1':
			// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
			p := splitAt(rec, " ", 8)
			xy := field(p, 1)
			e = &statusEntry{Path: field(p, 8), Index: at(xy, 0), Work: at(xy, 1)}
		case '2':
			// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
			p := splitAt(rec, " ", 9)
			xy := field(p, 1)
			i++
			e = &statusEntry{Path: field(p, 9), From: field(f, i), Index: at(xy, 0), Work: at(xy, 1)}
		case 'u':
			// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
			p := splitAt(rec, " ", 10)
			xy := field(p, 1)
			e = &statusEntry{Path: field(p, 10), Index: at(xy, 0), Work: at(xy, 1), Conflict: true}
		case '?':
			e = &statusEntry{Path: rec[2:], Index: ".", Work: "?", Untracked: true}
		case '!':
			e = &statusEntry{Path: rec[2:], Index: ".", Work: ".", Ignored: true}
		}
		if e != nil {
			st.Entries = append(st.Entries, *e)
		}
	}
	return st, nil
}

// at returns one character of a status pair as a string, or "" if absent.
func at(s string, i int) string {
	if i < len(s) {
		return s[i : i+1]
	}
	return ""
}

// ── history ───────────────────────────────────────────────────────────────

func parseCommits(out string) []commit {
	list := []commit{}
	for _, rec := range strings.Split(out, recSep) {
		if strings.TrimSpace(rec) == "" {
			continue
		}
		p := strings.Split(rec, fldSep)
		t, _ := strconv.ParseInt(field(p, 4), 10, 64)
		parents := []string{}
		for _, x := range strings.Split(field(p, 1), " ") {
			if x != "" {
				parents = append(parents, x)
			}
		}
		list = append(list, commit{
			Oid:     field(p, 0),
			Parents: parents,
			Author:  field(p, 2),
			Email:   field(p, 3),
			Time:    t,
			Refs:    field(p, 5),
			Subject: strings.TrimRight(field(p, 6), "\n"),
		})
	}
	return list
}

type logOpts struct {
	ref   string
	limit int
	all   bool
	path  string
}

func gitLog(ctx context.Context, cwd string, o logOpts) ([]commit, error) {
	limit := o.limit
	if limit == 0 {
		limit = 200
	}
	args := []string{"log", "--date-order", "--format=" + logFmt, "-n" + strconv.Itoa(limit)}
	if o.all {
		args = append(args, "--all")
	} else if o.ref != "" {
		args = append(args, o.ref)
	}
	// `--` keeps a path that looks like a flag from being parsed as one.
	if o.path != "" {
		args = append(args, "--", o.path)
	}
	out, err := gitOut(ctx, cwd, args...)
	if err != nil {
		return nil, err
	}
	return parseCommits(out), nil
}

var remoteHead = regexp.MustCompile(`^refs/remotes/[^/]+/HEAD$`)

func gitBranches(ctx context.Context, cwd string) ([]branch, error) {
	out, err := gitOut(ctx, cwd, "for-each-ref",
		"--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)",
		"refs/heads", "refs/remotes")
	if err != nil {
		return nil, err
	}
	list := []branch{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		p := strings.Split(line, "\x00")
		ref := field(p, 0)
		// refs/remotes/<name>/HEAD is a symbolic pointer, not a branch users pick.
		if remoteHead.MatchString(ref) {
			continue
		}
		name := ref
		for _, prefix := range []string{"refs/heads/", "refs/remotes/"} {
			if strings.HasPrefix(name, prefix) {
				name = name[len(prefix):]
				break
			}
		}
		var up *string
		if u := field(p, 2); u != "" {
			up = strPtr(u)
		}
		list = append(list, branch{
			Ref:      ref,
			Name:     name,
			Oid:      field(p, 1),
			Upstream: up,
			Remote:   strings.HasPrefix(ref, "refs/remotes/"),
			Head:     strings.TrimSpace(field(p, 3)) == "*",
		})
	}
	return list, nil
}

func gitCommitDetail(ctx context.Context, cwd, oid string) (*commitDetail, error) {
	out, err := gitOut(ctx, cwd, "log", "-1", "--format="+logFmt, oid)
	if err != nil {
		return nil, err
	}
	commits := parseCommits(out)
	if len(commits) == 0 {
		return nil, &gitError{"unknown commit " + oid}
	}
	c := commits[0]

	// The body is fetched separately rather than appended to logFmt: it is free
	// text and may contain the record separator, which would corrupt the parse.
	bodyOut, err := gitOut(ctx, cwd, "log", "-1", "--format=%b", oid)
	if err != nil {
		return nil, err
	}

	args := []string{"show", "--no-color", "--format=", "--raw", "--numstat", "-z"}
	// A merge shows no diff by default; compare against its first parent instead.
	if len(c.Parents) > 1 {
		args = append(args, "-m", "--first-parent")
	}
	args = append(args, oid)
	filesOut, err := gitOut(ctx, cwd, args...)
	if err != nil {
		return nil, err
	}

	return &commitDetail{
		Commit: c,
		Body:   strings.TrimRight(bodyOut, "\n"),
		Files:  parseFileList(filesOut),
	}, nil
}

type numstat struct {
	added   int
	deleted int
	binary  bool
}

// parseFileList reads the interleaved `--raw` + `--numstat` sections of a -z
// diff. Raw records start with ':', numstat records with a digit or '-'.
func parseFileList(out string) []commitFile {
	f := strings.Split(out, "\x00")
	type ordered struct {
		status string
		path   string
		from   string
	}
	order := []ordered{}
	nums := map[string]numstat{}

	for i := 0; i < len(f); i++ {
		rec := f[i]
		if rec == "" {
			continue
		}

		if strings.HasPrefix(rec, ":") {
			// :<mSrc> <mDst> <hSrc> <hDst> <status>
			parts := strings.Fields(strings.TrimSpace(rec))
			letter := "M"
			if len(parts) > 0 {
				if last := parts[len(parts)-1]; last != "" {
					letter = last[:1]
				}
			}
			if letter == "R" || letter == "C" {
				i++
				from := field(f, i)
				i++
				order = append(order, ordered{status: letter, path: field(f, i), from: from})
			} else {
				i++
				order = append(order, ordered{status: letter, path: field(f, i)})
			}
			continue
		}

		// <added>\t<deleted>\t<path>   (path empty for renames -> two more fields)
		parts := splitAt(rec, "\t", 2) // limit 2: a filename may contain a tab
		binary := field(parts, 0) == "-"
		added, deleted := 0, 0
		if !binary {
			added, _ = strconv.Atoi(field(parts, 0))
			deleted, _ = strconv.Atoi(field(parts, 1))
		}
		path := field(parts, 2)
		if path == "" {
			i++ // skip the old path
			i++
			path = field(f, i)
		}
		if path != "" {
			nums[path] = numstat{added: added, deleted: deleted, binary: binary}
		}
	}

	files := []commitFile{}
	for _, o := range order {
		n := nums[o.path]
		files = append(files, commitFile{
			Path:    o.path,
			From:    o.from,
			Status:  o.status,
			Added:   n.added,
			Deleted: n.deleted,
			Binary:  n.binary,
		})
	}
	return files
}

// ── file contents ─────────────────────────────────────────────────────────

// blobAt is the text of path at revision rev, or nil when it does not exist
// there or is binary. rev is a commit-ish, or "" for the index (":<path>").
func blobAt(ctx context.Context, cwd, rev, path string) (*string, bool, error) {
	spec := ":" + path
	if rev != "" {
		spec = rev + ":" + path
	}
	code, bytes, _, err := runBytes(ctx, []string{"git", "show", spec}, cwd)
	if err != nil {
		return nil, false, err
	}
	if code != 0 {
		return nil, false, nil
	}
	if isBinary(bytes) {
		return nil, true, nil
	}
	return strPtr(string(bytes)), false, nil
}

// gitDiffPair builds the two sides for @codemirror/merge.
//
//	kind "worktree" — index vs file on disk (unstaged changes)
//	kind "staged"   — HEAD vs index (staged changes)
//	kind "head"     — last commit vs file on disk (everything since HEAD)
//	otherwise       — the commit-ish itself vs its first parent
func gitDiffPair(ctx context.Context, cwd, path, kind string, readWorktree func() *string) (*diffPair, error) {
	switch kind {
	case "worktree", "head":
		rev := ""
		label := "index"
		if kind == "head" {
			rev, label = "HEAD", "HEAD"
		}
		before, binary, err := blobAt(ctx, cwd, rev, path)
		if err != nil {
			return nil, err
		}
		return &diffPair{
			Path: path, Before: before, After: readWorktree(),
			BeforeLabel: label, AfterLabel: "working tree", Binary: binary,
		}, nil

	case "staged":
		before, bBin, err := blobAt(ctx, cwd, "HEAD", path)
		if err != nil {
			return nil, err
		}
		after, aBin, err := blobAt(ctx, cwd, "", path)
		if err != nil {
			return nil, err
		}
		return &diffPair{
			Path: path, Before: before, After: after,
			BeforeLabel: "HEAD", AfterLabel: "index", Binary: bBin || aBin,
		}, nil
	}

	before, bBin, err := blobAt(ctx, cwd, kind+"^", path)
	if err != nil {
		return nil, err
	}
	after, aBin, err := blobAt(ctx, cwd, kind, path)
	if err != nil {
		return nil, err
	}
	short := kind
	if len(short) > 8 {
		short = short[:8]
	}
	return &diffPair{
		Path: path, Before: before, After: after,
		BeforeLabel: short + "^", AfterLabel: short, Binary: bBin || aBin,
	}, nil
}

var blameHeader = regexp.MustCompile(`^([0-9a-f]{40}) \d+ (\d+)`)

func gitBlame(ctx context.Context, cwd, path string) ([]blameRow, error) {
	out, err := gitOut(ctx, cwd, "blame", "--line-porcelain", "--", path)
	if err != nil {
		return nil, err
	}
	rows := []blameRow{}
	var cur *blameRow
	for _, line := range strings.Split(out, "\n") {
		if m := blameHeader.FindStringSubmatch(line); m != nil {
			n, _ := strconv.Atoi(m[2])
			cur = &blameRow{Oid: m[1], Line: n}
			continue
		}
		if cur == nil {
			continue
		}
		switch {
		case strings.HasPrefix(line, "author "):
			cur.Author = line[len("author "):]
		case strings.HasPrefix(line, "author-time "):
			cur.Time, _ = strconv.ParseInt(line[len("author-time "):], 10, 64)
		case strings.HasPrefix(line, "\t"):
			rows = append(rows, *cur)
			cur = nil
		}
	}
	return rows, nil
}

func strPtr(s string) *string { return &s }
