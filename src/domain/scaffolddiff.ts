import type { Anchor, Layer, ReviewScaffold } from "./scaffold.ts";

/**
 * Wave 4B — "Changes since last scaffold" (versions-lite). A pure structural
 * diff between two Review Scaffolds of the SAME PR at different head SHAs, as
 * they accumulate in the store (src/store/store.ts). Computed server-side by
 * GET /api/versions/diff and rendered by the client's versions panel
 * (src/render/versionsui.ts turns this shape into a list model).
 *
 * Deliberately LITE: honest counts + itemized added/removed/changed lists, no
 * content-level merging or three-way anything. The matching heuristics below
 * are best-effort and documented inline; when in doubt an item lands in
 * added+removed rather than pretending to track identity.
 */

/** How a Layer of one version shows up in the diff lists. */
export interface LayerRef {
  /** The Layer's id — the Scaffolder's semantic name (the schema has no separate title). */
  id: string;
  /** Distinct anchor files, sorted — the Layer's footprint at a glance. */
  files: string[];
  findingCount: number;
}

/** A Layer present in both versions but not identical. */
export interface LayerChange {
  /** Id in the old version. */
  oldId: string;
  /** Id in the new version (differs from oldId only for overlap-matched layers). */
  newId: string;
  /** True when the two ids differ — the layer was renamed (matched by file overlap). */
  renamed: boolean;
  /** True when the anchor sets differ — the layer covers different lines/files now. */
  reanchored: boolean;
}

/** A Finding in one version's terms, attributed to its owning Layer. */
export interface FindingRef {
  layerId: string;
  concern: string;
  severity: string;
  text: string;
  anchor: Anchor;
}

/** A Finding whose body+concern survived but whose Anchor moved. */
export interface MovedFinding {
  layerId: string;
  concern: string;
  severity: string;
  text: string;
  from: Anchor;
  to: Anchor;
}

/** The count summary the UI shows up top. Every list below has its count here. */
export interface ScaffoldDiffCounts {
  layersAdded: number;
  layersRemoved: number;
  layersChanged: number;
  findingsAdded: number;
  findingsRemoved: number;
  findingsMoved: number;
  filesEntering: number;
  filesLeaving: number;
}

/** The structured "what changed" summary between two scaffold versions. */
export interface ScaffoldDiff {
  counts: ScaffoldDiffCounts;
  layers: {
    added: LayerRef[];
    removed: LayerRef[];
    changed: LayerChange[];
  };
  findings: {
    added: FindingRef[];
    removed: FindingRef[];
    moved: MovedFinding[];
  };
  files: {
    /** Files in the new version's changeset but not the old one's. Sorted. */
    entering: string[];
    /** Files in the old version's changeset but not the new one's. Sorted. */
    leaving: string[];
  };
}

/** Canonical key for one Anchor (identity comparison, not display). */
function anchorKey(a: Anchor): string {
  return a.file + "|" + a.side + "|" + a.startLine + "|" + a.endLine;
}

/** Canonical key for a Layer's whole anchor set (order-insensitive). */
function anchorSetKey(anchors: readonly Anchor[]): string {
  return anchors.map(anchorKey).sort().join("\n");
}

/** Distinct anchor files of a Layer, sorted. */
function layerFiles(layer: Layer): string[] {
  return [...new Set(layer.anchors.map((a) => a.file))].sort();
}

function layerRef(layer: Layer): LayerRef {
  return {
    id: layer.id,
    files: layerFiles(layer),
    findingCount: layer.findings.length,
  };
}

/** Every file the scaffold touches: layer anchors + finding anchors. */
function fileSet(scaffold: ReviewScaffold): Set<string> {
  const files = new Set<string>();
  for (const layer of scaffold.layers) {
    for (const a of layer.anchors) files.add(a.file);
    for (const f of layer.findings) files.add(f.anchor.file);
  }
  return files;
}

