/**
 * B4 — File-level risk scoring from locally-available cheap signals.
 *
 * Produces a normalized [0, 1] risk score for a file in the changeset. The score
 * drives two downstream decisions:
 *
 *   1. Balanced shards: effort = LOC * risk; shards are capped at MAX_SHARD_EFFORT
 *      so no single detail call is the long pole.
 *   2. Model tiering: risk < CHEAP_TIER_THRESHOLD routes the shard to a cheaper
 *      model (gated by SLEEK_SCAFFOLDER_TIERING=1).
 *
 * Signals (all locally available, no network):
 *   - churn: recent git commit count on the file (higher = more churn = higher risk)
 *   - pathClass: runtime/prod path > test/doc path
 *   - touchesExportedSurface: heuristic on the diff lines
 *   - hasCoveringTests: whether the changeset also modifies a test file for this file
 *   - centrality: optional injected graph centrality [0,1]. When absent, a neighbor-
 *     count proxy from RegionContext.neighbors is used so B3 can feed the real graph
 *     later without reshaping this module.
 *
 * Weights are conservative and symmetric: each signal contributes an additive
 * fraction. The sum is clamped to [0, 1].
 */

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

/** Returns true when a path looks like a test or documentation file. */
export function isTestOrDocPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("__tests__") ||
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.startsWith("test/") ||
    lower.startsWith("tests/") ||
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    lower.endsWith(".txt") ||
    lower.includes("/docs/") ||
    lower.startsWith("docs/")
  );
}

// ---------------------------------------------------------------------------
// Exported surface heuristic
// ---------------------------------------------------------------------------

/**
 * Returns true when the diff lines for this file suggest that an exported or
 * public symbol is being added/changed. Heuristic: looks for `export ` or
 * `pub ` (Rust) at the start of an added/removed line.
 */
