// Who else can read the files that hold the secrets.
//
// A password in kafka-agent.yaml, a key in a keystore, a token in a file named
// by ${file:…}: each is exactly as private as the file's permissions. A config
// written with the editor's default (0644) on a shared machine is a password
// every other account can read, and nothing in the agent's behaviour would ever
// say so. So at startup and on every reload the agent looks, and says — once,
// with the command that fixes it. It does not refuse to run: the operator may
// know their machine, and a warning that stopped the agent would be turned off.
//
// Unix permission bits only. On Windows the mode bits say nothing about who can
// read a file (that is an ACL), and a warning built on them would be wrong in
// both directions, so there is none.
package main

import (
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"sort"
)

// permWarning is the sentence for one file, or "" when only its owner can read it.
func permWarning(path string, mode fs.FileMode) string {
	if mode.Perm()&0o077 == 0 {
		return ""
	}
	who := "other users"
	switch {
	case mode.Perm()&0o007 != 0:
		who = "every user on this machine"
	case mode.Perm()&0o070 != 0:
		who = "its group"
	}
	return fmt.Sprintf("%s is readable by %s (mode %04o) and holds secrets — chmod 600 %s", path, who, mode.Perm(), path)
}

// permissionWarnings checks each file, once, in path order. stat and goos are
// parameters so the rule can be tested on any machine.
func permissionWarnings(paths []string, stat func(string) (fs.FileMode, error), goos string) []string {
	if goos == "windows" {
		return nil
	}
	seen := map[string]bool{}
	var unique []string
	for _, p := range paths {
		if p != "" && !seen[p] {
			seen[p] = true
			unique = append(unique, p)
		}
	}
	sort.Strings(unique)

	var out []string
	for _, p := range unique {
		mode, err := stat(p)
		if err != nil || !mode.IsRegular() {
			continue // a missing file is reported by the code that needed it
		}
		if w := permWarning(p, mode); w != "" {
			out = append(out, w)
		}
	}
	return out
}

func statMode(path string) (fs.FileMode, error) {
	st, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return st.Mode(), nil
}

// checkPermissions is permissionWarnings for the real machine.
func checkPermissions(paths []string) []string {
	return permissionWarnings(paths, statMode, runtime.GOOS)
}
