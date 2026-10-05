// Changing a topic that is already there: its settings, how many partitions it has,
// and how much of a partition's log is still kept.
//
// Like the other write ops these are registered with writeOp, so dispatch has already
// refused them on a read-only cluster before this file is reached (see readonly_test.go).
// What is here is the checking they deserve once they are allowed, and — where the page
// asks for one — the difference they would make, worked out and shown before anything
// is changed. The cluster has the last word on every one of them: what it refuses is
// said in its own words.
package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kmsg"
)

// ── topics.alterConfigs ───────────────────────────────────────────────────

// configRank orders the sources a setting can come from, so that of the entries a cluster
// reports for one name — a default, the broker's own value, the topic's — the one with the
// last word is the one that counts. Kafka reports the effective value first and its
// synonyms after it; kfake reports every source as an entry of its own.
var configRank = map[string]int{
	"default":                0,
	"dynamic default broker": 1,
	"dynamic broker":         2,
	"static broker":          3,
	"topic":                  4,
}

// effectiveConfigs reduces the entries of one topic to one per name, the one that applies.
func effectiveConfigs(entries []configEntry) map[string]configEntry {
	out := make(map[string]configEntry, len(entries))
	for _, e := range entries {
		prev, seen := out[e.Name]
		if !seen || configRank[e.Source] >= configRank[prev.Source] {
			out[e.Name] = e
		}
	}
	return out
}

// settingsToAlter checks the settings a request names and works out what they would do,
// without asking the cluster anything. The rows are the difference — one per setting the
// request would change; a setting already at that value, or already at the cluster's
// default when the request resets it, is not in them.
func settingsToAlter(p alterConfigParams, now map[string]configEntry) ([]alterConfigRow, error) {
	if len(p.Configs) == 0 {
		return nil, &opError{Code: "EPARAM", Message: "No setting to change"}
	}
	if len(p.Configs) > maxConfigs {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("More than %d settings at once", maxConfigs)}
	}
	names := make([]string, 0, len(p.Configs))
	for name := range p.Configs {
		names = append(names, name)
	}
	sort.Strings(names)

	rows := make([]alterConfigRow, 0, len(names))
	for _, name := range names {
		if !configNameRe.MatchString(name) {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("%q is not a setting name", trimTo(name, 40))}
		}
		want := p.Configs[name]
		if want != nil && len(*want) > maxConfigValue {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("The value of %s is longer than %d characters", name, maxConfigValue)}
		}
		cur, known := now[name]
		if known && cur.Sensitive {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf(
				"%s is a sensitive setting: the agent never reads its value out, so it cannot say what changing it would do", name)}
		}
		if known && cur.ReadOnly {
			return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf(
				"%s is read-only on this topic: the cluster does not allow changing it while it runs", name)}
		}
		row := alterConfigRow{Name: name, After: want, FromDefault: true}
		if known {
			row.Before, row.FromDefault = cur.Value, cur.IsDefault
		}
		switch {
		case want == nil:
			// A reset of something that is already the default is not a change.
			if !known || row.FromDefault {
				continue
			}
		case known && !row.FromDefault && row.Before != nil && *row.Before == *want:
			continue // already set to exactly that on the topic
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// topicsAlterConfigs changes a topic's settings one by one, leaving everything it does
// not name alone.
//
// It is the same request whether it is a preview or not: the difference is worked out
// here from what the topic holds now, and with `dryRun` the cluster is asked whether it
// would take the settings — `ValidateOnly` — without changing anything. So what was
// shown is what is done, and a value the cluster will not take is a sentence in the
// dialog rather than an alteration that half happened.
func topicsAlterConfigs(c *opCtx, p alterConfigParams) (any, error) {
	if err := checkTopicName(p.Topic); err != nil {
		return nil, err
	}
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	details, err := t.adm.ListTopicsWithInternal(t.ctx, p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	d, ok := details[p.Topic]
	if !ok || d.Err != nil {
		return nil, unknownTopic(p.Topic, d.Err)
	}
	if d.IsInternal {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("%s is an internal topic: the cluster keeps its own settings", p.Topic)}
	}

	current, err := t.describeConfigs(kmsg.ConfigResourceTypeTopic, p.Topic)
	if err != nil {
		return nil, err
	}
	rows, err := settingsToAlter(p, effectiveConfigs(current))
	if err != nil {
		return nil, err
	}

	if len(rows) > 0 {
		alter := make([]kadm.AlterConfig, 0, len(rows))
		for _, r := range rows {
			op := kadm.SetConfig
			if r.After == nil {
				op = kadm.DeleteConfig // back to the cluster's default
			}
			alter = append(alter, kadm.AlterConfig{Op: op, Name: r.Name, Value: r.After})
		}
		change := t.adm.AlterTopicConfigs
		if p.DryRun {
			change = t.adm.ValidateAlterTopicConfigs
		}
		res, err := change(t.ctx, alter, p.Topic)
		if err != nil {
			return nil, t.fail(err)
		}
		if len(res) == 0 {
			return nil, &opError{Code: "EKAFKA", Message: "The cluster did not answer for that topic"}
		}
		for _, r := range res {
			if r.Err == nil {
				continue
			}
			msg := r.Err.Error()
			if r.ErrMessage != "" {
				msg = r.ErrMessage
			}
			return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The cluster did not take the settings of %s: %s", p.Topic, msg)}
		}
	}
	return alterConfigResult{Applied: !p.DryRun, Rows: rows}, nil
}

// ── topics.addPartitions ──────────────────────────────────────────────────

// topicsAddPartitions raises a topic's partition count.
//
// The count is the total afterwards, which is how the Kafka CLI takes it too: what the
// number means does not change with how many partitions the topic happens to have. The
// cluster is asked first when the page wants a check (`validateOnly`), so a count it
// will not take is a sentence in the dialog and not a topic with some of the partitions
// somebody asked for.
//
// Adding partitions changes which partition a key goes to — the partition is the hash of
// the key modulo the partition count — so the order of one key's messages is no longer
// the order they were written in. That is the cluster's behaviour, not this agent's, and
// the page warns about it. Nothing here can undo it either: Kafka does not remove
// partitions.
func topicsAddPartitions(c *opCtx, p addPartitionsParams) (any, error) {
	if p.Topic == "" {
		return nil, &opError{Code: "EPARAM", Message: "No topic to change"}
	}
	if p.Partitions < 1 || p.Partitions > maxPartitions {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Partitions: a number from 1 to %d", maxPartitions)}
	}
	if strings.HasPrefix(p.Topic, "__") {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("%s is an internal topic: how many partitions it has is the cluster's business", p.Topic)}
	}
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	details, err := t.adm.ListTopicsWithInternal(t.ctx, p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	d, ok := details[p.Topic]
	if !ok || d.Err != nil {
		return nil, unknownTopic(p.Topic, d.Err)
	}
	if d.IsInternal {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("%s is an internal topic: how many partitions it has is the cluster's business", p.Topic)}
	}
	from := len(d.Partitions)
	switch {
	case int(p.Partitions) == from:
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Topic %s has %d partition(s) already", p.Topic, from)}
	case int(p.Partitions) < from:
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf(
			"Topic %s has %d partitions, and Kafka adds partitions — it does not remove them — so %d is not possible", p.Topic, from, p.Partitions)}
	}

	add := t.adm.UpdatePartitions
	if p.ValidateOnly {
		add = t.adm.ValidateUpdatePartitions
	}
	res, err := add(t.ctx, int(p.Partitions), p.Topic)
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
		return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The cluster did not give %s %d partitions: %s", p.Topic, p.Partitions, msg)}
	}
	return addPartitionsResult{Topic: p.Topic, From: from, To: int(p.Partitions), Added: !p.ValidateOnly}, nil
}

