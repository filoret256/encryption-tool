package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/twmb/franz-go/pkg/sr"
)

// A message written with a schema: the page sends JSON, the agent turns it into the
// schema's own bytes, and what lands on the topic is what any other client of that
// registry expects to find (K-45).
//
// The rig with a registry, the header of a written value and the reading of one are in
// schema_rig_test.go: they are what the K-47 tests of registering a schema need as well.

// Avro: JSON from the page, Avro binary on the topic, JSON again when it is read back.
func TestProduceAValueWithAnAvroSchemaAndReadItBack(t *testing.T) {
	r, reg := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})
	id := schemaID(t, reg, "orders-value")

	m := r.sendWithSchema(t, map[string]any{
		"topic": "logs", "partition": 0,
		"value":  `{"id":7,"note":"привет"}`,
		"schema": map[string]any{"subject": "orders-value", "version": -1},
	})
	if got := headerID(t, m["value"]); got != id {
		t.Fatalf("the header names schema id %d, want %d", got, id)
	}
	// The value on the topic is not the JSON that was typed: it is what the schema says.
	if encoded := string(mustB64(t, m["value"])); strings.Contains(encoded, "note") {
		t.Errorf("the JSON went to the topic as it was: %q", encoded)
	}
	d := r.data("messages.decode", map[string]any{"value": m["value"]})
	if d["schemaType"] != "AVRO" || d["subject"] != "orders-value" || int(d["version"].(float64)) != 1 {
		t.Fatalf("what the value carries: %v", d)
	}
	back := decodedJSON(t, d)
	if back["id"].(float64) != 7 || back["note"] != "привет" {
		t.Fatalf("read back: %v", back)
	}
}

// The version that is named is the version that is written with: not the latest, and
// not whatever the subject happens to have.
func TestProduceWithANamedVersionWritesThatVersion(t *testing.T) {
	const second = `{"type":"record","name":"Order","fields":[{"name":"id","type":"int"},{"name":"note","type":"string"},{"name":"total","type":"double"}]}`
	r, reg := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})
	firstID := schemaID(t, reg, "orders-value")
	if _, _, err := reg.RegisterSchema("orders-value", sr.Schema{Schema: second, Type: sr.TypeAvro}); err != nil {
		t.Fatal(err)
	}
	v2, ok := reg.GetSchema("orders-value", 2)
	if !ok {
		t.Fatal("the second version was not registered")
	}
	secondID := v2.ID
	if firstID == secondID {
		t.Fatal("the registry gave the second version the first one's id — the test would prove nothing")
	}

	// Version 1 takes the three-field value? No: it takes what version 1 describes.
	m := r.sendWithSchema(t, map[string]any{
		"topic": "logs", "partition": 0,
		"value":  `{"id":1,"note":"one"}`,
		"schema": map[string]any{"subject": "orders-value", "version": 1},
	})
	if got := headerID(t, m["value"]); got != firstID {
		t.Errorf("version 1 was named, and the header says id %d, want %d", got, firstID)
	}
	// A value with a field version 1 does not have is refused by version 1's schema.
	r.fails("messages.produce", map[string]any{
		"topic": "logs", "value": `{"note":"one"}`,
		"schema": map[string]any{"subject": "orders-value", "version": 1},
	}, "EKAFKA", "does not fit")

	// The latest is the second version, and it takes the same value with the new field.
	m = r.sendWithSchema(t, map[string]any{
		"topic": "logs", "partition": 0,
		"value":  `{"id":2,"note":"two","total":2.5}`,
		"schema": map[string]any{"subject": "orders-value", "version": -1},
	})
	if got := headerID(t, m["value"]); got != secondID {
		t.Errorf("-1 means the latest, and the header says id %d, want %d", got, secondID)
	}
}

// Protobuf: the message indexes go in front of the message, and a value that does not
// fit says which field it was.
func TestProduceAValueWithAProtobufSchema(t *testing.T) {
	const text = `syntax = "proto3";
package acme;

message Order {
  int32 id = 1;
  string note = 2;
}
`
	r, reg := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: text, Type: sr.TypeProtobuf}})
	id := schemaID(t, reg, "orders-value")

	m := r.sendWithSchema(t, map[string]any{
		"topic": "logs", "partition": 0,
		"value":  `{"id":9,"note":"hello"}`,
		"schema": map[string]any{"subject": "orders-value", "version": -1},
	})
	raw := mustB64(t, m["value"])
	if headerID(t, m["value"]) != id {
		t.Fatalf("the header: %v", raw[:headerLen])
	}
	// The writer's shorthand for the first message of the file is a count of zero, and
	// that byte is the reader's whole instruction for which message this is.
	if len(raw) <= headerLen || raw[headerLen] != 0 {
		t.Fatalf("the message indexes are missing before the payload: %v", raw)
	}
	d := r.data("messages.decode", map[string]any{"value": m["value"]})
	if d["schemaType"] != "PROTOBUF" || d["message"] != "acme.Order" {
		t.Fatalf("what the value carries: %v", d)
	}
	back := decodedJSON(t, d)
	if back["id"].(float64) != 9 || back["note"] != "hello" {
		t.Fatalf("read back: %v", back)
	}

	// A value that does not fit: the format's own reader names the field, which is what
	// the page shows — a sentence that says where to look.
	r.fails("messages.produce", map[string]any{
		"topic": "logs", "value": `{"id":"nine"}`,
		"schema": map[string]any{"subject": "orders-value", "version": -1},
	}, "EKAFKA", "id")
	// A field the schema does not have is not silently dropped: a typo in a field name
	// would otherwise be a message that means something else.
	r.fails("messages.produce", map[string]any{
		"topic": "logs", "value": `{"id":1,"noote":"x"}`,
		"schema": map[string]any{"subject": "orders-value", "version": -1},
	}, "EKAFKA", "noote")
	if n := r.count("logs"); n != 1 {
		t.Fatalf("the topic holds %d messages; a refused one was written", n)
	}
}

