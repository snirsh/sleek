/**
 * Pure helpers for the sticky line selection (label + Ask payload text) — used by
 * src/render/client.ts in the browser.
 *
 * SHIPPING MODEL (same as markdown.ts / splitmodel.ts / lsputil.ts / threadsui.ts):
 * these exact functions also run in the browser — client.ts injects each
 * fn.toString() into CLIENT_JS, so every body must stay fully self-contained: no
 * imports, no references to module scope, no TS-only runtime syntax.
 * selection.test.ts covers the very functions the page runs.
 */

/** The client's compact DATA row shape: add / del / ctx / hunk + per-side lines. */
export interface SelRow {
  t: string;
  o: number | null;
  n: number | null;
}

/**
 * Selection label (GitHub model). rows: the selected non-hunk DATA rows in display
 * order. Single-side selections label "file:start–end". Mixed selections whose
 * new-file numbering is contiguous label "file:start–end (+N deleted lines not
 * included)" — the Ask/anchor payload is single-side (the dominant new side), so
 * the label must disclose the deleted rows it drops (no silent data loss). Mixed
 * selections with non-contiguous new numbering label per side:
 * "file: old A–B / new C–D". Ranges are always min–max per side — never reversed.
 */
export function selLabel(rows: readonly SelRow[], path: string): string {
  const name = path.split("/").pop();
  const news: number[] = [];
  const olds: number[] = [];
  let dels = 0;
  for (const r of rows) {
    if (r.n !== null) news.push(r.n);
    if (r.o !== null) olds.push(r.o);
    if (r.t === "d") dels++;
  }
  const range = (a: number[]): string => {
    const lo = Math.min.apply(null, a);
    const hi = Math.max.apply(null, a);
    return lo === hi ? String(lo) : lo + "–" + hi;
  };
  if (!dels) return name + ":" + range(news);
  if (!news.length) return name + ":" + range(olds);
  const contiguous = news.every((v, i) => i === 0 || v === news[i - 1]! + 1);
  if (contiguous) {
    return (
      name + ":" + range(news) +
      " (+" + dels + " deleted line" + (dels === 1 ? "" : "s") + " not included)"
    );
  }
  return name + ": old " + range(olds) + " / new " + range(news);
}

/**
 * The selection's text for the Ask payload (`selectedText`). entries: the selected
 * non-hunk rows in display order with their raw code text. Pure single-side
 * selections (all-deleted, or no deletions) return the plain joined lines —
 * byte-identical to the clipboard Copy text. MIXED selections return a unified-
 * diff-style snippet ("- " on deleted lines, "  " on kept lines) so the deleted
 * rows travel to the model as removed context instead of vanishing (the anchor
 * coordinates stay single-side; this text is the disclosure).
 */
export function selAskText(entries: readonly { t: string; text: string }[]): string {
  const hasDel = entries.some((e) => e.t === "d");
  const hasKept = entries.some((e) => e.t !== "d");
  if (!hasDel || !hasKept) return entries.map((e) => e.text).join("\n");
  return entries.map((e) => (e.t === "d" ? "- " + e.text : "  " + e.text)).join("\n");
}
