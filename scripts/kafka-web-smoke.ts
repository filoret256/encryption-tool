/** What the kafka tab writes down, without a browser: `bun run kafka-web:smoke`.
 *
 *  Two pieces of the tab are text in and text out, and both decide something a person then
 *  acts on: the JSON Lines file a save produces (K-46), and the words a Schema Registry is
 *  written with — a reference line, a compatibility level, what a level is called when it
 *  is the registry's default (K-47). Neither needs the page, so neither is checked by
 *  clicking; the dialogs around them are.
 *
 *  What is checked is the shape of a line: one message per line, everything a reader needs
 *  to know a field without being told, and a value that survives the trip whatever it was.
 */
import type { KafkaMessage } from "../src/kafka-agent/protocol.ts";
import { MAX_LIVE, MAX_LIVE_BYTES, listChars, messageChars, trimToBudget } from "../src/web/kafka/buffer.ts";
import { exportName, jsonLine, jsonLines } from "../src/web/kafka/export.ts";
import { decode } from "../src/web/kafka/format.ts";
import { reindentJSON } from "../src/web/kafka/json-text.ts";
import { KafkaModel } from "../src/web/kafka/model.ts";
import { COMPATIBILITY_LEVELS, COMPATIBILITY_TEXT, SCHEMA_TYPES, compatibilityText, diffOrder, parseReferences, prettySchema } from "../src/web/kafka/schema-text.ts";

const results: { name: string; ok: boolean; note: string }[] = [];

function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** One message, with only what a check is about filled in. */
const msg = (over: Partial<KafkaMessage>): KafkaMessage => ({
  partition: 0,
  offset: 0,
  timestamp: 1767225845000, // 2026-01-01T00:04:05Z
  key: null,
  value: null,
  headers: [],
  keySize: 0,
  valueSize: 0,
  truncated: false,
  ...over,
});

const line = (m: KafkaMessage, mode: "viewer" | "bytes" = "viewer"): Record<string, unknown> =>
  JSON.parse(jsonLine("orders", m, mode)) as Record<string, unknown>;

// ── one line (K-46) ───────────────────────────────────────────────────────

// A value with a line break in it is the case the format is for: JSON.stringify escapes it,
// and a file whose lines are not lines is not JSON Lines.
const wrapped = jsonLine("orders", msg({ offset: 7, value: b64("a\nb") }), "viewer");
const parsed = line(msg({ offset: 7, value: b64("a\nb") }));
check("a value with a line break stays one line", !wrapped.includes("\n"), wrapped);
check("the line names where the message was", parsed.topic === "orders" && parsed.partition === 0 && parsed.offset === 7);
check(
  "the time is a number and a text a person reads",
  parsed.timestamp === 1767225845000 && parsed.time === "2026-01-01T00:04:05.000Z",
  String(parsed.time),
);
check("what the viewer read is named", parsed.valueEncoding === "text" && parsed.value === "a\nb");

const json = line(msg({ value: b64(`{"a":1}`) }));
check("JSON is read as JSON, and the line says so", json.valueEncoding === "json" && json.value === `{"a":1}`);

// The bytes 00 01 ff are not text, so the viewer reads them as hex and the line says that
// too: a reader has to know whether a value is what it looks like.
const binary = line(msg({ value: "AAH/" }));
check("bytes that are not text are hex, and said to be", binary.valueEncoding === "hex" && binary.value === "00 01 ff", String(binary.value));

const raw = line(msg({ value: b64("hello") }), "bytes");
check("the bytes mode is base64, exactly what the topic holds", raw.value === b64("hello") && raw.valueEncoding === "base64");

const tombstone = line(msg({ value: null }));
check("a tombstone is null, and says it is not a value", tombstone.value === null && tombstone.valueEncoding === "null");
check("no key is null too", tombstone.key === null && tombstone.keyEncoding === "null");

const header = (line(msg({ headers: [{ key: "h", value: b64("v") }] })).headers as Record<string, unknown>[])[0];
check("a header carries its name, its value and its encoding", header.name === "h" && header.value === "v" && header.encoding === "text");
check("a value the agent cut is marked", line(msg({ value: b64("x"), truncated: true })).truncated === true);

// ── the file (K-46) ───────────────────────────────────────────────────────

