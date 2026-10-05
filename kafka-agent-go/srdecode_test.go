package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/iskorotkov/avro/v2"
	"github.com/twmb/franz-go/pkg/sr"
	"github.com/twmb/franz-go/pkg/sr/srfake"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/dynamicpb"
)

// wire is the bytes a Confluent serializer writes: a magic byte, the schema's id as four
// bytes, then the payload of the schema's own format.
func wire(t *testing.T, id int, payload []byte) string {
	t.Helper()
	out := make([]byte, headerLen, headerLen+len(payload))
	out[0] = magicByte
	binary.BigEndian.PutUint32(out[1:headerLen], uint32(id))
	return base64.StdEncoding.EncodeToString(append(out, payload...))
}

// decodingRig is a rig whose cluster has a registry with the given schemas registered.
func decodingRig(t *testing.T, schemas map[string]sr.Schema) (*rig, *srfake.Registry) {
	t.Helper()
	reg := srfake.New()
	t.Cleanup(reg.Close)
	for subject, s := range schemas {
		if _, _, err := reg.RegisterSchema(subject, s); err != nil {
			t.Fatalf("%s: %v", subject, err)
		}
	}
	r := newRig(t)
	r.withRegistry(reg.URL(), "", "", nil)
	return r, reg
}

// schemaID is the id the registry gave the one schema of a subject.
func schemaID(t *testing.T, reg *srfake.Registry, subject string) int {
	t.Helper()
	s, ok := reg.GetSchema(subject, 1)
	if !ok {
		t.Fatalf("no schema for %s", subject)
	}
	return s.ID
}

// Avro: what a producer wrote with the schema is what the viewer shows.
func TestDecodeAnAvroValue(t *testing.T) {
	const text = `{"type":"record","name":"Order","fields":[{"name":"id","type":"int"},{"name":"note","type":"string"}]}`
	r, reg := decodingRig(t, map[string]sr.Schema{"orders-value": {Schema: text, Type: sr.TypeAvro}})
	id := schemaID(t, reg, "orders-value")

	sch, err := avro.Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := avro.Marshal(sch, map[string]any{"id": 7, "note": "привет"})
	if err != nil {
		t.Fatal(err)
	}

	d := r.data("messages.decode", map[string]any{"value": wire(t, id, payload)})
	if d["schemaId"].(float64) != float64(id) || d["schemaType"] != "AVRO" {
		t.Fatalf("what the value carries: %v", d)
	}
	if d["subject"] != "orders-value" || d["version"].(float64) != 1 {
		t.Errorf("where the schema is registered: subject %v, version %v", d["subject"], d["version"])
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(d["json"].(string)), &got); err != nil {
		t.Fatalf("the JSON: %v (%q)", err, d["json"])
	}
	if got["id"].(float64) != 7 || got["note"] != "привет" {
		t.Fatalf("the decoded value: %v", got)
	}
}

// JSON Schema: the payload is already JSON, and comes back as it is.
func TestDecodeAJSONSchemaValue(t *testing.T) {
	const text = `{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}`
	r, reg := decodingRig(t, map[string]sr.Schema{"events-value": {Schema: text, Type: sr.TypeJSON}})
	id := schemaID(t, reg, "events-value")

	d := r.data("messages.decode", map[string]any{"value": wire(t, id, []byte(`{"id":3,"what":"click"}`))})
	if d["schemaType"] != "JSON" {
		t.Fatalf("type: %v", d)
	}
	if d["json"] != `{"id":3,"what":"click"}` {
		t.Fatalf("json: %v", d["json"])
	}
	r.fails("messages.decode", map[string]any{"value": wire(t, id, []byte(`{not json`))}, "EKAFKA", "not the JSON")
}

