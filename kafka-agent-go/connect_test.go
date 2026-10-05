package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kfake"

	"enc-tool/kafka-agent/internal/testpki"
)

// startBroker starts an in-process Kafka that speaks the real protocol — TLS, mTLS
// and SCRAM included — and returns where it listens.
func startBroker(t *testing.T, opts ...kfake.Opt) string {
	t.Helper()
	_, addr := startBrokerWith(t, opts...)
	return addr
}

// startBrokerWith is startBroker with the cluster itself in hand, for a test that has to
// make the broker answer something specific — a fault, the way a cluster without the right
// permission answers.
func startBrokerWith(t *testing.T, opts ...kfake.Opt) (*kfake.Cluster, string) {
	t.Helper()
	c, err := kfake.NewCluster(append([]kfake.Opt{kfake.NumBrokers(1), kfake.ClusterID("test-cluster")}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c, c.ListenAddrs()[0]
}

// at points a cluster from the stand at a running broker.
func at(c *cluster, addr string) *cluster {
	cp := *c
	cp.Bootstrap = []string{addr}
	return &cp
}

func statusOf(t *testing.T, c *cluster) *clusterStatus {
	t.Helper()
	conn := &connection{}
	t.Cleanup(conn.closeClients)
	s := &server{}
	st, err := s.status(context.Background(), conn, c)
	if err != nil {
		t.Fatalf("%s: %v", c.Name, err)
	}
	return st
}

func mustBe(t *testing.T, st *clusterStatus, state string, mentions ...string) {
	t.Helper()
	if st.State != state {
		t.Fatalf("%s: state %q (%s), want %q", st.Name, st.State, st.Message, state)
	}
	for _, m := range mentions {
		if !strings.Contains(st.Message, m) {
			t.Errorf("%s: %q does not mention %q", st.Name, st.Message, m)
		}
	}
}

func TestPlaintextClusterReportsWhoItIs(t *testing.T) {
	_, _, stand := stand(t)
	st := statusOf(t, at(stand["plaintext"], startBroker(t)))
	mustBe(t, st, stateConnected)
	if st.ClusterID == nil || *st.ClusterID != "test-cluster" || st.Brokers == nil || *st.Brokers != 1 || st.Controller == nil {
		t.Fatalf("status: %+v", st)
	}
	if st.Version == nil || *st.Version == "" {
		t.Fatalf("no version guess: %+v", st)
	}
	t.Logf("version guess: %s", *st.Version)
}

func TestEveryStoreFormatConnectsToAMutualTLSBroker(t *testing.T) {
	pki, _, clusters := stand(t)
	addr := startBroker(t, kfake.TLS(pki.ServerTLS(tls.RequireAndVerifyClientCert)))
	for _, name := range []string{"ssl-p12", "ssl-jks", "ssl-pem"} {
		mustBe(t, statusOf(t, at(clusters[name], addr)), stateConnected)
	}
}

func TestATLSBrokerThatWantsACertificateSaysWhy(t *testing.T) {
	pki, _, clusters := stand(t)
	addr := startBroker(t, kfake.TLS(pki.ServerTLS(tls.RequireAndVerifyClientCert)))

	// A truststore but no client certificate.
	c := at(clusters["ssl-p12"], addr)
	c.Keystore = store{}
	mustBe(t, statusOf(t, c), stateTLSFailed, "client certificate")

	// A CA the broker was not signed by.
	other, _ := testpki.New()
	c = at(clusters["ssl-p12"], addr)
	c.Truststore = store{}
	c.TrustPEM = string(other.CAPEM())
	mustBe(t, statusOf(t, c), stateTLSFailed, "not signed by a CA", "ssl.truststore.location")

	// The name check, and switching it off.
	c = at(clusters["ssl-p12"], strings.Replace(addr, "127.0.0.1", "localhost", 1))
	mustBe(t, statusOf(t, c), stateConnected) // localhost is on the certificate too
}

func TestSCRAMOverPlaintextAndOverTLS(t *testing.T) {
	pki, _, clusters := stand(t)

	plain := startBroker(t, kfake.EnableSASL(), kfake.Superuser("SCRAM-SHA-512", "app", "app-secret"))
	mustBe(t, statusOf(t, at(clusters["sasl-plaintext"], plain)), stateConnected)

	c := at(clusters["sasl-plaintext"], plain)
	c.Password = "not-the-password"
	mustBe(t, statusOf(t, c), stateAuthFailed, `"app"`, "SCRAM-SHA-512", "sasl.jaas.config")

	c = at(clusters["sasl-plaintext"], plain)
	c.Mechanism = "SCRAM-SHA-256" // the broker has this user on SHA-512 only
	mustBe(t, statusOf(t, c), stateAuthFailed)

	// SASL_SSL: the truststore, and SCRAM-SHA-256 as the stand's config says.
	secure := startBroker(t, kfake.TLS(pki.ServerTLS(tls.NoClientCert)), kfake.EnableSASL(),
		kfake.Superuser("SCRAM-SHA-256", "app", "app-secret"))
	mustBe(t, statusOf(t, at(clusters["sasl-ssl"], secure)), stateConnected)

	c = at(clusters["sasl-ssl"], secure)
	c.Password = "wrong"
	mustBe(t, statusOf(t, c), stateAuthFailed)
}

func TestMismatchedProtocolsAreNamed(t *testing.T) {
	pki, _, clusters := stand(t)
	plain := startBroker(t)
	secure := startBroker(t, kfake.TLS(pki.ServerTLS(tls.NoClientCert)))
	sasl := startBroker(t, kfake.EnableSASL(), kfake.Superuser("SCRAM-SHA-512", "app", "app-secret"))

	// A real plaintext broker hangs up on a ClientHello (classify turns that into
	// tls_failed); this fake never answers, so all the client can say is that
	// nothing did — with a hint that names TLS.
	statusTimeout = 3 * time.Second
	t.Cleanup(func() { statusTimeout = 12 * time.Second })
	if st := statusOf(t, at(clusters["ssl-p12"], plain)); st.State == stateConnected || !strings.Contains(st.Message, "TLS") {
		t.Fatalf("TLS towards a plaintext listener: %+v", st)
	}
	// Plaintext towards a TLS listener.
	if st := statusOf(t, at(clusters["plaintext"], secure)); st.State == stateConnected {
		t.Fatalf("a plaintext client reached a TLS listener: %+v", st)
	} else {
		t.Logf("plaintext → TLS: %s — %s", st.State, st.Message)
	}
	// Plaintext, no SASL, towards a broker that requires SASL.
	if st := statusOf(t, at(clusters["plaintext"], sasl)); st.State == stateConnected {
		t.Fatalf("a client without SASL reached a broker that requires it: %+v", st)
	} else {
		t.Logf("no SASL → SASL: %s — %s", st.State, st.Message)
	}
	// SASL towards a broker without it.
	if st := statusOf(t, at(clusters["sasl-plaintext"], plain)); st.State == stateConnected {
		t.Fatalf("SASL against a broker without SASL connected: %+v", st)
	} else {
		t.Logf("SASL → no SASL: %s — %s", st.State, st.Message)
	}
}

func TestAClosedPortIsUnreachableAndQuickly(t *testing.T) {
	_, _, clusters := stand(t)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()

	started := time.Now()
	st := statusOf(t, at(clusters["plaintext"], addr))
	mustBe(t, st, stateUnreachable, addr)
	if took := time.Since(started); took > 6*time.Second {
		t.Errorf("a refused connection took %s to report", took)
	}
}

func TestAnAddressNothingAnswersIsUnreachableWithinTheBound(t *testing.T) {
	// A listener that accepts and never speaks: what a filtered port looks like
	// once the SYN gets through.
	_, _, clusters := stand(t)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
		}
	}()
	statusTimeout = 3 * time.Second
	t.Cleanup(func() { statusTimeout = 12 * time.Second })
	started := time.Now()
	st := statusOf(t, at(clusters["plaintext"], l.Addr().String()))
	if st.State == stateConnected {
		t.Fatalf("connected to a silent listener: %+v", st)
	}
	if took := time.Since(started); took > statusTimeout+2*time.Second {
		t.Errorf("a silent listener held the status check for %s, bound is %s", took, statusTimeout)
	}
	t.Logf("silent listener: %s — %s (%s)", st.State, st.Message, time.Since(started).Round(time.Millisecond))
}

