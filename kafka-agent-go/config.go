// Where clusters come from: kafka-agent.yaml, Java client.properties files and
// the command line — never from the page.
//
// Every source is reduced to the same Java client property keys and applied
// through one function, applyProperty, so a setting means the same thing
// whichever file it was written in, and is checked in exactly one place:
//
//	properties file  <  yaml (bootstrap, security)  <  -X on the command line
//
// Values may name secrets instead of holding them: ${NAME} or ${env:NAME} is an
// environment variable, ${file:/path} the contents of a file; $${ is a literal
// "${". Relative paths are relative to the file that names them, not to
// wherever the agent happened to be started.
package main

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// store is a key or trust store as Java names it.
type store struct {
	Location string // absolute
	Password string
	Type     string // JKS, PKCS12, PEM, or "" to tell from the content
}

// cluster is one resolved connection. Everything in it stays in this process:
// agent.info reports Name and ReadOnly, nothing else.
type cluster struct {
	Name      string
	Bootstrap []string
	// Whether the agent may change anything on this cluster. True unless the
	// operator said otherwise: readOnly: false in the file, or --allow-write for a
	// cluster whose file says nothing. The check is server.go's (mayWrite).
	ReadOnly bool
	// readOnly was written down in the configuration, either way. --allow-write
	// lifts the default, not a decision: a cluster the operator marked readOnly: true
	// stays read-only.
	readOnlySet bool
	// ReadOnly is false because of --allow-write, not because the file says so.
	writableByFlag bool
	Protocol       string // PLAINTEXT, SSL, SASL_PLAINTEXT, SASL_SSL

	Truststore store
	// CA certificates given inline (ssl.truststore.certificates).
	TrustPEM string

	Keystore    store
	KeyPassword string // ssl.key.password: the key's own, when it differs from the store's
	// A client certificate and key as separate PEM files (yaml tls.cert, tls.key)…
	CertFile, KeyFile string
	// …or inline (ssl.keystore.certificate.chain, ssl.keystore.key).
	CertPEM, KeyPEM string

	// ssl.endpoint.identification.algorithm: "https" (the default) or "" to
	// accept a broker certificate issued for another name.
	VerifyHostname bool

	Mechanism          string // SCRAM-SHA-256 or SCRAM-SHA-512
	Username, Password string

	// The cluster's Schema Registry, when it has one (K-41). Nil for a cluster without.
	Registry *registryConfig

	// Where the cluster was defined — "kafka-agent.yaml:12", "command line" —
	// for every message about it.
	source   string
	Warnings []string
	// The files this cluster's settings came from or point at that hold secrets:
	// its properties files, its keystore and key, the files named by ${file:…}.
	// Checked for who else can read them (perm.go).
	secretFiles []string
}

// noteSecret records a file that holds a secret.
func (c *cluster) noteSecret(path string) {
	if path != "" {
		c.secretFiles = append(c.secretFiles, path)
	}
}

func newCluster(source string) *cluster {
	return &cluster{ReadOnly: true, VerifyHostname: true, source: source}
}

// configError names the place a setting came from, so the operator can go
// straight to the line.
type configError struct {
	where, key, msg string
}

func (e *configError) Error() string {
	if e.key == "" {
		return fmt.Sprintf("%s: %s", e.where, e.msg)
	}
	return fmt.Sprintf("%s: %s: %s", e.where, e.key, e.msg)
}

// ── values: secrets and paths ─────────────────────────────────────────────

var placeholder = regexp.MustCompile(`\$\$\{|\$\{([^}]*)\}`)

