import { describe, expect, it } from "vitest";

import { hunkStartRows } from "./keynav.ts";

const r = (t: string) => ({ t });

describe("hunkStartRows", () => {
  it("returns the first content row after each hunk header", () => {
    const rows = [r("h"), r("c"), r("a"), r("h"), r("d"), r("a"), r("c")];
    expect(hunkStartRows(rows)).toEqual([1, 4]);
  });

  it("returns [] for no rows and for rows without headers", () => {
    expect(hunkStartRows([])).toEqual([]);
    expect(hunkStartRows([r("c"), r("a"), r("d")])).toEqual([]);
  });

  it("skips a header with no content row after it (defensive)", () => {
    expect(hunkStartRows([r("h")])).toEqual([]);
    expect(hunkStartRows([r("h"), r("h"), r("a")])).toEqual([2]);
  });

  it("ignores expanded-context rows appended after the original rows", () => {
    const rows = [r("h"), r("a"), r("h"), r("d"), r("c"), r("c"), r("c")];
    // Appended ctx rows (indexes 4-6) create no new hunks.
    expect(hunkStartRows(rows)).toEqual([1, 3]);
  });
});
