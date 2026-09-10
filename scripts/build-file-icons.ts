/** Generate src/web/code/file-icons.ts from the Seti UI icon set.
 *
 *     bun scripts/build-file-icons.ts
 *
 *  Seti UI (https://github.com/jesseweed/seti-ui) is MIT licensed, which is why
 *  it is the set used here — the icons are vendored into a generated module and
 *  the licence travels with them in that file's header.
 *
 *  Generated rather than hand-copied so the provenance of every path is a URL
 *  and refreshing the set is one command. The theme's own sources are the input:
 *  `ui-variables.less` for the palette and `mapping.less` for which icon and
 *  colour each extension gets, so the result matches what VS Code shows under
 *  its "Seti" theme instead of being a guess.
 *
 *  Only the types this editor can actually highlight are pulled in — the full
 *  set is ~200 files and would be dead weight in the bundle.
 */
import { writeFile } from "node:fs/promises";

const RAW = "https://raw.githubusercontent.com/jesseweed/seti-ui/master";

/** Extensions and exact file names worth an icon here, in tree display order.
 *  The value is the key as it appears in the theme's mapping. */
const WANTED = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".md",
  ".html", ".css", ".scss", ".py", ".rs", ".go", ".java", ".php", ".sql", ".xml",
  ".c", ".h", ".cpp", ".sh", ".bash", ".toml", ".ini", ".env", ".lock", ".svg",
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".txt", ".csv",
  "dockerfile", ".dockerignore", ".gitignore", ".gitattributes", "license",
  "makefile", ".editorconfig", ".lua", ".rb", ".swift", ".kt", ".vue", ".graphql",
];

