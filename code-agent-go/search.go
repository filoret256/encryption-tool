// Project-wide search.
//
// ripgrep does the work when it is installed — it already honours .gitignore,
// skips binaries and is an order of magnitude faster than anything reachable
// from this process. Without it we fall back to `git ls-files -co
// --exclude-standard`, which gives the same file set (tracked + untracked,
// ignores applied) for free, and scan those files here.
//
// Results stream: the UI fills in as hits arrive rather than waiting for the
// whole tree, which is what makes a large repo feel usable.
package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"
)

type searchOpts struct {
	query      string
	matchCase  bool
	wholeWord  bool
	regex      bool
	include    string
	exclude    string
	maxMatches int
}

// Stop after this many matches so a stray "." cannot flood the socket.
const defaultMaxMatches = 5000

const maxSearchFileBytes = 2 * 1024 * 1024

// runSearch streams hits to emit and returns the summary. Cancellation is the
// caller's context: search-as-you-type supersedes its own requests constantly,
// and without this the code-agent would keep a dead scan (and a dead ripgrep)
// running for every keystroke.
//
// It takes the jail rather than a bare folder: the fallback opens every file it
// lists, and each of those has to be vouched for by the same containment check
// as any other read — see readSearchable.
func runSearch(ctx context.Context, j *jail, o searchOpts, ripgrep bool, emit func(searchHit)) searchSummary {
	root := j.root
	limit := o.maxMatches
	if limit == 0 {
		limit = defaultMaxMatches
	}
	engine := "fallback"
	if ripgrep {
		engine = "ripgrep"
	}
	if o.query == "" {
		return searchSummary{Engine: engine}
	}
	if ripgrep {
		return rgSearch(ctx, root, o, limit, emit)
	}
	return fallbackSearch(ctx, j, o, limit, emit)
}

// ── ripgrep ───────────────────────────────────────────────────────────────

type rgMessage struct {
	Type string `json:"type"`
	Data struct {
		Path       *struct{ Text *string } `json:"path"`
		Lines      *struct{ Text *string } `json:"lines"`
		LineNumber int                     `json:"line_number"`
		Submatches []struct {
			Start int `json:"start"`
			End   int `json:"end"`
		} `json:"submatches"`
	} `json:"data"`
}

func rgSearch(ctx context.Context, root string, o searchOpts, limit int, emit func(searchHit)) searchSummary {
	args := []string{"rg", "--json"}
	if o.matchCase {
		args = append(args, "-s")
	} else {
		args = append(args, "-i")
	}
	if o.wholeWord {
		args = append(args, "-w")
	}
	if !o.regex {
		args = append(args, "-F")
	}
	if o.include != "" {
		args = append(args, "-g", o.include)
	}
	if o.exclude != "" {
		args = append(args, "-g", "!"+o.exclude)
	}
	// -e keeps a pattern that begins with "-" from being read as a flag.
	args = append(args, "-e", o.query)

	// A child context so hitting the limit kills ripgrep instead of reading it
	// out to the end of a large repository.
	scanCtx, stop := context.WithCancel(ctx)
	defer stop()

	files := map[string]bool{}
	matches := 0
	truncated := false
	done := false

	_, _ = runLines(scanCtx, args, root, nil, func(line string) {
		if done || line == "" {
			return
		}
		var msg rgMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			return
		}
		if msg.Type != "match" {
			return
		}
		d := msg.Data
		// A non-UTF8 path or line arrives as base64 under a different key; there
		// is nothing useful to show for it.
		if d.Path == nil || d.Path.Text == nil || d.Lines == nil || d.Lines.Text == nil {
			return
		}
		path, text := *d.Path.Text, *d.Lines.Text

		stripped := strings.TrimSuffix(text, "\n")
		stripped = strings.TrimSuffix(stripped, "\r")
		ranges := [][2]int{}
		for _, s := range d.Submatches {
			ranges = append(ranges, [2]int{byteToUTF16(stripped, s.Start), byteToUTF16(stripped, s.End)})
		}

		files[path] = true
		if len(ranges) == 0 {
			matches++
		} else {
			matches += len(ranges)
		}
		col := 0
		if len(ranges) > 0 {
			col = ranges[0][0]
		}
		emit(searchHit{
			Path:   strings.ReplaceAll(path, "\x5c", "/"),
			Line:   d.LineNumber,
			Col:    col,
			Text:   stripped,
			Ranges: ranges,
		})
		if matches >= limit {
			truncated = true
			done = true
			stop()
		}
	})

	// A cancelled scan is a partial one; say so rather than reporting a complete
	// result the caller would take at face value.
	return searchSummary{
		Files:     len(files),
		Matches:   matches,
		Truncated: truncated || ctx.Err() != nil,
		Engine:    "ripgrep",
	}
}

// ── fallback ──────────────────────────────────────────────────────────────

