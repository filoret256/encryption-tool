package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// sptr is a setting's value as the page sends it: null resets the setting.
func sptr(s string) *string { return &s }

// callChunks is one streaming op's batches, for the ops whose answer is what they stream.
func (r *rig) callChunks(op string, params map[string]any) []map[string]any {
	r.t.Helper()
	chunks, _ := r.call(op, params)
	return chunks
}

// configsOf is a topic's settings by name, the effective one where the cluster reports a
// name more than once (a default and the topic's own, as kfake does).
func (r *rig) configsOf(topic string) map[string]map[string]any {
	r.t.Helper()
	out := map[string]map[string]any{}
	for _, e := range r.list("topics.config", map[string]any{"topic": topic}) {
		m := e.(map[string]any)
		out[m["name"].(string)] = m
	}
	return out
}

func (r *rig) valueOf(topic, setting string) (string, bool) {
	r.t.Helper()
	e, ok := r.configsOf(topic)[setting]
	if !ok || e["value"] == nil {
		return "", false
	}
	return e["value"].(string), true
}

func (r *rig) partitionsOf(topic string) int {
	r.t.Helper()
	return len(r.data("topics.describe", map[string]any{"topic": topic})["partitions"].([]any))
}

// boundsOf is where one partition of a topic starts and ends, from topics.describe.
func (r *rig) boundsOf(topic string, partition int) (start, end int64) {
	r.t.Helper()
	for _, p := range r.data("topics.describe", map[string]any{"topic": topic})["partitions"].([]any) {
		m := p.(map[string]any)
		if int(m["id"].(float64)) == partition {
			return int64(m["start"].(float64)), int64(m["end"].(float64))
		}
	}
	r.t.Fatalf("topic %s has no partition %d", topic, partition)
	return 0, 0
}

// ── topics.alterConfigs ───────────────────────────────────────────────────

func TestAlterConfigsPreviewsTheDifferenceThenApplies(t *testing.T) {
	r := newRig(t)
	r.writable()
	r.data("topics.create", map[string]any{"topic": "tuned", "partitions": 1, "replicationFactor": 1,
		"configs": map[string]string{"retention.ms": "60000"}})

	// A preview says what would change, and changes nothing.
	p := map[string]any{"topic": "tuned", "dryRun": true, "configs": map[string]*string{"retention.ms": sptr("120000"), "cleanup.policy": sptr("compact")}}
	d := r.data("topics.alterConfigs", p)
	if d["applied"] != false {
		t.Fatalf("a preview applied: %v", d)
	}
	rows := rowsOf(d)
	if len(rows) != 2 {
		t.Fatalf("rows: %v", rows)
	}
	byName := map[string]map[string]any{}
	for _, row := range rows {
		byName[row["name"].(string)] = row
	}
	if row := byName["retention.ms"]; row["after"] != "120000" || row["before"] != "60000" || row["fromDefault"] != false {
		t.Fatalf("the row for retention.ms: %v", row)
	}
	// cleanup.policy was only the cluster's default, so what it is now is the default.
	if row := byName["cleanup.policy"]; row["after"] != "compact" || row["fromDefault"] != true {
		t.Fatalf("the row for cleanup.policy: %v", row)
	}
	if v, _ := r.valueOf("tuned", "retention.ms"); v != "60000" {
		t.Fatalf("the preview changed retention.ms to %q", v)
	}

	// Applying does what the preview said.
	p["dryRun"] = false
	if d := r.data("topics.alterConfigs", p); d["applied"] != true || len(rowsOf(d)) != 2 {
		t.Fatalf("apply: %v", d)
	}
	if v, _ := r.valueOf("tuned", "retention.ms"); v != "120000" {
		t.Fatalf("retention.ms after applying: %q", v)
	}
	if v, _ := r.valueOf("tuned", "cleanup.policy"); v != "compact" {
		t.Fatalf("cleanup.policy after applying: %q", v)
	}
	if e := r.configsOf("tuned")["cleanup.policy"]; e["isDefault"] != false || e["source"] != "topic" {
		t.Fatalf("cleanup.policy should be the topic's own now: %v", e)
	}

	// The same value again is not a change.
	d = r.data("topics.alterConfigs", map[string]any{"topic": "tuned", "dryRun": true, "configs": map[string]*string{"retention.ms": sptr("120000")}})
	if len(rowsOf(d)) != 0 {
		t.Fatalf("%v, want no change", rowsOf(d))
	}

	// A null resets a setting to the cluster's default — the side the page has no field for.
	d = r.data("topics.alterConfigs", map[string]any{"topic": "tuned", "dryRun": true, "configs": map[string]*string{"retention.ms": nil}})
	row := rowsOf(d)[0]
	if row["before"] != "120000" || row["after"] != nil || row["fromDefault"] != false {
		t.Fatalf("resetting retention.ms: %v", row)
	}
	r.data("topics.alterConfigs", map[string]any{"topic": "tuned", "configs": map[string]*string{"retention.ms": nil}})
	if e := r.configsOf("tuned")["retention.ms"]; e["isDefault"] != true {
		t.Fatalf("retention.ms should be back to the cluster's default: %v", e)
	}
	// And a setting that was never set is left exactly as it is by a reset of it.
	r.data("topics.alterConfigs", map[string]any{"topic": "tuned", "configs": map[string]*string{"retention.ms": nil}})
}