// expand replaces ${…} references; a relative ${file:…} is relative to base. An unset variable or unreadable file is an
// error, never an empty string: an empty password is a login failure much
// later, and a far less helpful one.
func expand(value, base string, onFile ...func(path string)) (string, error) {
	var firstErr error
	out := placeholder.ReplaceAllStringFunc(value, func(m string) string {
		if m == "$${" {
			return "${"
		}
		ref := m[2 : len(m)-1]
		switch {
		case strings.HasPrefix(ref, "file:"):
			path := resolvePath(base, strings.TrimPrefix(ref, "file:"))
			for _, note := range onFile {
				note(path)
			}
			raw, err := os.ReadFile(path) // #nosec G304 -- a secret file the operator named in their own config
			if err != nil && firstErr == nil {
				firstErr = fmt.Errorf("${file:%s}: %v", path, err)
			}
			// A trailing newline is how nearly every editor saves a file, and
			// never part of the secret.
			return strings.TrimRight(string(raw), "\r\n")
		default:
			name := strings.TrimPrefix(ref, "env:")
			v, ok := os.LookupEnv(name)
			if !ok && firstErr == nil {
				firstErr = fmt.Errorf("${%s}: environment variable %s is not set", ref, name)
			}
			return v
		}
	})
	return out, firstErr
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[1:])
		}
	}
	return p
}

// resolvePath makes a path absolute against the directory of the file that
// named it.
func resolvePath(base, p string) string {
	p = expandHome(p)
	if p == "" || filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(base, p)
}

// ── applying one setting ──────────────────────────────────────────────────

// Mechanisms Kafka knows and this agent deliberately does not implement —
// named, so the refusal says "not supported" rather than "unknown".
var unsupportedMechanisms = map[string]bool{"PLAIN": true, "GSSAPI": true, "OAUTHBEARER": true, "AWS_MSK_IAM": true}

// applyProperty sets one Java client property on c. base is the directory
// relative paths are resolved against; where is used in messages.
func applyProperty(c *cluster, key, raw, base, where string) error {
	fail := func(format string, a ...any) error {
		return &configError{where: where, key: key, msg: fmt.Sprintf(format, a...)}
	}
	value, err := expand(raw, base, c.noteSecret)
	if err != nil {
		return fail("%v", err)
	}
	upper := strings.ToUpper(strings.TrimSpace(value))

	switch key {
	case "bootstrap.servers":
		c.Bootstrap = splitList(value)

	case "security.protocol":
		switch upper {
		case "PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL":
			c.Protocol = upper
		default:
			return fail("%q is not one of PLAINTEXT, SSL, SASL_PLAINTEXT, SASL_SSL", value)
		}

	case "ssl.truststore.location":
		c.Truststore.Location = resolvePath(base, value)
	case "ssl.truststore.password":
		c.Truststore.Password = value
	case "ssl.truststore.type":
		if c.Truststore.Type, err = storeType(upper); err != nil {
			return fail("%v", err)
		}
	case "ssl.truststore.certificates":
		c.TrustPEM = value

	case "ssl.keystore.location":
		c.Keystore.Location = resolvePath(base, value)
		c.noteSecret(c.Keystore.Location) // it holds the private key
	case "ssl.keystore.password":
		c.Keystore.Password = value
	case "ssl.keystore.type":
		if c.Keystore.Type, err = storeType(upper); err != nil {
			return fail("%v", err)
		}
	case "ssl.keystore.certificate.chain":
		c.CertPEM = value
	case "ssl.keystore.key":
		c.KeyPEM = value
	case "ssl.key.password":
		c.KeyPassword = value

	case "ssl.endpoint.identification.algorithm":
		switch upper {
		case "":
			c.VerifyHostname = false
		case "HTTPS":
			c.VerifyHostname = true
		default:
			return fail("%q — only \"https\" or empty (no hostname check) are meaningful", value)
		}

	case "sasl.mechanism":
		switch {
		case upper == "SCRAM-SHA-256" || upper == "SCRAM-SHA-512":
			c.Mechanism = upper
		case unsupportedMechanisms[upper]:
			return fail("%s is not supported by this agent — use SCRAM-SHA-256 or SCRAM-SHA-512", upper)
		default:
			return fail("%q is not a SASL mechanism this agent knows (SCRAM-SHA-256, SCRAM-SHA-512)", value)
		}

	case "sasl.jaas.config":
		e, err := parseJAAS(value)
		if err != nil {
			return fail("%v", err)
		}
		switch {
		case strings.HasSuffix(e.module, ".ScramLoginModule"):
		case strings.HasSuffix(e.module, ".PlainLoginModule"):
			return fail("PlainLoginModule (SASL PLAIN) is not supported by this agent — use SCRAM")
		default:
			return fail("%s is not supported by this agent — use org.apache.kafka.common.security.scram.ScramLoginModule", e.module)
		}
		c.Username, c.Password = e.options["username"], e.options["password"]

	default:
		// A client.properties made for a JVM client carries plenty that means
		// nothing here — acks, linger.ms, group.id. Said once, not refused.
		c.Warnings = append(c.Warnings, fmt.Sprintf("%s: %s is not a connection setting this agent uses — ignored", where, key))
	}
	return nil
}

