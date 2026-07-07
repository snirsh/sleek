import { describe, expect, it } from "vitest";

import { fileFilterMatches } from "./treefilter.ts";

describe("fileFilterMatches", () => {
  const paths = [
    "src/render/html.ts",
    "src/server/serve.ts",
    "docs/UI-ROADMAP.md",
    "package.json",
  ];

  it("matches a case-insensitive substring of the full path", () => {
    expect(fileFilterMatches(paths, "serve")).toEqual([1]);
    expect(fileFilterMatches(paths, "SERVE")).toEqual([1]);
    expect(fileFilterMatches(paths, "roadmap")).toEqual([2]);
  });

  it("matches directory segments, not just basenames", () => {
    expect(fileFilterMatches(paths, "src/")).toEqual([0, 1]);
    expect(fileFilterMatches(paths, "render")).toEqual([0]);
  });

  it("is a substring match, never a fuzzy subsequence", () => {
    // "sh" is a subsequence of "src/render/html.ts" but not a substring.
    expect(fileFilterMatches(paths, "sh")).toEqual([]);
  });

  it("returns all indexes, in input order, for an empty or blank query", () => {
    expect(fileFilterMatches(paths, "")).toEqual([0, 1, 2, 3]);
    expect(fileFilterMatches(paths, "   ")).toEqual([0, 1, 2, 3]);
  });

  it("ignores surrounding whitespace on the query", () => {
    expect(fileFilterMatches(paths, "  serve  ")).toEqual([1]);
  });

  it("returns [] when nothing matches", () => {
    expect(fileFilterMatches(paths, "zzz")).toEqual([]);
    expect(fileFilterMatches([], "anything")).toEqual([]);
  });
});
