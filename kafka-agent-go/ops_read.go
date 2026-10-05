// The read-only ops that describe a cluster: its brokers, topics and groups.
package main

import (
	"errors"
	"sort"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kmsg"
)

// ── brokers ───────────────────────────────────────────────────────────────

func brokersList(c *opCtx, p clusterParams) (any, error) {
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	md, err := t.adm.BrokerMetadata(t.ctx)
	if err != nil {
		return nil, t.fail(err)
	}
	out := brokerList{Brokers: []broker{}}
	if md.Cluster != "" {
		id := md.Cluster
		out.ClusterID = &id
	}
	if md.Controller >= 0 {
		id := md.Controller
		out.Controller = &id
	}
	for _, b := range md.Brokers {
		out.Brokers = append(out.Brokers, broker{ID: b.NodeID, Host: b.Host, Port: b.Port, Rack: b.Rack, Controller: b.NodeID == md.Controller})
	}
	sort.Slice(out.Brokers, func(i, j int) bool { return out.Brokers[i].ID < out.Brokers[j].ID })
	return out, nil
}

func brokersConfig(c *opCtx, p brokerParams) (any, error) {
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()
	return t.describeConfigs(kmsg.ConfigResourceTypeBroker, itoa(int64(p.Broker)))
}

// ── topics ────────────────────────────────────────────────────────────────

// sizes sums the bytes each topic's partitions take on the brokers' disks,
// replicas included. Nil when the cluster would not say — a broker that does not
// answer DescribeLogDirs, or one that refuses this user — which the page shows
// as "unknown" and not as zero.
func (t *target) sizes(topic string) (perTopic map[string]int64, perPartition map[string]map[int32]int64) {
	dirs, err := t.adm.DescribeAllLogDirs(t.ctx, nil)
	if err != nil && len(dirs) == 0 {
		return nil, nil
	}
	perTopic = map[string]int64{}
	perPartition = map[string]map[int32]int64{}
	dirs.Each(func(d kadm.DescribedLogDir) {
		if d.Err != nil {
			return
		}
		d.Topics.Each(func(p kadm.DescribedLogDirPartition) {
			if topic != "" && p.Topic != topic {
				return
			}
			perTopic[p.Topic] += p.Size
			if perPartition[p.Topic] == nil {
				perPartition[p.Topic] = map[int32]int64{}
			}
			perPartition[p.Topic][p.Partition] += p.Size
		})
	})
	return perTopic, perPartition
}

// bounds lists where each partition of some topics starts and ends.
func (t *target) bounds(topics ...string) (start, end kadm.ListedOffsets, err error) {
	if start, err = t.adm.ListStartOffsets(t.ctx, topics...); err != nil && len(start) == 0 {
		return nil, nil, err
	}
	if end, err = t.adm.ListEndOffsets(t.ctx, topics...); err != nil && len(end) == 0 {
		return nil, nil, err
	}
	return start, end, nil
}

func topicsList(c *opCtx, p clusterParams) (any, error) {
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	details, err := t.adm.ListTopicsWithInternal(t.ctx)
	if err != nil {
		return nil, t.fail(err)
	}
	start, end, err := t.bounds()
	if err != nil {
		return nil, t.fail(err)
	}
	sizes, _ := t.sizes("")

	out := make([]topicSummary, 0, len(details))
	for _, d := range details.Sorted() {
		if d.Err != nil {
			continue // a topic that would not load has nothing to list
		}
		s := topicSummary{Name: d.Topic, Internal: d.IsInternal, Partitions: len(d.Partitions)}
		for _, part := range d.Partitions.Sorted() {
			s.ReplicationFactor = max(s.ReplicationFactor, len(part.Replicas))
			if len(part.ISR) < len(part.Replicas) {
				s.UnderReplicated++
			}
			s.Messages += retained(start, end, d.Topic, part.Partition)
		}
		if sizes != nil {
			n := sizes[d.Topic]
			s.Size = &n
		}
		out = append(out, s)
	}
	return out, nil
}