func storeType(upper string) (string, error) {
	switch upper {
	case "JKS", "PKCS12", "PEM":
		return upper, nil
	case "P12", "PFX":
		return "PKCS12", nil
	case "":
		return "", nil
	}
	return "", fmt.Errorf("%q is not a store type this agent reads (JKS, PKCS12, PEM)", upper)
}

func splitList(v string) []string {
	var out []string
	for _, s := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' }) {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func applyPropertiesFile(c *cluster, path string) error {
	c.noteSecret(path) // a client.properties is where the passwords are
	props, err := readProperties(path)
	if err != nil {
		return &configError{where: c.source, msg: err.Error()}
	}
	base := filepath.Dir(path)
	for _, p := range props {
		if err := applyProperty(c, p.key, p.value, base, fmt.Sprintf("%s:%d", path, p.line)); err != nil {
			return err
		}
	}
	return nil
}

// ── checking a finished cluster ───────────────────────────────────────────

var clusterName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// validate checks what can be checked without a broker: that the settings
// agree with each other and the files they name exist. What only a connection
// can tell — a wrong password, an untrusted certificate — is reported by the
// connection, with the same care (see K-06/K-08 in to-do.md).
func (c *cluster) validate() error {
	fail := func(key, format string, a ...any) error {
		return &configError{where: fmt.Sprintf("%s (cluster %q)", c.source, c.Name), key: key, msg: fmt.Sprintf(format, a...)}
	}
	if !clusterName.MatchString(c.Name) {
		return &configError{where: c.source, key: "name", msg: fmt.Sprintf("%q — a name is 1-64 letters, digits, '.', '_' or '-'", c.Name)}
	}
	if len(c.Bootstrap) == 0 {
		return fail("bootstrap", "no bootstrap servers — set bootstrap (yaml), bootstrap.servers (properties) or --bootstrap")
	}
	for _, b := range c.Bootstrap {
		host, port, err := net.SplitHostPort(b)
		n, perr := strconv.Atoi(port)
		if err != nil || host == "" || perr != nil || n < 1 || n > 65535 {
			return fail("bootstrap", "%q is not host:port", b)
		}
	}
	if c.Protocol == "" {
		c.Protocol = "PLAINTEXT"
	}
	// A Schema Registry is checked here, before the broker's own TLS and SASL settings:
	// it stands on its own, and its URL, login and stores are the operator's to get right
	// whether or not the broker connection is sound.
	if err := c.validateRegistry(); err != nil {
		return err
	}
	usesTLS := c.Protocol == "SSL" || c.Protocol == "SASL_SSL"
	usesSASL := strings.HasPrefix(c.Protocol, "SASL_")

	if usesSASL {
		if c.Mechanism == "" {
			// Java's default here is GSSAPI, which this agent does not do; a
			// silent SCRAM would be a guess about someone's credentials.
			return fail("sasl.mechanism", "%s needs sasl.mechanism: SCRAM-SHA-256 or SCRAM-SHA-512", c.Protocol)
		}
		if c.Username == "" || c.Password == "" {
			return fail("sasl", "%s with %s needs a username and a password (sasl.jaas.config, or sasl.username/password in yaml)", c.Protocol, c.Mechanism)
		}
	} else if c.Mechanism != "" || c.Username != "" {
		c.Warnings = append(c.Warnings, fmt.Sprintf("%s (cluster %q): SASL settings ignored — security.protocol is %s", c.source, c.Name, c.Protocol))
	}

	hasTLSSettings := tlsGiven(c)
	if !usesTLS && hasTLSSettings {
		c.Warnings = append(c.Warnings, fmt.Sprintf("%s (cluster %q): TLS settings ignored — security.protocol is %s", c.source, c.Name, c.Protocol))
	}
	if !usesTLS {
		return nil
	}

	if c.Truststore.Location != "" && c.TrustPEM != "" {
		return fail("ssl.truststore", "both a truststore file and inline certificates — pick one")
	}
	clientCerts := 0
	for _, set := range []bool{c.Keystore.Location != "", c.CertFile != "" || c.KeyFile != "", c.CertPEM != "" || c.KeyPEM != ""} {
		if set {
			clientCerts++
		}
	}
	if clientCerts > 1 {
		return fail("ssl.keystore", "more than one client certificate given (keystore, cert/key files, inline PEM) — pick one")
	}
	if (c.CertFile == "") != (c.KeyFile == "") {
		return fail("tls.cert/tls.key", "a client certificate needs both cert and key")
	}
	if (c.CertPEM == "") != (c.KeyPEM == "") {
		return fail("ssl.keystore.certificate.chain/ssl.keystore.key", "an inline client certificate needs both the chain and the key")
	}
	for key, path := range map[string]string{
		"ssl.truststore.location": c.Truststore.Location,
		"ssl.keystore.location":   c.Keystore.Location,
		"tls.cert":                c.CertFile,
		"tls.key":                 c.KeyFile,
	} {
		if path == "" {
			continue
		}
		if st, err := os.Stat(path); err != nil {
			return fail(key, "%s: %v", path, errors.Unwrap(err))
		} else if st.IsDir() {
			return fail(key, "%s is a folder, not a file", path)
		}
	}
	// Everything a broker could not tell us: whether the stores open, whether
	// the key fits its certificate. A wrong password is worth knowing when the
	// agent starts, not when somebody opens the tab.
	if _, err := buildTLS(c); err != nil {
		return &configError{where: fmt.Sprintf("%s (cluster %q)", c.source, c.Name), msg: err.Error()}
	}
	return nil
}

