// The loopback server: HTTP for the liveness probe, WebSocket for everything
// else, and the op table both the browser and the smoke test drive.
//
// Security posture (all four are load-bearing):
//  1. binds 127.0.0.1 only — never reachable from the network;
//  2. a token, printed at startup, is required on every connection;
//  3. the Origin header is checked against an allowlist — a token in
//     localStorage is only as good as the origins that can read it — and the
//     Host header against this code-agent's own name, which is what stops a rebound
//     DNS name from reaching it under someone else's;
//  4. every path is confined to the workspace by the jail.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"
)

// ── request parameter coercion ────────────────────────────────────────────
//
// The TypeScript code-agent funnels every parameter through String()/Boolean()/
// Number(), so a client that sends 5 where a string is expected gets "5" rather
// than an error. These helpers reproduce that exactly: the two code-agents must
// disagree about nothing, including their sloppiness.

func (r *req) value(key string) any {
	raw, ok := r.params[key]
	if !ok {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}

func jsString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return ""
}

func (r *req) str(key string) string { return jsString(r.value(key)) }

func (r *req) strs(key string) []string {
	arr, ok := r.value(key).([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		out = append(out, jsString(v))
	}
	return out
}

func (r *req) truthy(key string) bool {
	switch t := r.value(key).(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	}
	return true // arrays and objects are truthy in JavaScript
}

// number mirrors `Number(v) || fallback`: an unparseable or zero value falls
// through to the default, which is what the TypeScript side relies on.
func (r *req) number(key string, fallback int) int {
	switch t := r.value(key).(type) {
	case float64:
		if int(t) != 0 {
			return int(t)
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil && n != 0 {
			return n
		}
	}
	return fallback
}

// ── connections ───────────────────────────────────────────────────────────

// How many child processes one connection may have running at once.
//
// search and every git op spawn one. Search-as-you-type issues a request per
// keystroke, and nothing bounded how many of those could be running: the cap
// turns a burst into a queue instead of a fork bomb. Four is enough that no
// single slow scan blocks the panel a user is looking at.
const maxConcurrentProcs = 4

// How many requests one connection may have started and not finished.
//
// Every request runs on a goroutine of its own so that a slow one never holds
// up the rest, and nothing bounded how many there could be: a client sending
// fs.read as fast as the socket would carry it queued a 4 MB buffer per
// request, with no ceiling but memory. A page that behaves stays a long way
// below this — search-as-you-type cancels the request it replaces — so the
// number is not a budget, it is where "a burst" becomes "something is wrong",
// and past it a request is refused with EBUSY rather than queued.
const maxInflightOps = 128

// spawnsProcess reports whether an op starts a child process, and so is worth
// counting against the cap.
func spawnsProcess(op string) bool {
	return op == "search" || strings.HasPrefix(op, "git.")
}

type connection struct {
	ws *wsConn

	// The queue behind maxConcurrentProcs: a send takes a slot, a receive gives
	// it back. Blocking on a full buffer is the wait, and it always ends —
	// closing the connection cancels every running op, which frees the slots.
	slots chan struct{}

	mu       sync.Mutex
	watcher  *watcher
	inflight map[int64]context.CancelFunc
}

func (c *connection) send(frame any) {
	b, err := json.Marshal(frame)
	if err != nil {
		return
	}
	_ = c.ws.sendText(b)
}

type opCtx struct {
	ctx  context.Context
	jail *jail
	// cwd for git — the repository root, which is also the workspace root.
	cwd  string
	info *codeAgentInfo
	conn *connection
	id   int64
	// The server itself, for the one op that changes the workspace out from
	// under every other one: code-agent.setRoot.
	srv *server
}

func (c *opCtx) chunk(v any) { c.conn.send(chunkFrame{ID: c.id, Chunk: v}) }

type opFunc func(*opCtx, *req) (any, error)

// ── op table ──────────────────────────────────────────────────────────────

var ops map[string]opFunc

// Built in an init function rather than a literal: several entries close over
// helpers declared below, and Go rejects the initialization cycle otherwise.
func init() {
	ops = map[string]opFunc{
		"code-agent.info": func(c *opCtx, _ *req) (any, error) { return c.info, nil },
		// See (*server).setRoot for why the boundary is where it is.
		"code-agent.setRoot": func(c *opCtx, p *req) (any, error) { return c.srv.setRoot(c.ctx, p.str("path")) },

		// ── filesystem ──
		"fs.readdir": func(c *opCtx, p *req) (any, error) { return readDir(c.jail, p.str("path")) },
		"fs.read": func(c *opCtx, p *req) (any, error) {
			return readTextFile(c.jail, p.str("path"), int64(p.number("offset", 0)), int64(p.number("length", 0)))
		},
		"fs.write": func(c *opCtx, p *req) (any, error) {
			return writeTextFile(c.jail, p.str("path"), p.str("text"))
		},
		"fs.createFile": func(c *opCtx, p *req) (any, error) {
			return okResult(createFile(c.jail, p.str("path")))
		},
		"fs.createDir": func(c *opCtx, p *req) (any, error) {
			return okResult(createDir(c.jail, p.str("path")))
		},
		"fs.move": func(c *opCtx, p *req) (any, error) {
			return okResult(movePath(c.jail, p.str("from"), p.str("to")))
		},
		"fs.delete": func(c *opCtx, p *req) (any, error) {
			return okResult(deletePaths(c.jail, p.strs("paths")))
		},
		"fs.stat": func(c *opCtx, p *req) (any, error) { return statPath(c.jail, p.str("path")) },

		// ── git: read ──
		"git.status": func(c *opCtx, _ *req) (any, error) { return gitStatusOf(c.ctx, c.cwd) },
		"git.log": func(c *opCtx, p *req) (any, error) {
			return gitLog(c.ctx, c.cwd, logOpts{
				ref:   p.str("ref"),
				limit: p.number("limit", 0),
				all:   p.truthy("all"),
				path:  p.str("path"),
				skip:  p.number("skip", 0),
			})
		},
		"git.branches": func(c *opCtx, _ *req) (any, error) { return gitBranches(c.ctx, c.cwd) },
		"git.checkIgnore": func(c *opCtx, p *req) (any, error) {
			return gitCheckIgnore(c.ctx, c.cwd, p.strs("paths"))
		},
		"git.reflog": func(c *opCtx, p *req) (any, error) {
			return gitReflog(c.ctx, c.cwd, p.number("limit", 50))
		},
		"git.commitDetail": func(c *opCtx, p *req) (any, error) {
			return gitCommitDetail(c.ctx, c.cwd, p.str("oid"), p.number("parent", 1))
		},
		"git.blob": func(c *opCtx, p *req) (any, error) {
			text, binary, err := blobAt(c.ctx, c.cwd, p.str("rev"), p.str("path"))
			if err != nil {
				return nil, err
			}
			return map[string]any{"text": text, "binary": binary}, nil
		},
		"git.blame": func(c *opCtx, p *req) (any, error) { return gitBlame(c.ctx, c.cwd, p.str("path")) },
		"git.diff": func(c *opCtx, p *req) (any, error) {
			path := p.str("path")
			return gitDiffPair(c.ctx, c.cwd, path, p.str("kind"), func() *string {
				f, err := readTextFile(c.jail, path, 0, 0)
				if err != nil || f == nil {
					return nil
				}
				return f.Text
			})
		},

		// ── git: index + commits ──
		"git.stage":   func(c *opCtx, p *req) (any, error) { return gitStage(c.ctx, c.cwd, p.strs("paths")) },
		"git.unstage": func(c *opCtx, p *req) (any, error) { return gitUnstage(c.ctx, c.cwd, p.strs("paths")) },
		"git.discard": func(c *opCtx, p *req) (any, error) { return gitDiscard(c.ctx, c.cwd, p.strs("paths")) },
		"git.resolve": func(c *opCtx, p *req) (any, error) { return gitMarkResolved(c.ctx, c.cwd, p.strs("paths")) },
		"git.applyPatch": func(c *opCtx, p *req) (any, error) {
			return gitApplyPatch(c.ctx, c.cwd, p.str("patch"), p.truthy("reverse"))
		},
		"git.commit": func(c *opCtx, p *req) (any, error) {
			return gitCommit(c.ctx, c.cwd, p.str("message"), p.truthy("amend"), p.truthy("all"))
		},
		"git.identity": func(c *opCtx, _ *req) (any, error) { return gitIdentity(c.ctx, c.cwd) },

		// ── git: refs ──
		"git.checkout": func(c *opCtx, p *req) (any, error) { return gitCheckout(c.ctx, c.cwd, p.str("ref")) },
		"git.branchCreate": func(c *opCtx, p *req) (any, error) {
			return gitBranchCreate(c.ctx, c.cwd, p.str("name"), p.str("from"))
		},
		"git.branchDelete": func(c *opCtx, p *req) (any, error) {
			return gitBranchDelete(c.ctx, c.cwd, p.str("name"), p.truthy("force"))
		},
		"git.branchRename": func(c *opCtx, p *req) (any, error) {
			return gitBranchRename(c.ctx, c.cwd, p.str("from"), p.str("to"))
		},
		"git.reset": func(c *opCtx, p *req) (any, error) {
			mode := p.str("mode")
			if mode == "" {
				mode = "mixed"
			}
			return gitReset(c.ctx, c.cwd, p.str("oid"), mode)
		},
		"git.revert":     func(c *opCtx, p *req) (any, error) { return gitRevert(c.ctx, c.cwd, p.str("oid")) },
		"git.cherryPick": func(c *opCtx, p *req) (any, error) { return gitCherryPick(c.ctx, c.cwd, p.str("oid")) },
		"git.tagCreate": func(c *opCtx, p *req) (any, error) {
			return gitTagCreate(c.ctx, c.cwd, p.str("name"), p.str("ref"), p.str("message"), p.truthy("force"))
		},
		"git.tagDelete": func(c *opCtx, p *req) (any, error) { return gitTagDelete(c.ctx, c.cwd, p.str("name")) },

		// ── git: merge / rebase / stash ──
		"git.merge": func(c *opCtx, p *req) (any, error) {
			return gitMerge(c.ctx, c.cwd, p.str("ref"), p.truthy("noFf"), p.truthy("squash"))
		},
		"git.mergeAbort": func(c *opCtx, _ *req) (any, error) { return gitMergeAbort(c.ctx, c.cwd) },
		"git.rebase": func(c *opCtx, p *req) (any, error) {
			action := p.str("action")
			if action == "" {
				action = "start"
			}
			return gitRebase(c.ctx, c.cwd, action, p.str("ref"))
		},
		"git.sequencer": func(c *opCtx, p *req) (any, error) {
			what := p.str("what")
			if what == "" {
				what = "cherry-pick"
			}
			action := p.str("action")
			if action == "" {
				action = "abort"
			}
			return gitSequencer(c.ctx, c.cwd, what, action)
		},
		"git.stash": func(c *opCtx, p *req) (any, error) {
			action := p.str("action")
			if action == "" {
				action = "list"
			}
			return gitStash(c.ctx, c.cwd, action, p.str("message"), p.str("ref"))
		},

		// ── git: remotes (streams progress) ──
		"git.remotes": func(c *opCtx, _ *req) (any, error) { return gitRemotes(c.ctx, c.cwd) },
		"git.remoteAdmin": func(c *opCtx, p *req) (any, error) {
			action := p.str("action")
			if action == "" {
				action = "add"
			}
			return gitRemoteAdmin(c.ctx, c.cwd, action, p.str("name"), p.str("url"), p.str("to"))
		},
		"git.remote": func(c *opCtx, p *req) (any, error) {
			action := p.str("action")
			if action == "" {
				action = "fetch"
			}
			return gitRemote(c.ctx, c.cwd, action, remoteOpts{
				remote:      p.str("remote"),
				ref:         p.str("ref"),
				setUpstream: p.truthy("setUpstream"),
				force:       p.truthy("force"),
				mode:        p.str("mode"),
			}, func(line string) {
				c.chunk(map[string]string{"progress": line})
			})
		},

		// ── search (streams hits) ──
		"search": func(c *opCtx, p *req) (any, error) {
			return runSearch(c.ctx, c.jail, searchOpts{
				query:      p.str("query"),
				matchCase:  p.truthy("matchCase"),
				wholeWord:  p.truthy("wholeWord"),
				regex:      p.truthy("regex"),
				include:    p.str("include"),
				exclude:    p.str("exclude"),
				maxMatches: p.number("maxMatches", 0),
			}, c.info.Ripgrep != nil, func(h searchHit) {
				c.chunk(map[string]any{"hit": h})
			}), nil
		},

		// Supersede a running request — search-as-you-type issues one per
		// keystroke and abandons the previous, which would otherwise keep
		// scanning.
		"cancel": func(c *opCtx, p *req) (any, error) {
			target := int64(p.number("target", 0))
			c.conn.mu.Lock()
			cancel, found := c.conn.inflight[target]
			c.conn.mu.Unlock()
			if found {
				cancel()
			}
			return map[string]bool{"cancelled": found}, nil
		},

		// ── watcher ──
		"watch.start": func(c *opCtx, _ *req) (any, error) {
			c.conn.mu.Lock()
			if c.conn.watcher != nil {
				c.conn.watcher.close()
			}
			// The root is read here, under the lock setRoot takes to re-aim
			// this connection's watcher, and not from the request's snapshot:
			// a snapshot taken before a reroot would start a watcher on the
			// folder the code-agent has just left, after the re-aim had already
			// passed this connection by.
			c.conn.watcher = startWatcher(c.srv.ws.Load().jail.root, func(paths []string) {
				c.conn.send(pushFrame{Event: "fs.change", Data: map[string]any{"paths": paths}})
			})
			watching := c.conn.watcher != nil
			c.conn.mu.Unlock()
			return map[string]bool{"watching": watching}, nil
		},
		"watch.stop": func(c *opCtx, _ *req) (any, error) {
			c.conn.mu.Lock()
			if c.conn.watcher != nil {
				c.conn.watcher.close()
				c.conn.watcher = nil
			}
			c.conn.mu.Unlock()
			return map[string]bool{"watching": false}, nil
		},
	}
}

func okResult(err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

// errCodeOf recovers the wire code for an error: EPATH and EGIT come from the
// error types, filesystem failures keep their Node-style errno name.
func errCodeOf(err error) string {
	var coded interface{ errCode() string }
	if errors.As(err, &coded) {
		return coded.errCode()
	}
	return errnoName(err)
}

// ── HTTP ──────────────────────────────────────────────────────────────────

// Origins trusted without being named on the command line: the port the web app
// is served from by default (src/server.ts PORT), and nothing else.
//
// What this replaced was a pattern matching any loopback origin on any port,
// which meant every other dev server on the machine — and script injected into
// any of them — spoke to this code-agent with the same authority as the app itself.
// A user serving the app elsewhere names it with --allow-origin: one flag,
// against a whole class of silent access.
var defaultOrigins = []string{"http://localhost:5000", "http://127.0.0.1:5000", "http://[::1]:5000"}

// Names this code-agent answers to. net.SplitHostPort strips the brackets from an
// IPv6 literal, so ::1 is stored without them.
var loopbackHosts = map[string]bool{"127.0.0.1": true, "localhost": true, "::1": true}

// workspace is one answer to "where is this code-agent pointed, and what is there" —
// the jail, whether it is a repository, and what code-agent.info reports about it.
//
// Immutable once published. These three used to be separate fields of server,
// and code-agent.setRoot rewrote them one at a time while operations were running on
// other goroutines: an operation could take the jail of the old folder and the
// repository flag of the new one, and code-agent.info could be serialised while its
// Root was being replaced. Nothing was wrong with any single field; the wrong
// thing was that they change together and were read apart. So they are one
// value, replaced whole, and a request reads it once and keeps what it read.
type workspace struct {
	jail   *jail
	isRepo bool
	info   *codeAgentInfo
}

type server struct {
	// The current workspace. Read with ws.Load() — once per request — and never
	// modified in place; only setRoot stores a new one, under rootMu.
	ws     atomic.Pointer[workspace]
	rootMu sync.Mutex

	token   string
	origins []string
	// The port actually bound: the same as the one asked for today, but the name
	// this code-agent answers to should be the one it actually got.
	port          int
	allowNoOrigin bool
	allowMultiple bool
	// Folders code-agent.setRoot may move the workspace into. The startup root is
	// always the first; --allow-root adds the rest. See setRoot below.
	rerootBases []string

	// Connections held right now. The lock in the /ws branch reads it, and the
	// startup banner promises what it will do.
	mu      sync.Mutex
	clients int
	// Live connections, so a reroot can re-aim watchers that are running on a
	// folder this code-agent has left.
	conns map[*connection]bool
	// Whether the current lock has already been reported. Reset when it lifts:
	// a refused tab keeps reconnecting on a backoff, and a line every few
	// seconds would bury the one event worth seeing.
	refusalLogged bool
}

// take reserves a connection slot, or reports that the code-agent is already held.
//
// Counted before the handshake rather than after: between the check and a
// completed upgrade there is room for a second request to have seen zero.
func (s *server) take() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.allowMultiple && s.clients > 0 {
		return false
	}
	s.clients++
	return true
}

// logRefusalOnce reports that the lock turned a client away, the first time it
// happens for the connection currently holding it.
func (s *server) logRefusalOnce() {
	s.mu.Lock()
	first := !s.refusalLogged
	s.refusalLogged = true
	s.mu.Unlock()
	if first {
		lifecycle("refused a second client — this code-agent is locked to the one already connected (--allow-multiple lifts that); further attempts stay quiet until it disconnects")
	}
}

// release gives the slot back and reports how many are still held.
func (s *server) release() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clients--
	s.refusalLogged = false
	return s.clients
}

func (s *server) held() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.clients
}

