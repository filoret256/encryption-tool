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

// readOnly builds the argv for a git command that only reads.
//
// `git status` is not a pure read: it refreshes the index and writes the
// updated stat cache back to `.git/index`. The watcher sees a write under
// `.git`, the UI refreshes status, branches and history, those run `git status`
// again — and the three panels rebuild once a second forever, with no user
// action anywhere in the loop. `--no-optional-locks` tells git to skip exactly
// the writes it performs only as an optimisation, so a read stays a read; the
// same flag is why other editors do not sit in this loop. git 2.15 and newer.
//
// Writes must not use it: they need the lock they are taking.
func readOnly(args ...string) []string {
	return append([]string{"git", "--no-optional-locks"}, args...)
}

func gitOut(ctx context.Context, cwd string, args ...string) (string, error) {
	r, err := run(ctx, readOnly(args...), cwd)
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
	r, err := run(ctx, readOnly("rev-parse", "--show-toplevel"), cwd)
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
	// skip is what makes "load more" a page rather than a bigger request: the
	// history view used to raise its limit and re-ask for the whole window, so
	// the tenth page walked the first nine again and parsed them again.
	skip int
}

func gitLog(ctx context.Context, cwd string, o logOpts) ([]commit, error) {
	limit := o.limit
	if limit == 0 {
		limit = 200
	}
	args := []string{"log", "--date-order", "--format=" + logFmt, "-n" + strconv.Itoa(limit)}
	// A number, never a string, so there is nothing here for safeArg to screen.
	if o.skip > 0 {
		args = append(args, "--skip="+strconv.Itoa(o.skip))
	}
	if o.all {
		args = append(args, "--all")
	} else if o.ref != "" {
		r, err := safeArg(o.ref, "ref")
		if err != nil {
			return nil, err
		}
		args = append(args, r)
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

// %(upstream:track) reads "[ahead 1, behind 2]"; either half may be absent.
var (
	aheadRe  = regexp.MustCompile(`ahead (\d+)`)
	behindRe = regexp.MustCompile(`behind (\d+)`)
)

// gitCheckIgnore reports which of paths git would ignore.
//
// Asked a directory at a time: the explorer dims a folder's contents, and one
// call per file would be one spawn per row.
//
// The paths go in on stdin rather than in the argv. -z is what makes the answer
// parseable for a path containing a newline, and git accepts -z only together
// with --stdin — but stdin is also the only inlet with no length limit, and a
// directory of ten thousand entries would otherwise be an argv too long for the
// platform to spawn.
//
// No --no-index: a tracked file is not ignored however well it matches a
// pattern, and that is precisely the distinction the explorer is drawing.
func gitCheckIgnore(ctx context.Context, cwd string, paths []string) ([]string, error) {
	out := []string{}
	if len(paths) == 0 {
		return out, nil
	}
	p, err := safeArgs(paths, "path")
	if err != nil {
		return nil, err
	}
	r, err := runStdin(ctx, readOnly("check-ignore", "-z", "--stdin"), cwd, strings.Join(p, "\x00"))
	if err != nil {
		return nil, err
	}
	// 0 = some are ignored, 1 = none are. Anything else is a real failure.
	if r.code != 0 && r.code != 1 {
		if r.stderr != "" {
			return nil, &gitError{r.stderr}
		}
		return nil, &gitError{r.stdout}
	}
	for _, s := range strings.Split(r.stdout, "\x00") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out, nil
}

// gitReflog is where HEAD has been — the undo list.
//
// Every ref movement git makes is recorded here, including the ones with no
// other way back: a `reset --hard` that threw away a commit leaves the commit
// itself intact and only this remembers its name. So the UI's "undo the last
// operation" is a reflog entry plus the reset onto it, and this is the half
// that has to exist first.
func gitReflog(ctx context.Context, cwd string, limit int) ([]reflogEntry, error) {
	if limit < 1 {
		limit = 50
	}
	// No --date: it rewrites %gd from the ordinal HEAD@{0} into a timestamp form,
	// and the ordinal is the half that can be passed back to reset. The time
	// comes from %ct, which --date does not touch.
	out, err := gitOut(ctx, cwd, "reflog", "-n"+strconv.Itoa(limit), "--format=%gd%x1f%H%x1f%gs%x1f%ct")
	if err != nil {
		return nil, err
	}
	entries := []reflogEntry{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		p := strings.Split(line, fldSep)
		t, _ := strconv.ParseInt(field(p, 3), 10, 64)
		// "commit: subject", "reset: moving to …", "checkout: moving from a to b"
		action, message, found := strings.Cut(field(p, 2), ": ")
		if !found {
			action, message = "", field(p, 2)
		}
		entries = append(entries, reflogEntry{
			Selector: field(p, 0),
			Oid:      field(p, 1),
			Action:   action,
			Message:  message,
			Time:     t,
		})
	}
	return entries, nil
}

func gitBranches(ctx context.Context, cwd string) ([]branch, error) {
	// upstream:track prints "[ahead 1, behind 2]", "[gone]" or nothing;
	// creatordate rather than committerdate because it is also defined for
	// annotated tag objects, which have no committer.
	out, err := gitOut(ctx, cwd, "for-each-ref",
		"--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(upstream:track)%00%(creatordate:unix)",
		"refs/heads", "refs/remotes", "refs/tags")
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
		for _, prefix := range []string{"refs/heads/", "refs/remotes/", "refs/tags/"} {
			if strings.HasPrefix(name, prefix) {
				name = name[len(prefix):]
				break
			}
		}
		var up *string
		if u := field(p, 2); u != "" {
			up = strPtr(u)
		}
		ahead, behind := 0, 0
		if m := aheadRe.FindStringSubmatch(field(p, 4)); m != nil {
			ahead, _ = strconv.Atoi(m[1])
		}
		if m := behindRe.FindStringSubmatch(field(p, 4)); m != nil {
			behind, _ = strconv.Atoi(m[1])
		}
		when, _ := strconv.ParseInt(field(p, 5), 10, 64)
		list = append(list, branch{
			Ref:      ref,
			Name:     name,
			Oid:      field(p, 1),
			Upstream: up,
			Remote:   strings.HasPrefix(ref, "refs/remotes/"),
			Head:     strings.TrimSpace(field(p, 3)) == "*",
			Tag:      strings.HasPrefix(ref, "refs/tags/"),
			Ahead:    ahead,
			Behind:   behind,
			Time:     when,
		})
	}
	return list, nil
}

func gitCommitDetail(ctx context.Context, cwd, oid string) (*commitDetail, error) {
	oid, err := safeArg(oid, "commit")
	if err != nil {
		return nil, err
	}
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
	rev, err := safeOptArg(rev, "revision")
	if err != nil {
		return nil, false, err
	}
	spec := ":" + path
	if rev != "" {
		spec = rev + ":" + path
	}
	code, bytes, _, err := runBytes(ctx, readOnly("show", spec), cwd)
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

	// Anything else is a commit-ish, which means it is client data reaching an
	// argv — the one branch here that has to be checked.
	rev, err := safeArg(kind, "commit")
	if err != nil {
		return nil, err
	}
	before, bBin, err := blobAt(ctx, cwd, rev+"^", path)
	if err != nil {
		return nil, err
	}
	after, aBin, err := blobAt(ctx, cwd, rev, path)
	if err != nil {
		return nil, err
	}
	short := rev
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