const file = jsonLines(
  "orders",
  [msg({ partition: 1, offset: 2, value: b64("b") }), msg({ partition: 0, offset: 5, value: b64("a") }), msg({ partition: 0, offset: 1, value: b64("z") })],
  "viewer",
);
const lines = file.split("\n");
check("the file ends with a newline", lines.length === 4 && lines[3] === "");
// What the list shows may be newest-first; a file is read from its start.
const order = lines.slice(0, 3).map((l) => {
  const o = JSON.parse(l) as { partition: number; offset: number };
  return `${o.partition}:${o.offset}`;
});
check("the file is in reading order, not list order", order.join(",") === "0:1,0:5,1:2", order.join(","));
check("nothing to save is an empty file, not a file of one newline", jsonLines("orders", [], "viewer") === "");

const name = exportName("prod", "orders");
check("the name says which cluster, which topic and when", /^prod-orders-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.jsonl$/.test(name), name);
check("a name that is not a filename is made one", exportName("a b", "c/d").startsWith("a_b-c_d-"), exportName("a b", "c/d"));

// ── references and levels (K-47) ──────────────────────────────────────────

const refs = parseReferences("# a comment, a blank line, then two references\nMoney money-value 1\n\nThing other-value 2\n");
check(
  "references are read one per line, comments and blanks left out",
  Array.isArray(refs) && refs.length === 2 && refs[0].name === "Money" && refs[1].version === 2,
  JSON.stringify(refs),
);
check("a line that is not three words is refused, with its number", parseReferences("Money money-value") === "References, line 1: write it as name subject version");
check("a version that cannot exist is refused", String(parseReferences("M s 0")).includes("1 or more"), String(parseReferences("M s 0")));
check("no references is no references, not an error", Array.isArray(parseReferences("  \n")) && (parseReferences("\n") as unknown[]).length === 0);

check("a level of the subject's own reads as itself", compatibilityText("FULL", "BACKWARD") === "FULL");
check("no level reads as the registry's default, named", compatibilityText(null, "BACKWARD") === "registry default (BACKWARD)");
check("a default nobody named is still a default", compatibilityText(null, null) === "registry default");
// A level added to the list without a sentence would be offered with nothing to explain it.
const unexplained = COMPATIBILITY_LEVELS.filter((l) => !COMPATIBILITY_TEXT[l]);
check("every level the registry knows is explained", unexplained.length === 0, unexplained.join(", "));
check("every format the agent writes is offered", SCHEMA_TYPES.join(",") === "AVRO,PROTOBUF,JSON", SCHEMA_TYPES.join(","));

// ── what the viewer keeps (P6) ────────────────────────────────────────────
//
// A live view is a window onto a stream with no end, and the window is what
// stands between a topic and the tab's memory. The count alone said nothing
// about size: 5000 values of 256 KiB is about 1.7 GB of base64, and the list
// held while the view is paused was another 1.7 GB on top of it.

/** A message of about `chars` base64 characters, filling the value. */
const weighs = (chars: number): KafkaMessage => msg({ value: "A".repeat(chars) });

const count = (n: number, chars: number): KafkaMessage[] => Array.from({ length: n }, () => weighs(chars));

// The largest value the agent sends before it cuts one is 256 KiB, which base64
// turns into about 341,000 characters.
const BIG = 349_528;

const many = count(6000, 0);
trimToBudget(many, true);
check("a list of small messages is still bounded by the count", many.length === MAX_LIVE, `${many.length} kept`);

const heavy = count(400, BIG);
const dropped = trimToBudget(heavy, false);
check(
  "a list of large messages is bounded by what it weighs",
  listChars(heavy) <= MAX_LIVE_BYTES && heavy.length < 400,
  `${heavy.length} of 400 kept, ${dropped} dropped, ${listChars(heavy)} characters`,
);
check("nothing is dropped while the list is inside both budgets", trimToBudget(count(10, 100), true) === 0);

// Which end goes is not cosmetic: a read is in arrival order, and the list on
// screen while following is newest first, so "the oldest" is a different index
// in each. What a busy topic costs is paid by its oldest arrivals, so the
// mark — the newest message — has to survive either way.
const marked = msg({ value: "MARK" });
const newestFirst = [marked, ...count(100, BIG)];
trimToBudget(newestFirst, false);
check(
  "the oldest go from a newest-first list",
  newestFirst[0] === marked && newestFirst.length < 101,
  `${newestFirst.length} of 101 kept, the newest is ${newestFirst[0] === marked ? "still there" : "gone"}`,
);
const oldestFirst = [...count(100, BIG), marked];
trimToBudget(oldestFirst, true);
check(
  "the oldest go from an oldest-first list",
  oldestFirst[oldestFirst.length - 1] === marked && oldestFirst.length < 101,
  `${oldestFirst.length} of 101 kept, the newest is ${oldestFirst[oldestFirst.length - 1] === marked ? "still there" : "gone"}`,
);
check("a message with no value and no key costs nothing", messageChars(msg({})) === 0);
check(
  "headers are counted too",
  messageChars(msg({ headers: [{ key: "abc", value: "AAAA" }], key: "AA" })) === 9,
  String(messageChars(msg({ headers: [{ key: "abc", value: "AAAA" }], key: "AA" }))),
);

