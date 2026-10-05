/** Wire protocol shared by the local kafka-agent and the browser client.
 *
 *  The kafka tab talks to `kafka-agent` (kafka-agent-go/), a small program on the
 *  user's machine, over a WebSocket on the loopback interface — the same
 *  arrangement, and the same frames, as the code-agent (src/code-agent/protocol.ts).
 *
 *  Frames:
 *    client -> agent   Req
 *    agent  -> client  Chunk*  Res          (one Res per Req, always last)
 *    agent  -> client  Push                 (unsolicited; no id)
 *
 *  What the page may say about *where* to connect is exactly one thing: the name
 *  of a cluster the agent already has in its own configuration. Bootstrap
 *  servers, key and trust stores and their passwords, SCRAM credentials — none of
 *  it crosses this wire in either direction (see clusters.list).
 *
 *  Keys and values of messages are bytes, and go as base64: a Kafka value is not
 *  text until somebody decides it is, and the page is the one that decides.
 *
 *  kafka-agent-go/protocol.go mirrors every interface here, and its op table
 *  names the parameter type of each op — `bun run protocol:check` compares both.
 */

export interface Req {
  id: number;
  op: string;
  [param: string]: unknown;
}

export type Res =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string; code?: string };

/** Partial result of a long-running op (consumed messages). */
export interface Chunk {
  id: number;
  chunk: unknown;
}

/** Server-initiated message. The kafka-agent sends one: `clusters.changed`. */
export interface Push {
  event: string;
  data: unknown;
}

export type ServerFrame = Res | Chunk | Push;

/** Error codes an op can fail with, besides the code-agent's shared ones.
 *
 *    ENOOP      no such op
 *    EPARAM     a parameter of the wrong type or out of range
 *    ENOCLUSTER the cluster is not in the agent's configuration
 *    ECONFIG    the cluster's settings cannot be used (a store will not open)
 *    EKAFKA     the cluster refused, or did not answer, the request
 *    ECANCELED  the page cancelled it
 *    EBUSY      too many requests in flight on this connection
 *    READ_ONLY  a write op named a cluster the agent holds read-only: refused before
 *               anything was sent to a broker (the message says what to change)
 *    EGROUPACTIVE  the consumer group has members: its offsets cannot be reset until they stop
 */
export type KafkaErrorCode = "ENOOP" | "EPARAM" | "ENOCLUSTER" | "ECONFIG" | "EKAFKA" | "ECANCELED" | "EBUSY" | "READ_ONLY" | "EGROUPACTIVE";

// ── agent and clusters ────────────────────────────────────────────────────

export interface KafkaAgentInfo {
  /** Always "kafka-agent": the page checks it, so a URL pasted into the wrong tab
   *  is refused by name instead of failing on the first unknown op. */
  agent: "kafka-agent";
  version: string;
  platform: string;
  clusters: ClusterInfo[];
}

export interface ClusterInfo {
  name: string;
  readOnly: boolean;
}

/** One cluster as clusters.list reports it. No bootstrap servers, no stores, no
 *  credentials: those stay in the agent. */
export interface ClusterEntry {
  name: string;
  readOnly: boolean;
  /** PLAINTEXT, SSL, SASL_PLAINTEXT or SASL_SSL. */
  protocol: string;
  /** SCRAM-SHA-256 or SCRAM-SHA-512; absent without SASL. */
  mechanism?: string;
}

export type ClusterState = "connected" | "unreachable" | "tls_failed" | "auth_failed" | "config_error";

export interface ClusterStatus {
  name: string;
  state: ClusterState;
  /** Why, when the state is not "connected": a sentence that ends in the thing to change. */
  message?: string;
  /** Null unless connected. */
  clusterId: string | null;
  controller: number | null;
  brokers: number | null;
  /** The Kafka version the brokers' API support corresponds to — a guess. */
  version: string | null;
}

/** What config.reload answers: the clusters as they are now, and what changed. */
export interface ReloadResult {
  clusters: ClusterEntry[];
  added: string[];
  removed: string[];
  /** Clusters whose settings differ from before: their connections were dropped. */
  changed: string[];
  /** Things the agent noted while reading — settings it ignored, and the like. */
  warnings: string[];
}