// retained is how many messages a partition holds now: end − start.
func retained(start, end kadm.ListedOffsets, topic string, partition int32) int64 {
	s, sok := start.Lookup(topic, partition)
	e, eok := end.Lookup(topic, partition)
	if !sok || !eok || s.Err != nil || e.Err != nil || e.Offset < s.Offset {
		return 0
	}
	return e.Offset - s.Offset
}

func topicsDescribe(c *opCtx, p topicParams) (any, error) {
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
	start, end, err := t.bounds(p.Topic)
	if err != nil {
		return nil, t.fail(err)
	}
	_, sizes := t.sizes(p.Topic)

	out := topicDetail{Name: d.Topic, Internal: d.IsInternal, Partitions: []partitionInfo{}}
	for _, part := range d.Partitions.Sorted() {
		info := partitionInfo{
			ID: part.Partition, Leader: part.Leader,
			Replicas: nonNil(part.Replicas), Isr: nonNil(part.ISR),
		}
		if s, ok := start.Lookup(p.Topic, part.Partition); ok && s.Err == nil {
			info.Start = s.Offset
		}
		if e, ok := end.Lookup(p.Topic, part.Partition); ok && e.Err == nil {
			info.End = e.Offset
		}
		if sizes != nil {
			n := sizes[p.Topic][part.Partition]
			info.Size = &n
		}
		out.Partitions = append(out.Partitions, info)
	}
	return out, nil
}

func topicsConfig(c *opCtx, p topicParams) (any, error) {
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()
	return t.describeConfigs(kmsg.ConfigResourceTypeTopic, p.Topic)
}

func unknownTopic(name string, cause error) error {
	msg := "Unknown topic: " + name
	if cause != nil {
		msg += " (" + cause.Error() + ")"
	}
	return &opError{Code: "EKAFKA", Message: msg}
}

func nonNil(s []int32) []int32 {
	if s == nil {
		return []int32{}
	}
	return s
}

// ── consumer groups ───────────────────────────────────────────────────────

// members reads a described group's members, and who holds which partition.
func members(d kadm.DescribedGroup) ([]groupMember, map[string]map[int32]string) {
	out := []groupMember{}
	holder := map[string]map[int32]string{} // topic → partition → member id
	for _, m := range d.Members {
		gm := groupMember{MemberID: m.MemberID, ClientID: m.ClientID, Host: m.ClientHost, Assignments: []topicPartitions{}}
		if a, ok := m.Assigned.AsConsumer(); ok {
			for _, tp := range a.Topics {
				parts := append([]int32{}, tp.Partitions...)
				sort.Slice(parts, func(i, j int) bool { return parts[i] < parts[j] })
				gm.Assignments = append(gm.Assignments, topicPartitions{Topic: tp.Topic, Partitions: parts})
				if holder[tp.Topic] == nil {
					holder[tp.Topic] = map[int32]string{}
				}
				for _, part := range parts {
					holder[tp.Topic][part] = m.MemberID
				}
			}
			sort.Slice(gm.Assignments, func(i, j int) bool { return gm.Assignments[i].Topic < gm.Assignments[j].Topic })
		}
		out = append(out, gm)
	}
	return out, holder
}

// lagRows is how far behind a group is, partition by partition: what it has
// committed, and — for a partition it holds but has not committed — where that
// partition starts, since that is how much it has yet to read.
//
// A partition that is neither committed nor held is not the group's as far as
// the cluster can tell, and is left out.
func lagRows(committed kadm.OffsetResponses, holder map[string]map[int32]string, start, end kadm.ListedOffsets) []partitionLag {
	rows := []partitionLag{}
	seen := map[string]map[int32]bool{}
	add := func(topic string, part int32, at *int64) {
		e, ok := end.Lookup(topic, part)
		if !ok || e.Err != nil {
			return
		}
		lag := int64(0)
		if at != nil {
			lag = max(0, e.Offset-*at)
		} else if s, ok := start.Lookup(topic, part); ok && s.Err == nil {
			lag = max(0, e.Offset-s.Offset)
		}
		row := partitionLag{Topic: topic, Partition: part, Committed: at, End: e.Offset, Lag: lag}
		if m, ok := holder[topic][part]; ok {
			row.Member = &m
		}
		rows = append(rows, row)
		if seen[topic] == nil {
			seen[topic] = map[int32]bool{}
		}
		seen[topic][part] = true
	}
	for topic, parts := range committed {
		for part, o := range parts {
			if o.Err == nil {
				at := o.At
				add(topic, part, &at)
			}
		}
	}
	for topic, parts := range holder {
		for part := range parts {
			if !seen[topic][part] {
				add(topic, part, nil)
			}
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Topic != rows[j].Topic {
			return rows[i].Topic < rows[j].Topic
		}
		return rows[i].Partition < rows[j].Partition
	})
	return rows
}

