package main

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
)

// A write op for the tests: nothing in the table writes yet, and the gate must be
// proven before the first one that does. It counts how often it was reached.
func registerWrite(t *testing.T, name string) *atomic.Int32 {
	t.Helper()
	var reached atomic.Int32
	ops[name] = writeOp(typed[clusterParams](func(_ *opCtx, _ clusterParams) (any, error) {
		reached.Add(1)
		return map[string]bool{"done": true}, nil
	}), nil)
	t.Cleanup(func() { delete(ops, name) })
	return &reached
}

func TestEveryOpIsMarkedReadOrWrite(t *testing.T) {
	for name, entry := range ops {
		if entry.fn == nil {
			t.Errorf("op %s has no handler", name)
		}
		if entry.access != accessRead && entry.access != accessWrite {
			t.Errorf("op %s is not marked read or write — a new op must say which it is", name)
		}
	}
}

// The ops that write are named here, on purpose: a write that was meant as a read
// passes the gate, and a new write op has to be added to this list to pass review.
func TestOnlyTheKnownOpsWrite(t *testing.T) {
	want := map[string]bool{
		"messages.produce": true, "topics.delete": true, "topics.create": true, "groups.reset": true,
		"topics.alterConfigs": true, "topics.addPartitions": true, "topics.deleteRecords": true, "groups.delete": true,
		"schemas.register": true, "schemas.setCompatibility": true,
	}
	got := map[string]bool{}
	for name, entry := range ops {
		if entry.access == accessWrite && !strings.HasPrefix(name, "test.") {
			got[name] = true
		}
	}
	for name := range want {
		if !got[name] {
			t.Errorf("%s is not marked as a write op", name)
		}
	}
	for name := range got {
		if !want[name] {
			t.Errorf("%s is a write op this test does not expect — add it to the list", name)
		}
	}
}

func TestAnUnmarkedOpIsNotDispatched(t *testing.T) {
	var reached atomic.Int32
	// Built by hand, skipping readOp and writeOp: what a careless edit would look like.
	ops["test.unmarked"] = opEntry{fn: func(_ *opCtx, _ *req) (any, error) {
		reached.Add(1)
		return nil, nil
	}}
	t.Cleanup(func() { delete(ops, "test.unmarked") })

	s, conn, fr := testConn(t)
	s.dispatch(conn, request(1, "test.unmarked", map[string]any{"cluster": "dev"}))
	if got := replyFor(t, fr, 1); got["code"] != "ENOOP" {
		t.Fatalf("an op nobody classified: %v, want ENOOP", got)
	}
	if reached.Load() != 0 {
		t.Fatal("an unmarked op ran")
	}
}

func TestAWriteOnAReadOnlyClusterIsRefusedBeforeItRuns(t *testing.T) {
	reached := registerWrite(t, "test.write")
	s, conn, fr := testConn(t) // "dev" is read-only, with no broker to reach
	s.dispatch(conn, request(1, "test.write", map[string]any{"cluster": "dev"}))
	got := replyFor(t, fr, 1)
	if got["code"] != "READ_ONLY" || got["ok"] == true {
		t.Fatalf("write on a read-only cluster: %v, want READ_ONLY", got)
	}
	msg, _ := got["error"].(string)
	if !strings.Contains(msg, `"dev"`) || !strings.Contains(msg, "readOnly: false") || !strings.Contains(msg, "--allow-write") {
		t.Errorf("the refusal should name the cluster and what to change: %q", msg)
	}
	if reached.Load() != 0 {
		t.Fatal("the handler ran on a read-only cluster")
	}
	if len(conn.clients) != 0 {
		t.Fatal("a client was made for a write that was refused — the broker was contacted")
	}
}

func TestAnExplicitReadOnlyIsNotLiftedByAllowWrite(t *testing.T) {
	s, conn, fr := testConn(t)
	s.setClusters([]*cluster{{Name: "dev", ReadOnly: true, readOnlySet: true, Protocol: "PLAINTEXT"}})
	registerWrite(t, "test.write")
	s.dispatch(conn, request(1, "test.write", map[string]any{"cluster": "dev"}))
	got := replyFor(t, fr, 1)
	msg, _ := got["error"].(string)
	if got["code"] != "READ_ONLY" || !strings.Contains(msg, "marked readOnly: true") {
		t.Fatalf("explicit readOnly: true: %v — the message should say it was set on purpose", got)
	}
}

func TestAWriteOnAWritableClusterRuns(t *testing.T) {
	reached := registerWrite(t, "test.write")
	s, conn, fr := testConn(t)
	s.setClusters([]*cluster{{Name: "dev", ReadOnly: false, Protocol: "PLAINTEXT"}})
	s.dispatch(conn, request(1, "test.write", map[string]any{"cluster": "dev"}))
	if got := replyFor(t, fr, 1); got["ok"] != true {
		t.Fatalf("write on a writable cluster: %v", got)
	}
	if reached.Load() != 1 {
		t.Fatalf("handler ran %d times, want 1", reached.Load())
	}
}

func TestAWriteNamingNoKnownClusterIsRefused(t *testing.T) {
	reached := registerWrite(t, "test.write")
	s, conn, fr := testConn(t)
	s.setClusters([]*cluster{{Name: "dev", ReadOnly: false, Protocol: "PLAINTEXT"}})
	for i, params := range []map[string]any{nil, {"cluster": ""}, {"cluster": "nope"}} {
		id := int64(i + 1)
		s.dispatch(conn, request(id, "test.write", params))
		if got := replyFor(t, fr, id); got["code"] != "ENOCLUSTER" {
			t.Errorf("write with params %v: %v, want ENOCLUSTER", params, got)
		}
	}
	if reached.Load() != 0 {
		t.Fatal("a write ran without naming a cluster the agent knows")
	}
}

