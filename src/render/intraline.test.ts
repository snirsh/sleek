import { describe, expect, it } from "vitest";

import type { MarkRange } from "./intraline.ts";
import { intralineMarks, tokenDiff } from "./intraline.ts";

const row = (type: "add" | "del" | "ctx" | "hunk", text: string) => ({ type, text });

function marked(text: string, ranges: MarkRange[]): string[] {
  return ranges.map((r) => text.slice(r.start, r.end));
}

describe("tokenDiff", () => {
  it("marks only the changed segment of a modified line pair (the manifestLoader case)", () => {
    const oldLine = `require('./dist/server')`;
    const newLine = `require('@acme/rocket-app/dist/server')`;
    const d = tokenDiff(oldLine, newLine);
    expect(d).not.toBeNull();
    expect(marked(oldLine, d!.del)).toEqual(["."]);
    expect(marked(newLine, d!.add)).toEqual(["@acme/rocket-app"]);
  });

  it("marks a renamed identifier as the WHOLE word, never a mid-word fragment", () => {
    const oldLine = "\t\tconst carmiFeatureConfig = stripOrphanArrayElements";
    const newLine = "\t\tconst carmiFeatureConfig = isResponsive";
    const d = tokenDiff(oldLine, newLine);
    expect(d).not.toBeNull();
    // char-LCS used to mark "tripOrphanArrayElements" / "isResponsiv" (shared s/e
    // chars peeled off the word edges); token-LCS marks the full identifiers.
    expect(marked(oldLine, d!.del)).toEqual(["stripOrphanArrayElements"]);
    expect(marked(newLine, d!.add)).toEqual(["isResponsive"]);
  });

  it("marks a changed number tightly", () => {
    const d = tokenDiff("const retries = 3", "const retries = 10");
    expect(d).not.toBeNull();
    expect(marked("const retries = 3", d!.del)).toEqual(["3"]);
    expect(marked("const retries = 10", d!.add)).toEqual(["10"]);
  });

  it("gives unrelated lines sharing only a `?: boolean` suffix no marks", () => {
    // 3 of ~4 tokens are shared but only 9 of 54 chars — char-weighted similarity
    // keeps the long differing identifiers from being glued by the common suffix.
    expect(tokenDiff("\tstripOrphanArrayElements?: boolean", "\tisResponsive?: boolean")).toBeNull();
  });

  it("gives a rewritten prose/comment line pair no marks (123 comment block)", () => {
    // Index-adjacent lines of a rewrapped comment: real shared words, but scattered —
    // char-LCS marked fragments like "and" / "therefore omit them, while".
    const oldLine =
      "// Carmi's flat maps (built over `originalStructure`) keep them. The omission is functionally";
    const newLine =
      "// `componentsUnderFoldMap` therefore omit them, while Carmi's flat maps (built over";
    expect(tokenDiff(oldLine, newLine)).toBeNull();
  });

  it("returns null (no marks) for dissimilar lines", () => {
    expect(tokenDiff("const a = 1", "return fetchData(url, options)")).toBeNull();
  });

  it("returns null for over-long lines (> 500 chars)", () => {
    expect(tokenDiff("x".repeat(501), "x".repeat(501) + "y")).toBeNull();
    expect(tokenDiff("ab", "a".repeat(501))).toBeNull();
  });

  it("identical lines yield empty ranges, not null", () => {
    expect(tokenDiff("same", "same")).toEqual({ del: [], add: [] });
  });

  it("marks whitespace-only differences (indentation change) without bailing out", () => {
    const d = tokenDiff("\tfoo(bar)", "\t\t\tfoo(bar)");
    expect(d).not.toBeNull();
    // Every mark covers only whitespace; non-ws similarity is 1 so no gate trips.
    const all = [...marked("\tfoo(bar)", d!.del), ...marked("\t\t\tfoo(bar)", d!.add)];
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) expect(s.trim()).toBe("");
  });

  it("merges changed ranges separated by short unchanged gaps", () => {
    const d = tokenDiff("const alpha = f(a, b)", "const beta = g(a, c)");
    expect(d).not.toBeNull();
    // "alpha"…"f" and "beta"…"g" are separated by 3+ unchanged chars (" = ") so they
    // stay separate ranges, but each range starts/ends on token boundaries.
    for (const r of d!.del) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeGreaterThan(r.start);
    }
    expect(d!.del.length).toBeLessThanOrEqual(4);
    expect(d!.add.length).toBeLessThanOrEqual(4);
  });

  it("bails out when the changed regions are too fragmented (confetti)", () => {
    // 5 changed words interleaved with unchanged ones → more than 4 mark segments.
    const oldLine = "aa keep1 bb keep2 cc keep3 dd keep4 ee keep5";
    const newLine = "xx keep1 yy keep2 zz keep3 ww keep4 vv keep5";
    expect(tokenDiff(oldLine, newLine)).toBeNull();
  });
});

describe("intralineMarks", () => {
  it("pairs an equal-length del run with the following add run row-by-row", () => {
    const rows = [
      row("del", "let count = 1"),
      row("del", "foo(bar)"),
      row("add", "let count = 2"),
      row("add", "foo(baz)"),
    ];
    const m = intralineMarks(rows);
    expect(marked(rows[0]!.text, m.get(0)!)).toEqual(["1"]);
    expect(marked(rows[2]!.text, m.get(2)!)).toEqual(["2"]);
    expect(marked(rows[1]!.text, m.get(1)!)).toEqual(["bar"]);
    expect(marked(rows[3]!.text, m.get(3)!)).toEqual(["baz"]);
  });

  it("gives unequal del/add runs no marks at all (no trustworthy correspondence)", () => {
    // 2 del / 3 add — index pairing would match non-counterpart lines (the 123
    // rewrapped-comment case), so the whole run stays plain full-line coloring.
    const rows = [
      row("del", "alpha = 1"),
      row("del", "beta = 2"),
      row("add", "alpha = 9"),
      row("add", "gamma = 3"),
      row("add", "beta = 2"),
    ];
    expect(intralineMarks(rows).size).toBe(0);
  });

  it("gives an unrelated del/add pair (low similarity) no marks", () => {
    const rows = [row("del", "const a = 1"), row("add", "return fetchData(url, options)")];
    expect(intralineMarks(rows).size).toBe(0);
  });

  it("does not pair across context rows or hunk headers", () => {
    const rows = [
      row("del", "let count = 1"),
      row("ctx", "unchanged"),
      row("add", "let count = 2"),
      row("hunk", "@@ -1 +1 @@"),
      row("del", "foo(bar)"),
      row("hunk", "@@ -9 +9 @@"),
      row("add", "foo(baz)"),
    ];
    expect(intralineMarks(rows).size).toBe(0);
  });

  it("pairs independently per del/add group", () => {
    const rows = [
      row("del", "let count = 1"),
      row("add", "let count = 2"),
      row("ctx", "unchanged"),
      row("del", "foo(bar)"),
      row("add", "foo(baz)"),
    ];
    const m = intralineMarks(rows);
    expect([...m.keys()].sort((a, b) => a - b)).toEqual([0, 1, 3, 4]);
  });
});
