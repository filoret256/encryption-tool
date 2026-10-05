package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pavlo-v-chernykh/keystore-go/v4"
	pkcs12 "software.sslmate.com/src/go-pkcs12"

	"enc-tool/kafka-agent/internal/testpki"
)

// stand writes a PKI to a folder and loads the six clusters cmd/testpki
// describes — exactly what an operator gets from the generator.
func stand(t *testing.T) (*testpki.PKI, string, map[string]*cluster) {
	t.Helper()
	pki, err := testpki.New()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := pki.WriteFiles(dir); err != nil {
		t.Fatal(err)
	}
	list, _, err := loadClusters(clusterFlags{config: filepath.Join(dir, "kafka-agent.yaml")})
	if err != nil {
		t.Fatalf("the generated stand does not load: %v", err)
	}
	byName := map[string]*cluster{}
	for _, c := range list {
		byName[c.Name] = c
	}
	return pki, dir, byName
}

// tlsServer accepts connections, finishes the handshake, remembers who the
// client claimed to be, and answers one byte.
type tlsServer struct {
	addr string
	mu   sync.Mutex
	seen []string // client certificate CNs, "" for none
}

func serveTLS(t *testing.T, cfg *tls.Config) *tlsServer {
	t.Helper()
	l, err := tls.Listen("tcp", "127.0.0.1:0", cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	s := &tlsServer{addr: l.Addr().String()}
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				tc := conn.(*tls.Conn)
				if tc.Handshake() != nil {
					return
				}
				cn := ""
				if peers := tc.ConnectionState().PeerCertificates; len(peers) > 0 {
					cn = peers[0].Subject.CommonName
				}
				s.mu.Lock()
				s.seen = append(s.seen, cn)
				s.mu.Unlock()
				one := make([]byte, 1)
				if _, err := tc.Read(one); err == nil {
					_, _ = tc.Write([]byte("k"))
				}
			}()
		}
	}()
	return s
}

// talk dials with the cluster's TLS settings and exchanges a byte. The byte
// matters: under TLS 1.3 a server that refuses the client certificate says so
// only after the client believes the handshake is done.
func talk(cfg *tls.Config, addr string) error {
	d := &net.Dialer{Timeout: 3 * time.Second}
	conn, err := tls.DialWithDialer(d, "tcp", addr, cfg)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("x")); err != nil {
		return err
	}
	one := make([]byte, 1)
	_, err = io.ReadFull(conn, one)
	return err
}