func TestAlterConfigsRefusesWhatItCannotDo(t *testing.T) {
	r := newRig(t)
	// Read-only first: nothing is asked of the cluster, and no client is made.
	r.fails("topics.alterConfigs", map[string]any{"topic": "orders", "configs": map[string]*string{"retention.ms": sptr("1")}}, "READ_ONLY", `"dev"`)

	r.writable()
	r.fails("topics.alterConfigs", map[string]any{"topic": "orders", "configs": map[string]*string{}}, "EPARAM", "No setting")
	r.fails("topics.alterConfigs", map[string]any{"topic": "orders"}, "EPARAM", "No setting")
	r.fails("topics.alterConfigs", map[string]any{"topic": "orders", "configs": map[string]*string{"retention ms": sptr("1")}}, "EPARAM", "not a setting name")
	r.fails("topics.alterConfigs", map[string]any{"topic": "orders", "configs": map[string]*string{"retention.ms": sptr(strings.Repeat("9", maxConfigValue+1))}}, "EPARAM", "longer than")
	r.fails("topics.alterConfigs", map[string]any{"topic": "no-such", "configs": map[string]*string{"retention.ms": sptr("1")}}, "EKAFKA", "Unknown topic")
	r.fails("topics.alterConfigs", map[string]any{"topic": "__consumer_offsets", "configs": map[string]*string{"retention.ms": sptr("1")}}, "EPARAM", "two underscores")
	r.fails("topics.alterConfigs", map[string]any{"topic": "", "configs": map[string]*string{"retention.ms": sptr("1")}}, "EPARAM")
	if v, ok := r.valueOf("orders", "retention.ms"); ok && v == "1" {
		t.Fatal("a refused alteration was applied")
	}
}

// ── topics.addPartitions ──────────────────────────────────────────────────

func TestAddPartitionsValidatesThenAdds(t *testing.T) {
	r := newRig(t)
	r.fails("topics.addPartitions", map[string]any{"topic": "orders", "partitions": 6}, "READ_ONLY", `"dev"`)
	r.writable()

	v := r.data("topics.addPartitions", map[string]any{"topic": "orders", "partitions": 6, "validateOnly": true})
	if v["added"] != false || v["from"].(float64) != 3 || v["to"].(float64) != 6 {
		t.Fatalf("a validation: %v", v)
	}
	if n := r.partitionsOf("orders"); n != 3 {
		t.Fatalf("a validation added partitions: %d", n)
	}

	a := r.data("topics.addPartitions", map[string]any{"topic": "orders", "partitions": 6})
	if a["added"] != true {
		t.Fatalf("adding: %v", a)
	}
	eventually(t, "orders to have 6 partitions", func() bool { return r.partitionsOf("orders") == 6 })
	if n := r.partitionsOf("logs"); n != 1 {
		t.Fatalf("another topic's partitions changed: %d", n)
	}
}