// tlsGiven says whether a cluster-shaped holder has any TLS setting at all: a store, a file
// or inline PEM. Used for the cluster's own settings and for a registry's alike.
func tlsGiven(c *cluster) bool {
	return c.Truststore.Location != "" || c.Keystore.Location != "" || c.CertFile != "" || c.KeyFile != "" ||
		c.TrustPEM != "" || c.CertPEM != "" || c.KeyPEM != ""
}

// validateRegistry checks a Schema Registry before anything is asked of it: a URL that is
// one, a login that is complete, and TLS settings that open. The registry logs in with its
// own credentials over its own TLS: neither is the cluster's, and a mistake in one must not
// look like a mistake in the other.
func (c *cluster) validateRegistry() error {
	r := c.Registry
	if r == nil {
		return nil
	}
	fail := func(key, format string, a ...any) error {
		return &configError{where: fmt.Sprintf("%s (cluster %q)", c.source, c.Name), key: key, msg: fmt.Sprintf(format, a...)}
	}
	u, err := url.Parse(r.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return fail("schemaRegistry.url", "%q is not a URL — write it as https://host:port", r.URL)
	}
	if u.User != nil {
		// A password in a URL ends up in every message about that URL, and this agent
		// prints the URL. The login has fields of its own, and they may be ${ENV}.
		return fail("schemaRegistry.url", "the URL carries a login in it — put the user and the password in schemaRegistry.username and schemaRegistry.password (the password may be ${ENV} or ${file:…})")
	}
	if (r.Username == "") != (r.Password == "") {
		return fail("schemaRegistry", "basic auth needs a username and a password together (the password may be ${ENV} or ${file:…})")
	}
	hasTLS := tlsGiven(r.tls)
	if u.Scheme == "http" {
		if hasTLS {
			c.Warnings = append(c.Warnings, fmt.Sprintf("%s (cluster %q): the schema registry's TLS settings are ignored — schemaRegistry.url is http", c.source, c.Name))
		}
		return nil
	}
	for _, f := range []struct{ key, path string }{
		{"schemaRegistry.tls.truststore.location", r.tls.Truststore.Location},
		{"schemaRegistry.tls.keystore.location", r.tls.Keystore.Location},
		{"schemaRegistry.tls.cert", r.tls.CertFile},
		{"schemaRegistry.tls.key", r.tls.KeyFile},
	} {
		if f.path == "" {
			continue
		}
		if st, err := os.Stat(f.path); err != nil {
			return fail(f.key, "%s: %v", f.path, errors.Unwrap(err))
		} else if st.IsDir() {
			return fail(f.key, "%s is a folder, not a file", f.path)
		}
	}
	// The same early error as the cluster's: a store that will not open is worth knowing
	// when the agent starts, not when somebody opens the tab.
	if _, err := buildTLS(r.tls); err != nil {
		return &configError{where: fmt.Sprintf("%s (cluster %q)", c.source, c.Name), key: "schemaRegistry.tls", msg: err.Error()}
	}
	return nil
}

