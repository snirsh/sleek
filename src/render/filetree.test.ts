import { describe, expect, it } from "vitest";

import type { TreeDirNode, TreeInputFile, TreeNode } from "./filetree.ts";
import { buildFileTree, fileLang, fileFindingCounts, fileLayerIndex } from "./filetree.ts";

const file = (path: string, adds = 1, dels = 1): TreeInputFile => ({
  path,
  adds,
  dels,
  status: "modified",
});

const asDir = (n: TreeNode | undefined): TreeDirNode => {
  if (!n || n.kind !== "dir") throw new Error("expected dir node");
  return n;
};

describe("buildFileTree", () => {
  it("builds the demo-PR shape: root file + one top dir with two subtrees", () => {
    const tree = buildFileTree([
      file("packages/rocket-app-public/index.js"),
      file("packages/rocket-app-public/build.js"),
      file("packages/rocket-app/src/server/services/siteAssetsManifestLoader.ts"),
      file("knip.config.js"),
    ]);
    // Dirs before files at every level.
    expect(tree.map((n) => n.kind)).toEqual(["dir", "file"]);
    const packages = asDir(tree[0]);
    expect(packages.name).toBe("packages");
    // Two subtrees under packages/ → the chain does NOT collapse into packages.
    expect(packages.children.map((n) => n.name)).toEqual([
      "rocket-app/src/server/services",
      "rocket-app-public",
    ]);
    // Single-child chain collapsed to one node with the full dimmed path.
    const chain = asDir(packages.children[0]);
    expect(chain.path).toBe("packages/rocket-app/src/server/services");
    expect(chain.children).toEqual([
      expect.objectContaining({ kind: "file", name: "siteAssetsManifestLoader.ts", fi: 2 }),
    ]);
    // Sibling files sort alphabetically by basename.
    const pub = asDir(packages.children[1]);
    expect(pub.children.map((n) => n.name)).toEqual(["build.js", "index.js"]);
    expect(tree[1]).toEqual(expect.objectContaining({ kind: "file", name: "knip.config.js", fi: 3 }));
  });

  it("fi is the input (card) index, independent of tree sort order", () => {
    const tree = buildFileTree([file("z.ts"), file("a.ts")]);
    expect(tree.map((n) => n.name)).toEqual(["a.ts", "z.ts"]);
    expect(tree.map((n) => (n.kind === "file" ? n.fi : -1))).toEqual([1, 0]);
  });

  it("collapses a single-child chain from the root", () => {
    const tree = buildFileTree([file("a/b/c/deep.ts")]);
    expect(tree).toHaveLength(1);
    const d = asDir(tree[0]);
    expect(d.name).toBe("a/b/c");
    expect(d.path).toBe("a/b/c");
    expect(d.children[0]).toEqual(expect.objectContaining({ kind: "file", name: "deep.ts" }));
  });

  it("does not collapse a dir that owns files even with a single subdir", () => {
    const tree = buildFileTree([file("a/own.ts"), file("a/b/inner.ts")]);
    const a = asDir(tree[0]);
    expect(a.name).toBe("a");
    expect(a.children.map((n) => n.name)).toEqual(["b", "own.ts"]);
  });

  it("carries adds/dels/status through to file nodes", () => {
    const tree = buildFileTree([{ path: "x.ts", adds: 7, dels: 2, status: "added" }]);
    expect(tree[0]).toEqual(
      expect.objectContaining({ kind: "file", adds: 7, dels: 2, status: "added" }),
    );
  });

  it("carries the findings count (defaulting to 0 when omitted)", () => {
    const tree = buildFileTree([
      { path: "a.ts", adds: 1, dels: 1, status: "modified", findings: 3 },
      { path: "b.ts", adds: 1, dels: 1, status: "modified" },
    ]);
    expect((tree[0] as { findings: number }).findings).toBe(3);
    expect((tree[1] as { findings: number }).findings).toBe(0);
  });

  it("returns [] for no files", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("rolls up subtree file count / findings / adds / dels onto dir nodes", () => {
    const tree = buildFileTree([
      { path: "pkg/a/one.ts", adds: 3, dels: 1, status: "modified", findings: 2 },
      { path: "pkg/a/two.ts", adds: 5, dels: 0, status: "added", findings: 0 },
      { path: "pkg/b/three.ts", adds: 1, dels: 4, status: "modified", findings: 1 },
    ]);
    const pkg = asDir(tree[0]);
    expect(pkg.name).toBe("pkg");
    // pkg rolls up everything below it.
    expect(pkg.fileCount).toBe(3);
    expect(pkg.findings).toBe(3);
    expect(pkg.adds).toBe(9);
    expect(pkg.dels).toBe(5);
    // Nested dirs sum only their own subtree.
    const a = asDir(pkg.children[0]);
    expect(a.name).toBe("a");
    expect(a.fileCount).toBe(2);
    expect(a.findings).toBe(2);
    expect(a.adds).toBe(8);
    expect(a.dels).toBe(1);
    const b = asDir(pkg.children[1]);
    expect(b.fileCount).toBe(1);
    expect(b.findings).toBe(1);
    expect(b.adds).toBe(1);
    expect(b.dels).toBe(4);
  });

  it("rolls up across a chain-collapsed dir (sums survive the collapse)", () => {
    const tree = buildFileTree([
      { path: "a/b/c/deep.ts", adds: 4, dels: 2, status: "modified", findings: 5 },
    ]);
    const d = asDir(tree[0]);
    expect(d.name).toBe("a/b/c");
    expect(d.fileCount).toBe(1);
    expect(d.findings).toBe(5);
    expect(d.adds).toBe(4);
    expect(d.dels).toBe(2);
  });

  it("compresses a many-segment single-child chain into ONE row (the screenshot shape)", () => {
    const tree = buildFileTree([
      file("packages/rocket-symbols/src/types/viewer-model.ts"),
      file("packages/rocket-core/src/features.ts"),
    ]);
    const packages = asDir(tree[0]);
    // Each subtree is one compressed dir row, not one row per directory level.
    expect(packages.children.map((n) => n.name)).toEqual([
      "rocket-core/src",
      "rocket-symbols/src/types",
    ]);
    expect(packages.children.map((n) => (n.kind === "dir" ? n.children.length : -1))).toEqual([1, 1]);
  });
});

describe("fileLayerIndex", () => {
  const anchor = (f: string) => ({ file: f });

  it("membership = the layer has ≥1 anchor in the file; many-to-many both ways", () => {
    const idx = fileLayerIndex(
      ["a.ts", "b.ts", "c.ts"],
      [
        { anchors: [anchor("a.ts"), anchor("b.ts")] }, // layer 0 spans two files
        { anchors: [anchor("b.ts")] }, // b.ts hosts two layers
      ],
    );
    expect(idx).toEqual([[0], [0, 1], []]);
  });

  it("dedupes multiple anchors of one layer in the same file", () => {
    const idx = fileLayerIndex(["a.ts"], [{ anchors: [anchor("a.ts"), anchor("a.ts")] }]);
    expect(idx).toEqual([[0]]);
  });

  it("ignores anchors into files absent from the diff", () => {
    const idx = fileLayerIndex(["a.ts"], [{ anchors: [anchor("ghost.ts")] }]);
    expect(idx).toEqual([[]]);
  });

  it("handles no layers and no files", () => {
    expect(fileLayerIndex(["a.ts"], [])).toEqual([[]]);
    expect(fileLayerIndex([], [{ anchors: [anchor("a.ts")] }])).toEqual([]);
  });
});

describe("fileFindingCounts", () => {
  const finding = (f: string) => ({ anchor: { file: f } });

  it("counts findings per file across all layers (by input index)", () => {
    const counts = fileFindingCounts(
      ["a.ts", "b.ts", "c.ts"],
      [
        { findings: [finding("a.ts"), finding("a.ts"), finding("b.ts")] },
        { findings: [finding("a.ts")] },
      ],
    );
    // a.ts: 2 (layer0) + 1 (layer1) = 3; b.ts: 1; c.ts: 0
    expect(counts).toEqual([3, 1, 0]);
  });

  it("ignores findings anchored to files absent from the diff", () => {
    expect(fileFindingCounts(["a.ts"], [{ findings: [finding("ghost.ts")] }])).toEqual([0]);
  });

  it("returns zeros for no layers", () => {
    expect(fileFindingCounts(["a.ts", "b.ts"], [])).toEqual([0, 0]);
  });
});

describe("fileLang", () => {
  it("maps common extensions to their language color key", () => {
    expect(fileLang("src/app.ts")).toBe("ts");
    expect(fileLang("a.tsx")).toBe("ts");
    expect(fileLang("b.js")).toBe("js");
    expect(fileLang("pkg.json")).toBe("json");
    expect(fileLang("x.css")).toBe("css");
    expect(fileLang("i.html")).toBe("html");
    expect(fileLang("readme.md")).toBe("md");
    expect(fileLang("main.py")).toBe("py");
    expect(fileLang("lib.rs")).toBe("rs");
    expect(fileLang("run.sh")).toBe("sh");
  });

  it("is case-insensitive on the extension", () => {
    expect(fileLang("A.TS")).toBe("ts");
  });

  it("falls back to generic for unknown / extensionless names", () => {
    expect(fileLang("notes.xyz")).toBe("generic");
    expect(fileLang("Makefile")).toBe("generic");
  });

  it("handles dotfiles (no extension → generic)", () => {
    expect(fileLang(".gitignore")).toBe("generic");
  });

  it("does not resolve prototype names as extensions", () => {
    expect(fileLang("a.constructor")).toBe("generic");
  });
});
