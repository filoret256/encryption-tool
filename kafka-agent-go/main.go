// The local kafka-agent: `kafka-agent`.
//
// Runs on the user's machine and lets the kafka tab browse and manage Kafka
// clusters over a loopback WebSocket. Every connection setting — bootstrap
// servers, TLS stores and their passwords, SCRAM credentials — is read here,
// from a config file or the command line, and never sent to the page: the page
// only ever names a cluster this process already knows.
//
// The front door (token, Origin, Host, WebSocket, the one-client lock) is
// agent-kit-go, shared with the code-agent.
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	agentkit "enc-tool/agent-kit"
)

// Overridden at link time by the build script, which reads src/version.ts —
// the one place the version is stated.
var version = "dev"

// The loopback ports this agent may bind, mirroring src/ports.ts
// (KAFKA_AGENT_PORT_*) — a range of its own, next to the code-agent's.
var kafkaAgentPorts = agentkit.PortRange{Min: 5011, Max: 5020, Env: "KAFKA_AGENT_PORTS"}

var helpText = fmt.Sprintf(`enc-tool kafka-agent — local Kafka bridge for the web app's kafka tab

  kafka-agent --config kafka-agent.yaml
  kafka-agent --bootstrap kafka1:9093 --properties client.properties

Clusters — every connection setting lives here, never in the page:

  --config <file>         clusters from a YAML file (format below). Without it,
                          and without a cluster on the command line, the agent
                          reads ./kafka-agent.yaml, then %s
  --bootstrap <hosts>     one more cluster from the command line: host:port,…
  --properties <file>     its settings from a Java client.properties — the file
                          kafka-console-consumer takes with --consumer.config
  -X <key>=<value>        one Java client property, repeatable; wins over
                          --properties. Quote a secret reference so the shell
                          leaves it alone: -X 'ssl.keystore.password=${KS_PASS}'
  --name <name>           that cluster's name (default: the first broker's host)
  --allow-write           let the agent change clusters — every cluster whose
                          configuration does not say readOnly. Without it a
                          cluster is read-only unless its own readOnly: false
                          says otherwise; readOnly: true is kept either way

Connection:

  --port <n>              pin the loopback port. Without it the agent takes the
                          first free port in %s — the ports the web app is
                          allowed to open a connection to. A port outside that
                          range is bound as asked, but the browser refuses it
                          unless the web app was started with KAFKA_AGENT_PORTS
                          naming it.
  --token <str>           fixed access token (default: random, printed below).
                          Visible to every process on the machine in the process
                          list — prefer KAFKA_AGENT_TOKEN.
  --allow-origin <url>    origin allowed to connect, repeatable
                          (http://localhost:5000 and http://127.0.0.1:5000 are
                          allowed by default — the web app's own port)
  --allow-no-origin       also accept clients that send no Origin header
  --allow-multiple        serve more than one client at once (default: one)
  --no-clipboard          do not copy the URL to the clipboard on startup
  --version               print the version and exit

Environment:
  ENC_TOOL_ALLOW_ORIGIN   extra allowed origins, comma-separated — shared with
                          the code-agent, so one line in a shell profile serves both
  KAFKA_AGENT_TOKEN       fixed access token, kept out of the process list.
                          Not ENC_TOOL_TOKEN: two agents with one token would let
                          a URL meant for one open the other.

Properties this agent reads (Java names; everything else is ignored with a note):
  bootstrap.servers, security.protocol (PLAINTEXT, SSL, SASL_PLAINTEXT, SASL_SSL),
  ssl.truststore.{location,password,type,certificates},
  ssl.keystore.{location,password,type,certificate.chain,key}, ssl.key.password,
  ssl.endpoint.identification.algorithm, sasl.mechanism (SCRAM-SHA-256/512),
  sasl.jaas.config (ScramLoginModule). Store types: JKS, PKCS12, PEM.

A value may be ${NAME} / ${env:NAME} (environment) or ${file:/path} (a file's
contents) instead of the secret itself. Relative paths are relative to the file
that names them. Store formats (PEM, PKCS12, JKS) are recognised by the file's
own bytes, not by the declared type.

Every mistake is reported at startup with the file, the line and the key. The
stores are opened then too, so a wrong password shows up when the agent starts.
On Unix the agent also warns, once, about a config, properties file, keystore,
key or ${file:…} secret that other users can read (chmod 600 fixes it).

Every operation the agent has is either a read or a write. A write on a read-only
cluster — the default — is refused with READ_ONLY before anything is sent to a
broker; readOnly: false for a cluster, or --allow-write for all that say nothing,
lifts that. Every write, done, failed or refused, is logged as one line on stderr:
cluster, operation, target, result — never message content, setting values or
error text. The kafka tab's "reload config" button (or the config.reload op)
reads all of this again with the same flags: a sound file replaces the running
configuration, a file with a typo leaves it as it was and says where the typo is.

kafka-agent.yaml:

  clusters:
    - name: prod
      bootstrap: [kafka1:9093, kafka2:9093]
      properties: ./prod.client.properties    # a Java client.properties, or a mapping
    - name: dev
      bootstrap: localhost:9094
      readOnly: true                          # the default; false lets the agent change this cluster
      security:
        protocol: SASL_SSL
        tls:
          truststore: { location: ./truststore.jks, password: "${TS_PASS}" }
          keystore:   { location: ./client.p12, type: PKCS12, password: "${KS_PASS}" }
          # or PEM files:  ca: ca.pem   cert: client.pem   key: client.key
          # verifyHostname: false
        sasl: { mechanism: SCRAM-SHA-512, username: app, password: "${file:~/.kafka/dev.pass}" }

The agent listens on 127.0.0.1 only. Paste the URL below into the kafka tab.`, userConfigHint(), kafkaAgentPorts)