// ── kafka-agent.yaml ──────────────────────────────────────────────────────

type yamlFile struct {
	Clusters []yamlCluster `yaml:"clusters"`
}

type yamlCluster struct {
	Name           string              `yaml:"name"`
	Bootstrap      stringList          `yaml:"bootstrap"`
	ReadOnly       *bool               `yaml:"readOnly"`
	Properties     propertiesRef       `yaml:"properties"`
	Security       *yamlSecurity       `yaml:"security"`
	SchemaRegistry *yamlSchemaRegistry `yaml:"schemaRegistry"`
}

// yamlSchemaRegistry is a cluster's Schema Registry (K-41): where it is, the login for it,
// and its own TLS settings — the same store kinds as the cluster's, kept apart from them, so
// that one set of stores cannot change the other connection.
type yamlSchemaRegistry struct {
	URL      string   `yaml:"url"`
	Username string   `yaml:"username"`
	Password string   `yaml:"password"`
	TLS      *yamlTLS `yaml:"tls"`
}

// registryConfig is that registry as the rest of the agent uses it.
//
// The TLS settings live in a cluster-shaped holder because that is what tls.go reads: the
// same code builds the broker's *tls.Config and the registry's, from the same store kinds,
// and no other field of the holder is ever looked at.
type registryConfig struct {
	URL      string
	Username string
	Password string
	tls      *cluster
}

type yamlSecurity struct {
	Protocol string    `yaml:"protocol"`
	TLS      *yamlTLS  `yaml:"tls"`
	SASL     *yamlSASL `yaml:"sasl"`
}

type yamlStore struct {
	Location    string `yaml:"location"`
	Password    string `yaml:"password"`
	Type        string `yaml:"type"`
	KeyPassword string `yaml:"keyPassword"`
}

type yamlTLS struct {
	Truststore     *yamlStore `yaml:"truststore"`
	Keystore       *yamlStore `yaml:"keystore"`
	CA             string     `yaml:"ca"`
	Cert           string     `yaml:"cert"`
	Key            string     `yaml:"key"`
	KeyPassword    string     `yaml:"keyPassword"`
	VerifyHostname *bool      `yaml:"verifyHostname"`
}

type yamlSASL struct {
	Mechanism string `yaml:"mechanism"`
	Username  string `yaml:"username"`
	Password  string `yaml:"password"`
}

// stringList accepts a list or one comma-separated string.
type stringList []string

func (l *stringList) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		*l = splitList(n.Value)
		return nil
	}
	var list []string
	if err := n.Decode(&list); err != nil {
		return err
	}
	*l = list
	return nil
}

// propertiesRef is a path to a client.properties file, or the properties
// themselves as a mapping.
type propertiesRef struct {
	path   string
	inline []property
}

func (p *propertiesRef) UnmarshalYAML(n *yaml.Node) error {
	switch n.Kind {
	case yaml.ScalarNode:
		p.path = n.Value
		return nil
	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, v := n.Content[i], n.Content[i+1]
			if v.Kind != yaml.ScalarNode {
				return fmt.Errorf("line %d: properties.%s must be a single value", v.Line, k.Value)
			}
			p.inline = append(p.inline, property{key: k.Value, value: v.Value, line: v.Line})
		}
		return nil
	}
	return fmt.Errorf("line %d: properties is a path to a .properties file or a mapping of properties", n.Line)
}

