// Reading what a Schema Registry holds: its subjects, their versions, and the text of one
// version — which is what the page's schema browser needs, and what a diff of two versions
// is made of (K-43).
//
// Everything here is a read. Registering a version and changing a compatibility level are
// K-47, and they are write ops: the registry's mode can be READONLY, and the cluster's
// read-only setting is not the registry's to obey.
package main

import (
	"context"
	"fmt"
	"sort"

	"github.com/twmb/franz-go/pkg/sr"
)

// ── schemas.subjects ──────────────────────────────────────────────────────

func schemasSubjects(c *opCtx, p clusterParams) (any, error) {
	cl, client, ctx, cancel, err := registryFor(c, p.Cluster)
	if err != nil {
		return nil, err
	}
	defer cancel()
	subjects, err := client.Subjects(ctx)
	if err != nil {
		return nil, registryFailure(cl, "read the subjects", err)
	}
	sort.Strings(subjects)
	if subjects == nil {
		subjects = []string{}
	}
	return subjectNames{Subjects: subjects}, nil
}

// ── schemas.versions ──────────────────────────────────────────────────────

// schemasVersions reads one subject's versions.
//
// The registry has no endpoint that answers "every version of this subject with its id and
// type": it has one for the version numbers, and one per version for the rest. So this
// costs one request per version — which is why it is asked when a subject is opened, and
// not for every subject in the list.
func schemasVersions(c *opCtx, p subjectParams) (any, error) {
	cl, client, ctx, cancel, err := registryFor(c, p.Cluster)
	if err != nil {
		return nil, err
	}
	defer cancel()
	if p.Subject == "" {
		return nil, &opError{Code: "EPARAM", Message: "No subject to read"}
	}
	schemas, err := client.Schemas(ctx, p.Subject)
	if err != nil {
		return nil, registryFailure(cl, fmt.Sprintf("read the versions of %q", p.Subject), err)
	}
	out := subjectVersions{Subject: p.Subject, Versions: make([]schemaVersion, 0, len(schemas))}
	for _, s := range schemas {
		out.Versions = append(out.Versions, schemaVersion{Version: s.Version, ID: s.ID, Type: schemaTypeOf(s.Type)})
	}
	// A level or mode of its own, or the registry's: both are worth showing, and neither is
	// worth failing over — an old registry may not answer for a subject at all.
	if levels := client.Compatibility(ctx, p.Subject); len(levels) > 0 && levels[0].Err == nil {
		level := levels[0].Level.String()
		if level != "" {
			out.Compatibility = &level
		}
	}
	if modes := client.Mode(ctx, p.Subject); len(modes) > 0 && modes[0].Err == nil {
		mode := modes[0].Mode.String()
		if mode != "" {
			out.Mode = &mode
		}
	}
	return out, nil
}

// ── schemas.version ───────────────────────────────────────────────────────

// schemasVersion reads one version's text. Version -1 is the latest, the registry's own
// shorthand for it.
func schemasVersion(c *opCtx, p schemaVersionParams) (any, error) {
	cl, client, ctx, cancel, err := registryFor(c, p.Cluster)
	if err != nil {
		return nil, err
	}
	defer cancel()
	if p.Subject == "" {
		return nil, &opError{Code: "EPARAM", Message: "No subject to read"}
	}
	if p.Version == 0 || p.Version < -1 {
		return nil, &opError{Code: "EPARAM", Message: "A version number, 1 or more, or -1 for the latest"}
	}
	s, err := client.SchemaByVersion(ctx, p.Subject, p.Version)
	if err != nil {
		return nil, registryFailure(cl, fmt.Sprintf("read version %d of %q", p.Version, p.Subject), err)
	}
	out := schemaVersionText{
		Subject:    p.Subject,
		Version:    s.Version,
		ID:         s.ID,
		Type:       schemaTypeOf(s.Type),
		Schema:     s.Schema.Schema,
		References: []schemaReference{},
	}
	for _, r := range s.References {
		out.References = append(out.References, schemaReference{Name: r.Name, Subject: r.Subject, Version: r.Version})
	}
	return out, nil
}

// ── shared ────────────────────────────────────────────────────────────────

// registryFor is the three lines every schema read starts with: the cluster, its registry
// client, and a bound on the whole thing. A cluster without a registry says so.
func registryFor(c *opCtx, name string) (*cluster, *sr.Client, context.Context, context.CancelFunc, error) {
	cl, err := c.srv.cluster(name)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	if cl.Registry == nil {
		return nil, nil, nil, nil, &opError{Code: "ENOREGISTRY", Message: fmt.Sprintf(
			"Cluster %q has no Schema Registry in the agent's configuration. Add schemaRegistry to it in kafka-agent.yaml.", cl.Name)}
	}
	client, err := c.conn.registryClient(cl)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	ctx, cancel := context.WithTimeout(c.ctx, registryTimeout)
	return cl, client, ctx, cancel, nil
}

// registryFailure is what a failed read says: what was being done, and the registry's own
// words about why not.
func registryFailure(cl *cluster, doing string, err error) error {
	_, message := registryProblem(err)
	return &opError{Code: "EKAFKA", Message: fmt.Sprintf("Could not %s on cluster %q: %s", doing, cl.Name, message)}
}

// schemaTypeOf names a schema's format the way the page shows it. The registry leaves the
// type out for Avro, which was the first format it had.
func schemaTypeOf(t sr.SchemaType) string {
	if s := t.String(); s != "" {
		return s
	}
	return "AVRO"
}