func TestAddPartitionsRefusesWhatKafkaCannotDo(t *testing.T) {
	r := newRig(t)
	r.writable()
	r.fails("topics.addPartitions", map[string]any{"topic": "orders", "partitions": 3}, "EPARAM", "already")
	r.fails("topics.addPartitions", map[string]any{"topic": "orders", "partitions": 2}, "EPARAM", "does not remove")
	r.fails("topics.addPartitions", map[string]any{"topic": "orders", "partitions": 0}, "EPARAM", "1 to")
	r.fails("topics.addPartitions", map[string]any{"topic": "orders", "partitions": maxPartitions + 1}, "EPARAM", "1 to")
	r.fails("topics.addPartitions", map[string]any{"topic": ""}, "EPARAM", "No topic")
	r.fails("topics.addPartitions", map[string]any{"topic": "__consumer_offsets", "partitions": 4}, "EPARAM", "internal")
	r.fails("topics.addPartitions", map[string]any{"topic": "no-such", "partitions": 4}, "EKAFKA", "Unknown topic")
	if n := r.partitionsOf("orders"); n != 3 {
		t.Fatalf("a refused change moved the partitions: %d", n)
	}
}

// ── topics.deleteRecords ──────────────────────────────────────────────────

func TestDeleteRecordsTruncatesOnePartitionAfterConfirmingTheTopic(t *testing.T) {
	r := newRig(t)
	seedOrders(r) // 30 messages: 10 in each of three partitions
	r.fails("topics.deleteRecords", map[string]any{"topic": "orders", "partition": 0, "offset": 4, "confirm": "orders"}, "READ_ONLY", `"dev"`)
	r.writable()

	r.fails("topics.deleteRecords", map[string]any{"topic": "orders", "partition": 0, "offset": 4}, "EPARAM", "confirmation")
	r.fails("topics.deleteRecords", map[string]any{"topic": "orders", "partition": 0, "offset": 4, "confirm": "Orders"}, "EPARAM", "confirmation")
	if s, _ := r.boundsOf("orders", 0); s != 0 {
		t.Fatalf("a refused truncation moved the start offset to %d", s)
	}

	d := r.data("topics.deleteRecords", map[string]any{"topic": "orders", "partition": 0, "offset": 4, "confirm": "orders"})
	if d["before"].(float64) != 0 || d["after"].(float64) != 4 || d["deleted"].(float64) != 4 {
		t.Fatalf("the answer: %v", d)
	}
	if s, e := r.boundsOf("orders", 0); s != 4 || e != 10 {
		t.Fatalf("partition 0 holds %d-%d, want 4-10", s, e)
	}
	if s, _ := r.boundsOf("orders", 1); s != 0 {
		t.Fatalf("another partition was truncated too: it starts at %d", s)
	}
	// What is gone is gone: a read from the start begins after it.
	msgs := messages(r.callChunks("messages.consume", map[string]any{"topic": "orders", "partitions": []int{0}, "from": "start", "limit": 100}))
	if len(msgs) != 6 || msgs[0]["offset"].(float64) != 4 {
		t.Fatalf("after the truncation partition 0 reads %d messages from offset %v", len(msgs), msgs[0]["offset"])
	}

	// -1 is Kafka's own "all of them".
	d = r.data("topics.deleteRecords", map[string]any{"topic": "orders", "partition": 0, "offset": -1, "confirm": "orders"})
	if d["after"].(float64) != 10 || d["deleted"].(float64) != 6 {
		t.Fatalf("deleting everything in partition 0: %v", d)
	}
	if msgs := messages(r.callChunks("messages.consume", map[string]any{"topic": "orders", "partitions": []int{0}, "from": "start", "limit": 100})); len(msgs) != 0 {
		t.Fatalf("%d messages left in an emptied partition", len(msgs))
	}
	if n := r.count("orders"); n != 20 { // the other two partitions are untouched
		t.Fatalf("the topic holds %d messages, want 20", n)
	}

	// The line cannot be drawn past the end, and it is only drawn for a topic named twice.
	r.fails("topics.deleteRecords", map[string]any{"topic": "orders", "partition": 0, "offset": 11, "confirm": "orders"}, "EPARAM", "past its end")
	r.fails("topics.deleteRecords", map[string]any{"topic": "orders", "partition": 0, "offset": -2, "confirm": "orders"}, "EPARAM", "0 or more")
	r.fails("topics.deleteRecords", map[string]any{"topic": "orders", "partition": 9, "offset": 1, "confirm": "orders"}, "EPARAM", "no partition 9")
	r.fails("topics.deleteRecords", map[string]any{"topic": "no-such", "partition": 0, "offset": 1, "confirm": "no-such"}, "EKAFKA", "Unknown topic")
	r.fails("topics.deleteRecords", map[string]any{"topic": "__consumer_offsets", "partition": 0, "offset": 1, "confirm": "__consumer_offsets"}, "EPARAM", "internal")
	r.fails("topics.deleteRecords", map[string]any{"topic": "", "partition": 0, "offset": 1}, "EPARAM")
}