// loadYAML reads a kafka-agent.yaml. Unknown keys are errors: a misspelt
// "trustore" silently ignored is a connection without the trust someone
// configured.
func loadYAML(path string) ([]*cluster, error) {
	raw, err := os.ReadFile(path) // #nosec G304 -- the operator's own config file, named by them
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %v", path, err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	var doc yamlFile
	if err := dec.Decode(&doc); err != nil {
		// The yaml library's message can run over several lines; it is shown on one.
		return nil, fmt.Errorf("%s: %v", path, strings.Join(strings.Fields(strings.TrimPrefix(err.Error(), "yaml: ")), " "))
	}
	lines := clusterLines(raw)
	base := filepath.Dir(path)

	var out []*cluster
	for i, y := range doc.Clusters {
		where := path
		if i < len(lines) {
			where = fmt.Sprintf("%s:%d", path, lines[i])
		}
		c := newCluster(where)
		c.Name = y.Name
		if err := y.apply(c, base, where); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: no clusters — see kafka-agent --help for the format", path)
	}
	return out, nil
}

// applyTLS writes a yaml tls block as the Java property keys the rest of the agent works
// in, into whichever cluster-shaped holder it is given: the cluster itself for its own
// connection, or the registry's holder for the registry's. The same code reads both, which
// is what makes "the same store kinds as the cluster" true rather than a promise. `owner`
// is how the settings are named in an error: "security" for the cluster's own block,
// "schemaRegistry" for a registry's.
func applyTLS(into *cluster, t *yamlTLS, owner, base, where string) error {
	if t == nil {
		return nil
	}
	set := func(key, value string) error {
		if value == "" {
			return nil
		}
		return applyProperty(into, key, value, base, where)
	}
	for prefix, st := range map[string]*yamlStore{"ssl.truststore": t.Truststore, "ssl.keystore": t.Keystore} {
		if st == nil {
			continue
		}
		for _, kv := range [][2]string{{".location", st.Location}, {".password", st.Password}, {".type", st.Type}} {
			if err := set(prefix+kv[0], kv[1]); err != nil {
				return err
			}
		}
		if prefix == "ssl.keystore" {
			if err := set("ssl.key.password", st.KeyPassword); err != nil {
				return err
			}
		}
	}
	if t.CA != "" {
		if t.Truststore != nil {
			return &configError{where: where, key: owner + ".tls.ca", msg: "both ca and truststore — pick one"}
		}
		if err := set("ssl.truststore.location", t.CA); err != nil {
			return err
		}
		into.Truststore.Type = "PEM"
	}
	for _, f := range []struct {
		key, value string
		dst        *string
	}{{owner + ".tls.cert", t.Cert, &into.CertFile}, {owner + ".tls.key", t.Key, &into.KeyFile}} {
		if f.value == "" {
			continue
		}
		v, err := expand(f.value, base, into.noteSecret)
		if err != nil {
			return &configError{where: where, key: f.key, msg: err.Error()}
		}
		*f.dst = resolvePath(base, v)
		if f.dst == &into.KeyFile {
			into.noteSecret(into.KeyFile)
		}
	}
	if err := set("ssl.key.password", t.KeyPassword); err != nil {
		return err
	}
	if t.VerifyHostname != nil && !*t.VerifyHostname {
		into.VerifyHostname = false
	}
	return nil
}