const text = async (path: string): Promise<string> => {
  const res = await fetch(`${RAW}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
};

// ── palette ───────────────────────────────────────────────────────────────
const variables = await text("styles/ui-variables.less");
const palette = new Map<string, string>();
for (const m of variables.matchAll(/@([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  palette.set(m[1], m[2]);
}

// ── extension -> icon + colour ────────────────────────────────────────────
// Entries look like: .icon-set(".js", "javascript", @yellow);
// Either quote style is accepted — the theme uses double quotes today, and a
// silently empty match here would degrade every file to the default icon.
const mapping = await text("styles/components/icons/mapping.less");
interface Entry { icon: string; colorVar: string }
const byKey = new Map<string, Entry>();
const RULE = /\.icon-(?:set|partial)\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*,\s*@([\w-]+)\s*\)/g;
for (const m of mapping.matchAll(RULE)) {
  byKey.set(m[1].toLowerCase(), { icon: m[2], colorVar: m[3] });
}
if (byKey.size < 100) throw new Error(`mapping.less parsed to only ${byKey.size} rules — the format changed`);

/** Keys the theme itself does not map, pointed at icons the set does contain.
 *  Still Seti's own artwork — only the choice of which icon is ours. */
const EXTRA: Record<string, Entry> = {
  ".bash": { icon: "shell", colorVar: "green" },
  ".ini": { icon: "config", colorVar: "grey" },
  ".lock": { icon: "lock", colorVar: "grey" },
};

/** Keys the theme does map, where we deliberately map them elsewhere. Also
 *  Seti's artwork; only the pairing is ours, and each one needs a reason.
 *
 *  .yml/.yaml: Seti draws these as an exclamation mark, and this app puts a
 *  state letter at the other end of the same row — where "!" means "merge
 *  conflict". In a directory of nothing but YAML, which is the normal case for
 *  the people this tool is built for, the explorer read as a list of files in
 *  trouble. The gear says "configuration", which is what these files are. */
const OVERRIDE: Record<string, Entry> = {
  ".yml": { icon: "config", colorVar: "purple" },
  ".yaml": { icon: "config", colorVar: "purple" },
};

const missing: string[] = [];
const chosen = new Map<string, Entry>();
for (const key of WANTED) {
  const hit = OVERRIDE[key.toLowerCase()] ?? byKey.get(key.toLowerCase()) ?? EXTRA[key.toLowerCase()];
  if (hit) chosen.set(key, hit);
  else missing.push(key);
}
// Always need the fallbacks, whatever the mapping says.
const defaults: Record<string, Entry> = {
  _default: { icon: "default", colorVar: "grey" },
  _folder: { icon: "folder", colorVar: "grey" },
};

// ── fetch the SVGs the choices point at ───────────────────────────────────
const needed = [...new Set([...chosen.values(), ...Object.values(defaults)].map((e) => e.icon))].sort();
const bodies = new Map<string, { viewBox: string; body: string }>();
for (const name of needed) {
  const svg = await text(`icons/${name}.svg`);
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 32 32";
  // Strip the wrapper and any fill the file hardcodes: colour comes from the
  // theme mapping and is applied via currentColor at render time.
  const body = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>[\s\S]*$/, "")
    .replace(/\s(fill|stroke)="(?!none)[^"]*"/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  bodies.set(name, { viewBox, body });
  console.log(`  ${name.padEnd(14)} ${viewBox.padEnd(12)} ${body.length} chars`);
}

// ── emit ──────────────────────────────────────────────────────────────────
const colorOf = (e: Entry): string => palette.get(e.colorVar) ?? "#8a93a3";
const q = (s: string): string => JSON.stringify(s);

const iconEntries = [...bodies]
  .map(([name, v]) => `  ${JSON.stringify(name)}: { viewBox: ${q(v.viewBox)}, body: ${q(v.body)} },`)
  .join("\n");

const mapEntries = [...chosen]
  .map(([key, e]) => `  ${JSON.stringify(key)}: [${q(e.icon)}, ${q(colorOf(e))}],`)
  .join("\n");

const out = `/** File-type icons, generated — do not edit by hand.
 *
 *  Source: Seti UI (https://github.com/jesseweed/seti-ui), MIT licensed.
 *  Copyright (c) 2014 Jesse Weed. Icon paths and their colours are taken from
 *  that project's own \`icons/\` and \`styles/\` sources; the MIT licence text
 *  ships alongside them in THIRD-PARTY-LICENSES.md at the repository root.
 *
 *  Regenerate with: bun scripts/build-file-icons.ts
 */

interface Glyph {
  viewBox: string;
  body: string;
}

const GLYPHS: Record<string, Glyph> = {
${iconEntries}
};

/** Extension or exact file name -> [glyph, colour]. */
const BY_KEY: Record<string, [string, string]> = {
${mapEntries}
};

const DEFAULT_FILE: [string, string] = [${q(defaults._default.icon)}, ${q(colorOf(defaults._default))}];
const FOLDER: [string, string] = [${q(defaults._folder.icon)}, ${q(colorOf(defaults._folder))}];

const render = ([name, color]: [string, string], extraClass: string): string => {
  const g = GLYPHS[name];
  if (!g) return "";
  return \`<svg class="fic \${extraClass}" viewBox="\${g.viewBox}" width="16" height="16" fill="\${color}" aria-hidden="true" focusable="false">\${g.body}</svg>\`;
};

/** Icon markup for a tree entry. Directories get one icon; files are matched on
 *  their full lower-cased name first (so \`Dockerfile\` and \`.gitignore\` win over
 *  any extension rule), then on the longest matching extension. */
export function fileIcon(name: string, dir: boolean): string {
  if (dir) return render(FOLDER, "fic-dir");
  const lower = name.toLowerCase();
  const exact = BY_KEY[lower];
  if (exact) return render(exact, "fic-file");
  const dot = lower.lastIndexOf(".");
  const ext = dot === -1 ? "" : lower.slice(dot);
  return render(BY_KEY[ext] ?? DEFAULT_FILE, "fic-file");
}
`;

await writeFile("src/web/code/file-icons.ts", out);

console.log(`\n${bodies.size} glyphs, ${chosen.size} mappings -> src/web/code/file-icons.ts`);
if (missing.length) console.log(`not in the theme's mapping (falling back to the default icon): ${missing.join(" ")}`);