// userConfigHint is where the second default config lives on this machine.
func userConfigHint() string {
	paths := defaultConfigPaths()
	return paths[len(paths)-1]
}

type options struct {
	clusters      clusterFlags
	port          int
	portExplicit  bool
	token         string
	origins       []string
	noClipboard   bool
	allowNoOrigin bool
	allowMultiple bool
}

func fail(message string) {
	fmt.Fprintf(os.Stderr, "kafka-agent: %s\nTry --help.\n", message)
	os.Exit(2)
}

func parseArgs(argv []string) options {
	o := options{port: kafkaAgentPorts.Min, origins: agentkit.EnvOrigins("ENC_TOOL_ALLOW_ORIGIN")}

	// i lives outside the loop: value() consumes the next argument for the
	// spaced form of a flag, and that has to move the loop on.
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
			fail(fmt.Sprintf("%s needs a value", flag))
			return ""
		}

		switch flag {
		case "--config", "-c":
			o.clusters.config = value()
		case "--bootstrap":
			o.clusters.bootstrap = value()
		case "--properties":
			o.clusters.properties = value()
		case "--name":
			o.clusters.name = value()
		case "--allow-write":
			// Applied in loadClusters, so that config.reload reads the file the same way.
			o.clusters.allowWrite = true
		case "-X":
			o.clusters.x = append(o.clusters.x, value())
		case "--port":
			raw := value()
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || n > 65535 {
				fail(fmt.Sprintf("--port takes a port number, not %q", raw))
			}
			o.port = n
			o.portExplicit = true
		case "--token":
			o.token = value()
			fmt.Fprintln(os.Stderr, "kafka-agent: warning: --token puts the token in the process list; KAFKA_AGENT_TOKEN keeps it out")
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
			// Ignoring a mistyped flag would run the agent without a setting the
			// operator believes they gave — a TLS store, a read-only switch.
			fail(fmt.Sprintf("unknown option %q", argv[i]))
		}
	}
	return o
}

