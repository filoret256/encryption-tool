/** End-to-end smoke test for the kafka-agent: `bun run kafka-agent:smoke`.
 *
 *  Builds the Go agent, starts it against a stand, connects over the loopback
 *  WebSocket exactly as the browser does, and exercises one op per subsystem: the
 *  connection kinds, brokers, topics, messages (read, filter, tail and cancel),
 *  consumer groups, and the front door's refusals (token, Origin, Host). Exits
 *  non-zero on the first failure so it can gate a commit.
 *
 *    bun scripts/kafka-agent-smoke.ts [--stand devstand|compose] [--config <kafka-agent.yaml>]
 *
 *  devstand (the default)  three fake brokers in one process (kafka-agent-go/cmd/devstand):
 *                          no Docker, no Java, but not a real Kafka.
 *  compose                 the Docker stand of testdata/compose.yaml, which the agent
 *                          reaches through testdata/pki/kafka-agent.yaml: a real broker,
 *                          six clusters. It has to be running already.
 *  --config <file>         any agent config; only what every stand shares is checked
 *                          (every cluster connects, the lists answer), not particular data.
 *
 *  Writes. The agent holds every cluster read-only unless told otherwise, and the writing
 *  section starts by checking that: each write op is refused with READ_ONLY. Then, where the
 *  agent was started with --allow-write, it runs a life cycle on a topic of its own making —
 *  create (validated first), send, read back, change a setting, add a partition, delete
 *  records, delete — so it leaves nothing behind, and can be pointed at a real cluster. The
 *  devstand gets --allow-write always (its data goes away with it) and, having a group that
 *  reads and stops, the offset reset and the group's deletion as well. For any other stand,
 *  --writes asks for the same: the agent is started with --allow-write, and the life cycle
 *  runs on --writes-cluster (default: the first cluster in the config).
 *
 *  --writes-group <name>   a group on --writes-cluster that has committed offsets, whose
 *                          offsets are moved and which is then deleted. Make one with
 *                          `kafka-console-consumer --group <name> --topic <topic>
 *                          --from-beginning --max-messages 1`. Without it, a stand that is
 *                          not the devstand gets no offset reset: making a group needs a
 *                          Kafka client, and this script has none.
 *
 *  --denied-cluster <name> a cluster whose login may not create topics (the ACL stand,
 *                          testdata/compose-acl.yaml): creating one there has to come back
 *                          as the broker's own refusal, word for word.
 *
 *  The Go suite is skipped, loudly, when no Go toolchain is present; set GO_BIN to
 *  point at one that is not on PATH.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iter } from "../src/code-agent/proc.ts";
import { findGo, GO_MISSING } from "./go-toolchain.ts";
import { VERSION } from "../src/version.ts";
import type {
  AddPartitionsResult,
  AlterConfigResult,
  BrokerList,
  ClusterEntry,
  ClusterStatus,
  AclEntry,
  AclList,
  ConfigEntry,
  ConsumeResult,
  CreateTopicResult,
  DeleteGroupResult,
  DeleteRecordsResult,
  DeleteTopicResult,
  GroupDetail,
  GroupSummary,
  KafkaAgentInfo,
  KafkaMessage,
  MessageBatch,
  ProduceResult,
  ResetOffsetsResult,
  TopicDetail,
  TopicSummary,
} from "../src/kafka-agent/protocol.ts";

// In the kafka-agent's range (5011-5020) and away from the default 5011, which is
// what someone running the agent by hand is likely to be holding.
const PORT = 5019;
const TOKEN = "smoke-" + Math.random().toString(16).slice(2);
const ORIGIN = "http://localhost:5000";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// ── results ───────────────────────────────────────────────────────────────

let failed = 0;
/** Thrown by a check that has nothing to check on this stand, and says why: a skip is printed
 *  and is not a failure. A stand that lacks what a check needs is not a broken agent. */
class Skip extends Error {}

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const note = await fn();
    console.log(`  ok    ${name}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    if (e instanceof Skip) {
      console.log(`  skip  ${name} — ${e.message}`);
      return;
    }
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : String(e)}`);
  }
}

function expect(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(what);
}

// ── the wire ──────────────────────────────────────────────────────────────

interface Call<T> extends Promise<T> {
  id: number;
  chunks: unknown[];
}

class Client {
  private ws!: WebSocket;
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; chunks: unknown[] }>();
  readonly events: { event: string; data: unknown }[] = [];

  static async open(url: string, headers: Record<string, string> = { Origin: ORIGIN }): Promise<Client> {
    const c = new Client();
    // Bun takes headers as a second argument; the DOM typings do not know that.
    c.ws = new (WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket)(url, { headers });
    c.ws.addEventListener("message", (ev) => {
      const f = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (typeof f.event === "string") return void c.events.push({ event: f.event, data: f.data });
      const p = c.pending.get(f.id as number);
      if (!p) return;
      if ("chunk" in f) return void p.chunks.push(f.chunk);
      c.pending.delete(f.id as number);
      if (f.ok) p.resolve(f.data);
      else p.reject(Object.assign(new Error(String(f.error)), { code: f.code }));
    });
    await new Promise<void>((resolve, reject) => {
      c.ws.addEventListener("open", () => resolve());
      c.ws.addEventListener("error", () => reject(new Error("the socket did not open")));
      c.ws.addEventListener("close", () => reject(new Error("the socket closed before it opened")));
    });
    return c;
  }

  call<T>(op: string, params: Record<string, unknown> = {}): Call<T> {
    const id = this.next++;
    const chunks: unknown[] = [];
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, chunks });
      this.ws.send(JSON.stringify({ id, op, ...params }));
    }) as Call<T>;
    p.id = id;
    p.chunks = chunks;
    return p;
  }

  /** The error code an op fails with, or "" when it does not fail. */
  async codeOf(op: string, params: Record<string, unknown> = {}): Promise<string> {
    try {
      await this.call(op, params);
      return "";
    } catch (e) {
      return (e as { code?: string }).code ?? "no code";
    }
  }

  close(): void {
    this.ws.close();
  }
}

/** Does the agent turn this connection away? A refusal is an HTTP status before the
 *  upgrade, which a WebSocket reports as an error or a close without an open. */
async function refused(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    (await Client.open(url, headers)).close();
    return false;
  } catch {
    return true;
  }
}

/** Text of about `n` characters that does not compress.
 *
 *  A producing client compresses by default (franz-go prefers snappy), and a broker that
 *  measures the batch as it arrives would let a message of repeated letters through a
 *  limit it is over. This is random bytes in base64: nothing to squeeze out of it. */
