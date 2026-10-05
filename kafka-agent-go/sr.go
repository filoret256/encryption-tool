// A cluster's Schema Registry: its client, and what the page may ask of it.
//
// A registry is a small HTTP service beside the cluster — Confluent's, or anything that
// speaks the same REST API. It has a URL, a login and stores of its own, and all three come
// from the operator's configuration: the page names a cluster, as everywhere else here, and
// never a registry or a credential.
//
// Only reads live here (K-41). What the schemas are, and what a message's bytes mean
// according to one, is K-42 and K-43; writing a schema is K-47.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/sr"
)

// How long one registry request may take. A registry that is down refuses at once; one
// behind a black hole is given this and no longer, so that a person is told rather than
// left watching a spinner.
const registryTimeout = 10 * time.Second

// registryClient returns this connection's client for the cluster's registry, making it on
// first use. A cluster without one answers nil, nil.
//
// One client per connection, like the Kafka client: the connection is the page's session,
// and a client per request would build its own HTTP pool every time. Nothing has to be
// closed — the client is a wrapper around an *http.Client, not a connection of its own.
func (c *connection) registryClient(cl *cluster) (*sr.Client, error) {
	if cl.Registry == nil {
		return nil, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.registries[cl.Name]; ok {
		return existing, nil
	}
	opts := []sr.ClientOpt{
		sr.URLs(strings.TrimSuffix(cl.Registry.URL, "/")),
		sr.UserAgent("enc-tool-kafka-agent/" + version),
		// The library would use http.DefaultClient, which has no timeout at all.
		sr.HTTPClient(&http.Client{Timeout: registryTimeout}),
	}
	if cl.Registry.Username != "" {
		opts = append(opts, sr.BasicAuth(cl.Registry.Username, cl.Registry.Password))
	}
	if strings.HasPrefix(cl.Registry.URL, "https://") {
		cfg, err := buildTLS(cl.Registry.tls)
		if err != nil {
			return nil, &opError{Code: "ECONFIG", Message: err.Error()}
		}
		opts = append(opts, sr.DialTLSConfig(cfg))
	}
	client, err := sr.NewClient(opts...)
	if err != nil {
		return nil, &opError{Code: "ECONFIG", Message: err.Error()}
	}
	if c.registries == nil {
		c.registries = map[string]*sr.Client{}
	}
	c.registries[cl.Name] = client
	return client, nil
}

// ── schemas.status ────────────────────────────────────────────────────────

// The states a registry can be in, as the page sees them. Apart from
// not_configured these are not the cluster's states: a registry has its own
// credentials and its own TLS, and one being wrong says nothing about the broker.
const (
	schemaNotConfigured = "not_configured"
	schemaConnected     = "connected"
	schemaAuthFailed    = "auth_failed"
	schemaUnreachable   = "unreachable"
	schemaTLSFailed     = "tls_failed"
	schemaError         = "error"
)

// registryProblem says what a registry's failure means, in the terms of the setting to
// change. The registry's own words are kept: it is the only thing that knows whether the
// password is wrong or the subject is missing.
//
// TLS is asked about first: a registry with a self-signed certificate is the mistake that
// looks least like itself — the error arrives as a transport failure, and "cannot reach the
// registry" would send the operator to look at the wrong thing.
func registryProblem(err error) (state, message string) {
	var unknownCA x509.UnknownAuthorityError
	var wrongName x509.HostnameError
	var badCert x509.CertificateInvalidError
	var recordErr tls.RecordHeaderError
	switch {
	case errors.As(err, &unknownCA):
		return schemaTLSFailed, "the registry's certificate is not signed by a CA this agent trusts — add that CA to the truststore (schemaRegistry.tls.truststore.location), or use http"
	case errors.As(err, &wrongName):
		return schemaTLSFailed, fmt.Sprintf("the registry's certificate is for %q, and the agent connected to %q — issue it for that name, or set schemaRegistry.tls.verifyHostname: false (the chain is still checked)", wrongName.Certificate.Subject.CommonName, wrongName.Host)
	case errors.As(err, &badCert):
		return schemaTLSFailed, "the registry's certificate is expired, or not valid yet — check it, and this machine's clock"
	case errors.As(err, &recordErr):
		return schemaTLSFailed, "the port is not speaking TLS — schemaRegistry.url says https, and something else answered there"
	}
	var resp *sr.ResponseError
	if errors.As(err, &resp) {
		said := trimTo(strings.TrimSpace(resp.Error()), 300)
		switch resp.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return schemaAuthFailed, fmt.Sprintf("the registry refused the login (HTTP %d: %s) — check schemaRegistry.username and schemaRegistry.password", resp.StatusCode, said)
		case http.StatusNotFound:
			// A registry that answers, and has no such endpoint: old, or something else
			// entirely is listening on that URL.
			return schemaError, fmt.Sprintf("the registry has no such endpoint (HTTP 404: %s) — check that schemaRegistry.url names a Schema Registry", said)
		}
		return schemaError, fmt.Sprintf("the registry answered HTTP %d: %s", resp.StatusCode, said)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return schemaUnreachable, fmt.Sprintf("no answer within %s — is the registry up, and is its port open to this machine?", registryTimeout)
	}
	return schemaUnreachable, "cannot reach the registry: " + trimTo(err.Error(), 300)
}

// schemasStatus answers what the page may know about a cluster's registry: whether there is
// one, whether it answers, and what it says about itself. A registry that does not answer is
// an answer, not an error — as a cluster that is down is (clusters.status).
func schemasStatus(c *opCtx, p clusterParams) (any, error) {
	cl, err := c.srv.cluster(p.Cluster)
	if err != nil {
		return nil, err
	}
	if cl.Registry == nil {
		return schemaStatus{Name: cl.Name, State: schemaNotConfigured}, nil
	}
	client, err := c.conn.registryClient(cl)
	if err != nil {
		// The client could not be made at all: the URL, or the stores behind it.
		var coded *opError
		msg := err.Error()
		if errors.As(err, &coded) {
			msg = coded.Message
		}
		return schemaStatus{Name: cl.Name, State: schemaError, Message: msg}, nil
	}

	ctx, cancel := context.WithTimeout(c.ctx, registryTimeout)
	defer cancel()

	out := schemaStatus{Name: cl.Name, State: schemaConnected}
	modes := client.Mode(ctx)
	if len(modes) == 0 {
		return schemaStatus{Name: cl.Name, State: schemaError, Message: "the registry answered nothing to a mode request"}, nil
	}
	if modes[0].Err != nil {
		state, message := registryProblem(modes[0].Err)
		return schemaStatus{Name: cl.Name, State: state, Message: message}, nil
	}
	mode := modes[0].Mode.String()
	out.Mode = &mode

	// The default compatibility level, and how many subjects there are: two small reads
	// that tell a person what the registry holds. Neither is what "connected" rests on.
	if compats := client.Compatibility(ctx); len(compats) > 0 && compats[0].Err == nil {
		level := compats[0].Level.String()
		out.Compatibility = &level
	}
	if subjects, serr := client.Subjects(ctx); serr == nil {
		n := len(subjects)
		out.Subjects = &n
	}
	return out, nil
}