func TestClustersOverTheWire(t *testing.T) {
	_, _, list := stand(t)
	s, conn, fr := testConn(t)
	s.setClusters([]*cluster{
		at(list["plaintext"], startBroker(t)),
		at(list["sasl-plaintext"], startBroker(t, kfake.EnableSASL(), kfake.Superuser("SCRAM-SHA-512", "app", "app-secret"))),
	})

	s.dispatch(conn, request(1, "clusters.list", nil))
	got := replyFor(t, fr, 1)
	raw, _ := json.Marshal(got["data"])
	for _, secret := range []string{"app-secret", "127.0.0.1", "localhost", "password", "bootstrap"} {
		if strings.Contains(string(raw), secret) {
			t.Errorf("clusters.list gave the page %q: %s", secret, raw)
		}
	}
	entries, _ := got["data"].([]any)
	if len(entries) != 2 || !strings.Contains(string(raw), `"mechanism":"SCRAM-SHA-512"`) || !strings.Contains(string(raw), `"readOnly":true`) {
		t.Fatalf("clusters.list: %s", raw)
	}

	s.dispatch(conn, request(2, "clusters.status", map[string]any{"cluster": "sasl-plaintext"}))
	st := replyFor(t, fr, 2)
	data, _ := st["data"].(map[string]any)
	if data["state"] != "connected" || data["clusterId"] != "test-cluster" {
		t.Fatalf("clusters.status: %v", st)
	}

	// A name that is not configured is refused, and an address is not a name.
	for i, name := range []string{"nope", "127.0.0.1:9092", ""} {
		id := int64(10 + i)
		s.dispatch(conn, request(id, "clusters.status", map[string]any{"cluster": name}))
		if got := replyFor(t, fr, id); got["code"] != "ENOCLUSTER" {
			t.Errorf("clusters.status %q: %v, want ENOCLUSTER", name, got)
		}
	}
	conn.closeClients()
}