func (y *yamlCluster) apply(c *cluster, base, where string) error {
	set := func(key, value string) error {
		if value == "" {
			return nil
		}
		return applyProperty(c, key, value, base, where)
	}

	if y.Properties.path != "" {
		p, err := expand(y.Properties.path, base, c.noteSecret)
		if err != nil {
			return &configError{where: where, key: "properties", msg: err.Error()}
		}
		if err := applyPropertiesFile(c, resolvePath(base, p)); err != nil {
			return err
		}
	}
	for _, p := range y.Properties.inline {
		// where is "<file>:<line of the cluster>"; a property has a line of its own.
		file := where
		if i := strings.LastIndex(where, ":"); i > 0 {
			file = where[:i]
		}
		if err := applyProperty(c, p.key, p.value, base, fmt.Sprintf("%s:%d", file, p.line)); err != nil {
			return err
		}
	}
	if len(y.Bootstrap) > 0 {
		if err := set("bootstrap.servers", strings.Join(y.Bootstrap, ",")); err != nil {
			return err
		}
	}
	if y.ReadOnly != nil {
		c.ReadOnly = *y.ReadOnly
		c.readOnlySet = true
	}
	if r := y.SchemaRegistry; r != nil {
		// The URL and the login go through the same ${…} expansion as every other value,
		// so a password can come from the environment or a file — and is never written
		// down in the configuration.
		reg := &registryConfig{tls: newCluster(where)}
		for _, f := range []struct {
			key, value string
			dst        *string
		}{
			{"schemaRegistry.url", r.URL, &reg.URL},
			{"schemaRegistry.username", r.Username, &reg.Username},
			{"schemaRegistry.password", r.Password, &reg.Password},
		} {
			if f.value == "" {
				continue
			}
			v, err := expand(f.value, base, reg.tls.noteSecret)
			if err != nil {
				return &configError{where: where, key: f.key, msg: err.Error()}
			}
			*f.dst = v
		}
		if err := applyTLS(reg.tls, r.TLS, "schemaRegistry", base, where); err != nil {
			return err
		}
		c.Registry = reg
	}
	s := y.Security
	if s == nil {
		return nil
	}
	if err := set("security.protocol", s.Protocol); err != nil {
		return err
	}
	if err := applyTLS(c, s.TLS, "security", base, where); err != nil {
		return err
	}
	if a := s.SASL; a != nil {
		if err := set("sasl.mechanism", a.Mechanism); err != nil {
			return err
		}
		for _, f := range []struct {
			key, value string
			dst        *string
		}{{"security.sasl.username", a.Username, &c.Username}, {"security.sasl.password", a.Password, &c.Password}} {
			if f.value == "" {
				continue
			}
			v, err := expand(f.value, base, c.noteSecret)
			if err != nil {
				return &configError{where: where, key: f.key, msg: err.Error()}
			}
			*f.dst = v
		}
	}
	return nil
}

// clusterLines finds the line each entry of `clusters:` starts on.
func clusterLines(raw []byte) []int {
	var root yaml.Node
	if yaml.Unmarshal(raw, &root) != nil || len(root.Content) == 0 {
		return nil
	}
	top := root.Content[0]
	for i := 0; i+1 < len(top.Content); i += 2 {
		if top.Content[i].Value == "clusters" {
			var out []int
			for _, item := range top.Content[i+1].Content {
				out = append(out, item.Line)
			}
			return out
		}
	}
	return nil
}

// ── putting it together ───────────────────────────────────────────────────

// clusterFlags is what the command line says about clusters.
type clusterFlags struct {
	config     string
	bootstrap  string
	properties string
	name       string
	x          []string // -X key=value, in order
	// --allow-write: every cluster whose configuration does not say readOnly is
	// writable. Here, and not in main, so that config.reload reads the file the
	// same way the start did.
	allowWrite bool
}

func (f clusterFlags) definesCluster() bool {
	return f.bootstrap != "" || f.properties != "" || len(f.x) > 0
}

// defaultConfigPaths are tried, in order, when neither --config nor a cluster
// on the command line was given.
func defaultConfigPaths() []string {
	paths := []string{"kafka-agent.yaml"}
	if dir, err := os.UserConfigDir(); err == nil {
		paths = append(paths, filepath.Join(dir, "enc-tool", "kafka-agent.yaml"))
	}
	return paths
}