// ── groups.delete ─────────────────────────────────────────────────────────

func (r *rig) groupNames() map[string]bool {
	r.t.Helper()
	out := map[string]bool{}
	for _, g := range r.list("groups.list", nil) {
		out[g.(map[string]any)["name"].(string)] = true
	}
	return out
}

func TestDeleteAGroupOnlyWhenItsNameIsConfirmed(t *testing.T) {
	r := newRig(t)
	seedOrders(r)
	r.commitGroup("billing", "orders", false) // an Empty group with commits on three partitions
	r.fails("groups.delete", map[string]any{"group": "billing", "confirm": "billing"}, "READ_ONLY", `"dev"`)
	r.writable()

	r.fails("groups.delete", map[string]any{"group": "billing"}, "EPARAM", "confirmation")
	r.fails("groups.delete", map[string]any{"group": "billing", "confirm": "Billing"}, "EPARAM", "confirmation")
	r.fails("groups.delete", map[string]any{"group": "billing", "confirm": "orders"}, "EPARAM", "confirmation")
	if !r.groupNames()["billing"] {
		t.Fatal("a refused delete removed the group")
	}

	d := r.data("groups.delete", map[string]any{"group": "billing", "confirm": "billing"})
	if d["group"] != "billing" || d["offsets"].(float64) != 3 {
		t.Fatalf("the answer: %v", d)
	}
	eventually(t, "billing to leave the group list", func() bool { return !r.groupNames()["billing"] })
	r.fails("groups.delete", map[string]any{"group": "billing", "confirm": "billing"}, "EKAFKA", "Unknown group")
}

func TestDeleteARunningGroupIsRefusedWithItsMembers(t *testing.T) {
	r := newRig(t)
	seedOrders(r)
	r.commitGroup("live", "orders", true) // still a member
	r.writable()

	r.fails("groups.delete", map[string]any{"group": "live", "confirm": "live"}, "EGROUPACTIVE", `"live"`, "live-1", "stop its consumers")
	r.fails("groups.delete", map[string]any{"group": "nobody", "confirm": "nobody"}, "EKAFKA", "Unknown group")
	if !r.groupNames()["live"] {
		t.Fatal("a refused delete removed a running group")
	}
}

