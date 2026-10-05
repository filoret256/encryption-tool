package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
)

// rig is a fake cluster with data in it, a server that knows it as "dev", and a
// connection to talk to it over.
type rig struct {
	t    *testing.T
	s    *server
	conn *connection
	fr   <-chan map[string]any
	addr string
	next int64
}

func newRig(t *testing.T, opts ...kfake.Opt) *rig {
	t.Helper()
	r, _ := newRigOn(t, opts...)
	return r
}

// newRigOn is newRig with the fake cluster itself in hand, for a test that has to make the
// broker answer something of its own choosing — a fault, the way a cluster without a right
// answers.
func newRigOn(t *testing.T, opts ...kfake.Opt) (*rig, *kfake.Cluster) {
	t.Helper()
	_, _, list := stand(t)
	broker, addr := startBrokerWith(t, append([]kfake.Opt{kfake.SeedTopics(3, "orders"), kfake.SeedTopics(1, "logs")}, opts...)...)
	s, conn, fr := testConn(t)
	c := at(list["plaintext"], addr)
	c.Name = "dev"
	s.setClusters([]*cluster{c})
	t.Cleanup(conn.closeClients)
	return &rig{t: t, s: s, conn: conn, fr: fr, addr: addr, next: 1}, broker
}

// producer is a client for putting messages on the fake cluster.
func (r *rig) producer(opts ...kgo.Opt) *kgo.Client {
	r.t.Helper()
	kc, err := kgo.NewClient(append([]kgo.Opt{kgo.SeedBrokers(r.addr), kgo.RecordPartitioner(kgo.ManualPartitioner()), kgo.ProducerBatchMaxBytes(32 << 20), kgo.MaxBufferedBytes(64 << 20)}, opts...)...)
	if err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(kc.Close)
	return kc
}

func (r *rig) produce(recs ...*kgo.Record) {
	r.t.Helper()
	if err := r.producer().ProduceSync(context.Background(), recs...).FirstErr(); err != nil {
		r.t.Fatal(err)
	}
}

// call sends one op and returns the batches it streamed and its reply.
func (r *rig) call(op string, params map[string]any) (chunks []map[string]any, reply map[string]any) {
	r.t.Helper()
	id := r.next
	r.next++
	if params == nil {
		params = map[string]any{}
	}
	if _, ok := params["cluster"]; !ok {
		params["cluster"] = "dev"
	}
	r.s.dispatch(r.conn, request(id, op, params))
	deadline := time.After(20 * time.Second)
	for {
		select {
		case m, ok := <-r.fr:
			if !ok {
				r.t.Fatalf("%s: connection closed", op)
			}
			if got, _ := m["id"].(float64); int64(got) != id {
				continue
			}
			if c, isChunk := m["chunk"]; isChunk {
				chunks = append(chunks, c.(map[string]any))
				continue
			}
			return chunks, m
		case <-deadline:
			r.t.Fatalf("%s: no answer", op)
		}
	}
}

func (r *rig) data(op string, params map[string]any) map[string]any {
	r.t.Helper()
	_, m := r.call(op, params)
	if m["ok"] != true {
		r.t.Fatalf("%s: %v", op, m)
	}
	d, _ := m["data"].(map[string]any)
	return d
}

func (r *rig) list(op string, params map[string]any) []any {
	r.t.Helper()
	_, m := r.call(op, params)
	if m["ok"] != true {
		r.t.Fatalf("%s: %v", op, m)
	}
	d, _ := m["data"].([]any)
	return d
}

func (r *rig) fails(op string, params map[string]any, code string, mentions ...string) {
	r.t.Helper()
	_, m := r.call(op, params)
	if m["ok"] == true || m["code"] != code {
		r.t.Fatalf("%s: %v, want %s", op, m, code)
	}
	for _, w := range mentions {
		if !strings.Contains(fmt.Sprint(m["error"]), w) {
			r.t.Errorf("%s: %q does not mention %q", op, m["error"], w)
		}
	}
}

// messages flattens the streamed batches.
func messages(chunks []map[string]any) []map[string]any {
	var out []map[string]any
	for _, c := range chunks {
		for _, m := range c["messages"].([]any) {
			out = append(out, m.(map[string]any))
		}
	}
	return out
}

