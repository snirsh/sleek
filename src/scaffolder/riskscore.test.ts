import { describe, expect, it } from "vitest";

import {
  CHEAP_TIER_THRESHOLD,
  DEFAULT_MAX_SHARD_EFFORT,
  hasCoveringTests,
  isTestOrDocPath,
  scoreFile,
  splitLayerIntoShards,
  touchesExportedSurface,
  type ShardInput,
} from "./riskscore.ts";

// ---------------------------------------------------------------------------
// isTestOrDocPath
// ---------------------------------------------------------------------------

describe("isTestOrDocPath", () => {
  it("classifies test files", () => {
    expect(isTestOrDocPath("src/foo.test.ts")).toBe(true);
    expect(isTestOrDocPath("src/foo.spec.ts")).toBe(true);
    expect(isTestOrDocPath("src/__tests__/foo.ts")).toBe(true);
    expect(isTestOrDocPath("test/foo.ts")).toBe(true);
  });

  it("classifies doc files", () => {
    expect(isTestOrDocPath("README.md")).toBe(true);
    expect(isTestOrDocPath("docs/guide.mdx")).toBe(true);
  });

  it("does not classify prod files", () => {
    expect(isTestOrDocPath("src/server.ts")).toBe(false);
    expect(isTestOrDocPath("src/utils/cache.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// touchesExportedSurface
// ---------------------------------------------------------------------------

describe("touchesExportedSurface", () => {
  it("detects added export lines", () => {
    expect(touchesExportedSurface(["+export function foo() {}"])).toBe(true);
  });

  it("detects removed public lines (pub Rust)", () => {
    expect(touchesExportedSurface(["-pub fn bar() {}"])).toBe(true);
  });

  it("detects module.exports", () => {
    expect(touchesExportedSurface(["+module.exports = { foo }"])).toBe(true);
  });

  it("returns false for internal changes", () => {
    expect(touchesExportedSurface(["+const x = 1;", "+  return x;"])).toBe(false);
  });

  it("ignores context lines (no + or -)", () => {
    expect(touchesExportedSurface(["export function foo() {}"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasCoveringTests
// ---------------------------------------------------------------------------

describe("hasCoveringTests", () => {
  it("returns true when a test file with the same stem is in the changeset", () => {
    expect(hasCoveringTests("src/cache.ts", ["src/cache.test.ts", "src/server.ts"])).toBe(true);
  });

  it("returns false when no test file matches the stem", () => {
    expect(hasCoveringTests("src/server.ts", ["src/cache.test.ts"])).toBe(false);
  });

  it("returns false when the changeset only contains the prod file itself", () => {
    expect(hasCoveringTests("src/cache.ts", ["src/cache.ts"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreFile
// ---------------------------------------------------------------------------

describe("scoreFile", () => {
  it("returns a value in [0, 1]", () => {
    const score = scoreFile({
      churnCount: 5,
      filePath: "src/server.ts",
      diffLines: ["+export function serve() {}"],
      allChangedFiles: ["src/server.ts"],
      neighborCount: 3,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("gives a lower score to a test file than an equivalent prod file", () => {
    const opts = {
      churnCount: 5,
      diffLines: ["+const x = 1;"],
      allChangedFiles: ["src/server.ts", "src/server.test.ts"],
      neighborCount: 2,
    };
    const prodScore = scoreFile({ ...opts, filePath: "src/server.ts" });
    const testScore = scoreFile({ ...opts, filePath: "src/server.test.ts" });
    expect(testScore).toBeLessThan(prodScore);
  });

  it("gives higher score when exported surface is touched", () => {
    const base = {
      churnCount: 3,
      filePath: "src/utils.ts",
      allChangedFiles: ["src/utils.ts"],
      neighborCount: 0,
    };
    const withExport = scoreFile({ ...base, diffLines: ["+export function foo() {}"] });
    const withoutExport = scoreFile({ ...base, diffLines: ["+const x = 1;"] });
    expect(withExport).toBeGreaterThan(withoutExport);
  });

  it("gives lower score when covering tests exist", () => {
    const base = {
      churnCount: 3,
      filePath: "src/utils.ts",
      diffLines: ["+const x = 1;"],
      neighborCount: 0,
    };
    const withTests = scoreFile({ ...base, allChangedFiles: ["src/utils.ts", "src/utils.test.ts"] });
    const withoutTests = scoreFile({ ...base, allChangedFiles: ["src/utils.ts"] });
    expect(withTests).toBeLessThan(withoutTests);
  });

  it("uses injected centrality over neighbor-count proxy", () => {
    const base = {
      churnCount: 0,
      filePath: "src/leaf.ts",
      diffLines: [],
      allChangedFiles: ["src/leaf.ts", "src/leaf.test.ts"],
      neighborCount: 0,
    };
    const lowCentrality = scoreFile({ ...base, centrality: 0 });
    const highCentrality = scoreFile({ ...base, centrality: 1 });
    expect(highCentrality).toBeGreaterThan(lowCentrality);
  });

  it("clamps result at 1 for extreme inputs", () => {
    const score = scoreFile({
      churnCount: 100,
      filePath: "src/core.ts",
      diffLines: ["+export default function core() {}", "+pub fn critical() {}"],
      allChangedFiles: ["src/core.ts"],
      neighborCount: 50,
      centrality: 1,
    });
    expect(score).toBe(1);
  });

  it("CHEAP_TIER_THRESHOLD: a pure test file with no churn scores below it", () => {
    const score = scoreFile({
      churnCount: 0,
      filePath: "src/foo.test.ts",
      diffLines: ["+it('should work', () => {})"],
      allChangedFiles: ["src/foo.ts", "src/foo.test.ts"],
      neighborCount: 0,
      centrality: 0,
    });
    expect(score).toBeLessThan(CHEAP_TIER_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// splitLayerIntoShards
// ---------------------------------------------------------------------------

describe("splitLayerIntoShards", () => {
  it("returns a single shard when total effort is within cap", () => {
    const input: ShardInput = {
      layerId: "L0",
      regions: [
        { regionIndex: 0, file: "src/a.ts", startLine: 1, endLine: 10, riskScore: 0.5 },
        { regionIndex: 1, file: "src/b.ts", startLine: 1, endLine: 5, riskScore: 0.5 },
      ],
    };
    // effort = (10 * 0.5) + (5 * 0.5) = 5 + 2.5 = 7.5, well below default max 200
    const shards = splitLayerIntoShards(input);
    expect(shards).toHaveLength(1);
    expect(shards[0]!.shardIndex).toBe(0);
    expect(shards[0]!.totalShards).toBe(1);
    expect(shards[0]!.regionIndices).toEqual([0, 1]);
  });

  it("splits oversized layer into multiple shards", () => {
    // Create regions totaling well above maxEffort=50
    const regions = Array.from({ length: 10 }, (_, i) => ({
      regionIndex: i,
      file: `src/f${i}.ts`,
      startLine: 1,
      endLine: 20, // 20 LOC each
      riskScore: 1.0, // effort = 20 per region
    }));
    // Total effort = 200. With maxEffort=50, should get 4 shards.
    const input: ShardInput = { layerId: "L0", regions };
    const shards = splitLayerIntoShards(input, 50);

    expect(shards.length).toBeGreaterThan(1);
    // Each shard's effort should be <= 50
    for (const shard of shards) {
      expect(shard.effort).toBeLessThanOrEqual(50);
    }
    // All region indices must be covered exactly once.
    const allIndices = shards.flatMap((s) => s.regionIndices).sort((a, b) => a - b);
    expect(allIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // totalShards is consistent.
    for (const shard of shards) {
      expect(shard.totalShards).toBe(shards.length);
    }
  });

  it("keeps small layers as-is (no splitting above DEFAULT_MAX_SHARD_EFFORT)", () => {
    const input: ShardInput = {
      layerId: "L1",
      regions: [
        { regionIndex: 5, file: "src/small.ts", startLine: 1, endLine: 3, riskScore: 0.1 },
      ],
    };
    // effort = 3 * 0.1 = 0.3, way below default 200
    const shards = splitLayerIntoShards(input, DEFAULT_MAX_SHARD_EFFORT);
    expect(shards).toHaveLength(1);
    expect(shards[0]!.regionIndices).toEqual([5]);
  });

  it("puts an oversized single region into its own shard", () => {
    // One region that by itself exceeds maxEffort
    const input: ShardInput = {
      layerId: "L0",
      regions: [
        { regionIndex: 0, file: "src/big.ts", startLine: 1, endLine: 200, riskScore: 1.0 },
        { regionIndex: 1, file: "src/small.ts", startLine: 1, endLine: 5, riskScore: 1.0 },
      ],
    };
    // maxEffort=50, big region has effort=200, small has 5
    const shards = splitLayerIntoShards(input, 50);
    // Big region forms its own shard (200 > 50 but it's alone); small fits after.
    expect(shards.length).toBeGreaterThanOrEqual(2);
    const bigShard = shards.find((s) => s.regionIndices.includes(0));
    expect(bigShard).toBeDefined();
    expect(bigShard!.regionIndices).toEqual([0]);
  });

  it("returns empty array for empty input", () => {
    const input: ShardInput = { layerId: "L0", regions: [] };
    expect(splitLayerIntoShards(input)).toEqual([]);
  });

  it("shards carry correct layerId", () => {
    const regions = Array.from({ length: 5 }, (_, i) => ({
      regionIndex: i,
      file: `src/f${i}.ts`,
      startLine: 1,
      endLine: 20,
      riskScore: 1.0,
    }));
    const shards = splitLayerIntoShards({ layerId: "myLayer", regions }, 30);
    for (const shard of shards) {
      expect(shard.layerId).toBe("myLayer");
    }
  });
});

// ---------------------------------------------------------------------------
// Size-gate: small PR → single-shard behavior
// ---------------------------------------------------------------------------

describe("splitLayerIntoShards — size gate (small PR unchanged)", () => {
  it("a 2-region layer on a small PR stays as one shard", () => {
    const input: ShardInput = {
      layerId: "small",
      regions: [
        { regionIndex: 0, file: "src/a.ts", startLine: 1, endLine: 5, riskScore: 0.5 },
        { regionIndex: 1, file: "src/b.ts", startLine: 1, endLine: 5, riskScore: 0.5 },
      ],
    };
    // effort = (5*0.5) + (5*0.5) = 5, well within default cap
    const shards = splitLayerIntoShards(input, DEFAULT_MAX_SHARD_EFFORT);
    expect(shards).toHaveLength(1);
    expect(shards[0]!.totalShards).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Model tiering: avgRisk drives tier selection
// ---------------------------------------------------------------------------

describe("LayerShard.avgRisk for model tiering", () => {
  it("avgRisk is below CHEAP_TIER_THRESHOLD for a pure test-file layer", () => {
    // All regions are test files scored very low (< 0.35)
    const input: ShardInput = {
      layerId: "tests",
      regions: [
        { regionIndex: 0, file: "src/a.test.ts", startLine: 1, endLine: 10, riskScore: 0.1 },
        { regionIndex: 1, file: "src/b.test.ts", startLine: 1, endLine: 8, riskScore: 0.1 },
      ],
    };
    const [shard] = splitLayerIntoShards(input);
    expect(shard!.avgRisk).toBeLessThan(CHEAP_TIER_THRESHOLD);
  });

  it("avgRisk is above CHEAP_TIER_THRESHOLD for a high-risk prod layer", () => {
    const input: ShardInput = {
      layerId: "core",
      regions: [
        { regionIndex: 0, file: "src/core.ts", startLine: 1, endLine: 10, riskScore: 0.8 },
        { regionIndex: 1, file: "src/api.ts", startLine: 1, endLine: 8, riskScore: 0.9 },
      ],
    };
    const [shard] = splitLayerIntoShards(input);
    expect(shard!.avgRisk).toBeGreaterThan(CHEAP_TIER_THRESHOLD);
  });
});
