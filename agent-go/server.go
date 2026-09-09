// The loopback server: HTTP for the liveness probe, WebSocket for everything
// else, and the op table both the browser and the smoke test drive.
//
// Security posture (all four are load-bearing):
//  1. binds 127.0.0.1 only — never reachable from the network;
//  2. a token, printed at startup, is required on every connection;
//  3. the Origin header is checked against an allowlist, because a token in
//     localStorage is only as good as the origins that can read it;
//  4. every path is confined to the workspace by the jail.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// ── request parameter coercion ────────────────────────────────────────────
//
// The TypeScript agent funnels every parameter through String()/Boolean()/
// Number(), so a client that sends 5 where a string is expected gets "5" rather
// than an error. These helpers reproduce that exactly: the two agents must
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

type connection struct {
	ws *wsConn

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
	info *agentInfo
	conn *connection
	id   int64
}

func (c *opCtx) chunk(v any) { c.conn.send(chunkFrame{ID: c.id, Chunk: v}) }

type opFunc func(*opCtx, *req) (any, error)

// ── op table ──────────────────────────────────────────────────────────────

var ops map[string]opFunc

// Built in an init function rather than a literal: several entries close over
// helpers declared below, and Go rejects the initialization cycle otherwise.
func init() {
	ops = map[string]opFunc{
		"agent.info": func(c *opCtx, _ *req) (any, error) { return c.info, nil },

		// ── filesystem ──
		"fs.readdir": func(c *opCtx, p *req) (any, error) { return readDir(c.jail, p.str("path")) },
		"fs.read":    func(c *opCtx, p *req) (any, error) { return readTextFile(c.jail, p.str("path")) },
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
			})
		},
		"git.branches":     func(c *opCtx, _ *req) (any, error) { return gitBranches(c.ctx, c.cwd) },
		"git.commitDetail": func(c *opCtx, p *req) (any, error) { return gitCommitDetail(c.ctx, c.cwd, p.str("oid")) },
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
				f, err := readTextFile(c.jail, path)
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

		// ── git: merge / rebase / stash ──
		"git.merge": func(c *opCtx, p *req) (any, error) {
			return gitMerge(c.ctx, c.cwd, p.str("ref"), p.truthy("noFf"))
		},
		"git.mergeAbort": func(c *opCtx, _ *req) (any, error) { return gitMergeAbort(c.ctx, c.cwd) },
		"git.rebase": func(c *opCtx, p *req) (any, error) {
			action := p.str("action")
			if action == "" {
				action = "start"
			}
			return gitRebase(c.ctx, c.cwd, action, p.str("ref"))
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
			}, func(line string) {
				c.chunk(map[string]string{"progress": line})
			})
		},

		// ── search (streams hits) ──
		"search": func(c *opCtx, p *req) (any, error) {
			return runSearch(c.ctx, c.cwd, searchOpts{
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
			c.conn.watcher = startWatcher(c.jail.root, func(paths []string) {
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

var loopbackOrigin = regexp.MustCompile(`^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$`)

type server struct {
	jail    *jail
	info    *agentInfo
	token   string
	origins []string
	// Whether the workspace is a git repository; git ops are refused when not.
	isRepo bool
}

func (s *server) originAllowed(origin string) bool {
	if origin == "" {
		return true // non-browser client; the token still gates it
	}
	trimmed := strings.TrimRight(origin, "/")
	for _, o := range s.origins {
		if o == trimmed {
			return true
		}
	}
	return loopbackOrigin.MatchString(origin)
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
	s.cors(w, origin)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	switch r.URL.Path {
	case "/ping":
		// Unauthenticated liveness probe: the UI's capability badge needs to
		// tell "agent not running" apart from "wrong token", and this reveals
		// nothing beyond the agent's presence to origins already on the list.
		if !s.originAllowed(origin) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"agent": "enc-tool", "version": version})

	case "/ws":
		if !s.originAllowed(origin) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.URL.Query().Get("token") != s.token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ws, err := wsUpgrade(w, r)
		if err != nil {
			http.Error(w, "upgrade failed", http.StatusBadRequest)
			return
		}
		s.serveConn(ws)

	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (s *server) serveConn(ws *wsConn) {
	conn := &connection{ws: ws, inflight: map[int64]context.CancelFunc{}}
	defer func() {
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
			continue // unparseable frames are ignored, as in the TypeScript agent
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
	if !s.isRepo && strings.HasPrefix(r.op, "git.") {
		conn.send(resErr{ID: r.id, Error: "Not a git repository", Code: "ENOREPO"})
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	conn.mu.Lock()
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

		c := &opCtx{ctx: ctx, jail: s.jail, cwd: s.jail.root, info: s.info, conn: conn, id: r.id}
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
