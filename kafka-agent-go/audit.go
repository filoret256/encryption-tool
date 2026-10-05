// The write log: one line on stderr for every op that changes (or was asked to
// change) a cluster, written before the page hears the answer.
//
//	kafka-agent: write time=2026-05-01T12:00:00Z cluster=dev op=topics.delete topic=orders result=ok messages=6
//
// What goes in a line is decided here and nowhere else. Never a message's key, value
// or headers, never a setting's value, never an error's text (it can quote what the
// page sent, or name a host and a user): the code says what kind of failure it was,
// and the page already shows the text to the person who asked. The fields come from
// the request's parameters and the op's answer, by the op's own describer — writeOp
// takes one, so an op cannot be added to the table without saying what it logs.
package main

import (
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
)

// auditFunc names what a write op acts on: logfmt fields, without the cluster and the
// op (the line carries those). result is what the op answered, nil when it did not
// succeed, so a field that only exists afterwards — where a message landed — is
// written only then. It returns "" when the parameters cannot be read.
type auditFunc func(r *req, result any) string

// about makes an auditFunc from a function of the op's own parameter type.
func about[P any](fn func(p P, result any) string) auditFunc {
	return func(r *req, result any) string {
		var p P
		if err := r.decode(&p); err != nil {
			return ""
		}
		return fn(p, result)
	}
}

// field is key=value, the value quoted when it is not plain: a name from the page can
// hold a space, a quote or a newline, and a newline must not start a line of its own.
func field(key, value string) string {
	return key + "=" + quoteIfNeeded(trimTo(value, 200))
}

func quoteIfNeeded(s string) string {
	if s == "" {
		return `""`
	}
	for _, r := range s {
		plain := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
			strings.ContainsRune("._-:/@,", r)
		if !plain {
			return strconv.Quote(s)
		}
	}
	return s
}

// record writes the line for one write op. outcome is nil for a success; a refusal is
// an op the gate turned away, and an error one that ran and failed.
func (s *server) record(r *req, entry opEntry, result any, outcome error, refused bool) {
	s.auditMu.Lock()
	defer s.auditMu.Unlock()
	if s.audit == nil {
		return
	}
	var head clusterParams
	_ = r.decode(&head) // a request that does not decode has no cluster to name

	parts := []string{
		"kafka-agent: write",
		field("time", time.Now().UTC().Format(time.RFC3339)),
		field("cluster", head.Cluster),
		field("op", r.op),
	}
	if entry.about != nil {
		if f := entry.about(r, result); f != "" {
			parts = append(parts, f)
		}
	}
	switch {
	case outcome == nil:
		parts = append(parts, "result=ok")
	case refused:
		parts = append(parts, "result=refused", field("code", codeOf(outcome)))
	default:
		parts = append(parts, "result=error", field("code", codeOf(outcome)))
	}
	_, _ = io.WriteString(s.audit, strings.Join(parts, " ")+"\n")
}

// codeOf is the wire code of an error, as errCodeOf gives it but without the op's
// context: an error that is not an opError came from the client library.
func codeOf(err error) string {
	var coded *opError
	if errors.As(err, &coded) {
		return coded.Code
	}
	return "EKAFKA"
}

// ── what each write op logs ───────────────────────────────────────────────

// partitionOf says which partition a send asked for.
func partitionOf(p *int32) string {
	if p == nil {
		return "auto"
	}
	return strconv.Itoa(int(*p))
}

func auditProduce(p produceParams, result any) string {
	out := []string{field("topic", p.Topic), field("partition", partitionOf(p.Partition))}
	if res, ok := result.(produceResult); ok {
		out = append(out, fmt.Sprintf("landed=%d@%d", res.Partition, res.Offset))
	}
	return strings.Join(out, " ")
}

func auditDeleteTopic(p deleteTopicParams, result any) string {
	out := []string{field("topic", p.Topic)}
	if res, ok := result.(deleteTopicResult); ok {
		out = append(out, fmt.Sprintf("messages=%d", res.Messages))
	}
	return strings.Join(out, " ")
}

// Setting names are logged, their values are not.
func auditCreateTopic(p createTopicParams, _ any) string {
	out := []string{
		field("topic", p.Topic),
		fmt.Sprintf("partitions=%d", p.Partitions),
		fmt.Sprintf("replication=%d", p.ReplicationFactor),
	}
	if len(p.Configs) > 0 {
		names := make([]string, 0, len(p.Configs))
		for k := range p.Configs {
			names = append(names, k)
		}
		sort.Strings(names)
		out = append(out, field("settings", strings.Join(names, ",")))
	}
	if p.ValidateOnly {
		out = append(out, "validateOnly=true")
	}
	return strings.Join(out, " ")
}