// setRoot moves the workspace to another folder without a restart.
//
// The path is absolute and native — this is the one op whose whole purpose is to
// leave the current workspace, so it does not go through the jail. It goes
// through rerootBases instead, which is the operator's boundary rather than the
// page's: by default only the folder the code-agent was started on and what is under
// it, which cannot reach anything the code-agent could not already read. Widening
// that is a --allow-root flag and therefore a decision made at the terminal,
// never by the page asking nicely.
//
// Every connection's watcher is re-aimed, because a watcher left on the old
// folder reports changes the client can no longer resolve to a path — a tree
// that refreshes on edits to a folder it is not showing.
func (s *server) setRoot(ctx context.Context, dir string) (any, error) {
	// One reroot at a time, start to finish: two of them interleaving would
	// publish one folder's workspace and re-aim the watchers at the other's.
	s.rootMu.Lock()
	defer s.rootMu.Unlock()

	if dir == "" {
		return nil, errors.New("A folder is required")
	}
	opened, err := openJail(dir)
	if err != nil {
		return nil, fmt.Errorf("Cannot open folder: %s", dir)
	}
	if !s.mayRoot(opened.root) {
		return nil, &jailError{"Folder is outside what this code-agent may open", opened.root}
	}
	// Snapping happens after the check, never before: the repository root of an
	// allowed folder can be above it, and that is a folder nobody allowed.
	next := opened
	top := repoRoot(ctx, opened.root)
	if top != "" {
		snapped, serr := openJail(top)
		if serr != nil {
			return nil, fmt.Errorf("Cannot open folder: %s", top)
		}
		if !s.mayRoot(snapped.root) {
			return nil, &jailError{"Repository root is outside what this code-agent may open", snapped.root}
		}
		next = snapped
	}

	// A copy, not the published info edited in place: operations already
	// running hold the old snapshot, and code-agent.info may be mid-serialisation.
	info := *s.ws.Load().info
	info.Root = next.root
	if top != "" {
		dot := "."
		info.Repo = &dot
	} else {
		info.Repo = nil
	}
	s.ws.Store(&workspace{jail: next, isRepo: top != "", info: &info})

	s.mu.Lock()
	live := make([]*connection, 0, len(s.conns))
	for c := range s.conns {
		live = append(live, c)
	}
	s.mu.Unlock()
	for _, c := range live {
		c.mu.Lock()
		if c.watcher != nil {
			c.watcher.close()
			conn := c
			c.watcher = startWatcher(next.root, func(paths []string) {
				conn.send(pushFrame{Event: "fs.change", Data: map[string]any{"paths": paths}})
			})
		}
		c.mu.Unlock()
	}
	lifecycle("workspace is now " + next.root)
	return &info, nil
}

