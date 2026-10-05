package main

import (
	"bytes"
	"regexp"
	"strings"
	"testing"
)

// logged starts the rig's write log and returns a way to read the lines so far.
func (r *rig) logged() func() []string {
	r.t.Helper()
	var buf bytes.Buffer
	r.s.auditMu.Lock()
	r.s.audit = &buf
	r.s.auditMu.Unlock()
	return func() []string {
		r.s.auditMu.Lock()
		defer r.s.auditMu.Unlock()
		text := strings.TrimSuffix(buf.String(), "\n")
		if text == "" {
			return nil
		}
		return strings.Split(text, "\n")
	}
}

// The time changes between runs; everything else is exact.
var auditTime = regexp.MustCompile(` time=\S+`)

func noTime(line string) string { return auditTime.ReplaceAllString(line, "") }

func TestEveryWriteIsLoggedWithWhatItActedOnAndHowItWent(t *testing.T) {
	r := newRig(t)
	lines := r.logged()

	// Refused first, on the read-only cluster: it is a write that was asked for.
	r.fails("topics.delete", map[string]any{"topic": "logs", "confirm": "logs"}, "READ_ONLY")
	r.writable()

	r.data("topics.create", map[string]any{
		"topic": "audited", "partitions": 2, "replicationFactor": 1,
		"configs": map[string]any{"retention.ms": "60000", "cleanup.policy": "delete"},
	})
	r.data("topics.create", map[string]any{"topic": "audited-check", "partitions": 2, "replicationFactor": 1, "validateOnly": true})
	r.data("messages.produce", map[string]any{"topic": "logs", "partition": 0, "key": "k", "value": "v"})
	r.data("messages.produce", map[string]any{"topic": "logs", "value": "v2"})
	r.fails("messages.produce", map[string]any{"topic": "nope", "value": "v"}, "EKAFKA")
	r.fails("groups.reset", map[string]any{"group": "g", "topic": "orders", "to": "shift", "shift": -5, "dryRun": true}, "EKAFKA")
	r.fails("topics.delete", map[string]any{"topic": "logs", "confirm": "wrong"}, "EPARAM")
	r.data("topics.delete", map[string]any{"topic": "audited", "confirm": "audited"})

	want := []string{
		"kafka-agent: write cluster=dev op=topics.delete topic=logs result=refused code=READ_ONLY",
		"kafka-agent: write cluster=dev op=topics.create topic=audited partitions=2 replication=1 settings=cleanup.policy,retention.ms result=ok",
		"kafka-agent: write cluster=dev op=topics.create topic=audited-check partitions=2 replication=1 validateOnly=true result=ok",
		"kafka-agent: write cluster=dev op=messages.produce topic=logs partition=0 landed=0@0 result=ok",
		"kafka-agent: write cluster=dev op=messages.produce topic=logs partition=auto landed=0@1 result=ok",
		"kafka-agent: write cluster=dev op=messages.produce topic=nope partition=auto result=error code=EKAFKA",
		"kafka-agent: write cluster=dev op=groups.reset group=g topic=orders to=shift shift=-5 partitions=all dryRun=true result=error code=EKAFKA",
		"kafka-agent: write cluster=dev op=topics.delete topic=logs result=error code=EPARAM",
		"kafka-agent: write cluster=dev op=topics.delete topic=audited messages=0 result=ok",
	}
	got := lines()
	if len(got) != len(want) {
		t.Fatalf("%d lines, want %d:\n%s", len(got), len(want), strings.Join(got, "\n"))
	}
	for i := range want {
		if noTime(got[i]) != want[i] {
			t.Errorf("line %d:\n got  %s\n want %s", i+1, noTime(got[i]), want[i])
		}
		if !auditTime.MatchString(got[i]) {
			t.Errorf("line %d has no time: %s", i+1, got[i])
		}
	}
}

