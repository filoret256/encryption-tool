/** Guard against the two code-agents' wire types drifting apart:
 *  `bun run protocol:check`.
 *
 *  src/code-agent/protocol.ts is the definition the browser is compiled against;
 *  code-agent-go/protocol.go is a hand-written mirror of it. Nothing in either
 *  language can notice when one gains a field and the other does not — the
 *  symptom is a panel that renders blank against one code-agent and fills in against
 *  the other, which is a miserable thing to debug months later.
 *
 *  So the field names are compared here, per type, and a difference fails the
 *  build. Types are paired by name (`DirEntry` <-> `dirEntry`); a TypeScript
 *  interface with no Go counterpart is reported rather than ignored, because
 *  "not ported yet" and "quietly forgotten" look identical otherwise.
 */
import { readFile } from "node:fs/promises";

const TS_FILE = "src/code-agent/protocol.ts";
const GO_FILE = "code-agent-go/protocol.go";

// The kafka-agent is held to the same standard, by the same two comparisons:
// every interface against its struct, and the op table against the ops the Go
// agent registers. Its op table is typed rather than read out of handlers —
// see checkKafka() below.
const KAFKA_TS_FILE = "src/kafka-agent/protocol.ts";
const KAFKA_GO_FILE = "kafka-agent-go/protocol.go";
const KAFKA_GO_OPS_FILE = "kafka-agent-go/server.go";

/** Frame envelopes the Go code-agent handles without a tagged struct. Listed
 *  explicitly so the omission is a decision on the record rather than a gap
 *  nobody noticed.
 *
 *  `Res` and `ServerFrame` need no entry: they are type aliases, and only
 *  `export interface` is parsed here. */
const NOT_MIRRORED: Record<string, string> = {
  Req: "decoded as a raw map — the params are op-specific",
  Chunk: "built as chunkFrame",
  Push: "built as pushFrame",
  FsChange: "built inline as the fs.change push payload",
};

/** Strip line and block comments so a field name inside prose is not mistaken
 *  for a declaration. */