// Reads are not the gate's business, on any cluster.
func TestReadsAreNeverRefusedForBeingReadOnly(t *testing.T) {
	s, conn, fr := testConn(t)
	s.dispatch(conn, request(1, "clusters.list", nil))
	if got := replyFor(t, fr, 1); got["ok"] != true {
		t.Fatalf("clusters.list on a read-only agent: %v", got)
	}
}

// A reload can turn a cluster read-only between dispatch's check and the moment
// the handler asks for its client. use() is the last place to say no.
func TestUseChecksAgainForAWrite(t *testing.T) {
	s, conn, _ := testConn(t)
	c := &opCtx{ctx: context.Background(), conn: conn, srv: s, write: true}
	_, err := c.use("dev")
	coded, ok := err.(*opError)
	if !ok || coded.Code != "READ_ONLY" {
		t.Fatalf("use for a write on a read-only cluster: %v, want READ_ONLY", err)
	}
	if len(conn.clients) != 0 {
		t.Fatal("use made a client before refusing")
	}
}

// ── the switch ────────────────────────────────────────────────────────────

const allowWriteYAML = `clusters:
  - name: unset
    bootstrap: k1:9092
  - name: locked
    bootstrap: k2:9092
    readOnly: true
  - name: open
    bootstrap: k3:9092
    readOnly: false
`

func readOnlyOf(t *testing.T, flags clusterFlags) map[string]bool {
	t.Helper()
	dir := write(t, map[string]string{"kafka-agent.yaml": allowWriteYAML})
	flags.config = dir + "/kafka-agent.yaml"
	list, _, err := loadClusters(flags)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, c := range list {
		out[c.Name] = c.ReadOnly
	}
	return out
}

func TestReadOnlyIsTheDefaultAndReadOnlyFalseOpensACluster(t *testing.T) {
	got := readOnlyOf(t, clusterFlags{})
	if !got["unset"] || !got["locked"] || got["open"] {
		t.Fatalf("read-only by cluster: %v, want unset and locked read-only, open writable", got)
	}
}

func TestAllowWriteLiftsTheDefaultAndNothingElse(t *testing.T) {
	got := readOnlyOf(t, clusterFlags{allowWrite: true})
	if got["unset"] {
		t.Error("--allow-write should open a cluster whose configuration says nothing")
	}
	if !got["locked"] {
		t.Error("--allow-write overrode readOnly: true — an explicit decision must outlive the flag")
	}
	if got["open"] {
		t.Error("readOnly: false should stay writable")
	}
}

func TestAllowWriteAppliesToAClusterFromTheCommandLine(t *testing.T) {
	list, _, err := loadClusters(clusterFlags{bootstrap: "k1:9092", allowWrite: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ReadOnly || !list[0].writableByFlag {
		t.Fatalf("a cluster from --bootstrap under --allow-write: %+v", list)
	}
	list, _, err = loadClusters(clusterFlags{bootstrap: "k1:9092"})
	if err != nil {
		t.Fatal(err)
	}
	if !list[0].ReadOnly {
		t.Fatal("a cluster from --bootstrap must be read-only without --allow-write")
	}
}

func TestTheBannerSaysWhereWritableComesFrom(t *testing.T) {
	dir := write(t, map[string]string{"kafka-agent.yaml": allowWriteYAML})
	list, _, err := loadClusters(clusterFlags{config: dir + "/kafka-agent.yaml", allowWrite: true})
	if err != nil {
		t.Fatal(err)
	}
	line := map[string]string{}
	for _, c := range list {
		line[c.Name] = c.describe()
	}
	if !strings.Contains(line["unset"], "WRITABLE (--allow-write)") {
		t.Errorf("writable by the flag: %q", line["unset"])
	}
	if !strings.Contains(line["open"], "WRITABLE") || strings.Contains(line["open"], "--allow-write") {
		t.Errorf("writable by its own setting: %q", line["open"])
	}
	if !strings.Contains(line["locked"], "read-only") {
		t.Errorf("read-only on purpose: %q", line["locked"])
	}
}

// A cluster with a Schema Registry says so in the banner, with the host and nothing of a login (S-02).
func TestTheBannerNamesTheSchemaRegistry(t *testing.T) {
	dir := write(t, map[string]string{"kafka-agent.yaml": `clusters:
  - name: with
    bootstrap: k1:9092
    schemaRegistry:
      url: https://registry.example.com:8081
      username: app
      password: secret-password
  - name: without
    bootstrap: k2:9092
`})
	list, _, err := loadClusters(clusterFlags{config: dir + "/kafka-agent.yaml"})
	if err != nil {
		t.Fatal(err)
	}
	line := map[string]string{}
	for _, c := range list {
		line[c.Name] = c.describe()
	}
	if !strings.Contains(line["with"], "schema registry registry.example.com:8081") {
		t.Errorf("a cluster with a registry: %q", line["with"])
	}
	if strings.Contains(line["with"], "secret-password") || strings.Contains(line["with"], "app@") {
		t.Errorf("the banner shows a login: %q", line["with"])
	}
	if strings.Contains(line["without"], "schema registry") {
		t.Errorf("a cluster without a registry: %q", line["without"])
	}
}
