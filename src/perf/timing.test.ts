import { describe, expect, it } from "vitest";

import { createTimeline, formatStageTable } from "./timing.ts";

describe("createTimeline", () => {
  /** A fake clock advancing a scripted amount per call. */
  function fakeNow(...steps: number[]): () => number {
    let t = 0;
    let i = 0;
    return () => {
      const v = t;
      t += steps[Math.min(i++, steps.length - 1)] ?? 0;
      return v;
    };
  }

  it("times async stages in completion order and returns fn's value", async () => {
    const timeline = createTimeline(fakeNow(5));
    const value = await timeline.time("gh view", async () => 42);
    expect(value).toBe(42);
    expect(timeline.entries()).toEqual([{ stage: "gh view", ms: 5 }]);
  });

  it("records the stage (and rethrows) when fn throws", async () => {
    const timeline = createTimeline(fakeNow(3));
    await expect(
      timeline.time("scaffold", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(timeline.entries()).toEqual([{ stage: "scaffold", ms: 3 }]);
  });

  it("add() records externally measured stages with notes", () => {
    const timeline = createTimeline(fakeNow(1));
    timeline.add("gh diff", 123.4, "HIT");
    timeline.add("render", 8);
    expect(timeline.entries()).toEqual([
      { stage: "gh diff", ms: 123.4, note: "HIT" },
      { stage: "render", ms: 8 },
    ]);
  });

  it("entries() returns copies (mutating them does not affect the table)", () => {
    const timeline = createTimeline(fakeNow(1));
    timeline.add("render", 1);
    timeline.entries()[0]!.ms = 999;
    expect(timeline.entries()[0]!.ms).toBe(1);
  });
});

describe("formatStageTable", () => {
  it("aligns columns and appends a total row", () => {
    const table = formatStageTable([
      { stage: "gh view", ms: 512.34, note: "MISS" },
      { stage: "render", ms: 8, note: "HIT" },
      { stage: "server listen", ms: 1200.5 },
    ]);
    expect(table).toBe(
      [
        "  stage              ms",
        "  gh view         512.3  MISS",
        "  render            8.0  HIT",
        "  server listen  1200.5",
        "  total          1720.8",
      ].join("\n"),
    );
  });

  it("handles an empty timeline (total 0.0)", () => {
    expect(formatStageTable([])).toBe(["  stage   ms", "  total  0.0"].join("\n"));
  });
});