export function touchesExportedSurface(diffLines: string[]): boolean {
  for (const line of diffLines) {
    if (line.startsWith("+") || line.startsWith("-")) {
      const body = line.slice(1).trimStart();
      if (
        body.startsWith("export ") ||
        body.startsWith("pub ") ||
        body.startsWith("public ") ||
        body.startsWith("module.exports")
      ) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Covering-tests detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the changeset includes a test file that is a plausible
 * cover for `filePath`. Strategy: test files often share the stem of the
 * production file (e.g. `foo.ts` → `foo.test.ts`, `foo.spec.ts`).
 */
export function hasCoveringTests(filePath: string, allChangedFiles: string[]): boolean {
  // Strip extension and path prefix to get the stem.
  const base = filePath.split("/").pop() ?? filePath;
  const stem = base.replace(/\.[^.]+$/, "");
  if (!stem) return false;

  return allChangedFiles.some((f) => {
    if (f === filePath) return false;
    if (!isTestOrDocPath(f)) return false;
    return f.includes(stem);
  });
}

// ---------------------------------------------------------------------------
// Score options
// ---------------------------------------------------------------------------

export interface ScoreFileOptions {
  /**
   * Number of commits that touched this file in recent history (from
   * RegionContext.history.length or a real `git log --oneline -- <file>` count).
   * Higher = more churn = higher risk.
   */
  churnCount: number;
  /** File path relative to the repo root. */
  filePath: string;
  /**
   * Diff lines for this file (the +/- lines from the unified diff). Used for
   * the exported-surface heuristic.
   */
  diffLines: string[];
  /**
   * All files changed in the PR. Used to detect covering tests.
   */
  allChangedFiles: string[];
  /**
   * Optional graph centrality in [0, 1]. When undefined, a neighbor-count proxy
   * is used: `Math.min(neighborCount / 10, 1)`.
   *
   * B3 will inject the real pre-computed centrality here once the nx/turbo graph
   * is available; the defaulting logic below makes B4 shippable before B3.
   */
  centrality?: number;
  /**
   * Neighbor count from RegionContext.neighbors. Used as centrality proxy when
   * `centrality` is not supplied.
   */
  neighborCount?: number;
}

// ---------------------------------------------------------------------------
// Weights — additive, clamped to [0, 1]
// ---------------------------------------------------------------------------

/** Churn contribution: saturates at 20 commits → full weight of 0.25. */
const CHURN_WEIGHT = 0.25;
const CHURN_SATURATION = 20;

/** Path class contribution: prod path adds 0.30; test/doc path adds 0. */
const PATH_CLASS_WEIGHT = 0.30;

/** Exported surface contribution. */
const EXPORTED_SURFACE_WEIGHT = 0.20;

/** No covering tests contribution (risk goes UP when tests are absent). */
const NO_COVERING_TESTS_WEIGHT = 0.15;

/** Centrality contribution. */
const CENTRALITY_WEIGHT = 0.10;

// ---------------------------------------------------------------------------
// scoreFile
// ---------------------------------------------------------------------------

/**
 * Compute a normalized [0, 1] risk score for a file in the changeset.
 *
 * Each signal contributes an additive fraction; the sum is clamped to [0, 1].
 * 0 = lowest risk (test file, no churn, no exported surface, has tests, low centrality).
 * 1 = highest risk (prod file, high churn, exported surface, no tests, high centrality).
 */
export function scoreFile(opts: ScoreFileOptions): number {
  // Churn: scale linearly to saturation.
  const churn = Math.min(opts.churnCount / CHURN_SATURATION, 1) * CHURN_WEIGHT;

  // Path class: test/doc = 0, prod = full weight.
  const pathClass = isTestOrDocPath(opts.filePath) ? 0 : PATH_CLASS_WEIGHT;

  // Exported surface: diff touches a public/exported symbol.
  const exportedSurface = touchesExportedSurface(opts.diffLines) ? EXPORTED_SURFACE_WEIGHT : 0;

  // Covering tests: no test = higher risk.
  const noTests = hasCoveringTests(opts.filePath, opts.allChangedFiles) ? 0 : NO_COVERING_TESTS_WEIGHT;

  // Centrality: use injected value or neighbor-count proxy.
  const centralityValue =
    opts.centrality !== undefined
      ? opts.centrality
      : Math.min((opts.neighborCount ?? 0) / 10, 1);
  const centrality = centralityValue * CENTRALITY_WEIGHT;

  const raw = churn + pathClass + exportedSurface + noTests + centrality;
  return Math.min(raw, 1);
}

// ---------------------------------------------------------------------------
// Effort estimation
// ---------------------------------------------------------------------------

/**
 * Estimate effort for a layer: sum of (regionLOC * riskScore) across its regions.
 * LOC = endLine - startLine + 1. Risk is from scoreFile on the layer's files.
 */
export interface RegionEffortInput {
  file: string;
  startLine: number;
  endLine: number;
  /** Pre-computed risk score for the file (0..1). */
  riskScore: number;
}

export function estimateLayerEffort(regions: RegionEffortInput[]): number {
  return regions.reduce((sum, r) => {
    const loc = r.endLine - r.startLine + 1;
    return sum + loc * r.riskScore;
  }, 0);
}

// ---------------------------------------------------------------------------
// Shard splitting
// ---------------------------------------------------------------------------

/**
 * Maximum effort per shard before splitting. Tune against empirical timing.
 * Default: 200 (roughly 200 LOC at risk=1, or 400 LOC at risk=0.5).
 */
export const DEFAULT_MAX_SHARD_EFFORT = 200;

/** The low-risk threshold for model tiering. Shards below this use the cheap model. */
export const CHEAP_TIER_THRESHOLD = 0.35;

/** A shard: a sub-slice of a layer's regions, with effort metadata. */
export interface LayerShard {
  /** Original layer id. */
  layerId: string;
  /** Shard index within the layer (0-based). */
  shardIndex: number;
  /** Total shards for this layer. */
  totalShards: number;
  /** Region indices (into the full ContextInput.regions array) this shard owns. */
  regionIndices: number[];
  /** Estimated effort for this shard. */
  effort: number;
  /** Average risk score of regions in this shard. */
  avgRisk: number;
}

export interface ShardInput {
  layerId: string;
  /** Pairs of (region index in contextInput.regions, risk score for that region's file). */
  regions: Array<{ regionIndex: number; file: string; startLine: number; endLine: number; riskScore: number }>;
}

/**
 * Split a layer's regions into balanced shards, each capped at maxEffort.
 *
 * Regions are assigned greedily: fill the current shard until it would exceed
 * maxEffort, then start a new one. Regions that individually exceed maxEffort
 * (e.g. a single 1000-LOC file) form their own shard.
 *
 * When the total effort is <= maxEffort the layer is returned as a single shard
 * (no splitting). This preserves current single-pass behavior for small layers.
 */
export function splitLayerIntoShards(
  input: ShardInput,
  maxEffort: number = DEFAULT_MAX_SHARD_EFFORT,
): LayerShard[] {
  if (input.regions.length === 0) {
    return [];
  }

  // Fast path: if total effort is within the cap, don't split.
  const totalEffort = input.regions.reduce((s, r) => {
    const loc = r.endLine - r.startLine + 1;
    return s + loc * r.riskScore;
  }, 0);

  if (totalEffort <= maxEffort) {
    const avgRisk =
      input.regions.reduce((s, r) => s + r.riskScore, 0) / input.regions.length;
    return [
      {
        layerId: input.layerId,
        shardIndex: 0,
        totalShards: 1,
        regionIndices: input.regions.map((r) => r.regionIndex),
        effort: totalEffort,
        avgRisk,
      },
    ];
  }

  // Greedy bin-packing.
  const shardRegions: Array<typeof input.regions> = [];
  let current: typeof input.regions = [];
  let currentEffort = 0;

  for (const r of input.regions) {
    const loc = r.endLine - r.startLine + 1;
    const regionEffort = loc * r.riskScore;
    if (current.length > 0 && currentEffort + regionEffort > maxEffort) {
      shardRegions.push(current);
      current = [r];
      currentEffort = regionEffort;
    } else {
      current.push(r);
      currentEffort += regionEffort;
    }
  }
  if (current.length > 0) shardRegions.push(current);

  const totalShards = shardRegions.length;
  return shardRegions.map((regs, i) => {
    const effort = regs.reduce((s, r) => {
      const loc = r.endLine - r.startLine + 1;
      return s + loc * r.riskScore;
    }, 0);
    const avgRisk = regs.reduce((s, r) => s + r.riskScore, 0) / regs.length;
    return {
      layerId: input.layerId,
      shardIndex: i,
      totalShards,
      regionIndices: regs.map((r) => r.regionIndex),
      effort,
      avgRisk,
    };
  });
}
