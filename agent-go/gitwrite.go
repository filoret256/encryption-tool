// Git mutations and remote operations.
//
// Two rules hold throughout:
//   - no value coming from the client may start with "-", or git would read it
//     as an option (`--upload-pack=…`, `-c core.sshCommand=…` are the sharp
//     ones); safeArg rejects those before the spawn;
//   - paths are always passed after `--`.
//
// Credentials are deliberately absent: the system git picks up the platform
// credential helper and the user's SSH agent, so no token ever reaches this
// process or the browser.
package main

import (
	"context"
	"regexp"
	"strings"
	"sync"
)

// safeArg rejects option-looking values; everything else git treats as data.
//
// Git reads any argument beginning with "-" as an option, and several of those
// do considerably more than pick a revision: --output=<file> is a diff option,
// which means `log` and `show` both accept it, and it writes wherever it is
// pointed — outside the workspace the jail exists to guard. So this is applied
// in the read operations (git.go) as much as in the writing ones here.
func safeArg(v, what string) (string, error) {
	if v == "" || strings.HasPrefix(v, "-") {
		return "", &gitError{"Invalid " + what + ": " + v}
	}
	return v, nil
}

// safeOptArg is safeArg for a value whose absence is meaningful: "" means "not
// given" and passes through, anything actually present is checked.
func safeOptArg(v, what string) (string, error) {
	if v == "" {
		return "", nil
	}
	return safeArg(v, what)
}

// oneOfArg accepts one of a fixed set. Used where the value is not data but a
// choice — a reset mode, a rebase action — and the legitimate answers are known
// and few. Rejecting a leading "-" is not enough there, because the value is
// concatenated into the flag itself.
func oneOfArg(v string, allowed []string, what string) (string, error) {
	for _, a := range allowed {
		if a == v {
			return v, nil
		}
	}
	return "", &gitError{"Invalid " + what + ": " + v}
}

var (
	resetModes    = []string{"soft", "mixed", "hard"}
	rebaseActions = []string{"start", "continue", "abort", "skip"}
	stashActions  = []string{"push", "pop", "apply", "drop", "list", "clear"}
	remoteActions = []string{"fetch", "pull", "push"}
)

