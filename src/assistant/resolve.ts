/**
 * Resolve a selected line range (Anchor) to the Layer that owns it.
 *
 * Per CONTEXT.md, Layers **completely tile the changeset** — every changed line
 * belongs to exactly one Layer — so any Reviewer selection resolves to a single
 * Layer, which is the retrieval unit the Assistant answers within.
 *
 * A Layer owns a selection when one of the Layer's anchors *contains* the
 * selection's start on the same file+side. We match on the selection's
 * `startLine` (rather than requiring full containment) so that a selection that
 * spills a line or two past a hunk boundary still resolves to the Layer that
 * owns where it begins — the overflow case is exactly what the nudge (nudge.ts)
 * flags. If nothing matches, we return null (the selection is outside the
 * changeset, e.g. an unchanged context line).
 */

import type { Anchor, Layer, ReviewScaffold } from "../domain/scaffold.ts";

/** True if `sel`'s start point lies within `anchor` (same file + side). */
function anchorContainsStart(anchor: Anchor, sel: Anchor): boolean {
  return (
    anchor.file === sel.file &&
    anchor.side === sel.side &&
    sel.startLine >= anchor.startLine &&
    sel.startLine <= anchor.endLine
  );
}

/**
 * The Layer that owns the selection, or null if none tiles it.
 *
 * Pure. Since Layers tile the changeset, at most one Layer should match; if the
 * scaffold is well-formed we return the first (and only) match.
 */
export function layerForAnchor(
  scaffold: ReviewScaffold,
  sel: Anchor,
): Layer | null {
  for (const layer of scaffold.layers) {
    if (layer.anchors.some((a) => anchorContainsStart(a, sel))) {
      return layer;
    }
  }
  return null;
}

/**
 * The Layer whose anchors cover the selected range — coverage is OVERLAP, not
 * exact match or full containment: any shared line between an anchor and the
 * [startLine, endLine] range (same file + side) claims the selection. This is
 * the server-facing resolver: a Reviewer drag that spills past a hunk boundary
 * still resolves to the Layer it touches.
 *
 * Pure. Returns null when no anchor overlaps (selection outside the changeset).
 */
export function layerForSelection(
  scaffold: ReviewScaffold,
  file: string,
  side: "LEFT" | "RIGHT",
  startLine: number,
  endLine: number,
): Layer | null {
  for (const layer of scaffold.layers) {
    const overlaps = layer.anchors.some(
      (a) =>
        a.file === file &&
        a.side === side &&
        a.startLine <= endLine &&
        a.endLine >= startLine,
    );
    if (overlaps) return layer;
  }
  return null;
}