// nodePlatform reports what process.platform would, so agent.info means the
// same thing as the code-agent's code-agent.info.
func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func main() {
	agentkit.Name = "kafka-agent"
	opts := parseArgs(os.Args[1:])

	token := opts.token
	if token == "" {
		token = os.Getenv("KAFKA_AGENT_TOKEN")
	}
	if token == "" {
		var err error
		if token, err = agentkit.NewToken(); err != nil {
			fmt.Fprintln(os.Stderr, "kafka-agent: cannot generate a token")
			os.Exit(1)
		}
	}

	clusters, configFile, err := loadClusters(opts.clusters)
	if err != nil {
		fmt.Fprintf(os.Stderr, "kafka-agent: %v\n", err)
		os.Exit(2)
	}
	for _, w := range warningsOf(clusters) {
		fmt.Fprintf(os.Stderr, "kafka-agent: warning: %s\n", w)
	}
	for _, c := range clusters {
		if c.writableByFlag {
			fmt.Fprintf(os.Stderr, "kafka-agent: warning: --allow-write makes cluster %q writable — set readOnly: true for it to keep it read-only\n", c.Name)
		}
		if !c.VerifyHostname {
			fmt.Fprintf(os.Stderr, "kafka-agent: warning: cluster %q does not check that broker certificates are issued for the broker's name\n", c.Name)
		}
	}

	srv := &server{
		Guard: agentkit.Guard{
			Token:         token,
			Origins:       opts.origins,
			AllowNoOrigin: opts.allowNoOrigin,
			AllowMultiple: opts.allowMultiple,
			Ping:          map[string]string{"agent": "kafka-agent", "version": version},
		},
	}
	srv.audit = os.Stderr
	srv.setClusters(clusters)
	// The same flags, read again: config.reload takes what is on disk now.
	srv.reload = func() ([]*cluster, error) {
		list, _, err := loadClusters(opts.clusters)
		return list, err
	}

	listener := agentkit.Listen(kafkaAgentPorts, opts.port, opts.portExplicit)
	port := listener.Addr().(*net.TCPAddr).Port
	srv.Port = port

	if !kafkaAgentPorts.Contains(port) {
		fmt.Fprintf(os.Stderr,
			"kafka-agent: warning: port %d is outside %s — the kafka tab will refuse it unless the web app was started with KAFKA_AGENT_PORTS=%d\n",
			port, kafkaAgentPorts, port)
	}

	url := fmt.Sprintf("ws://127.0.0.1:%d/ws?token=%s", port, token)
	clipLine := ""
	if !opts.noClipboard && agentkit.Interactive() && agentkit.CopyToClipboard(url) {
		clipLine = "\n  ✓ copied to your clipboard"
	}

	originLine := strings.Join(append(append([]string{}, agentkit.DefaultOrigins...), opts.origins...), ", ")
	clientsLine := "one at a time — the second is refused while the first holds"
	if opts.allowMultiple {
		clientsLine = "many (--allow-multiple)"
	}

	var clusterLines strings.Builder
	width := 0
	for _, c := range clusters {
		width = max(width, len(c.Name))
	}
	for _, c := range clusters {
		fmt.Fprintf(&clusterLines, "    %-*s  %s\n", width, c.Name, c.describe())
	}
	configLine := "command line"
	if configFile != "" {
		configLine = configFile
	}

	fmt.Printf(`
enc-tool kafka-agent %s
  config    %s
  clusters
%s  origins   %s
  clients   %s

  Paste this into the kafka tab:
  %s%s

`, version, configLine, clusterLines.String(), originLine, clientsLine, url, clipLine)

	// Timeouts on the plain-HTTP part; an upgraded WebSocket clears them.
	httpSrv := &http.Server{
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	if err := httpSrv.Serve(listener); err != nil {
		fmt.Fprintf(os.Stderr, "kafka-agent: %v\n", err)
		os.Exit(1)
	}
}
