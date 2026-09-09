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
func safeArg(v, what string) (string, error) {
	if v == "" || strings.HasPrefix(v, "-") {
		return "", &gitError{"Invalid " + what + ": " + v}
	}
	return v, nil
}

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

func gitReset(ctx context.Context, cwd, oid, mode string) (any, error) {
	o, err := safeArg(oid, "commit")
	if err != nil {
		return nil, err
	}
	return gitOut(ctx, cwd, "reset", "--"+mode, o)
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
	var args []string
	if action == "start" {
		r, err := safeArg(ref, "ref")
		if err != nil {
			return nil, err
		}
		args = []string{"git", "rebase", r}
	} else {
		args = []string{"git", "rebase", "--" + action}
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
		r, err := safeArg(o.remote, "remote")
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

func gitRemotes(ctx context.Context, cwd string) (any, error) {
	out, err := gitOut(ctx, cwd, "remote", "-v")
	if err != nil {
		return nil, err
	}
	type entry struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	// Keyed by name, last one wins, insertion order preserved — the same shape
	// the TypeScript agent gets from a Map.
	at := map[string]int{}
	list := []entry{}
	for _, line := range strings.Split(out, "\n") {
		if m := remoteLine.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			if i, ok := at[m[1]]; ok {
				list[i].URL = m[2]
				continue
			}
			at[m[1]] = len(list)
			list = append(list, entry{Name: m[1], URL: m[2]})
		}
	}
	return list, nil
}

// gitIdentity surfaces the check the UI runs before showing the commit box —
// `git commit` refuses to run without one.
func gitIdentity(ctx context.Context, cwd string) (any, error) {
	one := func(key string) *string {
		r, err := run(ctx, []string{"git", "config", "--get", key}, cwd)
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