func decoded(v any) string {
	if v == nil {
		return "<nil>"
	}
	b, _ := base64.StdEncoding.DecodeString(v.(string))
	return string(b)
}

func values(msgs []map[string]any) []string {
	var out []string
	for _, m := range msgs {
		out = append(out, decoded(m["value"]))
	}
	return out
}

// logLines puts n lines on the one-partition topic, a second apart.
func (r *rig) logLines(n int) time.Time {
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	var recs []*kgo.Record
	for i := 0; i < n; i++ {
		recs = append(recs, &kgo.Record{
			Topic: "logs", Key: []byte(fmt.Sprintf("k%d", i)), Value: []byte(fmt.Sprintf("line-%d", i)),
			Timestamp: base.Add(time.Duration(i) * time.Second),
			Headers:   []kgo.RecordHeader{{Key: "n", Value: []byte(fmt.Sprint(i))}},
		})
	}
	r.produce(recs...)
	return base
}

// ── brokers ───────────────────────────────────────────────────────────────

func TestBrokersAndTheirConfig(t *testing.T) {
	r := newRig(t)
	d := r.data("brokers.list", nil)
	brokers, _ := d["brokers"].([]any)
	if len(brokers) != 1 || d["clusterId"] != "test-cluster" {
		t.Fatalf("brokers.list: %v", d)
	}
	b := brokers[0].(map[string]any)
	if b["controller"] != true || b["host"] == "" || b["port"].(float64) <= 0 {
		t.Fatalf("broker: %v", b)
	}

	cfg := r.list("brokers.config", map[string]any{"broker": b["id"]})
	if len(cfg) == 0 {
		t.Fatal("no broker configuration")
	}
	for _, e := range cfg {
		e := e.(map[string]any)
		if e["sensitive"] == true && e["value"] != nil {
			t.Errorf("a sensitive entry carries its value: %v", e)
		}
	}
}

// ── topics ────────────────────────────────────────────────────────────────

func TestTopicsListDescribeAndConfig(t *testing.T) {
	r := newRig(t)
	var recs []*kgo.Record
	for i := 0; i < 30; i++ {
		recs = append(recs, &kgo.Record{Topic: "orders", Key: []byte(fmt.Sprint("o", i)), Value: []byte(fmt.Sprint("order ", i)), Partition: int32(i % 3)})
	}
	r.produce(recs...)

	byName := map[string]map[string]any{}
	for _, e := range r.list("topics.list", nil) {
		e := e.(map[string]any)
		byName[e["name"].(string)] = e
	}
	o := byName["orders"]
	if o == nil || o["partitions"].(float64) != 3 || o["messages"].(float64) != 30 || o["internal"] != false {
		t.Fatalf("orders: %v (all: %v)", o, byName)
	}
	if byName["logs"]["messages"].(float64) != 0 {
		t.Errorf("an empty topic: %v", byName["logs"])
	}
	t.Logf("orders as listed: %v", o)

	d := r.data("topics.describe", map[string]any{"topic": "orders"})
	parts := d["partitions"].([]any)
	if len(parts) != 3 {
		t.Fatalf("topics.describe: %v", d)
	}
	var total float64
	for i, p := range parts {
		p := p.(map[string]any)
		if p["id"].(float64) != float64(i) || p["end"].(float64) != 10 || p["start"].(float64) != 0 || len(p["replicas"].([]any)) == 0 {
			t.Errorf("partition %d: %v", i, p)
		}
		total += p["end"].(float64) - p["start"].(float64)
	}
	if total != 30 {
		t.Errorf("partitions add up to %v messages, want 30", total)
	}

	r.fails("topics.describe", map[string]any{"topic": "nope"}, "EKAFKA", "Unknown topic")
	if cfg := r.list("topics.config", map[string]any{"topic": "orders"}); cfg == nil {
		t.Error("topics.config returned no list")
	}
}

// ── messages ──────────────────────────────────────────────────────────────

