package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/twmb/franz-go/pkg/sr"
	"github.com/twmb/franz-go/pkg/sr/srfake"
)

// Writing schemas (K-47): registering a version, asking whether the registry would take
// one, and holding a subject to a compatibility level.
//
// srfake is the registry these run against: it speaks the real REST API, keeps versions
// and levels, and — being a fake — does not enforce compatibility on a registration and
// answers "compatible" to every check. Both of those are the places a test has to
// intercept, and both are said where they are used.

// The second version of the record, used to have something to add.
const avroOrderV2 = `{"type":"record","name":"Order","fields":[{"name":"id","type":"int"},{"name":"note","type":"string"},{"name":"total","type":"double"}]}`

// A registry whose compatibility answers are its own, for the cases srfake leaves out: it
// takes any schema and says any schema is compatible.
func interceptCompat(reg *srfake.Registry, body string, status int) {
	reg.Intercept(func(w http.ResponseWriter, req *http.Request) bool {
		if !strings.Contains(req.URL.Path, "/compatibility/") {
			return false
		}
		w.Header().Set("Content-Type", "application/vnd.schemaregistry.v1+json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
		return true
	})
}

func TestRegisterANewVersionOfASubject(t *testing.T) {
	r, reg := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})
	first, _ := reg.GetSchema("orders-value", 1)

	got := r.data("schemas.register", map[string]any{"subject": "orders-value", "schema": avroOrderV2, "type": "AVRO"})
	if got["subject"] != "orders-value" || got["version"].(float64) != 2 || got["type"] != "AVRO" {
		t.Fatalf("what the registry made of it: %v", got)
	}
	if id := int(got["id"].(float64)); id <= 0 || id == first.ID {
		t.Fatalf("the new version's id: %v, and the first version's is %d", got["id"], first.ID)
	}

	// The registry holds it: the version list has two, and its text is the text that was
	// sent — not a normalized or re-serialized one.
	v := r.data("schemas.versions", map[string]any{"subject": "orders-value"})
	if versions := v["versions"].([]any); len(versions) != 2 {
		t.Fatalf("the versions: %v", versions)
	}
	text := r.data("schemas.version", map[string]any{"subject": "orders-value", "version": 2})
	if text["schema"] != avroOrderV2 || text["type"] != "AVRO" {
		t.Fatalf("the second version's text: %v", text)
	}
}

// A subject the registry has never seen: the first version of it is registered the same
// way, which is how a schema gets into a registry at all.
func TestRegisterTheFirstVersionOfANewSubject(t *testing.T) {
	r, _ := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})
	got := r.data("schemas.register", map[string]any{
		"subject": "payments-value", "type": "JSON",
		"schema": `{"type":"object","properties":{"id":{"type":"integer"}}}`,
	})
	if got["subject"] != "payments-value" || got["version"].(float64) != 1 || got["type"] != "JSON" {
		t.Fatalf("the new subject: %v", got)
	}
	subjects := r.data("schemas.subjects", nil)["subjects"].([]any)
	if len(subjects) != 2 {
		t.Fatalf("the subjects: %v", subjects)
	}
}

// A schema that is written in terms of another one: the reference is what the registry
// needs to find it, and it comes back with the version.
func TestRegisterASchemaThatReferencesAnother(t *testing.T) {
	const money = `{"type":"record","name":"Money","fields":[{"name":"amount","type":"long"}]}`
	r, _ := producingRig(t, map[string]sr.Schema{"money-value": {Schema: money, Type: sr.TypeAvro}})

	r.data("schemas.register", map[string]any{
		"subject": "order-value", "type": "AVRO",
		"schema":     `{"type":"record","name":"Order","fields":[{"name":"total","type":"Money"}]}`,
		"references": []map[string]any{{"name": "Money", "subject": "money-value", "version": 1}},
	})
	text := r.data("schemas.version", map[string]any{"subject": "order-value", "version": 1})
	refs := text["references"].([]any)
	if len(refs) != 1 {
		t.Fatalf("the references: %v", refs)
	}
	ref := refs[0].(map[string]any)
	if ref["name"] != "Money" || ref["subject"] != "money-value" || ref["version"].(float64) != 1 {
		t.Fatalf("the reference: %v", ref)
	}
}

