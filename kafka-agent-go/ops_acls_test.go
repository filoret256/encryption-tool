package main

import (
	"testing"

	"github.com/twmb/franz-go/pkg/kadm"
)

// The ACL listing: what the cluster says a login may do, with every field the page shows —
// principal, host, resource, pattern, operation, permission.
func TestListingACLs(t *testing.T) {
	r := newRig(t)
	// The rig's fake cluster takes ACLs as Kafka does, so the filter the agent builds is
	// exercised against a broker rather than against a table in the test.
	adm := kadm.NewClient(r.producer())
	if _, err := adm.CreateACLs(t.Context(),
		kadm.NewACLs().Allow("User:app").AllowHosts("10.0.0.1").Topics("orders").Operations(kadm.OpRead, kadm.OpWrite),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := adm.CreateACLs(t.Context(),
		kadm.NewACLs().Deny("User:mallory").Groups("billing").ResourcePatternType(kadm.ACLPatternPrefixed).Operations(kadm.OpAll),
	); err != nil {
		t.Fatal(err)
	}

	d := r.data("acls.list", nil)
	entries := d["acls"].([]any)
	// Two operations for the allowed topic, one for the denied group.
	if len(entries) != 3 {
		t.Fatalf("%d entries, want 3:\n%v", len(entries), entries)
	}
	// Sorted by principal, then by what: app's two topic operations, then mallory's group.
	first := entries[0].(map[string]any)
	if first["principal"] != "User:app" || first["resourceType"] != "topic" || first["resourceName"] != "orders" {
		t.Errorf("the first entry: %v", first)
	}
	if first["host"] != "10.0.0.1" || first["permission"] != "allow" || first["patternType"] != "literal" {
		t.Errorf("how it applies: %v", first)
	}
	if entries[1].(map[string]any)["operation"] != "WRITE" || first["operation"] != "READ" {
		t.Errorf("the two operations: %v, %v", first["operation"], entries[1].(map[string]any)["operation"])
	}
	// A prefixed, denied ACL, on a group, for any host.
	last := entries[2].(map[string]any)
	if last["principal"] != "User:mallory" || last["resourceType"] != "group" || last["resourceName"] != "billing" {
		t.Errorf("the denied entry: %v", last)
	}
	if last["patternType"] != "prefixed" || last["permission"] != "deny" || last["operation"] != "ALL" || last["host"] != "*" {
		t.Errorf("how it applies: %v", last)
	}
}

// A cluster with no ACLs answers with none — not with an error, and not with null.
func TestListingACLsOnAClusterWithoutAny(t *testing.T) {
	r := newRig(t)
	d := r.data("acls.list", nil)
	if entries, ok := d["acls"].([]any); !ok || len(entries) != 0 {
		t.Fatalf("an empty listing: %v", d)
	}
}