// Protobuf: the indexes say which message of the file the payload holds, and the message is
// read without any generated Go code — the schema is compiled at the agent.
func TestDecodeAProtobufValue(t *testing.T) {
	const text = `syntax = "proto3";
package acme;

message Order {
  int32 id = 1;
  string note = 2;
}

message Other {
  string what = 1;
}
`
	r, reg := decodingRig(t, map[string]sr.Schema{"orders-value": {Schema: text, Type: sr.TypeProtobuf}})
	id := schemaID(t, reg, "orders-value")

	desc := mustCompile(t, text, "acme.Order")
	payload := marshalProto(t, desc, map[string]any{"id": 9, "note": "hello"})

	// The writer's shorthand for the first message of the file: a count of zero.
	d := r.data("messages.decode", map[string]any{"value": wire(t, id, append([]byte{0}, payload...))})
	if d["schemaType"] != "PROTOBUF" || d["message"] != "acme.Order" {
		t.Fatalf("what the value carries: %v", d)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(d["json"].(string)), &got); err != nil {
		t.Fatalf("the JSON: %v (%q)", err, d["json"])
	}
	if got["id"].(float64) != 9 || got["note"] != "hello" {
		t.Fatalf("the decoded value: %v", got)
	}

	// The second message, named by its index: count 1, index 1.
	other := mustCompile(t, text, "acme.Other")
	body := marshalProto(t, other, map[string]any{"what": "click"})
	d = r.data("messages.decode", map[string]any{"value": wire(t, id, append([]byte{1, 1}, body...))})
	if d["message"] != "acme.Other" {
		t.Fatalf("the second message: %v", d)
	}
	if !strings.Contains(d["json"].(string), `"click"`) {
		t.Fatalf("the decoded value: %v", d["json"])
	}

	// An index the file does not have is the value's own fault, and is said so; so is a
	// count that promises more indexes than the value holds.
	r.fails("messages.decode", map[string]any{"value": wire(t, id, append([]byte{1, 9}, body...))}, "EKAFKA", "names message 9")
	r.fails("messages.decode", map[string]any{"value": wire(t, id, []byte{2, 0})}, "EKAFKA", "message indexes")
	// A field index that is out of the message, or names something that is not a message.
	r.fails("messages.decode", map[string]any{"value": wire(t, id, append([]byte{2, 0, 9}, body...))}, "EKAFKA", "names field 9")
}

// A nested message: the first index picks the message of the file, the rest pick fields of
// the message before — the path Confluent's own deserializer follows.
func TestDecodeANestedProtobufMessage(t *testing.T) {
	const text = `syntax = "proto3";
package acme;

message Outer {
  message Inner {
    string s = 1;
  }
  Inner inner = 1;
}
`
	r, reg := decodingRig(t, map[string]sr.Schema{"nested-value": {Schema: text, Type: sr.TypeProtobuf}})
	id := schemaID(t, reg, "nested-value")
	desc := mustCompile(t, text, "acme.Outer.Inner")
	payload := marshalProto(t, desc, map[string]any{"s": "deep"})

	// Outer is the first message of the file; its own first field is Inner.
	d := r.data("messages.decode", map[string]any{"value": wire(t, id, append([]byte{2, 0, 0}, payload...))})
	if d["message"] != "acme.Outer.Inner" || !strings.Contains(d["json"].(string), `"deep"`) {
		t.Fatalf("the nested message: %v", d)
	}
}

// What is not a schema-encoded value is refused in words a person can act on, and never by
// a decoder's own error.
func TestDecodeRefusesWhatIsNotASchemaValue(t *testing.T) {
	r, reg := decodingRig(t, map[string]sr.Schema{"orders-value": {Schema: `"string"`, Type: sr.TypeAvro}})
	id := schemaID(t, reg, "orders-value")

	r.fails("messages.decode", map[string]any{"value": base64.StdEncoding.EncodeToString([]byte("just text"))}, "EPARAM", "does not carry a schema")
	r.fails("messages.decode", map[string]any{"value": base64.StdEncoding.EncodeToString([]byte{0, 1})}, "EPARAM", "does not carry a schema")
	r.fails("messages.decode", map[string]any{"value": "not base64 at all!!"}, "EPARAM", "not base64")
	// An id no one registered: the registry's own answer, with what it means for the value.
	r.fails("messages.decode", map[string]any{"value": wire(t, id+9999, []byte{1})}, "EKAFKA", "is not in the registry")
	// The right envelope, the wrong payload for that schema: Avro says so itself.
	r.fails("messages.decode", map[string]any{"value": wire(t, id, []byte{0x7f})}, "EKAFKA", "not the Avro")

	// A cluster without a registry says so, and names the setting to add.
	plain := newRig(t)
	plain.fails("messages.decode", map[string]any{"value": wire(t, id, []byte{1})}, "ENOREGISTRY", "schemaRegistry")
}

