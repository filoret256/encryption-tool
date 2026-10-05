package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/kmsg"
)

// ── groups.delete ─────────────────────────────────────────────────────────

// What a real broker says about a group it has never heard of — the state "Dead", no
// error — and what kfake says — GroupIDNotFound — both mean the same thing. A group of
// somebody's is neither.
func TestAGroupTheClusterDoesNotKnowIsUnknown(t *testing.T) {
	for _, c := range []struct {
		what string
		g    kadm.DescribedGroup
		want bool
	}{
		{"kfake's answer", kadm.DescribedGroup{Group: "x", Err: kerr.GroupIDNotFound}, true},
		{"a real broker's answer", kadm.DescribedGroup{Group: "x", State: "Dead"}, true},
		{"a state it did not fill in", kadm.DescribedGroup{Group: "x"}, true},
		{"an empty group", kadm.DescribedGroup{Group: "x", State: "Empty"}, false},
		{"a group with a member", kadm.DescribedGroup{Group: "x", State: "Stable", Members: []kadm.DescribedGroupMember{{ClientID: "c"}}}, false},
	} {
		if got := groupMissing(c.g); got != c.want {
			t.Errorf("%s: groupMissing(%+v) = %v, want %v", c.what, c.g, got, c.want)
		}
	}
}

func (r *rig) topicNames() map[string]bool {
	r.t.Helper()
	out := map[string]bool{}
	for _, t := range r.list("topics.list", nil) {
		out[t.(map[string]any)["name"].(string)] = true
	}
	return out
}

// ── topics.create ─────────────────────────────────────────────────────────

func TestCreateATopicAfterValidatingIt(t *testing.T) {
	r := newRig(t)
	r.writable()
	params := func(validate bool) map[string]any {
		return map[string]any{"topic": "invoices", "partitions": 4, "replicationFactor": 1, "validateOnly": validate,
			"configs": map[string]string{"retention.ms": "3600000", "cleanup.policy": "compact"}}
	}

	v := r.data("topics.create", params(true))
	if v["created"] != false || v["topic"] != "invoices" || v["partitions"].(float64) != 4 {
		t.Fatalf("a validation: %v", v)
	}
	if r.topicNames()["invoices"] {
		t.Fatal("a validation created the topic")
	}

	c := r.data("topics.create", params(false))
	if c["created"] != true {
		t.Fatalf("creation: %v", c)
	}
	eventually(t, "invoices to be listed", func() bool { return r.topicNames()["invoices"] })
	d := r.data("topics.describe", map[string]any{"topic": "invoices"})
	if n := len(d["partitions"].([]any)); n != 4 {
		t.Fatalf("%d partitions, want 4", n)
	}
	// The settings arrive on the topic.
	var got = map[string]string{}
	for _, e := range r.list("topics.config", map[string]any{"topic": "invoices"}) {
		m := e.(map[string]any)
		if m["value"] != nil {
			got[m["name"].(string)] = m["value"].(string)
		}
	}
	if got["retention.ms"] != "3600000" || got["cleanup.policy"] != "compact" {
		t.Errorf("settings on the new topic: retention.ms=%q cleanup.policy=%q", got["retention.ms"], got["cleanup.policy"])
	}

	r.fails("topics.create", params(false), "EKAFKA", "already exists")
	r.fails("topics.create", params(true), "EKAFKA", "already exists")
}

func TestCreateRefusesWhatIsNotATopicOrNotSaneSettings(t *testing.T) {
	r := newRig(t)
	r.writable()
	ok := func(over map[string]any) map[string]any {
		p := map[string]any{"topic": "fine", "partitions": 1, "replicationFactor": 1}
		for k, v := range over {
			p[k] = v
		}
		return p
	}
	for name, p := range map[string]map[string]any{
		"no name":            ok(map[string]any{"topic": ""}),
		"dot":                ok(map[string]any{"topic": ".."}),
		"a space":            ok(map[string]any{"topic": "a b"}),
		"a slash":            ok(map[string]any{"topic": "a/b"}),
		"the cluster's own":  ok(map[string]any{"topic": "__mine"}),
		"too long":           ok(map[string]any{"topic": strings.Repeat("a", 250)}),
		"no partitions":      ok(map[string]any{"partitions": 0}),
		"too many":           ok(map[string]any{"partitions": maxPartitions + 1}),
		"no replicas":        ok(map[string]any{"replicationFactor": 0}),
		"a bad setting name": ok(map[string]any{"configs": map[string]string{"retention ms": "1"}}),
	} {
		_, m := r.call("topics.create", p)
		if m["ok"] == true || m["code"] != "EPARAM" {
			t.Errorf("%s: %v, want EPARAM", name, m)
		}
	}
	// What the agent lets through, the cluster judges: here, more replicas than brokers. (A setting
	// that does not exist is refused by a real Kafka, and taken by the fake one, so it is not tried.)
	r.fails("topics.create", ok(map[string]any{"topic": "wide", "replicationFactor": 5}), "EKAFKA")
	if names := r.topicNames(); names["wide"] || names["fine"] {
		t.Fatalf("a refused create left a topic behind: %v", names)
	}
}