func safeArgs(vs []string, what string) ([]string, error) {
	out := make([]string, 0, len(vs))
	for _, v := range vs {
		s, err := safeArg(v, what)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

// ── index ─────────────────────────────────────────────────────────────────

func gitStage(ctx context.Context, cwd string, paths []string) (any, error) {
	p, err := safeArgs(paths, "path")
	if err != nil {
		return nil, err
	}
	return gitOut(ctx, cwd, append([]string{"add", "--"}, p...)...)
}

// gitUnstage falls back to removing the entry outright: on an unborn branch
// there is no HEAD to reset against.
func gitUnstage(ctx context.Context, cwd string, paths []string) (any, error) {
	p, err := safeArgs(paths, "path")
	if err != nil {
		return nil, err
	}
	r, err := run(ctx, append([]string{"git", "restore", "--staged", "--"}, p...), cwd)
	if err != nil {
		return nil, err
	}
	if r.code == 0 {
		return r.stdout, nil
	}
	return gitOut(ctx, cwd, append([]string{"rm", "--cached", "-r", "--"}, p...)...)
}

// gitDiscard throws away worktree changes. Staged-but-untracked files go too.
func gitDiscard(ctx context.Context, cwd string, paths []string) (any, error) {
	p, err := safeArgs(paths, "path")
	if err != nil {
		return nil, err
	}
	return gitOut(ctx, cwd, append([]string{"checkout", "--"}, p...)...)
}

// gitApplyPatch applies a unified diff to the index, or takes one back out.
//
// This is what stage-this-hunk is made of. The patch is a document, not an
// argument: it arrives on stdin, which is why run grew runStdin for it. Always
// --cached, so the worktree is never touched — the caller staged or unstaged a
// hunk, and their open buffer must come out of it unchanged.
//
// reverse is unstage: the same patch read backwards out of the index.
//
// --unidiff-zero is deliberately absent. Applying a zero-context patch is
// guesswork about where it goes, and guessing wrong here silently stages
// something the user did not point at; the client builds patches with context
// and this refuses the ones without.
func gitApplyPatch(ctx context.Context, cwd, patch string, reverse bool) (any, error) {
	if strings.TrimSpace(patch) == "" {
		return nil, &gitError{"Patch is empty"}
	}
	args := []string{"git", "apply", "--cached", "--whitespace=nowarn"}
	if reverse {
		args = append(args, "--reverse")
	}
	r, err := runStdin(ctx, args, cwd, patch)
	if err != nil {
		return nil, err
	}
	if r.code != 0 {
		if r.stderr != "" {
			return nil, &gitError{r.stderr}
		}
		return nil, &gitError{r.stdout}
	}
	return r.stdout, nil
}

// gitMarkResolved marks a conflicted file resolved once the user has edited
// the markers out.
func gitMarkResolved(ctx context.Context, cwd string, paths []string) (any, error) {
	return gitStage(ctx, cwd, paths)
}

func gitCommit(ctx context.Context, cwd, message string, amend, all bool) (any, error) {
	if strings.TrimSpace(message) == "" && !amend {
		return nil, &gitError{"Commit message is required"}
	}
	args := []string{"commit", "-m", message}
	if amend {
		args = append(args, "--amend")
	}
	if all {
		args = append(args, "-a")
	}
	return gitOut(ctx, cwd, args...)
}

// ── branches / refs ───────────────────────────────────────────────────────

func gitCheckout(ctx context.Context, cwd, ref string) (any, error) {
	r, err := safeArg(ref, "ref")
	if err != nil {
		return nil, err
	}
	return gitOut(ctx, cwd, "checkout", r)
}

func gitBranchCreate(ctx context.Context, cwd, name, from string) (any, error) {
	n, err := safeArg(name, "branch")
	if err != nil {
		return nil, err
	}
	args := []string{"switch", "-c", n}
	if from != "" {
		f, err := safeArg(from, "ref")
		if err != nil {
			return nil, err
		}
		args = append(args, f)
	}
	return gitOut(ctx, cwd, args...)
}

func gitBranchDelete(ctx context.Context, cwd, name string, force bool) (any, error) {
	n, err := safeArg(name, "branch")
	if err != nil {
		return nil, err
	}
	flag := "-d"
	if force {
		flag = "-D"
	}
	return gitOut(ctx, cwd, "branch", flag, n)
}

func gitBranchRename(ctx context.Context, cwd, from, to string) (any, error) {
	f, err := safeArg(from, "branch")
	if err != nil {
		return nil, err
	}
	t, err := safeArg(to, "branch")
	if err != nil {
		return nil, err
	}
	return gitOut(ctx, cwd, "branch", "-m", f, t)
}

// The mode is concatenated into the flag, so it is checked against the list
// rather than merely screened for a leading "-".
func gitReset(ctx context.Context, cwd, oid, mode string) (any, error) {
	m, err := oneOfArg(mode, resetModes, "reset mode")
	if err != nil {
		return nil, err
	}
	o, err := safeArg(oid, "commit")
	if err != nil {
		return nil, err
	}
	return gitOut(ctx, cwd, "reset", "--"+m, o)
}

func gitRevert(ctx context.Context, cwd, oid string) (any, error) {
	o, err := safeArg(oid, "commit")
	if err != nil {
		return nil, err
	}
	return gitOut(ctx, cwd, "revert", "--no-edit", o)
}

func gitCherryPick(ctx context.Context, cwd, oid string) (any, error) {
	o, err := safeArg(oid, "commit")
	if err != nil {
		return nil, err
	}
	return gitOut(ctx, cwd, "cherry-pick", o)
}

// ── merge / rebase ────────────────────────────────────────────────────────

type mergeResult struct {
	Conflict bool   `json:"conflict"`
	Output   string `json:"output"`
}

var conflictRe = regexp.MustCompile(`(?i)conflict`)
var rebaseConflictRe = regexp.MustCompile(`(?i)conflict|could not apply`)

// gitMerge expects to fail on conflict: git leaves conflict markers in the
// worktree and a non-zero exit. That is reported as data, not as an error, so
// the UI can open the conflict resolver instead of a toast.
func gitMerge(ctx context.Context, cwd, ref string, noFf bool) (any, error) {
	r, err := safeArg(ref, "ref")
	if err != nil {
		return nil, err
	}
	args := []string{"git", "merge", "--no-edit"}
	if noFf {
		args = append(args, "--no-ff")
	}
	args = append(args, r)

	res, err := run(ctx, args, cwd)
	if err != nil {
		return nil, err
	}
	output := strings.TrimSpace(res.stdout + res.stderr)
	if res.code == 0 {
		return mergeResult{Conflict: false, Output: output}, nil
	}
	if conflictRe.MatchString(output) {
		return mergeResult{Conflict: true, Output: output}, nil
	}
	return nil, &gitError{output}
}

func gitMergeAbort(ctx context.Context, cwd string) (any, error) {
	return gitOut(ctx, cwd, "merge", "--abort")
}

func gitRebase(ctx context.Context, cwd, action, ref string) (any, error) {
	a, err := oneOfArg(action, rebaseActions, "rebase action")
	if err != nil {
		return nil, err
	}
	var args []string
	if a == "start" {
		r, err := safeArg(ref, "ref")
		if err != nil {
			return nil, err
		}
		args = []string{"git", "rebase", r}
	} else {
		args = []string{"git", "rebase", "--" + a}
	}

	res, err := run(ctx, args, cwd)
	if err != nil {
		return nil, err
	}
	output := strings.TrimSpace(res.stdout + res.stderr)
	if res.code == 0 {
		return mergeResult{Conflict: false, Output: output}, nil
	}
	if rebaseConflictRe.MatchString(output) {
		return mergeResult{Conflict: true, Output: output}, nil
	}
	return nil, &gitError{output}
}

// ── stash ─────────────────────────────────────────────────────────────────

func gitStash(ctx context.Context, cwd, action, message, ref string) (any, error) {
	// The default branch passes the action through as a git subcommand, so this
	// is a fixed list rather than a type assertion the wire never honoured.
	action, err := oneOfArg(action, stashActions, "stash action")
	if err != nil {
		return nil, err
	}
	switch action {
	case "push":
		args := []string{"stash", "push", "--include-untracked"}
		if message != "" {
			args = append(args, "-m", message)
		}
		return gitOut(ctx, cwd, args...)
	case "list":
		return gitOut(ctx, cwd, "stash", "list", "--format=%gd%x00%ct%x00%gs")
	case "clear":
		return gitOut(ctx, cwd, "stash", "clear")
	default:
		args := []string{"stash", action}
		if ref != "" {
			r, err := safeArg(ref, "stash ref")
			if err != nil {
				return nil, err
			}
			args = append(args, r)
		}
		return gitOut(ctx, cwd, args...)
	}
}

// ── remotes ───────────────────────────────────────────────────────────────

type remoteOpts struct {
	remote      string
	ref         string
	setUpstream bool
	force       bool
}

// gitRemote streams fetch/pull/push progress, which git writes to stderr, so
// the UI shows a live log instead of freezing until the transfer ends.
func gitRemote(ctx context.Context, cwd, action string, o remoteOpts, onProgress func(string)) (any, error) {
	// The action is the git subcommand itself, so it comes off a list.
	action, err := oneOfArg(action, remoteActions, "remote action")
	if err != nil {
		return nil, err
	}
	args := []string{"git", action, "--progress"}
	if action == "fetch" {
		args = append(args, "--prune")
	}
	if action == "push" && o.setUpstream {
		args = append(args, "--set-upstream")
	}
	// --force-with-lease refuses to clobber commits this clone has not seen.
	if action == "push" && o.force {
		args = append(args, "--force-with-lease")
	}
	if o.remote != "" {
		r, err := knownRemote(ctx, cwd, o.remote)
		if err != nil {
			return nil, err
		}
		args = append(args, r)
	}
	if o.ref != "" {
		r, err := safeArg(o.ref, "ref")
		if err != nil {
			return nil, err
		}
		args = append(args, r)
	}

	var mu sync.Mutex
	lines := []string{}
	collect := func(line string) {
		mu.Lock()
		lines = append(lines, line)
		mu.Unlock()
		onProgress(line)
	}

	code, err := runLines(ctx, args, cwd, collect, collect)
	if err != nil {
		return nil, err
	}
	mu.Lock()
	output := strings.TrimSpace(strings.Join(lines, "\n"))
	mu.Unlock()
	if code != 0 {
		return nil, &gitError{output}
	}
	return map[string]string{"output": output}, nil
}

var remoteLine = regexp.MustCompile(`^(\S+)\s+(\S+)\s+\(fetch\)$`)

type remoteEntry struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

func remoteList(ctx context.Context, cwd string) ([]remoteEntry, error) {
	out, err := gitOut(ctx, cwd, "remote", "-v")
	if err != nil {
		return nil, err
	}
	// Keyed by name, last one wins, insertion order preserved — the same shape
	// the TypeScript agent gets from a Map.
	at := map[string]int{}
	list := []remoteEntry{}
	for _, line := range strings.Split(out, "\n") {
		if m := remoteLine.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			if i, ok := at[m[1]]; ok {
				list[i].URL = m[2]
				continue
			}
			at[m[1]] = len(list)
			list = append(list, remoteEntry{Name: m[1], URL: m[2]})
		}
	}
	return list, nil
}

func gitRemotes(ctx context.Context, cwd string) (any, error) {
	return remoteList(ctx, cwd)
}

// knownRemote resolves a remote *name*, and only a name.
//
// Git reads the <repository> argument as a URL whenever it is not a configured
// remote, so an unchecked value here is `git push https://…  HEAD` — the user's
// repository handed to whoever asked for it, and `git fetch` pulling back
// whatever they choose to serve. Screening for a leading "-" does not catch
// that; being on the repository's own remote list does.
func knownRemote(ctx context.Context, cwd, name string) (string, error) {
	wanted, err := safeArg(name, "remote")
	if err != nil {
		return "", err
	}
	known, err := remoteList(ctx, cwd)
	if err != nil {
		return "", err
	}
	for _, r := range known {
		if r.Name == wanted {
			return wanted, nil
		}
	}
	return "", &gitError{"Unknown remote: " + wanted}
}

var (
	remoteNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	urlSchemeRe  = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9+.-]*)://`)
	scpLikeRe    = regexp.MustCompile(`^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?:[^\s]+$`)
	windowsPath  = regexp.MustCompile(`^[A-Za-z]:[\\/]`)
)

