package main

import (
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/twmb/franz-go/pkg/sr"
	"github.com/twmb/franz-go/pkg/sr/srfake"

	"enc-tool/kafka-agent/internal/testpki"
)

// ── the configuration block ───────────────────────────────────────────────

// A cluster may name a Schema Registry of its own: a URL, a login, and stores that are not
// the cluster's. The password comes from the environment like every other secret.
func TestASchemaRegistryIsReadAndKeptApartFromTheCluster(t *testing.T) {
	t.Setenv("REG_PASS", "s3cret")
	_, pkiDir, _ := stand(t)
	yaml := `clusters:
  - name: prod
    bootstrap: k1:9092
    security:
      protocol: SSL
      tls:
        truststore:
          location: ` + filepath.Join(pkiDir, "truststore.p12") + `
          password: ` + testpki.StorePassword + `
    schemaRegistry:
      url: https://registry.example.com:8081
      username: app
      password: ${REG_PASS}
      tls:
        verifyHostname: false
        truststore:
          location: ` + filepath.Join(pkiDir, "ca.pem") + `
`
	dir := write(t, map[string]string{"kafka-agent.yaml": yaml})
	list, _, err := loadClusters(clusterFlags{config: filepath.Join(dir, "kafka-agent.yaml")})
	if err != nil {
		t.Fatal(err)
	}
	c := list[0]
	if c.Registry == nil {
		t.Fatal("the registry block was not read")
	}
	if c.Registry.URL != "https://registry.example.com:8081" {
		t.Errorf("url: %q", c.Registry.URL)
	}
	if c.Registry.Username != "app" || c.Registry.Password != "s3cret" {
		t.Errorf("login: %q / %q, want app / s3cret from ${REG_PASS}", c.Registry.Username, c.Registry.Password)
	}
	// The registry's stores are its own: the cluster keeps the ones it was given.
	if !strings.HasSuffix(c.Truststore.Location, "truststore.p12") {
		t.Errorf("the cluster's truststore: %q", c.Truststore.Location)
	}
	if !strings.HasSuffix(c.Registry.tls.Truststore.Location, "ca.pem") {
		t.Errorf("the registry's truststore: %q", c.Registry.tls.Truststore.Location)
	}
	// The registry's stores were opened, or loadClusters would have refused them: that is
	// the check, not the declared type (which stays empty and is read from the content).
	if c.Registry.tls.VerifyHostname {
		t.Error("verifyHostname: false was not read for the registry")
	}
	if !c.VerifyHostname {
		t.Error("the registry's verifyHostname changed the cluster's own")
	}
	// A cluster without a registry has none, and that is not an error.
	list, _, err = loadClusters(clusterFlags{bootstrap: "k1:9092"})
	if err != nil {
		t.Fatal(err)
	}
	if list[0].Registry != nil {
		t.Error("a cluster from the command line has a registry")
	}
}

func TestASchemaRegistryIsRefusedWhenItCannotWork(t *testing.T) {
	_, pkiDir, _ := stand(t)
	for _, c := range []struct {
		what     string
		block    string
		mentions []string
	}{
		{
			"a URL without a scheme",
			"    schemaRegistry:\n      url: registry.example.com:8081\n",
			[]string{"schemaRegistry.url", "not a URL"},
		},
		{
			"a URL with the login inside it",
			"    schemaRegistry:\n      url: https://app:pw@registry.example.com:8081\n",
			[]string{"schemaRegistry.url", "login in it"},
		},
		{
			"a username with no password",
			"    schemaRegistry:\n      url: https://registry.example.com:8081\n      username: app\n",
			[]string{"schemaRegistry", "username and a password"},
		},
		{
			"a password with no username",
			"    schemaRegistry:\n      url: https://registry.example.com:8081\n      password: pw\n",
			[]string{"schemaRegistry", "username and a password"},
		},
		{
			"a truststore that is not there",
			"    schemaRegistry:\n      url: https://registry.example.com:8081\n      tls:\n        truststore:\n          location: /no/such/store.p12\n",
			[]string{"schemaRegistry.tls.truststore.location", "store.p12"},
		},
		{
			"a store with the wrong password",
			"    schemaRegistry:\n      url: https://registry.example.com:8081\n      tls:\n        truststore:\n          location: " + filepath.Join(pkiDir, "truststore.p12") + "\n          password: not-the-password\n",
			[]string{"schemaRegistry.tls"},
		},
		{
			"an unset environment variable in the password",
			"    schemaRegistry:\n      url: https://registry.example.com:8081\n      username: app\n      password: ${NO_SUCH_VARIABLE_ANYWHERE}\n",
			[]string{"schemaRegistry.password", "NO_SUCH_VARIABLE_ANYWHERE"},
		},
		{
			"a key nobody knows",
			"    schemaRegistry:\n      url: https://registry.example.com:8081\n      ur: x\n",
			[]string{"ur"},
		},
	} {
		body := "clusters:\n  - name: prod\n    bootstrap: k1:9092\n" + c.block
		dir := write(t, map[string]string{"kafka-agent.yaml": body})
		_, _, err := loadClusters(clusterFlags{config: filepath.Join(dir, "kafka-agent.yaml")})
		if err == nil {
			t.Errorf("%s: accepted", c.what)
			continue
		}
		for _, want := range c.mentions {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("%s: %q does not mention %q", c.what, err, want)
			}
		}
	}
	// TLS settings under an http URL are ignored, and said to be.
	dir := write(t, map[string]string{"kafka-agent.yaml": "clusters:\n  - name: prod\n    bootstrap: k1:9092\n" +
		"    schemaRegistry:\n      url: http://registry.example.com:8081\n      tls:\n        truststore:\n          location: " + filepath.Join(pkiDir, "truststore.p12") + "\n"})
	list, _, err := loadClusters(clusterFlags{config: filepath.Join(dir, "kafka-agent.yaml")})
	if err != nil {
		t.Fatalf("http with TLS settings should load, with a warning: %v", err)
	}
	if len(list[0].Warnings) == 0 || !strings.Contains(strings.Join(list[0].Warnings, " "), "ignored") {
		t.Errorf("no warning about ignored TLS settings: %v", list[0].Warnings)
	}
}

