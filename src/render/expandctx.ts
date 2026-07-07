/**
 * Pure math for GitHub-style expandable diff context (live mode: POST /api/context)
 * — which hunk boundaries have hidden lines, what range one click fetches, and how
 * LEFT (old-file) numbers derive from the RIGHT (new-file) numbers the server
 * returns. Unchanged regions have a constant old−new offset (`delta`), so
 * old = new + delta everywhere inside a gap.
 *
 * SHIPPING MODEL (same as markdown.ts / splitmodel.ts / lsputil.ts / threadsui.ts):
 * these exact functions also run in the browser — client.ts injects each
 * fn.toString() into CLIENT_JS, so every body must stay fully self-contained: no
 * imports, no references to module scope, no TS-only runtime syntax.
 * expandctx.test.ts covers the very functions the page runs.
 */

/** The client's compact DATA row shape: add / del / ctx / hunk + per-side lines. */
export interface CtxRow {
  t: string;
  o: number | null;
  n: number | null;
}

/**
 * One expandable gap of hidden lines at a hunk boundary.
 * `hunkRi`: row index of the hunk-header row the gap sits ABOVE (the gap between
 * the previous hunk — or the top of the file — and this hunk); null for the gap
 * BELOW the last hunk (toward EOF). `gapStart`/`gapEnd` are RIGHT-side (new-file)
 * 1-based inclusive line numbers of the hidden region; `gapEnd` is null when the
 * end is unknown (EOF gap — the file's length isn't in the diff; a short
 * /api/context response reveals it). `delta` = old − new in the gap.
 */
export interface HunkBoundary {
  hunkRi: number | null;
  gapStart: number;
  gapEnd: number | null;
  delta: number;
}

/**
 * All expandable boundaries of one file's rows, in document order: above the
 * first hunk (when it doesn't start at line 1), between hunks separated by
 * hidden lines, and below the last hunk (always emitted — EOF is unknown).
 * Boundaries whose numbering can't be derived from the rows (e.g. a brand-new
 * or fully-deleted file, or a hunk with no old/new lines on record) are
 * skipped: no affordance beats a wrong one.
 */
export function hunkBoundaries(rows: readonly CtxRow[]): HunkBoundary[] {
  interface H {
    ri: number;
    firstO: number | null;
    firstN: number | null;
    lastO: number | null;
    lastN: number | null;
  }
  const hunks: H[] = [];
  let cur: H | null = null;
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri]!;
    if (r.t === "h") {
      cur = { ri: ri, firstO: null, firstN: null, lastO: null, lastN: null };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // defensive: content before any hunk header
    if (r.o !== null) {
      if (cur.firstO === null) cur.firstO = r.o;
      cur.lastO = r.o;
    }
    if (r.n !== null) {
      if (cur.firstN === null) cur.firstN = r.n;
      cur.lastN = r.n;
    }
  }
  const out: HunkBoundary[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i]!;
    // delta above a hunk = (first old line) − (first new line): rows preceding
    // the first old-numbered row are pure adds (consume no old lines) and rows
    // preceding the first new-numbered row are pure dels, so both firsts sit at
    // the hunk's start coordinates even when the hunk opens with changes.
    if (h.firstO === null || h.firstN === null) continue;
    const delta = h.firstO - h.firstN;
    if (i === 0) {
      if (h.firstN > 1) out.push({ hunkRi: h.ri, gapStart: 1, gapEnd: h.firstN - 1, delta: delta });
    } else {
      const p = hunks[i - 1]!;
      if (p.lastN !== null && h.firstN > p.lastN + 1) {
        out.push({ hunkRi: h.ri, gapStart: p.lastN + 1, gapEnd: h.firstN - 1, delta: delta });
      }
    }
  }
  const last = hunks.length ? hunks[hunks.length - 1]! : null;
  if (last && last.lastN !== null && last.lastO !== null) {
    out.push({
      hunkRi: null,
      gapStart: last.lastN + 1,
      gapEnd: null,
      delta: last.lastO - last.lastN,
    });
  }
  return out;
}

/** The two DOM decisions one expand fetch commits the client to (see applyExpansion). */
export interface ExpansionOutcome {
  /**
   * Which side of the boundary the fetched rows display on. "up" rows backfill
   * the gap's END and belong directly ABOVE the @@ hunk-header row (between the
   * band and the header — GitHub never shows lines from the gap above a hunk
   * below that hunk's header); "down" rows continue the content above the gap,
   * directly above the band.
   */
  side: "up" | "down";
  /** The remaining gap after the fetch (RIGHT-side lines, inclusive). */
  gapStart: number;
  gapEnd: number | null;
  /**
   * The gap is fully shown: remove the band AND (when the boundary has one)
   * the @@ hunk-header row — the hunks have merged visually (GitHub behavior).
   */
  closed: boolean;
}

/**
 * Pure state transition for one expand fetch. `upAnchored` says whether the
 * boundary has a hunk-header row below it to backfill against ("up" without one
 * — the EOF gap — resolves to "down", matching expandRange). `count` is how many
 * lines the fetch actually returned: on an unknown-end (EOF) gap a short
 * response reveals the end of the file and closes the gap.
 */
export function applyExpansion(
  gapStart: number,
  gapEnd: number | null,
  dir: "up" | "down",
  upAnchored: boolean,
  fetchedStart: number,
  fetchedEnd: number,
  count: number,
): ExpansionOutcome {
  if (dir === "up" && upAnchored && gapEnd !== null) {
    const end = fetchedStart - 1;
    return { side: "up", gapStart: gapStart, gapEnd: end, closed: end < gapStart };
  }
  const start = fetchedEnd + 1;
  let end = gapEnd;
  if (gapEnd === null && count < fetchedEnd - fetchedStart + 1) end = start - 1;
  return { side: "down", gapStart: start, gapEnd: end, closed: end !== null && end < start };
}

/**
 * The RIGHT-side line range one expand click fetches (inclusive). A known gap of
 * ≤ step lines is fetched whole (the combined "expand all" affordance). Otherwise
 * "up" takes the step adjacent to the content BELOW the gap (requires a known
 * gapEnd) and "down" the step adjacent to the content ABOVE it; an unknown-end
 * gap (EOF) only expands down, step lines at a time.
 */
export function expandRange(
  gapStart: number,
  gapEnd: number | null,
  dir: "up" | "down",
  step: number,
): { start: number; end: number } {
  if (gapEnd !== null && gapEnd - gapStart + 1 <= step) return { start: gapStart, end: gapEnd };
  if (dir === "up" && gapEnd !== null) {
    return { start: Math.max(gapStart, gapEnd - step + 1), end: gapEnd };
  }
  return {
    start: gapStart,
    end: gapEnd === null ? gapStart + step - 1 : Math.min(gapEnd, gapStart + step - 1),
  };
}