// A schema is fetched and parsed once, not for every message: a topic of a thousand
// schema-encoded messages is a thousand decodes and one read of the registry.
func TestDecodeKeepsTheSchema(t *testing.T) {
	r, reg := decodingRig(t, map[string]sr.Schema{"orders-value": {Schema: `"string"`, Type: sr.TypeAvro}})
	id := schemaID(t, reg, "orders-value")

	var asks atomic.Int64
	reg.Intercept(func(w http.ResponseWriter, req *http.Request) bool {
		if strings.HasPrefix(req.URL.Path, "/schemas/ids/") {
			asks.Add(1)
		}
		return false // and let the registry answer as usual
	})

	payload, err := avro.Marshal(mustAvro(t, `"string"`), "hello")
	if err != nil {
		t.Fatal(err)
	}
	value := wire(t, id, payload)
	for i := 0; i < 5; i++ {
		if d := r.data("messages.decode", map[string]any{"value": value}); d["json"] != `"hello"` {
			t.Fatalf("decode %d: %v", i, d)
		}
	}
	// The first decode asks about the schema's versions as well; what must not happen is a
	// read per message. Both requests are counted together, so the bound is generous.
	if n := asks.Load(); n > 3 {
		t.Fatalf("%d registry reads for five decodes: the schema is not kept", n)
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

func mustAvro(t *testing.T, text string) avro.Schema {
	t.Helper()
	sch, err := avro.Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	return sch
}

// mustCompile uses the agent's own compiler, so the test and the decoder agree on the
// message the indexes name.
func mustCompile(t *testing.T, text, name string) protoreflect.MessageDescriptor {
	t.Helper()
	first, err := compileProto(text)
	if err != nil {
		t.Fatal(err)
	}
	if found := findMessage(first.ParentFile().Messages(), protoreflect.FullName(name)); found != nil {
		return found
	}
	t.Fatalf("no message %s in the schema", name)
	return nil
}

// findMessage looks through a file's messages and everything nested inside them.
func findMessage(messages protoreflect.MessageDescriptors, name protoreflect.FullName) protoreflect.MessageDescriptor {
	for i := 0; i < messages.Len(); i++ {
		m := messages.Get(i)
		if m.FullName() == name {
			return m
		}
		if nested := findMessage(m.Messages(), name); nested != nil {
			return nested
		}
	}
	return nil
}

func marshalProto(t *testing.T, desc protoreflect.MessageDescriptor, fields map[string]any) []byte {
	t.Helper()
	msg := dynamicpb.NewMessage(desc)
	for name, value := range fields {
		fd := desc.Fields().ByName(protoreflect.Name(name))
		if fd == nil {
			t.Fatalf("no field %s in %s", name, desc.FullName())
		}
		switch v := value.(type) {
		case string:
			msg.Set(fd, protoreflect.ValueOfString(v))
		case int:
			msg.Set(fd, protoreflect.ValueOfInt32(int32(v)))
		}
	}
	out, err := proto.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// The fields of a record come back in the order the schema lists them, nested records and
// unions included, not in the order of the alphabet (N-03).
func TestDecodeAnAvroRecordInTheOrderOfItsSchema(t *testing.T) {
	const text = `{"type":"record","name":"Order","fields":[
		{"name":"id","type":"long"},
		{"name":"customer","type":{"type":"record","name":"Customer","fields":[{"name":"name","type":"string"},{"name":"city","type":"string"},{"name":"age","type":"int"}]}},
		{"name":"amount","type":"double"},
		{"name":"currency","type":"string"},
		{"name":"note","type":["null","Customer"],"default":null},
		{"name":"tags","type":{"type":"array","items":"string"}},
		{"name":"attrs","type":{"type":"map","values":"int"}}]}`
	r, reg := decodingRig(t, map[string]sr.Schema{"orders-value": {Schema: text, Type: sr.TypeAvro}})
	id := schemaID(t, reg, "orders-value")

	sch, err := avro.Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := avro.Marshal(sch, map[string]any{
		"id": int64(9007199254740993), "customer": map[string]any{"name": "Ann", "city": "Oslo", "age": 31},
		"amount": 10.5, "currency": "EUR", "note": map[string]any{"Customer": map[string]any{"name": "N", "city": "Rome", "age": 2}},
		"tags": []any{"a", "b"}, "attrs": map[string]any{"z": 1, "b": 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	d := r.data("messages.decode", map[string]any{"value": wire(t, id, payload)})
	const want = `{"id":9007199254740993,"customer":{"name":"Ann","city":"Oslo","age":31},"amount":10.5,"currency":"EUR","note":{"Customer":{"name":"N","city":"Rome","age":2}},"tags":["a","b"],"attrs":{"b":2,"z":1}}`
	if d["json"] != want {
		t.Fatalf("json:\n got %v\nwant %s", d["json"], want)
	}
}
