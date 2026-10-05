package main

import (
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/twmb/franz-go/pkg/sr"
	"github.com/twmb/franz-go/pkg/sr/srfake"
)

// What the tests of both schema tasks are made of: a cluster that may be written to, with a
// registry behind it, and the two readings of a message that was written with a schema —
// the header on the topic, and the JSON the same bytes decode to.
//
// The K-45 tests (ops_schema_produce_test.go) send by a schema; the K-47 tests
// (srschema_write_test.go) register the versions they are written with. Both start here.

// avroOrder is the first version of a record, used by most of these tests.
const avroOrder = `{"type":"record","name":"Order","fields":[{"name":"id","type":"int"},{"name":"note","type":"string"}]}`

// producingRig is a cluster that may be written to, with a registry holding the given
// schemas. decodingRig makes the read-only one; a send needs it writable.
func producingRig(t *testing.T, schemas map[string]sr.Schema) (*rig, *srfake.Registry) {
	t.Helper()
	r, reg := decodingRig(t, schemas)
	r.writable()
	return r, reg
}

// sendWithSchema produces one message and reads it back from the topic: what the tests
// check is the bytes, and the bytes are only on the topic.
func (r *rig) sendWithSchema(t *testing.T, params map[string]any) map[string]any {
	t.Helper()
	got := r.data("messages.produce", params)
	topic, _ := params["topic"].(string)
	partition := int(got["partition"].(float64))
	offset := int(got["offset"].(float64))
	return r.data("messages.get", map[string]any{"topic": topic, "partition": partition, "offset": offset})
}

// headerID is the id of the schema a value carries: a magic byte, then the id. A reader
// finds the schema by that id and nothing else, so the header is the whole point of the
// format.
func headerID(t *testing.T, value any) int {
	t.Helper()
	raw := mustB64(t, value)
	if len(raw) < headerLen || raw[0] != magicByte {
		t.Fatalf("the value does not carry the Confluent header: %v", raw)
	}
	return int(binary.BigEndian.Uint32(raw[1:headerLen]))
}

// decodedJSON is what a value read with the schema it carries holds.
func decodedJSON(t *testing.T, d map[string]any) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(d["json"].(string)), &out); err != nil {
		t.Fatalf("the decoded JSON: %v (%q)", err, d["json"])
	}
	return out
}