// mayRoot reports whether a resolved folder is inside one the operator allowed.
func (s *server) mayRoot(abs string) bool {
	for _, base := range s.rerootBases {
		if contains(base, abs) {
			return true
		}
	}
	return false
}

// lifecycle reports a connection coming or going, on stderr rather than stdout.
//
// stdout carries exactly one thing scripts parse — the URL with the token — and
// a line arriving there later, on somebody else's schedule, is the kind of
// thing that breaks a pipe reader six months from now.
func lifecycle(message string) {
	fmt.Fprintf(os.Stderr, "code-agent: %s\n", printable(message))
}

// printable makes a value from a request safe to write to a terminal.
//
// The Origin and Host of a request are chosen by whoever sends it, and they are
// echoed to the operator's terminal when refused. A control character in one is
// not text there but an instruction: an escape sequence can move the cursor,
// overwrite the lines above and make a refusal look like something else — or
// like nothing. Every control character becomes "?", and a value longer than a
// line is cut, so nothing sent over the socket can rewrite what the operator
// reads.
func printable(s string) string {
	const longest = 300
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if len(out) == longest {
			out = append(out, '…')
			break
		}
		if unicode.IsControl(r) {
			r = '?'
		}
		out = append(out, r)
	}
	return string(out)
}

// refuse logs why a request was turned away and reports it as not allowed.
//
// From the browser's side a rejected upgrade looks exactly like a code-agent that
// is not running, so without this line the user goes off to debug a process
// that is doing precisely what it was told.
func refuse(what, value, hint string) bool {
	if value == "" {
		value = "(none)"
	}
	fmt.Fprintf(os.Stderr, "code-agent: refused %s %s — %s\n", printable(what), printable(value), printable(hint))
	return false
}

