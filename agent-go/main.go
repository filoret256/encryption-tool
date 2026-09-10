// The local agent: `enc-tool-agent`.
//
// Runs on the user's machine next to their repository and exposes the
// filesystem, the system `git` and ripgrep to the browser tab over a loopback
// WebSocket. This exists because a web page cannot spawn processes — there is
// no API for it — so "use the git installed in the OS" necessarily means a
// small local process doing the spawning.
//
// A line-for-line port of src/agent/main.ts. The TypeScript version remains the
// reference implementation; both are driven by the same wire-level smoke test
// (scripts/agent-smoke.ts) precisely so that "port" can mean something checked
// rather than claimed.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// Overridden at link time by scripts/build-agents-go.ts, which reads
// src/version.ts — the one place the version is stated.
var version = "dev"

const helpText = `enc-tool agent — local filesystem + git bridge for the web editor

  enc-tool-agent [folder] [options]

The folder may be given as the first argument, so the binary can live anywhere
and be pointed at a project instead of copied into one:

  enc-tool-agent ~/work/my-project --allow-origin https://enc.example.com

  --root <dir>            same thing as the positional folder
                          (default: current directory)
  --port <n>              loopback port (default: 5001)
  --token <str>           fixed access token (default: random, printed below)
  --allow-origin <url>    origin allowed to connect, repeatable
                          (http://localhost:5000 and http://127.0.0.1:5000 are
                          allowed by default — the web app's own port)
  --allow-no-origin       also accept clients that send no Origin header:
                          curl, scripts, anything that is not a browser. Off by
                          default — a browser always sends one, so a missing
                          Origin is never the app.
  --allow-multiple        serve more than one client at once. By default the
                          agent takes a single connection and refuses the rest
                          while it is held, so it is always clear which page is
                          holding the folder.
  --no-clipboard          do not copy the URL to the clipboard on startup
  --version               print the version and exit

Environment:
  ENC_TOOL_ALLOW_ORIGIN   extra allowed origins, comma-separated — the same as
                          --allow-origin, but set once instead of per run

The agent listens on 127.0.0.1 only. Paste the URL below into the editor tab.`

type options struct {
	root          string
	port          int
	token         string
	origins       []string
	noClipboard   bool
	allowNoOrigin bool
	allowMultiple bool
}

// envOrigins reads comma- or space-separated origins from the environment.
//
// The agent people run is downloaded from a UI that is usually not on
// localhost, so it needs that origin allowed on every start. A variable can be
// set once in a shell profile; a flag has to be retyped every time.
func envOrigins() []string {
	raw := os.Getenv("ENC_TOOL_ALLOW_ORIGIN")
	out := []string{}
	for _, o := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
	}) {
		if o != "" {
			out = append(out, strings.TrimRight(o, "/"))
		}
	}
	return out
}

func fail(message string) {
	fmt.Fprintf(os.Stderr, "agent: %s\nTry --help.\n", message)
	os.Exit(2)
}

func parseArgs(argv []string) options {
	o := options{port: 5001, origins: envOrigins()}
	rootFrom := ""

	setRoot := func(dir, source string) {
		// Silently preferring one over the other would expose a folder the user
		// did not name — and this process hands that folder to a browser.
		if o.root != "" {
			fail(fmt.Sprintf("folder given twice: %s %q and %s %q", rootFrom, o.root, source, dir))
		}
		o.root = dir
		rootFrom = source
	}

	// i is declared outside the loop deliberately: value() consumes the next
	// argument for the spaced form of a flag, and that has to move the loop on.
	i := 0
	for ; i < len(argv); i++ {
		flag, inline, hasInline := strings.Cut(argv[i], "=")
		value := func() string {
			if hasInline {
				return inline
			}
			i++
			if i < len(argv) {
				return argv[i]
			}
			return ""
		}

		switch flag {
		case "--root":
			setRoot(value(), "--root")
		case "--port":
			if n, err := strconv.Atoi(value()); err == nil && n != 0 {
				o.port = n
			}
		case "--token":
			o.token = value()
		case "--allow-origin":
			o.origins = append(o.origins, strings.TrimSuffix(value(), "/"))
		case "--no-clipboard":
			o.noClipboard = true
		case "--allow-no-origin":
			o.allowNoOrigin = true
		case "--allow-multiple":
			o.allowMultiple = true
		case "--version", "-v":
			fmt.Println(version)
			os.Exit(0)
		case "--help", "-h":
			fmt.Println(helpText)
			os.Exit(0)
		default:
			// A mistyped flag must not be read as a folder, and must not be
			// ignored either — ignoring it would silently expose the current
			// directory instead of the one that was meant.
			if strings.HasPrefix(flag, "-") {
				fail(fmt.Sprintf("unknown option %q", flag))
			}
			setRoot(argv[i], "argument")
		}
	}

	if o.root == "" {
		cwd, err := os.Getwd()
		if err != nil {
			fail("cannot determine the current directory")
		}
		o.root = cwd
	}
	return o
}