// JSON Schema: the payload is already JSON, and the header is the only thing added. The
// key can be written with a schema of its own, which is a subject of its own too.
func TestProduceAValueAndAKeyWithJSONSchemas(t *testing.T) {
	const valueSchema = `{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}`
	r, reg := producingRig(t, map[string]sr.Schema{
		"orders-value": {Schema: valueSchema, Type: sr.TypeJSON},
		"orders-key":   {Schema: `{"type":"string"}`, Type: sr.TypeJSON},
	})
	valueID := schemaID(t, reg, "orders-value")
	keyID := schemaID(t, reg, "orders-key")

	m := r.sendWithSchema(t, map[string]any{
		"topic": "logs", "partition": 0,
		"key":           `"order-7"`,
		"keySchema":     map[string]any{"subject": "orders-key", "version": -1},
		"value":         `{"id":3,"what":"click"}`,
		"schema":        map[string]any{"subject": "orders-value", "version": -1},
		"valueEncoding": "json",
	})
	if got := headerID(t, m["value"]); got != valueID {
		t.Errorf("the value's header says id %d, want %d", got, valueID)
	}
	if got := headerID(t, m["key"]); got != keyID {
		t.Errorf("the key's header says id %d, want %d", got, keyID)
	}
	// Both are read with the schema they carry, through the same op.
	if k := r.data("messages.decode", map[string]any{"value": m["key"]}); k["json"] != `"order-7"` {
		t.Errorf("the key: %v", k)
	}
	if v := r.data("messages.decode", map[string]any{"value": m["value"]}); v["json"] != `{"id":3,"what":"click"}` {
		t.Errorf("the value: %v", v)
	}
}

// What is refused is refused before anything reaches the topic: a value the schema does
// not describe must not be written, whatever the cluster would have accepted.
func TestProduceWithASchemaRefusesWhatDoesNotFitBeforeItWrites(t *testing.T) {
	r, _ := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})

	// Not JSON at all, and JSON that is not the record: the schema is the judge.
	r.fails("messages.produce", map[string]any{
		"topic": "logs", "value": `{oops`, "schema": map[string]any{"subject": "orders-value", "version": -1},
	}, "EPARAM", "not JSON")
	r.fails("messages.produce", map[string]any{
		"topic": "logs", "value": `{"id":"seven","note":"x"}`, "schema": map[string]any{"subject": "orders-value", "version": -1},
	}, "EKAFKA", "does not fit the Avro schema")
	// A field the schema needs and the value does not have: what was typed means
	// something else than it says.
	r.fails("messages.produce", map[string]any{
		"topic": "logs", "value": `{"id":1}`, "schema": map[string]any{"subject": "orders-value", "version": -1},
	}, "EKAFKA", "does not fit the Avro schema")
	// A schema was named for a value that is not there, and for one that is not text.
	r.fails("messages.produce", map[string]any{
		"topic": "logs", "value": nil, "schema": map[string]any{"subject": "orders-value", "version": -1},
	}, "EPARAM", "value is missing")
	r.fails("messages.produce", map[string]any{
		"topic": "logs", "value": "AAH/", "valueEncoding": "base64", "schema": map[string]any{"subject": "orders-value", "version": -1},
	}, "EPARAM", "JSON")

	if n := r.count("logs"); n != 0 {
		t.Fatalf("a refused value reached the topic: %d message(s)", n)
	}
}