/** The `clusters.changed` push: the agent's configuration was reloaded, by this page
 *  or by another; what is shown about clusters is stale. */
export interface ClustersChanged {
  clusters: ClusterEntry[];
}

// ── parameters ────────────────────────────────────────────────────────────

export interface NoParams {
  // an op that takes nothing
}

export interface CancelParams {
  /** The id of the request to stop. Only this connection's own are reachable. */
  target: number;
}

export interface ClusterParams {
  cluster: string;
}

export interface BrokerParams {
  cluster: string;
  broker: number;
}

export interface TopicParams {
  cluster: string;
  topic: string;
}

export interface GroupParams {
  cluster: string;
  group: string;
}

// ── brokers ───────────────────────────────────────────────────────────────

export interface Broker {
  id: number;
  host: string;
  port: number;
  rack: string | null;
  controller: boolean;
}

export interface BrokerList {
  clusterId: string | null;
  controller: number | null;
  brokers: Broker[];
}

/** One configuration entry of a broker or a topic. */
export interface ConfigEntry {
  name: string;
  /** Null for a sensitive entry: the agent never reads those out. */
  value: string | null;
  /** Where the value comes from: "dynamic broker", "static broker", "default", "topic"… */
  source: string;
  sensitive: boolean;
  readOnly: boolean;
  /** True when the value is the default, not something somebody set. */
  isDefault: boolean;
}

// ── topics ────────────────────────────────────────────────────────────────

export interface TopicSummary {
  name: string;
  internal: boolean;
  partitions: number;
  replicationFactor: number;
  /** Partitions whose in-sync replicas are fewer than their replicas. */
  underReplicated: number;
  /** Sum of (end − start) over the partitions: what is retained, not what was ever written. */
  messages: number;
  /** Bytes on the brokers' disks, replicas included; null when the cluster would not say. */
  size: number | null;
}

export interface PartitionInfo {
  id: number;
  leader: number;
  replicas: number[];
  isr: number[];
  start: number;
  end: number;
  size: number | null;
}

export interface TopicDetail {
  name: string;
  internal: boolean;
  partitions: PartitionInfo[];
}

// ── messages ──────────────────────────────────────────────────────────────

export type ConsumeFrom = "start" | "end" | "offset" | "time";

export interface ConsumeParams {
  cluster: string;
  topic: string;
  /** Which partitions; empty or absent means all of them. */
  partitions?: number[];
  /** "start": the oldest first. "end": the newest N, newest first. "offset": from
   *  `offset` on, one partition. "time": from the first message at or after `timestamp`. */
  from: ConsumeFrom;
  offset?: number;
  /** Milliseconds since the epoch. */
  timestamp?: number;
  /** How many messages to return (after filtering). */
  limit: number;
  /** Keep only messages whose key or value contains this text (or matches it as a
   *  regular expression). The agent applies it, so a filter over a large topic
   *  does not ship the topic to the page. */
  filter?: string;
  regex?: boolean;
  caseSensitive?: boolean;
}

export interface MessageHeader {
  key: string;
  /** base64 */
  value: string | null;
}

export interface KafkaMessage {
  partition: number;
  offset: number;
  /** Milliseconds since the epoch. */
  timestamp: number;
  /** base64; null for a null key. */
  key: string | null;
  /** base64, cut at the agent's per-value cap when `truncated`; null for a tombstone. */
  value: string | null;
  headers: MessageHeader[];
  keySize: number;
  valueSize: number;
  /** The value shown is a prefix — messages.get has the rest, up to a hard cap. */
  truncated: boolean;
}

/** What a messages.consume or messages.tail chunk carries. */
export interface MessageBatch {
  messages: KafkaMessage[];
  /** How many matching messages the agent dropped from this stretch because they came
   *  faster than a page can show: the newest are kept. Always 0 for messages.consume. */
  skipped: number;
}

export type ConsumeStop = "end" | "limit" | "scan-limit" | "window" | "idle";

