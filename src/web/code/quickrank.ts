/** Ranking paths against what has been typed, for "go to file".
 *
 *  Subsequence matching, the way every quick open works: "wcdx" finds "web/code/index.ts". Two
 *  things keep it cheap on a project of twenty thousand files. The paths are lower-cased once, by
 *  the caller, and the query once here — it used to be lower-cased again for every path. And only
 *  the best `limit` are kept as the scan goes, by insertion, so there is no list of every match
 *  to sort when fifty are shown.
 */

/** How well a lower-cased path matches a lower-cased query: higher is better, negative is no. */
export function scorePath(haystack: string, needle: string): number {
  if (!needle) return 0;
  const direct = haystack.lastIndexOf(needle);
  // A contiguous match wins, and one in the file name beats one in a directory further up.
  if (direct !== -1) return 1000 - (haystack.length - direct);
  let at = -1;
  for (let i = 0; i < needle.length; i++) {
    at = haystack.indexOf(needle[i], at + 1);
    if (at === -1) return -1;
  }
  return 500 - haystack.length;
}

/** The `limit` best paths, best first; equal scores keep the order the paths came in. */
export function rankPaths(paths: readonly string[], lower: readonly string[], query: string, limit: number): string[] {
  const needle = query.toLowerCase();
  const best: { i: number; s: number }[] = [];
  for (let i = 0; i < paths.length; i++) {
    const s = scorePath(lower[i], needle);
    if (s < 0) continue;
    // Full, and not better than the worst kept: a later path with an equal score ranks below it.
    if (best.length === limit && s <= best[limit - 1].s) continue;
    let at = best.length;
    while (at > 0 && best[at - 1].s < s) at--;
    best.splice(at, 0, { i, s });
    if (best.length > limit) best.pop();
  }
  return best.map((b) => paths[b.i]);
}
