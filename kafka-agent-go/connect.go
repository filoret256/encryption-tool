// Connecting to a cluster: the client's options, SASL, and what it means when
// the connection does not come up.
//
// The page never says where to connect. It names a cluster, the agent looks
// the name up in its own configuration, and everything here — brokers, stores,
// credentials — comes from there.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
	"github.com/twmb/franz-go/pkg/kversion"
	"github.com/twmb/franz-go/pkg/sasl"
	"github.com/twmb/franz-go/pkg/sasl/scram"
)

// How long a dial may take. A broker that is down answers at once with a
// refusal; one that is filtered by a firewall answers not at all, and this
// is how long the operator waits to find that out.
const dialTimeout = 5 * time.Second

// The whole of a status check: dial, TLS, SASL, one metadata request and one
// ApiVersions. Retries inside it are few (see clientOpts), so the wait for a
// dead cluster is a couple of seconds, not this bound. A variable so tests
// can shorten the wait for a broker that never answers.
var statusTimeout = 12 * time.Second

// saslMechanism is the client side of SCRAM for the cluster, or nil when the
// cluster does not use SASL. Only SCRAM is offered: validate() has already
// refused everything else with a message that says so.
func saslMechanism(c *cluster) (sasl.Mechanism, error) {
	if !strings.HasPrefix(c.Protocol, "SASL_") {
		return nil, nil
	}
	auth := scram.Auth{User: c.Username, Pass: c.Password}
	switch c.Mechanism {
	case "SCRAM-SHA-256":
		return auth.AsSha256Mechanism(), nil
	case "SCRAM-SHA-512":
		return auth.AsSha512Mechanism(), nil
	}
	return nil, fmt.Errorf("SASL mechanism %q is not supported — use SCRAM-SHA-256 or SCRAM-SHA-512", c.Mechanism)
}

// clientOpts turns a cluster into franz-go options.
//
// Retries are kept few and short on purpose. The library's defaults suit a
// long-running producer that should ride out a broker restart; this agent
// serves a person looking at a screen, who is better told "connection
// refused" in two seconds than kept waiting for the twentieth attempt. A
// consume that needs patience makes its own.
func clientOpts(c *cluster) ([]kgo.Opt, error) {
	opts := []kgo.Opt{
		kgo.SeedBrokers(c.Bootstrap...),
		kgo.ClientID("enc-tool-kafka-agent/" + version),
		kgo.DialTimeout(dialTimeout),
		// The library adds 10s to every request's own timeout before it gives a
		// silent broker up, and retries after that. Half of it is plenty for the
		// admin requests this agent makes.
		kgo.RequestTimeoutOverhead(5 * time.Second),
		kgo.RequestRetries(2),
		kgo.RetryTimeout(8 * time.Second),
		kgo.RetryBackoffFn(func(n int) time.Duration { return time.Duration(n) * 250 * time.Millisecond }),
	}
	if c.Protocol == "SSL" || c.Protocol == "SASL_SSL" {
		cfg, err := buildTLS(c)
		if err != nil {
			return nil, err
		}
		opts = append(opts, kgo.DialTLSConfig(cfg))
	}
	mech, err := saslMechanism(c)
	if err != nil {
		return nil, err
	}
	if mech != nil {
		opts = append(opts, kgo.SASL(mech))
	}
	return opts, nil
}

// ── the connection's clients ──────────────────────────────────────────────

// client returns this connection's client for a cluster, creating it on first
// use. They live as long as the page's connection does: closing the tab closes
// every socket to every broker.
func (c *connection) client(cl *cluster) (*kgo.Client, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.clients[cl.Name]; ok {
		return existing, nil
	}
	opts, err := clientOpts(cl)
	if err != nil {
		return nil, &opError{Code: "ECONFIG", Message: err.Error()}
	}
	kc, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, &opError{Code: "ECONFIG", Message: err.Error()}
	}
	if c.clients == nil {
		c.clients = map[string]*kgo.Client{}
	}
	c.clients[cl.Name] = kc
	return kc, nil
}

// dropClient closes one cluster's client, so that the next use makes a new one.
func (c *connection) dropClient(name string) {
	c.mu.Lock()
	kc := c.clients[name]
	delete(c.clients, name)
	c.mu.Unlock()
	if kc != nil {
		kc.Close()
	}
}

func (c *connection) closeClients() {
	c.mu.Lock()
	clients := c.clients
	c.clients = nil
	c.mu.Unlock()
	for _, kc := range clients {
		kc.Close()
	}
}

// ── clusters.status ───────────────────────────────────────────────────────

// The states a cluster can be in, as the page sees them.
const (
	stateConnected   = "connected"
	stateUnreachable = "unreachable"
	stateTLSFailed   = "tls_failed"
	stateAuthFailed  = "auth_failed"
	stateConfigError = "config_error"
)

