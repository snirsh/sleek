/**
 * Changed-file tree for the left rail's "Files" section (GitHub-style).
 *
 * buildFileTree turns the render-ordered file list into a nested tree: directories
 * become dir nodes, and single-child directory CHAINS collapse into one node whose
 * name is the shared prefix ("packages/app/src" as one dimmed label) — so the tree
 * stays shallow for deep monorepo paths. Within a directory, subdirectories sort
 * before files, both alphabetically; `fi` on each file node is the index of the file
 * in the INPUT order (= the center's card order), which is how tree rows and file
 * cards reference each other in the DOM (data-fi).
 *
 * Pure data (no HTML): html.ts renders the markup, filetree.test.ts covers the shapes.
 */
import type { FileStatus } from "./diffmodel.ts";

export interface TreeFileNode {
  kind: "file";
  /** Basename, the row label. */
  name: string;
  path: string;
  /** Index into the input list = the file card's data-fi. */
  fi: number;
  adds: number;
  dels: number;
  status: FileStatus;
  /** Count of Findings anchored in this file (0 = no badge). Threaded from the
   * caller (html.ts counts anchors by file) — see fileFindingCounts below. */
  findings: number;
}

export interface TreeDirNode {
  kind: "dir";
  /** Directory label; collapsed chains join with "/" ("packages/app/src"). */
  name: string;
  /** Full path from the root to this node. */
  path: string;
  children: TreeNode[];
  /** Subtree rollups (all files anywhere under this dir), shown only when the dir
   * is collapsed so a folded folder still advertises what it hides. */
  fileCount: number;
  findings: number;
  adds: number;
  dels: number;
}

export type TreeNode = TreeDirNode | TreeFileNode;

export interface TreeInputFile {
  path: string;
  adds: number;
  dels: number;
  status: FileStatus;
  /** Optional per-file Finding count (defaults to 0 when absent). */
  findings?: number;
}

interface Builder {
  dirs: Map<string, Builder>;
  files: TreeFileNode[];
}

const newBuilder = (): Builder => ({ dirs: new Map(), files: [] });

