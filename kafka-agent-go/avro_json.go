package main

import (
	"bytes"
	"encoding/json"
	"sort"

	"github.com/iskorotkov/avro/v2"
)

// avroJSON writes a decoded Avro value as JSON with the fields of every record in the
// order the schema lists them (N-03).
//
// The library hands a record back as map[string]any, and encoding/json sorts a map's keys:
// {"id", "customer", "amount", "currency", "tags"} would come out as "amount", "currency",
// "customer", "id", "tags". The schema's order is the order a person wrote the record in
// and the order every other tool shows it in, so the text follows the schema. A map type
// has no order in Avro; its keys stay sorted. The rest is encoding/json's own.
func avroJSON(s avro.Schema, v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeAvroJSON(&buf, s, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeAvroJSON(buf *bytes.Buffer, s avro.Schema, v any) error {
	if ref, ok := s.(*avro.RefSchema); ok {
		s = ref.Schema()
	}
	if u, ok := s.(*avro.UnionSchema); ok {
		// A union member that is not null is handed back wrapped in a one-entry map named
		// for its branch ({"Customer": {...}}). The wrapper stays; what is inside follows
		// the branch's own schema.
		if m, ok := v.(map[string]any); ok && len(m) == 1 {
			for key, item := range m {
				if branch, _ := u.Types().Get(key); branch != nil {
					name, err := json.Marshal(key)
					if err != nil {
						return err
					}
					buf.WriteByte('{')
					buf.Write(name)
					buf.WriteByte(':')
					if err := writeAvroJSON(buf, branch, item); err != nil {
						return err
					}
					buf.WriteByte('}')
					return nil
				}
			}
		}
		s = unionBranchFor(u, v)
	}
	switch value := v.(type) {
	case map[string]any:
		switch schema := s.(type) {
		case *avro.RecordSchema:
			buf.WriteByte('{')
			first := true
			put := func(key string, item any, itemSchema avro.Schema) error {
				if !first {
					buf.WriteByte(',')
				}
				first = false
				name, err := json.Marshal(key)
				if err != nil {
					return err
				}
				buf.Write(name)
				buf.WriteByte(':')
				return writeAvroJSON(buf, itemSchema, item)
			}
			seen := make(map[string]bool, len(value))
			for _, f := range schema.Fields() {
				item, ok := value[f.Name()]
				if !ok {
					continue
				}
				seen[f.Name()] = true
				if err := put(f.Name(), item, f.Type()); err != nil {
					return err
				}
			}
			// What the schema does not list (the library should not produce it) goes last,
			// sorted, so nothing is lost.
			for _, key := range sortedKeys(value) {
				if !seen[key] {
					if err := put(key, value[key], nil); err != nil {
						return err
					}
				}
			}
			buf.WriteByte('}')
			return nil
		case *avro.MapSchema:
			buf.WriteByte('{')
			for i, key := range sortedKeys(value) {
				if i > 0 {
					buf.WriteByte(',')
				}
				name, err := json.Marshal(key)
				if err != nil {
					return err
				}
				buf.Write(name)
				buf.WriteByte(':')
				if err := writeAvroJSON(buf, schema.Values(), value[key]); err != nil {
					return err
				}
			}
			buf.WriteByte('}')
			return nil
		}
	case []any:
		if schema, ok := s.(*avro.ArraySchema); ok {
			buf.WriteByte('[')
			for i, item := range value {
				if i > 0 {
					buf.WriteByte(',')
				}
				if err := writeAvroJSON(buf, schema.Items(), item); err != nil {
					return err
				}
			}
			buf.WriteByte(']')
			return nil
		}
	}
	text, err := json.Marshal(v)
	if err != nil {
		return err
	}
	buf.Write(text)
	return nil
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// unionBranchFor is the branch of a union a decoded value belongs to, by its kind: a
// record or a map is a map[string]any, an array a []any. Anything else needs no schema to
// be written, so the union itself is returned and the value falls through to encoding/json.
func unionBranchFor(u *avro.UnionSchema, v any) avro.Schema {
	want := func(types ...avro.Type) avro.Schema {
		for _, branch := range u.Types() {
			t := branch.Type()
			if t == avro.Ref {
				t = branch.(*avro.RefSchema).Schema().Type()
			}
			for _, w := range types {
				if t == w {
					return branch
				}
			}
		}
		return u
	}
	switch v.(type) {
	case map[string]any:
		return want(avro.Record, avro.Map)
	case []any:
		return want(avro.Array)
	}
	return u
}
