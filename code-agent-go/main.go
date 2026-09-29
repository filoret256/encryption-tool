// The local code-agent: `enc-tool-code-agent`.
//
// Runs on the user's machine next to their repository and exposes the
// filesystem, the system `git` and ripgrep to the browser tab over a loopback
// WebSocket. This exists because a web page cannot spawn processes — there is
// no API for it — so "use the git installed in the OS" necessarily means a
// small local process doing the spawning.
//
// A line-for-line port of src/code-agent/main.ts. The TypeScript version remains the
// reference implementation; both are driven by the same wire-level smoke test
// (scripts/code-agent-smoke.ts) precisely so that "port" can mean something checked
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
	"time"
)

// Overridden at link time by scripts/build-code-agents-go.ts, which reads
// src/version.ts — the one place the version is stated.
var version = "dev"

// The loopback ports a code-agent may bind, mirroring src/ports.ts — which is where
// the reasoning lives. Two processes have to agree on this: the code-agent picks a
// port, and the page is only allowed to open a connection to the ports its own
// connect-src names. Disagreement is silent, and looks from the tab exactly
// like a code-agent that never started.
const (
	codeAgentPortMin = 5001
	codeAgentPortMax = 5010
)

// codeAgentPortRange is the "5001-5010" spelling, for help text and messages.
var codeAgentPortRange = fmt.Sprintf("%d-%d", codeAgentPortMin, codeAgentPortMax)

var helpText = fmt.Sprintf(`enc-tool code-agent — local filesystem + git bridge for the web editor

  enc-tool-code-agent [folder] [options]

The folder may be given as the first argument, so the binary can live anywhere
and be pointed at a project instead of copied into one:

  enc-tool-code-agent ~/work/my-project --allow-origin https://enc.example.com

  --root <dir>            same thing as the positional folder
                          (default: current directory)
  --port <n>              pin the loopback port. Without it the code-agent takes the
                          first free port in %s — the ports the web app is
                          allowed to open a connection to — so a second code-agent on
                          a second folder needs no flag at all. A port outside
                          that range is bound as asked, but the browser refuses
                          it unless the web app was started with CODE_AGENT_PORTS
                          naming it.
  --token <str>           fixed access token (default: random, printed below).
                          Visible to every process on the machine in the process
                          list — prefer ENC_TOOL_TOKEN.
  --allow-origin <url>    origin allowed to connect, repeatable
                          (http://localhost:5000 and http://127.0.0.1:5000 are
                          allowed by default — the web app's own port)
  --allow-no-origin       also accept clients that send no Origin header:
                          curl, scripts, anything that is not a browser. Off by
                          default — a browser always sends one, so a missing
                          Origin is never the app.
  --allow-root <dir>      another folder the editor may switch the workspace
                          to, repeatable. Without it the workspace can only be
                          moved inside the folder the code-agent was started on,
                          which can never reach anything it could not already
                          read. Naming a folder here is what lets the editor
                          open a second project without a second code-agent.
  --allow-multiple        serve more than one client at once. By default the
                          code-agent takes a single connection and refuses the rest
                          while it is held, so it is always clear which page is
                          holding the folder.
  --no-clipboard          do not copy the URL to the clipboard on startup
  --version               print the version and exit

Environment:
  ENC_TOOL_ALLOW_ORIGIN   extra allowed origins, comma-separated — the same as
                          --allow-origin, but set once instead of per run
  ENC_TOOL_TOKEN          fixed access token — the same as --token, but not
                          readable from the process list. --token wins if both
                          are given.

The code-agent listens on 127.0.0.1 only. Paste the URL below into the editor tab.`, codeAgentPortRange)

type options struct {
	root          string
	port          int
	portExplicit  bool
	token         string
	origins       []string
	noClipboard   bool
	allowNoOrigin bool
	allowMultiple bool
	// Folders code-agent.setRoot may move the workspace into, beyond the startup
	// root itself. Empty is the safe default — see (*server).setRoot.
	allowRoots []string
}

// envOrigins reads comma- or space-separated origins from the environment.
//
// The code-agent people run is downloaded from a UI that is usually not on
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
	fmt.Fprintf(os.Stderr, "code-agent: %s\nTry --help.\n", message)
	os.Exit(2)
}

