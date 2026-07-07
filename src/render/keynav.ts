/**
 * Pure hunk iteration for the Wave-3 j/k bindings — which row each change block
 * (hunk) starts at, in row order.
 *
 * SHIPPING MODEL (same as markdown.ts / splitmodel.ts / lsputil.ts / threadsui.ts
 * / palette.ts): this exact function also runs in the browser — client.ts injects
 * fn.toString() into CLIENT_JS, so the body must stay fully self-contained: no
 * imports, no references to module scope, no TS-only runtime syntax.
 * keynav.test.ts covers the very function the page runs.
 */

/**
 * Row index of every hunk's FIRST content row, in row order: the row right after
 * each hunk-header row ("h"). Rows the expandable-context layer appends later are
 * plain context rows (never "h"), so they never create new hunks — compute this
 * once on the original rows. A header with no content row after it (defensive;
 * real diffs never emit one) is skipped.
 */
export function hunkStartRows(rows: readonly { t: string }[]): number[] {
  const out: number[] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    if (rows[ri]!.t !== "h") continue;
    const next = rows[ri + 1];
    if (next && next.t !== "h") out.push(ri + 1);
  }
  return out;
}