/** |A ∩ B| / |A ∪ B| over two file sets (0 when both are empty). */
function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const f of sa) if (sb.has(f)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** A matched (old, new) Layer pair produced by matchLayers. */
interface LayerPair {
  oldLayer: Layer;
  newLayer: Layer;
}

/**
 * Match layers across two versions, best effort:
 *
 *  1. Exact id match — the Layer id is the Scaffolder's semantic name (e.g.
 *     "error-handling"); the schema has no separate title, so the id IS the
 *     closest thing to one, and a stable id across re-scaffolds is the
 *     strongest identity signal available.
 *  2. Remaining layers pair GREEDILY by highest anchor-FILE Jaccard overlap
 *     (> 0): a renamed layer usually still covers mostly the same files.
 *     Greedy (best pair first) rather than optimal assignment — layer counts
 *     are tiny and ties are arbitrary anyway; versions-lite.
 *  3. Whatever remains is added (new only) / removed (old only).
 */
function matchLayers(
  oldLayers: readonly Layer[],
  newLayers: readonly Layer[],
): { pairs: LayerPair[]; added: Layer[]; removed: Layer[] } {
  const pairs: LayerPair[] = [];
  const oldLeft = new Map(oldLayers.map((l) => [l.id, l]));
  const newLeft = new Map(newLayers.map((l) => [l.id, l]));

  // Pass 1: exact id.
  for (const [id, oldLayer] of oldLeft) {
    const newLayer = newLeft.get(id);
    if (!newLayer) continue;
    pairs.push({ oldLayer, newLayer });
    oldLeft.delete(id);
    newLeft.delete(id);
  }

  // Pass 2: greedy best file overlap among the leftovers.
  const candidates: { score: number; oldLayer: Layer; newLayer: Layer }[] = [];
  for (const oldLayer of oldLeft.values()) {
    for (const newLayer of newLeft.values()) {
      const score = jaccard(layerFiles(oldLayer), layerFiles(newLayer));
      if (score > 0) candidates.push({ score, oldLayer, newLayer });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (!oldLeft.has(c.oldLayer.id) || !newLeft.has(c.newLayer.id)) continue;
    pairs.push({ oldLayer: c.oldLayer, newLayer: c.newLayer });
    oldLeft.delete(c.oldLayer.id);
    newLeft.delete(c.newLayer.id);
  }

  return {
    pairs,
    added: [...newLeft.values()],
    removed: [...oldLeft.values()],
  };
}

/** One version's findings flattened with their layer attribution. */
interface AttributedFinding {
  layerId: string;
  concern: string;
  severity: string;
  text: string;
  anchor: Anchor;
  used: boolean;
}

function flattenFindings(scaffold: ReviewScaffold): AttributedFinding[] {
  const out: AttributedFinding[] = [];
  for (const layer of scaffold.layers) {
    for (const f of layer.findings) {
      out.push({
        layerId: layer.id,
        concern: f.concern,
        severity: f.severity,
        text: f.text,
        anchor: f.anchor,
        used: false,
      });
    }
  }
  return out;
}

/**
 * Diff two Review Scaffolds (old → new) of the same PR at different head SHAs.
 *
 * Layers: matched via {@link matchLayers}; a matched pair is "changed" when it
 * was renamed (matched by overlap under a different id) or reanchored (anchor
 * sets differ). Identical pairs are omitted entirely.
 *
 * Findings: matched in two passes, layer-agnostic (a finding that migrated to
 * a differently-named layer still matches) but each ref CARRIES its layer id:
 *  1. exact (concern, text, anchor) → unchanged, dropped from the diff;
 *  2. same (concern, text) at a different anchor → "moved" (from → to).
 * Leftovers are added (new only) / removed (old only). Severity is display
 * metadata, not identity: a severity-only change reads as added+removed —
 * honest for versions-lite.
 *
 * Files: the union of anchor files (layer + finding anchors) per version;
 * entering/leaving are the set differences, sorted.
 */
export function diffScaffolds(
  oldScaffold: ReviewScaffold,
  newScaffold: ReviewScaffold,
): ScaffoldDiff {
  // ── Layers ──
  const matched = matchLayers(oldScaffold.layers, newScaffold.layers);
  const changed: LayerChange[] = [];
  for (const { oldLayer, newLayer } of matched.pairs) {
    const renamed = oldLayer.id !== newLayer.id;
    const reanchored = anchorSetKey(oldLayer.anchors) !== anchorSetKey(newLayer.anchors);
    if (renamed || reanchored) {
      changed.push({ oldId: oldLayer.id, newId: newLayer.id, renamed, reanchored });
    }
  }
  const layersAdded = matched.added.map(layerRef);
  const layersRemoved = matched.removed.map(layerRef);

  // ── Findings ──
  const oldFindings = flattenFindings(oldScaffold);
  const newFindings = flattenFindings(newScaffold);
  const identityKey = (f: AttributedFinding): string =>
    f.concern + " " + f.text;

  // Pass 1: exact (concern, text, anchor) — unchanged, marked used on both sides.
  const oldByExact = new Map<string, AttributedFinding[]>();
  for (const f of oldFindings) {
    const k = identityKey(f) + " " + anchorKey(f.anchor);
    const bucket = oldByExact.get(k);
    if (bucket) bucket.push(f);
    else oldByExact.set(k, [f]);
  }
  for (const f of newFindings) {
    const k = identityKey(f) + " " + anchorKey(f.anchor);
    const bucket = oldByExact.get(k);
    const match = bucket?.find((o) => !o.used);
    if (match) {
      match.used = true;
      f.used = true;
    }
  }

  // Pass 2: same (concern, text), different anchor → moved.
  const moved: MovedFinding[] = [];
  const oldByIdentity = new Map<string, AttributedFinding[]>();
  for (const f of oldFindings) {
    if (f.used) continue;
    const bucket = oldByIdentity.get(identityKey(f));
    if (bucket) bucket.push(f);
    else oldByIdentity.set(identityKey(f), [f]);
  }
  for (const f of newFindings) {
    if (f.used) continue;
    const match = oldByIdentity.get(identityKey(f))?.find((o) => !o.used);
    if (!match) continue;
    match.used = true;
    f.used = true;
    moved.push({
      layerId: f.layerId,
      concern: f.concern,
      severity: f.severity,
      text: f.text,
      from: match.anchor,
      to: f.anchor,
    });
  }

  const toRef = (f: AttributedFinding): FindingRef => ({
    layerId: f.layerId,
    concern: f.concern,
    severity: f.severity,
    text: f.text,
    anchor: f.anchor,
  });
  const findingsAdded = newFindings.filter((f) => !f.used).map(toRef);
  const findingsRemoved = oldFindings.filter((f) => !f.used).map(toRef);

  // ── Files ──
  const oldFiles = fileSet(oldScaffold);
  const newFiles = fileSet(newScaffold);
  const entering = [...newFiles].filter((f) => !oldFiles.has(f)).sort();
  const leaving = [...oldFiles].filter((f) => !newFiles.has(f)).sort();

  return {
    counts: {
      layersAdded: layersAdded.length,
      layersRemoved: layersRemoved.length,
      layersChanged: changed.length,
      findingsAdded: findingsAdded.length,
      findingsRemoved: findingsRemoved.length,
      findingsMoved: moved.length,
      filesEntering: entering.length,
      filesLeaving: leaving.length,
    },
    layers: { added: layersAdded, removed: layersRemoved, changed },
    findings: { added: findingsAdded, removed: findingsRemoved, moved },
    files: { entering, leaving },
  };
}
