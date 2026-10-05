// Package testpki makes the certificates the kafka-agent's tests and the local
// Kafka stand need: one CA, a broker certificate, a client certificate, and
// the client's key material in every format the agent reads — PEM, PKCS12 and
// JKS, the JKS one with a key password that differs from the store's.
//
// Nothing here ships in the agent: no non-test file imports this package.
// The keys are generated fresh each time, never committed, and good for one
// thing only — talking to a broker on this machine.
package testpki

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/pavlo-v-chernykh/keystore-go/v4"
	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

const (
	// StorePassword protects every store file; KeyPassword protects the key
	// inside client.jks, and differs on purpose — a keystore whose key has its
	// own password is the case people get wrong.
	StorePassword = "changeit"
	KeyPassword   = "keypass"
)

// Leaf is a certificate with its key.
type Leaf struct {
	Cert *x509.Certificate
	Key  *ecdsa.PrivateKey
}

// PKI is a CA and the two certificates it signed.
type PKI struct {
	CA     Leaf
	Server Leaf
	Client Leaf
}

func serial() *big.Int {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 100))
	if err != nil {
		panic(err) // the system's random source failing is not recoverable here
	}
	return n
}

func issue(tmpl, parent *x509.Certificate, parentKey *ecdsa.PrivateKey) (Leaf, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Leaf{}, err
	}
	if parentKey == nil {
		parentKey = key // self-signed
	}
	if parent == nil {
		parent = tmpl
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &key.PublicKey, parentKey)
	if err != nil {
		return Leaf{}, err
	}
	cert, err := x509.ParseCertificate(der)
	return Leaf{Cert: cert, Key: key}, err
}

// New makes a PKI. The broker certificate names localhost, 127.0.0.1 and
// kafka (the compose service), which is everything a client on this machine
// or in the compose network dials.
func New() (*PKI, error) {
	now := time.Now()
	ca, err := issue(&x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: "kafka-agent test CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(30 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}, nil, nil)
	if err != nil {
		return nil, err
	}
	server, err := issue(&x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(30 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost", "kafka"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}, ca.Cert, ca.Key)
	if err != nil {
		return nil, err
	}
	client, err := issue(&x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: "kafka-agent-test"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(30 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}, ca.Cert, ca.Key)
	if err != nil {
		return nil, err
	}
	return &PKI{CA: ca, Server: server, Client: client}, nil
}

// ServerTLS is what a broker's listener would run: the broker certificate, and
// — when clientAuth asks for it — a check of the client's against the CA.
func (p *PKI) ServerTLS(clientAuth tls.ClientAuthType) *tls.Config {
	pool := x509.NewCertPool()
	pool.AddCert(p.CA.Cert)
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{{Certificate: [][]byte{p.Server.Cert.Raw}, PrivateKey: p.Server.Key}},
		ClientAuth:   clientAuth,
		ClientCAs:    pool,
	}
}

// ── encodings ─────────────────────────────────────────────────────────────

func certPEM(c *x509.Certificate) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raw})
}

func keyDER(k *ecdsa.PrivateKey) ([]byte, error) { return x509.MarshalPKCS8PrivateKey(k) }

