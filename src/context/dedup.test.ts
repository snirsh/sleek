import { describe, expect, it } from "vitest";

import type { ChangedRegion } from "./diff.ts";
import {
  dedupRegions,
  echoFindingsToSiblings,
  extractHunkLines,
  fnv1a32,
  normaliseHunk,
  type EchoableFinding,
} from "./dedup.ts";

// ---------------------------------------------------------------------------
// normaliseHunk
// ---------------------------------------------------------------------------

describe("normaliseHunk", () => {
  it("strips leading/trailing whitespace from every line", () => {
    expect(normaliseHunk("  +foo  \n  +bar  ")).toBe("+foo\n+bar");
  });

  it("collapses internal runs of spaces and tabs to a single space", () => {
    expect(normaliseHunk("+a  b\t\tc")).toBe("+a b c");
  });

  it("preserves the line content when normalised — a one-token difference survives", () => {
    const a = normaliseHunk("+const foo = 1;");
    const b = normaliseHunk("+const bar = 1;");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// fnv1a32
// ---------------------------------------------------------------------------

describe("fnv1a32", () => {
  it("returns a deterministic 8-character hex string", () => {
    const h = fnv1a32("hello");
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32("hello")).toBe(h);
  });

  it("differs for different inputs", () => {
    expect(fnv1a32("foo")).not.toBe(fnv1a32("bar"));
  });

  it("differs for a one-token difference (proving exact hash, not fuzzy)", () => {
    const a = fnv1a32(normaliseHunk("+const foo = 1;"));
    const b = fnv1a32(normaliseHunk("+const bar = 1;"));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIFF_WITH_TWO_IDENTICAL_HUNKS = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -0,0 +1,2 @@",
  "+const x = 1;",
  "+const y = 2;",
  "",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -0,0 +1,2 @@",
  "+const x = 1;",
  "+const y = 2;",
  "",
].join("\n");

const REGION_A: ChangedRegion = {
  file: "src/a.ts",
  side: "RIGHT",
  startLine: 1,
  endLine: 2,
};

const REGION_B: ChangedRegion = {
  file: "src/b.ts",
  side: "RIGHT",
  startLine: 1,
  endLine: 2,
};

const DIFF_WITH_DIFFERENT_HUNKS = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -0,0 +1,1 @@",
  "+const x = 1;",
  "",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -0,0 +1,1 @@",
  "+const y = 2;",
  "",
].join("\n");

const REGION_A_SINGLE: ChangedRegion = {
  file: "src/a.ts",
  side: "RIGHT",
  startLine: 1,
  endLine: 1,
};

const REGION_B_SINGLE: ChangedRegion = {
  file: "src/b.ts",
  side: "RIGHT",
  startLine: 1,
  endLine: 1,
};

// ---------------------------------------------------------------------------
// extractHunkLines
// ---------------------------------------------------------------------------

describe("extractHunkLines", () => {
  it("returns the added lines for a RIGHT region", () => {
    const lines = extractHunkLines(REGION_A, DIFF_WITH_TWO_IDENTICAL_HUNKS);
    expect(lines).toContain("+const x = 1;");
    expect(lines).toContain("+const y = 2;");
  });

  it("falls back to the anchor key when the diff has no matching lines", () => {
    const region: ChangedRegion = {
      file: "src/missing.ts",
      side: "RIGHT",
      startLine: 1,
      endLine: 5,
    };
    const lines = extractHunkLines(region, DIFF_WITH_TWO_IDENTICAL_HUNKS);
    expect(lines).toContain("src/missing.ts");
  });
});

// ---------------------------------------------------------------------------
// dedupRegions — core grouping
// ---------------------------------------------------------------------------

describe("dedupRegions — grouping", () => {
  it("groups two regions with identical hunks: first is representative, second is sibling", () => {
    const result = dedupRegions([REGION_A, REGION_B], DIFF_WITH_TWO_IDENTICAL_HUNKS);

    expect(result.unique).toHaveLength(1);
    expect(result.unique[0]).toBe(REGION_A);

    expect(result.siblings.size).toBe(1);
    const sibKey = "src/b.ts RIGHT 1 2";
    expect(result.siblings.has(sibKey)).toBe(true);
    const sib = result.siblings.get(sibKey)!;
    expect(sib.note).toContain("same edit as");
    expect(sib.note).toContain("2 total occurrence(s)");
    expect(sib.representativeKey).toBe("src/a.ts RIGHT 1 2");
  });

  it("keeps both regions when their hunks differ by one token — exact hash only", () => {
    const result = dedupRegions(
      [REGION_A_SINGLE, REGION_B_SINGLE],
      DIFF_WITH_DIFFERENT_HUNKS,
    );

    // Different tokens (+const x vs +const y) → different hashes → no dedup.
    expect(result.unique).toHaveLength(2);
    expect(result.siblings.size).toBe(0);
  });

  it("returns empty unique + siblings when input is empty", () => {
    const result = dedupRegions([], "");
    expect(result.unique).toHaveLength(0);
    expect(result.siblings.size).toBe(0);
  });

  it("passes through a single region unchanged", () => {
    const result = dedupRegions([REGION_A], DIFF_WITH_TWO_IDENTICAL_HUNKS);
    expect(result.unique).toHaveLength(1);
    expect(result.siblings.size).toBe(0);
    expect(result.groupSize.size).toBe(0);
  });

  it("groups three identical regions — first is representative, other two are siblings", () => {
    const regionC: ChangedRegion = {
      file: "src/c.ts",
      side: "RIGHT",
      startLine: 1,
      endLine: 2,
    };
    const diffThree = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -0,0 +1,2 @@",
      "+const x = 1;",
      "+const y = 2;",
      "",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -0,0 +1,2 @@",
      "+const x = 1;",
      "+const y = 2;",
      "",
      "diff --git a/src/c.ts b/src/c.ts",
      "--- a/src/c.ts",
      "+++ b/src/c.ts",
      "@@ -0,0 +1,2 @@",
      "+const x = 1;",
      "+const y = 2;",
      "",
    ].join("\n");

    const result = dedupRegions([REGION_A, REGION_B, regionC], diffThree);

    expect(result.unique).toHaveLength(1);
    expect(result.unique[0]).toBe(REGION_A);
    expect(result.siblings.size).toBe(2);

    for (const [, sib] of result.siblings) {
      expect(sib.note).toContain("3 total occurrence(s)");
    }
    const size = result.groupSize.values().next().value;
    expect(size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// dedupRegions — one-token-diff stays separate (key requirement)
// ---------------------------------------------------------------------------

describe("dedupRegions — one-token difference stays independent", () => {
  it("does NOT dedup regions that differ by one token in their hunk", () => {
    // Two files: one adds `const foo = 1;`, the other adds `const bar = 1;`
    // They differ by a single token (foo vs bar). They must hash differently.
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -0,0 +1,1 @@",
      "+const foo = 1;",
      "",
      "diff --git a/src/bar.ts b/src/bar.ts",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
      "@@ -0,0 +1,1 @@",
      "+const bar = 1;",
      "",
    ].join("\n");

    const fooRegion: ChangedRegion = {
      file: "src/foo.ts",
      side: "RIGHT",
      startLine: 1,
      endLine: 1,
    };
    const barRegion: ChangedRegion = {
      file: "src/bar.ts",
      side: "RIGHT",
      startLine: 1,
      endLine: 1,
    };

    const result = dedupRegions([fooRegion, barRegion], diff);

    // Both regions must be kept independently.
    expect(result.unique).toHaveLength(2);
    expect(result.siblings.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// echoFindingsToSiblings
// ---------------------------------------------------------------------------

describe("echoFindingsToSiblings", () => {
  it("echoes representative findings onto sibling anchors with a prefix note", () => {
    const result = dedupRegions([REGION_A, REGION_B], DIFF_WITH_TWO_IDENTICAL_HUNKS);

    const repKey = "src/a.ts RIGHT 1 2";
    const finding: EchoableFinding = {
      anchor: {
        file: "src/a.ts",
        side: "RIGHT",
        startLine: 1,
        endLine: 2,
      },
      concern: "maintainability",
      severity: "minor",
      text: "Consider a typed cache.",
    };

    const repFindings = new Map([[repKey, [finding]]]);
    const echoed = echoFindingsToSiblings(repFindings, result.siblings);

    const sibKey = "src/b.ts RIGHT 1 2";
    expect(echoed.has(sibKey)).toBe(true);
    const sibFindings = echoed.get(sibKey)!;
    expect(sibFindings).toHaveLength(1);
    expect(sibFindings[0]!.anchor.file).toBe("src/b.ts");
    expect(sibFindings[0]!.text).toContain("[echo from");
    expect(sibFindings[0]!.text).toContain("Consider a typed cache.");
  });

  it("returns empty map when representative has no findings", () => {
    const result = dedupRegions([REGION_A, REGION_B], DIFF_WITH_TWO_IDENTICAL_HUNKS);
    const echoed = echoFindingsToSiblings(new Map(), result.siblings);
    expect(echoed.size).toBe(0);
  });

  it("returns empty map when there are no siblings", () => {
    const result = dedupRegions([REGION_A_SINGLE], DIFF_WITH_DIFFERENT_HUNKS);
    const repFindings = new Map([
      [
        "src/a.ts RIGHT 1 1",
        [
          {
            anchor: { file: "src/a.ts", side: "RIGHT" as const, startLine: 1, endLine: 1 },
            concern: "correctness",
            severity: "major",
            text: "Bug here.",
          },
        ],
      ],
    ]);
    const echoed = echoFindingsToSiblings(repFindings, result.siblings);
    expect(echoed.size).toBe(0);
  });
});
