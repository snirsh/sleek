import { describe, expect, it } from "vitest";
import {
  anchorFromRow,
  anchorFromSelection,
  blameCardText,
  formatPathLine,
  formatPermalink,
  menuItems,
} from "./menuui.ts";

describe("menuItems", () => {
  const fullActions = { blame: true, open: true, permalink: "https://github.com/org/repo" };
  const noActions = { blame: false, open: false, permalink: null };

  it("always includes copy-pathline", () => {
    const items = menuItems(false, null);
    expect(items.map((x) => x.id)).toEqual(["copy-pathline"]);
  });

  it("static mode: only copy-pathline even with actions", () => {
    const items = menuItems(false, fullActions);
    expect(items.map((x) => x.id)).toEqual(["copy-pathline"]);
  });

  it("live + full actions: all four items in order", () => {
    const ids = menuItems(true, fullActions).map((x) => x.id);
    expect(ids).toEqual(["copy-pathline", "copy-permalink", "blame", "open-source"]);
  });

  it("live + no actions: only copy-pathline", () => {
    const ids = menuItems(true, noActions).map((x) => x.id);
    expect(ids).toEqual(["copy-pathline"]);
  });

  it("live + partial actions: omits unavailable items", () => {
    const ids = menuItems(true, { blame: true, open: false, permalink: null }).map((x) => x.id);
    expect(ids).toEqual(["copy-pathline", "blame"]);
  });

  it("live + permalink only: copy-pathline + copy-permalink", () => {
    const ids = menuItems(true, { blame: false, open: false, permalink: "https://github.com/a/b" }).map((x) => x.id);
    expect(ids).toEqual(["copy-pathline", "copy-permalink"]);
  });

  it("live + null actions: only copy-pathline", () => {
    const ids = menuItems(true, null).map((x) => x.id);
    expect(ids).toEqual(["copy-pathline"]);
  });
});

describe("formatPathLine", () => {
  it("formats single line as path:N", () => {
    expect(formatPathLine("src/foo.ts", 42, 42)).toBe("src/foo.ts:42");
  });

  it("formats a range as path:start-end", () => {
    expect(formatPathLine("src/foo.ts", 10, 20)).toBe("src/foo.ts:10-20");
  });
});

describe("formatPermalink", () => {
  const base = "https://github.com/org/repo";
  const sha = "abc1234";
  const file = "src/foo.ts";

  it("formats single line as ...#LN", () => {
    expect(formatPermalink(base, sha, file, 5, 5)).toBe(
      "https://github.com/org/repo/blob/abc1234/src/foo.ts#L5",
    );
  });

  it("formats a range as ...#Lstart-Lend", () => {
    expect(formatPermalink(base, sha, file, 5, 10)).toBe(
      "https://github.com/org/repo/blob/abc1234/src/foo.ts#L5-L10",
    );
  });

  it("uses the provided sha verbatim (caller supplies headSha or baseSha)", () => {
    const url = formatPermalink(base, "deadbeef", file, 1, 1);
    expect(url).toContain("deadbeef");
  });
});

describe("blameCardText", () => {
  it("formats blame info as shortSha author · date — summary", () => {
    const text = blameCardText({
      shortSha: "abc1234",
      author: "Alice",
      authorDate: "2024-03-15T10:00:00Z",
      summary: "Fix the bug",
    });
    expect(text).toBe("abc1234 Alice · 2024-03-15 — Fix the bug");
  });

  it("truncates ISO date to first 10 chars", () => {
    const text = blameCardText({
      shortSha: "ff0011",
      author: "Bob",
      authorDate: "2023-01-02T00:00:00+00:00",
      summary: "refactor",
    });
    expect(text).toContain("2023-01-02");
    expect(text).not.toContain("T00:00");
  });
});

describe("anchorFromRow", () => {
  it("returns RIGHT anchor with n for add row", () => {
    const a = anchorFromRow("src/a.ts", { t: "a", o: null, n: 10 });
    expect(a).toEqual({ file: "src/a.ts", side: "RIGHT", startLine: 10, endLine: 10 });
  });

  it("returns RIGHT anchor with n for ctx row", () => {
    const a = anchorFromRow("src/a.ts", { t: "c", o: 5, n: 6 });
    expect(a).toEqual({ file: "src/a.ts", side: "RIGHT", startLine: 6, endLine: 6 });
  });

  it("returns LEFT anchor with o for del row", () => {
    const a = anchorFromRow("src/a.ts", { t: "d", o: 7, n: null });
    expect(a).toEqual({ file: "src/a.ts", side: "LEFT", startLine: 7, endLine: 7 });
  });

  it("returns null when the relevant line number is null", () => {
    expect(anchorFromRow("src/a.ts", { t: "a", o: null, n: null })).toBeNull();
  });
});

describe("anchorFromSelection", () => {
  it("returns null for empty rows", () => {
    expect(anchorFromSelection("src/a.ts", [])).toBeNull();
  });

  it("uses RIGHT side when rows include non-del rows", () => {
    const rows = [
      { t: "a", o: null, n: 10 },
      { t: "c", o: 11, n: 11 },
    ];
    const a = anchorFromSelection("src/a.ts", rows);
    expect(a).toEqual({ file: "src/a.ts", side: "RIGHT", startLine: 10, endLine: 11 });
  });

  it("uses LEFT side when all rows are del", () => {
    const rows = [
      { t: "d", o: 5, n: null },
      { t: "d", o: 6, n: null },
    ];
    const a = anchorFromSelection("src/a.ts", rows);
    expect(a).toEqual({ file: "src/a.ts", side: "LEFT", startLine: 5, endLine: 6 });
  });

  it("computes min-max range across multiple rows", () => {
    const rows = [
      { t: "a", o: null, n: 15 },
      { t: "a", o: null, n: 12 },
      { t: "a", o: null, n: 18 },
    ];
    const a = anchorFromSelection("src/a.ts", rows);
    expect(a).toEqual({ file: "src/a.ts", side: "RIGHT", startLine: 12, endLine: 18 });
  });

  it("returns null when no valid line numbers exist for the chosen side", () => {
    const rows = [{ t: "a", o: null, n: null }];
    expect(anchorFromSelection("src/a.ts", rows)).toBeNull();
  });
});