// A schema the registry does not have, a version that cannot exist, no subject: each is
// a sentence about the registry rather than a decoder's error.
func TestProduceWithASchemaRefusesABadSubjectOrVersion(t *testing.T) {
	r, _ := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})
	bad := func(params map[string]any, code string, mentions ...string) {
		t.Helper()
		params["topic"] = "logs"
		params["value"] = `{"id":1,"note":"x"}`
		r.fails("messages.produce", params, code, mentions...)
	}
	bad(map[string]any{"schema": map[string]any{"subject": "", "version": -1}}, "EPARAM", "No subject")
	bad(map[string]any{"schema": map[string]any{"subject": "orders-value", "version": 0}}, "EPARAM", "version number")
	bad(map[string]any{"schema": map[string]any{"subject": "orders-value", "version": -2}}, "EPARAM", "version number")
	bad(map[string]any{"schema": map[string]any{"subject": "no-such-subject", "version": -1}}, "EKAFKA", "no-such-subject")
	bad(map[string]any{"schema": map[string]any{"subject": "orders-value", "version": 99}}, "EKAFKA", "99")

	// A cluster without a registry says so, and names the setting to add.
	plain := newRig(t)
	plain.writable()
	plain.fails("messages.produce", map[string]any{
		"topic": "logs", "value": `{"id":1,"note":"x"}`,
		"schema": map[string]any{"subject": "orders-value", "version": -1},
	}, "ENOREGISTRY", "schemaRegistry")
	if n := plain.count("logs"); n != 0 {
		t.Fatalf("a value reached the topic without a registry: %d", n)
	}
}

// The schema is read once and kept, as for reading: a topic written with one version of
// one schema costs one registry read. The latest is the exception, and on purpose —
// registering a version moves it, so it is asked for every time (K-45, K-47).
func TestProduceKeepsTheSchemaItWasGiven(t *testing.T) {
	r, reg := producingRig(t, map[string]sr.Schema{"orders-value": {Schema: avroOrder, Type: sr.TypeAvro}})
	asks := 0
	reg.Intercept(func(w http.ResponseWriter, req *http.Request) bool {
		if strings.Contains(req.URL.Path, "/subjects/orders-value/versions/") {
			asks++
		}
		return false // and let the registry answer as usual
	})
	send := func(version int) {
		t.Helper()
		r.sendWithSchema(t, map[string]any{
			"topic": "logs", "partition": 0,
			"value":  `{"id":1,"note":"x"}`,
			"schema": map[string]any{"subject": "orders-value", "version": version},
		})
	}
	for range 5 {
		send(1)
	}
	if asks != 1 {
		t.Fatalf("%d registry reads for five sends of version 1: the schema is not kept", asks)
	}
	for range 2 {
		send(-1)
	}
	if asks != 3 {
		t.Fatalf("%d registry reads after asking for the latest twice, want one per send", asks)
	}
}

// A long is written as the whole number that was typed (N-01). JSON read into float64
// rounds everything above 2^53, so 9007199254740993 would reach the topic as ...992.
func TestProduceALongAbove2To53WithoutLoss(t *testing.T) {
	const avroEvent = `{"type":"record","name":"Event","fields":[{"name":"at","type":"long"},{"name":"n","type":["null","long"]},{"name":"price","type":"double"},{"name":"ratio","type":"float"},{"name":"k","type":"int"}]}`
	r, _ := producingRig(t, map[string]sr.Schema{"events-value": {Schema: avroEvent, Type: sr.TypeAvro}})
	send := func(value string) map[string]any {
		return r.sendWithSchema(t, map[string]any{
			"topic": "logs", "partition": 0, "value": value,
			"schema": map[string]any{"subject": "events-value", "version": -1},
		})
	}
	for _, want := range []string{"9007199254740993", "-9223372036854775808", "9223372036854775807"} {
		m := send(`{"at":` + want + `,"n":null,"price":10.50,"ratio":0.25,"k":-7}`)
		d := r.data("messages.decode", map[string]any{"value": m["value"]})
		if got := d["json"].(string); !strings.Contains(got, `"at":`+want) {
			t.Errorf("sent %s, read back %s", want, got)
		}
	}
	// A whole number written with a fraction or an exponent is still that number.
	m := send(`{"at":9007199254740993.0,"n":1e3,"price":1,"ratio":1,"k":2e1}`)
	d := r.data("messages.decode", map[string]any{"value": m["value"]})
	if got := d["json"].(string); !strings.Contains(got, `"at":9007199254740993`) || !strings.Contains(got, `"k":20`) {
		t.Errorf("a whole number with a fraction or an exponent: %s", got)
	}

	// Never rounded: a fraction, a number out of the width and a wrong type name the field.
	before := r.count("logs")
	for _, tc := range []struct{ value, want, code string }{
		{`{"at":1.5,"n":null,"price":1,"ratio":1,"k":1}`, "at: 1.5 is not a whole number", "EKAFKA"},
		{`{"at":9223372036854775808,"n":null,"price":1,"ratio":1,"k":1}`, "64-bit", "EKAFKA"},
		{`{"at":1,"n":null,"price":1,"ratio":1,"k":2147483648}`, "32-bit", "EKAFKA"},
		{`{"at":1e999999999,"n":null,"price":1,"ratio":1,"k":1}`, "64-bit", "EKAFKA"},
		{`{"at":1,"n":null,"price":1,"ratio":1,"k":1} {"x":1}`, "not JSON", "EPARAM"},
	} {
		r.fails("messages.produce", map[string]any{
			"topic": "logs", "value": tc.value, "schema": map[string]any{"subject": "events-value", "version": -1},
		}, tc.code, tc.want)
	}
	if n := r.count("logs"); n != before {
		t.Fatalf("a refused value reached the topic: %d message(s) more", n-before)
	}
}