export interface ConsumeResult {
  /** How many messages the agent read, matching or not. */
  scanned: number;
  /** How many it sent: those that matched the filter, up to the limit. */
  matched: number;
  /** Why it stopped: it ran out of messages, filled the limit, hit the scan
   *  ceiling, filled the window it holds before sorting, or stopped hearing from
   *  the cluster. */
  stopped: ConsumeStop;
  /** How many matching messages the agent dropped to stay inside that window.
   *  Only a `from: end` read has one, so this is 0 everywhere else. */
  skipped: number;
}

/** Follow a topic from where it ends now: what is written from here on arrives as
 *  it is written, until the request is cancelled. */
export interface TailParams {
  cluster: string;
  topic: string;
  /** Which partitions; empty or absent means all of them. */
  partitions?: number[];
  /** As for messages.consume: applied by the agent. */
  filter?: string;
  regex?: boolean;
  caseSensitive?: boolean;
}

/** What a tail answers with when it ends other than by being cancelled — a cancelled
 *  one is an ECANCELED error, like any other op that was stopped. */
export interface TailResult {
  /** How many messages it sent. */
  received: number;
}

export interface GetMessageParams {
  cluster: string;
  topic: string;
  partition: number;
  offset: number;
}

// ── schema registry ───────────────────────────────────────────────────────

/** What a registry can be, as the page sees it. Apart from `not_configured` these are not
 *  the cluster's states: a registry has its own URL, login and stores. */
export type SchemaState = "not_configured" | "connected" | "auth_failed" | "unreachable" | "tls_failed" | "error";

/** schemas.status: whether a cluster has a Schema Registry, and whether it answers. */
export interface SchemaStatus {
  name: string;
  state: SchemaState;
  /** Why, when the state is not connected: a sentence ending in the setting to change. */
  message?: string;
  /** What the registry says about itself, when it answered: "READWRITE", "READONLY"… */
  mode: string | null;
  /** The default compatibility level, when it answered. */
  compatibility: string | null;
  /** How many subjects it holds; null when that listing did not answer. */
  subjects: number | null;
}

/** messages.decode: read one schema-encoded value — a message's value or its key: the wire
 *  format does not care which. */
export interface DecodeValueParams {
  cluster: string;
  /** The value's bytes, base64 — exactly as they came off the topic. */
  value: string;
}

export type SchemaType = "AVRO" | "PROTOBUF" | "JSON";

/** What a schema-encoded value held. */
export interface DecodedValue {
  schemaId: number;
  schemaType: SchemaType | string;
  /** Where the schema is registered, when the registry says. */
  subject: string | null;
  version: number | null;
  /** The value as JSON text, whatever the schema's own format was. */
  json: string;
  /** The Protobuf message it held, when the schema declares more than one. */
  message: string | null;
}

/** schemas.subjects: every subject the registry holds. Names only — a subject's versions
 *  cost one request per version, which a list of hundreds is not worth. */
export interface SubjectNames {
  subjects: string[];
}

/** One subject to read. */
export interface SubjectParams {
  cluster: string;
  subject: string;
}

/** One version of one subject. The text is not here: that is schemas.version. */
export interface SchemaVersion {
  version: number;
  id: number;
  type: SchemaType | string;
}

export interface SubjectVersions {
  subject: string;
  /** The subject's own compatibility level; null means it follows the registry's default. */
  compatibility: string | null;
  /** The subject's own mode; null means the registry's. */
  mode: string | null;
  versions: SchemaVersion[];
}

/** One version's text to read. */
export interface SchemaVersionParams {
  cluster: string;
  subject: string;
  /** 1 or more, or -1 for the latest. */
  version: number;
}

/** One reference of a schema: another schema this one is written in terms of. */
export interface SchemaReference {
  name: string;
  subject: string;
  version: number;
}

export interface SchemaVersionText {
  subject: string;
  version: number;
  id: number;
  type: SchemaType | string;
  schema: string;
  /** Empty for a schema that stands alone, which is most of them. */
  references: SchemaReference[];
}

// ── writing schemas ───────────────────────────────────────────────────────
// Registering a version and changing a compatibility level change the registry, so the
// agent refuses them on a read-only cluster (READ_ONLY) before anything is sent — the
// switch is the cluster's, and one switch is easier to trust than two. schemas.check asks
// the same question as a register and changes nothing, so it is a read.

