// The write ops that manage what a cluster holds rather than what is in it:
// topics.create and groups.reset. Like the others in ops_write.go they are writeOps,
// so dispatch has already refused them on a read-only cluster.
package main

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
)

// ── topics.create ─────────────────────────────────────────────────────────

const (
	maxTopicNameLen = 249 // Kafka's own limit
	maxPartitions   = 10_000
	maxConfigs      = 50
	maxConfigValue  = 1000
)

var (
	topicNameRe  = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	configNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
)

// checkTopicName says what is wrong with a name before the cluster is asked, in the
// terms a person typing it needs. The cluster checks it again, and has the last word.
func checkTopicName(name string) error {
	switch {
	case name == "":
		return &opError{Code: "EPARAM", Message: "The topic needs a name"}
	case name == "." || name == "..":
		return &opError{Code: "EPARAM", Message: `A topic cannot be named "." or ".."`}
	case len(name) > maxTopicNameLen:
		return &opError{Code: "EPARAM", Message: fmt.Sprintf("The name is %d characters; Kafka allows %d", len(name), maxTopicNameLen)}
	case !topicNameRe.MatchString(name):
		return &opError{Code: "EPARAM", Message: "A topic name may hold only letters, digits, dot, underscore and hyphen"}
	case strings.HasPrefix(name, "__"):
		return &opError{Code: "EPARAM", Message: "Names starting with two underscores are the cluster's own; pick another"}
	}
	return nil
}

// topicsCreate creates a topic — or, with validateOnly, asks the cluster whether it
// would, and answers the same without creating anything. The page asks the second
// question first, so a bad replication factor is a sentence in the dialog and not
// a topic that half exists.
func topicsCreate(c *opCtx, p createTopicParams) (any, error) {
	if err := checkTopicName(p.Topic); err != nil {
		return nil, err
	}
	if p.Partitions < 1 || p.Partitions > maxPartitions {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Partitions: a number from 1 to %d", maxPartitions)}
	}
	if p.ReplicationFactor < 1 {
		return nil, &opError{Code: "EPARAM", Message: "Replication factor: 1 or more"}
	}
	if len(p.Configs) > maxConfigs {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("More than %d settings", maxConfigs)}
	}
	configs := make(map[string]*string, len(p.Configs))
	for k, v := range p.Configs {
		if !configNameRe.MatchString(k) {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("%q is not a setting name", trimTo(k, 40))}
		}
		if len(v) > maxConfigValue {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("The value of %s is longer than %d characters", k, maxConfigValue)}
		}
		v := v
		configs[k] = &v
	}

	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	create := t.adm.CreateTopics
	if p.ValidateOnly {
		create = t.adm.ValidateCreateTopics
	}
	res, err := create(t.ctx, p.Partitions, p.ReplicationFactor, configs, p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	r, ok := res[p.Topic]
	if !ok {
		return nil, &opError{Code: "EKAFKA", Message: "The cluster did not answer for that topic"}
	}
	if r.Err != nil {
		msg := r.Err.Error()
		if r.ErrMessage != "" {
			msg = r.ErrMessage
		}
		switch {
		case errors.Is(r.Err, kerr.TopicAlreadyExists):
			msg = fmt.Sprintf("Topic %s already exists", p.Topic)
		case errors.Is(r.Err, kerr.InvalidReplicationFactor):
			msg = fmt.Sprintf("Replication factor %d is more than the cluster can hold: %s", p.ReplicationFactor, msg)
		}
		return nil, &opError{Code: "EKAFKA", Message: msg}
	}
	return createTopicResult{Topic: p.Topic, Partitions: p.Partitions, ReplicationFactor: p.ReplicationFactor, Created: !p.ValidateOnly}, nil
}

// ── groups.reset ──────────────────────────────────────────────────────────

// groupIsRunning says, in the terms the dialog needs, why a group with members cannot be
// changed: which state it is in, and who is in it. `what` is the operation's own sentence
// — what cannot be done while somebody is running as the group.
func groupIsRunning(g kadm.DescribedGroup, what string) *opError {
	who := ""
	if n := len(g.Members); n > 0 {
		ids := make([]string, 0, n)
		for _, m := range g.Members {
			ids = append(ids, m.ClientID)
		}
		sort.Strings(ids)
		who = fmt.Sprintf(" (%d member(s): %s)", n, trimTo(strings.Join(ids, ", "), 120))
	}
	return &opError{Code: "EGROUPACTIVE", Message: fmt.Sprintf("Group %q is %s%s. %s", g.Group, g.State, who, what)}
}