func TestConsumeStartOffsetAndEnd(t *testing.T) {
	r := newRig(t)
	r.logLines(20)

	chunks, reply := r.call("messages.consume", map[string]any{"topic": "logs", "from": "start", "limit": 5})
	got := messages(chunks)
	res := reply["data"].(map[string]any)
	if strings.Join(values(got), ",") != "line-0,line-1,line-2,line-3,line-4" || res["stopped"] != "limit" || res["matched"].(float64) != 5 {
		t.Fatalf("from start: %v %v", values(got), res)
	}
	first := got[0]
	if decoded(first["key"]) != "k0" || first["partition"].(float64) != 0 || first["offset"].(float64) != 0 ||
		first["timestamp"].(float64) != float64(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC).UnixMilli()) ||
		first["keySize"].(float64) != 2 || first["valueSize"].(float64) != 6 || first["truncated"] != false {
		t.Fatalf("a message: %v", first)
	}
	h := first["headers"].([]any)[0].(map[string]any)
	if h["key"] != "n" || decoded(h["value"]) != "0" {
		t.Fatalf("header: %v", h)
	}

	// Everything, and then it stops at the end.
	chunks, reply = r.call("messages.consume", map[string]any{"topic": "logs", "from": "start", "limit": 1000})
	res = reply["data"].(map[string]any)
	if len(messages(chunks)) != 20 || res["stopped"] != "end" || res["scanned"].(float64) != 20 {
		t.Fatalf("all of it: %d messages, %v", len(messages(chunks)), res)
	}

	// From an offset, on one partition.
	chunks, _ = r.call("messages.consume", map[string]any{"topic": "logs", "from": "offset", "offset": 10, "partitions": []int{0}, "limit": 3})
	if strings.Join(values(messages(chunks)), ",") != "line-10,line-11,line-12" {
		t.Fatalf("from offset 10: %v", values(messages(chunks)))
	}
	r.fails("messages.consume", map[string]any{"topic": "logs", "from": "offset", "offset": 3, "limit": 3, "partitions": []int{0, 1}}, "EPARAM", "exactly one partition")

	// The newest first.
	chunks, reply = r.call("messages.consume", map[string]any{"topic": "logs", "from": "end", "limit": 4})
	if strings.Join(values(messages(chunks)), ",") != "line-19,line-18,line-17,line-16" {
		t.Fatalf("from the end: %v %v", values(messages(chunks)), reply["data"])
	}

	// From a moment in time.
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	chunks, _ = r.call("messages.consume", map[string]any{"topic": "logs", "from": "time", "timestamp": base.Add(15 * time.Second).UnixMilli(), "limit": 100})
	if strings.Join(values(messages(chunks)), ",") != "line-15,line-16,line-17,line-18,line-19" {
		t.Fatalf("from a time: %v", values(messages(chunks)))
	}
	// After the last message there is nothing, and that is an answer.
	chunks, reply = r.call("messages.consume", map[string]any{"topic": "logs", "from": "time", "timestamp": base.Add(time.Hour).UnixMilli(), "limit": 100})
	if len(messages(chunks)) != 0 || reply["ok"] != true {
		t.Fatalf("from after the end: %v %v", chunks, reply)
	}
}

func TestConsumeAllPartitionsAndSomeOfThem(t *testing.T) {
	r := newRig(t)
	var recs []*kgo.Record
	for i := 0; i < 30; i++ {
		recs = append(recs, &kgo.Record{Topic: "orders", Value: []byte(fmt.Sprint("order ", i)), Partition: int32(i % 3)})
	}
	r.produce(recs...)

	chunks, _ := r.call("messages.consume", map[string]any{"topic": "orders", "from": "start", "limit": 1000})
	if n := len(messages(chunks)); n != 30 {
		t.Fatalf("all partitions: %d messages", n)
	}
	chunks, _ = r.call("messages.consume", map[string]any{"topic": "orders", "from": "start", "limit": 1000, "partitions": []int{2}})
	for _, m := range messages(chunks) {
		if m["partition"].(float64) != 2 {
			t.Fatalf("asked for partition 2, got %v", m)
		}
	}
	if n := len(messages(chunks)); n != 10 {
		t.Fatalf("partition 2: %d messages, want 10", n)
	}
	r.fails("messages.consume", map[string]any{"topic": "orders", "from": "start", "limit": 5, "partitions": []int{7}}, "EPARAM", "no partition 7")

	// The newest across partitions, by time, whichever partition they are on.
	chunks, _ = r.call("messages.consume", map[string]any{"topic": "orders", "from": "end", "limit": 6})
	if n := len(messages(chunks)); n != 6 {
		t.Fatalf("newest six of thirty: %d", n)
	}
}