/** schemas.register: a new version of a subject. The registry checks compatibility itself
 *  and refuses in its own words; `schemas.check` asks the same question first. */
export interface RegisterSchemaParams {
  cluster: string;
  subject: string;
  /** The schema's text: Avro JSON, a .proto, or a JSON Schema. */
  schema: string;
  /** AVRO, PROTOBUF or JSON; empty is AVRO, which is the registry's own default. */
  type: SchemaType | string;
  /** Empty for a schema that stands alone, which is most of them. */
  references: SchemaReference[];
}

/** What the registry made of a registered schema. */
export interface RegisteredSchema {
  subject: string;
  version: number;
  id: number;
  type: SchemaType | string;
}

/** schemas.check: whether the registry would take a schema, and why not. */
export interface CheckSchemaParams {
  cluster: string;
  subject: string;
  schema: string;
  type: SchemaType | string;
  /** 1 or more, -1 for the latest, or -2 for all of them: the registry's own shorthand. */
  version: number;
  references: SchemaReference[];
}

/** What the registry said about a schema it was asked to check. */
export interface SchemaCheck {
  compatible: boolean;
  /** The registry's own reasons, empty when the schema would be taken. */
  messages: string[];
}

/** schemas.setCompatibility: the level a subject is held to, or the registry's default. */
export interface SetCompatibilityParams {
  cluster: string;
  /** Empty sets the registry's default, for subjects that have no level of their own. */
  subject: string;
  /** NONE, BACKWARD, BACKWARD_TRANSITIVE, FORWARD, FORWARD_TRANSITIVE, FULL or
   *  FULL_TRANSITIVE; empty takes the subject back to following the registry's default. */
  level: string;
}

/** The level in force afterwards, as the registry reports it — not what was asked for. */
export interface CompatibilitySet {
  subject: string;
  level: string;
}

/** acls.list: one ACL. */
export interface AclEntry {
  principal: string;
  /** The host the principal may connect from; "*" for any. */
  host: string;
  /** topic, group, cluster, transactional_id or delegation_token. */
  resourceType: string;
  /** A literal name, a prefix or "*": patternType says which. */
  resourceName: string;
  patternType: string;
  operation: string;
  /** allow or deny. */
  permission: string;
}

export interface AclList {
  acls: AclEntry[];
}

// ── writing ───────────────────────────────────────────────────────────────
// Both ops below change a cluster, so the agent refuses them on a read-only one
// (READ_ONLY) before it touches a broker.

/** How the text of a key, a value or a header becomes bytes: as typed (UTF-8), as typed
 *  after checking it is JSON, or as what base64 encodes. */
export type ProduceEncoding = "string" | "json" | "base64";

export interface ProduceHeader {
  key: string;
  /** As typed; `encoding` says how to turn it into bytes. */
  value: string;
  encoding: ProduceEncoding;
}

/** messages.produce: send one message. */
export interface ProduceParams {
  cluster: string;
  topic: string;
  /** Null lets the cluster's partitioner choose, from the key if there is one. */
  partition: number | null;
  /** Null: a message with no key. */
  key: string | null;
  keyEncoding: ProduceEncoding;
  /** Null: a tombstone. An empty string is an empty value, not a tombstone. */
  value: string | null;
  valueEncoding: ProduceEncoding;
  headers: ProduceHeader[];
  /** When set, the value is JSON for this schema and the agent serializes it (K-45): the
   *  schema is read from the cluster's registry, and the bytes carry the Confluent header. */
  schema: ProduceSchema | null;
  /** The same, for the key. */
  keySchema: ProduceSchema | null;
}

/** Which schema a sent value is written with: a subject, and a version of it (-1 is the
 *  latest, the registry's own shorthand). */
export interface ProduceSchema {
  subject: string;
  version: number;
}

/** Where a sent message landed. */
export interface ProduceResult {
  partition: number;
  offset: number;
  /** Milliseconds since the epoch. */
  timestamp: number;
}

/** topics.delete. `confirm` is the topic's name again: the agent refuses a delete that
 *  was not asked for by name, whatever the page thinks it did. */
export interface DeleteTopicParams {
  cluster: string;
  topic: string;
  confirm: string;
}