func TestEveryStoreFormatCompletesMutualTLS(t *testing.T) {
	pki, _, clusters := stand(t)
	srv := serveTLS(t, pki.ServerTLS(tls.RequireAndVerifyClientCert))

	// The same client certificate, three ways: PKCS12, JKS with a key password of
	// its own, and PEM (a combined file, as Kafka's ssl.keystore.type=PEM reads).
	for _, name := range []string{"ssl-p12", "ssl-jks", "ssl-pem"} {
		cfg, err := buildTLS(clusters[name])
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := talk(cfg, srv.addr); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if len(srv.seen) != 3 {
		t.Fatalf("the broker completed %d handshakes, want 3", len(srv.seen))
	}
	for _, cn := range srv.seen {
		if cn != "kafka-agent-test" {
			t.Errorf("the broker saw client %q", cn)
		}
	}
}

func TestSeparatePEMFilesAndInlinePEM(t *testing.T) {
	pki, dir, clusters := stand(t)
	srv := serveTLS(t, pki.ServerTLS(tls.RequireAndVerifyClientCert))

	c := clusters["ssl-pem"]
	c.Keystore = store{}
	c.CertFile, c.KeyFile = filepath.Join(dir, "client.pem"), filepath.Join(dir, "client.key")
	cfg, err := buildTLS(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := talk(cfg, srv.addr); err != nil {
		t.Errorf("cert and key as separate files: %v", err)
	}

	keyPEM, _ := pki.ClientKeyPEM()
	c.CertFile, c.KeyFile = "", ""
	c.CertPEM, c.KeyPEM = string(pki.ClientCertPEM()), string(keyPEM)
	c.Truststore = store{}
	c.TrustPEM = string(pki.CAPEM())
	if cfg, err = buildTLS(c); err != nil {
		t.Fatal(err)
	}
	if err := talk(cfg, srv.addr); err != nil {
		t.Errorf("everything inline: %v", err)
	}
}

func TestAKindIsTakenFromTheFileNotTheDeclaredType(t *testing.T) {
	pki, dir, clusters := stand(t)
	srv := serveTLS(t, pki.ServerTLS(tls.RequireAndVerifyClientCert))
	c := clusters["ssl-p12"]
	// A PKCS12 keystore declared as JKS, and a JKS truststore declared as PKCS12:
	// Java reads both, so the agent does too.
	c.Keystore.Type = "JKS"
	c.Truststore = store{Location: filepath.Join(dir, "truststore.jks"), Password: testpki.StorePassword, Type: "PKCS12"}
	cfg, err := buildTLS(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := talk(cfg, srv.addr); err != nil {
		t.Fatal(err)
	}
}

func TestTrustingTheWrongCAIsSaidInTermsOfTheTruststore(t *testing.T) {
	pki, _, clusters := stand(t)
	srv := serveTLS(t, pki.ServerTLS(tls.RequireAndVerifyClientCert))

	other, _ := testpki.New()
	c := clusters["ssl-p12"]
	c.Truststore = store{}
	c.TrustPEM = string(other.CAPEM())
	cfg, err := buildTLS(c)
	if err != nil {
		t.Fatal(err)
	}
	err = talk(cfg, srv.addr)
	if err == nil {
		t.Fatal("connected to a broker signed by a CA that is not trusted")
	}
	got, ok := tlsProblem(err)
	if !ok || !strings.Contains(got, "ssl.truststore.location") {
		t.Fatalf("%q → %q", err, got)
	}
	// The chain is still checked when the name is not.
	c.VerifyHostname = false
	cfg, _ = buildTLS(c)
	if err := talk(cfg, srv.addr); err == nil {
		t.Fatal("with the hostname check off, an untrusted chain was accepted")
	}
}

func TestARefusedClientCertificateIsSaid(t *testing.T) {
	pki, _, clusters := stand(t)
	srv := serveTLS(t, pki.ServerTLS(tls.RequireAndVerifyClientCert))

	// No client certificate at all: the sasl-ssl cluster has a truststore only.
	cfg, err := buildTLS(clusters["sasl-ssl"])
	if err != nil {
		t.Fatal(err)
	}
	err = talk(cfg, srv.addr)
	if err == nil {
		t.Fatal("a broker that requires a client certificate let a client without one through")
	}
	if got, ok := tlsProblem(err); !ok || !strings.Contains(got, "client certificate") {
		t.Fatalf("%q → %q", err, got)
	}

	// A certificate the broker's CA did not issue.
	other, _ := testpki.New()
	c := clusters["ssl-p12"]
	c.Keystore = store{}
	keyPEM, _ := other.ClientKeyPEM()
	c.CertPEM, c.KeyPEM = string(other.ClientCertPEM()), string(keyPEM)
	cfg, _ = buildTLS(c)
	if err := talk(cfg, srv.addr); err == nil {
		t.Fatal("a certificate from another CA was accepted")
	} else if got, ok := tlsProblem(err); !ok || !strings.Contains(got, "client certificate") {
		t.Fatalf("%q → %q", err, got)
	}
}

func TestHostnameCheckAndHowToSwitchItOff(t *testing.T) {
	pki, _, clusters := stand(t)
	srv := serveTLS(t, pki.ServerTLS(tls.RequireAndVerifyClientCert))
	c := clusters["ssl-p12"]

	cfg, _ := buildTLS(c)
	cfg.ServerName = "broker.elsewhere.example"
	err := talk(cfg, srv.addr)
	if got, ok := tlsProblem(err); !ok || !strings.Contains(got, "broker.elsewhere.example") || !strings.Contains(got, "ssl.endpoint.identification.algorithm") {
		t.Fatalf("a certificate for another name: %v → %q", err, got)
	}

	c.VerifyHostname = false
	cfg, _ = buildTLS(c)
	cfg.ServerName = "broker.elsewhere.example"
	if err := talk(cfg, srv.addr); err != nil {
		t.Fatalf("with the name check off: %v", err)
	}
}

func TestAPlaintextBrokerIsRecognised(t *testing.T) {
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
			go func() {
				// The ClientHello is read first: closing with it unread makes the
				// system reset the connection, and the client would report the
				// reset instead of what was said.
				_ = conn.SetReadDeadline(time.Now().Add(time.Second))
				_, _ = conn.Read(make([]byte, 1024))
				_, _ = conn.Write([]byte("not tls at all, and long enough to be a record header\n"))
				time.Sleep(200 * time.Millisecond)
				conn.Close()
			}()
		}
	}()
	cfg, _ := buildTLS(clusters["sasl-ssl"])
	err = talk(cfg, l.Addr().String())
	if got, ok := tlsProblem(err); !ok || !strings.Contains(got, "not speaking TLS") {
		t.Fatalf("%v → %q", err, got)
	}
}

func TestStoreProblemsNameTheSetting(t *testing.T) {
	_, dir, clusters := stand(t)
	fresh := func(name string) *cluster { c := *clusters[name]; return &c }
	expect := func(what string, c *cluster, want ...string) {
		t.Helper()
		_, err := buildTLS(c)
		if err == nil {
			t.Errorf("%s: accepted", what)
			return
		}
		for _, w := range want {
			if !strings.Contains(err.Error(), w) {
				t.Errorf("%s: %q does not mention %q", what, err, w)
			}
		}
	}

	c := fresh("ssl-p12")
	c.Keystore.Password = "nope-nope"
	expect("PKCS12 keystore, wrong password", c, "ssl.keystore.location", "wrong password", "ssl.keystore.password")

	c = fresh("ssl-jks")
	c.Keystore.Password = "nope-nope"
	expect("JKS keystore, wrong password", c, "wrong password", "ssl.keystore.password")

	c = fresh("ssl-jks")
	c.KeyPassword = "nope-nope"
	expect("JKS key, wrong key password", c, "cannot open the key", "ssl.key.password")

	c = fresh("ssl-jks")
	c.KeyPassword = "" // falls back to the store's password, which is not the key's
	expect("JKS key that has a password of its own, none given", c, "ssl.key.password")

	c = fresh("ssl-jks")
	c.Truststore.Password = "nope-nope"
	expect("JKS truststore, wrong password", c, "ssl.truststore.location", "wrong password", "ssl.truststore.password")

	c = fresh("ssl-jks")
	c.Truststore.Password = ""
	expect("JKS truststore, no password", c, "needs its password")

	c = fresh("ssl-p12")
	c.Truststore = store{Location: filepath.Join(dir, "truststore.p12"), Password: "nope-nope"}
	expect("PKCS12 truststore, wrong password", c, "wrong password", "ssl.truststore.password")

	c = fresh("ssl-p12")
	c.Truststore = store{Location: filepath.Join(dir, "client.key")}
	c.Keystore = store{}
	expect("a key where a truststore belongs", c, "no certificates")

	// A truststore that trusts nothing, and a keystore that holds no key.
	empty := filepath.Join(dir, "empty.jks")
	ks := keystore.New()
	f, _ := os.Create(empty)
	_ = ks.Store(f, []byte(testpki.StorePassword))
	f.Close()
	c = fresh("ssl-jks")
	c.Truststore.Location = empty
	expect("an empty truststore", c, "no trusted certificate entries")
	c = fresh("ssl-jks")
	c.Keystore.Location = empty
	expect("a keystore with no key", c, "no private key entry")

	// JCEKS and rubbish.
	jceks := filepath.Join(dir, "x.jceks")
	_ = os.WriteFile(jceks, []byte{0xCE, 0xCE, 0xCE, 0xCE, 0, 0, 0, 2}, 0o600)
	c = fresh("ssl-jks")
	c.Keystore.Location = jceks
	expect("JCEKS", c, "JCEKS", "keytool -importkeystore")
	junk := filepath.Join(dir, "junk.bin")
	_ = os.WriteFile(junk, []byte("hello"), 0o600)
	c = fresh("ssl-jks")
	c.Truststore.Location = junk
	expect("not a store", c, "not a PEM, PKCS12 or JKS file")

	// Encrypted PEM key.
	enc := filepath.Join(dir, "enc.key")
	_ = os.WriteFile(enc, []byte("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n"), 0o600)
	c = fresh("ssl-pem")
	c.Keystore = store{}
	c.CertFile, c.KeyFile = filepath.Join(dir, "client.pem"), enc
	expect("encrypted PEM key", c, "encrypted", "PKCS12")

	// A key that is not the certificate's.
	other, _ := testpki.New()
	otherKey, _ := other.ClientKeyPEM()
	otherKeyFile := filepath.Join(dir, "other.key")
	_ = os.WriteFile(otherKeyFile, otherKey, 0o600)
	c = fresh("ssl-pem")
	c.Keystore = store{}
	c.CertFile, c.KeyFile = filepath.Join(dir, "client.pem"), otherKeyFile
	expect("a key that does not fit the certificate", c, "does not match")

	// Two keys in one JKS.
	two := filepath.Join(dir, "two.jks")
	{
		ks := keystore.New()
		key, _ := x509.MarshalPKCS8PrivateKey(other.Client.Key)
		for _, alias := range []string{"a", "b"} {
			_ = ks.SetPrivateKeyEntry(alias, keystore.PrivateKeyEntry{
				CreationTime: time.Now(), PrivateKey: key,
				CertificateChain: []keystore.Certificate{{Type: "X509", Content: other.Client.Cert.Raw}},
			}, []byte(testpki.StorePassword))
		}
		f, _ := os.Create(two)
		_ = ks.Store(f, []byte(testpki.StorePassword))
		f.Close()
	}
	c = fresh("ssl-jks")
	c.Keystore.Location = two
	c.KeyPassword = ""
	expect("two keys, no way to choose", c, "2 private keys", "a, b")
}

func TestTruststoreThatJavaDidNotMake(t *testing.T) {
	// openssl's `pkcs12 -export -nokeys` writes plain certificate bags, without
	// the marking Java gives a trust anchor.
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("openssl is not installed")
	}
	_, dir, clusters := stand(t)
	p12 := filepath.Join(dir, "plain.p12")
	out, err := exec.Command("openssl", "pkcs12", "-export", "-nokeys", "-in", filepath.Join(dir, "ca.pem"),
		"-out", p12, "-passout", "pass:"+testpki.StorePassword, "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1").CombinedOutput()
	if err != nil {
		t.Skipf("this openssl cannot write a legacy PKCS12: %v\n%s", err, out)
	}
	c := clusters["ssl-p12"]
	c.Truststore = store{Location: p12, Password: testpki.StorePassword}
	_, err = buildTLS(c)
	if err == nil || !strings.Contains(err.Error(), "not a truststore") || !strings.Contains(err.Error(), "PEM") {
		t.Fatalf("a PKCS12 file without the trust marking: %v — want a message that says what to do", err)
	}
}

func TestModernPKCS12IsRead(t *testing.T) {
	pki, _, clusters := stand(t)
	dir := t.TempDir()
	trust, _ := pki.P12Truststore(pkcs12.Modern2023, testpki.StorePassword)
	client, _ := pki.P12Client(pkcs12.Modern2023, testpki.StorePassword)
	_ = os.WriteFile(filepath.Join(dir, "t.p12"), trust, 0o600)
	_ = os.WriteFile(filepath.Join(dir, "c.p12"), client, 0o600)
	c := clusters["ssl-p12"]
	c.Truststore = store{Location: filepath.Join(dir, "t.p12"), Password: testpki.StorePassword}
	c.Keystore = store{Location: filepath.Join(dir, "c.p12"), Password: testpki.StorePassword}
	srv := serveTLS(t, pki.ServerTLS(tls.RequireAndVerifyClientCert))
	cfg, err := buildTLS(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := talk(cfg, srv.addr); err != nil {
		t.Fatal(err)
	}
}

func TestNotATLSProblem(t *testing.T) {
	for _, err := range []error{nil, errors.New("connection refused"), io.EOF} {
		if got, ok := tlsProblem(err); ok {
			t.Errorf("%v was called a TLS problem: %q", err, got)
		}
	}
}