// ── the registry does not hold the cluster back (V-07) ────────────────────

/** A client that answers by script. A call waits for `gate(op)` when it has one, which is how
 *  a registry that does not answer is played: its call stays open until the test lets it go. */
function fakeClient(schemaState: "connected" | "not_configured") {
  const calls: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const handlers = new Map<string, (data: unknown) => void>();
  const client = {
    clusterStates: new Map<string, unknown>(),
    info: null,
    onClusters: null,
    on: (event: string, cb: (data: unknown) => void) => {
      handlers.set(event, cb);
      return () => handlers.delete(event);
    },
    op: async (op: string): Promise<unknown> => {
      calls.push(op);
      const gate = gates.get(op);
      if (gate) await gate;
      if (op === "clusters.status") return { state: "connected", brokers: 1 };
      if (op === "schemas.status") return { state: schemaState, message: "" };
      if (op === "topics.list") return [];
      return {};
    },
  };
  return { client, calls, gates, handlers, count: (op: string): number => calls.filter((c) => c === op).length };
}

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const entries = [{ name: "dev", readOnly: false, protocol: "PLAINTEXT" }];

{
  // ↻ with a registry that never answers: the topic list is asked for at once.
  const f = fakeClient("connected");
  let open!: () => void;
  f.gates.set("schemas.status", new Promise<void>((r) => (open = r)));
  const model = new KafkaModel(f.client as never);
  model.clusters = entries;
  model.cluster = "dev";
  model.view = "topics";
  const done = model.refresh();
  await settled();
  await settled();
  check("↻ asks for the topics while the registry has not answered", f.count("topics.list") === 1 && f.count("schemas.status") === 1);
  let finished = false;
  void done.then(() => (finished = true));
  await settled();
  check("↻ is not over until the registry has answered", !finished);
  open();
  await done;
  check("and is over once it has", model.schemas.get("dev")?.state === "connected");

  // Two askers, one question.
  const g = fakeClient("connected");
  const m2 = new KafkaModel(g.client as never);
  await Promise.all([m2.checkSchema("dev"), m2.checkSchema("dev")]);
  check("two callers asking about one registry send one request", g.count("schemas.status") === 1);
}

{
  // A cluster with no registry is not asked again by the status pass, until the configuration is read again.
  const f = fakeClient("not_configured");
  const model = new KafkaModel(f.client as never);
  model.clusters = entries;
  model.refreshStatuses();
  await settled();
  await settled();
  model.refreshStatuses();
  await settled();
  await settled();
  check("a cluster without a registry is asked once by the status pass", f.count("schemas.status") === 1, String(f.count("schemas.status")));
  check("but its status is asked every time", f.count("clusters.status") === 2);

  f.handlers.get("clusters.changed")?.({ clusters: entries });
  await settled();
  await settled();
  check("a reloaded configuration asks again", f.count("schemas.status") >= 2, String(f.count("schemas.status")));
}

{
  // open() right after an answer does not ask the registry again.
  const f = fakeClient("connected");
  const model = new KafkaModel(f.client as never);
  model.clusters = entries;
  await model.checkSchema("dev");
  await model.open("dev");
  check("open() takes a registry answer that is a moment old", f.count("schemas.status") === 1, String(f.count("schemas.status")));
}

{
  // An answer asked for before the configuration was read again is not kept.
  const f = fakeClient("not_configured");
  let late!: () => void;
  f.gates.set("schemas.status", new Promise<void>((r) => (late = r)));
  const model = new KafkaModel(f.client as never);
  model.clusters = entries;
  const old = model.checkSchema("dev");
  f.handlers.get("clusters.changed")?.({ clusters: entries });
  await settled();
  late();
  await old;
  check("a registry answer from before a reload is thrown away", !model.schemas.has("dev") || f.count("schemas.status") >= 2);
}