func (s *server) originAllowed(origin string) bool {
	if origin == "" {
		// A browser always sends one. The absence of the header is therefore
		// never the app, and it used to be the way past this check entirely.
		if s.allowNoOrigin {
			return true
		}
		return refuse("client with no Origin", "", "pass --allow-no-origin to permit non-browser clients")
	}
	trimmed := strings.TrimRight(origin, "/")
	for _, o := range defaultOrigins {
		if o == trimmed {
			return true
		}
	}
	for _, o := range s.origins {
		if o == trimmed {
			return true
		}
	}
	return refuse("origin", origin, "pass --allow-origin "+origin)
}

// hostAllowed is the second lock, and the one that does not depend on the
// browser volunteering a header we like.
//
// A page on attacker.example whose DNS answers 127.0.0.1 reaches this process
// directly — DNS rebinding. Such a request carries the attacker's own Origin
// and the check above refuses it, but that is one check, and under
// --allow-no-origin there is no Origin to judge. The name the request arrived
// under is the other half: the browser puts the rebound hostname in Host, and
// that is never one of ours.
func (s *server) hostAllowed(host string) bool {
	expected := "127.0.0.1:" + strconv.Itoa(s.port)
	if host == "" {
		return refuse("request with no Host header", "", "expected "+expected)
	}
	name, port, err := net.SplitHostPort(host)
	if err != nil {
		return refuse("unparseable Host", host, "expected "+expected)
	}
	if loopbackHosts[name] && port == strconv.Itoa(s.port) {
		return true
	}
	return refuse("Host", host, "this code-agent answers to "+expected+" only")
}

