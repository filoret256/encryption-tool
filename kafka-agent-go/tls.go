// TLS for a cluster: the truststore, the client certificate, and what a failed
// handshake means.
//
// Stores come in the three shapes Kafka users have — PEM, PKCS12 and JKS —
// and the kind is taken from the file's own bytes, not from a declared type or
// an extension: a JKS renamed .p12, or a PKCS12 declared as JKS (which Java
// itself tolerates), should not be a reason for the connection to fail.
package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/pavlo-v-chernykh/keystore-go/v4"
	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

// buildTLS makes the *tls.Config for a cluster that uses TLS: the CAs to trust
// (the system's when none are configured), the client certificate if one is,
// and TLS 1.2 as the floor.
//
// Read again at every connection rather than once at startup: a certificate
// that was renewed on disk should be the one presented, without a restart.
// loadClusters calls it once as well, so a wrong password or a missing key is
// found when the agent starts, not when somebody opens the tab.
func buildTLS(c *cluster) (*tls.Config, error) {
	roots, err := loadTrust(c)
	if err != nil {
		return nil, err
	}
	certs, err := loadClientCert(c)
	if err != nil {
		return nil, err
	}
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, Certificates: certs}
	if !c.VerifyHostname {
		// ssl.endpoint.identification.algorithm= (empty), as in Java: the chain is
		// still checked, only the name is not. Verification is done here rather
		// than by the library, which cannot be told to skip only the name.
		cfg.InsecureSkipVerify = true // #nosec G402 -- the chain is verified in VerifyConnection; only the hostname check is off, and only because the operator asked
		cfg.VerifyConnection = func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("the broker presented no certificate")
			}
			inter := x509.NewCertPool()
			for _, ic := range cs.PeerCertificates[1:] {
				inter.AddCert(ic)
			}
			_, err := cs.PeerCertificates[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: inter})
			return err
		}
	}
	return cfg, nil
}

// ── what a file is ────────────────────────────────────────────────────────

const (
	kindJKS    = "JKS"
	kindPKCS12 = "PKCS12"
	kindPEM    = "PEM"
)

// storeKind reads the format from the first bytes. JCEKS (Java's other
// keystore, 0xCECECECE) is named so the refusal says what to do about it.
func storeKind(data []byte) (string, error) {
	if len(data) >= 4 {
		switch binary.BigEndian.Uint32(data) {
		case 0xFEEDFEED:
			return kindJKS, nil
		case 0xCECECECE:
			return "", errors.New("this is a JCEKS keystore, which this agent does not read — convert it: keytool -importkeystore -srckeystore x.jceks -srcstoretype JCEKS -destkeystore x.p12 -deststoretype PKCS12")
		}
	}
	if bytes.Contains(data, []byte("-----BEGIN ")) {
		return kindPEM, nil
	}
	if len(data) > 0 && data[0] == 0x30 { // an ASN.1 SEQUENCE: how every PKCS12 file starts
		return kindPKCS12, nil
	}
	return "", errors.New("not a PEM, PKCS12 or JKS file")
}

func readStore(key, path string) ([]byte, string, error) {
	data, err := os.ReadFile(path) // #nosec G304 -- a store the operator named in their own config
	if err != nil {
		return nil, "", fmt.Errorf("%s: cannot read %s: %v", key, path, unwrapPathError(err))
	}
	kind, err := storeKind(data)
	if err != nil {
		return nil, "", fmt.Errorf("%s: %s: %v", key, path, err)
	}
	return data, kind, nil
}

func unwrapPathError(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

// wrongPassword recognises the ways the libraries say "that password did not
// open this store".
func wrongPassword(err error) bool {
	return errors.Is(err, pkcs12.ErrIncorrectPassword) || strings.Contains(err.Error(), "got invalid digest")
}

// ── the truststore ────────────────────────────────────────────────────────

// loadTrust returns the pool of CAs to trust, or nil for the system's.
func loadTrust(c *cluster) (*x509.CertPool, error) {
	const key = "ssl.truststore.location"
	var certs []*x509.Certificate

	switch {
	case c.TrustPEM != "":
		var err error
		if certs, err = pemCerts([]byte(c.TrustPEM)); err != nil {
			return nil, fmt.Errorf("ssl.truststore.certificates: %v", err)
		}
	case c.Truststore.Location != "":
		data, kind, err := readStore(key, c.Truststore.Location)
		if err != nil {
			return nil, err
		}
		switch kind {
		case kindPEM:
			certs, err = pemCerts(data)
		case kindJKS:
			certs, err = jksTrusted(data, c.Truststore.Password)
		default:
			certs, err = p12Trusted(data, c.Truststore.Password)
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %s: %v", key, c.Truststore.Location, storeErr(err, "ssl.truststore.password"))
		}
	default:
		return nil, nil
	}

	pool := x509.NewCertPool()
	for _, cert := range certs {
		pool.AddCert(cert)
	}
	return pool, nil
}

// storeErr words a store failure, saying which setting to look at when the
// problem is the password.
func storeErr(err error, passwordKey string) error {
	if wrongPassword(err) {
		return fmt.Errorf("wrong password (%s) — or the file is damaged", passwordKey)
	}
	return err
}

func pemCerts(data []byte) ([]*x509.Certificate, error) {
	var out []*x509.Certificate
	for {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("a certificate in the file does not parse: %v", err)
		}
		out = append(out, cert)
	}
	if len(out) == 0 {
		return nil, errors.New("no certificates in the file")
	}
	return out, nil
}

