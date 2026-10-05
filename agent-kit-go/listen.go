package agentkit

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

// PortRange is the loopback range an agent may bind, mirroring src/ports.ts —
// which is where the reasoning lives. Two processes have to agree on it: the
// agent picks a port, and the page may only open a connection to the ports its
// own connect-src names. Disagreement is silent, and looks from the tab exactly
// like an agent that never started.
type PortRange struct {
	Min, Max int
	// The web app's variable that widens its policy: CODE_AGENT_PORTS,
	// KAFKA_AGENT_PORTS.
	Env string
}

// String is the "5001-5010" spelling, for help text and messages.
func (p PortRange) String() string { return fmt.Sprintf("%d-%d", p.Min, p.Max) }

// Contains reports whether the page may reach a port without a wider policy.
func (p PortRange) Contains(port int) bool { return port >= p.Min && port <= p.Max }

// ListenLoopback binds 127.0.0.1 only. Port 0 asks the OS to choose, and the
// chosen port is read back off the listener for the banner.
func ListenLoopback(port int) (net.Listener, error) {
	return net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
}

// Listen binds the first free port in the range, or the one --port named, and
// stops with a sentence rather than a stack trace when there is none.
//
// Running a second agent is an ordinary thing to do, and what used to happen
// is that it stopped dead on "address already in use", leaving the user to pick
// a port by hand — and then to find out that the page is only allowed to reach
// some of them. Walking the range is that decision made once, here.
//
// An explicit --port is never second-guessed. It names a port, and quietly
// serving a different one would hand this agent to a tab that asked for
// somebody else's.
func Listen(r PortRange, port int, explicit bool) net.Listener {
	candidates := []int{port}
	if !explicit {
		candidates = candidates[:0]
		for p := r.Min; p <= r.Max; p++ {
			candidates = append(candidates, p)
		}
	}

	var last error
	for _, p := range candidates {
		l, err := ListenLoopback(p)
		if err == nil {
			return l
		}
		// Any refusal moves on to the next candidate rather than stopping: a
		// taken port is not reported as the same errno on every platform, and
		// the last error is still reported if none of them work.
		last = err
	}

	if explicit {
		fmt.Fprintf(os.Stderr, "%s: cannot listen on 127.0.0.1:%d: %v\n", Name, port, last)
		fmt.Fprintf(os.Stderr, "%s: drop --port and the %s takes the first free port in %s\n", Name, Name, r)
	} else {
		fmt.Fprintf(os.Stderr, "%s: no free loopback port in %s: %v\n", Name, r, last)
		fmt.Fprintf(os.Stderr, "%s: stop a %s you are done with, or pass --port <n> and start the web app with %s naming that port\n", Name, Name, r.Env)
	}
	os.Exit(1)
	return nil
}

// EnvOrigins reads comma- or space-separated origins from an environment
// variable.
//
// The agent people run is downloaded from a UI that is usually not on
// localhost, so it needs that origin allowed on every start. A variable can be
// set once in a shell profile; a flag has to be retyped every time.
func EnvOrigins(name string) []string {
	out := []string{}
	for _, o := range strings.FieldsFunc(os.Getenv(name), func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
	}) {
		if o != "" {
			out = append(out, strings.TrimRight(o, "/"))
		}
	}
	return out
}

// NewToken returns 128 random bits in hex — the access token when none was given.
func NewToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
