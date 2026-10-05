// What the ops share: decoding parameters, finding the cluster a request
// names, and saying what went wrong in the operator's terms.
package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
)

// How long an admin request may take from start to finish. The consume ops have
// their own, shorter idea of "nothing is coming" (see messages.go).
const adminTimeout = 30 * time.Second

// typed makes an op from a function of its parameters. The type argument is
// the whole of the op's contract with the page, which is why the op table in
// server.go spells it out: protocol:check reads it to hold this table to
// src/kafka-agent/protocol.ts.
func typed[P any](fn func(*opCtx, P) (any, error)) opFunc {
	return func(c *opCtx, r *req) (any, error) {
		var p P
		if err := r.decode(&p); err != nil {
			return nil, err
		}
		return fn(c, p)
	}
}

// target is what an op needs to talk to a cluster: its configuration, this
// connection's client for it, and the admin wrapper over that client.
type target struct {
	cl  *cluster
	kc  *kgo.Client
	adm *kadm.Client
	// The bound on the whole op, and the way to give it back.
	ctx    context.Context
	cancel context.CancelFunc
}

func (t *target) done() { t.cancel() }

// use looks the cluster up by the name the page gave and gets the client for
// it. The name is the only thing the page says about where to connect.
func (c *opCtx) use(name string) (*target, error) {
	cl, err := c.srv.cluster(name)
	if err != nil {
		return nil, err
	}
	// dispatch has already asked; a reload since may have said something else, and
	// this is the last place before a client is made.
	if c.write {
		if e := writable(cl); e != nil {
			return nil, e
		}
	}
	kc, err := c.conn.client(cl)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(c.ctx, adminTimeout)
	return &target{cl: cl, kc: kc, adm: kadm.NewClient(kc), ctx: ctx, cancel: cancel}, nil
}

// fail turns an error from the client library into the op's error: a cancelled
// op stays a cancelled op, and anything else says what it means for this
// cluster's settings (see classify).
func (t *target) fail(err error) error {
	if err == nil {
		return nil
	}
	var coded *opError
	if errors.As(err, &coded) {
		return err
	}
	if errors.Is(err, context.Canceled) {
		return err
	}
	_, msg := classify(t.cl, err, errors.Is(t.ctx.Err(), context.DeadlineExceeded))
	return &opError{Code: "EKAFKA", Message: msg}
}

// ── configuration entries ─────────────────────────────────────────────────

// describeConfigs asks for every configuration entry of one broker or topic.
// Raw requests rather than kadm's wrapper: the wrapper drops read-only and the
// default flag, both of which the page shows.
func (t *target) describeConfigs(resourceType kmsg.ConfigResourceType, name string) ([]configEntry, error) {
	req := kmsg.NewPtrDescribeConfigsRequest()
	res := kmsg.NewDescribeConfigsRequestResource()
	res.ResourceType = resourceType
	res.ResourceName = name
	req.Resources = append(req.Resources, res)

	resp, err := req.RequestWith(t.ctx, t.kc)
	if err != nil {
		return nil, t.fail(err)
	}
	out := []configEntry{}
	for _, r := range resp.Resources {
		if err := kerr.ErrorForCode(r.ErrorCode); err != nil {
			msg := err.Error()
			if r.ErrorMessage != nil && *r.ErrorMessage != "" {
				msg = *r.ErrorMessage
			}
			return nil, &opError{Code: "EKAFKA", Message: msg}
		}
		for _, cfg := range r.Configs {
			e := configEntry{
				Name:      cfg.Name,
				Source:    sourceName(cfg.Source),
				Sensitive: cfg.IsSensitive,
				ReadOnly:  cfg.ReadOnly,
				IsDefault: cfg.Source == kmsg.ConfigSourceDefaultConfig,
			}
			// A sensitive value is never sent on: the broker withholds it anyway,
			// and a bug here must not be the reason one reaches the page.
			if !cfg.IsSensitive {
				e.Value = cfg.Value
			}
			out = append(out, e)
		}
	}
	return out, nil
}

func sourceName(s kmsg.ConfigSource) string {
	switch s {
	case kmsg.ConfigSourceDynamicTopicConfig:
		return "topic"
	case kmsg.ConfigSourceDynamicBrokerConfig:
		return "dynamic broker"
	case kmsg.ConfigSourceDynamicDefaultBrokerConfig:
		return "dynamic default broker"
	case kmsg.ConfigSourceStaticBrokerConfig:
		return "static broker"
	case kmsg.ConfigSourceDefaultConfig:
		return "default"
	case kmsg.ConfigSourceDynamicBrokerLoggerConfig:
		return "broker logger"
	}
	return strings.ToLower(strings.ReplaceAll(s.String(), "_", " "))
}