func jksTrusted(data []byte, password string) ([]*x509.Certificate, error) {
	ks := keystore.New()
	if err := ks.Load(bytes.NewReader(data), []byte(password)); err != nil {
		if password == "" && wrongPassword(err) {
			// Java skips the integrity check of a truststore opened without a
			// password. The library this reads JKS with cannot, so say so.
			return nil, errors.New("a JKS truststore needs its password (ssl.truststore.password) — this agent cannot open one without it")
		}
		return nil, err
	}
	var out []*x509.Certificate
	for _, alias := range ks.Aliases() {
		if !ks.IsTrustedCertificateEntry(alias) {
			continue // a private key is not a trust anchor, here or in Java
		}
		e, err := ks.GetTrustedCertificateEntry(alias)
		if err != nil {
			return nil, err
		}
		cert, err := x509.ParseCertificate(e.Certificate.Content)
		if err != nil {
			return nil, fmt.Errorf("entry %q does not parse: %v", alias, err)
		}
		out = append(out, cert)
	}
	if len(out) == 0 {
		return nil, errors.New("no trusted certificate entries — a truststore holds certificates imported as trusted (keytool -importcert), and this file has none")
	}
	return out, nil
}

func p12Trusted(data []byte, password string) ([]*x509.Certificate, error) {
	certs, err := pkcs12.DecodeTrustStore(data, password)
	if err != nil && strings.Contains(err.Error(), "not marked as trusted") {
		// A PKCS12 file of plain certificate bags — openssl pkcs12 -export
		// -nokeys — carries no trust marking, and the library this reads PKCS12
		// with only reads trust anchors Java would recognise as such.
		return nil, errors.New("this PKCS12 file is not a truststore: its certificates lack Java's trust marking — make it with keytool -importcert -storetype PKCS12 (or openssl pkcs12 -export -nokeys -jdktrust anyExtendedKeyUsage), or point at a PEM file of CA certificates instead")
	}
	return certs, err
}

// ── the client certificate ────────────────────────────────────────────────

// loadClientCert returns the certificate to present to the broker, or none.
// Config validation has already ensured at most one source is set.
func loadClientCert(c *cluster) ([]tls.Certificate, error) {
	var certPEM, keyPEM []byte
	var err error

	switch {
	case c.Keystore.Location != "":
		return keystoreCert(c)
	case c.CertFile != "":
		if certPEM, err = readFile("tls.cert", c.CertFile); err != nil {
			return nil, err
		}
		if keyPEM, err = readFile("tls.key", c.KeyFile); err != nil {
			return nil, err
		}
	case c.CertPEM != "":
		certPEM, keyPEM = []byte(c.CertPEM), []byte(c.KeyPEM)
	default:
		return nil, nil
	}
	pair, err := pemPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("client certificate: %v", err)
	}
	return []tls.Certificate{pair}, nil
}

func readFile(key, path string) ([]byte, error) {
	data, err := os.ReadFile(path) // #nosec G304 -- a file the operator named in their own config
	if err != nil {
		return nil, fmt.Errorf("%s: cannot read %s: %v", key, path, unwrapPathError(err))
	}
	return data, nil
}