func TestConsumeFilters(t *testing.T) {
	r := newRig(t)
	r.logLines(20)
	consume := func(f map[string]any) ([]string, map[string]any) {
		p := map[string]any{"topic": "logs", "from": "start", "limit": 100}
		for k, v := range f {
			p[k] = v
		}
		chunks, reply := r.call("messages.consume", p)
		if reply["ok"] != true {
			t.Fatalf("%v: %v", f, reply)
		}
		return values(messages(chunks)), reply["data"].(map[string]any)
	}

	got, res := consume(map[string]any{"filter": "line-1"}) // line-1, line-10 … line-19
	if len(got) != 11 || res["scanned"].(float64) != 20 || res["matched"].(float64) != 11 {
		t.Errorf("substring: %v %v", got, res)
	}
	if got, _ := consume(map[string]any{"filter": "LINE-7"}); len(got) != 1 {
		t.Errorf("a substring ignores case by default: %v", got)
	}
	if got, _ := consume(map[string]any{"filter": "LINE-7", "caseSensitive": true}); len(got) != 0 {
		t.Errorf("caseSensitive: %v", got)
	}
	if got, _ := consume(map[string]any{"filter": `^line-1\d$`, "regex": true}); len(got) != 10 {
		t.Errorf("regex: %v", got)
	}
	if got, _ := consume(map[string]any{"filter": "k13"}); len(got) != 1 || got[0] != "line-13" {
		t.Errorf("a filter looks at the key as well: %v", got)
	}
	// The newest first, through a filter that drops most of them.
	if got, _ := consume(map[string]any{"filter": "line-1", "from": "end", "limit": 3}); strings.Join(got, ",") != "line-19,line-18,line-17" {
		t.Errorf("end + filter: %v", got)
	}
	r.fails("messages.consume", map[string]any{"topic": "logs", "from": "start", "limit": 5, "filter": "(", "regex": true}, "EPARAM", "regular expression")
	r.fails("messages.consume", map[string]any{"topic": "nope", "from": "start", "limit": 5}, "EKAFKA", "Unknown topic")
	r.fails("messages.consume", map[string]any{"topic": "logs", "from": "sideways", "limit": 5}, "EPARAM", "sideways")
}

func TestABigValueIsCutAndFetchedWhole(t *testing.T) {
	r := newRig(t)
	big := bytes.Repeat([]byte("x"), 1<<20)
	huge := bytes.Repeat([]byte("y"), 10<<20)
	r.produce(
		&kgo.Record{Topic: "logs", Value: []byte("small")},
		&kgo.Record{Topic: "logs", Value: big},
		&kgo.Record{Topic: "logs", Value: huge},
	)
	chunks, reply := r.call("messages.consume", map[string]any{"topic": "logs", "from": "start", "limit": 10})
	msgs := messages(chunks)
	if reply["ok"] != true || len(msgs) != 3 {
		t.Fatalf("%d messages: %v", len(msgs), reply)
	}
	if msgs[0]["truncated"] != false {
		t.Errorf("a small value was cut: %v", msgs[0])
	}
	for i, want := range []int{1 << 20, 10 << 20} {
		m := msgs[i+1]
		if m["truncated"] != true || int(m["valueSize"].(float64)) != want || len(decoded(m["value"])) != maxValueBytes {
			t.Errorf("value of %d bytes: truncated=%v size=%v shown=%d", want, m["truncated"], m["valueSize"], len(decoded(m["value"])))
		}
	}

	whole := r.data("messages.get", map[string]any{"topic": "logs", "partition": 0, "offset": 1})
	if whole["truncated"] != false || len(decoded(whole["value"])) != 1<<20 {
		t.Errorf("messages.get of 1 MiB: truncated=%v, %d bytes", whole["truncated"], len(decoded(whole["value"])))
	}
	capped := r.data("messages.get", map[string]any{"topic": "logs", "partition": 0, "offset": 2})
	if capped["truncated"] != true || len(decoded(capped["value"])) != maxGetBytes || int(capped["valueSize"].(float64)) != 10<<20 {
		t.Errorf("messages.get of 10 MiB: truncated=%v, %d bytes", capped["truncated"], len(decoded(capped["value"])))
	}
}

