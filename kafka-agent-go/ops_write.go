// The ops that change a cluster: messages.produce and topics.delete.
//
// Every one is registered with writeOp, so dispatch refuses it on a read-only
// cluster before this file is reached (see readonly_test.go); nothing here has to
// ask again. What is here is the checking a write deserves once it is allowed:
// that the thing it acts on is what the page meant, and that the answer says what
// happened.
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/twmb/franz-go/pkg/kgo"
)

const (
	// The most one message may carry in key, value and headers together. Larger than
	// the brokers' usual limit (1 MiB) on purpose: whether it is too large is the
	// cluster's to say, in its own words, and it differs between clusters.
	maxProduceBytes = maxGetBytes
	maxHeaders      = 100
	maxHeaderKey    = 1 << 10
)

// decodeField turns text from the page into the bytes to send.
//
//	string  the text as typed, UTF-8
//	json    the text as typed, after checking that it is JSON — a message that is
//	        meant to be JSON and is not is what a typo looks like from the consumer's side
//	base64  what the text encodes, for bytes that are not text
func decodeField(what, text, encoding string) ([]byte, error) {
	switch encoding {
	case "", "string":
		return []byte(text), nil
	case "json":
		var v any
		if err := json.Unmarshal([]byte(text), &v); err != nil {
			msg := err.Error()
			var syntax *json.SyntaxError
			if errors.As(err, &syntax) {
				msg = fmt.Sprintf("%v, at character %d", syntax, syntax.Offset)
			}
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("The %s is not valid JSON (%s)", what, msg)}
		}
		return []byte(text), nil
	case "base64":
		// Whitespace is allowed: a long value is pasted with line breaks in it.
		clean := strings.Map(func(r rune) rune {
			if r == ' ' || r == '\n' || r == '\r' || r == '\t' {
				return -1
			}
			return r
		}, text)
		b, err := base64.StdEncoding.DecodeString(clean)
		if err != nil {
			// A missing padding is the usual slip.
			if b2, err2 := base64.RawStdEncoding.DecodeString(clean); err2 == nil {
				return b2, nil
			}
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("The %s is not valid base64: %v", what, err)}
		}
		return b, nil
	}
	return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Unknown encoding %q for the %s (string, json or base64)", encoding, what)}
}

// buildRecord checks the page's message and makes the record to send.
func buildRecord(p produceParams) (*kgo.Record, error) {
	if p.Topic == "" {
		return nil, &opError{Code: "EPARAM", Message: "No topic to send to"}
	}
	rec := &kgo.Record{Topic: p.Topic, Partition: -1}
	size := 0
	if p.Key != nil {
		k, err := decodeField("key", *p.Key, p.KeyEncoding)
		if err != nil {
			return nil, err
		}
		rec.Key = k
		size += len(k)
	}
	if p.Value != nil {
		v, err := decodeField("value", *p.Value, p.ValueEncoding)
		if err != nil {
			return nil, err
		}
		if v == nil {
			v = []byte{} // an empty value is a value; only a missing one is a tombstone
		}
		rec.Value = v
		size += len(v)
	}
	if len(p.Headers) > maxHeaders {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("More than %d headers", maxHeaders)}
	}
	for i, h := range p.Headers {
		if h.Key == "" {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Header %d has no name", i+1)}
		}
		if len(h.Key) > maxHeaderKey || !utf8.ValidString(h.Key) {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Header %q: the name is too long or not UTF-8", trimTo(h.Key, 40))}
		}
		v, err := decodeField(fmt.Sprintf("value of header %q", h.Key), h.Value, h.Encoding)
		if err != nil {
			return nil, err
		}
		rec.Headers = append(rec.Headers, kgo.RecordHeader{Key: h.Key, Value: v})
		size += len(h.Key) + len(v)
	}
	if size > maxProduceBytes {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("The message is %s, over the %s this agent sends", formatSize(size), formatSize(maxProduceBytes))}
	}
	return rec, nil
}

