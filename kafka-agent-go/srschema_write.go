// Writing to a Schema Registry (K-47): a new version of a subject, and the compatibility
// level a subject is held to.
//
// The registry is a service beside the cluster, but the permission is the operator's
// decision about the cluster: these are writeOps, so a read-only cluster refuses them
// before anything is sent, and one switch stays the whole of "this agent changes nothing
// here". A registry of its own may also answer READONLY, and then its words are what the
// page shows.
//
// A schema's text is never logged and never named in an error (audit.go): it describes the
// cluster's data, and what the write log needs to say is which subject and version moved.
package main

import (
	"fmt"
	"strings"

	"github.com/twmb/franz-go/pkg/sr"
)

// ── schemas.check ─────────────────────────────────────────────────────────

// schemasCheck asks the registry whether it would take a schema, and changes nothing: a
// read, so it is allowed on a read-only cluster. It is what the page's register dialog asks
// before the write, and the reason is the registry's own — whether a field was removed, a
// type changed, or the subject does not exist yet.
func schemasCheck(c *opCtx, p checkSchemaParams) (any, error) {
	if p.Subject == "" {
		return nil, &opError{Code: "EPARAM", Message: "No subject to check the schema against"}
	}
	if p.Schema == "" {
		return nil, &opError{Code: "EPARAM", Message: "No schema to check"}
	}
	if p.Version == 0 || p.Version < -2 {
		return nil, &opError{Code: "EPARAM", Message: "Which version to check against: 1 or more, -1 for the latest, or -2 for all of them"}
	}
	s, err := schemaFrom(p.Schema, p.Type, p.References)
	if err != nil {
		return nil, err
	}
	cl, client, ctx, cancel, err := registryFor(c, p.Cluster)
	if err != nil {
		return nil, err
	}
	defer cancel()
	res, err := client.CheckCompatibility(ctx, p.Subject, p.Version, s)
	if err != nil {
		return nil, registryFailure(cl, fmt.Sprintf("check a schema against %q", p.Subject), err)
	}
	messages := res.Messages
	if messages == nil {
		messages = []string{}
	}
	return schemaCheck{Compatible: res.Is, Messages: messages}, nil
}

// ── schemas.register ──────────────────────────────────────────────────────

// schemasRegister writes a new version of a subject. The registry checks compatibility
// itself (unless its level is NONE) and refuses with its own words; the page asks
// schemas.check first so that the refusal, when it comes, is expected.
func schemasRegister(c *opCtx, p registerSchemaParams) (any, error) {
	if p.Subject == "" {
		return nil, &opError{Code: "EPARAM", Message: "No subject to register the schema under"}
	}
	if p.Schema == "" {
		return nil, &opError{Code: "EPARAM", Message: "No schema to register"}
	}
	s, err := schemaFrom(p.Schema, p.Type, p.References)
	if err != nil {
		return nil, err
	}
	cl, client, ctx, cancel, err := registryFor(c, p.Cluster)
	if err != nil {
		return nil, err
	}
	defer cancel()
	got, err := client.CreateSchema(ctx, p.Subject, s)
	if err != nil {
		return nil, registryFailure(cl, fmt.Sprintf("register a version of %q", p.Subject), err)
	}
	return registeredSchema{Subject: got.Subject, Version: got.Version, ID: got.ID, Type: schemaTypeOf(got.Type)}, nil
}

// ── schemas.setCompatibility ──────────────────────────────────────────────