// nodePlatform reports the value process.platform would have, so agent.info
// means the same thing whichever implementation answered it.
func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func main() {
	opts := parseArgs(os.Args[1:])

	token := opts.token
	if token == "" {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			fmt.Fprintln(os.Stderr, "agent: cannot generate a token")
			os.Exit(1)
		}
		token = hex.EncodeToString(b)
	}

	j, err := openJail(opts.root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent: cannot open folder: %s\n", opts.root)
		os.Exit(1)
	}

	ctx := context.Background()

	// Snap the workspace to the repository root when the folder sits inside one:
	// git reports paths relative to the toplevel, and one coordinate system for
	// both filesystem and git paths is what keeps the UI honest.
	top := repoRoot(ctx, j.root)
	if top != "" {
		if snapped, err := openJail(top); err == nil {
			if snapped.root != j.root {
				fmt.Printf("agent: using repository root %s\n", snapped.root)
			}
			j = snapped
		}
	}

	var repo *string
	if top != "" {
		repo = strPtr(".")
	}
	info := &agentInfo{
		Agent:      "enc-tool",
		Version:    version,
		Platform:   nodePlatform(),
		Root:       j.root,
		Repo:       repo,
		GitVersion: probe(ctx, []string{"git", "--version"}),
		Ripgrep:    probe(ctx, []string{"rg", "--version"}),
		// Probed once so agent.info can tell the UI the truth up front.
		Watch: watcherSupported(j.root),
	}

	srv := &server{
		jail:          j,
		info:          info,
		token:         token,
		origins:       opts.origins,
		allowNoOrigin: opts.allowNoOrigin,
		allowMultiple: opts.allowMultiple,
		isRepo:        top != "",
	}

	listener, err := listenLoopback(opts.port)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent: cannot listen on 127.0.0.1:%d: %v\n", opts.port, err)
		os.Exit(1)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	// The Host check compares against the port this agent actually answers on,
	// which is the one the listener reports.
	srv.port = port

	gitLine := "NOT FOUND — git operations are unavailable"
	if info.GitVersion != nil {
		gitLine = *info.GitVersion
	}
	rgLine := "not found — using the slower built-in search"
	if info.Ripgrep != nil {
		rgLine = *info.Ripgrep
	}
	watchLine := "unavailable on this platform"
	if info.Watch {
		watchLine = "live"
	}
	originLine := strings.Join(append(append([]string{}, defaultOrigins...), opts.origins...), ", ")
	noOriginLine := "refused"
	if opts.allowNoOrigin {
		noOriginLine = "accepted (--allow-no-origin)"
	}
	clientsLine := "one at a time — the second is refused while the first holds"
	if opts.allowMultiple {
		clientsLine = "many (--allow-multiple)"
	}

	url := fmt.Sprintf("ws://127.0.0.1:%d/ws?token=%s", port, token)

	// Copied for the user rather than left to their mouse: the token is new on
	// every run, so this is the one line they would otherwise select by hand
	// every single time. Only when someone is actually watching — see
	// interactive() — and never when they have asked us not to.
	clipLine := ""
	if !opts.noClipboard && interactive() && copyToClipboard(url) {
		clipLine = "\n  ✓ copied to your clipboard"
	}

	fmt.Printf(`
enc-tool agent %s
  folder    %s
  git       %s
  ripgrep   %s
  watcher   %s
  origins   %s
  no-origin %s
  clients   %s

  Paste this into the editor tab:
  %s%s

`, version, j.root, gitLine, rgLine, watchLine, originLine, noOriginLine, clientsLine, url, clipLine)

	httpSrv := &http.Server{Handler: srv}
	if err := httpSrv.Serve(listener); err != nil {
		fmt.Fprintf(os.Stderr, "agent: %v\n", err)
		os.Exit(1)
	}
}