// ── topics.deleteRecords ──────────────────────────────────────────────────

// topicsDeleteRecords drops the records of one partition below an offset, which is what
// the cluster's DeleteRecords does: the partition's start offset moves up and everything
// under it is gone for good. -1 is Kafka's own way of saying "all of them", and the
// cluster maps it to the high watermark — no record written between here and there is
// missed, which working the offset out here could not promise.
//
// The page asks the person to type the topic's name, and the agent asks the page to say
// that it did: a call that skipped the dialog truncates nothing. Internal topics are left
// alone — the cluster's offset and transaction state live in them.
func topicsDeleteRecords(c *opCtx, p deleteRecordsParams) (any, error) {
	if p.Topic == "" {
		return nil, &opError{Code: "EPARAM", Message: "No topic to delete records from"}
	}
	if p.Confirm != p.Topic {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Not deleted: the confirmation %q is not the topic's name %q", trimTo(p.Confirm, 60), trimTo(p.Topic, 60))}
	}
	if p.Partition < 0 {
		return nil, &opError{Code: "EPARAM", Message: "A partition number, 0 or more"}
	}
	if p.Offset < -1 {
		return nil, &opError{Code: "EPARAM", Message: "An offset of 0 or more, or -1 for everything in the partition"}
	}
	if strings.HasPrefix(p.Topic, "__") {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("%s is an internal topic: its records are the cluster's own state", p.Topic)}
	}
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	details, err := t.adm.ListTopicsWithInternal(t.ctx, p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	d, ok := details[p.Topic]
	if !ok || d.Err != nil {
		return nil, unknownTopic(p.Topic, d.Err)
	}
	if d.IsInternal {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("%s is an internal topic: its records are the cluster's own state", p.Topic)}
	}
	if _, ok := d.Partitions[p.Partition]; !ok {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf("Topic %s has no partition %d (it has %d)", p.Topic, p.Partition, len(d.Partitions))}
	}

	start, end, err := t.bounds(p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	s, sok := start.Lookup(p.Topic, p.Partition)
	e, eok := end.Lookup(p.Topic, p.Partition)
	if !sok || !eok || s.Err != nil || e.Err != nil {
		return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf(
			"The cluster did not say where partition %d of %s starts and ends, so there is nothing safe to delete", p.Partition, p.Topic)}
	}
	// The offset the request aims at, for the check here: -1 is the end, which is where the
	// cluster will read it too.
	target := p.Offset
	if target == -1 {
		target = e.Offset
	}
	if target > e.Offset {
		return nil, &opError{Code: "EPARAM", Message: fmt.Sprintf(
			"Partition %d of %s holds offsets %d–%d; %d is past its end, so there is nothing to delete it up to", p.Partition, p.Topic, s.Offset, e.Offset, p.Offset)}
	}

	offsets := kadm.Offsets{}
	offsets.Add(kadm.Offset{Topic: p.Topic, Partition: p.Partition, At: p.Offset})
	res, err := t.adm.DeleteRecords(t.ctx, offsets)
	if err != nil {
		return nil, t.fail(err)
	}
	r, ok := res.Lookup(p.Topic, p.Partition)
	if !ok {
		return nil, &opError{Code: "EKAFKA", Message: "The cluster did not answer for that partition"}
	}
	if r.Err != nil {
		return nil, &opError{Code: "EKAFKA", Message: fmt.Sprintf("The cluster deleted nothing from partition %d of %s: %s", p.Partition, p.Topic, r.Err)}
	}
	return deleteRecordsResult{
		Topic: p.Topic, Partition: p.Partition,
		Before: s.Offset, After: r.LowWatermark,
		Deleted: max(r.LowWatermark-s.Offset, 0),
	}, nil
}