// schemasSetCompatibility sets a subject's own level, or — with no subject — the
// registry's default for subjects that have none of their own. An empty level takes the
// subject back to that default, which is not the same as setting it to the default's
// current value: the registry's default may change afterwards, and a subject that follows
// it follows.
func schemasSetCompatibility(c *opCtx, p setCompatibilityParams) (any, error) {
	var level sr.CompatibilityLevel
	if p.Level != "" {
		var err error
		level, err = compatibilityLevel(p.Level)
		if err != nil {
			return nil, err
		}
	}
	cl, client, ctx, cancel, err := registryFor(c, p.Cluster)
	if err != nil {
		return nil, err
	}
	defer cancel()
	doing := "set the compatibility of the registry"
	if p.Subject != "" {
		doing = fmt.Sprintf("set the compatibility of %q", p.Subject)
	}
	var results []sr.CompatibilityResult
	if p.Level == "" {
		results = client.ResetCompatibility(ctx, p.Subject)
	} else {
		results = client.SetCompatibility(ctx, sr.SetCompatibility{Level: level}, p.Subject)
	}
	if len(results) == 0 {
		return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("Could not %s on cluster %q: the registry answered nothing", doing, cl.Name)}
	}
	if results[0].Err != nil {
		return nil, registryFailure(cl, doing, results[0].Err)
	}
	// What is in force afterwards is read back rather than taken from the answer. A
	// registry reports the level it now holds, and the shapes differ: a DELETE answers
	// with the level on one registry and with nothing useful on another, and a registry
	// may hold a subject to a level it chose over the one it was asked for. This is the
	// same read the schema browser makes, and it answers with the registry's default when
	// the subject has just gone back to following it.
	if levels := client.Compatibility(ctx, p.Subject); len(levels) > 0 && levels[0].Err == nil {
		return compatibilitySet{Subject: p.Subject, Level: levels[0].Level.String()}, nil
	}
	return compatibilitySet{Subject: p.Subject, Level: results[0].Level.String()}, nil
}

// ── shared ────────────────────────────────────────────────────────────────

// schemaFrom checks the three parts of a schema from the page and makes the registry's own
// shape of it. The type is checked here rather than left to the registry: a type the agent
// cannot name is a request it should not send, and "AVRO" is what the registry means by a
// schema with no type at all.
func schemaFrom(text, typ string, refs []schemaReference) (sr.Schema, error) {
	schemaType, err := schemaTypeFrom(typ)
	if err != nil {
		return sr.Schema{}, err
	}
	out := sr.Schema{Schema: text, Type: schemaType}
	for i, r := range refs {
		if r.Name == "" || r.Subject == "" {
			return sr.Schema{}, &opError{Code: "EPARAM", Message: fmt.Sprintf("Reference %d: a name and a subject are both needed", i+1)}
		}
		if r.Version < 1 {
			return sr.Schema{}, &opError{Code: "EPARAM", Message: fmt.Sprintf("Reference %q: a version number, 1 or more", trimTo(r.Name, 40))}
		}
		out.References = append(out.References, sr.SchemaReference{Name: r.Name, Subject: r.Subject, Version: r.Version})
	}
	return out, nil
}

// schemaTypeFrom is the format the registry should read the text as. Empty is Avro, which
// is what the registry itself assumes for a schema that does not say.
func schemaTypeFrom(typ string) (sr.SchemaType, error) {
	switch strings.ToUpper(strings.TrimSpace(typ)) {
	case "", "AVRO":
		return sr.TypeAvro, nil
	case "PROTOBUF":
		return sr.TypeProtobuf, nil
	case "JSON":
		return sr.TypeJSON, nil
	}
	return 0, &opError{Code: "EPARAM", Message: fmt.Sprintf("A schema of type %q cannot be registered by this agent (Avro, Protobuf and JSON Schema it can)", trimTo(typ, 40))}
}

// theLevels is every level the registry knows, in the order the page offers them: the
// least strict first, because that is the order in which they cost a person something.
var theLevels = []sr.CompatibilityLevel{
	sr.CompatNone, sr.CompatBackward, sr.CompatBackwardTransitive,
	sr.CompatForward, sr.CompatForwardTransitive,
	sr.CompatFull, sr.CompatFullTransitive,
}

// compatibilityLevel turns the page's word into the registry's own. An unknown one is
// refused here, with the whole list: the registry would answer with a code, and a person
// would have to look up what it means.
func compatibilityLevel(name string) (sr.CompatibilityLevel, error) {
	up := strings.ToUpper(strings.TrimSpace(name))
	for _, l := range theLevels {
		if l.String() == up {
			return l, nil
		}
	}
	names := make([]string, len(theLevels))
	for i, l := range theLevels {
		names[i] = l.String()
	}
	return 0, &opError{Code: "EPARAM", Message: fmt.Sprintf("Unknown compatibility level %q: %s", trimTo(name, 40), strings.Join(names, ", "))}
}
