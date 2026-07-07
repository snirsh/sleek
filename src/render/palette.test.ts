import { describe, expect, it } from "vitest";

import { fuzzyScore, paletteMatches } from "./palette.ts";

describe("fuzzyScore", () => {
  it("matches a subsequence and rejects a non-subsequence", () => {
    expect(fuzzyScore("src", "src/render/client.ts")).not.toBeNull();
    expect(fuzzyScore("srz", "src/render/client.ts")).toBeNull();
    expect(fuzzyScore("client", "cli.ts")).toBeNull(); // query longer than remaining text
  });

  it("is case-insensitive both ways", () => {
    expect(fuzzyScore("README", "readme.md")).not.toBeNull();
    expect(fuzzyScore("readme", "README.md")).not.toBeNull();
    expect(fuzzyScore("ABC", "abc")).toEqual(fuzzyScore("abc", "ABC"));
  });

  it("ranks contiguous > word-boundary > scattered", () => {
    const contiguous = fuzzyScore("abc", "abcxxx")!;
    const boundary = fuzzyScore("abc", "a-b-cx")!;
    const scattered = fuzzyScore("abc", "xaxbxc")!;
    expect(contiguous).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(scattered);
  });

  it("gives the word-boundary bonus at offset 0 and after separators", () => {
    // Same match structure, but "b" sits at a word boundary in the second text.
    expect(fuzzyScore("ab", "axxbxx")!).toBeLessThan(fuzzyScore("ab", "axx/bx")!);
  });

  it("prefers the shorter target on structural ties", () => {
    expect(fuzzyScore("cli", "client.ts")!).toBeGreaterThan(fuzzyScore("cli", "client.test.ts")!);
  });

  it("matches everything at score 0 on an empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("", "")).toBe(0);
  });
});

describe("paletteMatches", () => {
  const labels = ["src/render/html.ts", "Threading model", "xhxtxmxl", "html.ts"];

  it("returns matching indexes best-first", () => {
    // "html" contiguous in 3 (short) and 0 (longer), scattered in 2; no match in 1.
    expect(paletteMatches("html", labels, 10)).toEqual([3, 0, 2]);
  });

  it("keeps input order on exactly equal scores", () => {
    expect(paletteMatches("dup", ["dup", "dup", "dup"], 10)).toEqual([0, 1, 2]);
  });

  it("caps results at the limit", () => {
    expect(paletteMatches("html", labels, 2)).toEqual([3, 0]);
  });

  it("returns the first `limit` indexes in input order on an empty query", () => {
    expect(paletteMatches("", labels, 3)).toEqual([0, 1, 2]);
    expect(paletteMatches("", labels, 10)).toEqual([0, 1, 2, 3]);
  });

  it("returns [] when nothing matches", () => {
    expect(paletteMatches("zzz", labels, 10)).toEqual([]);
  });
});
