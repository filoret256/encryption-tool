// The loopback server's front door, shared by every agent.
//
// Security posture (all load-bearing):
//  1. binds 127.0.0.1 only — never reachable from the network (see Listen);
//  2. a token, printed at startup, is required on every connection;
//  3. the Origin header is checked against an allowlist — a token in
//     localStorage is only as good as the origins that can read it — and the
//     Host header against this agent's own name, which is what stops a rebound
//     DNS name from reaching it under someone else's;
//  4. one client at a time unless the operator says otherwise, so it is always
//     clear which page is holding the agent.
//
// What lies behind the door — the op table, and whatever the agent is a bridge
// to — is the agent's own.
package agentkit

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// DefaultOrigins are trusted without being named on the command line: the port
// the web app is served from by default (src/server.ts PORT), and nothing else.
//
// What this replaced was a pattern matching any loopback origin on any port,
// which meant every other dev server on the machine — and script injected into
// any of them — spoke to the agent with the same authority as the app itself.
// A user serving the app elsewhere names it with --allow-origin: one flag,
// against a whole class of silent access.
var DefaultOrigins = []string{"http://localhost:5000", "http://127.0.0.1:5000", "http://[::1]:5000"}

// Names an agent answers to. net.SplitHostPort strips the brackets from an
// IPv6 literal, so ::1 is stored without them.
var loopbackHosts = map[string]bool{"127.0.0.1": true, "localhost": true, "::1": true}

// Guard holds the checks every request passes before an agent sees it, and the
// one-client lock.
type Guard struct {
	Token   string
	Origins []string
	// The port actually bound: the name this agent answers to should be the
	// one it actually got.
	Port          int
	AllowNoOrigin bool
	AllowMultiple bool
	// What /ping answers: enough to tell "agent not running" from "wrong
	// token", and nothing an origin on the list could not learn anyway.
	Ping any

	mu      sync.Mutex
	clients int
	// Whether the current lock has already been reported. Reset when it lifts:
	// a refused tab keeps reconnecting on a backoff, and a line every few
	// seconds would bury the one event worth seeing.
	refusalLogged bool
}

// Take reserves a connection slot, or reports that the agent is already held.
//
// Counted before the handshake rather than after: between the check and a
// completed upgrade there is room for a second request to have seen zero.
func (g *Guard) Take() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.AllowMultiple && g.clients > 0 {
		return false
	}
	g.clients++
	return true
}

// LogRefusalOnce reports that the lock turned a client away, the first time it
// happens for the connection currently holding it.
func (g *Guard) LogRefusalOnce() {
	g.mu.Lock()
	first := !g.refusalLogged
	g.refusalLogged = true
	g.mu.Unlock()
	if first {
		Lifecycle("refused a second client — this " + Name + " is locked to the one already connected (--allow-multiple lifts that); further attempts stay quiet until it disconnects")
	}
}

// Release gives the slot back and reports how many are still held.
func (g *Guard) Release() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.clients--
	g.refusalLogged = false
	return g.clients
}

// Held reports how many connections are open.
func (g *Guard) Held() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.clients
}

// OriginAllowed checks the Origin header against DefaultOrigins and --allow-origin.
func (g *Guard) OriginAllowed(origin string) bool {
	if origin == "" {
		// A browser always sends one. The absence of the header is therefore
		// never the app, and it used to be the way past this check entirely.
		if g.AllowNoOrigin {
			return true
		}
		return Refuse("client with no Origin", "", "pass --allow-no-origin to permit non-browser clients")
	}
	trimmed := strings.TrimRight(origin, "/")
	for _, o := range DefaultOrigins {
		if o == trimmed {
			return true
		}
	}
	for _, o := range g.Origins {
		if o == trimmed {
			return true
		}
	}
	return Refuse("origin", origin, "pass --allow-origin "+origin)
}

// HostAllowed is the second lock, and the one that does not depend on the
// browser volunteering a header we like.
//
// A page on attacker.example whose DNS answers 127.0.0.1 reaches this process
// directly — DNS rebinding. Such a request carries the attacker's own Origin
// and the check above refuses it, but that is one check, and under
// --allow-no-origin there is no Origin to judge. The name the request arrived
// under is the other half: the browser puts the rebound hostname in Host, and
// that is never one of ours.
func (g *Guard) HostAllowed(host string) bool {
	expected := "127.0.0.1:" + strconv.Itoa(g.Port)
	if host == "" {
		return Refuse("request with no Host header", "", "expected "+expected)
	}
	name, port, err := net.SplitHostPort(host)
	if err != nil {
		return Refuse("unparseable Host", host, "expected "+expected)
	}
	if loopbackHosts[name] && port == strconv.Itoa(g.Port) {
		return true
	}
	return Refuse("Host", host, "this "+Name+" answers to "+expected+" only")
}

func (g *Guard) cors(w http.ResponseWriter, origin string) {
	if origin == "" || !g.OriginAllowed(origin) {
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

// Serve runs one HTTP request through every check, answers /ping itself, and
// hands an upgraded /ws connection to session. The slot taken for it is
// released and the socket closed when session returns.
func (g *Guard) Serve(w http.ResponseWriter, r *http.Request, session func(ws *Conn, origin string)) {
	origin := r.Header.Get("Origin")

	// Before anything else, the preflight included: a request that reached this
	// port under a name that is not ours gets nothing back, not even the CORS
	// grant that would tell the page it is worth trying again.
	if !g.HostAllowed(r.Host) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	g.cors(w, origin)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	switch r.URL.Path {
	case "/ping":
		// Unauthenticated liveness probe: the UI's capability badge needs to
		// tell "agent not running" apart from "wrong token", and this reveals
		// nothing beyond the agent's presence to origins already on the list.
		if !g.OriginAllowed(origin) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(g.Ping)

	case "/ws":
		// Order matters: the specific refusals first, so a foreign origin or a
		// bad token still says so rather than "busy".
		if !g.OriginAllowed(origin) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		// Constant time: `!=` returns at the first differing byte, so how long a
		// refusal takes says how much of a guess was right — a signal a page on
		// another origin can measure through its own failed connections. The
		// length is compared first and is not secret.
		if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("token")), []byte(g.Token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !g.Take() {
			g.LogRefusalOnce()
			http.Error(w, Name+" busy", http.StatusConflict)
			return
		}
		ws, err := Upgrade(w, r)
		if err != nil {
			g.Release()
			http.Error(w, "upgrade failed", http.StatusBadRequest)
			return
		}
		g.session(ws, origin, session)

	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

// session brackets one connection with the lines the operator sees.
func (g *Guard) session(ws *Conn, origin string, run func(*Conn, string)) {
	if origin == "" {
		origin = "(no Origin)"
	}
	if g.AllowMultiple {
		Lifecycle(fmt.Sprintf("client connected — %s (%d connected)", origin, g.Held()))
	} else {
		Lifecycle(fmt.Sprintf("client connected — %s — locked: no other client until this one disconnects", origin))
	}
	defer func() {
		left := g.Release()
		if g.AllowMultiple {
			Lifecycle(fmt.Sprintf("client disconnected — %s (%d connected)", origin, left))
		} else {
			Lifecycle(fmt.Sprintf("client disconnected — %s — unlocked, accepting a connection again", origin))
		}
		ws.Close()
	}()
	run(ws, origin)
}
