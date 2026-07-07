import { describe, it, expect } from "vitest";
import { layerForAnchor, layerForSelection } from "./resolve.ts";
import { makeAnchor, makeLayer, makeScaffold } from "./fixtures.ts";

describe("layerForAnchor", () => {
  it("resolves a selection to the owning Layer (hit)", () => {
    const layer = makeLayer({
      id: "L",
      anchors: [makeAnchor({ startLine: 10, endLine: 20 })],
    });
    const scaffold = makeScaffold([layer]);

    const sel = makeAnchor({ startLine: 12, endLine: 15 });
    expect(layerForAnchor(scaffold, sel)?.id).toBe("L");
  });

  it("returns null when nothing tiles the selection (miss)", () => {
    const layer = makeLayer({
      anchors: [makeAnchor({ startLine: 10, endLine: 20 })],
    });
    const scaffold = makeScaffold([layer]);

    // A selection on an unchanged line far away.
    const sel = makeAnchor({ startLine: 500, endLine: 505 });
    expect(layerForAnchor(scaffold, sel)).toBeNull();
  });

  it("returns null when file differs even if line range overlaps", () => {
    const layer = makeLayer({
      anchors: [makeAnchor({ file: "src/a.ts", startLine: 10, endLine: 20 })],
    });
    const scaffold = makeScaffold([layer]);

    const sel = makeAnchor({ file: "src/b.ts", startLine: 12, endLine: 15 });
    expect(layerForAnchor(scaffold, sel)).toBeNull();
  });

  it("returns null when side differs (LEFT vs RIGHT)", () => {
    const layer = makeLayer({
      anchors: [makeAnchor({ side: "RIGHT", startLine: 10, endLine: 20 })],
    });
    const scaffold = makeScaffold([layer]);

    const sel = makeAnchor({ side: "LEFT", startLine: 12, endLine: 15 });
    expect(layerForAnchor(scaffold, sel)).toBeNull();
  });

  it("resolves each selection to exactly one Layer when Layers tile the file", () => {
    // Two Layers tiling the same file: lines 1-50 and 51-100.
    const l1 = makeLayer({
      id: "L1",
      anchors: [makeAnchor({ startLine: 1, endLine: 50 })],
    });
    const l2 = makeLayer({
      id: "L2",
      anchors: [makeAnchor({ startLine: 51, endLine: 100 })],
    });
    const scaffold = makeScaffold([l1, l2]);

    expect(layerForAnchor(scaffold, makeAnchor({ startLine: 25, endLine: 30 }))?.id).toBe(
      "L1",
    );
    expect(layerForAnchor(scaffold, makeAnchor({ startLine: 60, endLine: 70 }))?.id).toBe(
      "L2",
    );
    // Boundary: startLine 51 belongs to L2.
    expect(layerForAnchor(scaffold, makeAnchor({ startLine: 51, endLine: 55 }))?.id).toBe(
      "L2",
    );
  });
});

describe("layerForSelection", () => {
  const layer = makeLayer({
    id: "L",
    anchors: [makeAnchor({ file: "src/util.ts", side: "RIGHT", startLine: 10, endLine: 20 })],
  });
  const scaffold = makeScaffold([layer]);

  it("resolves a range fully inside an anchor (hit)", () => {
    expect(
      layerForSelection(scaffold, "src/util.ts", "RIGHT", 12, 15)?.id,
    ).toBe("L");
  });

  it("returns null for a range with no overlap (miss)", () => {
    expect(layerForSelection(scaffold, "src/util.ts", "RIGHT", 500, 505)).toBeNull();
    expect(layerForSelection(scaffold, "src/util.ts", "RIGHT", 1, 9)).toBeNull();
    expect(layerForSelection(scaffold, "src/util.ts", "RIGHT", 21, 30)).toBeNull();
  });

  it("resolves on partial overlap, not just containment", () => {
    // Spills before the anchor…
    expect(layerForSelection(scaffold, "src/util.ts", "RIGHT", 5, 12)?.id).toBe("L");
    // …and past it.
    expect(layerForSelection(scaffold, "src/util.ts", "RIGHT", 18, 30)?.id).toBe("L");
    // Single shared boundary line counts.
    expect(layerForSelection(scaffold, "src/util.ts", "RIGHT", 20, 25)?.id).toBe("L");
  });

  it("requires the same file and side", () => {
    expect(layerForSelection(scaffold, "src/other.ts", "RIGHT", 12, 15)).toBeNull();
    expect(layerForSelection(scaffold, "src/util.ts", "LEFT", 12, 15)).toBeNull();
  });
});