// groupMissing says whether the cluster has never heard of the group. A real broker answers
// DescribeGroups for a name it does not know with the state "Dead" — no members, its
// metadata gone — and no error at all; kfake answers GroupIDNotFound. Both mean the same
// thing, and neither is a group with somebody in it: without this, a reset or a delete of a
// name that was never there tells the person to stop consumers that do not exist.
func groupMissing(g kadm.DescribedGroup) bool {
	return errors.Is(g.Err, kerr.GroupIDNotFound) || g.State == "Dead" || g.State == ""
}

// groupsReset moves a consumer group's committed offsets for one topic.
//
// It is the same request whether it is a preview or not: `dryRun` computes what would
// change — from where each partition is now, and where the topic's log starts and ends —
// and answers with that; without it the same offsets are committed. So what was shown
// is what is done, to the extent the log did not move in between.
//
// Only for a group nobody is running as: a member would go on committing its own
// position over this one, and the broker rejects the commit anyway. The refusal says so
// before that, and says which members there are.
func groupsReset(c *opCtx, p resetOffsetsParams) (any, error) {
	switch p.To {
	case "earliest", "latest":
	case "timestamp":
		if p.Timestamp == nil || *p.Timestamp < 0 {
			return nil, &opError{Code: "EPARAM", Message: "Reset to a time needs the time (milliseconds since the epoch)"}
		}
	case "offset":
		if p.Offset == nil || *p.Offset < 0 {
			return nil, &opError{Code: "EPARAM", Message: "Reset to an offset needs the offset (0 or more)"}
		}
	case "shift":
		if p.Shift == nil {
			return nil, &opError{Code: "EPARAM", Message: "Shifting needs the number of messages to move by (negative moves back)"}
		}
	default:
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Unknown reset target %q (earliest, latest, timestamp, offset or shift)", p.To)}
	}
	if p.Group == "" || p.Topic == "" {
		return nil, &opError{Code: "EPARAM", Message: "A group and a topic are needed"}
	}
	if strings.HasPrefix(p.Topic, "__") {
		return nil, &opError{Code: "EPARAM", Message: "Internal topics are the cluster's own; their offsets are not reset"}
	}

	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	// The group, and whether anybody is in it.
	described, err := t.adm.DescribeGroups(t.ctx, p.Group)
	if err != nil && len(described) == 0 {
		return nil, t.fail(err)
	}
	g, ok := described[p.Group]
	if !ok || groupMissing(g) {
		return nil, &opError{Code: "EKAFKA", Message: "Unknown group: " + p.Group}
	}
	if g.Err != nil {
		return nil, t.fail(g.Err)
	}
	if g.State != "Empty" {
		return nil, groupIsRunning(g, "Offsets can be reset only while nobody in the group is running: stop its consumers first, and try again.")
	}

	// The topic and the partitions to move.
	details, err := t.adm.ListTopicsWithInternal(t.ctx, p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	d, ok := details[p.Topic]
	if !ok || d.Err != nil {
		return nil, unknownTopic(p.Topic, d.Err)
	}
	var parts []int32
	if len(p.Partitions) == 0 {
		for _, part := range d.Partitions.Sorted() {
			parts = append(parts, part.Partition)
		}
	} else {
		seen := map[int32]bool{}
		for _, n := range p.Partitions {
			if _, ok := d.Partitions[n]; !ok {
				return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Topic %s has no partition %d (it has %d)", p.Topic, n, len(d.Partitions))}
			}
			if !seen[n] {
				seen[n] = true
				parts = append(parts, n)
			}
		}
		sort.Slice(parts, func(i, j int) bool { return parts[i] < parts[j] })
	}

	start, end, err := t.bounds(p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	committed, err := t.adm.FetchOffsets(t.ctx, p.Group)
	if err != nil && len(committed) == 0 {
		return nil, t.fail(err)
	}
	var byTime kadm.ListedOffsets
	if p.To == "timestamp" {
		if byTime, err = t.adm.ListOffsetsAfterMilli(t.ctx, *p.Timestamp, p.Topic); err != nil {
			return nil, t.fail(err)
		}
	}

	rows := make([]resetRow, 0, len(parts))
	var problems []string
	for _, n := range parts {
		s, sok := start.Lookup(p.Topic, n)
		e, eok := end.Lookup(p.Topic, n)
		if !sok || !eok || s.Err != nil || e.Err != nil {
			problems = append(problems, fmt.Sprintf("partition %d: the cluster did not say where it starts and ends", n))
			continue
		}
		row := resetRow{Topic: p.Topic, Partition: n, Start: s.Offset, End: e.Offset}
		if o, ok := committed.Lookup(p.Topic, n); ok && o.Err == nil && o.At >= 0 {
			at := o.At
			row.Before = &at
		}
		switch p.To {
		case "earliest":
			row.After = row.Start
		case "latest":
			row.After = row.End
		case "timestamp":
			row.After = row.End // nothing at or after that time: the end, as Kafka answers
			if lo, ok := byTime.Lookup(p.Topic, n); ok && lo.Err == nil && lo.Offset >= 0 {
				row.After = lo.Offset
			}
		case "offset":
			row.After = *p.Offset
			if row.After < row.Start || row.After > row.End {
				problems = append(problems, fmt.Sprintf("partition %d holds offsets %d–%d; %d is outside", n, row.Start, row.End, row.After))
				continue
			}
		case "shift":
			if row.Before == nil {
				problems = append(problems, fmt.Sprintf("partition %d has no committed offset to shift from — use earliest, latest or an offset", n))
				continue
			}
			row.After = min(max(*row.Before+*p.Shift, row.Start), row.End)
		}
		rows = append(rows, row)
	}
	if len(problems) > 0 {
		return nil, &opError{Code: "EPARAM", Message: "Nothing was changed. " + strings.Join(problems, "; ")}
	}
	if p.DryRun {
		return resetOffsetsResult{Applied: false, Rows: rows}, nil
	}

	offsets := kadm.Offsets{}
	for _, r := range rows {
		offsets.Add(kadm.Offset{Topic: r.Topic, Partition: r.Partition, At: r.After})
	}
	res, err := t.adm.CommitOffsets(t.ctx, p.Group, offsets)
	if err != nil {
		return nil, t.fail(err)
	}
	var failed []string
	for _, r := range rows {
		if o, ok := res.Lookup(r.Topic, r.Partition); !ok || o.Err != nil {
			why := "no answer"
			if ok {
				why = o.Err.Error()
			}
			failed = append(failed, fmt.Sprintf("partition %d: %s", r.Partition, why))
		}
	}
	if len(failed) > 0 {
		return nil, &opError{Code: "EKAFKA", Message: "The cluster did not take every offset — " + strings.Join(failed, "; ")}
	}
	return resetOffsetsResult{Applied: true, Rows: rows}, nil
}

// ── groups.delete ─────────────────────────────────────────────────────────

// groupsDelete removes a consumer group and the offsets it committed.
//
// Like a topic's deletion, the page asks the person to type the group's name and the
// agent asks the page to say that it did — a call that skipped the dialog deletes
// nothing. Only a group nobody is running as: Kafka refuses a group with members
// (`NonEmptyGroup`) and would keep refusing until they leave, so the refusal here says
// what is happening and who is in it instead of passing that on.
//
// What it held is answered after the fact, because once the group is gone nobody can
// say: the offsets that went with it, summed over partitions.
func groupsDelete(c *opCtx, p deleteGroupParams) (any, error) {
	if p.Group == "" {
		return nil, &opError{Code: "EPARAM", Message: "No group to delete"}
	}
	if p.Confirm != p.Group {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Not deleted: the confirmation %q is not the group's name %q", trimTo(p.Confirm, 60), trimTo(p.Group, 60))}
	}
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	described, err := t.adm.DescribeGroups(t.ctx, p.Group)
	if err != nil && len(described) == 0 {
		return nil, t.fail(err)
	}
	g, ok := described[p.Group]
	if !ok || groupMissing(g) {
		return nil, &opError{Code: "EKAFKA", Message: "Unknown group: " + p.Group}
	}
	if g.Err != nil {
		return nil, t.fail(g.Err)
	}
	if g.State != "Empty" {
		return nil, groupIsRunning(g, "A group can be deleted only while nobody is running as it: stop its consumers first, and try again.")
	}

	// What goes with it, for the answer. A group that committed nothing has none.
	var offsets int
	if committed, err := t.adm.FetchOffsets(t.ctx, p.Group); err == nil {
		committed.Each(func(o kadm.OffsetResponse) {
			if o.Err == nil && o.At >= 0 {
				offsets++
			}
		})
	}

	res, err := t.adm.DeleteGroups(t.ctx, p.Group)
	if err != nil {
		return nil, t.fail(err)
	}
	r, ok := res[p.Group]
	if !ok {
		return nil, &opError{Code: "EKAFKA", Message: "The cluster did not answer for that group"}
	}
	if r.Err != nil {
		msg := r.Err.Error()
		if r.ErrMessage != "" {
			msg = r.ErrMessage
		}
		return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The cluster did not delete %s: %s", p.Group, msg)}
	}
	return deleteGroupResult{Group: p.Group, Offsets: offsets}, nil
}
