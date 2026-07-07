import { describe, expect, it } from "vitest";

import { markerStops } from "./markers.ts";
import type { MarkerInput } from "./markers.ts";

describe("markerStops", () => {
  it("maps offsets to fractions of the scroll height, sorted ascending", () => {
    const items: MarkerInput[] = [
      { top: 750, kind: "open" },
      { top: 250, kind: "finding" },
      { top: 500, kind: "resolved" },
    ];
    expect(markerStops(items, 1000)).toEqual([
      { frac: 0.25, kind: "finding", at: 1 },
      { frac: 0.5, kind: "resolved", at: 2 },
      { frac: 0.75, kind: "open", at: 0 },
    ]);
  });

  it("clamps offsets into [0, 1]", () => {
    const stops = markerStops(
      [
        { top: -40, kind: "open" },
        { top: 2000, kind: "finding" },
      ],
      1000,
    );
    expect(stops.map((s) => s.frac)).toEqual([0, 1]);
  });

  it("drops non-finite offsets and returns [] for a non-positive scroll height", () => {
    expect(markerStops([{ top: Number.NaN, kind: "open" }], 1000)).toEqual([]);
    expect(markerStops([{ top: Number.POSITIVE_INFINITY, kind: "open" }], 1000)).toEqual([]);
    expect(markerStops([{ top: 10, kind: "open" }], 0)).toEqual([]);
    expect(markerStops([{ top: 10, kind: "open" }], -5)).toEqual([]);
  });

  it("merges markers closer than the threshold, keeping the highest-priority kind", () => {
    // 3px apart on a 1000px document = 0.003 < the 0.006 default threshold.
    const stops = markerStops(
      [
        { top: 500, kind: "resolved" },
        { top: 503, kind: "open" },
        { top: 501, kind: "finding" },
      ],
      1000,
    );
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: "open", at: 1 });
  });

  it("keeps the earliest input on a same-kind, same-position stack", () => {
    const stops = markerStops(
      [
        { top: 100, kind: "finding" },
        { top: 100, kind: "finding" },
      ],
      1000,
    );
    expect(stops).toEqual([{ frac: 0.1, kind: "finding", at: 0 }]);
  });

  it("does not merge markers farther apart than the threshold", () => {
    const stops = markerStops(
      [
        { top: 500, kind: "resolved" },
        { top: 510, kind: "open" }, // 0.01 apart > 0.006
      ],
      1000,
    );
    expect(stops).toHaveLength(2);
  });

  it("honors an explicit merge threshold", () => {
    const items: MarkerInput[] = [
      { top: 500, kind: "resolved" },
      { top: 510, kind: "open" },
    ];
    expect(markerStops(items, 1000, 0.02)).toHaveLength(1);
    expect(markerStops(items, 1000, 0.001)).toHaveLength(2);
  });

  it("returns [] for no items", () => {
    expect(markerStops([], 1000)).toEqual([]);
  });
});
