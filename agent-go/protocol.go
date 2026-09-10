// Wire protocol shared with the browser client.
//
// The authoritative definition lives in src/agent/protocol.ts — the browser
// side is written against those types, so these structs exist to match them
// byte for byte on the wire. Every json tag here is load-bearing: a renamed
// field is a silently empty panel, not a compile error. scripts/protocol-check
// diffs the two files' field lists on every build so a drift cannot ship.
//
// Nullable fields are pointers on purpose. `size` on an empty file is 0 and
// must still be sent, while `size` on a directory must be absent — omitempty on
// a plain int cannot express that difference.
package main

import "encoding/json"

// ── frames ────────────────────────────────────────────────────────────────

type req struct {
	id     int64
	op     string
	params map[string]json.RawMessage
}

type resOK struct {
	ID   int64 `json:"id"`
	OK   bool  `json:"ok"`
	Data any   `json:"data"`
}

type resErr struct {
	ID    int64  `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

// Partial result of a long-running op (search hits, transfer progress).
type chunkFrame struct {
	ID    int64 `json:"id"`
	Chunk any   `json:"chunk"`
}

// Server-initiated message (filesystem watcher).
type pushFrame struct {
	Event string `json:"event"`
	Data  any    `json:"data"`
}

// ── op payloads ───────────────────────────────────────────────────────────

type agentInfo struct {
	Agent    string `json:"agent"`
	Version  string `json:"version"`
	Platform string `json:"platform"`
	Root     string `json:"root"`
	// Repository root relative to Root, or null when the folder is not a repo.
	Repo       *string `json:"repo"`
	GitVersion *string `json:"gitVersion"`
	// ripgrep is optional — without it search falls back to `git ls-files`.
	Ripgrep *string `json:"ripgrep"`
	// Recursive watching is unavailable on some hosts; UI hides live updates.
	Watch bool `json:"watch"`
}

type dirEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
	// Present for files only.
	Size  *int64 `json:"size,omitempty"`
	Mtime *int64 `json:"mtime,omitempty"`
	// True for symlinks; Dir then reflects the link target.
	Link bool `json:"link,omitempty"`
}

type fileRead struct {
	// utf-8 text, or null when the file is binary or over the size cap.
	Text     *string `json:"text"`
	Size     int64   `json:"size"`
	Mtime    int64   `json:"mtime"`
	Binary   bool    `json:"binary"`
	TooLarge bool    `json:"tooLarge"`
}

// One row of `git status --porcelain=v2`.
type statusEntry struct {
	Path string `json:"path"`
	// Previous path for renames/copies.
	From string `json:"from,omitempty"`
	// Index (staged) state: one of ".MADRCU"
	Index string `json:"index"`
	// Worktree (unstaged) state: one of ".MADRCU"
	Work      string `json:"work"`
	Untracked bool   `json:"untracked,omitempty"`
	Ignored   bool   `json:"ignored,omitempty"`
	Conflict  bool   `json:"conflict,omitempty"`
}

type gitStatus struct {
	Branch *string `json:"branch"`
	// null for a detached HEAD or an unborn branch.
	Upstream *string       `json:"upstream"`
	Ahead    int           `json:"ahead"`
	Behind   int           `json:"behind"`
	Oid      *string       `json:"oid"`
	Entries  []statusEntry `json:"entries"`
}

type commit struct {
	Oid     string   `json:"oid"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	Email   string   `json:"email"`
	// Author time, seconds since epoch.
	Time int64 `json:"time"`
	// Decoration from %D, e.g. "HEAD -> main, origin/main, tag: v2".
	Refs    string `json:"refs"`
	Subject string `json:"subject"`
}

type branch struct {
	// Full refname, e.g. "refs/heads/main" or "refs/remotes/origin/main".
	Ref string `json:"ref"`
	// Short display name, e.g. "main" or "origin/main".
	Name     string  `json:"name"`
	Oid      string  `json:"oid"`
	Upstream *string `json:"upstream"`
	Remote   bool    `json:"remote"`
	Head     bool    `json:"head"`
}

// A pair of texts for @codemirror/merge. Before/After are null when the file
// does not exist on that side (added / deleted).
type diffPair struct {
	Path        string  `json:"path"`
	Before      *string `json:"before"`
	After       *string `json:"after"`
	BeforeLabel string  `json:"beforeLabel"`
	AfterLabel  string  `json:"afterLabel"`
	Binary      bool    `json:"binary"`
}

type commitFile struct {
	Path    string `json:"path"`
	From    string `json:"from,omitempty"`
	Status  string `json:"status"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
	Binary  bool   `json:"binary"`
}

type commitDetail struct {
	Commit commit       `json:"commit"`
	Body   string       `json:"body"`
	Files  []commitFile `json:"files"`
}

type blameRow struct {
	Oid    string `json:"oid"`
	Author string `json:"author"`
	Time   int64  `json:"time"`
	Line   int    `json:"line"`
}

type searchHit struct {
	Path string `json:"path"`
	// 1-based.
	Line int `json:"line"`
	// 0-based column of the first match on the line.
	Col  int    `json:"col"`
	Text string `json:"text"`
	// [start, end) offsets of every match within Text.
	Ranges [][2]int `json:"ranges"`
}

type searchSummary struct {
	Files   int `json:"files"`
	Matches int `json:"matches"`
	// True when the scan stopped at the result cap.
	Truncated bool `json:"truncated"`
	// "ripgrep" or "fallback".
	Engine string `json:"engine"`
}
