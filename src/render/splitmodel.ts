/**
 * Row pairing for the side-by-side (split) diff view.
 *
 * buildSplitPairs walks a file's rows (only the `t` type tag is consulted — the
 * client's compact DATA shape) and yields one output entry per SPLIT-TABLE ROW:
 *   hunk  → full-width hunk header
 *   ctx   → the same row on both sides
 *   pair  → del row d on the left / add row a on the right; within a del-run
 *           followed by an add-run, del i pairs with add i (the intraline.ts rule),
 *           and the longer run's leftover rows get null on the opposite side.
 * Add-runs with no preceding del-run become pairs with d:null.
 *
 * SHIPPING MODEL (same as markdown.ts): this exact function also runs in the
 * browser — client.ts injects buildSplitPairs.toString() into CLIENT_JS, so the body
 * must stay fully self-contained: no imports, no module-scope references, no TS-only
 * runtime syntax. splitmodel.test.ts covers the very function the page runs.
 */

export type SplitPair =
  | { k: "hunk"; ri: number }
  | { k: "ctx"; ri: number }
  | { k: "pair"; d: number | null; a: number | null };

export function buildSplitPairs(rows: readonly { t: "a" | "d" | "c" | "h" }[]): SplitPair[] {
  const out: SplitPair[] = [];
  let i = 0;
  while (i < rows.length) {
    const t = rows[i].t;
    if (t === "h") {
      out.push({ k: "hunk", ri: i });
      i++;
    } else if (t === "c") {
      out.push({ k: "ctx", ri: i });
      i++;
    } else if (t === "a") {
      // Add with no preceding del-run: right side only.
      out.push({ k: "pair", d: null, a: i });
      i++;
    } else {
      let j = i;
      while (j < rows.length && rows[j].t === "d") j++;
      let k = j;
      while (k < rows.length && rows[k].t === "a") k++;
      const dels = j - i;
      const adds = k - j;
      const span = dels > adds ? dels : adds;
      for (let p = 0; p < span; p++) {
        out.push({ k: "pair", d: p < dels ? i + p : null, a: p < adds ? j + p : null });
      }
      i = k;
    }
  }
  return out;
}