func TestMessagesGet(t *testing.T) {
	r := newRig(t)
	r.logLines(5)
	m := r.data("messages.get", map[string]any{"topic": "logs", "partition": 0, "offset": 3})
	if decoded(m["value"]) != "line-3" || m["offset"].(float64) != 3 {
		t.Fatalf("messages.get: %v", m)
	}
	r.fails("messages.get", map[string]any{"topic": "logs", "partition": 0, "offset": 5}, "EKAFKA", "outside")
	r.fails("messages.get", map[string]any{"topic": "logs", "partition": 4, "offset": 0}, "EKAFKA", "No partition")
}

func TestATombstoneAndAnEmptyTopic(t *testing.T) {
	r := newRig(t)
	if chunks, reply := r.call("messages.consume", map[string]any{"topic": "orders", "from": "start", "limit": 5}); reply["ok"] != true || len(messages(chunks)) != 0 {
		t.Fatalf("an empty topic: %v %v", chunks, reply)
	}
	r.produce(&kgo.Record{Topic: "logs", Key: []byte("gone"), Value: nil})
	chunks, _ := r.call("messages.consume", map[string]any{"topic": "logs", "from": "start", "limit": 5})
	m := messages(chunks)[0]
	if m["value"] != nil || decoded(m["key"]) != "gone" || m["valueSize"].(float64) != 0 {
		t.Fatalf("a tombstone: %v", m)
	}
}

func TestOnlyAFewReadsAtOnce(t *testing.T) {
	c := &connection{}
	var releases []func()
	for i := 0; i < maxConsumes; i++ {
		rel, ok := c.consumeSlot()
		if !ok {
			t.Fatalf("slot %d refused", i)
		}
		releases = append(releases, rel)
	}
	if _, ok := c.consumeSlot(); ok {
		t.Fatal("more reads than the limit")
	}
	releases[0]()
	if _, ok := c.consumeSlot(); !ok {
		t.Fatal("a released slot was not free")
	}
}

// ── groups ────────────────────────────────────────────────────────────────