// readSearchable returns the text of a file the listing named, or false when it
// is not to be scanned.
//
// The listing is a list of names, and a name is not a promise about where it
// leads: a symlink committed to the repository (`notes -> ~/.ssh/id_rsa`) is
// listed like any other file, and os.ReadFile follows it out of the workspace.
// The results carry the matching lines, so a search would have been a way to
// read a file the jail exists to keep out of reach. Every other op reads
// through toAbsExisting; this one did not, which is the whole of that hole.
// ripgrep does not follow links by default, so only this path was open.
//
// The size is checked before the read, not after. Reading a file and then
// finding it too large costs the whole file, and search-as-you-type would pay
// that for a tracked 500 MB dump on every keystroke. The read is capped as well
// as the stat, because a file can grow between the two. Anything that is not a
// regular file is skipped: opening a FIFO would block this goroutine for good.
func readSearchable(j *jail, rel string) ([]byte, bool) {
	abs, err := j.toAbsExisting(rel)
	if err != nil {
		return nil, false // outside the workspace, or inside the git directory
	}
	st, err := os.Stat(abs)
	if err != nil || !st.Mode().IsRegular() || st.Size() > maxSearchFileBytes {
		return nil, false // listed but gone, unreadable, or not worth reading
	}
	f, err := os.Open(abs) // #nosec G304 -- abs came from j.toAbsExisting, which is the containment check
	if err != nil {
		return nil, false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxSearchFileBytes+1))
	if err != nil || len(b) > maxSearchFileBytes || isBinary(b) {
		return nil, false
	}
	return b, true
}

func fallbackSearch(ctx context.Context, j *jail, o searchOpts, limit int, emit func(searchHit)) searchSummary {
	root := j.root
	paths := []string{}
	if r, err := run(ctx, readOnly("ls-files", "-co", "--exclude-standard", "-z"), root); err == nil && r.code == 0 {
		for _, p := range strings.Split(r.stdout, "\x00") {
			if p != "" {
				paths = append(paths, p)
			}
		}
	}

	src := o.query
	if !o.regex {
		src = regexp.QuoteMeta(src)
	}
	if o.wholeWord {
		src = `\b(?:` + src + `)\b`
	}
	if !o.matchCase {
		src = "(?i)" + src
	}
	// Go's regexp is RE2: it rejects backreferences and lookaround, which the
	// browser's engine accepts. The error surfaces to the UI as a normal search
	// failure rather than silently returning nothing.
	re, err := regexp.Compile(src)
	if err != nil {
		return searchSummary{Engine: "fallback"}
	}

	includeRe := globToRe(o.include)
	excludeRe := globToRe(o.exclude)

	files := map[string]bool{}
	matches := 0

	for _, rel := range paths {
		if ctx.Err() != nil {
			return searchSummary{Files: len(files), Matches: matches, Truncated: true, Engine: "fallback"}
		}
		if includeRe != nil && !includeRe.MatchString(rel) {
			continue
		}
		if excludeRe != nil && excludeRe.MatchString(rel) {
			continue
		}

		b, ok := readSearchable(j, rel)
		if !ok {
			continue
		}

		for i, text := range splitLines(string(b)) {
			found := re.FindAllStringIndex(text, -1)
			if len(found) == 0 {
				continue
			}
			ranges := make([][2]int, 0, len(found))
			for _, m := range found {
				ranges = append(ranges, [2]int{byteToUTF16(text, m[0]), byteToUTF16(text, m[1])})
			}
			files[rel] = true
			matches += len(ranges)
			emit(searchHit{Path: rel, Line: i + 1, Col: ranges[0][0], Text: text, Ranges: ranges})
			if matches >= limit {
				return searchSummary{Files: len(files), Matches: matches, Truncated: true, Engine: "fallback"}
			}
		}
	}
	return searchSummary{Files: len(files), Matches: matches, Truncated: false, Engine: "fallback"}
}

// splitLines splits on \n and drops one trailing \r, matching /\r?\n/.
func splitLines(s string) []string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSuffix(l, "\r")
	}
	return lines
}

// globToRe is minimal glob support for the include/exclude boxes: * and ** only.
func globToRe(glob string) *regexp.Regexp {
	if glob == "" {
		return nil
	}
	segs := strings.Split(glob, "/")
	for i, seg := range segs {
		if seg == "**" {
			segs[i] = ".*"
			continue
		}
		segs[i] = strings.ReplaceAll(regexp.QuoteMeta(seg), "\x5c*", "[^/]*")
	}
	src := strings.Join(segs, "/")
	re, err := regexp.Compile("^" + src + "$|(^|/)" + src + "($|/)")
	if err != nil {
		return nil
	}
	return re
}

// byteToUTF16 converts a byte offset within text to the UTF-16 code-unit index
// the browser uses to slice strings. Identical for ASCII, which is the
// overwhelming majority of what gets searched.
func byteToUTF16(text string, byteOffset int) int {
	if byteOffset <= 0 {
		return 0
	}
	if byteOffset > len(text) {
		byteOffset = len(text)
	}
	n := 0
	for _, r := range text[:byteOffset] {
		if r > 0xFFFF {
			n += 2 // a surrogate pair
		} else {
			n++
		}
	}
	return n
}