function incompressible(n: number): string {
  const bytes = new Uint8Array(n);
  let seed = 0x2545f491;
  for (let i = 0; i < n; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 0xff;
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

/** The topic a group has committed offsets for: the one there is something to reset in. */
async function groupTopicOf(c: Client, cluster: string, group: string): Promise<string> {
  const d = await c.call<GroupDetail>("groups.describe", { cluster, group });
  const topic = d.lag.find((r) => r.committed !== null)?.topic;
  if (!topic) throw new Error(`group ${group} has committed no offsets: there is nothing to reset`);
  return topic;
}

// ── starting things ───────────────────────────────────────────────────────

const exe = process.platform === "win32" ? ".exe" : "";

async function goBuild(go: string, pkg: string, out: string, version = false): Promise<void> {
  const flags = version ? ["-ldflags", `-X main.version=${VERSION}`] : [];
  const proc = Bun.spawn([go, "build", ...flags, "-o", join("..", out), pkg], {
    cwd: "kafka-agent-go",
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  if ((await proc.exited) !== 0) throw new Error(`go build ${pkg} failed`);
}

/** Read a process's stdout until a line matches, or fail with what it said. */
async function waitFor(proc: { stdout: ReadableStream<Uint8Array> | null }, re: RegExp, what: string, ms = 60_000): Promise<RegExpExecArray> {
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  const reader = iter(proc.stdout as ReadableStream<Uint8Array>)[Symbol.asyncIterator]();
  while (Date.now() < deadline) {
    const next = await Promise.race([reader.next(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))]);
    if (next === null || next.done) break;
    buf += dec.decode(next.value, { stream: true });
    const m = re.exec(buf);
    if (m) return m;
  }
  throw new Error(`${what} did not come up:\n${buf}`);
}

// ── the run ───────────────────────────────────────────────────────────────

const go = await findGo();if (!go) {
  console.log(`  skip  kafka-agent: ${GO_MISSING}`);
  process.exit(0);
}

const stand = (arg("--stand") ?? "devstand") as "devstand" | "compose";
const given = arg("--config");
const writesFlag = process.argv.includes("--writes");
const children: { kill(): void }[] = [];
let workdir = "";

try {
  await mkdir(join("dist", "kafka-agent-go"), { recursive: true });
  const agentExe = join("dist", "kafka-agent-go", `kafka-agent${exe}`);
  await goBuild(go, ".", agentExe, true);

  // Which config the agent is started with, and what that stand is known to hold.
  let config = given ?? "";
  let known: Known | null = null;
  if (!config && stand === "compose") {
    config = join("kafka-agent-go", "testdata", "pki", "kafka-agent.yaml");
    if (!existsSync(config)) throw new Error(`${config} is missing — run \`bun run kafka-agent:pki\` and start the compose stand first`);
    known = { clusters: 6, data: "plaintext", topics: { demo: 3 } };
  } else if (!config) {
    workdir = await mkdtemp(join(tmpdir(), "kafka-agent-smoke-"));
    const devExe = join("dist", "kafka-agent-go", `devstand${exe}`);
    await goBuild(go, "./cmd/devstand", devExe);
    const dev = Bun.spawn([devExe, "-dir", workdir, "-live"], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
    children.push(dev);
    const m = await waitFor(dev, /config: (.+kafka-agent\.yaml)/, "the devstand");
    config = m[1].trim();
    known = { clusters: 3, data: "dev", topics: { orders: 90, "app-logs": 400, "empty-topic": 0 }, live: "events", groups: ["billing", "log-shipper"], writes: { cluster: "dev", locked: "login", group: { idle: "log-shipper", active: "billing", topic: "app-logs", messages: 400 } } };
  }

  const agent = Bun.spawn([agentExe, "--config", config, "--port", String(PORT), "--no-clipboard", ...(known?.writes || writesFlag ? ["--allow-write"] : [])], {
    env: { ...(process.env as Record<string, string>), KAFKA_AGENT_TOKEN: TOKEN },
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });
  children.push(agent);
  await waitFor(agent, /ws:\/\/127\.0\.0\.1:\d+\/ws\?token=/, "the kafka-agent");

  const url = `ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`;
  const c = await Client.open(url);
  console.log(`kafka-agent smoke — ${given ? "config " + given : stand}`);

  // ── the front door ──
  console.log("\nfront door");
  await check("a wrong token is refused", async () => expect(await refused(`ws://127.0.0.1:${PORT}/ws?token=nope`, { Origin: ORIGIN }), "connected with a wrong token"));
  await check("no token is refused", async () => expect(await refused(`ws://127.0.0.1:${PORT}/ws`, { Origin: ORIGIN }), "connected without a token"));
  await check("a foreign Origin is refused", async () => expect(await refused(url, { Origin: "https://evil.example" }), "connected from a foreign origin"));
  await check("no Origin is refused unless allowed", async () => expect(await refused(url, {}), "connected without an Origin"));
  await check("a foreign Host is refused (DNS rebinding)", async () => expect(await refused(url, { Origin: ORIGIN, Host: "evil.example" }), "answered to a foreign Host"));

  // ── the agent and its clusters ──
  console.log("\nagent and clusters");
  let clusters: ClusterEntry[] = [];
  await check("agent.info names the agent and its clusters, and only that", async () => {
    const info = await c.call<KafkaAgentInfo>("agent.info");
    expect(info.agent === "kafka-agent" && info.version === VERSION, `agent.info: ${JSON.stringify(info)}`);
    expect(info.clusters.every((k) => Object.keys(k).sort().join() === "name,readOnly"), "a cluster in agent.info carries more than a name and a flag");
    return `${info.clusters.length} clusters, version ${info.version}`;
  });
  await check("clusters.list carries no address or credential", async () => {
    clusters = await c.call<ClusterEntry[]>("clusters.list");
    if (known) expect(clusters.length === known.clusters, `${clusters.length} clusters, want ${known.clusters}`);
    expect(clusters.length > 0, "no clusters");
    const wire = JSON.stringify(clusters);
    expect(!/bootstrap|password|secret|keystore|truststore|127\.0\.0\.1|192\.168\./i.test(wire), `something private in clusters.list: ${wire}`);
    return clusters.map((k) => `${k.name} (${k.protocol}${k.mechanism ? " " + k.mechanism : ""})`).join(", ");
  });
  for (const k of clusters) {
    await check(`clusters.status: ${k.name} connects`, async () => {
      const s = await c.call<ClusterStatus>("clusters.status", { cluster: k.name });
      expect(s.state === "connected", `${s.state}: ${s.message}`);
      expect(s.brokers && s.brokers > 0 && s.clusterId, "connected without a broker count or cluster id");
      return `${s.brokers} broker(s), Kafka ${s.version}`;
    });
  }
  await check("config.reload reads the file again and changes nothing", async () => {
    const r = await c.call<{ added: string[]; removed: string[]; changed: string[] }>("config.reload");
    expect(!r.added.length && !r.removed.length && !r.changed.length, `reload changed ${JSON.stringify(r)}`);
  });

  // ── brokers, topics, groups, on a cluster that holds data ──
  const name = known?.data ?? clusters[0]?.name;
  expect(name, "no cluster to test against");
  console.log(`\nreading — cluster ${name}`);

  await check("brokers.list and brokers.config", async () => {
    const b = await c.call<BrokerList>("brokers.list", { cluster: name });
    expect(b.brokers.length > 0 && b.clusterId, "no brokers");
    const cfg = await c.call<ConfigEntry[]>("brokers.config", { cluster: name, broker: b.brokers[0].id });
    expect(cfg.length > 0, "no broker settings");
    expect(cfg.every((e) => !e.sensitive || e.value === null), "a sensitive setting was read out");
    return `${b.brokers.length} broker(s), ${cfg.length} settings`;
  });

  let topics: TopicSummary[] = [];
  await check("topics.list", async () => {
    topics = await c.call<TopicSummary[]>("topics.list", { cluster: name });
    if (known) for (const [t, n] of Object.entries(known.topics)) {
      const got = topics.find((x) => x.name === t);
      expect(got, `topic ${t} is missing`);
      expect(got.messages === n, `topic ${t}: ${got.messages} messages, want ${n}`);
    }
    return `${topics.length} topics`;
  });
  // A topic of the user's, not one the registry or the broker keeps for itself (`_schemas` sorts
  // first and holds one-line records of its own); the one with the most to read, so that a filter
  // has something to tell apart.
  const readable = topics.filter((t) => !t.internal && !t.name.startsWith("_") && t.messages > 0);
  const topic = (known ? Object.entries(known.topics).find(([, n]) => n > 0)?.[0] : [...readable].sort((a, b) => b.messages - a.messages)[0]?.name) ?? "";
  expect(topic, "no topic with messages to read");

  await check(`topics.describe and topics.config: ${topic}`, async () => {
    const d = await c.call<TopicDetail>("topics.describe", { cluster: name, topic });
    expect(d.partitions.length > 0 && d.partitions.every((p) => p.end >= p.start), "bad partitions");
    const cfg = await c.call<ConfigEntry[]>("topics.config", { cluster: name, topic });
    expect(cfg.some((e) => e.name === "retention.ms"), "no retention.ms in the topic's settings");
    return `${d.partitions.length} partition(s)`;
  });

  await check(`messages.consume: ${topic} from the start, filtered, and with a limit`, async () => {
    const all = c.call<ConsumeResult>("messages.consume", { cluster: name, topic, from: "start", limit: 1000 });
    const r = await all;
    const got = (all.chunks as MessageBatch[]).flatMap((b) => b.messages);
    expect(r.matched === got.length && got.length > 0, `matched ${r.matched}, streamed ${got.length}`);
    if (known) expect(got.length === known.topics[topic], `${got.length} messages, want ${known.topics[topic]}`);
    const first = got[0];
    const full = await c.call<KafkaMessage>("messages.get", { cluster: name, topic, partition: first.partition, offset: first.offset });
    expect(full.offset === first.offset && full.value === first.value, "messages.get returned another message");

    const two = c.call<ConsumeResult>("messages.consume", { cluster: name, topic, from: "start", limit: 2 });
    const r2 = await two;
    expect(r2.matched === 2 && r2.stopped === "limit", `limit 2: ${JSON.stringify(r2)}`);

    // A needle that tells messages apart: one taken from a message's key or value that not every
    // message has. The start of the first message is not that on a topic whose messages begin alike
    // ({"id":… in all of them), and a filter that keeps everything proves nothing.
    const text = (b64: string | null): string => (b64 === null ? "" : new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
    const haystacks = got.map((m) => (text(m.key) + "\n" + text(m.value)).toLowerCase());
    const candidates = got.slice(0, 20).flatMap((m) => [text(m.key).slice(0, 12), text(m.value).slice(-12)].filter((x) => x.trim() !== ""));
    const needle = candidates.find((n) => {
      const hits = haystacks.filter((h) => h.includes(n.toLowerCase())).length;
      return hits >= 1 && hits < got.length;
    });
    // A needle nothing contains finds nothing, and still scans everything.
    const none = await c.call<ConsumeResult>("messages.consume", { cluster: name, topic, from: "start", limit: 1000, filter: "no-such-text-" + Date.now() });
    expect(none.matched === 0 && none.scanned === r.scanned, `a needle nothing contains: ${JSON.stringify(none)}`);
    if (needle === undefined) return `${got.length} messages, all alike: the filter was shown to find nothing, not to narrow`;
    const rf = await c.call<ConsumeResult>("messages.consume", { cluster: name, topic, from: "start", limit: 1000, filter: needle });
    const want = haystacks.filter((h) => h.includes(needle.toLowerCase())).length;
    expect(rf.scanned === r.scanned && rf.matched === want, `filter "${needle}": ${JSON.stringify(rf)}, want ${want} of ${got.length}`);
    return `${got.length} messages, filter kept ${rf.matched}`;
  });

  await check("messages.tail streams new messages, and cancel stops it with ECANCELED", async () => {
    // The devstand's -live writer feeds "events"; elsewhere nothing is written, and the
    // tail is only shown to start and to stop.
    const tail = c.call<unknown>("messages.tail", { cluster: name, topic: known?.live ?? topic });
    const outcome = tail.then(() => "ended", (e: { code?: string }) => e.code ?? "error");
    if (known?.live) {
      const until = Date.now() + 15_000;
      while (!tail.chunks.length && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      expect(tail.chunks.length > 0, "nothing arrived on the live topic within 15s");
    } else {
      await new Promise((r) => setTimeout(r, 1500));
    }
    await c.call("cancel", { target: tail.id });
    const code = await Promise.race([outcome, new Promise<string>((r) => setTimeout(() => r("still running"), 5000))]);
    expect(code === "ECANCELED", `after cancel the tail was: ${code}`);
    return known?.live ? `${tail.chunks.length} batch(es) arrived first` : "";
  });

  await check("groups.list and groups.describe", async () => {
    const gs = await c.call<GroupSummary[]>("groups.list", { cluster: name });
    if (known?.groups) {
      for (const g of known.groups) expect(gs.some((x) => x.name === g), `group ${g} is missing`);
      const d = await c.call<GroupDetail>("groups.describe", { cluster: name, group: known.groups[0] });
      expect(d.name === known.groups[0] && d.lag.length > 0 && d.totalLag > 0, `describe: ${JSON.stringify(d).slice(0, 200)}`);
      return `${gs.length} groups, ${known.groups[0]} is ${d.totalLag} behind`;
    }
    if (gs.length) await c.call("groups.describe", { cluster: name, group: gs[0].name });
    return `${gs.length} groups`;
  });

  // ── writing ──
  console.log("\nwriting");
  const w = known?.writes;
  const writable = w?.cluster ?? (writesFlag ? (arg("--writes-cluster") ?? name) : null);
  const WRITE_OPS: [string, Record<string, unknown>][] = [
    ["messages.produce", { topic: "t", value: "x" }],
    ["topics.delete", { topic: "t", confirm: "t" }],
    ["topics.create", { topic: "t", partitions: 1, replicationFactor: 1, configs: {}, validateOnly: false }],
    ["groups.reset", { group: "g", topic: "t", to: "earliest", dryRun: true }],
    ["topics.alterConfigs", { topic: "t", configs: { "retention.ms": "60000" }, dryRun: true }],
    ["topics.addPartitions", { topic: "t", partitions: 2, validateOnly: true }],
    ["topics.deleteRecords", { topic: "t", partition: 0, offset: 1, confirm: "t" }],
    ["groups.delete", { group: "g", confirm: "g" }],
  ];
  if (!writesFlag || w) {
    await check("every write op is refused with READ_ONLY on a read-only cluster, and says which", async () => {
      const target = w?.locked ?? name;
      for (const [op, params] of WRITE_OPS) {
        try {
          await c.call(op, { cluster: target, ...params });
        } catch (e) {
          const err = e as { code?: string; message: string };
          expect(err.code === "READ_ONLY", `${op}: code ${err.code}: ${err.message}`);
          expect(err.message.includes(`"${target}"`), `${op}: the refusal does not name the cluster: ${err.message}`);
          continue;
        }
        throw new Error(`${op} was not refused on ${target}`);
      }
      return `${WRITE_OPS.length} ops on ${target}${w ? " (readOnly: true, which --allow-write does not lift)" : ""}`;
    });
  }

  // ── ACLs ──
  // Every cluster answers this one, ACLs or not; --acl-expect is for the ACL stand, where
  // the seed wrote a known set and an entry that is missing from the answer is the bug
  // this check exists for.
  await check("acls.list: an ACL with every field the page paints", async () => {
    const at = arg("--writes-cluster") ?? name;
    let list: AclEntry[];
    try {
      list = (await c.call<AclList>("acls.list", { cluster: at })).acls;
    } catch (e) {
      // A broker without an authorizer answers "No Authorizer is configured", which is its
      // honest answer and the agent's correct report of it. Only a stand that was told to have
      // ACLs (--acl-expect) can call that a failure.
      if (!arg("--acl-expect") && /no authorizer/i.test(e instanceof Error ? e.message : String(e))) {
        throw new Skip(`${at} has no authorizer (the broker says so); pass --acl-expect on an ACL stand`);
      }
      throw e;
    }
    for (const a of list) {
      for (const field of ["principal", "host", "resourceType", "resourceName", "patternType", "operation", "permission"] as const) {
        expect(typeof a[field] === "string" && a[field] !== "", `${a.principal}: ${field} is ${JSON.stringify(a[field])}`);
      }
      expect(a.permission === "allow" || a.permission === "deny", `permission: ${a.permission}`);
    }
    const want = Number(arg("--acl-expect") ?? "0");
    if (want) {
      expect(list.length >= want, `${list.length} ACLs, want at least ${want}: ${list.map((a) => `${a.principal} ${a.operation} ${a.resourceType}:${a.resourceName}`).join("; ")}`);
      // The stand's seed gives the app user a topic ACL and a group ACL; a listing that
      // dropped the group ACL (or the deny side) would still be short.
      const kinds = new Set(list.map((a) => a.resourceType));
      expect(kinds.has("topic") && kinds.has("group"), `the resource types: ${[...kinds].join(", ")}`);
    }
    return `${list.length} ACLs on ${at}`;
  });

  if (writable) {
    const at = writable;
    const scratch = "smoke-writes-" + Date.now().toString(36);
    const denied = arg("--denied-cluster");
    const listed = async (): Promise<boolean> => (await c.call<TopicSummary[]>("topics.list", { cluster: at })).some((x) => x.name === scratch);
    const until = async (what: string, want: boolean): Promise<void> => {
      const limit = Date.now() + 20_000;
      while ((await listed()) !== want) {
        expect(Date.now() < limit, `${scratch} is ${want ? "not" : "still"} listed after 20s (${what})`);
        await new Promise((r) => setTimeout(r, 300));
      }
    };

    await check(`topics.create: validated first, then created — ${scratch} on ${at}`, async () => {
      const p = { cluster: at, topic: scratch, partitions: 3, replicationFactor: 1, configs: { "retention.ms": "3600000", "cleanup.policy": "delete", "max.message.bytes": "100000" } };
      const v = await c.call<CreateTopicResult>("topics.create", { ...p, validateOnly: true });
      expect(v.created === false && v.partitions === 3, `validation: ${JSON.stringify(v)}`);
      expect(!(await listed()), "a validation created the topic");
      const made = await c.call<CreateTopicResult>("topics.create", { ...p, validateOnly: false });
      expect(made.created === true, `creation: ${JSON.stringify(made)}`);
      await until("create", true);
      const d = await c.call<TopicDetail>("topics.describe", { cluster: at, topic: scratch });
      expect(d.partitions.length === 3, `${d.partitions.length} partitions, want 3`);
      const cfg = await c.call<ConfigEntry[]>("topics.config", { cluster: at, topic: scratch });
      expect(cfg.find((e) => e.name === "retention.ms")?.value === "3600000", "retention.ms did not arrive on the topic");
      expect(cfg.find((e) => e.name === "max.message.bytes")?.value === "100000", "max.message.bytes did not arrive — the limit below would prove nothing");
      return "3 partitions, retention.ms and max.message.bytes set";
    });
    await check("topics.create refuses a name already taken, a bad name and nonsense sizes", async () => {
      const base = { cluster: at, partitions: 1, replicationFactor: 1, configs: {}, validateOnly: true };
      expect((await c.codeOf("topics.create", { ...base, topic: scratch })) === "EKAFKA", "an existing topic");
      for (const [why, over] of [
        ["a space in the name", { topic: "a b" }],
        ["the cluster's own prefix", { topic: "__mine" }],
        ["no partitions", { topic: scratch + "-x", partitions: 0 }],
        ["no replicas", { topic: scratch + "-x", replicationFactor: 0 }],
      ] as const) {
        expect((await c.codeOf("topics.create", { ...base, ...over })) === "EPARAM", why);
      }
    });
    // What the cluster makes of a setting is the cluster's to say, and the page shows its
    // words as they are. `check` and `create` ask the same question, so they have to answer
    // the same way: a cluster that would refuse the setting must refuse it to both.
    // The fake stand has no catalogue of setting names and takes anything, so where nothing
    // is refused the topic it made is deleted again.
    await check("topics.create: a setting the cluster does not know is answered the same by check and create", async () => {
      const topic = scratch + "-bad";
      const p = { cluster: at, topic, partitions: 1, replicationFactor: 1, configs: { "no.such.setting": "1" } };
      const [checked, created] = [await c.codeOf("topics.create", { ...p, validateOnly: true }), await c.codeOf("topics.create", { ...p, validateOnly: false })];
      expect(checked === created, `check said ${checked}, create said ${created}`);
      if (created === "") {
        await c.call("topics.delete", { cluster: at, topic, confirm: topic });
        return "this cluster takes any setting name (nothing to refuse)";
      }
      expect(created === "EKAFKA", `an unknown setting gave ${created}`);
      let said = "";
      try {
        await c.call("topics.create", { ...p, validateOnly: true });
      } catch (e) {
        said = (e as { message: string }).message;
      }
      expect(/unknown|invalid|no\.such\.setting/i.test(said), `what the cluster said: ${said}`);
      expect(!(await c.call<TopicSummary[]>("topics.list", { cluster: at })).some((t) => t.name === topic), "a refused create left the topic behind");
      return said.slice(0, 90);
    });
    await check("topics.create: a wrong value for a known setting is refused the same by check and create", async () => {      const cases: [string, Record<string, string>][] = [
        ["retention.ms is not a number", { "retention.ms": "abc" }],
        ["cleanup.policy is not a policy", { "cleanup.policy": "foo" }],
        ["min.insync.replicas is more than the replication factor", { "min.insync.replicas": "3" }],
      ];
      const notes: string[] = [];
      for (const [what, configs] of cases) {
        const topic = `${scratch}-v${notes.length}`;
        const p = { cluster: at, topic, partitions: 1, replicationFactor: 1, configs };
        const [checked, created] = [await c.codeOf("topics.create", { ...p, validateOnly: true }), await c.codeOf("topics.create", { ...p, validateOnly: false })];
        expect(checked === created, `${what}: check said ${checked}, create said ${created}`);
        if (created === "") {
          await c.call("topics.delete", { cluster: at, topic, confirm: topic });
          notes.push(`${what} → taken`);
          continue;
        }
        expect(created === "EKAFKA", `${what} gave ${created}`);
        expect(!(await c.call<TopicSummary[]>("topics.list", { cluster: at })).some((t) => t.name === topic), `${what}: a refused create left the topic behind`);
        notes.push(`${what} → refused`);
      }
      return notes.join("; ");
    });
    if (denied) {
      // K-50's third point, on a broker that really has an authorizer: the login may do
      // everything to a topic but nothing to the cluster, and creating a topic is a cluster
      // right. The refusal has to arrive as the broker's own sentence.
      await check(`topics.create is refused on ${denied}, whose login may not create`, async () => {
        const topics = await c.call<TopicSummary[]>("topics.list", { cluster: denied });
        expect(topics.length > 0, `${denied}: the login cannot even list topics — the stand is not set up as this check needs`);
        const topic = `${scratch}-denied`;
        const p = { cluster: denied, topic, partitions: 1, replicationFactor: 1, configs: {} };
        const [checked, created] = [
          await c.codeOf("topics.create", { ...p, validateOnly: true }),
          await c.codeOf("topics.create", { ...p, validateOnly: false }),
        ];
        expect(checked === "EKAFKA" && created === "EKAFKA", `check said ${checked}, create said ${created}`);
        let said = "";
        try {
          await c.call("topics.create", { ...p, validateOnly: false });
        } catch (e) {
          said = (e as { message: string }).message;
        }
        expect(/authoriz/i.test(said), `what the broker said: ${said}`);
        expect(!(await c.call<TopicSummary[]>("topics.list", { cluster: denied })).some((t) => t.name === topic), "a refused create made the topic");
        return `${said.slice(0, 80)} — with ${topics.length} topic(s) still readable`;
      });
    }
    await check(`messages.produce: send to ${scratch}, and read it back`, async () => {
      const r = await c.call<ProduceResult>("messages.produce", {
        cluster: at, topic: scratch, partition: 0, key: "smoke-key", value: '{"smoke": true}', valueEncoding: "json",
        headers: [{ key: "source", value: "smoke", encoding: "string" }, { key: "raw", value: "AAH/", encoding: "base64" }],
      });
      expect(r.partition === 0 && r.offset === 0, `landed at ${JSON.stringify(r)}`);
      const t = await c.call<ProduceResult>("messages.produce", { cluster: at, topic: scratch, partition: 0, key: "smoke-gone", value: null });
      expect(t.offset === 1, "the tombstone did not follow");
      const read = c.call<ConsumeResult>("messages.consume", { cluster: at, topic: scratch, from: "start", limit: 10 });
      await read;
      const got = (read.chunks as MessageBatch[]).flatMap((b) => b.messages);
      expect(got.length === 2, `${got.length} messages read back, want 2`);
      expect(atob(got[0].key ?? "") === "smoke-key" && atob(got[0].value ?? "") === '{"smoke": true}', "key or value came back different");
      expect(got[0].headers.length === 2 && got[0].headers[1].value === "AAH/", "headers came back different");
      expect(got[1].value === null, "the tombstone has a value");
      return "partition 0, offsets 0 and 1";
    });
    await check("messages.produce refuses a bad partition, bad JSON and an unknown topic", async () => {
      expect((await c.codeOf("messages.produce", { cluster: at, topic: scratch, partition: 99, value: "x" })) === "EPARAM", "partition 99");
      expect((await c.codeOf("messages.produce", { cluster: at, topic: scratch, value: "{", valueEncoding: "json" })) === "EPARAM", "bad JSON");
      expect((await c.codeOf("messages.produce", { cluster: at, topic: "no-such-" + Date.now(), value: "x" })) === "EKAFKA", "unknown topic");
    });
    await check(`messages.produce: a message over ${scratch}'s max.message.bytes comes back in the cluster's words`, async () => {
      const count = async (): Promise<number> => (await c.call<TopicSummary[]>("topics.list", { cluster: at })).find((t) => t.name === scratch)?.messages ?? -1;
      const before = await count();
      const over = incompressible(150_000); // about 200 kB of text, over the topic's 100 kB
      let said = "";
      try {
        await c.call("messages.produce", { cluster: at, topic: scratch, partition: 0, value: over });
      } catch (e) {
        const err = e as { code?: string; message: string };
        expect(err.code === "EKAFKA", `code ${err.code}: ${err.message}`);
        said = err.message;
      }
      expect(said !== "", "a message over the topic's limit was accepted");
      expect(/too large|larger than/i.test(said), `what the cluster said: ${said}`);
      expect((await count()) === before, "the refused message was written");
      return said.slice(0, 90);
    });
    await check("a cluster's own topic is refused before anything is written to it", async () => {
      const all = await c.call<TopicSummary[]>("topics.list", { cluster: at });
      const own = all.find((t) => t.internal);
      if (!own) return "this cluster has no internal topic to try";
      const code = await c.codeOf("messages.produce", { cluster: at, topic: own.name, value: "x" });
      expect(code === "EPARAM", `${own.name}: code ${code}`);
      return `${own.name} is refused as the cluster's own`;
    });
    await check("groups.reset refuses a group that does not exist", async () => {
      const base = { cluster: at, group: "no-such-group-" + Date.now(), topic: scratch, to: "earliest", dryRun: true };
      expect((await c.codeOf("groups.reset", base)) === "EKAFKA", "an unknown group");
    });
    await check(`topics.alterConfigs: ${scratch} — a preview changes nothing, then the setting is written and reset`, async () => {
      const entry = async (): Promise<ConfigEntry | undefined> =>
        (await c.call<ConfigEntry[]>("topics.config", { cluster: at, topic: scratch })).find((e) => e.name === "retention.ms");
      // A real cluster carries a config change from the controller to the brokers that
      // answer DescribeConfigs on its own schedule, so the read is re-tried rather than
      // assumed to be instant. What is being checked is that it arrives, not that it
      // arrives within the same millisecond.
      const entryUntil = async (holds: (e: ConfigEntry | undefined) => boolean): Promise<ConfigEntry | undefined> => {
        const limit = Date.now() + 5000;
        for (;;) {
          const e = await entry();
          if (holds(e) || Date.now() > limit) return e;
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      // The topic was made with retention.ms=3600000, so that is what it holds now.
      const before = await entry();
      expect(before?.value === "3600000" && before.isDefault === false, `the setting before: ${JSON.stringify(before)}`);

      const pre = await c.call<AlterConfigResult>("topics.alterConfigs", { cluster: at, topic: scratch, configs: { "retention.ms": "120000" }, dryRun: true });
      expect(pre.applied === false && pre.rows.length === 1, `preview: ${JSON.stringify(pre)}`);
      expect(pre.rows[0].name === "retention.ms" && pre.rows[0].before === "3600000" && pre.rows[0].after === "120000", `the row: ${JSON.stringify(pre.rows[0])}`);
      expect((await entry())?.value === "3600000", "the preview wrote the setting");

      const a = await c.call<AlterConfigResult>("topics.alterConfigs", { cluster: at, topic: scratch, configs: { "retention.ms": "120000" } });
      expect(a.applied === true && a.rows.length === 1, `applying: ${JSON.stringify(a)}`);
      const wrote = await entryUntil((e) => e?.value === "120000");
      expect(wrote?.value === "120000", `the setting did not arrive on the topic: ${JSON.stringify(wrote)}`);
      // The same value again is not a change.
      const same = await c.call<AlterConfigResult>("topics.alterConfigs", { cluster: at, topic: scratch, configs: { "retention.ms": "120000" }, dryRun: true });
      expect(same.rows.length === 0, `the same value again: ${JSON.stringify(same)}`);
      // A null takes the topic's own value off, and the cluster's default applies again.
      const back = await c.call<AlterConfigResult>("topics.alterConfigs", { cluster: at, topic: scratch, configs: { "retention.ms": null } });
      expect(back.rows.length === 1 && back.rows[0].after === null, `resetting: ${JSON.stringify(back)}`);
      const after = await entryUntil((e) => e?.isDefault === true);
      expect(after?.isDefault === true && after.value !== "120000", `after the reset the setting is ${JSON.stringify(after)}`);
      return `retention.ms 3600000 → 120000 → the cluster's default (${after?.value})`;
    });
    await check(`topics.alterConfigs refuses a setting it cannot name and a topic that is not there`, async () => {
      expect((await c.codeOf("topics.alterConfigs", { cluster: at, topic: scratch, configs: { "retention ms": "1" } })) === "EPARAM", "a setting name with a space");
      expect((await c.codeOf("topics.alterConfigs", { cluster: at, topic: scratch, configs: {} })) === "EPARAM", "no setting at all");
      expect((await c.codeOf("topics.alterConfigs", { cluster: at, topic: "no-such-" + Date.now(), configs: { "retention.ms": "1" } })) === "EKAFKA", "an unknown topic");
    });
    await check(`topics.addPartitions: ${scratch} — checked first, then added, and never taken back`, async () => {
      const parts = async (): Promise<number> => (await c.call<TopicDetail>("topics.describe", { cluster: at, topic: scratch })).partitions.length;
      const before = await parts();
      const v = await c.call<AddPartitionsResult>("topics.addPartitions", { cluster: at, topic: scratch, partitions: before + 1, validateOnly: true });
      expect(v.added === false && v.from === before && v.to === before + 1, `a validation: ${JSON.stringify(v)}`);
      expect((await parts()) === before, "the validation added a partition");
      const a = await c.call<AddPartitionsResult>("topics.addPartitions", { cluster: at, topic: scratch, partitions: before + 1 });
      expect(a.added === true, `adding: ${JSON.stringify(a)}`);
      const limit = Date.now() + 20_000;
      while ((await parts()) !== before + 1) {
        expect(Date.now() < limit, `${scratch} still has ${await parts()} partitions after 20s`);
        await new Promise((r) => setTimeout(r, 300));
      }
      expect((await c.codeOf("topics.addPartitions", { cluster: at, topic: scratch, partitions: before })) === "EPARAM", "fewer partitions than it has");
      expect((await parts()) === before + 1, "a refused change moved the count");
      return `${before} → ${before + 1} partitions`;
    });
    await check(`topics.deleteRecords: ${scratch} — one partition, with the topic's name confirmed`, async () => {
      const bound = async (): Promise<{ start: number; end: number }> => {
        const d = await c.call<TopicDetail>("topics.describe", { cluster: at, topic: scratch });
        const p = d.partitions.find((x) => x.id === 0)!;
        return { start: p.start, end: p.end };
      };
      const read = async (): Promise<KafkaMessage[]> => {
        const call = c.call<ConsumeResult>("messages.consume", { cluster: at, topic: scratch, partitions: [0], from: "start", limit: 100 });
        await call;
        return (call.chunks as MessageBatch[]).flatMap((b) => b.messages);
      };
      expect((await c.codeOf("topics.deleteRecords", { cluster: at, topic: scratch, partition: 0, offset: 1 })) === "EPARAM", "deleted without a confirmation");
      expect((await c.codeOf("topics.deleteRecords", { cluster: at, topic: scratch, partition: 0, offset: 1, confirm: "other" })) === "EPARAM", "deleted with the wrong confirmation");
      expect((await bound()).start === 0, "a refused truncation moved the start offset");

      const d = await c.call<DeleteRecordsResult>("topics.deleteRecords", { cluster: at, topic: scratch, partition: 0, offset: 1, confirm: scratch });
      expect(d.before === 0 && d.after === 1 && d.deleted === 1, `the answer: ${JSON.stringify(d)}`);
      const left = await read();
      expect(left.length === 1 && left[0].offset === 1, `${left.length} messages left in partition 0`);
      expect((await c.codeOf("topics.deleteRecords", { cluster: at, topic: scratch, partition: 0, offset: 99, confirm: scratch })) === "EPARAM", "past the end of the partition");
      const all = await c.call<DeleteRecordsResult>("topics.deleteRecords", { cluster: at, topic: scratch, partition: 0, offset: -1, confirm: scratch });
      expect(all.deleted === 1 && (await read()).length === 0, `deleting everything: ${JSON.stringify(all)}`);
      expect((await bound()).end === 2, "the end of the partition moved");
      return "offsets 0 and 1 dropped one at a time, the end untouched";
    });
    await check("groups.delete: only for a group nobody is running as, with its name confirmed", async () => {
      expect((await c.codeOf("groups.delete", { cluster: at, group: "any", confirm: "other" })) === "EPARAM", "deleted with the wrong confirmation");
      expect((await c.codeOf("groups.delete", { cluster: at, group: "no-such-group-" + Date.now(), confirm: "" })) === "EPARAM", "deleted without a confirmation");
      // A name the cluster has never heard of, on a real broker as on the fake one.
      const absent = "no-such-group-" + Date.now();
      expect((await c.codeOf("groups.delete", { cluster: at, group: absent, confirm: absent })) === "EKAFKA", "a group that is not there");
      if (!w) return "a wrong confirmation and a group that is not there are refused; nothing here has a group to delete";
      const running = w.group.active;
      try {
        await c.call("groups.delete", { cluster: at, group: running, confirm: running });
      } catch (e) {
        const err = e as { code?: string; message: string };
        expect(err.code === "EGROUPACTIVE" && /stop its consumers/.test(err.message), `${err.code}: ${err.message}`);
        return `${running}, which has a running consumer, is refused`;
      }
      throw new Error(`a running group (${running}) was deleted`);
    });
    await check(`topics.delete: only with the name confirmed, then ${scratch} is gone`, async () => {
      expect((await c.codeOf("topics.delete", { cluster: at, topic: scratch })) === "EPARAM", "deleted without a confirmation");
      expect((await c.codeOf("topics.delete", { cluster: at, topic: scratch, confirm: "other" })) === "EPARAM", "deleted with the wrong confirmation");
      expect(await listed(), "a refused delete removed the topic");
      const r = await c.call<DeleteTopicResult>("topics.delete", { cluster: at, topic: scratch, confirm: scratch });
      // The two messages sent above were both deleted again — the second truncation took
      // everything the partition had — so it is empty, and the answer says so.
      expect(r.topic === scratch && r.messages === 0, `answer: ${JSON.stringify(r)}`);
      await until("delete", false);
      expect((await c.codeOf("topics.delete", { cluster: at, topic: "__consumer_offsets", confirm: "__consumer_offsets" })) === "EPARAM", "an internal topic was not refused");
    });
  }

  // ── consumer groups: moving offsets of a group that has committed some ──
  // The devstand brings a group that has stopped; on any other stand --writes-group names
  // one the operator made and is willing to lose (kafka-console-consumer --group is the
  // quickest way to make one with commits). Everything below is read back through the
  // group's own lag and, where it can be, through the cluster's offsets.
  const givenGroup = arg("--writes-group");
  const groupAt = w ? w.cluster : givenGroup ? writable : null;
  const groupName = w ? w.group.idle : givenGroup;
  if (groupAt && groupName) {
    const at = groupAt;
    const group = groupName;
    const topic = w ? w.group.topic : await groupTopicOf(c, at, group);
    const lag = async (g: string): Promise<number> => (await c.call<GroupDetail>("groups.describe", { cluster: at, group: g })).totalLag;
    const held = async (): Promise<Map<number, number>> => {
      const d = await c.call<GroupDetail>("groups.describe", { cluster: at, group });
      return new Map(d.lag.filter((r) => r.topic === topic && r.committed !== null).map((r) => [r.partition, r.committed as number]));
    };
    const d0 = await c.call<TopicDetail>("topics.describe", { cluster: at, topic });
    const bounds = new Map(d0.partitions.map((p) => [p.id, p]));
    const part0 = d0.partitions[0];
    const total = [...bounds.values()].reduce((n, p) => n + (p.end - p.start), 0);
    /** What the group's lag is when it sits where `at` says: everything later than the
     *  position counts, and a partition the map does not name is at its end. */
    const lagAt = (where: Map<number, number>): number =>
      [...bounds.values()].reduce((n, p) => n + (p.end - (where.get(p.id) ?? p.end)), 0);

    await check(`groups.reset: ${group} on ${topic} — a preview changes nothing, then earliest, latest, shift and an offset`, async () => {
      const p = { cluster: at, group, topic };
      const start = await lag(group);
      const pre = await c.call<ResetOffsetsResult>("groups.reset", { ...p, to: "earliest", dryRun: true });
      expect(pre.applied === false && pre.rows.length > 0 && pre.rows.every((r) => r.after === r.start), `preview: ${JSON.stringify(pre).slice(0, 200)}`);
      expect((await lag(group)) === start, "the preview moved the group");

      const a = await c.call<ResetOffsetsResult>("groups.reset", { ...p, to: "earliest" });
      expect(a.applied === true, "not applied");
      expect((await lag(group)) === total, `lag after earliest: ${await lag(group)}, want ${total} (every retained message)`);

      await c.call("groups.reset", { ...p, to: "latest" });
      expect((await lag(group)) === 0, "lag after latest is not 0");

      // One partition moved to an offset it holds; the rest are left at their ends.
      const to = Math.min(5, part0.end);
      const one = await c.call<ResetOffsetsResult>("groups.reset", { ...p, partitions: [part0.id], to: "offset", offset: to });
      expect(one.rows.length === 1 && one.rows[0].after === to, `offset ${to} on partition ${part0.id}: ${JSON.stringify(one.rows)}`);
      expect((await lag(group)) === lagAt(new Map([[part0.id, to]])), `lag after offset ${to}: ${await lag(group)}`);

      // Shifted back by ten from wherever each partition is, held at its start.
      const before = await held();
      await c.call("groups.reset", { ...p, to: "shift", shift: -10 });
      const wanted = new Map([...bounds.values()].map((q) => [q.id, Math.max((before.get(q.id) ?? q.end) - 10, q.start)]));
      expect((await lag(group)) === lagAt(wanted), `lag after a shift of -10: ${await lag(group)}, want ${lagAt(wanted)}`);
      expect((await c.codeOf("groups.reset", { ...p, to: "offset", offset: total + 1 })) === "EPARAM", "an offset past the end");
      return `four kinds of move over ${total} messages in ${bounds.size} partition(s), each read back through the group's lag`;
    });

    await check(`groups.reset to a time: before the first message, at one of them, and after the last — ${topic}`, async () => {
      const d = await c.call<TopicDetail>("topics.describe", { cluster: at, topic });
      const part = d.partitions.find((p) => p.end > p.start) ?? d.partitions[0];
      const read = c.call<ConsumeResult>("messages.consume", { cluster: at, topic, partitions: [part.id], from: "start", limit: 1000 });
      await read;
      const msgs = (read.chunks as MessageBatch[]).flatMap((b) => b.messages);
      expect(msgs.length >= 1, `partition ${part.id} is empty: there is no time to look for`);
      // A second message makes the middle case sharper; with one, its own time is the case.
      const probe = msgs[Math.min(1, msgs.length - 1)];
      const at2 = (time: number): Promise<ResetOffsetsResult> =>
        c.call<ResetOffsetsResult>("groups.reset", { cluster: at, group, topic, partitions: [part.id], to: "timestamp", timestamp: time, dryRun: true });
      const rowOf = (r: ResetOffsetsResult): { after: number } => r.rows[0];

      // A moment before everything that is in the log: the first message there is it.
      const first = rowOf(await at2(1));
      expect(first.after === msgs[0].offset, `a time before the log gave offset ${first.after}, want the first message at ${msgs[0].offset}`);
      // A moment after everything: the end.
      const last = rowOf(await at2(Date.now() + 3600_000));
      expect(last.after === part.end, `a time after the log gave offset ${last.after}, want the end at ${part.end}`);
      // One of the messages' own times: the first message at or after it.
      const middle = rowOf(await at2(probe.timestamp));
      expect(
        middle.after >= msgs[0].offset && middle.after <= probe.offset,
        `the time of message ${probe.offset} gave offset ${middle.after}; want a message no later than it`,
      );
      // And applying it puts the group exactly where the preview said.
      const applied = await c.call<ResetOffsetsResult>("groups.reset", { cluster: at, group, topic, partitions: [part.id], to: "timestamp", timestamp: probe.timestamp });
      expect(applied.applied === true && rowOf(applied).after === middle.after, `apply: ${JSON.stringify(applied.rows[0])}`);
      expect((await held()).get(part.id) === middle.after, `the group is at ${(await held()).get(part.id)}, want ${middle.after}`);
      return `partition ${part.id} of ${msgs.length} message(s): start → ${middle.after} → end, and the preview was what was applied`;
    });

    if (w) {
      const running = w.group.active;
      await check(`groups.reset refuses ${running}, which has a running consumer, before and after asking`, async () => {
        for (const dryRun of [true, false]) {
          try {
            await c.call("groups.reset", { cluster: at, group: running, topic: "orders", to: "earliest", dryRun });
          } catch (e) {
            const err = e as { code?: string; message: string };
            expect(err.code === "EGROUPACTIVE" && /stop its consumers/.test(err.message), `dryRun ${dryRun}: ${err.code}: ${err.message}`);
            continue;
          }
          throw new Error(`a running group was reset (dryRun ${dryRun})`);
        }
        expect((await lag(running)) === 50, "the running group moved");
      });
    }

    // Last, because it takes the group away: deleting the one nothing is running as.
    await check(`groups.delete: ${group} is gone, and its offsets with it`, async () => {
      const offsets = (await c.call<GroupDetail>("groups.describe", { cluster: at, group })).lag.filter((r) => r.committed !== null).length;
      const r = await c.call<DeleteGroupResult>("groups.delete", { cluster: at, group, confirm: group });
      expect(r.group === group && r.offsets === offsets, `${JSON.stringify(r)}, want ${offsets} offsets`);
      const limit = Date.now() + 20_000;
      const listed = async (): Promise<boolean> => (await c.call<GroupSummary[]>("groups.list", { cluster: at })).some((g) => g.name === group);
      while (await listed()) {
        expect(Date.now() < limit, `${group} is still listed after 20s`);
        await new Promise((r) => setTimeout(r, 300));
      }
      expect((await c.codeOf("groups.delete", { cluster: at, group, confirm: group })) === "EKAFKA", "a group deleted twice");
      return `${group}, ${offsets} committed offsets removed`;
    });
  }

  // ── refusals ──
  console.log("\nrefusals");
  await check("an unknown op is ENOOP", async () => expect((await c.codeOf("fs.read")) === "ENOOP", "not ENOOP"));
  await check("an unknown cluster is ENOCLUSTER", async () => expect((await c.codeOf("topics.list", { cluster: "nope" })) === "ENOCLUSTER", "not ENOCLUSTER"));
  await check("a parameter of the wrong type is EPARAM", async () => expect((await c.codeOf("cancel", { target: "seven" })) === "EPARAM", "not EPARAM"));
  await check("a topic that does not exist is an EKAFKA error, not a hang", async () => {
    const code = await c.codeOf("topics.describe", { cluster: name, topic: "no-such-topic-" + Date.now() });
    expect(code === "EKAFKA", `code ${code}`);
  });

  c.close();
} finally {
  for (const p of children) p.kill();
  if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
}

interface Known {
  clusters: number;
  /** The cluster that holds the data below. */
  data: string;
  topics: Record<string, number>;
  groups?: string[];
  /** A topic something keeps writing to. */
  live?: string;
  /** Where writes may be tried without asking: the devstand's cluster to change, one its
   *  configuration holds read-only, and a group that has stopped and one that is still running,
   *  with the topic the first read and how many messages it holds. */
  writes?: { cluster: string; locked: string; group: { idle: string; active: string; topic: string; messages: number } };
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
