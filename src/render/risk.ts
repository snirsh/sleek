/**
 * Highest-risk Layer selection for the initial file-card collapse state: on first
 * load (no persisted per-file viewed/collapse state) only the highest-risk Layer's
 * files start expanded; every other card starts collapsed.
 *
 * Highest-risk = the Layer whose WORST Finding severity is highest (critical >
 * major > minor > info); ties break to the lowest reading order (the input is the
 * reading-ordered layer list, so "first wins"); Layers with no Findings never win.
 * html.ts computes this at render time and embeds the index in the page DATA.
 */

/**
 * Index (into the reading-ordered input) of the highest-risk Layer, or -1 when
 * no Layer has any Finding (then the default collapse state stays as-is).
 */
export function highestRiskLayer(
  layers: readonly { findings: readonly { severity: string }[] }[],
): number {
  const rank: Record<string, number> = { critical: 0, major: 1, minor: 2, info: 3 };
  let best = -1;
  let bestRank = Number.POSITIVE_INFINITY;
  layers.forEach((l, li) => {
    for (const f of l.findings) {
      const r = rank[f.severity];
      if (r !== undefined && r < bestRank) {
        bestRank = r;
        best = li;
      }
    }
  });
  return best;
}