func keystoreCert(c *cluster) ([]tls.Certificate, error) {
	const key = "ssl.keystore.location"
	path := c.Keystore.Location
	data, kind, err := readStore(key, path)
	if err != nil {
		return nil, err
	}
	fail := func(err error) ([]tls.Certificate, error) {
		return nil, fmt.Errorf("%s: %s: %v", key, path, storeErr(err, "ssl.keystore.password"))
	}

	switch kind {
	case kindPEM:
		// Kafka's PEM keystore: the certificate chain and the key, in one file.
		pair, err := pemPair(data, data)
		if err != nil {
			return fail(err)
		}
		return []tls.Certificate{pair}, nil

	case kindPKCS12:
		priv, leaf, chain, err := pkcs12.DecodeChain(data, c.Keystore.Password)
		if err != nil {
			return fail(err)
		}
		der, err := x509.MarshalPKCS8PrivateKey(priv)
		if err != nil {
			return fail(err)
		}
		ders := [][]byte{leaf.Raw}
		for _, ca := range chain {
			ders = append(ders, ca.Raw)
		}
		pair, err := pairFromDER(ders, der)
		if err != nil {
			return fail(err)
		}
		return []tls.Certificate{pair}, nil

	default: // JKS
		ks := keystore.New()
		if err := ks.Load(bytes.NewReader(data), []byte(c.Keystore.Password)); err != nil {
			return fail(err)
		}
		var aliases []string
		for _, a := range ks.Aliases() {
			if ks.IsPrivateKeyEntry(a) {
				aliases = append(aliases, a)
			}
		}
		sort.Strings(aliases)
		switch len(aliases) {
		case 0:
			return fail(errors.New("no private key entry — a keystore holds a key and its certificate chain (keytool -genkeypair, or -importkeystore from a PKCS12 file)"))
		case 1:
		default:
			return fail(fmt.Errorf("%d private keys (%s) and no way to say which to present — keep one", len(aliases), strings.Join(aliases, ", ")))
		}
		// The key's own password, when it has one; Java's default is the store's.
		keyPass := c.KeyPassword
		if keyPass == "" {
			keyPass = c.Keystore.Password
		}
		entry, err := ks.GetPrivateKeyEntry(aliases[0], []byte(keyPass))
		if err != nil {
			return nil, fmt.Errorf("%s: %s: cannot open the key %q: %v — if the key has a password of its own, set ssl.key.password", key, path, aliases[0], err)
		}
		var ders [][]byte
		for _, cert := range entry.CertificateChain {
			ders = append(ders, cert.Content)
		}
		pair, err := pairFromDER(ders, entry.PrivateKey)
		if err != nil {
			return fail(err)
		}
		return []tls.Certificate{pair}, nil
	}
}

// pairFromDER checks that the key belongs to the first certificate — a
// mismatched pair would otherwise fail the handshake with an error about the
// broker — and builds the tls.Certificate.
func pairFromDER(chain [][]byte, keyDER []byte) (tls.Certificate, error) {
	var certPEM []byte
	for _, der := range chain {
		certPEM = append(certPEM, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
	}
	return pemPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
}

// pemPair reads a certificate chain and a private key from PEM. certPEM and
// keyPEM may be the same bytes (a combined file).
func pemPair(certPEM, keyPEM []byte) (tls.Certificate, error) {
	for rest := keyPEM; ; {
		var b *pem.Block
		b, rest = pem.Decode(rest)
		if b == nil {
			break
		}
		if b.Type == "ENCRYPTED PRIVATE KEY" || b.Headers["Proc-Type"] != "" && strings.Contains(b.Headers["Proc-Type"], "ENCRYPTED") {
			return tls.Certificate{}, errors.New("the private key is encrypted, and this agent reads unencrypted PEM keys only — put the key in a PKCS12 keystore instead (openssl pkcs12 -export -inkey … -in … -out client.p12)")
		}
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("%v", err)
	}
	return pair, nil
}

// ── what a failed connection means ────────────────────────────────────────

// tlsProblem says what a connection error means in terms of the operator's
// settings, or reports that it is not a TLS problem.
//
// The library's errors are accurate and unhelpful: "x509: certificate signed
// by unknown authority" names no setting. Every case here ends in the thing to
// change.
func tlsProblem(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	if _, ok := errors.AsType[x509.UnknownAuthorityError](err); ok {
		return "the broker's certificate is not signed by a CA this agent trusts — add the CA to the truststore (ssl.truststore.location)", true
	}
	if he, ok := errors.AsType[x509.HostnameError](err); ok {
		return fmt.Sprintf("the broker's certificate is not valid for the name the agent connected to (%s) — reissue it with that name, or set ssl.endpoint.identification.algorithm to an empty value to skip the name check", he.Host), true
	}
	if ci, ok := errors.AsType[x509.CertificateInvalidError](err); ok {
		switch ci.Reason {
		case x509.Expired:
			return "the broker's certificate has expired, or is not valid yet — check the broker's certificate and this machine's clock", true
		default:
			return fmt.Sprintf("the broker's certificate is not acceptable (%s)", ci.Detail), true
		}
	}

	msg := err.Error()
	switch {
	case strings.Contains(msg, "first record does not look like a TLS handshake"):
		return "the port is not speaking TLS — security.protocol is SSL or SASL_SSL, but this listener is plaintext", true
	case strings.Contains(msg, "certificate required"),
		strings.Contains(msg, "bad certificate"),
		strings.Contains(msg, "unknown certificate authority"),
		strings.Contains(msg, "unknown certificate"):
		return "the broker rejected the client certificate, or wanted one and got none — check ssl.keystore.location, and that the broker trusts the CA that issued it", true
	case strings.Contains(msg, "protocol version not supported"), strings.Contains(msg, "no supported versions"):
		return "no TLS version in common with the broker — this agent needs TLS 1.2 or newer", true
	case strings.Contains(msg, "tls:"):
		return "TLS handshake failed: " + msg, true
	}
	return "", false
}
