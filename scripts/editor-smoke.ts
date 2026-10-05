/** The numbers under an editor, without a browser: `bun run editor:smoke`.
 *
 *  The status line counts bytes and the badge parses YAML, both after a pause in typing, on texts
 *  that can be megabytes. Two things are checked: the byte count is the one `TextEncoder` gives,
 *  for every kind of text, and one text is parsed once however many ask about it.
 */
import { utf8Length } from "../src/web/text-size.ts";
import { YAML_LINT_MAX, yamlDiagnostics, yamlParseCount, yamlTooLarge } from "../src/web/yaml-lint.ts";

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

// ── bytes ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const samples: [string, string][] = [
  ["empty", ""],
  ["ASCII", "key: value\nother: 2\n"],
  ["Latin and Cyrillic", "ключ: значение — café"],
  ["CJK", "键: 值 漢字かな"],
  ["emoji, a surrogate pair", "ok 🚀 ok"],
  ["a lone high surrogate", "a\ud83db"],
  ["a lone low surrogate", "a\ude00b"],
  ["a pair split by text", "\ud83d x \ude00"],
  ["every size in a row", "a\u00e9\u20ac\u{1f600}"],
];
for (const [name, text] of samples) {
  const want = encoder.encode(text).length;
  check(`bytes of ${name}`, utf8Length(text) === want, `${utf8Length(text)} against ${want}`);
}
let mixed = "";
for (let i = 0; i < 20000; i++) mixed += String.fromCodePoint(0x20 + ((i * 7919) % 0x2f00), i % 9 === 0 ? 0x1f600 : 0x61);
check("bytes of 20,000 mixed characters", utf8Length(mixed) === encoder.encode(mixed).length);

// ── one parse ─────────────────────────────────────────────────────────────

const text = "a: 1\nb: [\n";
const before = yamlParseCount();
const first = yamlDiagnostics(text);
const second = yamlDiagnostics(`${text}`.slice(0)); // another string with the same characters
check("one text, two askers, one parse", yamlParseCount() - before === 1, String(yamlParseCount() - before));
check("and the same answer", first === second && first.length > 0);
yamlDiagnostics("a: 1\nb: 2\n");
check("a different text is parsed again", yamlParseCount() - before === 2);
yamlDiagnostics("   \n");
check("a blank text is not parsed at all", yamlParseCount() - before === 2);
const huge = "k: v\n".repeat(Math.ceil(YAML_LINT_MAX / 5) + 10) + "b: [\n";
check("a text over the limit is too large", yamlTooLarge(huge) && !yamlTooLarge("k: v\n"));
check("and is not parsed, and has no diagnostics", yamlDiagnostics(huge).length === 0 && yamlParseCount() - before === 2);

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(`${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`${results.length} checks passed: bytes are counted as encoded, and a text is parsed once`);