export function buildFileTree(files: readonly TreeInputFile[]): TreeNode[] {
  const root = newBuilder();
  files.forEach((f, fi) => {
    const segs = f.path.split("/");
    const base = segs.pop() ?? f.path;
    let node = root;
    for (const seg of segs) {
      let next = node.dirs.get(seg);
      if (!next) {
        next = newBuilder();
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.files.push({
      kind: "file",
      name: base,
      path: f.path,
      fi,
      adds: f.adds,
      dels: f.dels,
      status: f.status,
      findings: f.findings ?? 0,
    });
  });

  const emit = (b: Builder, name: string, path: string): TreeDirNode => {
    // Collapse single-child directory chains ("a" → "a/b" → files becomes "a/b").
    let cur = b;
    let label = name;
    let full = path;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const [seg, child] = [...cur.dirs.entries()][0]!;
      label = label ? `${label}/${seg}` : seg;
      full = full ? `${full}/${seg}` : seg;
      cur = child;
    }
    const children = childrenOf(cur, full);
    // Subtree rollups: sum descendant files (dir children already carry their own
    // subtree sums, so one shallow pass over the immediate children suffices).
    let fileCount = 0;
    let findings = 0;
    let adds = 0;
    let dels = 0;
    for (const c of children) {
      if (c.kind === "dir") {
        fileCount += c.fileCount;
        findings += c.findings;
        adds += c.adds;
        dels += c.dels;
      } else {
        fileCount += 1;
        findings += c.findings;
        adds += c.adds;
        dels += c.dels;
      }
    }
    return { kind: "dir", name: label, path: full, children, fileCount, findings, adds, dels };
  };

  // Siblings sort by their IMMEDIATE segment name (asciibetic, like GitHub), dirs
  // first — never by the collapsed chain label ("app-public" must not interleave
  // with "app/src/…").
  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const childrenOf = (b: Builder, path: string): TreeNode[] => {
    const dirs = [...b.dirs.entries()]
      .sort(([a], [b2]) => byName(a, b2))
      .map(([seg, child]) => emit(child, seg, path ? `${path}/${seg}` : seg));
    const filesSorted = [...b.files].sort((a, b2) => byName(a.name, b2.name));
    return [...dirs, ...filesSorted];
  };

  // The root is not a real node: emit its children directly (chains under the root
  // still collapse — emit() on each top-level dir handles that).
  return childrenOf(root, "");
}

/**
 * Per-file Finding counts, keyed by the file's INPUT index (= card/tree data-fi):
 * one entry per path in `paths`, holding how many Findings across all layers anchor
 * into that file. Anchors into files absent from the diff are ignored (they never
 * reach the tree). Pure — html.ts feeds the result into buildFileTree as `findings`.
 */
export function fileFindingCounts(
  paths: readonly string[],
  layers: readonly { findings: readonly { anchor: { file: string } }[] }[],
): number[] {
  const byPath = new Map<string, number>();
  paths.forEach((p, fi) => byPath.set(p, fi));
  const out: number[] = paths.map(() => 0);
  for (const l of layers) {
    for (const f of l.findings) {
      const fi = byPath.get(f.anchor.file);
      if (fi !== undefined) out[fi]! += 1;
    }
  }
  return out;
}

/** Per-language color family key for a file row's icon: extension-driven with a
 * neutral fallback. html.ts turns the key into a `.ficon.lang-{key}` CSS class
 * (the icon glyph itself is a shared SVG; only the color varies). Kept here
 * (pure, tested) so the ext→lang mapping has one home. */
const LANG_BY_EXT: Record<string, string> = {
  ts: "ts", mts: "ts", cts: "ts", tsx: "ts",
  js: "js", mjs: "js", cjs: "js", jsx: "js",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
  md: "md", mdx: "md", markdown: "md",
  py: "py",
  rs: "rs",
  go: "go",
  rb: "rb",
  sh: "sh", bash: "sh", zsh: "sh",
  yaml: "yaml", yml: "yaml", toml: "yaml",
  sql: "sql",
  java: "java", kt: "java",
  c: "c", h: "c", cpp: "c", hpp: "c", cc: "c",
  swift: "swift", php: "php",
};

/**
 * Language color-family key for a file path, driving the `.ficon.lang-{key}` tint
 * on the file's icon. Dotfiles / unknown / extensionless paths get "generic".
 * Own-key lookup so prototype names ("constructor") never resolve to a lang.
 */
export function fileLang(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (ext && Object.prototype.hasOwnProperty.call(LANG_BY_EXT, ext)) {
    return LANG_BY_EXT[ext]!;
  }
  return "generic";
}

/**
 * file → layers membership index for tree scoping: for each input file (by
 * index — the card/tree data-fi), the layer indexes with ≥1 Anchor in that
 * file, in layer order. file↔layer is many-to-many (a file can host several
 * layers' anchors); anchors into files absent from the diff are ignored.
 *
 * SHIPPING MODEL (same as markdown.ts etc.): this exact function also runs in
 * the browser — client.ts injects fn.toString() into CLIENT_JS, so the body
 * must stay fully self-contained: no imports, no references to module scope,
 * no TS-only runtime syntax.
 */
export function fileLayerIndex(
  paths: readonly string[],
  layers: readonly { anchors: readonly { file: string }[] }[],
): number[][] {
  const byPath = new Map<string, number>();
  paths.forEach((p, fi) => byPath.set(p, fi));
  const out: number[][] = paths.map(() => []);
  layers.forEach((l, li) => {
    const seen = new Set<number>();
    for (const a of l.anchors) {
      const fi = byPath.get(a.file);
      if (fi === undefined || seen.has(fi)) continue;
      seen.add(fi);
      out[fi]!.push(li);
    }
  });
  return out;
}
