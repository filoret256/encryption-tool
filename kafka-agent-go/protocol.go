// Wire protocol shared with the browser client.
//
// The authoritative definition lives in src/kafka-agent/protocol.ts — the
// browser side is written against those types, so these structs exist to
// match them byte for byte on the wire. Every json tag here is load-bearing: a
// renamed field is a silently empty panel, not a compile error.
//
// The frame shapes are the code-agent's (code-agent-go/protocol.go): a request
// is one flat object, {id, op, ...params}; a reply is {id, ok, data} or
// {id, ok: false, error, code}; a streamed op sends {id, chunk} frames before
// its reply; the agent's own news is {event, data}.
package main

import "encoding/json"

// ── frames ────────────────────────────────────────────────────────────────

type req struct {
	id int64
	op string
	// The whole frame, for an op to decode its parameters from. id and op are
	// in it too, and a params struct simply has no field for them.
	raw json.RawMessage
}

// decode reads the request's parameters into v. A parameter of the wrong type
// is an error: unlike the code-agent, this one has no TypeScript twin whose
// coercions it must reproduce.
func (r *req) decode(v any) error {
	if err := json.Unmarshal(r.raw, v); err != nil {
		return &opError{Code: "EPARAM", Message: "Bad parameters: " + err.Error()}
	}
	return nil
}

type resOK struct {
	ID   int64 `json:"id"`
	OK   bool  `json:"ok"`
	Data any   `json:"data"`
}