// loadClusters resolves every cluster the agent will serve and checks them.
// It returns the config file it read, if any, for the banner.
func loadClusters(f clusterFlags) ([]*cluster, string, error) {
	var clusters []*cluster
	file := f.config
	if file == "" && !f.definesCluster() {
		for _, p := range defaultConfigPaths() {
			if _, err := os.Stat(p); err == nil {
				file = p
				break
			}
		}
		if file == "" {
			return nil, "", fmt.Errorf("no clusters: pass --config <file>, or --bootstrap / --properties, or create one of %s",
				strings.Join(defaultConfigPaths(), ", "))
		}
	}
	if file != "" {
		abs, err := filepath.Abs(expandHome(file))
		if err != nil {
			return nil, "", err
		}
		file = abs
		if clusters, err = loadYAML(file); err != nil {
			return nil, "", err
		}
		// The file may hold passwords itself.
		for _, c := range clusters {
			c.noteSecret(file)
		}
	}

	if f.definesCluster() {
		cwd, _ := os.Getwd()
		c := newCluster("command line")
		c.Name = f.name
		if f.properties != "" {
			if err := applyPropertiesFile(c, resolvePath(cwd, f.properties)); err != nil {
				return nil, "", err
			}
		}
		for _, kv := range f.x {
			key, value, ok := strings.Cut(kv, "=")
			if !ok {
				return nil, "", &configError{where: "command line", key: "-X", msg: fmt.Sprintf("%q is not key=value", kv)}
			}
			if err := applyProperty(c, strings.TrimSpace(key), value, cwd, "-X"); err != nil {
				return nil, "", err
			}
		}
		if f.bootstrap != "" {
			if err := applyProperty(c, "bootstrap.servers", f.bootstrap, cwd, "--bootstrap"); err != nil {
				return nil, "", err
			}
		}
		if c.Name == "" && len(c.Bootstrap) > 0 {
			// The first broker's host is what anyone would call it when
			// nothing else was said.
			host, _, _ := net.SplitHostPort(c.Bootstrap[0])
			c.Name = strings.Trim(regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(host, "-"), "-.")
		}
		clusters = append(clusters, c)
	}

	seen := map[string]string{}
	for _, c := range clusters {
		if err := c.validate(); err != nil {
			return nil, "", err
		}
		if prev, dup := seen[c.Name]; dup {
			return nil, "", fmt.Errorf("cluster %q is defined twice: %s and %s", c.Name, prev, c.source)
		}
		seen[c.Name] = c.source
		if f.allowWrite && !c.readOnlySet {
			c.ReadOnly = false
			c.writableByFlag = true
		}
		c.Warnings = append(c.Warnings, checkPermissions(c.secretFiles)...)
	}
	return clusters, file, nil
}

// warningsOf is what was noted while reading the clusters, each said once: the
// config file's permissions, for one, are noted by every cluster defined in it.
func warningsOf(list []*cluster) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, c := range list {
		for _, w := range c.Warnings {
			if !seen[w] {
				seen[w] = true
				out = append(out, w)
			}
		}
	}
	return out
}

// describe is the banner line for a cluster: enough to recognise it, no secrets.
func (c *cluster) describe() string {
	parts := []string{strings.Join(c.Bootstrap, ", "), c.Protocol}
	if c.Mechanism != "" {
		parts[1] += " " + c.Mechanism
	}
	if c.Protocol == "SSL" || c.Protocol == "SASL_SSL" {
		trust := "system CAs"
		switch {
		case c.Truststore.Location != "":
			trust = "truststore " + fileKind(c.Truststore.Location)
		case c.TrustPEM != "":
			trust = "inline CA"
		}
		parts = append(parts, trust)
		switch {
		case c.Keystore.Location != "":
			parts = append(parts, "keystore "+fileKind(c.Keystore.Location))
		case c.CertFile != "" || c.CertPEM != "":
			parts = append(parts, "client certificate")
		}
		if !c.VerifyHostname {
			parts = append(parts, "NO hostname check")
		}
	}
	// The registry beside the cluster: a mistake in its address is otherwise seen only in the
	// page. The host and the port only — validateRegistry has refused a URL that carries a login.
	if c.Registry != nil {
		if u, err := url.Parse(c.Registry.URL); err == nil && u.Host != "" {
			parts = append(parts, "schema registry "+u.Host)
		}
	}
	switch {
	case c.ReadOnly:
		parts = append(parts, "read-only")
	case c.writableByFlag:
		parts = append(parts, "WRITABLE (--allow-write)")
	default:
		parts = append(parts, "WRITABLE")
	}
	return strings.Join(parts, " · ")
}

// fileKind names a store's format for the banner: what the file is, which is
// what the agent will read it as, whatever the config declared.
func fileKind(path string) string {
	f, err := os.Open(path) // #nosec G304 -- a store the operator named in their own config
	if err != nil {
		return "?"
	}
	defer f.Close()
	head := make([]byte, 4096)
	n, _ := f.Read(head)
	kind, err := storeKind(head[:n])
	if err != nil {
		return "?"
	}
	return kind
}
