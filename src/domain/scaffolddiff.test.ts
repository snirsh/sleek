import { describe, expect, it } from "vitest";

import type {
  Anchor,
  Finding,
  Layer,
  ReviewScaffold,
} from "./scaffold.ts";
import { diffScaffolds } from "./scaffolddiff.ts";

function anchor(partial: Partial<Anchor> = {}): Anchor {
  return { file: "src/a.ts", side: "RIGHT", startLine: 1, endLine: 5, ...partial };
}

function finding(partial: Partial<Finding> = {}): Finding {
  return {
    anchor: anchor(),
    concern: "correctness",
    severity: "minor",
    text: "Consider a guard clause.",
    ...partial,
  };
}

function layer(partial: Partial<Layer> = {}): Layer {
  return {
    id: "layer-1",
    anchors: [anchor()],
    order: 0,
    bundle: { summary: "Does a thing.", neighbors: [], history: [], learnings: [] },
    findings: [],
    ...partial,
  };
}

function scaffold(layers: Layer[], headSha = "head"): ReviewScaffold {
  return {
    pr: { number: 1, title: "T", description: "", baseSha: "base", headSha },
    layers,
  };
}

/** An all-zero counts object; tests spread the fields they expect to differ. */
const NO_CHANGES = {
  layersAdded: 0,
  layersRemoved: 0,
  layersChanged: 0,
  findingsAdded: 0,
  findingsRemoved: 0,
  findingsMoved: 0,
  filesEntering: 0,
  filesLeaving: 0,
};