// Whether the registry would take a schema: the answer is the registry's, and a "no" is an
// answer rather than an error — the page shows the reasons where the schema is written.
func TestCheckWhetherTheRegistryWouldTakeASchema(t *testing.T) {
	r, reg := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})
	ask := func(version any) map[string]any {
		return r.data("schemas.check", map[string]any{
			"subject": "orders-value", "schema": avroOrderV2, "type": "AVRO", "version": version,
		})
	}
	// srfake's own answer, which its source calls a stub: it says yes to anything.
	d := ask(-1)
	if d["compatible"] != true {
		t.Fatalf("a compatible schema: %v", d)
	}
	if msgs := d["messages"].([]any); len(msgs) != 0 {
		t.Fatalf("a compatible schema with reasons: %v", msgs)
	}

	// A registry that says no: its reasons are the whole value of asking, so they are
	// carried through as they came.
	interceptCompat(reg, `{"is_compatible":false,"messages":["{oldSchemaVersion: 1}","{errorType: \"READER_FIELD_MISSING_DEFAULT_VALUE\", description: \"note is missing\"}"]}`, http.StatusOK)
	d = ask(-1)
	if d["compatible"] != false {
		t.Fatalf("an incompatible schema: %v", d)
	}
	joined := ""
	for _, m := range d["messages"].([]any) {
		joined += m.(string)
	}
	if !strings.Contains(joined, "READER_FIELD_MISSING_DEFAULT_VALUE") || !strings.Contains(joined, "note is missing") {
		t.Fatalf("the registry's reasons: %v", d["messages"])
	}
}

// The compatibility level of one subject, and of the registry for subjects that have none
// of their own. An empty level takes a subject back to following the default, which is not
// the same as setting it to the default's value.
func TestSetTheCompatibilityOfASubjectAndOfTheRegistry(t *testing.T) {
	reg := srfake.New(srfake.WithGlobalCompat(sr.CompatBackward))
	t.Cleanup(reg.Close)
	if _, _, err := reg.RegisterSchema("orders-value", sr.Schema{Schema: avroOrder, Type: sr.TypeAvro}); err != nil {
		t.Fatal(err)
	}
	r := newRig(t)
	r.withRegistry(reg.URL(), "", "", nil)
	r.writable()

	// The subject's own level.
	d := r.data("schemas.setCompatibility", map[string]any{"subject": "orders-value", "level": "none"})
	if d["subject"] != "orders-value" || d["level"] != "NONE" {
		t.Fatalf("the level of the subject: %v — the page's word for a level is not its case", d)
	}
	if v := r.data("schemas.versions", map[string]any{"subject": "orders-value"}); v["compatibility"] != "NONE" {
		t.Fatalf("what the subject holds: %v", v["compatibility"])
	}

	// Back to following the registry's default: the level in force is the registry's own.
	d = r.data("schemas.setCompatibility", map[string]any{"subject": "orders-value", "level": ""})
	if d["level"] != "BACKWARD" {
		t.Fatalf("a subject back on the default: %v", d)
	}
	if v := r.data("schemas.versions", map[string]any{"subject": "orders-value"}); v["compatibility"] != "BACKWARD" {
		t.Fatalf("what the subject holds afterwards: %v", v["compatibility"])
	}

	// And the registry's default itself, which is what a subject without one of its own
	// is held to.
	d = r.data("schemas.setCompatibility", map[string]any{"subject": "", "level": "FULL"})
	if d["subject"] != "" || d["level"] != "FULL" {
		t.Fatalf("the registry's default: %v", d)
	}
	if s := r.data("schemas.status", nil); s["compatibility"] != "FULL" {
		t.Fatalf("what the registry says about itself: %v", s["compatibility"])
	}

	// Resetting the registry's default: srfake has no DELETE /config at all (the real
	// registry does), so the one request it cannot answer is answered here. What the op
	// reports is read back, which is the part this test is about.
	reg.Intercept(func(w http.ResponseWriter, req *http.Request) bool {
		if req.Method == http.MethodDelete && req.URL.Path == "/config" {
			w.Header().Set("Content-Type", "application/vnd.schemaregistry.v1+json")
			_, _ = w.Write([]byte(`{"compatibility":"NONE"}`))
			return true
		}
		return false
	})
	d = r.data("schemas.setCompatibility", map[string]any{"subject": "", "level": ""})
	if d["level"] != "FULL" {
		t.Fatalf("the registry's default after a reset: %v — what is reported is what is in force", d)
	}
}