func parseArgs(argv []string) options {
	o := options{port: codeAgentPortMin, origins: envOrigins()}
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
			// A mistyped port used to be ignored and the default used instead,
			// which is the silent wrong answer this file refuses everywhere
			// else: the user would be handed a URL for a port they never asked
			// for.
			raw := value()
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || n > 65535 {
				fail(fmt.Sprintf("--port takes a port number, not %q", raw))
			}
			o.port = n
			o.portExplicit = true
		case "--token":
			o.token = value()
			// A command line is readable by every process on the machine — `ps`,
			// Task Manager, WMI — and lands in shell history. The environment is not.
			fmt.Fprintln(os.Stderr, "code-agent: warning: --token puts the token in the process list; ENC_TOOL_TOKEN keeps it out")
		case "--allow-origin":
			o.origins = append(o.origins, strings.TrimSuffix(value(), "/"))
		case "--no-clipboard":
			o.noClipboard = true
		case "--allow-no-origin":
			o.allowNoOrigin = true
		case "--allow-root":
			o.allowRoots = append(o.allowRoots, value())
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

// nodePlatform reports the value process.platform would have, so code-agent.info
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
		token = os.Getenv("ENC_TOOL_TOKEN")
	}
	if token == "" {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			fmt.Fprintln(os.Stderr, "code-agent: cannot generate a token")
			os.Exit(1)
		}
		token = hex.EncodeToString(b)
	}

	j, err := openJail(opts.root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "code-agent: cannot open folder: %s\n", opts.root)
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
				fmt.Printf("code-agent: using repository root %s\n", snapped.root)
			}
			j = snapped
		}
	}

	var repo *string
	if top != "" {
		repo = strPtr(".")
	}
	// A git that is too old is reported as no git, with the reason beside it: the
	// UI reads a null version as "no version control", which is what an old git
	// means in practice, and its operations are refused in dispatch.
	gitVersion := probe(ctx, []string{"git", "--version"})
	gitProblem := gitVersionProblem(gitVersion)
	if gitProblem != nil {
		gitVersion = nil
	}
	info := &codeAgentInfo{
		CodeAgent:  "enc-tool",
		Version:    version,
		Platform:   nodePlatform(),
		Root:       j.root,
		Repo:       repo,
		GitVersion: gitVersion,
		GitProblem: gitProblem,
		Ripgrep:    probe(ctx, []string{"rg", "--version"}),
		// Probed once so code-agent.info can tell the UI the truth up front.
		Watch: watcherSupported(j.root),
	}

	// The startup root is always allowed, so setRoot can narrow to a subfolder
	// and come back — neither reaches anything this code-agent could not already
	// read, which makes the default a non-escalation rather than a judgement
	// call. Anything wider is a --allow-root on the command line.
	rerootBases := []string{j.root}
	for _, dir := range opts.allowRoots {
		allowed, err := openJail(dir)
		if err != nil {
			fail(fmt.Sprintf("--allow-root folder does not exist: %s", dir))
		}
		rerootBases = append(rerootBases, allowed.root)
	}

	srv := &server{
		token:         token,
		origins:       opts.origins,
		allowNoOrigin: opts.allowNoOrigin,
		allowMultiple: opts.allowMultiple,
		rerootBases:   rerootBases,
	}
	srv.ws.Store(&workspace{jail: j, isRepo: top != "", info: info})

	listener := listen(opts)
	port := listener.Addr().(*net.TCPAddr).Port
	// The Host check compares against the port this code-agent actually answers on,
	// which is the one the listener reports.
	srv.port = port

	gitLine := "NOT FOUND — git operations are unavailable"
	if info.GitVersion != nil {
		gitLine = *info.GitVersion
	} else if info.GitProblem != nil {
		gitLine = "UNUSABLE — " + *info.GitProblem
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

	// The page's connect-src names the range and nothing outside it, so a port
	// beyond it is one the browser refuses before a packet leaves. Said on
	// stderr: stdout carries the URL and nothing else, on purpose.
	if port < codeAgentPortMin || port > codeAgentPortMax {
		fmt.Fprintf(os.Stderr,
			"code-agent: warning: port %d is outside %s — the editor tab will refuse it unless the web app was started with CODE_AGENT_PORTS=%d\n",
			port, codeAgentPortRange, port)
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
enc-tool code-agent %s
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

	// Timeouts on the parts that are plain HTTP. Without ReadHeaderTimeout a
	// client that opens a connection and sends a byte a minute holds it, and a
	// goroutine, forever — on loopback, but this port is open to every process
	// and every web page on the machine. A WebSocket is not affected: wsUpgrade
	// takes the socket over and clears the deadline net/http armed, so a session
	// is as long-lived as ever.
	httpSrv := &http.Server{
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	if err := httpSrv.Serve(listener); err != nil {
		fmt.Fprintf(os.Stderr, "code-agent: %v\n", err)
		os.Exit(1)
	}
}
