/**
 * Pure fuzzy matching for the Wave-3 jump palette (t / ⌘K) — subsequence match +
 * rank across file paths, layer titles and open-thread first lines.
 *
 * SHIPPING MODEL (same as markdown.ts / splitmodel.ts / lsputil.ts / threadsui.ts):
 * these exact functions also run in the browser — client.ts injects each
 * fn.toString() into CLIENT_JS, so every body must stay fully self-contained: no
 * imports (paletteMatches may call fuzzyScore — both ship), no references to
 * module scope, no TS-only runtime syntax. palette.test.ts covers the very
 * functions the page runs.
 */

/**
 * Score `query` as a case-insensitive subsequence of `text`; null when it is not
 * one. Greedy leftmost alignment; per matched character: +1 base, +2 more when
 * contiguous with the previous match, else +1 more when it starts a word (offset
 * 0 or preceded by a non-alphanumeric). A tiny length penalty prefers shorter
 * targets on structural ties. Net ranking: contiguous runs > word-boundary
 * starts > scattered matches. An empty query matches everything at score 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let from = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const at = t.indexOf(q.charAt(qi), from);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += 2;
    else if (at === 0 || !/[a-z0-9]/.test(t.charAt(at - 1))) score += 1;
    prev = at;
    from = at + 1;
  }
  return score - t.length / 1000;
}

/**
 * Indexes of the labels matching `query`, best first (score descending; input
 * order on equal scores), capped at `limit`. An empty query returns the first
 * `limit` indexes in input order — the palette's "nothing typed yet" list.
 */
export function paletteMatches(query: string, labels: readonly string[], limit: number): number[] {
  if (query === "") return labels.slice(0, limit).map((_l, i) => i);
  const scored: { i: number; s: number }[] = [];
  for (let i = 0; i < labels.length; i++) {
    const s = fuzzyScore(query, labels[i]!);
    if (s !== null) scored.push({ i: i, s: s });
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.i);
}
