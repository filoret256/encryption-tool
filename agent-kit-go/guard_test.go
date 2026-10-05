package agentkit

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPrintableNeutralisesWhatATerminalWouldObey(t *testing.T) {
	cases := []struct{ in, want string }{
		{"http://localhost:5000", "http://localhost:5000"},
		{"пароль ключ 日本語", "пароль ключ 日本語"},
		{"evil\x1b[2J\x1b[Hfake", "evil?[2J?[Hfake"}, // escape sequences
		{"two\nlines\r\nhere", "two?lines??here"},    // a value that starts a fresh line
		{"c1\u009bcontrol\x7f", "c1?control?"},       // C1 CSI and DEL
		{"", ""},
	}
	for _, c := range cases {
		if got := Printable(c.in); got != c.want {
			t.Errorf("Printable(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	long := Printable(strings.Repeat("x", 1000))
	if r := []rune(long); len(r) != 301 || r[300] != '…' {
		t.Errorf("a long value should be cut at 300 runes plus an ellipsis, got %d runes", len(r))
	}
}

func TestOriginAllowlist(t *testing.T) {
	g := &Guard{Origins: []string{"https://enc.example.com"}}
	for origin, want := range map[string]bool{
		"http://localhost:5000":    true,
		"http://127.0.0.1:5000/":   true, // a trailing slash is the same origin
		"https://enc.example.com":  true,
		"http://localhost:5001":    false, // another dev server on the machine
		"https://evil.example.com": false,
		"":                         false, // not a browser
	} {
		if got := g.OriginAllowed(origin); got != want {
			t.Errorf("OriginAllowed(%q) = %v, want %v", origin, got, want)
		}
	}
	g.AllowNoOrigin = true
	if !g.OriginAllowed("") {
		t.Error("--allow-no-origin did not admit a client without an Origin")
	}
}

func TestHostMustBeOurOwnName(t *testing.T) {
	g := &Guard{Port: 5011}
	for host, want := range map[string]bool{
		"127.0.0.1:5011":    true,
		"localhost:5011":    true,
		"[::1]:5011":        true,
		"127.0.0.1:5012":    false, // the port the request did not arrive on
		"rebound.evil:5011": false, // DNS rebinding
		"127.0.0.1":         false,
		"":                  false,
	} {
		if got := g.HostAllowed(host); got != want {
			t.Errorf("HostAllowed(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestServeRefusesBeforeUpgrading(t *testing.T) {
	g := &Guard{Port: 5011, Token: "secret", Ping: map[string]string{"agent": "test"}}
	call := func(path, host, origin string) int {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Host = host
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		g.Serve(w, r, func(*Conn, string) { t.Fatal("a refused request reached the session") })
		return w.Code
	}
	if got := call("/ping", "127.0.0.1:5011", "http://localhost:5000"); got != http.StatusOK {
		t.Errorf("/ping from the app: %d", got)
	}
	if got := call("/ping", "evil:5011", "http://localhost:5000"); got != http.StatusForbidden {
		t.Errorf("/ping under a foreign Host: %d, want 403", got)
	}
	if got := call("/ws?token=wrong", "127.0.0.1:5011", "http://localhost:5000"); got != http.StatusUnauthorized {
		t.Errorf("/ws with a wrong token: %d, want 401", got)
	}
	if got := call("/ws?token=secret", "127.0.0.1:5011", "https://evil.example.com"); got != http.StatusForbidden {
		t.Errorf("/ws from a foreign origin: %d, want 403", got)
	}
	if g.Held() != 0 {
		t.Errorf("refusals left %d slots taken", g.Held())
	}
}

func TestOneClientUnlessAllowed(t *testing.T) {
	g := &Guard{}
	if !g.Take() || g.Take() {
		t.Fatal("the second client was not refused while the first held the agent")
	}
	g.Release()
	if !g.Take() {
		t.Fatal("the slot did not come back on release")
	}
	g.AllowMultiple = true
	if !g.Take() {
		t.Fatal("--allow-multiple did not admit a second client")
	}
}