func TestAPageThatLeavesClosesItsClients(t *testing.T) {
	_, _, clusters := stand(t)
	conn := &connection{}
	s := &server{}
	c := at(clusters["plaintext"], startBroker(t))
	if _, err := s.status(context.Background(), conn, c); err != nil {
		t.Fatal(err)
	}
	if len(conn.clients) != 1 {
		t.Fatalf("%d clients after one status, want 1 (made on first use, reused after)", len(conn.clients))
	}
	if _, err := s.status(context.Background(), conn, c); err != nil || len(conn.clients) != 1 {
		t.Fatalf("a second status made another client: %d, %v", len(conn.clients), err)
	}
	conn.closeClients()
	if len(conn.clients) != 0 {
		t.Fatalf("%d clients left after the connection closed", len(conn.clients))
	}
}

func TestClassifyWhatTheLibraryReports(t *testing.T) {
	sasl := &cluster{Name: "c", Protocol: "SASL_PLAINTEXT", Mechanism: "SCRAM-SHA-512", Username: "app", Bootstrap: []string{"h:1"}}
	tlsC := &cluster{Name: "c", Protocol: "SSL", Bootstrap: []string{"h:1"}}
	plain := &cluster{Name: "c", Protocol: "PLAINTEXT", Bootstrap: []string{"h:1"}}

	refused := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connect: connection refused")}
	cases := []struct {
		name  string
		c     *cluster
		err   error
		state string
		has   string
	}{
		// What a real broker sends for a wrong password.
		{"wrong password", sasl, fmt.Errorf("broker: %w", kerr.SaslAuthenticationFailed), stateAuthFailed, `"app"`},
		{"mechanism not enabled", sasl, kerr.UnsupportedSaslMechanism, stateAuthFailed, "does not offer SCRAM-SHA-512"},
		// What some brokers do instead: hang up.
		{"hangs up during login", sasl, io.EOF, stateAuthFailed, "during the login"},
		{"hangs up, no SASL", plain, io.EOF, stateUnreachable, "cannot connect"},
		{"untrusted broker", tlsC, fmt.Errorf("unable to dial: %w", &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}), stateTLSFailed, "not signed by a CA"},
		{"expired", tlsC, x509.CertificateInvalidError{Reason: x509.Expired}, stateTLSFailed, "expired"},
		{"refused", plain, refused, stateUnreachable, "h:1"},
		{"deadline", tlsC, context.DeadlineExceeded, stateUnreachable, "speak TLS"},
		{"something else", plain, errors.New("kaboom"), stateUnreachable, "kaboom"},
	}
	for _, c := range cases {
		state, msg := classify(c.c, c.err, false)
		if state != c.state || !strings.Contains(msg, c.has) {
			t.Errorf("%s: %s / %q, want %s mentioning %q", c.name, state, msg, c.state, c.has)
		}
	}
}
