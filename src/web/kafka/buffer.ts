/** How much of the topic the viewer keeps, and in what units.
 *
 *  A live view is a window onto a stream that does not end, so the oldest
 *  messages fall off the far end rather than the tab growing until it is slow.
 *  That window used to be counted in messages alone, and a count says nothing
 *  about size: a value may be 256 KiB, which base64 turns into about 341,000
 *  characters, so 5000 of them was about 1.7 GB of text on screen — and the
 *  list held while the view is paused was another 1.7 GB on top of it.
 *
 *  This module is the budget itself, kept out of the panel because it is the
 *  one part of it that can be reasoned about without a page: `bun run
 *  kafka-web:smoke` checks it directly.
 */
import type { KafkaMessage } from "../../kafka-agent/protocol.ts";

/** How many messages either list may hold. */
export const MAX_LIVE = 5000;

/** How much memory either list may hold, as the characters it is made of.
 *
 *  A character in a JavaScript string is two bytes, so this is about 64 MB of
 *  the tab's memory. It is the bound that actually decides how much a viewer
 *  keeps; the count above is what applies to small messages.
 *
 *  A value is not turned into bytes to store it. It arrives as base64 text and
 *  stays text: the detail view renders exactly that string and the editor puts
 *  it in a CodeMirror document, so decoding every value up front to save the
 *  third that base64 costs would only move the work to the panel that shows it.
 *  "Load full message" and the export are the two places that decode, and both
 *  are one message at a time.
 */
export const MAX_LIVE_BYTES = 32 << 20;

/** What one message costs the page: its base64 text, headers included. */
export function messageChars(m: KafkaMessage): number {
  let n = (m.key?.length ?? 0) + (m.value?.length ?? 0);
  for (const h of m.headers) n += h.key.length + (h.value?.length ?? 0);
  return n;
}

/** What a list costs, keys and values and headers together. */
export const listChars = (list: KafkaMessage[]): number => list.reduce((n, m) => n + messageChars(m), 0);

/** Drop the oldest messages of a list until it is inside both budgets, and say
 *  how many went.
 *
 *  `oldestFirst` says which end they are at, because the lists do not agree on
 *  that: a read and a paused tail are in arrival order, and the list on screen
 *  while following is newest first. What a busy topic costs is always paid by
 *  its oldest arrivals — the newest are what a viewer is for. */
export function trimToBudget(list: KafkaMessage[], oldestFirst: boolean): number {
  let chars = listChars(list);
  let dropped = 0;
  const oldest = (i: number): KafkaMessage => list[oldestFirst ? i : list.length - 1 - i]!;
  while (dropped < list.length && (list.length - dropped > MAX_LIVE || chars > MAX_LIVE_BYTES)) {
    chars -= messageChars(oldest(dropped));
    dropped++;
  }
  if (dropped === 0) return 0;
  if (oldestFirst) list.splice(0, dropped);
  else list.length -= dropped;
  return dropped;
}