function decomment(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** `export interface Name { ... }` -> the names of its properties. */
function parseTs(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /export interface (\w+)\s*\{([\s\S]*?)\n\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const fields: string[] = [];
    for (const line of decomment(m[2]).split("\n")) {
      const f = /^\s*(\w+)\??\s*:/.exec(line);
      if (f) fields.push(f[1]);
    }
    out.set(m[1], fields);
  }
  return out;
}

/** `type name struct { ... }` -> the names in its json tags. Untagged fields
 *  are unexported bookkeeping and never reach the wire. */
function parseGo(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /^type (\w+) struct \{([\s\S]*?)^\}/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const fields: string[] = [];
    for (const line of decomment(m[2]).split("\n")) {
      const tag = /`json:"([^",]+)/.exec(line);
      if (tag) fields.push(tag[1]);
    }
    out.set(m[1], fields);
  }
  return out;
}

// ── the op tables ─────────────────────────────────────────────────────────
//
// Types matching is not enough, and this is not theoretical: `git.remote` grew
// a `mode` parameter, it was wired into the Go code-agent and forgotten in the
// TypeScript one, every type still lined up, and the symptom was a pull that
// silently went on merging. The op names and the parameter names each code-agent
// reads are the other half of the wire contract.

const TS_OPS_FILE = "src/code-agent/main.ts";
const GO_OPS_FILE = "code-agent-go/server.go";

/** An op name -> the parameter names that implementation reads for it. */
type OpTable = Map<string, Set<string>>;

/** Split a table body into `name -> the source text of its handler`.
 *
 *  Both files are one flat table of `"op.name": <handler>`, so the text of a
 *  handler is everything up to the next op name. That is cruder than parsing
 *  the language and it is enough: the parameter reads are inside it either way.
 */
function opBodies(source: string, from: string): Map<string, string> {
  const body = decomment(source.slice(source.indexOf(from)));
  // A hyphen is allowed in the namespace: `code-agent.info` is an op, and a
  // pattern that stopped at the letters silently left it out of the comparison.
  const re = /"([a-z][a-z-]*\.[A-Za-z]+)"\s*:/g;
  const found: { name: string; at: number }[] = [];
  for (let m = re.exec(body); m; m = re.exec(body)) found.push({ name: m[1], at: m.index + m[0].length });
  const out = new Map<string, string>();
  for (const [i, entry] of found.entries()) {
    out.set(entry.name, body.slice(entry.at, found[i + 1]?.at ?? body.length));
  }
  return out;
}

/** `str(p.ref)`, `Boolean(p.noFf)`, `p.limit` — all of them are `p.<name>`. */
function tsParams(handler: string): Set<string> {
  return new Set([...handler.matchAll(/\bp\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
}

/** `p.str("ref")`, `p.truthy("noFf")`, `p.number("limit", 0)`, `p.strs(…)`. */
function goParams(handler: string): Set<string> {
  return new Set([...handler.matchAll(/\bp\.(?:str|strs|truthy|number|value)\("([^"]+)"/g)].map((m) => m[1]));
}

function opTable(source: string, from: string, params: (h: string) => Set<string>): OpTable {
  const out: OpTable = new Map();
  for (const [name, handler] of opBodies(source, from)) out.set(name, params(handler));
  return out;
}

const ts = parseTs(await readFile(TS_FILE, "utf8"));
const go = parseGo(await readFile(GO_FILE, "utf8"));
const tsOps = opTable(await readFile(TS_OPS_FILE, "utf8"), "code-agent.info", tsParams);
const goOps = opTable(await readFile(GO_OPS_FILE, "utf8"), "code-agent.info", goParams);

if (ts.size === 0) throw new Error(`${TS_FILE} parsed to zero interfaces — the format changed`);
if (go.size === 0) throw new Error(`${GO_FILE} parsed to zero structs — the format changed`);

const problems: string[] = [];
let compared = 0;

for (const [name, tsFields] of ts) {
  // The exemption is checked first: `req` does exist as a Go struct, but it
  // carries untagged bookkeeping fields rather than a mirror of the interface.
  const reason = NOT_MIRRORED[name];
  if (reason) {
    console.log(`  skip  ${name.padEnd(14)} — ${reason}`);
    continue;
  }

  const goName = name[0].toLowerCase() + name.slice(1);
  const goFields = go.get(goName);
  if (!goFields) {
    problems.push(`${name}: no Go struct named ${goName}, and it is not in the not-mirrored list`);
    continue;
  }

  compared++;
  const missing = tsFields.filter((f) => !goFields.includes(f));
  const extra = goFields.filter((f) => !tsFields.includes(f));
  if (missing.length || extra.length) {
    problems.push(
      `${name} / ${goName}:` +
        (missing.length ? `\n    only in ${TS_FILE}: ${missing.join(", ")}` : "") +
        (extra.length ? `\n    only in ${GO_FILE}: ${extra.join(", ")}` : ""),
    );
  } else {
    console.log(`  ok    ${name.padEnd(14)} ${tsFields.length} fields`);
  }
}

// A Go struct with no TypeScript interface is fine — blameRow, for one, mirrors
// an inline return type — so only the other direction is an error.

// ── ops ───────────────────────────────────────────────────────────────────

if (tsOps.size === 0) throw new Error(`${TS_OPS_FILE} parsed to zero ops — the table format changed`);
if (goOps.size === 0) throw new Error(`${GO_OPS_FILE} parsed to zero ops — the table format changed`);

const onlyIn = (a: Iterable<string>, b: { has(v: string): boolean }): string[] => [...a].filter((v) => !b.has(v));

const missingOps = onlyIn(tsOps.keys(), goOps);
const extraOps = onlyIn(goOps.keys(), tsOps);
if (missingOps.length) problems.push(`ops only in ${TS_OPS_FILE}: ${missingOps.join(", ")}`);
if (extraOps.length) problems.push(`ops only in ${GO_OPS_FILE}: ${extraOps.join(", ")}`);

let opsCompared = 0;
for (const [name, tsP] of tsOps) {
  const goP = goOps.get(name);
  if (!goP) continue; // already reported above
  opsCompared++;
  // Only parameters *read from the request* are compared. A handler is free to
  // call whatever it likes internally; what has to agree is the set of names
  // the two code-agents will look for in the same frame.
  const missing = onlyIn(tsP, goP);
  const extra = onlyIn(goP, tsP);
  if (missing.length || extra.length) {
    problems.push(
      `${name}:` +
        (missing.length ? `\n    params read only by ${TS_OPS_FILE}: ${missing.join(", ")}` : "") +
        (extra.length ? `\n    params read only by ${GO_OPS_FILE}: ${extra.join(", ")}` : ""),
    );
  }
}
console.log(`  ok    ${String(opsCompared).padStart(3)} op(s), same names, same parameters`);

// ── the kafka-agent ───────────────────────────────────────────────────────

/** The same envelopes as the code-agent's, plus the op table itself. */
const KAFKA_NOT_MIRRORED: Record<string, string> = {
  Req: "decoded from the raw frame — the params are op-specific",
  Chunk: "built as chunkFrame",
  Push: "built as pushFrame",
  KafkaOps: "the op table, compared below",
};

/** `"topics.list": { params: ClusterParams; ...` -> op name -> parameter type. */
function kafkaTsOps(source: string): Map<string, string> {
  const block = /export interface KafkaOps\s*\{([\s\S]*?)\n\}/.exec(source);
  if (!block) throw new Error(`${KAFKA_TS_FILE} has no KafkaOps interface — the format changed`);
  const out = new Map<string, string>();
  for (const m of decomment(block[1]).matchAll(/"([A-Za-z.]+)":\s*\{\s*params:\s*(\w+);/g)) out.set(m[1], m[2]);
  return out;
}

/** `"topics.list": readOp(typed[clusterParams](...))` -> op name -> parameter type. The
 *  type argument is the whole of an op's contract, which is why the Go table is
 *  written that way and not with handlers that read their own parameters.
 *
 *  Every entry says `readOp` or `writeOp`. Go will not compile an entry without one,
 *  but a write that was marked a read compiles, and passes the read-only gate too — so
 *  the marks are collected here as well (`marks`: op name -> readOp | writeOp), and an
 *  entry with none is reported. */
function kafkaGoOps(source: string, marks: Map<string, string> = new Map()): Map<string, string> {
  const body = source.slice(source.indexOf("ops = map[string]opEntry{"));
  const out = new Map<string, string>();
  for (const m of decomment(body).matchAll(/"([A-Za-z.]+)":\s*(?:(readOp|writeOp)\()?typed\[(\w+)\]/g)) {
    out.set(m[1], m[3]);
    if (m[2]) marks.set(m[1], m[2]);
  }
  return out;
}

async function checkKafka(): Promise<void> {
  const kts = parseTs(await readFile(KAFKA_TS_FILE, "utf8"));
  const kgo = parseGo(await readFile(KAFKA_GO_FILE, "utf8"));
  if (kts.size === 0) throw new Error(`${KAFKA_TS_FILE} parsed to zero interfaces — the format changed`);
  if (kgo.size === 0) throw new Error(`${KAFKA_GO_FILE} parsed to zero structs — the format changed`);

  let ok = 0;
  for (const [name, tsFields] of kts) {
    if (KAFKA_NOT_MIRRORED[name]) continue;
    const goName = name[0].toLowerCase() + name.slice(1);
    const goFields = kgo.get(goName);
    if (!goFields) {
      problems.push(`${name}: no Go struct named ${goName} in ${KAFKA_GO_FILE}`);
      continue;
    }
    compared++;
    ok++;
    const missing = tsFields.filter((f) => !goFields.includes(f));
    const extra = goFields.filter((f) => !tsFields.includes(f));
    if (missing.length || extra.length) {
      problems.push(
        `${name} / ${goName}:` +
          (missing.length ? `\n    only in ${KAFKA_TS_FILE}: ${missing.join(", ")}` : "") +
          (extra.length ? `\n    only in ${KAFKA_GO_FILE}: ${extra.join(", ")}` : ""),
      );
    }
  }
  console.log(`  ok    kafka-agent: ${ok} type(s) compared`);

  const tsOps = kafkaTsOps(await readFile(KAFKA_TS_FILE, "utf8"));
  const marks = new Map<string, string>();
  const goOps = kafkaGoOps(await readFile(KAFKA_GO_OPS_FILE, "utf8"), marks);
  if (tsOps.size === 0) throw new Error(`${KAFKA_TS_FILE}: KafkaOps parsed to zero ops — the format changed`);
  if (goOps.size === 0) throw new Error(`${KAFKA_GO_OPS_FILE}: no typed ops found — the table format changed`);

  for (const name of tsOps.keys()) if (!goOps.has(name)) problems.push(`kafka op only in ${KAFKA_TS_FILE}: ${name}`);
  for (const name of goOps.keys()) if (!tsOps.has(name)) problems.push(`kafka op only in ${KAFKA_GO_OPS_FILE}: ${name}`);
  let same = 0;
  for (const [name, tsType] of tsOps) {
    const goType = goOps.get(name);
    if (!goType) continue;
    if (goType[0].toUpperCase() + goType.slice(1) !== tsType) {
      problems.push(`kafka op ${name}: takes ${tsType} in ${KAFKA_TS_FILE} but ${goType} in ${KAFKA_GO_OPS_FILE}`);
    } else {
      same++;
    }
  }
  console.log(`  ok    kafka-agent: ${same} op(s), same names, same parameter types`);

  const unmarked = [...goOps.keys()].filter((name) => !marks.has(name));
  for (const name of unmarked) problems.push(`kafka op ${name}: not marked readOp or writeOp in ${KAFKA_GO_OPS_FILE}`);
  if (unmarked.length === 0) {
    const writes = [...marks].filter(([, mark]) => mark === "writeOp").map(([name]) => name);
    console.log(`  ok    kafka-agent: every op is marked read or write (${writes.length} write: ${writes.join(", ") || "none"})`);
  }
}

await checkKafka();

console.log("");
if (problems.length) {
  for (const p of problems) console.log(`  FAIL  ${p}`);
  console.log(`\n${problems.length} problem(s): the TypeScript and Go sides of a protocol differ`);
  process.exit(1);
}
console.log(`${compared} type(s) match field for field, in both protocols`);
