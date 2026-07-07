import { describe, it, expect } from "vitest";
import { hydrateNeighborSource, parseRef, DEFAULT_MAX_LINES } from "./hydrate.ts";
import type { FileReader } from "./hydrate.ts";

const SOURCE = Array.from({ length: 300 }, (_, i) => `line${i + 1}`).join("\n");

/** A fake reader that returns SOURCE for one known path, else throws. */
function fakeReader(knownAbs: string): FileReader {
  return async (abs) => {
    if (abs === knownAbs) return SOURCE;
    throw new Error("ENOENT");
  };
}

describe("parseRef", () => {
  it("parses path#symbol", () => {
    expect(parseRef("src/util.ts#helper")).toMatchObject({
      file: "src/util.ts",
      symbol: "helper",
    });
  });

  it("parses path:start-end", () => {
    expect(parseRef("src/util.ts:10-42")).toMatchObject({
      file: "src/util.ts",
      startLine: 10,
      endLine: 42,
    });
  });

  it("parses path:start (single line)", () => {
    expect(parseRef("src/util.ts:10")).toMatchObject({
      file: "src/util.ts",
      startLine: 10,
      endLine: 10,
    });
  });

  it("parses a whole-file path", () => {
    expect(parseRef("src/util.ts")).toMatchObject({
      file: "src/util.ts",
      symbol: null,
    });
  });

  it("parses a bare symbol (M2 case)", () => {
    expect(parseRef("helper")).toMatchObject({ file: null, symbol: "helper" });
  });
});

describe("hydrateNeighborSource", () => {
  it("reads an explicit line range (1-based, inclusive)", async () => {
    const text = await hydrateNeighborSource(
      "/wt",
      "src/util.ts:2-4",
      DEFAULT_MAX_LINES,
      { readFile: fakeReader("/wt/src/util.ts") },
    );
    expect(text).toBe("line2\nline3\nline4");
  });

  it("bounds output to maxLines", async () => {
    const text = await hydrateNeighborSource("/wt", "src/util.ts:1-300", 5, {
      readFile: fakeReader("/wt/src/util.ts"),
    });
    expect(text.split("\n")).toHaveLength(5);
    expect(text.split("\n")[0]).toBe("line1");
  });

  it("resolves a bare-symbol ref via fileHint and returns the bounded head", async () => {
    const text = await hydrateNeighborSource("/wt", "helper", 3, {
      fileHint: "src/util.ts",
      readFile: fakeReader("/wt/src/util.ts"),
    });
    expect(text).toBe("line1\nline2\nline3");
  });

  it("returns '' for a bare symbol with no fileHint", async () => {
    const text = await hydrateNeighborSource("/wt", "helper", 10, {
      readFile: fakeReader("/wt/src/util.ts"),
    });
    expect(text).toBe("");
  });

  it("returns '' when the file cannot be read (best-effort)", async () => {
    const text = await hydrateNeighborSource("/wt", "src/missing.ts:1-5", 10, {
      readFile: fakeReader("/wt/src/util.ts"),
    });
    expect(text).toBe("");
  });

  it("honors absolute paths inside the worktree", async () => {
    const text = await hydrateNeighborSource(
      "/wt",
      "/wt/src/util.ts:1-2",
      DEFAULT_MAX_LINES,
      { readFile: fakeReader("/wt/src/util.ts") },
    );
    expect(text).toBe("line1\nline2");
  });

  it("returns '' for absolute paths outside the worktree", async () => {
    const text = await hydrateNeighborSource(
      "/wt",
      "/abs/util.ts:1-2",
      DEFAULT_MAX_LINES,
      { readFile: fakeReader("/abs/util.ts") },
    );
    expect(text).toBe("");
  });

  it("returns '' for refs that escape the worktree via ..", async () => {
    const text = await hydrateNeighborSource(
      "/wt",
      "../abs/util.ts:1-2",
      DEFAULT_MAX_LINES,
      { readFile: fakeReader("/abs/util.ts") },
    );
    expect(text).toBe("");
  });
});