// ── schemas.status ────────────────────────────────────────────────────────

// withRegistry points the rig's cluster at a registry, as the configuration would.
func (r *rig) withRegistry(url, username, password string, tlsCluster *cluster) {
	r.t.Helper()
	cl, err := r.s.cluster("dev")
	if err != nil {
		r.t.Fatal(err)
	}
	cp := *cl
	reg := &registryConfig{URL: url, Username: username, Password: password, tls: tlsCluster}
	if reg.tls == nil {
		reg.tls = newCluster("test")
	}
	cp.Registry = reg
	r.s.setClusters([]*cluster{&cp})
}

func TestSchemaStatusOfAClusterWithoutARegistry(t *testing.T) {
	r := newRig(t)
	d := r.data("schemas.status", nil)
	if d["name"] != "dev" || d["state"] != schemaNotConfigured {
		t.Fatalf("a cluster without a registry: %v", d)
	}
}

func TestSchemaStatusReadsWhatTheRegistryIs(t *testing.T) {
	reg := srfake.New(srfake.WithGlobalCompat(sr.CompatFull))
	t.Cleanup(reg.Close)
	if _, _, err := reg.RegisterSchema("orders-value", sr.Schema{Schema: `"string"`}); err != nil {
		t.Fatal(err)
	}

	r := newRig(t)
	r.withRegistry(reg.URL(), "", "", nil)
	d := r.data("schemas.status", nil)
	if d["state"] != schemaConnected {
		t.Fatalf("state: %v", d)
	}
	if d["mode"] != "READWRITE" {
		t.Errorf("mode: %v", d["mode"])
	}
	if d["compatibility"] != "FULL" {
		t.Errorf("compatibility: %v", d["compatibility"])
	}
	if d["subjects"].(float64) != 1 {
		t.Errorf("subjects: %v", d["subjects"])
	}
}

func TestSchemaStatusSaysWhyTheRegistryWouldNotAnswer(t *testing.T) {
	// A registry that wants a login, and one that does not know the URL.
	auth := srfake.New(srfake.WithAuth("Basic " + base64.StdEncoding.EncodeToString([]byte("app:right"))))
	t.Cleanup(auth.Close)
	notRegistry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { http.NotFound(w, nil) }))
	t.Cleanup(notRegistry.Close)

	for _, c := range []struct {
		what     string
		url      string
		user     string
		password string
		state    string
		mentions []string
	}{
		{"no login at all", auth.URL(), "", "", schemaAuthFailed, []string{"refused the login", "schemaRegistry.username"}},
		{"the wrong password", auth.URL(), "app", "wrong", schemaAuthFailed, []string{"refused the login"}},
		{"something else on that port", notRegistry.URL, "", "", schemaError, []string{"404", "Schema Registry"}},
		{"nothing on that port", "http://127.0.0.1:1", "", "", schemaUnreachable, []string{"cannot reach the registry"}},
	} {
		r := newRig(t)
		r.withRegistry(c.url, c.user, c.password, nil)
		d := r.data("schemas.status", nil)
		if d["state"] != c.state {
			t.Errorf("%s: state %v (%v), want %s", c.what, d["state"], d["message"], c.state)
			continue
		}
		msg, _ := d["message"].(string)
		for _, want := range c.mentions {
			if !strings.Contains(msg, want) {
				t.Errorf("%s: %q does not mention %q", c.what, msg, want)
			}
		}
	}
}