func TestGroupsAndTheirLag(t *testing.T) {
	r := newRig(t)
	var recs []*kgo.Record
	for i := 0; i < 30; i++ {
		recs = append(recs, &kgo.Record{Topic: "orders", Value: []byte(fmt.Sprint("order ", i)), Partition: int32(i % 3)})
	}
	r.produce(recs...)

	// A member that has read and committed twelve messages, and is still there.
	member, err := kgo.NewClient(kgo.SeedBrokers(r.addr), kgo.ConsumerGroup("billing"), kgo.ConsumeTopics("orders"),
		kgo.DisableAutoCommit(), kgo.ClientID("billing-1"), kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(member.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var read []*kgo.Record
	for len(read) < 30 {
		fs := member.PollFetches(ctx)
		if ctx.Err() != nil {
			t.Fatalf("the member read %d of 30", len(read))
		}
		fs.EachRecord(func(rec *kgo.Record) { read = append(read, rec) })
	}
	if err := member.CommitRecords(ctx, read[:12]...); err != nil {
		t.Fatal(err)
	}
	// A commit is a position per partition: the highest offset among the twelve, plus one.
	committedAt := map[int32]int64{}
	for _, rec := range read[:12] {
		committedAt[rec.Partition] = max(committedAt[rec.Partition], rec.Offset+1)
	}
	var behind float64 = 30
	for _, at := range committedAt {
		behind -= float64(at)
	}

	list := r.list("groups.list", nil)
	var g map[string]any
	for _, e := range list {
		if e.(map[string]any)["name"] == "billing" {
			g = e.(map[string]any)
		}
	}
	if g == nil || g["state"] != "Stable" || g["members"].(float64) != 1 || g["protocolType"] != "consumer" {
		t.Fatalf("groups.list: %v", list)
	}
	if g["lag"] == nil || g["lag"].(float64) != behind {
		t.Errorf("lag in the list: %v, want %v", g["lag"], behind)
	}

	d := r.data("groups.describe", map[string]any{"group": "billing"})
	if d["state"] != "Stable" || d["totalLag"].(float64) != behind || d["protocol"] == "" {
		t.Fatalf("groups.describe: %v", d)
	}
	members := d["members"].([]any)
	if len(members) != 1 || members[0].(map[string]any)["clientId"] != "billing-1" {
		t.Fatalf("members: %v", members)
	}
	assigned := 0
	for _, a := range members[0].(map[string]any)["assignments"].([]any) {
		assigned += len(a.(map[string]any)["partitions"].([]any))
	}
	if assigned != 3 {
		t.Errorf("the member holds %d partitions, want 3", assigned)
	}
	rows := d["lag"].([]any)
	if len(rows) != 3 {
		t.Fatalf("lag rows: %v", rows)
	}
	for _, row := range rows {
		row := row.(map[string]any)
		committed := 0.0
		if row["committed"] != nil {
			committed = row["committed"].(float64)
		}
		if row["member"] == nil || row["end"].(float64) != 10 || row["lag"].(float64) != row["end"].(float64)-committed {
			t.Errorf("lag row: %v", row)
		}
	}

	// Gone: the group is Empty, and what it committed is still what it owes.
	member.Close()
	eventually(t, "the group to empty", func() bool {
		d := r.data("groups.describe", map[string]any{"group": "billing"})
		return d["state"] == "Empty"
	})
	d = r.data("groups.describe", map[string]any{"group": "billing"})
	// Empty, it is known only by what it committed: the third partition it never
	// committed was never its own as far as the cluster can tell.
	var owed float64
	for _, at := range committedAt {
		owed += 10 - float64(at)
	}
	if len(d["members"].([]any)) != 0 || d["totalLag"].(float64) != owed {
		t.Errorf("an empty group: %v", d)
	}
	for _, row := range d["lag"].([]any) {
		if row.(map[string]any)["member"] != nil {
			t.Errorf("a partition with no member: %v", row)
		}
	}

	// Committed nothing at all: as far behind as the log is long.
	r.produce(&kgo.Record{Topic: "logs", Value: []byte("a")})
	r.fails("groups.describe", map[string]any{"group": "nobody"}, "EKAFKA", "Unknown group")
}

func TestEveryOpOfTheTableIsRegistered(t *testing.T) {
	for _, op := range []string{
		"agent.info", "cancel", "clusters.list", "clusters.status", "brokers.list", "brokers.config",
		"topics.list", "topics.describe", "topics.config", "messages.consume", "messages.get", "groups.list", "groups.describe",
		"messages.produce", "topics.delete", "topics.create", "groups.reset",
	} {
		if ops[op].fn == nil {
			t.Errorf("op %s is not registered", op)
		}
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for i := 0; i < 300; i++ {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// ── tail ──────────────────────────────────────────────────────────────────

// startTail sends a messages.tail and returns a function that reads what it streams.
func (r *rig) startTail(params map[string]any) (id int64, batches func(within time.Duration, until func(got []map[string]any) bool) []map[string]any) {
	r.t.Helper()
	id = r.next
	r.next++
	if _, ok := params["cluster"]; !ok {
		params["cluster"] = "dev"
	}
	r.s.dispatch(r.conn, request(id, "messages.tail", params))
	return id, func(within time.Duration, until func([]map[string]any) bool) []map[string]any {
		var got []map[string]any
		deadline := time.After(within)
		for !until(got) {
			select {
			case m := <-r.fr:
				if got2, _ := m["id"].(float64); int64(got2) != id {
					continue
				}
				if c, ok := m["chunk"].(map[string]any); ok {
					for _, msg := range c["messages"].([]any) {
						got = append(got, msg.(map[string]any))
					}
				}
			case <-deadline:
				return got
			}
		}
		return got
	}
}

func TestTailFollowsFromTheEndUntilCancelled(t *testing.T) {
	r := newRig(t)
	r.logLines(5) // written before the tail: never delivered

	id, read := r.startTail(map[string]any{"topic": "logs"})
	prod := r.producer()
	// Keep writing until the tail is seen to be listening: it takes its place at the
	// end lazily, so a write made too early would be one it (rightly) never sees.
	stop := make(chan struct{})
	go func() {
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			case <-time.After(60 * time.Millisecond):
				_ = prod.ProduceSync(context.Background(), &kgo.Record{Topic: "logs", Value: []byte(fmt.Sprintf("live-%d", i))}).FirstErr()
			}
		}
	}()
	got := read(8*time.Second, func(g []map[string]any) bool { return len(g) >= 5 })
	close(stop)
	if len(got) < 5 {
		t.Fatalf("the tail delivered %d messages", len(got))
	}
	for _, m := range got {
		if !strings.HasPrefix(decoded(m["value"]), "live-") {
			t.Fatalf("a message from before the tail: %s", decoded(m["value"]))
		}
	}

	// Cancelling is how it ends, and it says so as any stopped op does.
	r.s.dispatch(r.conn, request(r.next, "cancel", map[string]any{"target": id}))
	r.next++
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-r.fr:
			if got2, _ := m["id"].(float64); int64(got2) == id && m["chunk"] == nil {
				if m["code"] != "ECANCELED" {
					t.Fatalf("a cancelled tail: %v", m)
				}
				// And its slot is free again.
				eventually(t, "the tail's slot to be released", func() bool {
					rel, ok := r.conn.consumeSlot()
					if ok {
						rel()
					}
					return r.conn.consuming == 0
				})
				return
			}
		case <-deadline:
			t.Fatal("the tail did not stop when cancelled")
		}
	}
}

func TestTailAppliesItsFilterAndChecksItsTopic(t *testing.T) {
	r := newRig(t)
	id, read := r.startTail(map[string]any{"topic": "logs", "filter": "KEEP"})
	prod := r.producer()
	stop := make(chan struct{})
	go func() {
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			case <-time.After(60 * time.Millisecond):
				v := fmt.Sprintf("drop-%d", i)
				if i%2 == 0 {
					v = fmt.Sprintf("keep-%d", i)
				}
				_ = prod.ProduceSync(context.Background(), &kgo.Record{Topic: "logs", Value: []byte(v)}).FirstErr()
			}
		}
	}()
	got := read(8*time.Second, func(g []map[string]any) bool { return len(g) >= 3 })
	close(stop)
	for _, m := range got {
		if !strings.HasPrefix(decoded(m["value"]), "keep-") {
			t.Errorf("the filter let %q through", decoded(m["value"]))
		}
	}
	if len(got) < 3 {
		t.Fatalf("only %d matching messages arrived", len(got))
	}
	r.s.dispatch(r.conn, request(r.next, "cancel", map[string]any{"target": id}))
	r.next++

	r.fails("messages.tail", map[string]any{"topic": "nope"}, "EKAFKA", "Unknown topic")
	r.fails("messages.tail", map[string]any{"topic": "logs", "partitions": []int{3}}, "EPARAM", "no partition 3")
	r.fails("messages.tail", map[string]any{"topic": "logs", "filter": "(", "regex": true}, "EPARAM", "regular expression")
}

