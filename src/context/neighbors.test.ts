import { describe, it, expect } from "vitest";
import { neighborsFromSource, findNeighbors } from "./neighbors.ts";

const SAMPLE = `import { z } from "zod";

export function helper(x: number): number {
  return x * 2;
}

export class Widget {
  render(): string {
    return "w";
  }
}

export function main(): number {
  const w = new Widget();
  return helper(41) + Number(w.render().length);
}
`;

describe("neighborsFromSource (TypeScript)", () => {
  it("finds the enclosing definition and referenced definitions of the region", async () => {
    // The body of `main` (lines 14-16) references helper() and Widget.
    const neighbors = await neighborsFromSource(SAMPLE, "typescript", 13, 16);
    const refs = neighbors.map((n) => n.ref);

    // enclosing def
    expect(refs).toContain("main");
    // referenced defs elsewhere in the file
    expect(refs).toContain("helper");
    expect(refs).toContain("Widget");

    const helper = neighbors.find((n) => n.ref === "helper");
    expect(helper?.signature).toContain("function helper");
    expect(helper?.signature).not.toContain("{"); // signature only, no body
    expect(helper?.oneLine.toLowerCase()).toContain("referenced");
  });

  it("caps the number of neighbors", async () => {
    const neighbors = await neighborsFromSource(SAMPLE, "typescript", 1, 20, 1);
    expect(neighbors.length).toBeLessThanOrEqual(1);
  });
});

describe("findNeighbors", () => {
  it("returns [] for an unsupported language", async () => {
    // .py is not in LANGUAGE_BY_EXT; must be a no-op without throwing.
    const result = await findNeighbors("/nonexistent", "script.py", 1, 10);
    expect(result).toEqual([]);
  });

  it("returns [] for an unreadable file in a supported language", async () => {
    const result = await findNeighbors("/nonexistent", "gone.ts", 1, 10);
    expect(result).toEqual([]);
  });
});