type resErr struct {
	ID    int64  `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

// Partial result of a long-running op (consumed messages).
type chunkFrame struct {
	ID    int64 `json:"id"`
	Chunk any   `json:"chunk"`
}

// Server-initiated message.
type pushFrame struct {
	Event string `json:"event"`
	Data  any    `json:"data"`
}

// opError is an error with a wire code the page can branch on.
type opError struct {
	Code    string
	Message string
}

func (e *opError) Error() string { return e.Message }

// ── agent and clusters ────────────────────────────────────────────────────

// What agent.info reports. Names and flags only: bootstrap servers, stores and
// credentials never leave this process.
type kafkaAgentInfo struct {
	// Always "kafka-agent": the page checks it, so a URL pasted into the wrong
	// tab is refused by name instead of failing on the first unknown op.
	Agent    string        `json:"agent"`
	Version  string        `json:"version"`
	Platform string        `json:"platform"`
	Clusters []clusterInfo `json:"clusters"`
}

type clusterInfo struct {
	Name     string `json:"name"`
	ReadOnly bool   `json:"readOnly"`
}

// One cluster as clusters.list reports it. No bootstrap servers, no stores, no
// credentials: those stay in this process.
type clusterEntry struct {
	Name     string `json:"name"`
	ReadOnly bool   `json:"readOnly"`
	// PLAINTEXT, SSL, SASL_PLAINTEXT or SASL_SSL.
	Protocol string `json:"protocol"`
	// SCRAM-SHA-256 or SCRAM-SHA-512; empty without SASL.
	Mechanism string `json:"mechanism,omitempty"`
}

type clusterStatus struct {
	Name  string `json:"name"`
	State string `json:"state"`
	// Why, when the state is not "connected": a sentence that ends in the
	// thing to change.
	Message string `json:"message,omitempty"`
	// Null unless connected.
	ClusterID  *string `json:"clusterId"`
	Controller *int32  `json:"controller"`
	Brokers    *int    `json:"brokers"`
	// The Kafka version the brokers' API support corresponds to, "v3.7" —
	// a guess from ApiVersions, which is all a client can know.
	Version *string `json:"version"`
}

// What config.reload answers: the clusters as they are now, and what changed.
type reloadResult struct {
	Clusters []clusterEntry `json:"clusters"`
	Added    []string       `json:"added"`
	Removed  []string       `json:"removed"`
	// Clusters whose settings differ from before: their connections were dropped.
	Changed []string `json:"changed"`
	// Things the agent noted while reading — settings it ignored, and the like.
	Warnings []string `json:"warnings"`
}

// The clusters.changed push: the agent's configuration was reloaded, by this page
// or by another; what is shown about clusters is stale.
type clustersChanged struct {
	Clusters []clusterEntry `json:"clusters"`
}

// ── parameters ────────────────────────────────────────────────────────────

type noParams struct {
	// an op that takes nothing
}

type cancelParams struct {
	Target int64 `json:"target"`
}

type clusterParams struct {
	Cluster string `json:"cluster"`
}

type brokerParams struct {
	Cluster string `json:"cluster"`
	Broker  int32  `json:"broker"`
}

type topicParams struct {
	Cluster string `json:"cluster"`
	Topic   string `json:"topic"`
}

type groupParams struct {
	Cluster string `json:"cluster"`
	Group   string `json:"group"`
}

// ── brokers ───────────────────────────────────────────────────────────────

type broker struct {
	ID         int32   `json:"id"`
	Host       string  `json:"host"`
	Port       int32   `json:"port"`
	Rack       *string `json:"rack"`
	Controller bool    `json:"controller"`
}

type brokerList struct {
	ClusterID  *string  `json:"clusterId"`
	Controller *int32   `json:"controller"`
	Brokers    []broker `json:"brokers"`
}

// One configuration entry of a broker or a topic.
type configEntry struct {
	Name string `json:"name"`
	// Null for a sensitive entry: the agent never reads those out.
	Value *string `json:"value"`
	// Where the value comes from: "dynamic broker", "static broker", "default", "topic"…
	Source    string `json:"source"`
	Sensitive bool   `json:"sensitive"`
	ReadOnly  bool   `json:"readOnly"`
	// True when the value is the default, not something somebody set.
	IsDefault bool `json:"isDefault"`
}

// ── topics ────────────────────────────────────────────────────────────────

type topicSummary struct {
	Name              string `json:"name"`
	Internal          bool   `json:"internal"`
	Partitions        int    `json:"partitions"`
	ReplicationFactor int    `json:"replicationFactor"`
	// Partitions whose in-sync replicas are fewer than their replicas.
	UnderReplicated int `json:"underReplicated"`
	// Sum of (end − start) over the partitions: what is retained, not what was ever written.
	Messages int64 `json:"messages"`
	// Bytes on the brokers' disks, replicas included; null when the cluster would not say.
	Size *int64 `json:"size"`
}

type partitionInfo struct {
	ID       int32   `json:"id"`
	Leader   int32   `json:"leader"`
	Replicas []int32 `json:"replicas"`
	Isr      []int32 `json:"isr"`
	Start    int64   `json:"start"`
	End      int64   `json:"end"`
	Size     *int64  `json:"size"`
}

type topicDetail struct {
	Name       string          `json:"name"`
	Internal   bool            `json:"internal"`
	Partitions []partitionInfo `json:"partitions"`
}

// ── messages ──────────────────────────────────────────────────────────────

type consumeParams struct {
	Cluster string `json:"cluster"`
	Topic   string `json:"topic"`
	// Which partitions; empty or absent means all of them.
	Partitions []int32 `json:"partitions"`
	// "start": the oldest first. "end": the newest N, newest first. "offset": from
	// offset on, one partition. "time": from the first message at or after timestamp.
	From      string `json:"from"`
	Offset    *int64 `json:"offset"`
	Timestamp *int64 `json:"timestamp"`
	// How many messages to return (after filtering).
	Limit int `json:"limit"`
	// Keep only messages whose key or value contains this text (or matches it as a
	// regular expression). Applied here, so a filter over a large topic does not
	// ship the topic to the page.
	Filter        string `json:"filter"`
	Regex         bool   `json:"regex"`
	CaseSensitive bool   `json:"caseSensitive"`
}

type messageHeader struct {
	Key string `json:"key"`
	// base64
	Value *string `json:"value"`
}

type kafkaMessage struct {
	Partition int32 `json:"partition"`
	Offset    int64 `json:"offset"`
	// Milliseconds since the epoch.
	Timestamp int64 `json:"timestamp"`
	// base64; null for a null key.
	Key *string `json:"key"`
	// base64, cut at the per-value cap when truncated; null for a tombstone.
	Value     *string         `json:"value"`
	Headers   []messageHeader `json:"headers"`
	KeySize   int             `json:"keySize"`
	ValueSize int             `json:"valueSize"`
	// The value shown is a prefix — messages.get has the rest, up to a hard cap.
	Truncated bool `json:"truncated"`
}

// What a messages.consume chunk carries.
type messageBatch struct {
	Messages []kafkaMessage `json:"messages"`
	// How many matching messages were dropped from this stretch because they came
	// faster than a page can show: the newest are kept. Always 0 for messages.consume.
	Skipped int `json:"skipped"`
}

type consumeResult struct {
	// How many messages were read, matching or not.
	Scanned int `json:"scanned"`
	Matched int `json:"matched"`
	// Why it stopped: "end", "limit", "scan-limit", "window" or "idle".
	Stopped string `json:"stopped"`
	// How many matching messages the agent dropped to stay inside the window it
	// holds before sorting. Only a `from: end` read has a window, so this is 0
	// for every other direction.
	Skipped int `json:"skipped"`
}

// Follow a topic from where it ends now: what is written from here on arrives as
// it is written, until the request is cancelled.
type tailParams struct {
	Cluster string `json:"cluster"`
	Topic   string `json:"topic"`
	// Which partitions; empty or absent means all of them.
	Partitions []int32 `json:"partitions"`
	// As for messages.consume: applied by the agent.
	Filter        string `json:"filter"`
	Regex         bool   `json:"regex"`
	CaseSensitive bool   `json:"caseSensitive"`
}

// What a tail answers with when it ends other than by being cancelled — a cancelled
// one is an ECANCELED error, like any other op that was stopped.
type tailResult struct {
	// How many messages it sent.
	Received int `json:"received"`
}

type getMessageParams struct {
	Cluster   string `json:"cluster"`
	Topic     string `json:"topic"`
	Partition int32  `json:"partition"`
	Offset    int64  `json:"offset"`
}

// ── schema registry ───────────────────────────────────────────────────────

// schemas.status: whether the cluster has a Schema Registry, and whether it answers.
//
// This is not the agent's own connection to the cluster: a registry has its own URL, login
// and stores, so what is wrong with it is reported on its own terms.
type schemaStatus struct {
	Name string `json:"name"`
	// "not_configured", "connected", "auth_failed", "unreachable" or "error".
	State string `json:"state"`
	// Why, when the state is not connected: a sentence that ends in the setting to change.
	Message string `json:"message,omitempty"`
	// What the registry says about itself, when it answered: "READWRITE", "READONLY"…
	Mode *string `json:"mode"`
	// The default compatibility level, when it answered.
	Compatibility *string `json:"compatibility"`
	// How many subjects it holds; null when that listing did not answer.
	Subjects *int `json:"subjects"`
}

// messages.decode: read one schema-encoded value — a message's value or its key: the wire
// format does not care which. The bytes go as base64, exactly as they came off the topic.
type decodeValueParams struct {
	Cluster string `json:"cluster"`
	// The value's bytes, base64.
	Value string `json:"value"`
}

// What a schema-encoded value held.
type decodedValue struct {
	SchemaID int `json:"schemaId"`
	// AVRO, PROTOBUF or JSON.
	SchemaType string `json:"schemaType"`
	// Where the schema is registered, when the registry says: subject and version.
	Subject *string `json:"subject"`
	Version *int    `json:"version"`
	// The value as JSON text, whatever the schema's own format was.
	JSON string `json:"json"`
	// The Protobuf message it held, when the schema declares more than one.
	Message *string `json:"message"`
}

// schemas.subjects: every subject the registry holds. Names only — what a subject's
// versions are costs one request per version, and a list of hundreds is not worth that.
type subjectNames struct {
	Subjects []string `json:"subjects"`
}

// One subject to read.
type subjectParams struct {
	Cluster string `json:"cluster"`
	Subject string `json:"subject"`
}

// One version of one subject: what the page's version list is made of. The text is not
// here — that is schemas.version, asked for the versions somebody wants to read.
type schemaVersion struct {
	Version int `json:"version"`
	ID      int `json:"id"`
	// AVRO, PROTOBUF or JSON.
	Type string `json:"type"`
}

type subjectVersions struct {
	Subject string `json:"subject"`
	// The subject's own compatibility level, when it has one of its own; null means it
	// follows the registry's default (see schemas.status).
	Compatibility *string `json:"compatibility"`
	// The subject's own mode, when it has one; null means the registry's.
	Mode     *string         `json:"mode"`
	Versions []schemaVersion `json:"versions"`
}

// One version's text to read.
type schemaVersionParams struct {
	Cluster string `json:"cluster"`
	Subject string `json:"subject"`
	// 1 or more, or -1 for the latest.
	Version int `json:"version"`
}

// One reference of a schema: another schema this one is written in terms of.
type schemaReference struct {
	Name    string `json:"name"`
	Subject string `json:"subject"`
	Version int    `json:"version"`
}

// The text of one version, with what it is and where it came from.
type schemaVersionText struct {
	Subject string `json:"subject"`
	Version int    `json:"version"`
	ID      int    `json:"id"`
	Type    string `json:"type"`
	Schema  string `json:"schema"`
	// Empty for a schema that stands alone, which is most of them.
	References []schemaReference `json:"references"`
}

// schemas.register: a new version of a subject (K-47). The registry checks compatibility
// itself and refuses with its own words; schemas.check asks the same question first.
type registerSchemaParams struct {
	Cluster string `json:"cluster"`
	Subject string `json:"subject"`
	// The schema's text: Avro JSON, a .proto, or a JSON Schema.
	Schema string `json:"schema"`
	// AVRO, PROTOBUF or JSON; empty is Avro, which is the registry's own default.
	Type string `json:"type"`
	// Empty for a schema that stands alone, which is most of them.
	References []schemaReference `json:"references"`
}

// What the registry made of a registered schema: the version it gave it, and its id.
type registeredSchema struct {
	Subject string `json:"subject"`
	Version int    `json:"version"`
	ID      int    `json:"id"`
	Type    string `json:"type"`
}

// schemas.check: whether the registry would take a schema, and why not. The same
// parameters as a register, and one more: which existing version to check against.
type checkSchemaParams struct {
	Cluster string `json:"cluster"`
	Subject string `json:"subject"`
	Schema  string `json:"schema"`
	Type    string `json:"type"`
	// 1 or more, -1 for the latest, or -2 for all of them: the registry's own shorthand.
	Version    int               `json:"version"`
	References []schemaReference `json:"references"`
}

// What the registry said about a schema it was asked to check. `messages` is its own
// reasons, empty when the schema would be taken.
type schemaCheck struct {
	Compatible bool     `json:"compatible"`
	Messages   []string `json:"messages"`
}

// schemas.setCompatibility: the level a subject is held to, or the registry's default.
type setCompatibilityParams struct {
	Cluster string `json:"cluster"`
	// Empty sets the registry's default, for subjects that have no level of their own.
	Subject string `json:"subject"`
	// NONE, BACKWARD, BACKWARD_TRANSITIVE, FORWARD, FORWARD_TRANSITIVE, FULL or
	// FULL_TRANSITIVE; empty takes the subject back to following the registry's default.
	Level string `json:"level"`
}

// The level in force afterwards, as the registry reports it — not what was asked for.
type compatibilitySet struct {
	Subject string `json:"subject"`
	Level   string `json:"level"`
}

// acls.list: every ACL the login may see. One read — creating and deleting ACLs is not in
// this agent at all.
type aclEntry struct {
	Principal string `json:"principal"`
	// The host the principal may connect from; "*" for any.
	Host string `json:"host"`
	// topic, group, cluster, transactional_id or delegation_token.
	ResourceType string `json:"resourceType"`
	// The resource's name may be a literal, a prefix or "*": PatternType says which.
	ResourceName string `json:"resourceName"`
	// literal, prefixed or match.
	PatternType string `json:"patternType"`
	Operation   string `json:"operation"`
	// allow or deny.
	Permission string `json:"permission"`
}

type aclList struct {
	ACLs []aclEntry `json:"acls"`
}

// ── writing ───────────────────────────────────────────────────────────────

// One header of a message to send.
type produceHeader struct {
	Key string `json:"key"`
	// As typed; Encoding says how to turn it into bytes.
	Value string `json:"value"`
	// "string" (the default), "json" or "base64".
	Encoding string `json:"encoding"`
}

// messages.produce: send one message. Key and value are text plus the encoding that
// turns it into bytes; null is a message with no key, or — for the value — a tombstone.
type produceParams struct {
	Cluster string `json:"cluster"`
	Topic   string `json:"topic"`
	// Null lets the cluster's partitioner choose, from the key if there is one.
	Partition     *int32          `json:"partition"`
	Key           *string         `json:"key"`
	KeyEncoding   string          `json:"keyEncoding"`
	Value         *string         `json:"value"`
	ValueEncoding string          `json:"valueEncoding"`
	Headers       []produceHeader `json:"headers"`
	// When set, the value is JSON for this schema and the agent serializes it (K-45): the
	// schema is read from the cluster's registry, and the bytes on the topic carry the
	// Confluent header. Null sends the value as it is.
	Schema *produceSchema `json:"schema"`
	// The same, for the key.
	KeySchema *produceSchema `json:"keySchema"`
}

// Which schema a sent value is written with: a subject, and a version of it (-1 is the
// latest, the registry's own shorthand).
type produceSchema struct {
	Subject string `json:"subject"`
	Version int    `json:"version"`
}

// Where a sent message landed.
type produceResult struct {
	Partition int32 `json:"partition"`
	Offset    int64 `json:"offset"`
	// Milliseconds since the epoch.
	Timestamp int64 `json:"timestamp"`
}

// topics.delete. Confirm must be the topic's name again: the agent refuses a delete
// that was not asked for by name, whatever the page thinks it did.
type deleteTopicParams struct {
	Cluster string `json:"cluster"`
	Topic   string `json:"topic"`
	Confirm string `json:"confirm"`
}

type deleteTopicResult struct {
	Topic string `json:"topic"`
	// How many messages it held (retained ones, summed over partitions).
	Messages int64 `json:"messages"`
}

// topics.create. With ValidateOnly the cluster is asked whether it would create the
// topic and nothing is created.
type createTopicParams struct {
	Cluster           string `json:"cluster"`
	Topic             string `json:"topic"`
	Partitions        int32  `json:"partitions"`
	ReplicationFactor int16  `json:"replicationFactor"`
	// Topic settings by their Kafka names: retention.ms, cleanup.policy and the like.
	Configs      map[string]string `json:"configs"`
	ValidateOnly bool              `json:"validateOnly"`
}

type createTopicResult struct {
	Topic             string `json:"topic"`
	Partitions        int32  `json:"partitions"`
	ReplicationFactor int16  `json:"replicationFactor"`
	// False for a validation: the cluster said yes, and nothing was made.
	Created bool `json:"created"`
}

// topics.alterConfigs: change a topic's settings, one by one, the way IncrementalAlterConfigs
// does — what is not named is left alone. A null value resets the setting to the cluster's
// default. With DryRun the cluster is asked whether it would take them (ValidateOnly) and
// answers with the difference; nothing is changed.
type alterConfigParams struct {
	Cluster string `json:"cluster"`
	Topic   string `json:"topic"`
	// Settings by their Kafka names; null resets one to the cluster's default.
	Configs map[string]*string `json:"configs"`
	DryRun  bool               `json:"dryRun"`
}

// One setting of an alter: what it is now and what it becomes. Only settings the request
// would change are listed, so the difference is the rows.
type alterConfigRow struct {
	Name string `json:"name"`
	// The value the topic has now; null when the cluster does not know the setting.
	Before *string `json:"before"`
	// The value it will have; null when the setting goes back to the cluster's default.
	After *string `json:"after"`
	// True when the value before is only the cluster's default, not something set on the topic.
	FromDefault bool `json:"fromDefault"`
}

type alterConfigResult struct {
	// False for a dry run.
	Applied bool             `json:"applied"`
	Rows    []alterConfigRow `json:"rows"`
}

// topics.addPartitions: raise a topic's partition count. Kafka can only add partitions,
// and the count is the total afterwards — not how many to add — as the CLI's
// --alter --partitions takes it. ValidateOnly asks the cluster and adds nothing.
type addPartitionsParams struct {
	Cluster string `json:"cluster"`
	Topic   string `json:"topic"`
	// The number of partitions the topic should have afterwards.
	Partitions   int32 `json:"partitions"`
	ValidateOnly bool  `json:"validateOnly"`
}

type addPartitionsResult struct {
	Topic string `json:"topic"`
	// What the topic had before, and what it has (or would have) now.
	From  int  `json:"from"`
	To    int  `json:"to"`
	Added bool `json:"added"`
}

// topics.deleteRecords: DeleteRecords — drop the records of one partition below an offset.
// Confirm must be the topic's name again: like a delete, a truncation nobody spelled out
// does not happen. -1 is the offset Kafka reads as "all of them".
type deleteRecordsParams struct {
	Cluster   string `json:"cluster"`
	Topic     string `json:"topic"`
	Partition int32  `json:"partition"`
	// Records below this offset go; -1 is everything in the partition.
	Offset  int64  `json:"offset"`
	Confirm string `json:"confirm"`
}

type deleteRecordsResult struct {
	Topic     string `json:"topic"`
	Partition int32  `json:"partition"`
	// Where the partition started before, and where it starts now.
	Before int64 `json:"before"`
	After  int64 `json:"after"`
	// How many records that removed.
	Deleted int64 `json:"deleted"`
}

// groups.delete: remove a consumer group and the offsets it committed. Confirm must be the
// group's name again; the group must have no members.
type deleteGroupParams struct {
	Cluster string `json:"cluster"`
	Group   string `json:"group"`
	Confirm string `json:"confirm"`
}

type deleteGroupResult struct {
	Group string `json:"group"`
	// How many committed offsets went with it.
	Offsets int `json:"offsets"`
}

// groups.reset: move a group's committed offsets for one topic. DryRun answers with what
// would change and changes nothing; the group must have no members either way.
type resetOffsetsParams struct {
	Cluster string `json:"cluster"`
	Group   string `json:"group"`
	Topic   string `json:"topic"`
	// Which partitions; empty or absent means all of them.
	Partitions []int32 `json:"partitions"`
	// "earliest", "latest", "timestamp", "offset" or "shift".
	To string `json:"to"`
	// Milliseconds since the epoch: the first offset at or after it. For "timestamp".
	Timestamp *int64 `json:"timestamp"`
	// The same offset in every chosen partition. For "offset".
	Offset *int64 `json:"offset"`
	// Move each partition by this many messages from where it is now; negative goes back.
	Shift  *int64 `json:"shift"`
	DryRun bool   `json:"dryRun"`
}

// One partition of a reset: where the group was, and where it is (or would be) after.
type resetRow struct {
	Topic     string `json:"topic"`
	Partition int32  `json:"partition"`
	// Null when the group had committed nothing for the partition.
	Before *int64 `json:"before"`
	After  int64  `json:"after"`
	// Where the partition's log starts and ends now: lag is end − offset.
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

type resetOffsetsResult struct {
	// False for a dry run.
	Applied bool       `json:"applied"`
	Rows    []resetRow `json:"rows"`
}

// ── consumer groups ───────────────────────────────────────────────────────

type groupSummary struct {
	Name         string `json:"name"`
	State        string `json:"state"`
	ProtocolType string `json:"protocolType"`
	Members      int    `json:"members"`
	// Sum of the group's lag over what it has committed; null when it cannot be worked out.
	Lag *int64 `json:"lag"`
}

type topicPartitions struct {
	Topic      string  `json:"topic"`
	Partitions []int32 `json:"partitions"`
}

type groupMember struct {
	MemberID    string            `json:"memberId"`
	ClientID    string            `json:"clientId"`
	Host        string            `json:"host"`
	Assignments []topicPartitions `json:"assignments"`
}

type partitionLag struct {
	Topic     string `json:"topic"`
	Partition int32  `json:"partition"`
	// Null when the group has committed nothing for the partition.
	Committed *int64 `json:"committed"`
	End       int64  `json:"end"`
	// end − committed, or the whole retained log when nothing is committed.
	Lag int64 `json:"lag"`
	// The member that holds the partition now, when the group is active.
	Member *string `json:"member"`
}

type groupDetail struct {
	Name         string         `json:"name"`
	State        string         `json:"state"`
	ProtocolType string         `json:"protocolType"`
	Protocol     string         `json:"protocol"`
	Coordinator  int32          `json:"coordinator"`
	Members      []groupMember  `json:"members"`
	Lag          []partitionLag `json:"lag"`
	TotalLag     int64          `json:"totalLag"`
}
