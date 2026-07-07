# Anchors use GitHub review-comment coordinates

Every Layer and Finding attaches via an **Anchor**: `{file, side, startLine, endLine}`,
where `side` is LEFT (old file) or RIGHT (new file). Layers tile the changeset in this
coordinate space; the diff-viewer's line selection produces the same shape.

## Why

A PR has three coordinate systems — old-file lines, new-file lines, and diff/hunk positions.
Picking the wrong one renders Findings on the wrong lines and breaks selection→Layer lookup.
The `{file, side, line}` model is what GitHub itself uses for review comments: it is
unambiguous, it can address **deleted** lines (side=LEFT) which new-file-only coordinates
cannot, and it composes if Sleek ever posts findings back to GitHub.

## Considered and rejected

- **New-file line numbers only**: simplest, but cannot anchor to deleted lines.
- **Diff/hunk positions**: uniform over add/delete/context, but forces every consumer to
  reason in diff-space and doesn't survive a re-scaffold at a new head SHA cleanly.
