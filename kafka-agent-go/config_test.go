package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"enc-tool/kafka-agent/internal/testpki"
)

func TestPropertiesFormat(t *testing.T) {
	text := "# comment\n" +
		"! also a comment\n" +
		"   \n" +
		"security.protocol=SASL_SSL\n" +
		"ssl.truststore.location : /etc/kafka/ts.jks\n" +
		"ssl.truststore.password  changeit\n" +
		"sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \\\n" +
		"    username=\"app\" \\\n" +
		"    password=\"p\\\\w\";\n" +
		"key\\ with\\ spaces=v\n" +
		"unicode=\\u0041\\u00e9\n" +
		"trailing=ends in a backslash\\\\\n" +
		"empty=\n"
	props, err := parseProperties(text)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	lines := map[string]int{}
	for _, p := range props {
		got[p.key] = p.value
		lines[p.key] = p.line
	}
	want := map[string]string{
		"security.protocol":       "SASL_SSL",
		"ssl.truststore.location": "/etc/kafka/ts.jks",
		"ssl.truststore.password": "changeit",
		"sasl.jaas.config":        `org.apache.kafka.common.security.scram.ScramLoginModule required username="app" password="p\w";`,
		"key with spaces":         "v",
		"unicode":                 "Aé",
		"trailing":                `ends in a backslash\`,
		"empty":                   "",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed\n%#v\nwant\n%#v", got, want)
	}
	if lines["sasl.jaas.config"] != 7 {
		t.Errorf("a continued value is reported at the line it starts on: got %d, want 7", lines["sasl.jaas.config"])
	}
}

func TestJAAS(t *testing.T) {
	e, err := parseJAAS(`org.apache.kafka.common.security.scram.ScramLoginModule required username="app" password="a=b;c\"d";`)
	if err != nil {
		t.Fatal(err)
	}
	if e.options["username"] != "app" || e.options["password"] != `a=b;c"d` {
		t.Fatalf("options %v — a quoted = or ; is part of the value", e.options)
	}
	for _, bad := range []string{
		`ScramLoginModule required username="app"`,  // no ;
		`ScramLoginModule maybe username="app";`,    // flag
		`ScramLoginModule required username "app";`, // no =
		`ScramLoginModule required username="app; `, // unterminated
		`A required u="1"; B required u="2";`,       // two modules
	} {
		if _, err := parseJAAS(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

// write creates files under dir and returns dir.
func write(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestYAMLWithPropertiesFileAndRelativePaths(t *testing.T) {
	t.Setenv("TEST_TS_PASS", testpki.StorePassword)
	dir := write(t, map[string]string{
		"kafka-agent.yaml": `clusters:
  - name: prod
    bootstrap: [k1:9093, k2:9093]
    properties: conf/prod.properties
  - name: dev
    bootstrap: localhost:9094
    readOnly: false
    security:
      protocol: SASL_SSL
      tls:
        ca: certs/ca.pem
        verifyHostname: false
      sasl: { mechanism: scram-sha-256, username: dev, password: "${file:secret.txt}" }
`,
		"conf/prod.properties": "bootstrap.servers=ignored:1\n" +
			"security.protocol=SSL\n" +
			"ssl.truststore.location=truststore.jks\n" +
			"ssl.truststore.password=${TEST_TS_PASS}\n" +
			"ssl.keystore.location=../client.p12\n" +
			"ssl.keystore.type=pkcs12\n" +
			"ssl.keystore.password=" + testpki.StorePassword + "\n" +
			"acks=all\n",
		"secret.txt": "s3cret\n",
	})
	// Real stores: validation opens them, so a placeholder would fail — as it should.
	// WriteFiles also writes a kafka-agent.yaml; the test's own goes back afterwards.
	yamlPath := filepath.Join(dir, "kafka-agent.yaml")
	testYAML, err := os.ReadFile(yamlPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, sub := range []string{"conf", ".", "certs"} {
		pki, err := testpki.New()
		if err != nil {
			t.Fatal(err)
		}
		if err := pki.WriteFiles(filepath.Join(dir, sub)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(yamlPath, testYAML, 0o600); err != nil {
		t.Fatal(err)
	}
	clusters, file, err := loadClusters(clusterFlags{config: yamlPath})
	if err != nil {
		t.Fatal(err)
	}
	if file != filepath.Join(dir, "kafka-agent.yaml") || len(clusters) != 2 {
		t.Fatalf("file %s, %d clusters", file, len(clusters))
	}
	prod, dev := clusters[0], clusters[1]

	if !reflect.DeepEqual(prod.Bootstrap, []string{"k1:9093", "k2:9093"}) {
		t.Errorf("yaml bootstrap must win over the properties file: %v", prod.Bootstrap)
	}
	if prod.Protocol != "SSL" || !prod.ReadOnly {
		t.Errorf("prod: protocol %s readOnly %v", prod.Protocol, prod.ReadOnly)
	}
	if prod.Truststore.Location != filepath.Join(dir, "conf", "truststore.jks") || prod.Truststore.Password != testpki.StorePassword {
		t.Errorf("a path in a properties file is relative to that file, and ${…} is expanded: %+v", prod.Truststore)
	}
	if prod.Keystore.Location != filepath.Join(dir, "client.p12") || prod.Keystore.Type != "PKCS12" {
		t.Errorf("keystore %+v", prod.Keystore)
	}
	if len(prod.Warnings) != 1 || !strings.Contains(prod.Warnings[0], "acks") {
		t.Errorf("a JVM-only property is noted, not refused: %v", prod.Warnings)
	}

	if dev.ReadOnly || dev.Protocol != "SASL_SSL" || dev.Mechanism != "SCRAM-SHA-256" {
		t.Errorf("dev: %+v", dev)
	}
	if dev.Password != "s3cret" {
		t.Errorf("${file:…} is the file's contents without the trailing newline: %q", dev.Password)
	}
	if dev.Truststore.Location != filepath.Join(dir, "certs", "ca.pem") || dev.Truststore.Type != "PEM" || dev.VerifyHostname {
		t.Errorf("dev tls: %+v verify=%v", dev.Truststore, dev.VerifyHostname)
	}
	if d := dev.describe(); strings.Contains(d, "s3cret") || !strings.Contains(d, "NO hostname check") {
		t.Errorf("describe: %q", d)
	}
}

func TestCommandLineCluster(t *testing.T) {
	dir := write(t, map[string]string{
		"client.properties": "security.protocol=SASL_PLAINTEXT\nsasl.mechanism=SCRAM-SHA-512\n" +
			`sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="u" password="from-file";` + "\n",
	})
	t.Chdir(dir)
	t.Setenv("TEST_SASL", "from-x")
	clusters, _, err := loadClusters(clusterFlags{
		bootstrap:  "broker.example.com:9092",
		properties: "client.properties",
		x:          []string{`sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="u" password="${TEST_SASL}";`},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := clusters[0]
	if c.Name != "broker.example.com" || c.Password != "from-x" || c.source != "command line" {
		t.Fatalf("-X must win over --properties, and the name defaults to the first host: %+v", c)
	}
}

func TestConfigErrorsNameThePlace(t *testing.T) {
	cases := []struct {
		name, yaml string
		want       []string
	}{
		{"misspelt key", "clusters:\n  - name: a\n    bootstrap: h:1\n    security:\n      tls:\n        trustore: {}\n", []string{"line 6", "trustore"}},
		{"plain", "clusters:\n  - name: a\n    bootstrap: h:1\n    security:\n      protocol: SASL_SSL\n      sasl: { mechanism: PLAIN }\n", []string{"kafka-agent.yaml:2", "sasl.mechanism", "not supported"}},
		{"no mechanism", "clusters:\n  - name: a\n    bootstrap: h:1\n    security: { protocol: SASL_PLAINTEXT }\n", []string{`cluster "a"`, "SCRAM"}},
		{"missing store", "clusters:\n  - name: a\n    bootstrap: h:1\n    security:\n      protocol: SSL\n      tls: { truststore: { location: nope.jks } }\n", []string{"ssl.truststore.location", "nope.jks"}},
		{"bad bootstrap", "clusters:\n  - name: a\n    bootstrap: justahost\n", []string{"host:port"}},
		{"bad name", "clusters:\n  - name: 'a b'\n    bootstrap: h:1\n", []string{"name"}},
		{"duplicate", "clusters:\n  - { name: a, bootstrap: h:1 }\n  - { name: a, bootstrap: h:2 }\n", []string{"defined twice", ":2", ":3"}},
		{"unset env", "clusters:\n  - name: a\n    bootstrap: h:1\n    security:\n      protocol: SASL_SSL\n      sasl: { mechanism: SCRAM-SHA-256, username: u, password: '${NO_SUCH_VAR_HERE}' }\n", []string{"NO_SUCH_VAR_HERE", "not set"}},
	}
	for _, c := range cases {
		dir := write(t, map[string]string{"kafka-agent.yaml": c.yaml})
		_, _, err := loadClusters(clusterFlags{config: filepath.Join(dir, "kafka-agent.yaml")})
		if err == nil {
			t.Errorf("%s: accepted", c.name)
			continue
		}
		for _, w := range c.want {
			if !strings.Contains(err.Error(), w) {
				t.Errorf("%s: %q does not mention %q", c.name, err, w)
			}
		}
	}
}

func TestExpandEscapes(t *testing.T) {
	t.Setenv("TEST_X", "x")
	got, err := expand("a${TEST_X}b${env:TEST_X}c$${TEST_X}", ".")
	if err != nil || got != "axbxc${TEST_X}" {
		t.Fatalf("expand = %q, %v", got, err)
	}
}