export interface DeleteTopicResult {
  topic: string;
  /** How many messages it held (retained ones, summed over partitions). */
  messages: number;
}

/** topics.create. With `validateOnly` the cluster is asked whether it would create the topic,
 *  and nothing is created. */
export interface CreateTopicParams {
  cluster: string;
  topic: string;
  partitions: number;
  replicationFactor: number;
  /** Topic settings by their Kafka names: retention.ms, cleanup.policy and the like. */
  configs: Record<string, string>;
  validateOnly: boolean;
}

export interface CreateTopicResult {
  topic: string;
  partitions: number;
  replicationFactor: number;
  /** False for a validation: the cluster said yes, and nothing was made. */
  created: boolean;
}

export type ResetTo = "earliest" | "latest" | "timestamp" | "offset" | "shift";

/** topics.alterConfigs: change a topic's settings one by one, the way
 *  IncrementalAlterConfigs does — what is not named is left alone. A null value resets a
 *  setting to the cluster's default. With `dryRun` the cluster is asked whether it would
 *  take them (`ValidateOnly`) and answers with the difference; nothing is changed. */
export interface AlterConfigParams {
  cluster: string;
  topic: string;
  /** Settings by their Kafka names; null resets one to the cluster's default. */
  configs: Record<string, string | null>;
  dryRun: boolean;
}

/** One setting of an alter: what it is now and what it becomes. Only settings the request
 *  would change are listed, so the rows are the difference. */
export interface AlterConfigRow {
  name: string;
  /** The value the topic has now; null when the cluster does not know the setting. */
  before: string | null;
  /** The value it will have; null when the setting goes back to the cluster's default. */
  after: string | null;
  /** True when the value before is only the cluster's default, not something set on the topic. */
  fromDefault: boolean;
}

export interface AlterConfigResult {
  /** False for a dry run. */
  applied: boolean;
  rows: AlterConfigRow[];
}

/** topics.addPartitions: raise a topic's partition count. Kafka only adds partitions, and
 *  the count is the total afterwards — not how many to add. `validateOnly` asks the cluster
 *  and adds nothing. */
export interface AddPartitionsParams {
  cluster: string;
  topic: string;
  /** The number of partitions the topic should have afterwards. */
  partitions: number;
  validateOnly: boolean;
}

export interface AddPartitionsResult {
  topic: string;
  /** What the topic had before, and what it has (or would have) now. */
  from: number;
  to: number;
  added: boolean;
}

/** topics.deleteRecords: DeleteRecords — drop the records of one partition below an offset.
 *  `confirm` is the topic's name again: like a delete, a truncation nobody spelled out does
 *  not happen. -1 is the offset Kafka reads as "all of them". */
export interface DeleteRecordsParams {
  cluster: string;
  topic: string;
  partition: number;
  /** Records below this offset go; -1 is everything in the partition. */
  offset: number;
  confirm: string;
}

export interface DeleteRecordsResult {
  topic: string;
  partition: number;
  /** Where the partition started before, and where it starts now. */
  before: number;
  after: number;
  /** How many records that removed. */
  deleted: number;
}

/** groups.delete: remove a consumer group and the offsets it committed. `confirm` is the
 *  group's name again; the group must have no members. */
export interface DeleteGroupParams {
  cluster: string;
  group: string;
  confirm: string;
}

export interface DeleteGroupResult {
  group: string;
  /** How many committed offsets went with it. */
  offsets: number;
}

/** groups.reset: move a group's committed offsets for one topic. `dryRun` answers with what
 *  would change and changes nothing; either way the group must have no members. */
export interface ResetOffsetsParams {
  cluster: string;
  group: string;
  topic: string;
  /** Which partitions; empty or absent means all of them. */
  partitions: number[] | null;
  to: ResetTo;
  /** Milliseconds since the epoch: the first offset at or after it. For "timestamp". */
  timestamp: number | null;
  /** The same offset in every chosen partition. For "offset". */
  offset: number | null;
  /** Move each partition by this many messages from where it is now; negative goes back. */
  shift: number | null;
  dryRun: boolean;
}