func (s *server) cors(w http.ResponseWriter, origin string) {
	if origin == "" || !s.originAllowed(origin) {
		return
	}
	h := w.Header()
	h.Set("access-control-allow-origin", origin)
	h.Set("access-control-allow-headers", "content-type")
	// Forward-compat with Chrome's Private Network Access preflight, which
	// would otherwise start blocking https -> loopback without warning.
	h.Set("access-control-allow-private-network", "true")
	h.Set("vary", "origin")
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")

	// Before anything else, the preflight included: a request that reached this
	// port under a name that is not ours gets nothing back, not even the CORS
	// grant that would tell the page it is worth trying again.
	if !s.hostAllowed(r.Host) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	s.cors(w, origin)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	switch r.URL.Path {
	case "/ping":
		// Unauthenticated liveness probe: the UI's capability badge needs to
		// tell "code-agent not running" apart from "wrong token", and this reveals
		// nothing beyond the code-agent's presence to origins already on the list.
		if !s.originAllowed(origin) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"codeAgent": "enc-tool", "version": version})

	case "/ws":
		// Order matters: the specific refusals first, so a foreign origin or a
		// bad token still says so rather than "busy".
		if !s.originAllowed(origin) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		// Constant time: `!=` returns at the first differing byte, so how long a
		// refusal takes says how much of a guess was right — a signal a page on
		// another origin can measure through its own failed connections. The
		// length is compared first and is not secret.
		if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(s.token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !s.take() {
			s.logRefusalOnce()
			http.Error(w, "code-agent busy", http.StatusConflict)
			return
		}
		ws, err := wsUpgrade(w, r)
		if err != nil {
			s.release()
			http.Error(w, "upgrade failed", http.StatusBadRequest)
			return
		}
		s.serveConn(ws, origin)

	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (s *server) serveConn(ws *wsConn, origin string) {
	if origin == "" {
		origin = "(no Origin)"
	}
	if s.allowMultiple {
		lifecycle(fmt.Sprintf("client connected — %s (%d connected)", origin, s.held()))
	} else {
		lifecycle(fmt.Sprintf("client connected — %s — locked: no other client until this one disconnects", origin))
	}

	conn := &connection{
		ws:       ws,
		slots:    make(chan struct{}, maxConcurrentProcs),
		inflight: map[int64]context.CancelFunc{},
	}
	s.mu.Lock()
	if s.conns == nil {
		s.conns = map[*connection]bool{}
	}
	s.conns[conn] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.conns, conn)
		s.mu.Unlock()
		left := s.release()
		if s.allowMultiple {
			lifecycle(fmt.Sprintf("client disconnected — %s (%d connected)", origin, left))
		} else {
			lifecycle(fmt.Sprintf("client disconnected — %s — unlocked, accepting a connection again", origin))
		}
		ws.close()
		conn.mu.Lock()
		if conn.watcher != nil {
			conn.watcher.close()
			conn.watcher = nil
		}
		// Nothing will read the results now; let running scans stop early.
		for _, cancel := range conn.inflight {
			cancel()
		}
		conn.inflight = map[int64]context.CancelFunc{}
		conn.mu.Unlock()
	}()

	for {
		opcode, payload, err := ws.readMessage()
		if err != nil {
			return
		}
		if opcode != opText {
			continue
		}
		var params map[string]json.RawMessage
		if err := json.Unmarshal(payload, &params); err != nil {
			continue // unparseable frames are ignored, as in the TypeScript code-agent
		}
		r := &req{params: params}
		if raw, ok := params["id"]; ok {
			_ = json.Unmarshal(raw, &r.id)
		}
		if raw, ok := params["op"]; ok {
			_ = json.Unmarshal(raw, &r.op)
		}
		s.dispatch(conn, r)
	}
}