// The ops that change a topic that is already there, and a group that is finished with:
// what each of them writes is decided here and nowhere else.
func TestTheAlteringWritesAreLoggedWithWhatTheyActedOn(t *testing.T) {
	r := newRig(t)
	seedOrders(r)
	r.commitGroup("billing", "orders", false)
	r.writable()
	lines := r.logged()

	r.data("topics.alterConfigs", map[string]any{"topic": "orders", "dryRun": true,
		"configs": map[string]*string{"retention.ms": sptr("60000"), "cleanup.policy": sptr("compact")}})
	r.data("topics.alterConfigs", map[string]any{"topic": "orders", "configs": map[string]*string{"retention.ms": sptr("60000")}})
	r.data("topics.addPartitions", map[string]any{"topic": "orders", "partitions": 6, "validateOnly": true})
	r.data("topics.addPartitions", map[string]any{"topic": "orders", "partitions": 6})
	r.data("topics.deleteRecords", map[string]any{"topic": "orders", "partition": 0, "offset": 3, "confirm": "orders"})
	r.data("groups.delete", map[string]any{"group": "billing", "confirm": "billing"})
	// A refusal is a write that was asked for: it is logged, with its code and no text.
	r.fails("topics.deleteRecords", map[string]any{"topic": "orders", "partition": 0, "offset": 99, "confirm": "orders"}, "EPARAM")

	want := []string{
		"kafka-agent: write cluster=dev op=topics.alterConfigs topic=orders settings=cleanup.policy,retention.ms changes=2 dryRun=true result=ok",
		"kafka-agent: write cluster=dev op=topics.alterConfigs topic=orders settings=retention.ms changes=1 result=ok",
		"kafka-agent: write cluster=dev op=topics.addPartitions topic=orders partitions=6 from=3 validateOnly=true result=ok",
		"kafka-agent: write cluster=dev op=topics.addPartitions topic=orders partitions=6 from=3 result=ok",
		"kafka-agent: write cluster=dev op=topics.deleteRecords topic=orders partition=0 upTo=3 deleted=3 start=3 result=ok",
		"kafka-agent: write cluster=dev op=groups.delete group=billing offsets=3 result=ok",
		"kafka-agent: write cluster=dev op=topics.deleteRecords topic=orders partition=0 upTo=99 result=error code=EPARAM",
	}
	got := lines()
	if len(got) != len(want) {
		t.Fatalf("%d lines, want %d:\n%s", len(got), len(want), strings.Join(got, "\n"))
	}
	for i := range want {
		if noTime(got[i]) != want[i] {
			t.Errorf("line %d:\n got  %s\n want %s", i+1, noTime(got[i]), want[i])
		}
	}
	// A setting's value is what the cluster holds; the log names the settings, never their values.
	if all := strings.Join(got, "\n"); strings.Contains(all, "60000") {
		t.Errorf("the log holds a setting's value:\n%s", all)
	}
}

func TestTheWriteLogHoldsNoMessageContentNoSettingValueAndNoErrorText(t *testing.T) {
	r := newRig(t)
	r.writable()
	lines := r.logged()

	secret := "s3cr3t-payload"
	r.data("messages.produce", map[string]any{
		"topic": "logs", "key": "key-" + secret, "value": secret,
		"headers": []map[string]any{{"key": "h-" + secret, "value": "hv-" + secret}},
	})
	// A value that is not JSON: the error text quotes a character of it, the log must not.
	r.fails("messages.produce", map[string]any{"topic": "logs", "value": "{" + secret, "valueEncoding": "json"}, "EPARAM")
	r.data("topics.create", map[string]any{"topic": "t-" + "audit2", "partitions": 1, "replicationFactor": 1,
		"configs": map[string]any{"retention.ms": "value-" + secret}})
	// A name with a space and a line break in it must not become a line of its own.
	r.fails("topics.delete", map[string]any{"topic": "a b\nkafka-agent: write forged", "confirm": "x"}, "EPARAM")

	got := lines()
	if len(got) != 4 {
		t.Fatalf("%d lines, want 4 (one per write, however odd the input):\n%s", len(got), strings.Join(got, "\n"))
	}
	all := strings.Join(got, "\n")
	for _, leak := range []string{secret, "hv-", "Not deleted", "not valid JSON"} {
		if strings.Contains(all, leak) {
			t.Errorf("the log contains %q:\n%s", leak, all)
		}
	}
	if !strings.Contains(got[3], `topic="a b\nkafka-agent: write forged"`) {
		t.Errorf("a name from the page must be quoted on one line: %s", got[3])
	}
}

func TestReadsAreNotLoggedAndNoLogMeansNoOutput(t *testing.T) {
	r := newRig(t)
	lines := r.logged()
	r.list("topics.list", nil)
	r.data("agent.info", nil)
	if got := lines(); len(got) != 0 {
		t.Fatalf("a read was logged: %v", got)
	}

	// With no writer set the agent writes nothing and does not fail.
	r.s.auditMu.Lock()
	r.s.audit = nil
	r.s.auditMu.Unlock()
	r.writable()
	r.data("messages.produce", map[string]any{"topic": "logs", "value": "v"})
}

func TestEveryWriteOpSaysWhatItLogs(t *testing.T) {
	for name, entry := range ops {
		if entry.access == accessWrite && entry.about == nil && !strings.HasPrefix(name, "test.") {
			t.Errorf("write op %s has no describer for the write log", name)
		}
	}
}
