package main

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/twmb/franz-go/pkg/sr"
	"github.com/twmb/franz-go/pkg/sr/srfake"
)

// The three reads of the schema browser: what the registry holds, one subject's versions
// with its own compatibility and mode, and the text of one version.
func TestReadingWhatTheRegistryHolds(t *testing.T) {
	const first = `{"type":"record","name":"Order","fields":[{"name":"id","type":"int"}]}`
	const second = `{"type":"record","name":"Order","fields":[{"name":"id","type":"int"},{"name":"note","type":"string"}]}`
	reg := srfake.New()
	t.Cleanup(reg.Close)
	for _, s := range []struct {
		subject string
		schema  sr.Schema
	}{
		{"orders-value", sr.Schema{Schema: first, Type: sr.TypeAvro}},
		{"events-value", sr.Schema{Schema: `syntax = "proto3"; message Event { string what = 1; }`, Type: sr.TypeProtobuf}},
	} {
		if _, _, err := reg.RegisterSchema(s.subject, s.schema); err != nil {
			t.Fatal(err)
		}
	}
	// A second version of one of them: what a diff is made of.
	if _, _, err := reg.RegisterSchema("orders-value", sr.Schema{Schema: second, Type: sr.TypeAvro}); err != nil {
		t.Fatal(err)
	}

	r := newRig(t)
	r.withRegistry(reg.URL(), "", "", nil)

	// ── the subjects ──
	d := r.data("schemas.subjects", nil)
	var subjects []string
	for _, s := range d["subjects"].([]any) {
		subjects = append(subjects, s.(string))
	}
	if len(subjects) != 2 || subjects[0] != "events-value" || subjects[1] != "orders-value" {
		t.Fatalf("the subjects: %v", subjects)
	}

	// ── one subject's versions ──
	v := r.data("schemas.versions", map[string]any{"subject": "orders-value"})
	if v["subject"] != "orders-value" {
		t.Fatalf("the subject: %v", v)
	}
	if v["compatibility"] != "BACKWARD" {
		t.Errorf("the registry's default compatibility: %v", v["compatibility"])
	}
	if v["mode"] != "READWRITE" {
		t.Errorf("mode: %v", v["mode"])
	}
	versions := v["versions"].([]any)
	if len(versions) != 2 {
		t.Fatalf("versions: %v", versions)
	}
	for i, x := range versions {
		m := x.(map[string]any)
		if int(m["version"].(float64)) != i+1 || m["type"] != "AVRO" {
			t.Errorf("version %d: %v", i+1, m)
		}
		if m["id"].(float64) <= 0 {
			t.Errorf("version %d has no schema id: %v", i+1, m)
		}
	}
	// A Protobuf subject says so.
	p := r.data("schemas.versions", map[string]any{"subject": "events-value"})
	if p["versions"].([]any)[0].(map[string]any)["type"] != "PROTOBUF" {
		t.Errorf("the Protobuf subject: %v", p["versions"])
	}

	// ── one version's text ──
	one := r.data("schemas.version", map[string]any{"subject": "orders-value", "version": 1})
	if one["subject"] != "orders-value" || one["version"].(float64) != 1 || one["type"] != "AVRO" {
		t.Fatalf("the version: %v", one)
	}
	if one["schema"] != first {
		t.Errorf("version 1's text: %q", one["schema"])
	}
	if refs := one["references"].([]any); len(refs) != 0 {
		t.Errorf("references: %v", refs)
	}
	// -1 is the registry's own shorthand for the latest, and it is not version 1.
	latest := r.data("schemas.version", map[string]any{"subject": "orders-value", "version": -1})
	if latest["version"].(float64) != 2 || latest["schema"] != second {
		t.Fatalf("the latest version: %v", latest)
	}
	if latest["id"] == one["id"] {
		t.Error("two versions of one subject share a schema id")
	}
}

// What the registry refuses, the page is told in the registry's own words.
func TestReadingSchemasRefusesWhatIsNotThere(t *testing.T) {
	reg := srfake.New()
	t.Cleanup(reg.Close)
	if _, _, err := reg.RegisterSchema("orders-value", sr.Schema{Schema: `"string"`, Type: sr.TypeAvro}); err != nil {
		t.Fatal(err)
	}
	r := newRig(t)
	r.withRegistry(reg.URL(), "", "", nil)

	r.fails("schemas.versions", map[string]any{"subject": "no-such-subject"}, "EKAFKA", "no-such-subject")
	r.fails("schemas.version", map[string]any{"subject": "orders-value", "version": 99}, "EKAFKA", "99")
	r.fails("schemas.versions", map[string]any{"subject": ""}, "EPARAM", "No subject")
	r.fails("schemas.version", map[string]any{"subject": "orders-value", "version": 0}, "EPARAM", "version number")

	// A cluster with no registry says so, and names the setting to add — for every read.
	plain := newRig(t)
	plain.fails("schemas.subjects", nil, "ENOREGISTRY", "schemaRegistry")
	plain.fails("schemas.versions", map[string]any{"subject": "orders-value"}, "ENOREGISTRY", "schemaRegistry")
	plain.fails("schemas.version", map[string]any{"subject": "orders-value", "version": 1}, "ENOREGISTRY", "schemaRegistry")

	// A registry that refuses the login: the sentence names the setting, not the decoder.
	auth := srfake.New(srfake.WithAuth("Basic " + base64.StdEncoding.EncodeToString([]byte("app:right"))))
	t.Cleanup(auth.Close)
	locked := newRig(t)
	locked.withRegistry(auth.URL(), "app", "wrong", nil)
	_, m := locked.call("schemas.subjects", nil)
	if m["ok"] == true || !strings.Contains(m["error"].(string), "refused the login") {
		t.Errorf("a refused login: %v", m)
	}
}