describe("diffScaffolds", () => {
  it("reports no differences for identical scaffolds", () => {
    const s = scaffold([layer({ findings: [finding()] })]);
    const d = diffScaffolds(s, scaffold([layer({ findings: [finding()] })], "head2"));
    expect(d.counts).toEqual(NO_CHANGES);
    expect(d.layers).toEqual({ added: [], removed: [], changed: [] });
    expect(d.findings).toEqual({ added: [], removed: [], moved: [] });
    expect(d.files).toEqual({ entering: [], leaving: [] });
  });

  it("reports added and removed layers with their file footprint and finding count", () => {
    const oldS = scaffold([
      layer({ id: "gone", anchors: [anchor({ file: "src/old.ts" })] }),
    ]);
    const newS = scaffold([
      layer({
        id: "fresh",
        anchors: [anchor({ file: "src/new.ts" }), anchor({ file: "src/new2.ts", startLine: 9, endLine: 9 })],
        findings: [finding({ anchor: anchor({ file: "src/new.ts" }) })],
      }),
    ]);
    const d = diffScaffolds(oldS, newS);
    expect(d.layers.added).toEqual([
      { id: "fresh", files: ["src/new.ts", "src/new2.ts"], findingCount: 1 },
    ]);
    expect(d.layers.removed).toEqual([
      { id: "gone", files: ["src/old.ts"], findingCount: 0 },
    ]);
    expect(d.counts).toMatchObject({ layersAdded: 1, layersRemoved: 1 });
  });

  it("matches layers by id first and flags a reanchored one as changed", () => {
    const oldS = scaffold([layer({ id: "core", anchors: [anchor({ startLine: 1, endLine: 5 })] })]);
    const newS = scaffold([layer({ id: "core", anchors: [anchor({ startLine: 10, endLine: 20 })] })]);
    const d = diffScaffolds(oldS, newS);
    expect(d.layers.changed).toEqual([
      { oldId: "core", newId: "core", renamed: false, reanchored: true },
    ]);
    expect(d.counts.layersChanged).toBe(1);
    expect(d.counts.layersAdded).toBe(0);
    expect(d.counts.layersRemoved).toBe(0);
  });

  it("anchor-set comparison is order-insensitive (no false reanchored)", () => {
    const a1 = anchor({ file: "src/a.ts" });
    const a2 = anchor({ file: "src/b.ts", startLine: 7, endLine: 8 });
    const d = diffScaffolds(
      scaffold([layer({ id: "core", anchors: [a1, a2] })]),
      scaffold([layer({ id: "core", anchors: [a2, a1] })]),
    );
    expect(d.layers.changed).toEqual([]);
  });

  it("matches a renamed layer by anchor-file overlap and flags it renamed", () => {
    const oldS = scaffold([
      layer({ id: "old-name", anchors: [anchor({ file: "src/shared.ts" })] }),
    ]);
    const newS = scaffold([
      layer({ id: "new-name", anchors: [anchor({ file: "src/shared.ts" })] }),
    ]);
    const d = diffScaffolds(oldS, newS);
    expect(d.layers.changed).toEqual([
      { oldId: "old-name", newId: "new-name", renamed: true, reanchored: false },
    ]);
    expect(d.layers.added).toEqual([]);
    expect(d.layers.removed).toEqual([]);
  });

  it("greedy overlap pairs the BEST-overlapping candidates first", () => {
    // old X covers {a,b}; new Y covers {a,b} (2/2), new Z covers {a} (1/2 vs X).
    // X must pair with Y; Z is added.
    const oldS = scaffold([
      layer({ id: "x", anchors: [anchor({ file: "a.ts" }), anchor({ file: "b.ts" })] }),
    ]);
    const newS = scaffold([
      layer({ id: "z", anchors: [anchor({ file: "a.ts" })], order: 1 }),
      layer({ id: "y", anchors: [anchor({ file: "a.ts" }), anchor({ file: "b.ts" })] }),
    ]);
    const d = diffScaffolds(oldS, newS);
    expect(d.layers.changed).toEqual([
      { oldId: "x", newId: "y", renamed: true, reanchored: false },
    ]);
    expect(d.layers.added.map((l) => l.id)).toEqual(["z"]);
  });

  it("does not overlap-match layers with disjoint files", () => {
    const d = diffScaffolds(
      scaffold([layer({ id: "left", anchors: [anchor({ file: "a.ts" })] })]),
      scaffold([layer({ id: "right", anchors: [anchor({ file: "b.ts" })] })]),
    );
    expect(d.layers.changed).toEqual([]);
    expect(d.layers.added.map((l) => l.id)).toEqual(["right"]);
    expect(d.layers.removed.map((l) => l.id)).toEqual(["left"]);
  });

  it("reports added and removed findings attributed to their layers", () => {
    const oldS = scaffold([
      layer({ findings: [finding({ text: "Old worry.", concern: "security" })] }),
    ]);
    const newS = scaffold([
      layer({ findings: [finding({ text: "New worry.", severity: "major" })] }),
    ]);
    const d = diffScaffolds(oldS, newS);
    expect(d.findings.added).toEqual([
      {
        layerId: "layer-1",
        concern: "correctness",
        severity: "major",
        text: "New worry.",
        anchor: anchor(),
      },
    ]);
    expect(d.findings.removed).toEqual([
      {
        layerId: "layer-1",
        concern: "security",
        severity: "minor",
        text: "Old worry.",
        anchor: anchor(),
      },
    ]);
    expect(d.counts).toMatchObject({ findingsAdded: 1, findingsRemoved: 1 });
  });

  it("reports a same-body+concern finding at a new anchor as moved, not added+removed", () => {
    const from = anchor({ startLine: 3, endLine: 3 });
    const to = anchor({ startLine: 30, endLine: 31 });
    const d = diffScaffolds(
      scaffold([layer({ findings: [finding({ anchor: from })] })]),
      scaffold([layer({ findings: [finding({ anchor: to })] })]),
    );
    expect(d.findings.moved).toEqual([
      {
        layerId: "layer-1",
        concern: "correctness",
        severity: "minor",
        text: "Consider a guard clause.",
        from,
        to,
      },
    ]);
    expect(d.findings.added).toEqual([]);
    expect(d.findings.removed).toEqual([]);
    expect(d.counts.findingsMoved).toBe(1);
  });

  it("matches moved findings across layers (attribution follows the new layer)", () => {
    const from = anchor({ file: "src/a.ts" });
    const to = anchor({ file: "src/b.ts" });
    const d = diffScaffolds(
      scaffold([layer({ id: "alpha", findings: [finding({ anchor: from })] })]),
      scaffold([
        layer({ id: "alpha" }),
        layer({ id: "beta", anchors: [to], order: 1, findings: [finding({ anchor: to })] }),
      ]),
    );
    expect(d.findings.moved).toHaveLength(1);
    expect(d.findings.moved[0]!.layerId).toBe("beta");
  });

  it("a concern change is added+removed, never moved (concern is identity)", () => {
    const d = diffScaffolds(
      scaffold([layer({ findings: [finding({ concern: "correctness" })] })]),
      scaffold([layer({ findings: [finding({ concern: "security" })] })]),
    );
    expect(d.findings.moved).toEqual([]);
    expect(d.counts).toMatchObject({ findingsAdded: 1, findingsRemoved: 1 });
  });

  it("duplicate identical findings pair one-to-one (no double matching)", () => {
    const twice = [finding(), finding()];
    const d = diffScaffolds(
      scaffold([layer({ findings: twice })]),
      scaffold([layer({ findings: [finding()] })]),
    );
    expect(d.counts.findingsRemoved).toBe(1);
    expect(d.counts.findingsAdded).toBe(0);
    expect(d.counts.findingsMoved).toBe(0);
  });

  it("reports files entering and leaving the changeset, sorted", () => {
    const oldS = scaffold([
      layer({
        anchors: [anchor({ file: "src/kept.ts" }), anchor({ file: "src/dropped.ts" })],
        findings: [finding({ anchor: anchor({ file: "src/dropped2.ts" }) })],
      }),
    ]);
    const newS = scaffold([
      layer({
        anchors: [anchor({ file: "src/kept.ts" }), anchor({ file: "src/z-added.ts" })],
        findings: [finding({ anchor: anchor({ file: "src/a-added.ts" }) })],
      }),
    ]);
    const d = diffScaffolds(oldS, newS);
    expect(d.files.entering).toEqual(["src/a-added.ts", "src/z-added.ts"]);
    expect(d.files.leaving).toEqual(["src/dropped.ts", "src/dropped2.ts"]);
    expect(d.counts).toMatchObject({ filesEntering: 2, filesLeaving: 2 });
  });

  it("counts always mirror the itemized lists", () => {
    const oldS = scaffold([
      layer({ id: "gone", anchors: [anchor({ file: "x.ts" })] }),
      layer({ id: "core", order: 1, findings: [finding({ text: "Stays." }), finding({ text: "Goes." })] }),
    ]);
    const newS = scaffold([
      layer({ id: "core", findings: [finding({ text: "Stays." }), finding({ text: "Arrives." })] }),
      layer({ id: "fresh", order: 1, anchors: [anchor({ file: "y.ts" })] }),
    ]);
    const d = diffScaffolds(oldS, newS);
    expect(d.counts.layersAdded).toBe(d.layers.added.length);
    expect(d.counts.layersRemoved).toBe(d.layers.removed.length);
    expect(d.counts.layersChanged).toBe(d.layers.changed.length);
    expect(d.counts.findingsAdded).toBe(d.findings.added.length);
    expect(d.counts.findingsRemoved).toBe(d.findings.removed.length);
    expect(d.counts.findingsMoved).toBe(d.findings.moved.length);
    expect(d.counts.filesEntering).toBe(d.files.entering.length);
    expect(d.counts.filesLeaving).toBe(d.files.leaving.length);
  });
});