func trimTo(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func formatSize(n int) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

// messagesProduce sends one message and answers with where it landed.
//
// A producer of its own for each send, closed after it: a partition chosen by the
// page needs the manual partitioner, an automatic one needs the default, and one
// client cannot be both. A single record does not need the idempotent producer,
// and asking for it would need a permission (IdempotentWrite) that a login allowed
// to write to this topic does not necessarily have.
func messagesProduce(c *opCtx, p produceParams) (any, error) {
	// A value written with a schema becomes the schema's own bytes here, before anything is
	// asked of the cluster: a value that does not fit must not reach the topic (K-45).
	if p.Schema != nil {
		raw, err := serializeForSchema(c, p.Cluster, *p.Schema, "value", p.Value, p.ValueEncoding)
		if err != nil {
			return nil, err
		}
		p.Value, p.ValueEncoding = &raw, "base64"
	}
	if p.KeySchema != nil {
		raw, err := serializeForSchema(c, p.Cluster, *p.KeySchema, "key", p.Key, p.KeyEncoding)
		if err != nil {
			return nil, err
		}
		p.Key, p.KeyEncoding = &raw, "base64"
	}
	rec, err := buildRecord(p)
	if err != nil {
		return nil, err
	}
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	// The topic has to exist, and be one a person writes to. Without this a missing
	// topic is not an error but a wait for one to appear, until the timeout.
	details, err := t.adm.ListTopicsWithInternal(t.ctx, p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	d, ok := details[p.Topic]
	if !ok || d.Err != nil {
		return nil, unknownTopic(p.Topic, d.Err)
	}
	if d.IsInternal {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("%s is an internal topic: the cluster writes to it, nobody else should", p.Topic)}
	}
	if p.Partition != nil {
		if _, ok := d.Partitions[*p.Partition]; !ok {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Topic %s has no partition %d (it has %d)", p.Topic, *p.Partition, len(d.Partitions))}
		}
		rec.Partition = *p.Partition
	}

	opts, oerr := clientOpts(t.cl)
	if oerr != nil {
		return nil, &opError{Code: "ECONFIG", Message: oerr.Error()}
	}
	opts = append(opts,
		kgo.DisableIdempotentWrite(),
		kgo.ProducerBatchMaxBytes(int32(maxProduceBytes+1<<20)),
		kgo.MaxBufferedBytes(2*maxProduceBytes),
	)
	if p.Partition != nil {
		opts = append(opts, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	}
	kc, cerr := kgo.NewClient(opts...)
	if cerr != nil {
		return nil, &opError{Code: "ECONFIG", Message: cerr.Error()}
	}
	defer kc.Close()

	res := kc.ProduceSync(t.ctx, rec)
	if err := res.FirstErr(); err != nil {
		return nil, t.fail(err)
	}
	return produceResult{Partition: rec.Partition, Offset: rec.Offset, Timestamp: rec.Timestamp.UnixMilli()}, nil
}

// topicsDelete deletes a topic, and everything in it.
//
// The page asks the person to type the topic's name, and the agent asks the page to
// say that it did: the name comes back as `confirm`, and a request whose confirmation
// is not the topic is refused, so a call that skipped the dialog — a script, a
// mistake in the page — deletes nothing. Internal topics are never deleted: the
// cluster keeps its offsets and transaction state there.
func topicsDelete(c *opCtx, p deleteTopicParams) (any, error) {
	if p.Topic == "" {
		return nil, &opError{Code: "EPARAM", Message: "No topic to delete"}
	}
	if p.Confirm != p.Topic {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Not deleted: the confirmation %q is not the topic's name %q", trimTo(p.Confirm, 60), trimTo(p.Topic, 60))}
	}
	if strings.HasPrefix(p.Topic, "__") {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("%s is an internal topic: the cluster keeps its own state there, and it is not deleted", p.Topic)}
	}
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	details, err := t.adm.ListTopicsWithInternal(t.ctx, p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	d, ok := details[p.Topic]
	if !ok || d.Err != nil {
		return nil, unknownTopic(p.Topic, d.Err)
	}
	if d.IsInternal {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("%s is an internal topic: the cluster keeps its own state there, and it is not deleted", p.Topic)}
	}
	// What it held, for the answer: once it is gone nobody can say.
	var held int64
	if start, end, err := t.bounds(p.Topic); err == nil {
		for _, part := range d.Partitions.Sorted() {
			held += retained(start, end, p.Topic, part.Partition)
		}
	}

	res, err := t.adm.DeleteTopics(t.ctx, p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	for _, r := range res {
		if r.Err != nil {
			msg := r.Err.Error()
			if r.ErrMessage != "" {
				msg = r.ErrMessage
			}
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The cluster did not delete %s: %s", p.Topic, msg)}
		}
	}
	return deleteTopicResult{Topic: p.Topic, Messages: held}, nil
}
