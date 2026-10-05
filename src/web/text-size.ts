/** The size of a text in UTF-8, in bytes — counted, not encoded.
 *
 *  The status line needs a number, and getting it by encoding the whole text built a copy of the
 *  document in the size of the document, on every pause in typing. For ASCII — which is all of an
 *  envelope, and most of what is typed here — the size is the length, and one scan says so. For
 *  anything else the code units are walked once and priced: one byte below U+0080, two below
 *  U+0800, four for a surrogate pair, three for the rest. A lone surrogate is three, because that
 *  is what encoding it gives (U+FFFD), so the answer is the one `TextEncoder` would have given.
 */
const NON_ASCII = /[^\x00-\x7f]/;

export function utf8Length(text: string): number {
  if (!NON_ASCII.test(text)) return text.length;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