// What cannot work is refused with a sentence, before the registry is asked anything.
func TestWritingSchemasRefusesWhatCannotWork(t *testing.T) {
	r, _ := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})
	register := func(patch map[string]any) map[string]any {
		p := map[string]any{"subject": "orders-value", "schema": avroOrderV2, "type": "AVRO"}
		for k, v := range patch {
			p[k] = v
		}
		return p
	}
	r.fails("schemas.register", register(map[string]any{"subject": ""}), "EPARAM", "No subject")
	r.fails("schemas.register", register(map[string]any{"schema": ""}), "EPARAM", "No schema")
	r.fails("schemas.register", register(map[string]any{"type": "THRIFT"}), "EPARAM", "THRIFT")
	r.fails("schemas.register", register(map[string]any{"references": []map[string]any{{"name": "X", "subject": "", "version": 1}}}), "EPARAM", "Reference 1")
	r.fails("schemas.register", register(map[string]any{"references": []map[string]any{{"name": "X", "subject": "money-value", "version": 0}}}), "EPARAM", "version number")

	// The check is asked the same questions, plus which version to check against.
	check := func(version any) map[string]any {
		return map[string]any{"subject": "orders-value", "schema": avroOrderV2, "type": "AVRO", "version": version}
	}
	r.fails("schemas.check", check(0), "EPARAM", "Which version")
	r.fails("schemas.check", check(-3), "EPARAM", "Which version")
	r.fails("schemas.check", map[string]any{"subject": "", "schema": avroOrderV2, "version": -1}, "EPARAM", "No subject")
	r.fails("schemas.check", map[string]any{"subject": "orders-value", "schema": "", "version": -1}, "EPARAM", "No schema")

	// A level nobody has: the whole list is in the sentence, because the person asking is
	// usually reading it off something else.
	r.fails("schemas.setCompatibility", map[string]any{"subject": "orders-value", "level": "SOMETIMES"}, "EPARAM", "Unknown compatibility level", "BACKWARD_TRANSITIVE")

	// A cluster with no registry says so for all three, and names the setting to add.
	plain := newRig(t)
	plain.writable()
	plain.fails("schemas.register", register(nil), "ENOREGISTRY", "schemaRegistry")
	plain.fails("schemas.check", check(-1), "ENOREGISTRY", "schemaRegistry")
	plain.fails("schemas.setCompatibility", map[string]any{"subject": "orders-value", "level": "FULL"}, "ENOREGISTRY", "schemaRegistry")
}

// What the registry itself refuses — an incompatible schema, a level it will not take —
// arrives as its own sentence, and the write log keeps the kind of failure, not the text.
func TestWhatTheRegistryRefusesIsSaidInItsOwnWords(t *testing.T) {
	r, reg := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})
	reg.Intercept(func(w http.ResponseWriter, req *http.Request) bool {
		if req.Method != http.MethodPost || !strings.Contains(req.URL.Path, "/subjects/") {
			return false
		}
		w.Header().Set("Content-Type", "application/vnd.schemaregistry.v1+json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error_code":409,"message":"Schema being registered is incompatible with an earlier schema"}`))
		return true
	})
	r.fails("schemas.register", map[string]any{"subject": "orders-value", "schema": avroOrderV2, "type": "AVRO"},
		"EKAFKA", "incompatible with an earlier schema")
}

// The schema's text is the cluster's data: the write log says which subject and version
// moved, and never quotes the schema.
func TestTheWriteLogNamesTheSchemaAndNeverQuotesIt(t *testing.T) {
	r, _ := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})
	lines := r.logged()

	const secret = "fieldNamedSecret123"
	schema := `{"type":"record","name":"Order","fields":[{"name":"id","type":"int"},{"name":"note","type":"string"},{"name":"` + secret + `","type":"string"}]}`
	r.data("schemas.register", map[string]any{"subject": "orders-value", "schema": schema, "type": "AVRO"})
	r.data("schemas.setCompatibility", map[string]any{"subject": "orders-value", "level": "FULL"})
	r.data("schemas.setCompatibility", map[string]any{"subject": "orders-value", "level": ""})

	want := []string{
		"kafka-agent: write cluster=dev op=schemas.register subject=orders-value type=AVRO version=2 id=",
		"kafka-agent: write cluster=dev op=schemas.setCompatibility subject=orders-value level=FULL result=ok",
		"kafka-agent: write cluster=dev op=schemas.setCompatibility subject=orders-value level=default result=ok",
	}
	got2 := lines()
	if len(got2) != len(want) {
		t.Fatalf("%d lines, want %d:\n%s", len(got2), len(want), strings.Join(got2, "\n"))
	}
	// The line names the version and the id the registry gave; the id itself is the
	// registry's to choose, so only what comes before it is fixed.
	if !strings.HasPrefix(noTime(got2[0]), want[0]) || !strings.HasSuffix(got2[0], " result=ok") {
		t.Errorf("line 1:\n got  %s\n want %s…result=ok", noTime(got2[0]), want[0])
	}
	for i, w := range want[1:] {
		if noTime(got2[i+1]) != w {
			t.Errorf("line %d:\n got  %s\n want %s", i+2, noTime(got2[i+1]), w)
		}
	}
	if all := strings.Join(got2, "\n"); strings.Contains(all, secret) {
		t.Errorf("the log quotes the schema:\n%s", all)
	}
}
