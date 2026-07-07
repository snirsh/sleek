/**
 * Pure position math for the Wave-4C scrollbar thread markers: the slim strip
 * along the right edge of the diff pane showing where Threads live in the
 * scrollable document. The client measures each thread's anchor-row offset
 * within #center's scroll content and this module maps those offsets to
 * strip fractions — clamped, sorted, and de-stacked (markers closer than the
 * merge threshold collapse into one, keeping the highest-priority kind so an
 * open thread never hides behind a resolved one).
 *
 * SHIPPING MODEL (same as markdown.ts / splitmodel.ts / palette.ts / keynav.ts):
 * this exact function also runs in the browser — client.ts injects
 * fn.toString() into CLIENT_JS, so the body must stay fully self-contained: no
 * imports, no references to module scope, no TS-only runtime syntax.
 * markers.test.ts covers the very function the page runs.
 */

/**
 * What a marker denotes, most to least urgent: "open" — a thread with reviewer
 * activity (reviewer-created, or a finding thread someone replied into);
 * "finding" — a Scaffolder finding nobody has engaged with yet (severity
 * accent comes from the thread card, not from here); "resolved".
 */
export type MarkerKind = "open" | "finding" | "resolved";

export interface MarkerInput {
  /** Document offset (px from the top of the scroll content) of the thread's row. */
  top: number;
  kind: MarkerKind;
}

export interface MarkerStop {
  /** Position along the strip, 0 (top) … 1 (bottom). */
  frac: number;
  kind: MarkerKind;
  /** Index into the INPUT array of the stop's representative item (the
   * highest-priority member of a merged cluster; ties keep the earliest). */
  at: number;
}

/**
 * Map document offsets to strip stops: invalid tops (NaN/∞) drop, the rest
 * clamp into [0, 1] of `scrollHeight`, sort ascending, and clusters closer
 * than `mergeEps` (fraction of the strip; default 0.006) merge into one stop
 * keeping the highest-priority kind (open > finding > resolved; ties keep the
 * first). A non-positive scrollHeight yields no stops.
 */
export function markerStops(
  items: readonly MarkerInput[],
  scrollHeight: number,
  mergeEps?: number,
): MarkerStop[] {
  const eps = typeof mergeEps === "number" ? mergeEps : 0.006;
  if (!(scrollHeight > 0)) return [];
  const prio: Record<string, number> = { open: 3, finding: 2, resolved: 1 };
  const stops: MarkerStop[] = [];
  items.forEach(function (it, i) {
    if (typeof it.top !== "number" || !isFinite(it.top)) return;
    const frac = Math.min(1, Math.max(0, it.top / scrollHeight));
    stops.push({ frac: frac, kind: it.kind, at: i });
  });
  stops.sort(function (a, b) {
    return a.frac - b.frac || (prio[b.kind] || 0) - (prio[a.kind] || 0) || a.at - b.at;
  });
  const out: MarkerStop[] = [];
  for (const s of stops) {
    const last = out.length ? out[out.length - 1] : undefined;
    if (last && s.frac - last.frac < eps) {
      if ((prio[s.kind] || 0) > (prio[last.kind] || 0)) {
        last.kind = s.kind;
        last.at = s.at;
      }
      continue;
    }
    out.push({ frac: s.frac, kind: s.kind, at: s.at });
  }
  return out;
}
