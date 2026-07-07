import { describe, expect, it, vi } from "vitest";
import { createProgressTimeline, formatProgressLine } from "./progress.ts";

describe("createProgressTimeline", () => {
  function fakeNow(...steps: number[]): () => number {
    let t = 0;
    let i = 0;
    return () => {
      const v = t;
      t += steps[Math.min(i++, steps.length - 1)] ?? 0;
      return v;
    };
  }

  it("without onStage behaves identically to createTimeline", async () => {
    const tl = createProgressTimeline({ now: fakeNow(10) });
    await tl.time("gh view", async () => 42);
    expect(tl.entries()).toEqual([{ stage: "gh view", ms: 10 }]);
  });

  it("calls onStage after time() with the completed entry", async () => {
    const calls: string[] = [];
    const tl = createProgressTimeline({
      now: fakeNow(5),
      onStage: (e) => calls.push(`${e.stage}:${e.ms}`),
    });
    await tl.time("gh view", () => "ok");
    expect(calls).toEqual(["gh view:5"]);
  });

  it("calls onStage after add()", () => {
    const calls: string[] = [];
    const tl = createProgressTimeline({
      onStage: (e) => calls.push(e.stage),
    });
    tl.add("render", 50, "HIT");
    tl.add("scaffold", 100);
    expect(calls).toEqual(["render", "scaffold"]);
  });

  it("still records the stage even when fn throws", async () => {
    const calls: string[] = [];
    const tl = createProgressTimeline({
      now: fakeNow(3),
      onStage: (e) => calls.push(e.stage),
    });
    await tl.time("scaffold", () => { throw new Error("boom"); }).catch(() => {});
    expect(calls).toEqual(["scaffold"]);
    expect(tl.entries()[0]!.ms).toBe(3);
  });

  it("passes note through to onStage", () => {
    const notes: (string | undefined)[] = [];
    const tl = createProgressTimeline({ onStage: (e) => notes.push(e.note) });
    tl.add("gh diff", 10, "HIT");
    tl.add("server listen", 5);
    expect(notes).toEqual(["HIT", undefined]);
  });
});

describe("formatProgressLine", () => {
  it("formats a stage with note", () => {
    const line = formatProgressLine({ stage: "gh view", ms: 312.4, note: "HIT" });
    expect(line).toContain("✓");
    expect(line).toContain("gh view");
    expect(line).toContain("312.4ms");
    expect(line).toContain("(HIT)");
  });

  it("formats a stage without note", () => {
    const line = formatProgressLine({ stage: "render", ms: 88.0 });
    expect(line).toContain("✓");
    expect(line).toContain("render");
    expect(line).toContain("88.0ms");
    expect(line).not.toContain("(");
  });
});
