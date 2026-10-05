/** What the kafka tab knows, and how it finds out.
 *
 *  One object holds the clusters the agent offers, which one is open, what is
 *  selected, and the lists that were fetched for the open cluster. Views read it
 *  and subscribe; they do not fetch on their own, so two panels wanting the
 *  topic list are one request, and a cluster switch has one place to forget.
 */
import type {
  AddPartitionsParams,
  AddPartitionsResult,
  AlterConfigParams,
  AlterConfigResult,
  BrokerList,
  CheckSchemaParams,
  ClusterEntry,
  ClusterStatus,
  ClustersChanged,
  CompatibilitySet,
  CreateTopicParams,
  CreateTopicResult,
  DeleteGroupResult,
  DeleteRecordsParams,
  DeleteRecordsResult,
  DeleteTopicResult,
  DecodedValue,
  AclEntry,
  GroupSummary,
  ProduceParams,
  ProduceResult,
  RegisterSchemaParams,
  RegisteredSchema,
  ReloadResult,
  ResetOffsetsParams,
  ResetOffsetsResult,
  SchemaCheck,
  SchemaStatus,
  SetCompatibilityParams,
  SubjectVersions,
  TopicSummary,
} from "../../kafka-agent/protocol.ts";
import { SCHEMA_TEXT, STATE_TEXT } from "./format.ts";
import type { KafkaAgentClient } from "./kafka-agent.ts";

export type ViewName = "clusters" | "topics" | "groups" | "brokers" | "schemas" | "acls";

export type Selection =
  | { kind: "cluster" }
  | { kind: "topic"; name: string }
  | { kind: "group"; name: string }
  | { kind: "broker"; id: number }
  | { kind: "subject"; name: string };

/** A list that is being fetched, has arrived, or failed. */
export interface Load<T> {
  state: "idle" | "loading" | "ready" | "error";
  data: T | null;
  error: string;
}

const idle = <T>(): Load<T> => ({ state: "idle", data: null, error: "" });

const CLUSTER_KEY = "enc-kafka-cluster";