// A registry behind TLS: the truststore is what decides, and the words say which setting
// to look at when it is the wrong one.
func TestSchemaStatusOverTLS(t *testing.T) {
	reg := srfake.New()
	t.Cleanup(reg.Close)
	srv := httptest.NewTLSServer(reg.Handler())
	t.Cleanup(srv.Close)

	// The server's own certificate as the truststore: an unknown CA must be refused.
	other, err := testpki.New()
	if err != nil {
		t.Fatal(err)
	}
	dir := write(t, map[string]string{
		"registry.pem": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})),
		"other.pem":    string(other.CAPEM()),
	})

	trusting := newCluster("test")
	trusting.Truststore = store{Location: filepath.Join(dir, "registry.pem")}
	trusting.VerifyHostname = false // the test certificate is for 127.0.0.1 and example.com

	r := newRig(t)
	r.withRegistry(srv.URL, "", "", trusting)
	if d := r.data("schemas.status", nil); d["state"] != schemaConnected {
		t.Fatalf("a trusted certificate: %v", d)
	}

	stranger := newCluster("test")
	stranger.Truststore = store{Location: filepath.Join(dir, "other.pem")}
	stranger.VerifyHostname = false
	r2 := newRig(t)
	r2.withRegistry(srv.URL, "", "", stranger)
	d := r2.data("schemas.status", nil)
	if d["state"] != schemaTLSFailed {
		t.Fatalf("a certificate from another CA: %v", d)
	}
	if msg, _ := d["message"].(string); !strings.Contains(msg, "schemaRegistry.tls.truststore.location") {
		t.Errorf("the refusal should name the setting: %q", msg)
	}
}

// The registry's failures are named by the setting to change, including the ones that are
// hard to produce over a wire: a certificate for another name, an expired one, a port that
// is not TLS at all.
func TestRegistryProblemNamesTheSetting(t *testing.T) {
	for _, c := range []struct {
		what     string
		err      error
		state    string
		mentions []string
	}{
		{
			"a certificate for another name",
			x509.HostnameError{Certificate: &x509.Certificate{Subject: pkix.Name{CommonName: "registry.example.com"}}, Host: "127.0.0.1"},
			schemaTLSFailed,
			[]string{"registry.example.com", "127.0.0.1", "verifyHostname"},
		},
		{
			"an expired certificate",
			x509.CertificateInvalidError{Reason: x509.Expired},
			schemaTLSFailed,
			[]string{"expired"},
		},
		{
			"a port that is not TLS",
			tls.RecordHeaderError{Msg: "first record does not look like a TLS handshake"},
			schemaTLSFailed,
			[]string{"not speaking TLS"},
		},
		{
			"the wrong password",
			&sr.ResponseError{StatusCode: http.StatusUnauthorized, Message: "Unauthorized"},
			schemaAuthFailed,
			[]string{"refused the login", "schemaRegistry.username"},
		},
		{
			"a 500",
			&sr.ResponseError{StatusCode: http.StatusInternalServerError, ErrorCode: 50001, Message: "backend down"},
			schemaError,
			[]string{"HTTP 500", "backend down"},
		},
		{
			"a port with nothing on it",
			&net.OpError{Op: "dial", Err: errors.New("connection refused")},
			schemaUnreachable,
			[]string{"cannot reach the registry", "connection refused"},
		},
	} {
		state, msg := registryProblem(c.err)
		if state != c.state {
			t.Errorf("%s: state %q, want %q (%s)", c.what, state, c.state, msg)
			continue
		}
		for _, want := range c.mentions {
			if !strings.Contains(msg, want) {
				t.Errorf("%s: %q does not mention %q", c.what, msg, want)
			}
		}
	}
}

// The client itself is made per connection and reused; a cluster without a registry has
// none, and neither case asks the registry anything it should not.
func TestRegistryClientIsPerConnectionAndOptional(t *testing.T) {
	reg := srfake.New()
	t.Cleanup(reg.Close)
	r := newRig(t)
	if client, err := r.conn.registryClient(&cluster{Name: "dev"}); client != nil || err != nil {
		t.Fatalf("a cluster without a registry: %v %v", client, err)
	}
	r.withRegistry(reg.URL(), "", "", nil)
	cl, _ := r.s.cluster("dev")
	first, err := r.conn.registryClient(cl)
	if err != nil || first == nil {
		t.Fatalf("the client: %v %v", first, err)
	}
	again, err := r.conn.registryClient(cl)
	if err != nil || again != first {
		t.Fatal("the second call should hand back the same client")
	}
}