func topicsOf(committed kadm.OffsetResponses, holder map[string]map[int32]string) []string {
	set := map[string]bool{}
	for topic := range committed {
		set[topic] = true
	}
	for topic := range holder {
		set[topic] = true
	}
	list := make([]string, 0, len(set))
	for topic := range set {
		list = append(list, topic)
	}
	sort.Strings(list)
	return list
}

func groupsList(c *opCtx, p clusterParams) (any, error) {
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	listed, err := t.adm.ListGroups(t.ctx)
	if err != nil && len(listed) == 0 {
		return nil, t.fail(err)
	}
	names := listed.Groups()
	sort.Strings(names)
	out := make([]groupSummary, 0, len(names))
	if len(names) == 0 {
		return out, nil
	}

	described, _ := t.adm.DescribeGroups(t.ctx, names...)
	committed := t.adm.FetchManyOffsets(t.ctx, names...)

	// One list of offsets for every topic any group has a stake in.
	holders := map[string]map[string]map[int32]string{}
	topics := map[string]bool{}
	for _, name := range names {
		if d, ok := described[name]; ok && d.Err == nil {
			_, holders[name] = members(d)
		}
		if r, ok := committed[name]; ok && r.Err == nil {
			for _, topic := range topicsOf(r.Fetched, holders[name]) {
				topics[topic] = true
			}
		}
	}
	var start, end kadm.ListedOffsets
	if len(topics) > 0 {
		list := make([]string, 0, len(topics))
		for topic := range topics {
			list = append(list, topic)
		}
		start, _ = t.adm.ListStartOffsets(t.ctx, list...)
		end, _ = t.adm.ListEndOffsets(t.ctx, list...)
	}

	for _, name := range names {
		l := listed[name]
		s := groupSummary{Name: name, State: l.State, ProtocolType: l.ProtocolType}
		if d, ok := described[name]; ok && d.Err == nil {
			s.State, s.ProtocolType, s.Members = d.State, d.ProtocolType, len(d.Members)
		}
		if r, ok := committed[name]; ok && r.Err == nil {
			var lag int64
			for _, row := range lagRows(r.Fetched, holders[name], start, end) {
				lag += row.Lag
			}
			s.Lag = &lag
		}
		out = append(out, s)
	}
	return out, nil
}

func groupsDescribe(c *opCtx, p groupParams) (any, error) {
	t, err := c.use(p.Cluster)
	if err != nil {
		return nil, err
	}
	defer t.done()

	described, err := t.adm.DescribeGroups(t.ctx, p.Group)
	if err != nil && len(described) == 0 {
		return nil, t.fail(err)
	}
	d, ok := described[p.Group]
	if !ok || errors.Is(d.Err, kerr.GroupIDNotFound) {
		return nil, &opError{Code: "EKAFKA", Message: "Unknown group: " + p.Group}
	}
	if d.Err != nil {
		return nil, t.fail(d.Err)
	}

	out := groupDetail{
		Name: d.Group, State: d.State, ProtocolType: d.ProtocolType, Protocol: d.Protocol,
		Coordinator: d.Coordinator.NodeID, Lag: []partitionLag{},
	}
	var holder map[string]map[int32]string
	out.Members, holder = members(d)

	fetched, err := t.adm.FetchOffsets(t.ctx, p.Group)
	if err != nil && len(fetched) == 0 {
		return nil, t.fail(err)
	}
	if topics := topicsOf(fetched, holder); len(topics) > 0 {
		start, end, err := t.bounds(topics...)
		if err != nil {
			return nil, t.fail(err)
		}
		out.Lag = lagRows(fetched, holder, start, end)
		for _, row := range out.Lag {
			out.TotalLag += row.Lag
		}
	}
	return out, nil
}