/** How long a registry's answer counts as current for `open()`, in ms. */
const SCHEMA_FRESH_MS = 10_000;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class KafkaModel {
  clusters: ClusterEntry[] = [];
  statuses = new Map<string, ClusterStatus>();
  /** Each cluster's Schema Registry, as schemas.status reported it (K-41). */
  schemas = new Map<string, SchemaStatus>();
  /** Clusters whose status is being asked for right now. */
  checking = new Set<string>();
  /** Above zero while a pass over several clusters is starting them: each would say "checking"
   *  on its own, and the pass says it once. */
  private startingPass = 0;
  /** The registry questions in flight, by cluster: a second caller takes the first one's
   *  answer instead of sending its own (a registry that does not answer holds each for 10 s). */
  private schemaAsking = new Map<string, Promise<void>>();
  /** When each cluster's registry last answered, in ms. `open()` reads it to skip a question
   *  a refresh has just asked. */
  private schemaAt = new Map<string, number>();
  /** Bumped when what the registry answers for is invalidated (connection lost, configuration
   *  read again): an answer that was asked for before that is thrown away on arrival. */
  private schemaGen = 0;

  /** The open cluster, by name: the one every list below belongs to. */
  cluster: string | null = null;
  view: ViewName = "clusters";
  selection: Selection = { kind: "cluster" };
  /** Whether the page is dark. The tab keeps this true to the theme; a dialog opened from
   *  a side panel has no view to ask, and its editor has to be told. */
  dark = false;

  topics: Load<TopicSummary[]> = idle();
  groups: Load<GroupSummary[]> = idle();
  brokers: Load<BrokerList> = idle();
  /** The registry's subjects, when the schemas view is open and the cluster has a registry
   *  (K-43). Names only: see srschema.go for why. */
  subjects: Load<string[]> = idle();
  /** Every ACL the login may see (K-44), for the acls view. */
  acls: Load<AclEntry[]> = idle();
  /** What the ACL table is filtered by. It lives here because two things set it: the filter
   *  inputs in the table, and the principal picked in the side panel. */
  aclFilter: { principal: string; resource: string; exact: boolean } = { principal: "", resource: "", exact: false };
  /** Who wants to know the ACL filter changed: the table and the principal list. The filter is not
   *  the model's data, so it does not go through `changed()` — which repaints every panel and
   *  the main area for what only two of them show. */
  private aclFilterListeners = new Set<() => void>();

  private listeners = new Set<() => void>();
  /** A line for the toast stack; set by the tab. */
  notify: ((message: string, isError?: boolean) => void) | null = null;
  /** Where the tab's output log is fed from; set once the tab has built one. */
  onLog: ((op: string, level: "info" | "error", summary: string, detail?: string) => void) | null = null;
  /** Bumped when the cluster changes, so an answer that arrives for the cluster
   *  the user has since left is thrown away instead of painted over the new one. */
  private epoch = 0;

  /** The client subscription this model made. Kept so that unmounting can take
   *  it off: a listener left on the shared client outlives the markup it was
   *  refreshing, and a second mount would refresh twice. */
  private readonly offClusters: () => void;

  constructor(readonly client: KafkaAgentClient) {
    // The agent's configuration was reloaded — by this page or by another one.
    this.offClusters = client.on("clusters.changed", (data) => void this.onClustersChanged(data as ClustersChanged));
  }

  /** Take this model's subscription off the client. */
  dispose(): void {
    this.offClusters();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }

  get entry(): ClusterEntry | null {
    return this.clusters.find((c) => c.name === this.cluster) ?? null;
  }

  get status(): ClusterStatus | null {
    return this.cluster ? (this.statuses.get(this.cluster) ?? null) : null;
  }

  /** Say something in the output log: what was asked of the cluster and what it answered.
   *  `op` is the agent's own op name, so a line reads like the request behind it. */
  log(op: string, summary: string, detail?: string): void {
    this.onLog?.(op, "info", summary, detail);
  }

  /** A failure, in the same place. The first line is the summary, the whole text the detail. */
  logError(op: string, e: unknown): void {
    const full = message(e);
    const first = full.split(/\r?\n/, 1)[0].slice(0, 200);
    this.onLog?.(op, "error", first, full.includes("\n") || full.length > 200 ? full : undefined);
  }

  /** Read-only is the agent's word, and the page only shows it. */
  get readOnly(): boolean {
    return this.entry?.readOnly ?? true;
  }

  // ── the agent went away or came ─────────────────────────────────────────

  /** Ask the agent to read its configuration again. Resolves with what changed; rejects
   *  with the reason when the file is not sound, in which case nothing changed. */
  reloadConfig(): Promise<ReloadResult> {
    return this.client.op("config.reload", {});
  }

  /** The list of clusters changed under us: take the new one, forget what was known
   *  of clusters that are gone, and ask again about the rest — one of them may now
   *  live somewhere else. */
  private async onClustersChanged(data: ClustersChanged): Promise<void> {
    this.clusters = data.clusters;
    // What the agent said about itself when it connected is now out of date too, and
    // the header badge reads it.
    if (this.client.info) this.client.info.clusters = data.clusters.map((c) => ({ name: c.name, readOnly: c.readOnly }));
    const names = new Set(data.clusters.map((c) => c.name));
    for (const name of [...this.statuses.keys()]) {
      if (!names.has(name)) {
        this.statuses.delete(name);
        this.client.clusterStates.delete(name);
      }
    }
    // "No registry" was true of the old configuration. The new one may name one, and
    // refreshStatuses() does not ask a cluster it has that answer for.
    for (const [name, s] of [...this.schemas]) {
      if (s.state === "not_configured" || !names.has(name)) this.schemas.delete(name);
    }
    // A name may now point at another registry: no answer by name is current, and none still on
    // its way was given for this configuration.
    this.schemaGen++;
    this.schemaAt.clear();
    this.schemaAsking.clear();
    if (this.cluster && !names.has(this.cluster)) {
      this.epoch++;
      this.cluster = null;
      this.selection = { kind: "cluster" };
      this.resetLists();
    }
    this.changed();
    this.refreshStatuses();
    if (this.cluster) await this.refresh();
  }

  /** Called when the connection to the agent is (re)established. */
  async onOnline(): Promise<void> {
    await this.loadClusters();
  }

  /** Called when the connection is lost: what was fetched over it is now stale. */
  onOffline(): void {
    this.epoch++;
    this.clusters = [];
    this.statuses.clear();
    this.schemas.clear();
    this.schemaGen++;
    this.schemaAt.clear();
    this.schemaAsking.clear();
    this.checking.clear();
    this.client.clusterStates.clear();
    this.client.onClusters?.();
    this.resetLists();
    this.changed();
  }

  async loadClusters(): Promise<void> {
    try {
      this.clusters = await this.client.op("clusters.list", {});
    } catch (e) {
      this.clusters = [];
      console.warn("clusters.list:", message(e));
    }
    // The cluster the user had open last time, when it is still on offer;
    // otherwise the only one there is.
    let remembered = "";
    try {
      remembered = localStorage.getItem(CLUSTER_KEY) ?? "";
    } catch {
      /* private mode */
    }
    const pick = this.clusters.find((c) => c.name === remembered) ?? (this.clusters.length === 1 ? this.clusters[0] : null);
    this.changed();
    // Every cluster is asked about, not only the one that opens: the list shows which are up, and
    // the header counts the ones that are down. The open cluster is already being asked (open()
    // starts its own question first, and a second one for the same cluster is not sent), so this
    // adds the others — and the registries — without waiting for the open one (X-10).
    const opening = pick ? this.open(pick.name) : undefined;
    this.refreshStatuses();
    await opening;
  }

  // ── clusters ────────────────────────────────────────────────────────────

  private resetLists(): void {
    this.topics = idle();
    this.groups = idle();
    this.brokers = idle();
    this.subjects = idle();
    this.acls = idle();
  }

  /** Every cluster's status, in the background, so the list can show which are up. The registry
   *  is asked only where there may be one: a cluster that said "not configured" has none until
   *  its configuration is read again (see onClustersChanged), and asking again is a request
   *  for nothing. */
  refreshStatuses(): void {
    this.startingPass++;
    for (const c of this.clusters) {
      void this.checkStatus(c.name);
      if (this.schemas.get(c.name)?.state !== "not_configured") void this.checkSchema(c.name);
    }
    this.startingPass--;
    this.changed();
  }

  /** Ask about one cluster's Schema Registry: whether it has one, and whether it answers.
   *  A registry that is not configured is an answer too — most clusters have none. */
  checkSchema(name: string): Promise<void> {
    const asking = this.schemaAsking.get(name);
    if (asking) return asking;
    const p: Promise<void> = this.askSchema(name).finally(() => {
      if (this.schemaAsking.get(name) === p) this.schemaAsking.delete(name);
    });
    this.schemaAsking.set(name, p);
    return p;
  }

  private async askSchema(name: string): Promise<void> {
    const gen = this.schemaGen;
    let s: SchemaStatus;
    try {
      s = await this.client.op("schemas.status", { cluster: name });
    } catch (e) {
      if (gen !== this.schemaGen) return;
      this.schemas.delete(name);
      this.schemaAt.delete(name);
      this.logError("schemas.status", e);
      this.changed();
      return;
    }
    if (gen !== this.schemaGen) return;
    const before = this.schemas.get(name);
    // Said when it changes, not on every refresh — the same rule as the cluster's own.
    if (s.state !== "not_configured" && (!before || before.state !== s.state || before.message !== s.message)) this.logSchema(name, s);
    this.schemas.set(name, s);
    this.schemaAt.set(name, Date.now());
    this.changed();
  }

  private logSchema(name: string, s: SchemaStatus): void {
    if (s.state === "connected") {
      const bits = [s.mode, s.compatibility, s.subjects === null ? "" : `${s.subjects} subject${s.subjects === 1 ? "" : "s"}`].filter(Boolean);
      this.log("schemas.status", `${name}: schema registry connected${bits.length ? ` · ${bits.join(" · ")}` : ""}`);
      return;
    }
    this.onLog?.("schemas.status", "error", `${name}: schema registry ${SCHEMA_TEXT[s.state]}`, s.message || undefined);
  }

  async checkStatus(name: string): Promise<void> {
    if (this.checking.has(name)) return;
    this.checking.add(name);
    if (!this.startingPass) this.changed();
    try {
      const status = await this.client.op("clusters.status", { cluster: name });
      // Said when the answer changes, not on every refresh: the log is a record of
      // what happened, and "still connected" ten times over buries the one that mattered.
      const before = this.statuses.get(name);
      if (!before || before.state !== status.state || before.message !== status.message) this.logStatus(name, status);
      this.statuses.set(name, status);
      this.client.clusterStates.set(name, status);
    } catch (e) {
      this.logError("clusters.status", e);
      // A request that failed, as opposed to a cluster that did not answer:
      // the agent went away, or the page cancelled it.
      this.statuses.delete(name);
      this.client.clusterStates.delete(name);
      console.warn("clusters.status:", message(e));
    } finally {
      this.checking.delete(name);
      this.client.onClusters?.();
      this.changed();
    }
  }

  private logStatus(name: string, s: ClusterStatus): void {
    if (s.state === "connected") {
      const brokers = s.brokers === null || s.brokers === undefined ? "" : ` · ${s.brokers} broker${s.brokers === 1 ? "" : "s"}`;
      this.log("clusters.status", `${name}: connected${brokers}${s.version ? ` · Kafka ${s.version}` : ""}`);
    } else {
      this.onLog?.("clusters.status", "error", `${name}: ${STATE_TEXT[s.state]}`, s.message || undefined);
    }
  }

  /** Open a cluster: everything shown from here on is about it. */
  async open(name: string): Promise<void> {
    if (this.cluster !== name) {
      this.epoch++;
      this.cluster = name;
      this.selection = { kind: "cluster" };
      this.resetLists();
      try {
        localStorage.setItem(CLUSTER_KEY, name);
      } catch {
        /* private mode */
      }
    }
    this.changed();
    await this.checkStatus(name);
    if (this.cluster === name && this.status?.state === "connected") this.loadFor(this.view);
    // An answer from the last few seconds is as good as a new one: a refresh or the status
    // pass just asked, and a registry that hangs makes this question cost 10 s.
    const answered = this.schemaAt.get(name);
    if (answered === undefined || Date.now() - answered > SCHEMA_FRESH_MS) void this.checkSchema(name);
  }

  setView(view: ViewName): void {
    this.view = view;
    this.changed();
    this.loadFor(view);
  }

  select(selection: Selection): void {
    this.selection = selection;
    this.changed();
  }

  private loadFor(view: ViewName): void {
    if (this.status?.state !== "connected") return;
    if (view === "topics" && this.topics.state === "idle") void this.loadTopics();
    if (view === "groups" && this.groups.state === "idle") void this.loadGroups();
    if (view === "brokers" && this.brokers.state === "idle") void this.loadBrokers();
    if (view === "schemas" && this.subjects.state === "idle") void this.loadSubjects();
    if (view === "acls" && this.acls.state === "idle") void this.loadACLs();
  }

  // ── lists ───────────────────────────────────────────────────────────────

  /** Fetch one list for the open cluster, and keep the answer only if the user
   *  is still looking at that cluster when it arrives. */
  private async fetch<T>(
    op: string,
    get: () => Promise<T>,
    read: () => Load<T>,
    write: (l: Load<T>) => void,
  ): Promise<void> {
    if (!this.cluster) return;
    const epoch = this.epoch;
    write({ state: "loading", data: read().data, error: "" });
    this.changed();
    try {
      const data = await get();
      if (epoch === this.epoch) write({ state: "ready", data, error: "" });
    } catch (e) {
      if (epoch === this.epoch) {
        write({ state: "error", data: null, error: message(e) });
        this.logError(op, e);
      }
    }
    if (epoch === this.epoch) this.changed();
  }

  loadTopics(): Promise<void> {
    const cluster = this.cluster!;
    return this.fetch(
      "topics.list",
      () => this.client.op("topics.list", { cluster }),
      () => this.topics,
      (l) => (this.topics = l),
    );
  }

  loadGroups(): Promise<void> {
    const cluster = this.cluster!;
    return this.fetch(
      "groups.list",
      () => this.client.op("groups.list", { cluster }),
      () => this.groups,
      (l) => (this.groups = l),
    );
  }

  loadBrokers(): Promise<void> {
    const cluster = this.cluster!;
    return this.fetch(
      "brokers.list",
      () => this.client.op("brokers.list", { cluster }),
      () => this.brokers,
      (l) => (this.brokers = l),
    );
  }

  /** The registry's subjects, for the schemas view. A cluster without a registry answers
   *  ENOREGISTRY, which the panel shows as a sentence rather than an empty list. */
  loadSubjects(): Promise<void> {
    const cluster = this.cluster!;
    return this.fetch(
      "schemas.subjects",
      async () => (await this.client.op("schemas.subjects", { cluster })).subjects,
      () => this.subjects,
      (l) => (this.subjects = l),
    );
  }

  /** Resolves once a list is no longer being fetched — at once when it is not. */
  private whenSettled(read: () => Load<unknown>): Promise<void> {
    if (read().state !== "loading") return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        if (read().state === "loading") return;
        off();
        resolve();
      });
    });
  }

  /** Every ACL the login may see, for the acls view. One request: a cluster's ACL list is a
   *  table a person reads, and filtering it per keystroke would be a request per keystroke. */
  loadACLs(): Promise<void> {
    const cluster = this.cluster!;
    return this.fetch(
      "acls.list",
      async () => (await this.client.op("acls.list", { cluster })).acls,
      () => this.acls,
      (l) => (this.acls = l),
    );
  }

  /** What the ACL table shows, and what the principal picked in the panel means. */
  setACLFilter(patch: Partial<{ principal: string; resource: string; exact: boolean }>): void {
    this.aclFilter = { ...this.aclFilter, ...patch };
    for (const cb of this.aclFilterListeners) cb();
  }

  subscribeACLFilter(cb: () => void): () => void {
    this.aclFilterListeners.add(cb);
    return () => this.aclFilterListeners.delete(cb);
  }

  /** Have the topic and group lists asked for and answered, for whoever wants both at
   *  once (the go-to picker) rather than whichever side panel happens to be open. */
  async ensureNames(): Promise<void> {
    if (this.status?.state !== "connected") return;
    if (this.topics.state === "idle") void this.loadTopics();
    if (this.groups.state === "idle") void this.loadGroups();
    await Promise.all([this.whenSettled(() => this.topics), this.whenSettled(() => this.groups)]);
  }

  // ── changing the cluster ────────────────────────────────────────────────
  // What the agent allows is its own decision (READ_ONLY); the page only offers these
  // where the cluster is not read-only. Each is one line in the output log — a write
  // is what somebody will ask about afterwards.

  /** Send one message to the open cluster. Rejects with the agent's words. */
  async produce(p: Omit<ProduceParams, "cluster">): Promise<ProduceResult> {
    const cluster = this.cluster!;
    try {
      const r = await this.client.op("messages.produce", { cluster, ...p });
      this.log("messages.produce", `${cluster}: sent to ${p.topic} — partition ${r.partition}, offset ${r.offset}`);
      // The topic list shows message counts, and one more has just been written.
      if (this.cluster === cluster && this.topics.state === "ready") void this.loadTopics();
      return r;
    } catch (e) {
      this.logError("messages.produce", e);
      throw e;
    }
  }

  /** Ask the cluster whether it would create a topic (`validateOnly`), or create it. A created
   *  topic is waited for: the cluster lists it a moment after it says yes. */
  async createTopic(p: Omit<CreateTopicParams, "cluster">): Promise<CreateTopicResult> {
    const cluster = this.cluster!;
    try {
      const r = await this.client.op("topics.create", { cluster, ...p });
      if (r.created) {
        this.log("topics.create", `${cluster}: created topic ${p.topic} (${p.partitions} partition${p.partitions === 1 ? "" : "s"}, replication factor ${p.replicationFactor})`);
        void this.showNewTopic(cluster, p.topic);
      }
      return r;
    } catch (e) {
      this.logError("topics.create", e);
      throw e;
    }
  }

  /** Wait for the new topic to be visible to the cluster, then read the list once and open it.
   *
   *  The brokers learn of a new topic a moment after the create is answered. Asking for the whole
   *  list every half second until it showed — a walk over every topic's offsets and directories,
   *  up to twelve times — was a heavy question asked for the sake of one name. The question here
   *  is the light one, about that topic only, with waits that grow, and the list is read when the
   *  answer is yes. About six seconds in all, as before. */
  private async showNewTopic(cluster: string, topic: string): Promise<void> {
    for (const wait of [0, 250, 500, 1000, 2000, 2500]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (this.cluster !== cluster) return;
      try {
        await this.client.op("topics.describe", { cluster, topic });
      } catch {
        continue; // not there yet
      }
      await this.loadTopics();
      if (this.cluster !== cluster) return;
      this.view = "topics";
      this.selection = { kind: "topic", name: topic };
      this.changed();
      return;
    }
  }

  /** Move a consumer group's offsets, or — with `dryRun` — say what moving them would do. */
  async resetOffsets(p: Omit<ResetOffsetsParams, "cluster">): Promise<ResetOffsetsResult> {
    const cluster = this.cluster!;
    try {
      const r = await this.client.op("groups.reset", { cluster, ...p });
      if (r.applied) this.log("groups.reset", `${cluster}: reset ${p.group} on ${p.topic} to ${p.to} — ${r.rows.length} partition${r.rows.length === 1 ? "" : "s"}`);
      return r;
    } catch (e) {
      // A preview that is refused is the dialog's to say; the log is for what was done or failed for real.
      if (!p.dryRun) this.logError("groups.reset", e);
      throw e;
    }
  }

  /** Delete a topic of the open cluster, and take it off the page. The agent is given
   *  the name a second time, as the confirmation the dialog collected. */
  async deleteTopic(topic: string): Promise<DeleteTopicResult> {
    const cluster = this.cluster!;
    let r: DeleteTopicResult;
    try {
      r = await this.client.op("topics.delete", { cluster, topic, confirm: topic });
    } catch (e) {
      this.logError("topics.delete", e);
      throw e;
    }
    this.log("topics.delete", `${cluster}: deleted topic ${topic} (${r.messages} message${r.messages === 1 ? "" : "s"})`);
    if (this.cluster === cluster) {
      // Gone from the page at once. The cluster's own list catches up a moment later, and
      // a list fetched now may still show it — so it is asked again after a pause, not now.
      if (this.topics.data) this.topics = { ...this.topics, data: this.topics.data.filter((t) => t.name !== topic) };
      this.selection = { kind: "cluster" };
      this.changed();
      setTimeout(() => this.cluster === cluster && void this.loadTopics(), 1500);
    }
    return r;
  }

  /** Change a topic's settings, or — with `dryRun` — say what changing them would do and
   *  ask the cluster whether it would take them. Only the settings named are touched. */
  async alterTopicConfigs(p: Omit<AlterConfigParams, "cluster">): Promise<AlterConfigResult> {
    const cluster = this.cluster!;
    try {
      const r = await this.client.op("topics.alterConfigs", { cluster, ...p });
      if (r.applied && r.rows.length > 0) {
        const names = r.rows.map((row) => row.name).join(", ");
        this.log("topics.alterConfigs", `${cluster}: ${p.topic} — ${r.rows.length} setting${r.rows.length === 1 ? "" : "s"} written (${names})`);
      }
      return r;
    } catch (e) {
      // A preview that is refused is the dialog's to say, not the log's.
      if (!p.dryRun) this.logError("topics.alterConfigs", e);
      throw e;
    }
  }

  /** Raise a topic's partition count — or, with `validateOnly`, ask the cluster whether it
   *  would and add nothing. */
  async addPartitions(p: Omit<AddPartitionsParams, "cluster">): Promise<AddPartitionsResult> {
    const cluster = this.cluster!;
    try {
      const r = await this.client.op("topics.addPartitions", { cluster, ...p });
      if (r.added) {
        this.log("topics.addPartitions", `${cluster}: ${r.topic} now has ${r.to} partitions (was ${r.from})`);
        if (this.cluster === cluster && this.topics.state === "ready") void this.loadTopics();
      }
      return r;
    } catch (e) {
      this.logError("topics.addPartitions", e);
      throw e;
    }
  }

  /** Drop the records of one partition below an offset. The agent is given the topic's name
   *  a second time, as the confirmation the dialog collected. */
  async deleteRecords(p: Omit<DeleteRecordsParams, "cluster">): Promise<DeleteRecordsResult> {
    const cluster = this.cluster!;
    try {
      const r = await this.client.op("topics.deleteRecords", { cluster, ...p });
      const n = `${r.deleted} record${r.deleted === 1 ? "" : "s"}`;
      this.log("topics.deleteRecords", `${cluster}: ${p.topic} partition ${p.partition} — deleted ${n}, it starts at ${r.after} now`);
      if (this.cluster === cluster && this.topics.state === "ready") void this.loadTopics();
      return r;
    } catch (e) {
      this.logError("topics.deleteRecords", e);
      throw e;
    }
  }

  /** Delete a consumer group of the open cluster and the offsets it committed. */
  async deleteGroup(group: string): Promise<DeleteGroupResult> {
    const cluster = this.cluster!;
    let r: DeleteGroupResult;
    try {
      r = await this.client.op("groups.delete", { cluster, group, confirm: group });
    } catch (e) {
      this.logError("groups.delete", e);
      throw e;
    }
    this.log("groups.delete", `${cluster}: deleted group ${group} (${r.offsets} committed offset${r.offsets === 1 ? "" : "s"})`);
    if (this.cluster === cluster) {
      // Off the page at once, like a deleted topic: the cluster's own list takes a
      // moment to agree, so it is asked again after a pause rather than now.
      if (this.groups.data) this.groups = { ...this.groups, data: this.groups.data.filter((g) => g.name !== group) };
      this.selection = { kind: "cluster" };
      this.changed();
      setTimeout(() => this.cluster === cluster && void this.loadGroups(), 1500);
    }
    return r;
  }

  /** Read one schema-encoded value with the registry's schema (K-42). The bytes go as they
   *  are — this is the only thing the page can do with them, and the agent has the
   *  registry, the decoders and the cache. */
  async decodeValue(value: string): Promise<DecodedValue> {
    const cluster = this.cluster!;
    const d = await this.client.op("messages.decode", { cluster, value });
    this.log(
      "messages.decode",
      `${cluster}: value read with schema ${d.schemaId} (${d.schemaType}${d.subject ? `, ${d.subject}` : ""}${d.version === null ? "" : ` v${d.version}`})`,
    );
    return d;
  }

  /** The registry's subjects and one subject's versions, for the send dialog's schema
   *  picker (K-45). Not logged: this is a menu being filled, not something that was asked
   *  of a cluster, and the lines would bury the sends themselves. */
  registrySubjects(): Promise<string[]> {
    return this.client.op("schemas.subjects", { cluster: this.cluster! }).then((r) => r.subjects);
  }

  registryVersions(subject: string): Promise<SubjectVersions> {
    return this.client.op("schemas.versions", { cluster: this.cluster!, subject });
  }

  /** Whether the registry would take a schema (K-47): the same question a register asks,
   *  with nothing written. A read, so it is asked on a read-only cluster too. */
  async checkSchemaCompatibility(p: Omit<CheckSchemaParams, "cluster">): Promise<SchemaCheck> {
    const cluster = this.cluster!;
    try {
      const r = await this.client.op("schemas.check", { cluster, ...p });
      this.log(
        "schemas.check",
        `${cluster}: ${p.subject} — ${r.compatible ? "the registry would take this schema" : `the registry would refuse it: ${r.messages.join(" ")}`}`,
      );
      return r;
    } catch (e) {
      this.logError("schemas.check", e);
      throw e;
    }
  }

  /** Register one version of one subject (K-47). The registry's own words come back when
   *  it refuses — it is the side that decides what compatibility means. A registered
   *  subject is opened: what was just written is what is worth looking at. */
  async registerSchema(p: Omit<RegisterSchemaParams, "cluster">): Promise<RegisteredSchema> {
    const cluster = this.cluster!;
    let r: RegisteredSchema;
    try {
      r = await this.client.op("schemas.register", { cluster, ...p });
    } catch (e) {
      this.logError("schemas.register", e);
      throw e;
    }
    this.log("schemas.register", `${cluster}: registered ${r.subject} v${r.version} — id ${r.id}, ${r.type}`);
    if (this.cluster === cluster) {
      // The list of subjects now holds one more, and the registry's own count changed with it.
      if (this.subjects.state === "ready") void this.loadSubjects();
      this.select({ kind: "subject", name: r.subject });
    }
    return r;
  }

  /** Hold a subject — or the registry, for subjects with no level of their own — to a
   *  compatibility level (K-47). An empty level goes back to following the default. */
  async setCompatibility(p: Omit<SetCompatibilityParams, "cluster">): Promise<CompatibilitySet> {
    const cluster = this.cluster!;
    try {
      const r = await this.client.op("schemas.setCompatibility", { cluster, ...p });
      const where = p.subject === "" ? "the registry's default" : p.subject;
      this.log("schemas.setCompatibility", `${cluster}: ${where} — compatibility ${r.level || "(the registry did not name one)"}`);
      return r;
    } catch (e) {
      this.logError("schemas.setCompatibility", e);
      throw e;
    }
  }

  /** Re-ask everything about the open cluster. */
  async refresh(): Promise<void> {
    if (!this.cluster) return;
    const name = this.cluster;
    this.resetLists();
    // Side by side. The lists need the cluster's status and nothing from the registry, and
    // waiting for it first held ↻ for the registry's whole 10 s deadline when it was down.
    const registry = this.checkSchema(name);
    await this.checkStatus(name);
    this.loadFor(this.view);
    await registry;
  }
}
