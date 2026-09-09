/** Syntax grammars for the code editor, keyed by file extension.
 *
 *  Deliberately a fixed, statically imported set rather than
 *  @codemirror/language-data: that package resolves grammars through dynamic
 *  imports, which only pay off with `bun build --splitting`, and split chunks
 *  get hashed names that cannot be listed in server.ts's STATIC map — which is
 *  what keeps the compiled binary self-contained. A fixed set costs a few
 *  hundred KB inside the lazily-loaded code chunk and keeps the build honest.
 *
 *  Adding a language: install its @codemirror/lang-* package, import it, and
 *  add its extensions to EXTENSIONS below.
 */
import type { LanguageSupport } from "@codemirror/language";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { yaml } from "@codemirror/lang-yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import type { Extension } from "@codemirror/state";

type Factory = () => Extension;

const ts = (): Extension => javascript({ typescript: true });
const tsx = (): Extension => javascript({ typescript: true, jsx: true });
const jsx = (): Extension => javascript({ jsx: true });
const stream = (mode: Parameters<typeof StreamLanguage.define>[0]): Factory => () => StreamLanguage.define(mode);

/** extension (without the dot) -> grammar factory */
const EXTENSIONS: Record<string, Factory> = {
  js: javascript, mjs: javascript, cjs: javascript, jsx,
  ts: ts, mts: ts, cts: ts, tsx,
  json: json, jsonc: json, map: json,
  yaml: yaml, yml: yaml,
  css: css, scss: css, less: css,
  html: html, htm: html, vue: html, svelte: html,
  md: markdown, markdown: markdown,
  py: python, pyi: python,
  rs: rust,
  go: go,
  xml: xml, svg: xml, xsl: xml, plist: xml,
  sql: sql,
  c: cpp, h: cpp, cc: cpp, cpp: cpp, cxx: cpp, hpp: cpp, hxx: cpp,
  java: java,
  php: php,
  sh: stream(shell), bash: stream(shell), zsh: stream(shell), fish: stream(shell),
  toml: stream(toml),
  ini: stream(properties), cfg: stream(properties), conf: stream(properties), env: stream(properties),
};

/** Files matched by name rather than extension. */
const FILENAMES: [RegExp, Factory][] = [
  [/^Dockerfile(\..+)?$/i, stream(dockerFile)],
  [/^(Makefile|GNUmakefile)$/i, stream(properties)],
  [/^\.env(\..+)?$/i, stream(properties)],
  [/^\.(git|npm|docker)ignore$/i, stream(properties)],
  [/^(package|tsconfig|bun)\.lock$/i, json],
];

/** Instantiated grammars are cached: the same language recurs constantly while
 *  browsing a project and each parser build is not free. */
const cache = new Map<string, Extension | null>();

export function grammarFor(path: string): Extension | null {
  const name = path.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const key = ext || name;

  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const factory = EXTENSIONS[ext] ?? FILENAMES.find(([re]) => re.test(name))?.[1];
  const support = factory ? factory() : null;
  cache.set(key, support);
  return support;
}

// Re-exported so editor.ts can keep its own imports to the CodeMirror core.
export type { LanguageSupport };