// Setting names are logged, their values are not: a value from the page is what the
// cluster will hold, and one of them is worth as much as a secret to whoever reads the
// log afterwards.
func auditAlterConfigs(p alterConfigParams, result any) string {
	names := make([]string, 0, len(p.Configs))
	for k := range p.Configs {
		names = append(names, k)
	}
	sort.Strings(names)
	out := []string{field("topic", p.Topic), field("settings", strings.Join(names, ","))}
	if res, ok := result.(alterConfigResult); ok {
		out = append(out, fmt.Sprintf("changes=%d", len(res.Rows)))
	}
	if p.DryRun {
		out = append(out, "dryRun=true")
	}
	return strings.Join(out, " ")
}

// A partition count says nothing about the data, so both numbers are logged.
func auditAddPartitions(p addPartitionsParams, result any) string {
	out := []string{field("topic", p.Topic), fmt.Sprintf("partitions=%d", p.Partitions)}
	if res, ok := result.(addPartitionsResult); ok {
		out = append(out, fmt.Sprintf("from=%d", res.From))
	}
	if p.ValidateOnly {
		out = append(out, "validateOnly=true")
	}
	return strings.Join(out, " ")
}

// The offset is where the page drew the line — which is "everything" when it is -1 —
// and how much went is the answer's.
func auditDeleteRecords(p deleteRecordsParams, result any) string {
	out := []string{field("topic", p.Topic), fmt.Sprintf("partition=%d", p.Partition), fmt.Sprintf("upTo=%d", p.Offset)}
	if res, ok := result.(deleteRecordsResult); ok {
		out = append(out, fmt.Sprintf("deleted=%d", res.Deleted), fmt.Sprintf("start=%d", res.After))
	}
	return strings.Join(out, " ")
}

func auditDeleteGroup(p deleteGroupParams, result any) string {
	out := []string{field("group", p.Group)}
	if res, ok := result.(deleteGroupResult); ok {
		out = append(out, fmt.Sprintf("offsets=%d", res.Offsets))
	}
	return strings.Join(out, " ")
}

func auditResetOffsets(p resetOffsetsParams, result any) string {
	out := []string{field("group", p.Group), field("topic", p.Topic), field("to", p.To)}
	switch {
	case p.To == "timestamp" && p.Timestamp != nil:
		out = append(out, fmt.Sprintf("timestamp=%d", *p.Timestamp))
	case p.To == "offset" && p.Offset != nil:
		out = append(out, fmt.Sprintf("offset=%d", *p.Offset))
	case p.To == "shift" && p.Shift != nil:
		out = append(out, fmt.Sprintf("shift=%d", *p.Shift))
	}
	if len(p.Partitions) == 0 {
		out = append(out, "partitions=all")
	} else {
		ns := make([]string, len(p.Partitions))
		for i, n := range p.Partitions {
			ns[i] = strconv.Itoa(int(n))
		}
		out = append(out, field("partitions", strings.Join(ns, ",")))
	}
	if p.DryRun {
		out = append(out, "dryRun=true")
	}
	if res, ok := result.(resetOffsetsResult); ok {
		out = append(out, fmt.Sprintf("rows=%d", len(res.Rows)))
	}
	return strings.Join(out, " ")
}

// A schema's text is not logged. It describes the cluster's data — field names, types, and
// sometimes a default that is a real value — and what the log has to say is which subject
// and version moved, which the answer names.
func auditRegisterSchema(p registerSchemaParams, result any) string {
	out := []string{field("subject", p.Subject), field("type", p.Type)}
	if len(p.References) > 0 {
		out = append(out, fmt.Sprintf("references=%d", len(p.References)))
	}
	if res, ok := result.(registeredSchema); ok {
		out = append(out, fmt.Sprintf("version=%d", res.Version), fmt.Sprintf("id=%d", res.ID))
	}
	return strings.Join(out, " ")
}

// The level is the whole of what this op does, so it is logged. With no subject it is the
// registry's default for subjects that have none of their own; with no level, the subject
// goes back to following that default.
func auditSetCompatibility(p setCompatibilityParams, _ any) string {
	out := []string{"subject=all"}
	if p.Subject != "" {
		out[0] = field("subject", p.Subject)
	}
	if p.Level == "" {
		out = append(out, "level=default")
	} else {
		out = append(out, field("level", p.Level))
	}
	return strings.Join(out, " ")
}