// joinAndLeave has a consumer join a group and go away without committing anything: a
// group that exists with no offsets in it, which is what a reset before the first run of a
// consumer is for.
func (r *rig) joinAndLeave(group, topic string) {
	r.t.Helper()
	member, err := kgo.NewClient(kgo.SeedBrokers(r.addr), kgo.ConsumerGroup(group), kgo.ConsumeTopics(topic),
		kgo.DisableAutoCommit(), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	if err != nil {
		r.t.Fatal(err)
	}
	// A fetch with nothing on the topic can wait for its deadline: what this needs is the
	// join, which has happened by then, and the leave that Close() performs.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	member.PollFetches(ctx) // joins the group, reads, commits nothing
	member.Close()
	eventually(r.t, group+" to be Empty", func() bool {
		for _, g := range r.list("groups.list", nil) {
			if m := g.(map[string]any); m["name"] == group {
				return m["state"] == "Empty"
			}
		}
		return false
	})
}

// A group that joined and left without committing anything is still a group, and can be
// deleted; nothing goes with it.
func TestDeleteAGroupThatNeverCommitted(t *testing.T) {
	r := newRig(t)
	seedOrders(r)
	r.joinAndLeave("silent", "orders")

	r.writable()
	d := r.data("groups.delete", map[string]any{"group": "silent", "confirm": "silent"})
	if d["offsets"].(float64) != 0 {
		t.Fatalf("offsets of a group that committed nothing: %v", d)
	}
	eventually(t, "silent to leave the group list", func() bool { return !r.groupNames()["silent"] })
}

// The other half of that: a group with no commits can be given a starting position, which
// is what somebody wants before a consumer's very first run. Its rows have no "was", the
// commit that follows is a real one, and the group is where it was put.
func TestResetOffsetsOfAGroupThatNeverCommitted(t *testing.T) {
	r := newRig(t)
	seedOrders(r) // 30 messages: 10 in each of three partitions
	r.joinAndLeave("fresh", "orders")
	r.writable()

	d := r.data("groups.reset", map[string]any{"group": "fresh", "topic": "orders", "to": "earliest", "dryRun": true})
	rows := rowsOf(d)
	if len(rows) != 3 {
		t.Fatalf("a preview over three partitions: %v", rows)
	}
	for _, row := range rows {
		if row["before"] != nil || row["after"].(float64) != 0 {
			t.Fatalf("a group that committed nothing: %v", row)
		}
	}
	if n := len(r.positions("fresh")); n != 0 {
		t.Fatalf("a preview committed %d offsets", n)
	}

	if d := r.data("groups.reset", map[string]any{"group": "fresh", "topic": "orders", "to": "offset", "offset": 4}); d["applied"] != true {
		t.Fatalf("apply: %v", d)
	}
	if got := r.positions("fresh"); got[0] != 4 || got[1] != 4 || got[2] != 4 {
		t.Fatalf("the group is at %v, want offset 4 everywhere", got)
	}
	if lag := r.totalLag("fresh"); lag != 18 {
		t.Fatalf("lag after offset 4 in three partitions of ten: %v, want 18", lag)
	}
}

// Hundreds of partitions: the preview and the commit have to answer about every one of
// them, and answer in a moment rather than a minute.
func TestResetOffsetsOverManyPartitions(t *testing.T) {
	r := newRig(t)
	r.writable()
	r.data("topics.create", map[string]any{"topic": "wide", "partitions": 300, "replicationFactor": 1})
	eventually(t, "wide to have 300 partitions", func() bool { return r.partitionsOf("wide") == 300 })
	r.joinAndLeave("wide-group", "wide")

	started := time.Now()
	d := r.data("groups.reset", map[string]any{"group": "wide-group", "topic": "wide", "to": "offset", "offset": 0, "dryRun": true})
	preview := time.Since(started)
	if n := len(rowsOf(d)); n != 300 {
		t.Fatalf("%d rows for a topic of 300 partitions", n)
	}
	if preview > 5*time.Second {
		t.Errorf("the preview took %s for 300 partitions", preview)
	}

	started = time.Now()
	a := r.data("groups.reset", map[string]any{"group": "wide-group", "topic": "wide", "to": "offset", "offset": 0})
	applied := time.Since(started)
	if a["applied"] != true || len(rowsOf(a)) != 300 {
		t.Fatalf("applying over 300 partitions: %v rows", len(rowsOf(a)))
	}
	if applied > 10*time.Second {
		t.Errorf("the commit took %s for 300 partitions", applied)
	}
	t.Logf("300 partitions: preview %s, commit %s", preview.Round(time.Millisecond), applied.Round(time.Millisecond))
	if n := len(r.positions("wide-group")); n != 300 {
		t.Fatalf("%d partitions are committed, want 300", n)
	}
}