func keyPEM(k *ecdsa.PrivateKey) ([]byte, error) {
	der, err := keyDER(k)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

// CAPEM, ClientCertPEM and ClientKeyPEM are the PEM forms, for tests that
// pass a certificate inline.
func (p *PKI) CAPEM() []byte         { return certPEM(p.CA.Cert) }
func (p *PKI) ClientCertPEM() []byte { return certPEM(p.Client.Cert) }
func (p *PKI) ClientKeyPEM() ([]byte, error) {
	return keyPEM(p.Client.Key)
}

// JKSTruststore is a JKS file trusting the CA.
func (p *PKI) JKSTruststore(password string) ([]byte, error) {
	ks := keystore.New()
	if err := ks.SetTrustedCertificateEntry("ca", keystore.TrustedCertificateEntry{
		CreationTime: time.Now(),
		Certificate:  keystore.Certificate{Type: "X509", Content: p.CA.Cert.Raw},
	}); err != nil {
		return nil, err
	}
	return storeJKS(ks, password)
}

// JKSKeystore is a JKS file holding the client key and its chain, the key
// under keyPassword.
func (p *PKI) JKSKeystore(storePassword, keyPassword string) ([]byte, error) {
	der, err := keyDER(p.Client.Key)
	if err != nil {
		return nil, err
	}
	ks := keystore.New()
	if err := ks.SetPrivateKeyEntry("client", keystore.PrivateKeyEntry{
		CreationTime: time.Now(),
		PrivateKey:   der,
		CertificateChain: []keystore.Certificate{
			{Type: "X509", Content: p.Client.Cert.Raw},
			{Type: "X509", Content: p.CA.Cert.Raw},
		},
	}, []byte(keyPassword)); err != nil {
		return nil, err
	}
	return storeJKS(ks, storePassword)
}

func storeJKS(ks keystore.KeyStore, password string) ([]byte, error) {
	var b bytes.Buffer
	if err := ks.Store(&b, []byte(password)); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// P12Truststore is a PKCS12 file trusting the CA, marked the way Java marks a
// trust anchor.
func (p *PKI) P12Truststore(enc *pkcs12.Encoder, password string) ([]byte, error) {
	return enc.EncodeTrustStore([]*x509.Certificate{p.CA.Cert}, password)
}

// P12Client is a PKCS12 file with the client key, certificate and CA.
func (p *PKI) P12Client(enc *pkcs12.Encoder, password string) ([]byte, error) {
	return enc.Encode(p.Client.Key, p.Client.Cert, []*x509.Certificate{p.CA.Cert}, password)
}

// P12Server is the broker's keystore.
func (p *PKI) P12Server(enc *pkcs12.Encoder, password string) ([]byte, error) {
	return enc.Encode(p.Server.Key, p.Server.Cert, []*x509.Certificate{p.CA.Cert}, password)
}

// ── files ─────────────────────────────────────────────────────────────────

// Ports of the compose stand, on the host.
const (
	PortPlaintext     = 19092
	PortSSL           = 19093
	PortSASLPlaintext = 19094
	PortSASLSSL       = 19095
)

// WriteFiles writes every store, the client.properties for each kind of
// connection, and a kafka-agent.yaml naming the stand's listeners, into dir.
// Store files are world-readable: a container reads them as another user, and
// they hold nothing but test keys.
func (p *PKI) WriteFiles(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	ckey, err := keyPEM(p.Client.Key)
	if err != nil {
		return err
	}
	skey, err := keyPEM(p.Server.Key)
	if err != nil {
		return err
	}
	// LegacyDES: every JDK reads it. The modern encoder needs 8u301 / 11.0.12.
	enc := pkcs12.LegacyDES
	jksTrust, err := p.JKSTruststore(StorePassword)
	if err != nil {
		return err
	}
	jksClient, err := p.JKSKeystore(StorePassword, KeyPassword)
	if err != nil {
		return err
	}
	p12Trust, err := p.P12Truststore(enc, StorePassword)
	if err != nil {
		return err
	}
	p12Client, err := p.P12Client(enc, StorePassword)
	if err != nil {
		return err
	}
	p12Server, err := p.P12Server(enc, StorePassword)
	if err != nil {
		return err
	}

	files := map[string][]byte{
		"ca.pem":     certPEM(p.CA.Cert),
		"client.pem": certPEM(p.Client.Cert),
		"client.key": ckey,
		// The one-file form Kafka's own ssl.keystore.type=PEM reads.
		"client-combined.pem": append(append(certPEM(p.Client.Cert), certPEM(p.CA.Cert)...), ckey...),
		"server.pem":          certPEM(p.Server.Cert),
		"server.key":          skey,
		"truststore.jks":      jksTrust,
		"client.jks":          jksClient,
		"truststore.p12":      p12Trust,
		"client.p12":          p12Client,
		"server.p12":          p12Server,
		// The apache/kafka image reads store and key passwords from files, not
		// from the environment: KAFKA_SSL_*_CREDENTIALS name these.
		"store-password": []byte(StorePassword + "\n"),

		"client-plaintext.properties": []byte("security.protocol=PLAINTEXT\n"),
		"client-ssl-p12.properties": []byte(fmt.Sprintf(`security.protocol=SSL
ssl.truststore.location=truststore.p12
ssl.truststore.password=%[1]s
ssl.keystore.location=client.p12
ssl.keystore.type=PKCS12
ssl.keystore.password=%[1]s
`, StorePassword)),
		// The key has a password of its own — the shape that trips people up.
		"client-ssl-jks.properties": []byte(fmt.Sprintf(`security.protocol=SSL
ssl.truststore.location=truststore.jks
ssl.truststore.password=%s
ssl.keystore.location=client.jks
ssl.keystore.type=JKS
ssl.keystore.password=%s
ssl.key.password=%s
`, StorePassword, StorePassword, KeyPassword)),
		"client-ssl-pem.properties": []byte(`security.protocol=SSL
ssl.truststore.location=ca.pem
ssl.truststore.type=PEM
ssl.keystore.location=client-combined.pem
ssl.keystore.type=PEM
`),
		"client-sasl-plaintext.properties": []byte(`security.protocol=SASL_PLAINTEXT
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="app" password="app-secret";
`),
		"client-sasl-ssl.properties": []byte(fmt.Sprintf(`security.protocol=SASL_SSL
sasl.mechanism=SCRAM-SHA-256
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="app" password="app-secret";
ssl.truststore.location=truststore.jks
ssl.truststore.password=%s
`, StorePassword)),

		"kafka-agent.yaml": []byte(fmt.Sprintf(`# Written by cmd/testpki for the compose stand. Every listener is a cluster.
clusters:
  - name: plaintext
    bootstrap: localhost:%d
    properties: client-plaintext.properties
  - name: ssl-p12
    bootstrap: localhost:%d
    properties: client-ssl-p12.properties
  - name: ssl-jks
    bootstrap: localhost:%d
    properties: client-ssl-jks.properties
  - name: ssl-pem
    bootstrap: localhost:%d
    properties: client-ssl-pem.properties
  - name: sasl-plaintext
    bootstrap: localhost:%d
    properties: client-sasl-plaintext.properties
  - name: sasl-ssl
    bootstrap: localhost:%d
    properties: client-sasl-ssl.properties
`, PortPlaintext, PortSSL, PortSSL, PortSSL, PortSASLPlaintext, PortSASLSSL)),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil { // #nosec G306 -- test keys, read by a container running as another user
			return err
		}
	}
	return nil
}