// newRemoteName checks a remote name the user is about to create. Unlike
// knownRemote there is nothing to check it against yet, so the shape is checked
// instead: git's own rules for a ref component, which is what it becomes.
func newRemoteName(name string) (string, error) {
	n, err := safeArg(name, "remote")
	if err != nil {
		return "", err
	}
	if !remoteNameRe.MatchString(n) || strings.HasSuffix(n, ".lock") {
		return "", &gitError{"Invalid remote name: " + n}
	}
	return n, nil
}

// safeRemoteURL screens a remote URL before it is written into .git/config.
//
// This is the one place the client hands over something git will later execute
// against. `<transport>::<address>` makes git run `git-remote-<transport>`, and
// `ext::sh -c whoami` is the documented way to spell "run this" — the fetch path
// already refuses those, but a URL stored in the config is fetched by name
// afterwards and would sail straight past that check.
//
// So the allowed set is the transports that move bytes over a network and
// nothing else. A local path is refused too: `git fetch /some/other/repo` would
// pull a repository from outside the workspace into this one, where the page can
// then read it — the jail exists to make exactly that impossible.
func safeRemoteURL(url string) (string, error) {
	u, err := safeArg(url, "remote URL")
	if err != nil {
		return "", err
	}
	if strings.Contains(u, "::") {
		return "", &gitError{"Unsupported remote URL: " + u}
	}
	if m := urlSchemeRe.FindStringSubmatch(u); m != nil {
		switch strings.ToLower(m[1]) {
		case "https", "http", "ssh", "git":
			return u, nil
		}
		return "", &gitError{"Unsupported remote URL: " + u}
	}
	// scp-like: [user@]host:path — the form every ssh remote is written in.
	if scpLikeRe.MatchString(u) && !windowsPath.MatchString(u) {
		return u, nil
	}
	return "", &gitError{"Unsupported remote URL: " + u}
}