// ── groups.reset ──────────────────────────────────────────────────────────

// commitGroup has a group read a topic to its end and commit, and then leave — which is
// what makes it Empty, the state a reset needs.
func (r *rig) commitGroup(group, topic string, keep bool) *kgo.Client {
	r.t.Helper()
	member, err := kgo.NewClient(kgo.SeedBrokers(r.addr), kgo.ConsumerGroup(group), kgo.ConsumeTopics(topic),
		kgo.DisableAutoCommit(), kgo.ClientID(group+"-1"), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	if err != nil {
		r.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	want := r.count(topic)
	var read []*kgo.Record
	for len(read) < want {
		member.PollFetches(ctx).EachRecord(func(rec *kgo.Record) { read = append(read, rec) })
		if ctx.Err() != nil {
			r.t.Fatalf("the group read %d of %d", len(read), want)
		}
	}
	if err := member.CommitRecords(ctx, read...); err != nil {
		r.t.Fatal(err)
	}
	if keep {
		r.t.Cleanup(member.Close)
		return member
	}
	member.Close()
	eventually(r.t, group+" to be Empty", func() bool {
		for _, g := range r.list("groups.list", nil) {
			if m := g.(map[string]any); m["name"] == group {
				return m["state"] == "Empty"
			}
		}
		return false
	})
	return nil
}

// positions is where a group is, per partition, from groups.describe.
func (r *rig) positions(group string) map[int]int64 {
	r.t.Helper()
	out := map[int]int64{}
	for _, row := range r.data("groups.describe", map[string]any{"group": group})["lag"].([]any) {
		m := row.(map[string]any)
		if m["committed"] != nil {
			out[int(m["partition"].(float64))] = int64(m["committed"].(float64))
		}
	}
	return out
}

func (r *rig) totalLag(group string) float64 {
	r.t.Helper()
	return r.data("groups.describe", map[string]any{"group": group})["totalLag"].(float64)
}

func seedOrders(r *rig) {
	var recs []*kgo.Record
	for i := 0; i < 30; i++ {
		recs = append(recs, &kgo.Record{Topic: "orders", Value: []byte(fmt.Sprint("order ", i)), Partition: int32(i % 3)})
	}
	r.produce(recs...)
}

func rowsOf(d map[string]any) []map[string]any {
	var out []map[string]any
	for _, x := range d["rows"].([]any) {
		out = append(out, x.(map[string]any))
	}
	return out
}

func TestResetOffsetsPreviewsThenApplies(t *testing.T) {
	r := newRig(t)
	seedOrders(r)
	r.commitGroup("billing", "orders", false)
	r.writable()
	before := r.positions("billing")
	if len(before) != 3 || r.totalLag("billing") != 0 {
		t.Fatalf("the group should be at the end of every partition: %v", before)
	}

	// A preview says what would change, and changes nothing.
	p := map[string]any{"group": "billing", "topic": "orders", "to": "earliest", "dryRun": true}
	d := r.data("groups.reset", p)
	if d["applied"] != false {
		t.Fatalf("a preview applied: %v", d)
	}
	rows := rowsOf(d)
	if len(rows) != 3 {
		t.Fatalf("rows: %v", rows)
	}
	for _, row := range rows {
		if row["before"].(float64) != 10 || row["after"].(float64) != 0 || row["start"].(float64) != 0 || row["end"].(float64) != 10 {
			t.Fatalf("a row of the preview: %v", row)
		}
	}
	if got := r.positions("billing"); fmt.Sprint(got) != fmt.Sprint(before) {
		t.Fatalf("the preview moved the group: %v -> %v", before, got)
	}

	// Applying moves it, to what the preview said.
	p["dryRun"] = false
	if d := r.data("groups.reset", p); d["applied"] != true || len(rowsOf(d)) != 3 {
		t.Fatalf("apply: %v", d)
	}
	if lag := r.totalLag("billing"); lag != 30 {
		t.Fatalf("lag after reset to earliest: %v, want 30", lag)
	}
	// And back to the end.
	r.data("groups.reset", map[string]any{"group": "billing", "topic": "orders", "to": "latest"})
	if lag := r.totalLag("billing"); lag != 0 {
		t.Fatalf("lag after reset to latest: %v, want 0", lag)
	}
}

func TestResetOffsetsByPartitionOffsetAndShift(t *testing.T) {
	r := newRig(t)
	seedOrders(r)
	r.commitGroup("billing", "orders", false)
	r.writable()

	// One partition only: the others stay where they were.
	r.data("groups.reset", map[string]any{"group": "billing", "topic": "orders", "partitions": []int{1}, "to": "offset", "offset": 4})
	if got := r.positions("billing"); got[0] != 10 || got[1] != 4 || got[2] != 10 {
		t.Fatalf("after an offset on partition 1: %v", got)
	}
	// Shifted back by three, from where each is: partition 1 from 4, the rest from 10.
	d := r.data("groups.reset", map[string]any{"group": "billing", "topic": "orders", "to": "shift", "shift": -3})
	if got := r.positions("billing"); got[0] != 7 || got[1] != 1 || got[2] != 7 {
		t.Fatalf("after a shift of -3: %v (%v)", got, d)
	}
	// Shifted past the ends is held at them.
	r.data("groups.reset", map[string]any{"group": "billing", "topic": "orders", "to": "shift", "shift": -100})
	if got := r.positions("billing"); got[0] != 0 || got[1] != 0 || got[2] != 0 {
		t.Fatalf("a shift back past the start: %v", got)
	}
	r.data("groups.reset", map[string]any{"group": "billing", "topic": "orders", "to": "shift", "shift": 100})
	if got := r.positions("billing"); got[0] != 10 || got[1] != 10 || got[2] != 10 {
		t.Fatalf("a shift forward past the end: %v", got)
	}

	// Refusals change nothing.
	r.fails("groups.reset", map[string]any{"group": "billing", "topic": "orders", "to": "offset", "offset": 11}, "EPARAM", "partition 0", "outside", "Nothing was changed")
	r.fails("groups.reset", map[string]any{"group": "billing", "topic": "orders", "to": "offset"}, "EPARAM", "needs the offset")
	r.fails("groups.reset", map[string]any{"group": "billing", "topic": "orders", "to": "shift"}, "EPARAM", "number of messages")
	r.fails("groups.reset", map[string]any{"group": "billing", "topic": "orders", "to": "timestamp"}, "EPARAM", "needs the time")
	r.fails("groups.reset", map[string]any{"group": "billing", "topic": "orders", "to": "yesterday"}, "EPARAM", "Unknown reset target")
	r.fails("groups.reset", map[string]any{"group": "billing", "topic": "orders", "partitions": []int{7}, "to": "earliest"}, "EPARAM", "no partition 7")
	if got := r.positions("billing"); got[0] != 10 || got[1] != 10 || got[2] != 10 {
		t.Fatalf("a refused reset moved the group: %v", got)
	}
}

func TestResetOffsetsToATime(t *testing.T) {
	r := newRig(t)
	base := time.Now().Add(-time.Hour).Truncate(time.Second)
	var recs []*kgo.Record
	for i := 0; i < 10; i++ {
		recs = append(recs, &kgo.Record{Topic: "logs", Partition: 0, Value: []byte(fmt.Sprint("line ", i)), Timestamp: base.Add(time.Duration(i) * time.Minute)})
	}
	r.produce(recs...)
	r.commitGroup("shipper", "logs", false)
	r.writable()

	at := base.Add(5 * time.Minute).UnixMilli()
	d := r.data("groups.reset", map[string]any{"group": "shipper", "topic": "logs", "to": "timestamp", "timestamp": at})
	if row := rowsOf(d)[0]; row["after"].(float64) != 5 {
		t.Fatalf("the first message at or after minute 5 is offset 5: %v", row)
	}
	if got := r.positions("shipper")[0]; got != 5 {
		t.Fatalf("the group is at %d, want 5", got)
	}
	// After every message: the end.
	future := time.Now().Add(time.Hour).UnixMilli()
	d = r.data("groups.reset", map[string]any{"group": "shipper", "topic": "logs", "to": "timestamp", "timestamp": future})
	if row := rowsOf(d)[0]; row["after"].(float64) != 10 {
		t.Fatalf("a time after everything is the end: %v", row)
	}
}

func TestResetOffsetsRefusesAGroupThatIsRunning(t *testing.T) {
	r := newRig(t)
	seedOrders(r)
	r.commitGroup("live", "orders", true) // still a member
	r.writable()

	r.fails("groups.reset", map[string]any{"group": "live", "topic": "orders", "to": "earliest", "dryRun": true}, "EGROUPACTIVE", `"live"`, "live-1", "stop its consumers")
	r.fails("groups.reset", map[string]any{"group": "live", "topic": "orders", "to": "earliest"}, "EGROUPACTIVE")
	if lag := r.totalLag("live"); lag != 0 {
		t.Fatalf("a refused reset moved a running group: lag %v", lag)
	}
	r.fails("groups.reset", map[string]any{"group": "nobody", "topic": "orders", "to": "earliest"}, "EKAFKA", "Unknown group")
}

func TestResetOffsetsChecksTheTopicAndKeepsToItsOwn(t *testing.T) {
	r := newRig(t)
	seedOrders(r)
	r.commitGroup("billing", "orders", false)
	r.writable()
	r.fails("groups.reset", map[string]any{"group": "billing", "topic": "no-such", "to": "earliest"}, "EKAFKA", "Unknown topic")
	r.fails("groups.reset", map[string]any{"group": "billing", "topic": "__consumer_offsets", "to": "earliest"}, "EPARAM", "Internal")
	r.fails("groups.reset", map[string]any{"group": "", "topic": "orders", "to": "earliest"}, "EPARAM")
	// A shift needs somewhere to shift from.
	r.fails("groups.reset", map[string]any{"group": "billing", "topic": "logs", "to": "shift", "shift": -1}, "EPARAM", "no committed offset")
}

// K-50, the third point: a login with no right to create. No stand here has an authorizer,
// so the broker is made to answer the way one that refuses does. What this proves is the
// agent's half of it: the cluster's own words reach the page, the same for a check as for a
// create, and nothing is made.
func TestCreateReportsWhatTheClusterSaysWhenItMayNotCreate(t *testing.T) {
	r, broker := newRigOn(t)
	r.writable()
	broker.Fault(kfake.Fault{Keys: []kmsg.Key{kmsg.CreateTopics}, Err: kerr.TopicAuthorizationFailed, Count: -1})

	r.fails("topics.create", map[string]any{"topic": "nope", "partitions": 1, "replicationFactor": 1}, "EKAFKA", "authoriz")
	r.fails("topics.create", map[string]any{"topic": "nope", "partitions": 1, "replicationFactor": 1, "validateOnly": true}, "EKAFKA", "authoriz")
	if r.topicNames()["nope"] {
		t.Fatal("a create the cluster refused made the topic")
	}
	// The refusal is the cluster's, not the agent's: what it says is what is shown.
	_, m := r.call("topics.create", map[string]any{"topic": "nope", "partitions": 1, "replicationFactor": 1})
	msg, _ := m["error"].(string)
	if !strings.Contains(msg, kerr.TopicAuthorizationFailed.Error()) {
		t.Errorf("the cluster's sentence should come through as it is: %q", msg)
	}
}

// ── the gate, for every write op there is ─────────────────────────────────

// Whatever write ops the table has — now and added later — each is refused with READ_ONLY
// on a read-only cluster, before it looks at its parameters or asks a broker anything.
func TestEveryWriteOpIsRefusedOnAReadOnlyCluster(t *testing.T) {
	r := newRig(t) // read-only
	checked := 0
	for name, entry := range ops {
		if entry.access != accessWrite || strings.HasPrefix(name, "test.") {
			continue
		}
		checked++
		r.fails(name, map[string]any{}, "READ_ONLY", `"dev"`)
	}
	if checked < 4 {
		t.Fatalf("only %d write ops found — the table changed shape", checked)
	}
	if len(r.conn.clients) != 0 {
		t.Fatal("a refused write made a client: a broker was contacted")
	}
}