// status connects and asks the cluster who it is.
//
// A cluster that cannot be reached is an answer, not an error: the page shows
// "unreachable" and why. Only a request that was itself wrong — no such
// cluster — or one the page cancelled fails.
func (s *server) status(ctx context.Context, conn *connection, cl *cluster) (*clusterStatus, error) {
	st := &clusterStatus{Name: cl.Name}
	kc, err := conn.client(cl)
	if err != nil {
		st.State, st.Message = stateConfigError, err.Error()
		return st, nil
	}

	ctx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()

	meta := kmsg.NewPtrMetadataRequest()
	meta.Topics = []kmsg.MetadataRequestTopic{} // empty, not null: null asks for every topic

	// The request runs on its own goroutine so that the bound is a bound: the
	// library retries a silent broker on its own schedule, which can outlast the
	// context. The channel is buffered, so a late answer has somewhere to go.
	type answer struct {
		resp *kmsg.MetadataResponse
		err  error
	}
	got := make(chan answer, 1)
	go func() {
		r, e := meta.RequestWith(ctx, kc)
		got <- answer{r, e}
	}()
	var resp *kmsg.MetadataResponse
	select {
	case a := <-got:
		if a.err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil, a.err // the page moved on; nothing to report to
			}
			st.State, st.Message = classify(cl, a.err, ctx.Err() != nil)
			return st, nil
		}
		resp = a.resp
	case <-ctx.Done():
		if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, ctx.Err()
		}
		// A client still retrying against a broker that is not answering is of no
		// use to the next request either; the next one starts clean.
		conn.dropClient(cl.Name)
		st.State, st.Message = classify(cl, context.DeadlineExceeded, true)
		return st, nil
	}

	st.State = stateConnected
	st.ClusterID = resp.ClusterID
	controller := resp.ControllerID
	st.Controller = &controller
	brokers := len(resp.Brokers)
	st.Brokers = &brokers

	if vr, err := kmsg.NewPtrApiVersionsRequest().RequestWith(ctx, kc); err == nil {
		guess := kversion.FromApiVersionsResponse(vr).VersionGuess()
		st.Version = &guess
	}
	return st, nil
}

// classify turns the error of a failed connection into a state and a message
// that says what to change. timedOut is whether the status deadline, rather
// than the network, ended the wait.
//
// The library reports what it saw, in its own words; the operator needs it in
// the words of their configuration. Order matters: a TLS failure is also a
// failed dial, and an authentication failure is also a failed request.
func classify(c *cluster, err error, timedOut bool) (state, message string) {
	if _, ok := errors.AsType[*kerr.Error](err); ok {
		switch {
		case errors.Is(err, kerr.SaslAuthenticationFailed):
			return stateAuthFailed, fmt.Sprintf("the broker refused the login for user %q with %s — check the username and password (sasl.jaas.config)", c.Username, c.Mechanism)
		case errors.Is(err, kerr.UnsupportedSaslMechanism):
			return stateAuthFailed, fmt.Sprintf("the broker does not offer %s on this listener — check sasl.mechanism against what the broker enables", c.Mechanism)
		case errors.Is(err, kerr.IllegalSaslState):
			return stateAuthFailed, "the broker did not accept the SASL exchange: " + err.Error()
		}
	}
	if problem, ok := tlsProblem(err); ok {
		return stateTLSFailed, problem
	}
	if _, ok := errors.AsType[*kgo.ErrFirstReadEOF](err); ok {
		// The broker hung up at once. Which of the three things it usually
		// means depends on what this agent was told to do.
		switch {
		case c.Protocol == "SASL_PLAINTEXT" || c.Protocol == "SASL_SSL":
			return stateAuthFailed, "the broker closed the connection as soon as the login started — the listener probably does not expect SASL here (security.protocol is " + c.Protocol + ")"
		case c.Protocol == "SSL":
			return stateTLSFailed, "the broker closed the connection during the TLS handshake — the listener may be plaintext, or may require a client certificate this agent does not present"
		default:
			return stateTLSFailed, "the broker closed the connection at once — the listener may require TLS or SASL (security.protocol is " + c.Protocol + ")"
		}
	}
	if strings.Contains(err.Error(), "SASL") && strings.Contains(strings.ToLower(err.Error()), "auth") {
		return stateAuthFailed, err.Error()
	}

	if timedOut || errors.Is(err, context.DeadlineExceeded) {
		hint := "is it up, and is the port open to this machine?"
		if c.Protocol == "SSL" || c.Protocol == "SASL_SSL" {
			hint = "is it up, is the port open to this machine, and does the listener speak TLS (security.protocol is " + c.Protocol + ")?"
		}
		return stateUnreachable, fmt.Sprintf("no answer from %s within %s — %s", strings.Join(c.Bootstrap, ", "), statusTimeout, hint)
	}
	if errors.Is(err, io.EOF) && strings.HasPrefix(c.Protocol, "SASL_") {
		// Some brokers answer a failed login by hanging up instead of with an error.
		return stateAuthFailed, fmt.Sprintf("the broker closed the connection during the login for user %q with %s — check the username and password (sasl.jaas.config), and that the broker enables this mechanism", c.Username, c.Mechanism)
	}
	var netErr net.Error
	if errors.As(err, &netErr) || errors.Is(err, io.EOF) || strings.Contains(err.Error(), "unable to dial") {
		return stateUnreachable, "cannot connect to " + strings.Join(c.Bootstrap, ", ") + ": " + trimDial(err)
	}
	return stateUnreachable, err.Error()
}

// trimDial drops the library's own prefix, which says nothing the rest does not.
func trimDial(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, "dial tcp"); i >= 0 {
		return msg[i:]
	}
	return strings.TrimPrefix(msg, "unable to dial: ")
}