func TestATailThatIsOutrunLosesTheOldestAndSaysSo(t *testing.T) {
	r := newRig(t)
	id := r.next
	r.next++
	r.s.dispatch(r.conn, request(id, "messages.tail", map[string]any{"cluster": "dev", "topic": "logs"}))
	time.Sleep(600 * time.Millisecond)

	var recs []*kgo.Record
	for i := 0; i < 1500; i++ {
		recs = append(recs, &kgo.Record{Topic: "logs", Value: []byte(fmt.Sprintf("burst-%04d", i))})
	}
	r.produce(recs...)

	got, skipped := 0, 0
	var last string
	deadline := time.After(8 * time.Second)
	for got+skipped < 1500 {
		select {
		case m := <-r.fr:
			if id2, _ := m["id"].(float64); int64(id2) != id {
				continue
			}
			c, ok := m["chunk"].(map[string]any)
			if !ok {
				continue
			}
			skipped += int(c["skipped"].(float64))
			for _, msg := range c["messages"].([]any) {
				got++
				last = decoded(msg.(map[string]any)["value"])
			}
		case <-deadline:
			t.Fatalf("saw %d delivered and %d skipped of 1500", got, skipped)
		}
	}
	if skipped == 0 {
		t.Errorf("1500 messages in one stretch and nothing was dropped: %d delivered", got)
	}
	if got+skipped != 1500 {
		t.Errorf("%d delivered + %d skipped is not 1500 — messages were lost without being counted", got, skipped)
	}
	if last != "burst-1499" {
		t.Errorf("the newest message was not kept: last delivered %s", last)
	}
	r.s.dispatch(r.conn, request(r.next, "cancel", map[string]any{"target": id}))
	r.next++
}