var remoteAdminActions = []string{"add", "rename", "remove"}

// gitRemoteAdmin adds, renames or removes a remote. Fetching through one is
// gitRemote above; this is the configuration behind it.
func gitRemoteAdmin(ctx context.Context, cwd, action, name, url, to string) (any, error) {
	verb, err := oneOfArg(action, remoteAdminActions, "remote admin action")
	if err != nil {
		return nil, err
	}
	switch verb {
	case "add":
		n, err := newRemoteName(name)
		if err != nil {
			return nil, err
		}
		u, err := safeRemoteURL(url)
		if err != nil {
			return nil, err
		}
		return gitOut(ctx, cwd, "remote", "add", n, u)
	case "rename":
		// The source must exist, the destination must merely be a legal name.
		from, err := knownRemote(ctx, cwd, name)
		if err != nil {
			return nil, err
		}
		n, err := newRemoteName(to)
		if err != nil {
			return nil, err
		}
		return gitOut(ctx, cwd, "remote", "rename", from, n)
	default:
		n, err := knownRemote(ctx, cwd, name)
		if err != nil {
			return nil, err
		}
		return gitOut(ctx, cwd, "remote", "remove", n)
	}
}

// ── tags ──────────────────────────────────────────────────────────────────

// gitTagCreate creates a tag. With a message it is an annotated tag — an object
// of its own with an author and a date — which is what a release wants; without
// one it is a lightweight pointer, which is what a bookmark wants.
func gitTagCreate(ctx context.Context, cwd, name, ref, message string, force bool) (any, error) {
	args := []string{"tag"}
	if force {
		args = append(args, "--force")
	}
	if strings.TrimSpace(message) != "" {
		args = append(args, "-a", "-m", message)
	}
	n, err := safeArg(name, "tag")
	if err != nil {
		return nil, err
	}
	args = append(args, n)
	if ref != "" {
		r, err := safeArg(ref, "ref")
		if err != nil {
			return nil, err
		}
		args = append(args, r)
	}
	return gitOut(ctx, cwd, args...)
}

func gitTagDelete(ctx context.Context, cwd, name string) (any, error) {
	n, err := safeArg(name, "tag")
	if err != nil {
		return nil, err
	}
	return gitOut(ctx, cwd, "tag", "-d", n)
}

// gitIdentity surfaces the check the UI runs before showing the commit box —
// `git commit` refuses to run without one.
func gitIdentity(ctx context.Context, cwd string) (any, error) {
	one := func(key string) *string {
		r, err := run(ctx, readOnly("config", "--get", key), cwd)
		if err != nil || r.code != 0 {
			return nil
		}
		if v := strings.TrimSpace(r.stdout); v != "" {
			return &v
		}
		return nil
	}
	return map[string]*string{"name": one("user.name"), "email": one("user.email")}, nil
}