/** One partition of a reset: where the group was, and where it is (or would be) after. */
export interface ResetRow {
  topic: string;
  partition: number;
  /** Null when the group had committed nothing for the partition. */
  before: number | null;
  after: number;
  /** Where the partition's log starts and ends now: lag is end − offset. */
  start: number;
  end: number;
}

export interface ResetOffsetsResult {
  /** False for a dry run. */
  applied: boolean;
  rows: ResetRow[];
}

// ── consumer groups ───────────────────────────────────────────────────────

export interface GroupSummary {
  name: string;
  state: string;
  protocolType: string;
  members: number;
  /** Sum of the group's lag over what it has committed; null when it cannot be worked out. */
  lag: number | null;
}

export interface TopicPartitions {
  topic: string;
  partitions: number[];
}

export interface GroupMember {
  memberId: string;
  clientId: string;
  host: string;
  assignments: TopicPartitions[];
}

export interface PartitionLag {
  topic: string;
  partition: number;
  /** Null when the group has committed nothing for the partition. */
  committed: number | null;
  end: number;
  /** end − committed, or the whole retained log when nothing is committed. */
  lag: number;
  /** The member that holds the partition now, when the group is active. */
  member: string | null;
}

export interface GroupDetail {
  name: string;
  state: string;
  protocolType: string;
  protocol: string;
  coordinator: number;
  members: GroupMember[];
  lag: PartitionLag[];
  totalLag: number;
}

// ── the op table ──────────────────────────────────────────────────────────

/** Every op: its parameters and what it answers. The browser client is typed by
 *  this table, and protocol:check holds the Go op table to its names and
 *  parameter types. */
export interface KafkaOps {
  "agent.info": { params: NoParams; result: KafkaAgentInfo };
  "cancel": { params: CancelParams; result: { cancelled: boolean } };
  "config.reload": { params: NoParams; result: ReloadResult };
  "clusters.list": { params: NoParams; result: ClusterEntry[] };
  "clusters.status": { params: ClusterParams; result: ClusterStatus };
  "brokers.list": { params: ClusterParams; result: BrokerList };
  "brokers.config": { params: BrokerParams; result: ConfigEntry[] };
  "schemas.status": { params: ClusterParams; result: SchemaStatus };
  "messages.decode": { params: DecodeValueParams; result: DecodedValue };
  "schemas.subjects": { params: ClusterParams; result: SubjectNames };
  "schemas.versions": { params: SubjectParams; result: SubjectVersions };
  "schemas.version": { params: SchemaVersionParams; result: SchemaVersionText };
  "schemas.check": { params: CheckSchemaParams; result: SchemaCheck };
  "schemas.register": { params: RegisterSchemaParams; result: RegisteredSchema };
  "schemas.setCompatibility": { params: SetCompatibilityParams; result: CompatibilitySet };
  "acls.list": { params: ClusterParams; result: AclList };
  "topics.list": { params: ClusterParams; result: TopicSummary[] };
  "topics.describe": { params: TopicParams; result: TopicDetail };
  "topics.config": { params: TopicParams; result: ConfigEntry[] };
  "messages.consume": { params: ConsumeParams; result: ConsumeResult };
  "messages.tail": { params: TailParams; result: TailResult };
  "messages.get": { params: GetMessageParams; result: KafkaMessage };
  "messages.produce": { params: ProduceParams; result: ProduceResult };
  "topics.delete": { params: DeleteTopicParams; result: DeleteTopicResult };
  "topics.create": { params: CreateTopicParams; result: CreateTopicResult };
  "groups.reset": { params: ResetOffsetsParams; result: ResetOffsetsResult };
  "topics.alterConfigs": { params: AlterConfigParams; result: AlterConfigResult };
  "topics.addPartitions": { params: AddPartitionsParams; result: AddPartitionsResult };
  "topics.deleteRecords": { params: DeleteRecordsParams; result: DeleteRecordsResult };
  "groups.delete": { params: DeleteGroupParams; result: DeleteGroupResult };
  "groups.list": { params: ClusterParams; result: GroupSummary[] };
  "groups.describe": { params: GroupParams; result: GroupDetail };
}

export type KafkaOp = keyof KafkaOps;
