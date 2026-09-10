/** Guard against the two agents' wire types drifting apart:
 *  `bun run protocol:check`.
 *
 *  src/agent/protocol.ts is the definition the browser is compiled against;
 *  agent-go/protocol.go is a hand-written mirror of it. Nothing in either
 *  language can notice when one gains a field and the other does not — the
 *  symptom is a panel that renders blank against one agent and fills in against
 *  the other, which is a miserable thing to debug months later.
 *
 *  So the field names are compared here, per type, and a difference fails the
 *  build. Types are paired by name (`DirEntry` <-> `dirEntry`); a TypeScript
 *  interface with no Go counterpart is reported rather than ignored, because
 *  "not ported yet" and "quietly forgotten" look identical otherwise.
 */
import { readFile } from "node:fs/promises";

const TS_FILE = "src/agent/protocol.ts";
const GO_FILE = "agent-go/protocol.go";

/** Frame envelopes the Go agent handles without a tagged struct. Listed
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

const ts = parseTs(await readFile(TS_FILE, "utf8"));
const go = parseGo(await readFile(GO_FILE, "utf8"));

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

console.log("");
if (problems.length) {
  for (const p of problems) console.log(`  FAIL  ${p}`);
  console.log(`\n${problems.length} type(s) differ between ${TS_FILE} and ${GO_FILE}`);
  process.exit(1);
}
console.log(`${compared} type(s) match field for field`);