func (s *server) dispatch(conn *connection, r *req) {
	handler, ok := ops[r.op]
	if !ok {
		conn.send(resErr{ID: r.id, Error: "Unknown op: " + r.op, Code: "ENOOP"})
		return
	}
	// One read, kept for the whole request: the repository check below and the
	// jail the handler gets must describe the same folder.
	ws := s.ws.Load()
	// Before "not a repository": with a git too old to trust, that would be
	// true of every folder, and the reason is the more useful thing to say.
	if ws.info.GitProblem != nil && strings.HasPrefix(r.op, "git.") {
		conn.send(resErr{ID: r.id, Error: *ws.info.GitProblem, Code: "EGIT"})
		return
	}
	if !ws.isRepo && strings.HasPrefix(r.op, "git.") {
		conn.send(resErr{ID: r.id, Error: "Not a git repository", Code: "ENOREPO"})
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	conn.mu.Lock()
	// cancel is exempt: it is how a client gets out of a full house, and it
	// finishes at once.
	if r.op != "cancel" && len(conn.inflight) >= maxInflightOps {
		conn.mu.Unlock()
		cancel()
		conn.send(resErr{ID: r.id, Error: "Too many requests in flight", Code: "EBUSY"})
		return
	}
	conn.inflight[r.id] = cancel
	conn.mu.Unlock()

	// Not awaited: a long search or push must not block other requests.
	go func() {
		defer func() {
			cancel()
			conn.mu.Lock()
			delete(conn.inflight, r.id)
			conn.mu.Unlock()
		}()

		if spawnsProcess(r.op) {
			// The wait ends when the request is cancelled. It used to be a bare
			// send, so a search the client had already replaced stood in the
			// queue for a slot, took it, and only then found out — holding a
			// slot a live request was waiting for.
			select {
			case conn.slots <- struct{}{}:
				defer func() { <-conn.slots }()
			case <-ctx.Done():
				conn.send(resErr{ID: r.id, Error: "Cancelled", Code: "ECANCELED"})
				return
			}
		}

		c := &opCtx{ctx: ctx, jail: ws.jail, cwd: ws.jail.root, info: ws.info, conn: conn, id: r.id, srv: s}
		data, err := handler(c, r)
		if err != nil {
			conn.send(resErr{ID: r.id, Error: err.Error(), Code: errCodeOf(err)})
			return
		}
		conn.send(resOK{ID: r.id, OK: true, Data: data})
	}()
}

// listenLoopback binds 127.0.0.1 only. Port 0 asks the OS to choose, and the
// chosen port is read back off the listener for the banner.
func listenLoopback(port int) (net.Listener, error) {
	return net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
}

// listen binds the first free port in the range, or the one --port named, and
// stops with a sentence rather than a stack trace when there is none.
//
// Running a second code-agent on a second folder is an ordinary thing to do, and
// what used to happen is that it stopped dead on "address already in use",
// leaving the user to pick a port by hand — and then to find out that the page
// is only allowed to reach some of them. Walking the range is that decision
// made once, here.
//
// An explicit --port is never second-guessed. It names a port, and quietly
// serving a different one would hand this folder to a tab that asked for
// somebody else's.
func listen(o options) net.Listener {
	candidates := []int{o.port}
	if !o.portExplicit {
		candidates = candidates[:0]
		for p := codeAgentPortMin; p <= codeAgentPortMax; p++ {
			candidates = append(candidates, p)
		}
	}

	var last error
	for _, p := range candidates {
		l, err := listenLoopback(p)
		if err == nil {
			return l
		}
		// Any refusal moves on to the next candidate rather than stopping: a
		// taken port is not reported as the same errno on every platform, and
		// the last error is still reported if none of them work.
		last = err
	}

	if o.portExplicit {
		fmt.Fprintf(os.Stderr, "code-agent: cannot listen on 127.0.0.1:%d: %v\n", o.port, last)
		fmt.Fprintf(os.Stderr, "code-agent: drop --port and the code-agent takes the first free port in %s\n", codeAgentPortRange)
	} else {
		fmt.Fprintf(os.Stderr, "code-agent: no free loopback port in %s: %v\n", codeAgentPortRange, last)
		fmt.Fprintln(os.Stderr, "code-agent: stop a code-agent you are done with, or pass --port <n> and start the web app with CODE_AGENT_PORTS naming that port")
	}
	os.Exit(1)
	return nil
}
