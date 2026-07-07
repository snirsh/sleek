import { describe, expect, it } from "vitest";

import type { SelRow } from "./selection.ts";
import { selAskText, selLabel } from "./selection.ts";

const add = (n: number): SelRow => ({ t: "a", o: null, n });
const del = (o: number): SelRow => ({ t: "d", o, n: null });
const ctx = (o: number, n: number): SelRow => ({ t: "c", o, n });

describe("selLabel", () => {
  it("labels a single added line", () => {
    expect(selLabel([add(5)], "src/build.js")).toBe("build.js:5");
  });

  it("labels a pure new-side range (adds + context) without disclosure", () => {
    expect(selLabel([ctx(4, 5), add(6), add(7)], "src/build.js")).toBe("build.js:5–7");
  });

  it("labels a pure-deletion range on the old side without disclosure", () => {
    expect(selLabel([del(6), del(7), del(8)], "build.js")).toBe("build.js:6–8");
  });

  it("discloses dropped deletions on a mixed selection with contiguous new lines", () => {
    // ctx new-13, four deleted rows, ctx new-14: label is new-side + disclosure.
    const rows = [ctx(8, 13), del(9), del(10), del(11), del(12), ctx(13, 14)];
    expect(selLabel(rows, "build.js")).toBe("build.js:13–14 (+4 deleted lines not included)");
  });

  it("uses singular wording for one dropped deletion", () => {
    expect(selLabel([ctx(8, 13), del(9)], "build.js")).toBe(
      "build.js:13 (+1 deleted line not included)",
    );
  });

  it("labels per side when the new numbering is non-contiguous", () => {
    const rows = [add(3), del(7), add(9)];
    expect(selLabel(rows, "a/b.ts")).toBe("b.ts: old 7 / new 3–9");
  });

  it("never reverses ranges (rows arrive in display order regardless of click order)", () => {
    expect(selLabel([add(9), add(10), add(11)], "x.ts")).toBe("x.ts:9–11");
  });
});

describe("selAskText", () => {
  it("returns plain joined lines for a pure new-side selection", () => {
    const e = [
      { t: "c", text: "const a = 1;" },
      { t: "a", text: "const b = 2;" },
    ];
    expect(selAskText(e)).toBe("const a = 1;\nconst b = 2;");
  });

  it("returns plain joined lines for a pure-deletion selection", () => {
    const e = [
      { t: "d", text: "old();" },
      { t: "d", text: "older();" },
    ];
    expect(selAskText(e)).toBe("old();\nolder();");
  });

  it("marks deleted lines as removed context in a mixed selection", () => {
    const e = [
      { t: "c", text: "keep(1)" },
      { t: "d", text: "gone(2)" },
      { t: "a", text: "new(3)" },
    ];
    expect(selAskText(e)).toBe("  keep(1)\n- gone(2)\n  new(3)");
  });

  it("handles empty input", () => {
    expect(selAskText([])).toBe("");
  });
});
