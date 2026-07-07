/**
 * M2 Context Builder — entry point.
 *
 * Given a ChangeSet (from M1 Ingest) and the path to the Reviewer's local clone, this
 * produces the RAW, per-changed-region context that the Scaffolder (M3) later distills
 * into per-Layer Context Bundles. It gathers, for every changed region of the diff:
 *   - git history of those exact lines (`regionHistory`)
 *   - graph neighbors around those lines (`findNeighbors`)
 *
 * All git/tree-sitter work happens inside a detached worktree at the PR head SHA
 * (ADR-0001) so the Reviewer's checkout and branch are never touched.
 *
 * Output vs. M3: `ContextInput` is the *raw, pre-distillation* output of M2 — it may be
 * larger than any token budget and carries every region's neighbors + history keyed by
 * Anchor. M3 consumes a ContextInput and DISTILLS it — clustering regions into Layers
 * and compressing each Layer's slice into a budgeted ~8K-token `ContextBundle`
 * (summary + bounded neighbors + bounded history). `ContextInput` and `ContextBundle`
 * are deliberately distinct: this module never produces a ContextBundle.
 */

import type { Anchor, ChangeSet, HistoryEntry, Neighbor } from "../domain/scaffold.ts";
import { mapWithConcurrency } from "../perf/concurrency.ts";
import { dedupRegions, type DedupResult } from "./dedup.ts";
import { parseChangedRegions } from "./diff.ts";
import { buildGraph, type GraphResult, type GraphRunner } from "./graph.ts";

export type { GraphResult } from "./graph.ts";
import { regionHistory, DEFAULT_HISTORY_LIMIT } from "./history.ts";
import { findNeighbors, DEFAULT_NEIGHBOR_CAP } from "./neighbors.ts";
import { withWorktree } from "./worktree.ts";

/**
 * Default fan-out for per-region history/neighbor extraction (Wave 5). Each region
 * costs one git subprocess (`git log -L`), so the cap bounds process pressure while
 * still overlapping the subprocess waits.
 */
export const DEFAULT_CONTEXT_CONCURRENCY = 8;

/**
 * Raw context for one changed region, keyed by its Anchor so M3 can map it onto the
 * Layers it forms. `neighbors` and `history` are bounded (see limits below) but NOT yet
 * budget-distilled — that is M3's job.
 */
export interface RegionContext {
  /** The changed region in Anchor coordinates (ADR-0004). */
  anchor: Anchor;
  /** Graph neighbors around the region (references + signatures + one-liners). */
  neighbors: Neighbor[];
  /** Recent commits that touched these exact lines. */
  history: HistoryEntry[];
}

/**
 * M2's output: the raw, pre-distillation context for a whole ChangeSet. M3 distills
 * this into the Review Scaffold's per-Layer `ContextBundle`s within the per-Layer token
 * budget (see module doc). Distinct from `ContextBundle` by design.
 */
export interface ContextInput {
  /** Echoed PR head SHA the worktree was built at (staleness key for M4). */
  headSha: string;
  /**
   * One entry per UNIQUE (de-duplicated) changed region of the diff, in diff order.
   * Sibling (duplicate) regions are excluded here; their metadata lives in `dedup`.
   */
  regions: RegionContext[];
  /**
   * B2 dedup metadata. `siblings` maps each excluded duplicate region's anchor key to
   * its SiblingRegion descriptor (note, representative key, hash). `groupSize` maps each
   * hash to the full group size (representative + siblings). Populated only when two or
   * more hunks hash identically; otherwise both maps are empty (no allocations).
   *
   * Optional for backward-compat with cached JSON that predates B2: when absent, callers
   * should treat it as { siblings: new Map(), groupSize: new Map() }.
   */
  dedup?: Pick<DedupResult, "siblings" | "groupSize">;
  /**
   * B3 graph-aware grouping result. Computed by buildContext (from nx.json/turbo.json in
   * the head-SHA worktree). Optional for backward-compat with serialized ContextInput that
   * predates B3; when absent or null, all graph-dependent behavior is bypassed
   * (byte-identical prompt, neighbor-count centrality proxy).
   */
  graph?: GraphResult | null;
}

export interface BuildContextOptions {
  historyLimit?: number;
  neighborCap?: number;
  /** Max regions extracted in parallel (one git subprocess each). Default 8. */
  concurrency?: number;
  /** B3: injectable graph command runner (nx/turbo). Tests pass a fixture runner; the
   * default spawns the real command. Fail-soft — a null graph disables B3 behavior. */
  graphRunner?: GraphRunner;
}

/**
 * Build the raw ContextInput for a ChangeSet against the Reviewer's local clone.
 *
 * LEFT-side (deleted) regions get history but no neighbors: their lines no longer exist
 * at the head SHA the worktree is checked out at, so there is nothing to parse for graph
 * neighbors. RIGHT-side (added) regions get both.
 *
 * Regions are extracted in parallel (bounded by `options.concurrency`) but
 * `regions` always comes back in diff order — mapWithConcurrency preserves input
 * order, keeping the output byte-stable for cache keys and scaffold determinism.
 */
export async function buildContext(
  changeSet: ChangeSet,
  repoPath: string,
  options: BuildContextOptions = {},
): Promise<ContextInput> {
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const neighborCap = options.neighborCap ?? DEFAULT_NEIGHBOR_CAP;
  const concurrency = options.concurrency ?? DEFAULT_CONTEXT_CONCURRENCY;

  const allChangedRegions = parseChangedRegions(changeSet.unifiedDiff);
  // B2: deduplicate hunks before context building so siblings don't consume quota.
  const dedupResult = dedupRegions(allChangedRegions, changeSet.unifiedDiff);
  const changedRegions = dedupResult.unique;
  const headSha = changeSet.pr.headSha;

  // B3: map each unique region to its file so buildGraph can build clusters keyed by
  // region index (indexes into `regions`, which preserves changedRegions order).
  const regionFileMap = changedRegions.map((r, i) => ({ file: r.file, regionIndex: i }));
  const changedFiles = Array.from(new Set(changedRegions.map((r) => r.file)));

  const { regions, graph } = await withWorktree(repoPath, headSha, async (worktreePath) => {
    const regions = await mapWithConcurrency(
      changedRegions,
      concurrency,
      async (region): Promise<RegionContext> => {
        const anchor: Anchor = {
          file: region.file,
          side: region.side,
          startLine: region.startLine,
          endLine: region.endLine,
        };

        const history = await regionHistory(
          worktreePath,
          region.file,
          region.startLine,
          region.endLine,
          historyLimit,
        );

        const neighbors =
          region.side === "RIGHT"
            ? await findNeighbors(
                worktreePath,
                region.file,
                region.startLine,
                region.endLine,
                neighborCap,
              )
            : [];

        return { anchor, neighbors, history };
      },
    );

    // B3: compute the dependency graph inside the same worktree (nx.json / turbo.json
    // live at the head SHA checked out here). Fail-soft: returns null when no tooling
    // is present or the command fails, and all graph-dependent behavior is bypassed.
    const graph = await buildGraph(
      worktreePath,
      changedFiles,
      regionFileMap,
      options.graphRunner,
    );

    return { regions, graph };
  });

  return {
    headSha,
    regions,
    dedup: { siblings: dedupResult.siblings, groupSize: dedupResult.groupSize },
    graph,
  };
}
