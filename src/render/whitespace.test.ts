import { describe, expect, it } from "vitest";

import { isWsOnly, wsOnlyRows } from "./whitespace.ts";

const row = (type: "add" | "del" | "ctx" | "hunk", text: string) => ({ type, text });

describe("isWsOnly", () => {
  it("indentation-only change qualifies", () => {
    expect(isWsOnly("  const a = 1;", "    const a = 1;")).toBe(true);
  });

  it("trailing whitespace and tabs↔spaces qualify", () => {
    expect(isWsOnly("done();", "done();  ")).toBe(true);
    expect(isWsOnly("\tif (x) {", "  if (x) {")).toBe(true);
  });

  it("whitespace REMOVED between tokens still qualifies (definition is ws-insensitive equality)", () => {
    expect(isWsOnly("a = b", "a=b")).toBe(true);
  });

  it("any non-whitespace difference does not qualify", () => {
    expect(isWsOnly("const a = 1;", "const a = 2;")).toBe(false);
    expect(isWsOnly("foo()", "foo();")).toBe(false);
  });
});

describe("wsOnlyRows", () => {
  it("tags both rows of a ws-only del/add pair and counts it", () => {
    const rows = [
      row("hunk", "@@"),
      row("ctx", "before"),
      row("del", "  x();"),
      row("add", "    x();"),
      row("ctx", "after"),
    ];
    const r = wsOnlyRows(rows);
    expect([...r.rows].sort()).toEqual([2, 3]);
    expect(r.pairs).toBe(1);
  });

  it("pairs del i with add i within runs; mixed runs tag only the ws-only pairs", () => {
    const rows = [
      row("del", "  a();"), // pairs with add 2 → ws-only
      row("del", "b(1);"), // pairs with add 3 → real change
      row("add", "\ta();"),
      row("add", "b(2);"),
    ];
    const r = wsOnlyRows(rows);
    expect([...r.rows].sort()).toEqual([0, 2]);
    expect(r.pairs).toBe(1);
  });

  it("unpaired leftover rows of the longer run never qualify", () => {
    const rows = [row("del", "  a();"), row("add", "    a();"), row("add", "extra();")];
    const r = wsOnlyRows(rows);
    expect(r.pairs).toBe(1);
    expect(r.rows.has(2)).toBe(false);
  });

  it("ctx and hunk rows break runs (no pairing across them)", () => {
    const rows = [row("del", "  a();"), row("ctx", "gap"), row("add", "    a();")];
    expect(wsOnlyRows(rows)).toEqual({ rows: new Set(), pairs: 0 });
  });

  it("returns zero pairs for a diff with no ws-only changes", () => {
    const rows = [row("del", "old();"), row("add", "brandNew();")];
    expect(wsOnlyRows(rows).pairs).toBe(0);
  });
});