{
  // A cluster remembered from the last visit opens at load; the others are asked about too (X-10).
  const f = fakeClient("not_configured");
  const base = f.client.op;
  f.client.op = async (op: string): Promise<unknown> =>
    op === "clusters.list"
      ? ["vm-plain", "vm-ssl", "vm-down"].map((name) => ({ name, readOnly: false, protocol: "PLAINTEXT" }))
      : base(op);
  const store = { get: "vm-plain" };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => store.get,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  const model = new KafkaModel(f.client as never);
  await model.loadClusters();
  await settled();
  await settled();
  delete (globalThis as { localStorage?: unknown }).localStorage;
  check("the open cluster is asked once", f.calls.filter((c) => c === "clusters.status").length === 3, String(f.count("clusters.status")));
  check("every cluster has a status once the list is loaded", ["vm-plain", "vm-ssl", "vm-down"].every((n) => model.statuses.has(n)), [...model.statuses.keys()].join());
  check("and the open one is the remembered one", model.cluster === "vm-plain");
}

// ── a schema as it is read and compared (V-09) ────────────────────────────

const oneLine = '{"type":"record","name":"Order","fields":[{"name":"id","type":"long"}]}';
const laidOut = prettySchema("AVRO", oneLine);
check("an Avro schema is laid out in lines", laidOut.split("\n").length > 5 && laidOut.startsWith('{\n  "type": "record"'));
check("the same JSON Schema is too", prettySchema("JSON", oneLine) === laidOut);
check("a laid-out schema reads back as the same JSON", JSON.stringify(JSON.parse(laidOut)) === oneLine);
check("a .proto is left as it is", prettySchema("PROTOBUF", 'syntax = "proto3";') === 'syntax = "proto3";');
check("text that is not JSON is left as it is", prettySchema("AVRO", "{oops") === "{oops");
check("the older version goes on the left, whichever was clicked", diffOrder(2, 1).join() === "1,2" && diffOrder(1, 2).join() === "1,2");

// ── JSON numbers stay as written (X-02) ───────────────────────────────────

const numbers = '{"id": 9007199254740993, "price": 10.50, "ratio": 1e2, "neg": -0.0, "big": 123456789012345678901234567890}';
const laid = reindentJSON(numbers);
check(
  "the viewer shows the numbers as they were written",
  laid === '{\n  "id": 9007199254740993,\n  "price": 10.50,\n  "ratio": 1e2,\n  "neg": -0.0,\n  "big": 123456789012345678901234567890\n}',
  String(laid),
);
check("a value of the viewer is decoded the same way", decode(b64(numbers), "auto")?.text === laid && decode(b64(numbers), "auto")?.as === "json");
check(
  "the file keeps the text of the value, with the same numbers",
  line(msg({ value: b64(numbers) })).value === numbers && line(msg({ value: b64(numbers) })).valueEncoding === "json",
);
check(
  "strings are copied with their escapes",
  reindentJSON('{"a":"\\u00e9\\n\\"x\\"","é":"é"}') === '{\n  "a": "\\u00e9\\n\\"x\\"",\n  "é": "é"\n}',
);
check("keys keep their order, a key written twice stays", reindentJSON('{"b":1,"a":2,"b":3}') === '{\n  "b": 1,\n  "a": 2,\n  "b": 3\n}');
check("empty objects and arrays are {} and []", reindentJSON('{"a":{},"b":[],"c":[{}]}') === '{\n  "a": {},\n  "b": [],\n  "c": [\n    {}\n  ]\n}');
check(
  "the layout is the one of JSON.stringify",
  ['[1,[2,{"a":[true,false,null]}],"x"]', '{"a":{"b":{"c":[]}}}', "[]", "{}", "[[],[[]]]"].every((t) => reindentJSON(t) === JSON.stringify(JSON.parse(t), null, 2)),
);
check(
  "text that is not JSON gives null",
  ["", "{", '{"a":1', '{"a":1}}', "{a:1}", "[1,]", '{"a":}', "[01]", '{"a" 1}', "tru", '"abc', "1 2", '{"a":1,}'].every((t) => reindentJSON(t) === null),
);
check("a bare string or number is not turned into JSON for the viewer", decode(b64("42"), "auto")?.as === "text" && decode(b64('"x"'), "auto")?.as === "text");
const cut = '{"a":"' + "x".repeat(200_000);
const t0 = performance.now();
check("a cut-off string fails at once", reindentJSON(cut) === null && performance.now() - t0 < 200, String(Math.round(performance.now() - t0)) + " ms");
check(
  "nesting 1,000 deep is laid out, nesting 100,000 deep is left as it is — and neither overflows the stack or the memory",
  reindentJSON("[".repeat(1000) + "]".repeat(1000)) !== null && reindentJSON("[".repeat(100_000) + "]".repeat(100_000)) === null,
);

// ── what it comes to ──────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  for (const f of failed) console.log(`  FAIL  ${f.name}`);
  console.log(`\n${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`${results.length} checks passed: the shape of a saved message, what the viewer keeps, and the words of a schema registry`);
