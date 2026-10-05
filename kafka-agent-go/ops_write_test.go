package main

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/twmb/franz-go/pkg/kgo"
)

func kgoRecord(topic, value string) *kgo.Record {
	return &kgo.Record{Topic: topic, Value: []byte(value), Partition: 0}
}

func mustB64(t *testing.T, v any) []byte {
	t.Helper()
	s, ok := v.(string)
	if !ok {
		t.Fatalf("not a base64 string: %v", v)
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func (r *rig) writable() {
	r.t.Helper()
	cl, err := r.s.cluster("dev")
	if err != nil {
		r.t.Fatal(err)
	}
	cp := *cl
	cp.ReadOnly = false
	r.s.setClusters([]*cluster{&cp})
}

func (r *rig) count(topic string) int {
	r.t.Helper()
	for _, t := range r.list("topics.list", nil) {
		if m := t.(map[string]any); m["name"] == topic {
			return int(m["messages"].(float64))
		}
	}
	return -1
}

func TestWritesAreRefusedOnAReadOnlyClusterAndNothingIsWritten(t *testing.T) {
	r := newRig(t) // read-only, as configured by default
	r.fails("messages.produce", map[string]any{"topic": "logs", "value": "x"}, "READ_ONLY", `"dev"`)
	r.fails("topics.delete", map[string]any{"topic": "logs", "confirm": "logs"}, "READ_ONLY", `"dev"`)
	if n := r.count("logs"); n != 0 {
		t.Fatalf("the refused produce wrote %d messages", n)
	}
	if len(r.list("topics.list", nil)) < 2 {
		t.Fatal("the refused delete removed a topic")
	}
}

func TestProduceThenReadItBack(t *testing.T) {
	r := newRig(t)
	r.writable()

	got := r.data("messages.produce", map[string]any{
		"topic": "logs", "partition": 0,
		"key": "k1", "value": "hello",
		"headers": []map[string]any{{"key": "source", "value": "test"}, {"key": "raw", "value": "AAH/", "encoding": "base64"}},
	})
	if got["partition"].(float64) != 0 || got["offset"].(float64) != 0 || got["timestamp"].(float64) <= 0 {
		t.Fatalf("where it landed: %v", got)
	}
	m := r.data("messages.get", map[string]any{"topic": "logs", "partition": 0, "offset": 0})
	if decoded(m["key"]) != "k1" || decoded(m["value"]) != "hello" {
		t.Fatalf("read back: %v", m)
	}
	headers, _ := m["headers"].([]any)
	if len(headers) != 2 {
		t.Fatalf("headers: %v", m["headers"])
	}
	h1 := headers[1].(map[string]any)
	if h1["key"] != "raw" || h1["value"] != "AAH/" { // the bytes 00 01 ff, as base64 again
		t.Fatalf("a base64 header should arrive as the bytes it encodes: %v", h1)
	}
}

func TestProduceEncodings(t *testing.T) {
	r := newRig(t)
	r.writable()
	send := func(p map[string]any) map[string]any {
		p["topic"], p["partition"] = "logs", 0
		got := r.data("messages.produce", p)
		return r.data("messages.get", map[string]any{"topic": "logs", "partition": 0, "offset": int(got["offset"].(float64))})
	}

	if m := send(map[string]any{"value": `{"a": 1}`, "valueEncoding": "json"}); decoded(m["value"]) != `{"a": 1}` {
		t.Errorf("json is sent as typed: %v", m)
	}
	if m := send(map[string]any{"value": "AAH/gA==", "valueEncoding": "base64"}); string(mustB64(t, m["value"])) != "\x00\x01\xff\x80" {
		t.Errorf("base64 is sent as the bytes it encodes: %v", m)
	}
	// Line breaks and a missing pad are what a pasted value has.
	if m := send(map[string]any{"value": "aGVs\nbG8", "valueEncoding": "base64"}); decoded(m["value"]) != "hello" {
		t.Errorf("pasted base64: %v", m)
	}
	if m := send(map[string]any{"value": "héllo ✓"}); decoded(m["value"]) != "héllo ✓" {
		t.Errorf("UTF-8 text: %v", m)
	}
	// An empty value is a value; only a missing one is a tombstone, and only a missing key is no key.
	if m := send(map[string]any{"value": ""}); m["value"] == nil || m["valueSize"].(float64) != 0 {
		t.Errorf("an empty value is not a tombstone: %v", m)
	}
	if m := send(map[string]any{"key": "gone", "value": nil}); m["value"] != nil || decoded(m["key"]) != "gone" {
		t.Errorf("a tombstone: %v", m)
	}
	if m := send(map[string]any{"value": "no key"}); m["key"] != nil {
		t.Errorf("no key was asked for: %v", m)
	}
}

func TestProduceChoosesAPartitionOrTheClusterDoes(t *testing.T) {
	r := newRig(t)
	r.writable()
	got := r.data("messages.produce", map[string]any{"topic": "orders", "partition": 2, "value": "x"})
	if got["partition"].(float64) != 2 {
		t.Fatalf("an explicit partition: %v", got)
	}
	// The same key always lands in the same partition.
	first := r.data("messages.produce", map[string]any{"topic": "orders", "key": "customer-7", "value": "a"})["partition"]
	for i := 0; i < 5; i++ {
		if again := r.data("messages.produce", map[string]any{"topic": "orders", "key": "customer-7", "value": "b"})["partition"]; again != first {
			t.Fatalf("key customer-7 went to partition %v, then %v", first, again)
		}
	}
	r.fails("messages.produce", map[string]any{"topic": "orders", "partition": 3, "value": "x"}, "EPARAM", "no partition 3", "has 3")
	r.fails("messages.produce", map[string]any{"topic": "orders", "partition": -1, "value": "x"}, "EPARAM", "no partition")
}

func TestProduceRefusesWhatIsNotAMessageOrNotATopic(t *testing.T) {
	r := newRig(t)
	r.writable()
	r.fails("messages.produce", map[string]any{"topic": "logs", "value": "{oops", "valueEncoding": "json"}, "EPARAM", "not valid JSON", "value")
	r.fails("messages.produce", map[string]any{"topic": "logs", "key": "{", "keyEncoding": "json", "value": "x"}, "EPARAM", "key")
	r.fails("messages.produce", map[string]any{"topic": "logs", "value": "@@@", "valueEncoding": "base64"}, "EPARAM", "base64")
	r.fails("messages.produce", map[string]any{"topic": "logs", "value": "x", "valueEncoding": "hex"}, "EPARAM", "Unknown encoding")
	r.fails("messages.produce", map[string]any{"topic": "logs", "value": "x", "headers": []map[string]any{{"key": "", "value": "v"}}}, "EPARAM", "no name")
	r.fails("messages.produce", map[string]any{"topic": "logs", "value": "x", "headers": []map[string]any{{"key": "h", "value": "!", "encoding": "base64"}}}, "EPARAM", `header "h"`)
	r.fails("messages.produce", map[string]any{"topic": "", "value": "x"}, "EPARAM", "No topic")
	r.fails("messages.produce", map[string]any{"topic": "no-such-topic", "value": "x"}, "EKAFKA", "Unknown topic")
	r.fails("messages.produce", map[string]any{"topic": "logs", "value": strings.Repeat("x", maxProduceBytes+1)}, "EPARAM", "over the")
	if n := r.count("logs"); n != 0 {
		t.Fatalf("refused messages were written: %d", n)
	}
}

func TestDeleteATopicOnlyWhenItsNameIsConfirmed(t *testing.T) {
	r := newRig(t)
	r.writable()
	r.produce(kgoRecord("logs", "a"), kgoRecord("logs", "b"), kgoRecord("logs", "c"))

	r.fails("topics.delete", map[string]any{"topic": "logs"}, "EPARAM", "confirmation")
	r.fails("topics.delete", map[string]any{"topic": "logs", "confirm": "Logs"}, "EPARAM", "confirmation")
	r.fails("topics.delete", map[string]any{"topic": "logs", "confirm": "orders"}, "EPARAM", "confirmation")
	if n := r.count("logs"); n != 3 {
		t.Fatalf("a refused delete touched the topic: %d messages left", n)
	}

	got := r.data("topics.delete", map[string]any{"topic": "logs", "confirm": "logs"})
	if got["topic"] != "logs" || got["messages"].(float64) != 3 {
		t.Fatalf("what the answer says: %v", got)
	}
	// A deleted topic goes from the listing a moment later, on a real cluster as on the fake one.
	eventually(t, "logs to leave the topic list", func() bool { return r.count("logs") == -1 })
	if n := r.count("orders"); n != 0 {
		t.Fatalf("another topic went with it: %d", n)
	}
	r.fails("topics.delete", map[string]any{"topic": "logs", "confirm": "logs"}, "EKAFKA", "Unknown topic")
}

func TestInternalTopicsAreNeverDeleted(t *testing.T) {
	r := newRig(t)
	r.writable()
	r.fails("topics.delete", map[string]any{"topic": "__consumer_offsets", "confirm": "__consumer_offsets"}, "EPARAM", "internal")
	r.fails("topics.delete", map[string]any{"topic": "__transaction_state", "confirm": "__transaction_state"}, "EPARAM", "internal")
}

// The cluster's own topics are the ones a double underscore names, and the ones the
// cluster's metadata calls internal. The second is the branch a real cluster takes for its
// state topics; kfake makes such a topic through a setting of its own, whose name has no
// underscores at all — so only the metadata says what the topic is.
func TestAnInternalTopicIsRefusedByEveryWrite(t *testing.T) {
	r := newRig(t)
	r.writable()
	r.data("topics.create", map[string]any{"topic": "cluster-own", "partitions": 1, "replicationFactor": 1,
		"configs": map[string]string{"kfake.is_internal": "true"}})
	eventually(t, "cluster-own to be listed", func() bool { return r.topicNames()["cluster-own"] })

	internal := false
	for _, x := range r.list("topics.list", nil) {
		if m := x.(map[string]any); m["name"] == "cluster-own" {
			internal = m["internal"] == true
		}
	}
	if !internal {
		t.Fatal("the cluster did not call the topic internal — the checks below would prove nothing")
	}

	for _, c := range []struct {
		op     string
		params map[string]any
	}{
		{"messages.produce", map[string]any{"topic": "cluster-own", "value": "x"}},
		{"topics.alterConfigs", map[string]any{"topic": "cluster-own", "configs": map[string]*string{"retention.ms": sptr("1")}}},
		{"topics.addPartitions", map[string]any{"topic": "cluster-own", "partitions": 2}},
		{"topics.deleteRecords", map[string]any{"topic": "cluster-own", "partition": 0, "offset": 1, "confirm": "cluster-own"}},
		{"topics.delete", map[string]any{"topic": "cluster-own", "confirm": "cluster-own"}},
	} {
		r.fails(c.op, c.params, "EPARAM", "internal")
	}
	// A refused write leaves it exactly as it was.
	if n := r.count("cluster-own"); n != 0 {
		t.Fatalf("%d messages landed in an internal topic", n)
	}
	if !r.topicNames()["cluster-own"] {
		t.Fatal("a write to an internal topic changed or removed it")
	}
	if n := r.partitionsOf("cluster-own"); n != 1 {
		t.Fatalf("its partitions were changed: %d", n)
	}
}

// What the cluster refuses with has to arrive as a sentence: the page shows the agent's
// words as they are, and a message over the topic's own max.message.bytes is the case a
// person meets most often. Nothing else may change on the way — the topic keeps what it
// held, and the next message that fits is accepted.
//
// The value below is random base64 on purpose. A producing client compresses by default
// (franz-go prefers snappy), and kfake measures the batch as it arrives on the wire, so a
// value that compresses well slips under the limit here; a real broker measures the batch
// itself and refuses that same message (checked on the stand, in kafka-agent:smoke).
func TestProduceRefusesAMessageOverTheTopicLimit(t *testing.T) {
	r := newRig(t)
	r.writable()
	r.data("topics.create", map[string]any{"topic": "small", "partitions": 1, "replicationFactor": 1,
		"configs": map[string]string{"max.message.bytes": "1000"}})
	eventually(t, "small to be listed", func() bool { return r.topicNames()["small"] })
	// The limit has to be the topic's own, or this test would prove nothing.
	if v, _ := r.valueOf("small", "max.message.bytes"); v != "1000" {
		t.Fatalf("the topic's max.message.bytes is %q, want 1000", v)
	}

	r.data("messages.produce", map[string]any{"topic": "small", "partition": 0, "value": strings.Repeat("x", 100)})

	seed := uint64(0x2545F4914F6CDD1D)
	noise := make([]byte, 3000)
	for i := range noise {
		seed ^= seed << 13
		seed ^= seed >> 7
		seed ^= seed << 17
		noise[i] = byte(seed)
	}
	big := base64.StdEncoding.EncodeToString(noise) // ~4 kB of text that does not compress
	_, m := r.call("messages.produce", map[string]any{"topic": "small", "value": big})
	if m["ok"] == true || m["code"] != "EKAFKA" {
		t.Fatalf("a message over the topic's limit: %v", m)
	}
	msg, _ := m["error"].(string)
	if !strings.Contains(strings.ToLower(msg), "too large") && !strings.Contains(strings.ToLower(msg), "larger than") {
		t.Errorf("the cluster's refusal should say the message is too large: %q", msg)
	}
	if n := r.count("small"); n != 1 {
		t.Fatalf("the topic holds %d messages, want the one that fitted", n)
	}
	r.data("messages.produce", map[string]any{"topic": "small", "partition": 0, "value": strings.Repeat("y", 100)})
	if n := r.count("small"); n != 2 {
		t.Fatalf("the topic holds %d messages; a refused one stopped the next", n)
	}
}
