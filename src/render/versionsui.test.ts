import { describe, expect, it } from "vitest";

import type { ScaffoldDiff } from "../domain/scaffolddiff.ts";
import {
  diffCountsLabel,
  diffSections,
  shortSha,
  versionDateLabel,
  versionOptionLabel,
  versionsBannerLabel,
} from "./versionsui.ts";

/** An empty diff; tests spread in the parts they exercise. */
function emptyDiff(): ScaffoldDiff {
  return {
    counts: {
      layersAdded: 0,
      layersRemoved: 0,
      layersChanged: 0,
      findingsAdded: 0,
      findingsRemoved: 0,
      findingsMoved: 0,
      filesEntering: 0,
      filesLeaving: 0,
    },
    layers: { added: [], removed: [], changed: [] },
    findings: { added: [], removed: [], moved: [] },
    files: { entering: [], leaving: [] },
  };
}

describe("shortSha", () => {
  it("truncates to 12 characters", () => {
    expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe("0123456789ab");
  });

  it("leaves shorter values alone", () => {
    expect(shortSha("abc")).toBe("abc");
  });
});

describe("versionDateLabel", () => {
  it("formats an ISO-8601 UTC timestamp as date + minutes UTC", () => {
    expect(versionDateLabel("2026-07-02T14:05:33.123Z")).toBe("2026-07-02 14:05 UTC");
  });

  it("passes malformed input through unchanged", () => {
    expect(versionDateLabel("yesterday")).toBe("yesterday");
  });
});

describe("versionOptionLabel", () => {
  it("combines the short sha and the date label", () => {
    expect(
      versionOptionLabel({
        headSha: "0123456789abcdef0123456789abcdef01234567",
        createdAt: "2026-07-02T14:05:33.123Z",
      }),
    ).toBe("0123456789ab · 2026-07-02 14:05 UTC");
  });
});

describe("versionsBannerLabel", () => {
  it("pluralizes the previous-version count", () => {
    expect(versionsBannerLabel(1)).toBe("Scaffold updated · 1 previous version");
    expect(versionsBannerLabel(3)).toBe("Scaffold updated · 3 previous versions");
  });
});

describe("diffCountsLabel", () => {
  it("reads as a calm sentence when nothing changed", () => {
    expect(diffCountsLabel(emptyDiff().counts)).toBe(
      "No structural changes between these scaffold versions.",
    );
  });

  it("lists only the non-zero counts, pluralized", () => {
    const counts = {
      ...emptyDiff().counts,
      findingsAdded: 2,
      layersChanged: 1,
      filesLeaving: 1,
    };
    expect(diffCountsLabel(counts)).toBe(
      "1 layer changed · 2 findings added · 1 file leaving",
    );
  });
});

describe("diffSections", () => {
  it("returns no sections for an empty diff", () => {
    expect(diffSections(emptyDiff())).toEqual([]);
  });

  it("builds titled sections with counts, skipping empty ones", () => {
    const diff: ScaffoldDiff = {
      ...emptyDiff(),
      layers: {
        added: [{ id: "retry-core", files: ["src/retry.ts"], findingCount: 2 }],
        removed: [],
        changed: [
          { oldId: "old-name", newId: "new-name", renamed: true, reanchored: true },
          { oldId: "core", newId: "core", renamed: false, reanchored: true },
        ],
      },
      findings: {
        added: [
          {
            layerId: "retry-core",
            concern: "correctness",
            severity: "major",
            text: "First line of the worry.\nSecond line never shows.",
            anchor: { file: "src/retry.ts", side: "RIGHT", startLine: 4, endLine: 9 },
          },
        ],
        removed: [],
        moved: [
          {
            layerId: "retry-core",
            concern: "tests",
            severity: "minor",
            text: "Cover the zero case.",
            from: { file: "src/retry.ts", side: "RIGHT", startLine: 4, endLine: 4 },
            to: { file: "src/retry.ts", side: "RIGHT", startLine: 40, endLine: 40 },
          },
        ],
      },
      files: { entering: ["src/new.ts"], leaving: [] },
    };
    expect(diffSections(diff)).toEqual([
      {
        title: "Layers added (1)",
        items: ["retry-core · src/retry.ts · 2 findings"],
      },
      {
        title: "Layers changed (2)",
        items: [
          "old-name → new-name · renamed, re-anchored",
          "core · re-anchored",
        ],
      },
      {
        title: "Findings added (1)",
        items: [
          "[major] correctness · src/retry.ts:4–9 (new) — First line of the worry.",
        ],
      },
      {
        title: "Findings moved (1)",
        items: [
          "[minor] tests · src/retry.ts:4 (new) → src/retry.ts:40 (new) — Cover the zero case.",
        ],
      },
      {
        title: "Files entering the changeset (1)",
        items: ["src/new.ts"],
      },
    ]);
  });

  it("truncates long finding text to ~80 chars on the first line", () => {
    const long = "x".repeat(120);
    const diff: ScaffoldDiff = {
      ...emptyDiff(),
      findings: {
        added: [
          {
            layerId: "l",
            concern: "performance",
            severity: "info",
            text: long,
            anchor: { file: "a.ts", side: "LEFT", startLine: 1, endLine: 1 },
          },
        ],
        removed: [],
        moved: [],
      },
    };
    const item = diffSections(diff)[0]!.items[0]!;
    expect(item).toContain("a.ts:1 (old)");
    expect(item.endsWith("…")).toBe(true);
    expect(item.length).toBeLessThan(120);
  });

  it("ships to the client backtick-free (fn.toString contract)", () => {
    // Same posture as the other injected helpers: the serialized source must
    // contain no backticks and no ${ (client.ts embeds it inside a template).
    for (const fn of [shortSha, versionDateLabel, versionOptionLabel, versionsBannerLabel, diffCountsLabel, diffSections]) {
      const src = fn.toString();
      expect(src.includes("`"), fn.name + " has a backtick").toBe(false);
      expect(src.includes("${"), fn.name + " has ${").toBe(false);
    }
  });
});
