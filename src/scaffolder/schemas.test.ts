import { describe, expect, it } from "vitest";

import { layerDetailToolSchema, skeletonToolSchema } from "./schemas.ts";

// ── Phase 3a — skeleton tool input schema ──────────────────────────────────────────

describe("skeletonToolSchema", () => {
  it("each layer requires id, order, and regionIndexes (no anchors)", () => {
    const layer = skeletonToolSchema.properties!.layers!.items!;
    expect(layer.required).toEqual(["id", "order", "regionIndexes"]);
    expect(layer.properties).toHaveProperty("regionIndexes");
    // Anchors are gone from the skeleton contract — Sleek expands indices to anchors.
    expect(layer.properties).not.toHaveProperty("anchors");
  });

  it("regionIndexes is a required, non-empty array of integers", () => {
    const regionIndexes = skeletonToolSchema.properties!.layers!.items!.properties!.regionIndexes!;
    expect(regionIndexes.type).toBe("array");
    expect(regionIndexes.minItems).toBe(1);
    expect(regionIndexes.items!.type).toBe("integer");
  });

  it("describes the indexes as referring to the Changed regions table", () => {
    const regionIndexes = skeletonToolSchema.properties!.layers!.items!.properties!.regionIndexes!;
    expect(regionIndexes.description).toContain("Changed regions");
  });

  it("keeps strict-tool-use invariants (additionalProperties:false, required listed)", () => {
    expect(skeletonToolSchema.additionalProperties).toBe(false);
    expect(skeletonToolSchema.required).toEqual(["layers"]);
    const layer = skeletonToolSchema.properties!.layers!.items!;
    expect(layer.additionalProperties).toBe(false);
  });
});

// ── Phase 3b — per-Layer detail tool input schema (unchanged) ──────────────────────

describe("layerDetailToolSchema", () => {
  it("still requires bundle and findings", () => {
    expect(layerDetailToolSchema.required).toEqual(["bundle", "findings"]);
    expect(layerDetailToolSchema.additionalProperties).toBe(false);
  });
});
