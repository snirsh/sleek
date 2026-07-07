import { describe, expect, it } from "vitest";

import { buildSplitPairs } from "./splitmodel.ts";

type T = "a" | "d" | "c" | "h";
const rows = (...ts: T[]) => ts.map((t) => ({ t }));

describe("buildSplitPairs", () => {
  it("hunk and ctx rows pass through one-to-one", () => {
    expect(buildSplitPairs(rows("h", "c", "c"))).toEqual([
      { k: "hunk", ri: 0 },
      { k: "ctx", ri: 1 },
      { k: "ctx", ri: 2 },
    ]);
  });

  it("pairs del i with add i for equal runs (the intraline rule)", () => {
    expect(buildSplitPairs(rows("d", "d", "a", "a"))).toEqual([
      { k: "pair", d: 0, a: 2 },
      { k: "pair", d: 1, a: 3 },
    ]);
  });

  it("leftover dels of a longer del-run get an empty right side", () => {
    expect(buildSplitPairs(rows("d", "d", "d", "a"))).toEqual([
      { k: "pair", d: 0, a: 3 },
      { k: "pair", d: 1, a: null },
      { k: "pair", d: 2, a: null },
    ]);
  });

  it("leftover adds of a longer add-run get an empty left side", () => {
    expect(buildSplitPairs(rows("d", "a", "a"))).toEqual([
      { k: "pair", d: 0, a: 1 },
      { k: "pair", d: null, a: 2 },
    ]);
  });

  it("adds with no preceding del-run are right-side-only pairs", () => {
    expect(buildSplitPairs(rows("c", "a", "a", "c"))).toEqual([
      { k: "ctx", ri: 0 },
      { k: "pair", d: null, a: 1 },
      { k: "pair", d: null, a: 2 },
      { k: "ctx", ri: 3 },
    ]);
  });

  it("ctx rows break del/add runs (no pairing across the gap)", () => {
    expect(buildSplitPairs(rows("d", "c", "a"))).toEqual([
      { k: "pair", d: 0, a: null },
      { k: "ctx", ri: 1 },
      { k: "pair", d: null, a: 2 },
    ]);
  });

  it("a full-file walk keeps every row exactly once", () => {
    const input = rows("h", "c", "d", "d", "a", "c", "a", "h", "d");
    const out = buildSplitPairs(input);
    const seen: number[] = [];
    for (const p of out) {
      if (p.k === "pair") {
        if (p.d !== null) seen.push(p.d);
        if (p.a !== null) seen.push(p.a);
      } else seen.push(p.ri);
    }
    expect(seen.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
