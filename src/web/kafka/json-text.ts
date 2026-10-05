/** JSON laid out in lines without being read as values (X-02).
 *
 *  `JSON.stringify(JSON.parse(text), null, 2)` reads every number as a double. 9007199254740993
 *  comes back as 9007199254740992, 10.50 as 10.5, 1e2 as 100: the panel then shows a number the
 *  topic does not hold, and a person who copies it from there sends the wrong one. Here the text
 *  is walked token by token. The indent is the only thing that changes; every string, number and
 *  literal is copied as it was written, and so is the order of the keys (and a key written twice).
 */

// Written as an unrolled loop (plain run, escape, plain run, …): a string cut off before its
// closing quote must fail in one pass, not after trying every way to split the run.
const STRING = /"[^"\\\u0000-\u001f]*(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})[^"\\\u0000-\u001f]*)*"/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERAL = /true|false|null/y;

/** Deeper than this is shown as it came. The indent grows with the depth, so the text of a
 *  value nested n deep takes n² characters; no real message is nested a thousand levels. */
const MAX_DEPTH = 1000;

const isSpace = (c: string): boolean => c === " " || c === "\n" || c === "\r" || c === "\t";

/** `text` written out with `indent` per level, or null when it is not JSON. The layout is the one
 *  of `JSON.stringify(value, null, 2)`: `"key": value`, an empty object or array as `{}` / `[]`.
 *  Nothing is recursive, so a deeply nested value costs no stack; one nested past MAX_DEPTH gives null. */
export function reindentJSON(text: string, indent = "  "): string | null {
  const n = text.length;
  const stack: ("{" | "[")[] = [];
  // What comes next. "first" is the position right after an opening bracket, where a closing
  // one is allowed and a comma is not.
  let want: "value" | "first-value" | "first-key" | "key" | "colon" | "after" | "end" = "value";
  let out = "";
  let i = 0;

  const newline = (): string => "\n" + indent.repeat(stack.length);
  const scan = (re: RegExp): string | null => {
    re.lastIndex = i;
    const m = re.exec(text);
    if (m === null) return null;
    i += m[0].length;
    return m[0];
  };

  while (true) {
    while (i < n && isSpace(text[i])) i++;
    if (i >= n) break;
    const c = text[i];

    if (want === "end") return null; // text after the value

    if (want === "value" || want === "first-value") {
      if (want === "first-value" && c === "]") {
        stack.pop();
        out += "]";
        i++;
        want = stack.length === 0 ? "end" : "after";
        continue;
      }
      if (want === "first-value") out += newline();
      if (c === "{" || c === "[") {
        if (stack.length >= MAX_DEPTH) return null;
        stack.push(c);
        out += c;
        i++;
        want = c === "{" ? "first-key" : "first-value";
        continue;
      }
      const token = c === '"' ? scan(STRING) : c === "t" || c === "f" || c === "n" ? scan(LITERAL) : scan(NUMBER);
      if (token === null) return null;
      out += token;
      want = stack.length === 0 ? "end" : "after";
      continue;
    }

    if (want === "first-key" || want === "key") {
      if (want === "first-key" && c === "}") {
        stack.pop();
        out += "}";
        i++;
        want = stack.length === 0 ? "end" : "after";
        continue;
      }
      if (c !== '"') return null;
      const key = scan(STRING);
      if (key === null) return null;
      out += newline() + key;
      want = "colon";
      continue;
    }

    if (want === "colon") {
      if (c !== ":") return null;
      out += ": ";
      i++;
      want = "value";
      continue;
    }

    // After a value inside a container: a comma, or the container's own closing bracket.
    const top = stack[stack.length - 1];
    if (c === ",") {
      out += ",";
      i++;
      if (top === "{") {
        want = "key";
      } else {
        out += newline();
        want = "value";
      }
      continue;
    }
    if ((c === "}" && top === "{") || (c === "]" && top === "[")) {
      stack.pop();
      out += newline() + c;
      i++;
      want = stack.length === 0 ? "end" : "after";
      continue;
    }
    return null;
  }
  return want === "end" ? out : null;
}
