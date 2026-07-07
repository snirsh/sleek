/**
 * Pure matching for the Wave-4C file filter (the text input above the rail's
 * Files tree): which files survive the query. Deliberately a case-insensitive
 * SUBSTRING match on the full path (GitHub's file-filter semantics) rather
 * than the palette's fuzzy subsequence — the tree is a spatial structure, and
 * "sub" matching "src/utils/badge.ts" would read as a bug there. The client
 * hides tree file rows not in the returned set and dirs left with no visible
 * descendant.
 *
 * SHIPPING MODEL (same as markdown.ts / palette.ts / keynav.ts / markers.ts):
 * this exact function also runs in the browser — client.ts injects
 * fn.toString() into CLIENT_JS, so the body must stay fully self-contained: no
 * imports, no references to module scope, no TS-only runtime syntax.
 * treefilter.test.ts covers the very function the page runs.
 */

/**
 * Indexes of the paths matching `query` (case-insensitive substring on the
 * FULL path, so directory segments match too), in input order. Surrounding
 * whitespace on the query is ignored; an empty/blank query matches everything.
 */
export function fileFilterMatches(paths: readonly string[], query: string): number[] {
  const q = query.trim().toLowerCase();
  const out: number[] = [];
  paths.forEach(function (p, i) {
    if (q === "" || p.toLowerCase().indexOf(q) !== -1) out.push(i);
  });
  return out;
}
