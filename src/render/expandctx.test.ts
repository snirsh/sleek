import { describe, expect, it } from "vitest";

import type { CtxRow } from "./expandctx.ts";
import { applyExpansion, expandRange, hunkBoundaries } from "./expandctx.ts";

const h = (): CtxRow => ({ t: "h", o: null, n: null });
const add = (n: number): CtxRow => ({ t: "a", o: null, n });
const del = (o: number): CtxRow => ({ t: "d", o, n: null });
const ctx = (o: number, n: number): CtxRow => ({ t: "c", o, n });

describe("hunkBoundaries", () => {
  it("emits no top gap when the first hunk starts at line 1, plus the EOF gap", () => {
    // @@ -1,3 +1,3 @@: ctx 1, del 2/add 2, ctx 3
    const rows = [h(), ctx(1, 1), del(2), add(2), ctx(3, 3)];
    expect(hunkBoundaries(rows)).toEqual([
      { hunkRi: null, gapStart: 4, gapEnd: null, delta: 0 },
    ]);
  });

  it("emits a top gap above a first hunk that starts past line 1", () => {
    // @@ -10,2 +12,2 @@ (region above has delta −2)
    const rows = [h(), ctx(10, 12), add(13)];
    const b = hunkBoundaries(rows);
    expect(b[0]).toEqual({ hunkRi: 0, gapStart: 1, gapEnd: 11, delta: -2 });
  });

  it("emits a between gap with the lower hunk's delta and the EOF gap with the last hunk's", () => {
    // hunk A: ctx old1/new1, add new2; hunk B at old20/new19 (delta above B =
    // 20−19 = +1), hidden new lines 3..18; EOF gap delta from B's last lines.
    const rows = [h(), ctx(1, 1), add(2), h(), ctx(20, 19), del(21)];
    expect(hunkBoundaries(rows)).toEqual([
      { hunkRi: 3, gapStart: 3, gapEnd: 18, delta: 1 },
      { hunkRi: null, gapStart: 20, gapEnd: null, delta: 2 },
    ]);
  });

  it("derives delta from hunk-start coordinates even when the hunk opens with changes", () => {
    // Hunk opens with 3 dels then an add then ctx: firstO=5, firstN=5 → delta 0,
    // NOT the post-change offset (ctx 8/6 → +2) that a naive first-both-numbered
    // row would give.
    const rows = [h(), ctx(1, 1), h(), del(5), del(6), del(7), add(5), ctx(8, 6)];
    const between = hunkBoundaries(rows)[0]!;
    expect(between).toEqual({ hunkRi: 2, gapStart: 2, gapEnd: 4, delta: 0 });
  });

  it("emits no between gap for adjacent hunks", () => {
    const rows = [h(), ctx(1, 1), h(), ctx(2, 2)];
    expect(hunkBoundaries(rows)).toEqual([
      { hunkRi: null, gapStart: 3, gapEnd: null, delta: 0 },
    ]);
  });

  it("skips boundaries it cannot derive: brand-new files (no old lines at all)", () => {
    const rows = [h(), add(1), add(2), add(3)];
    expect(hunkBoundaries(rows)).toEqual([]);
  });

  it("skips everything for a fully-deleted file (no new lines at all)", () => {
    const rows = [h(), del(1), del(2)];
    expect(hunkBoundaries(rows)).toEqual([]);
  });

  it("returns [] for empty rows or a binary/metadata-only file", () => {
    expect(hunkBoundaries([])).toEqual([]);
  });
});

describe("expandRange", () => {
  it("fetches a small known gap whole (combined expand-all)", () => {
    expect(expandRange(3, 20, "up", 20)).toEqual({ start: 3, end: 20 });
    expect(expandRange(3, 20, "down", 20)).toEqual({ start: 3, end: 20 });
  });

  it("expands up: the step adjacent to the content below the gap", () => {
    expect(expandRange(1, 100, "up", 20)).toEqual({ start: 81, end: 100 });
  });

  it("expands down: the step adjacent to the content above the gap", () => {
    expect(expandRange(1, 100, "down", 20)).toEqual({ start: 1, end: 20 });
  });

  it("clamps an up expansion at the gap start", () => {
    expect(expandRange(95, 100, "up", 20)).toEqual({ start: 95, end: 100 });
  });

  it("expands down into an unknown-end (EOF) gap one step at a time", () => {
    expect(expandRange(41, null, "down", 20)).toEqual({ start: 41, end: 60 });
  });

  it("treats an unknown-end gap as down even when asked up (no anchor below)", () => {
    expect(expandRange(41, null, "up", 20)).toEqual({ start: 41, end: 60 });
  });
});

describe("applyExpansion (insertion side + header removal)", () => {
  it("up batches display on the up side — above the @@ header, never below it", () => {
    // Gap 1..98 above a hunk starting at 99; fetch 79..98 backfills the gap end.
    expect(applyExpansion(1, 98, "up", true, 79, 98, 20)).toEqual({
      side: "up",
      gapStart: 1,
      gapEnd: 78,
      closed: false, // 78 lines still hidden: the band AND the header stay
    });
  });

  it("closing the gap from above removes the header (single hidden line, expand-all)", () => {
    // The user-screenshot shape: prev hunk ends at 97, hunk starts at 99 → the
    // one hidden line 98 goes ABOVE the header, and the closed gap removes the
    // @@ header row so 97/98/99 read contiguously.
    expect(applyExpansion(98, 98, "up", true, 98, 98, 1)).toEqual({
      side: "up",
      gapStart: 98,
      gapEnd: 97,
      closed: true,
    });
  });

  it("down batches continue the content above the gap and keep the header while lines remain", () => {
    expect(applyExpansion(3, 60, "down", true, 3, 22, 20)).toEqual({
      side: "down",
      gapStart: 23,
      gapEnd: 60,
      closed: false,
    });
  });

  it("closing the gap from below also removes the header", () => {
    expect(applyExpansion(41, 60, "down", true, 41, 60, 20)).toEqual({
      side: "down",
      gapStart: 61,
      gapEnd: 60,
      closed: true,
    });
  });

  it("EOF gap: a full response keeps expanding, a short response reveals EOF and closes", () => {
    expect(applyExpansion(41, null, "down", false, 41, 60, 20)).toEqual({
      side: "down",
      gapStart: 61,
      gapEnd: null,
      closed: false,
    });
    expect(applyExpansion(61, null, "down", false, 61, 80, 7)).toEqual({
      side: "down",
      gapStart: 81,
      gapEnd: 80,
      closed: true,
    });
  });

  it("an up request without an up anchor resolves to the down side (EOF gap has no header)", () => {
    expect(applyExpansion(41, null, "up", false, 41, 60, 20).side).toBe("down");
  });
});
