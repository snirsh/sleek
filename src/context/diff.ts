/**
 * Parse a unified diff into changed regions, expressed in Anchor coordinates
 * (ADR-0004): a `side` of RIGHT means new-file line numbers (added lines), LEFT
 * means old-file line numbers (deleted lines). These regions are the raw material
 * the Scaffolder (M3) tiles into Layers, so their line ranges must be exact.
 *
 * A single hunk can produce up to two regions: one RIGHT region covering its added
 * lines and one LEFT region covering its deleted lines. Runs of consecutive added
 * (or deleted) lines within a hunk are coalesced into a single contiguous range; a
 * hunk with interleaved add/delete blocks yields one region per side spanning from
 * the first to the last changed line on that side. Context-only hunks yield nothing.
 */

export type Side = "LEFT" | "RIGHT";

export interface ChangedRegion {
  file: string;
  side: Side;
  startLine: number;
  endLine: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Extract the target path from a `+++ b/path` line, stripping the `a/`/`b/` prefix
 * git adds. `/dev/null` (a pure deletion's `+++`) returns null.
 */
function parsePlusPlusPlus(line: string): string | null {
  const raw = line.slice(4).trim();
  return stripAbPrefix(raw);
}

function parseMinusMinusMinus(line: string): string | null {
  const raw = line.slice(4).trim();
  return stripAbPrefix(raw);
}

function stripAbPrefix(raw: string): string | null {
  if (raw === "/dev/null") return null;
  if (raw.startsWith("a/") || raw.startsWith("b/")) return raw.slice(2);
  return raw;
}

/**
 * Parse a unified diff (as produced by `git diff` / `gh pr diff`) into the added
 * (RIGHT) and deleted (LEFT) line ranges per hunk.
 */
export function parseChangedRegions(unifiedDiff: string): ChangedRegion[] {
  const regions: ChangedRegion[] = [];
  const lines = unifiedDiff.split("\n");

  // The file a hunk applies to. We prefer the RIGHT-side path (`+++ b/...`) for both
  // sides so LEFT (deleted) regions of a renamed/deleted file still key off a stable
  // path; a pure deletion (RIGHT is /dev/null) falls back to the LEFT path.
  let rightPath: string | null = null;
  let leftPath: string | null = null;

  // State for the hunk currently being scanned.
  let inHunk = false;
  let oldLine = 0; // next old-file line number to assign to a LEFT line
  let newLine = 0; // next new-file line number to assign to a RIGHT line
  let addStart = 0;
  let addEnd = 0;
  let delStart = 0;
  let delEnd = 0;

  const flushHunk = () => {
    if (!inHunk) return;
    const file = rightPath ?? leftPath;
    if (file !== null) {
      if (addEnd >= addStart && addStart > 0) {
        regions.push({ file, side: "RIGHT", startLine: addStart, endLine: addEnd });
      }
      if (delEnd >= delStart && delStart > 0) {
        // A deleted region keys off the file's path as well; when the whole file is
        // deleted, rightPath is null and we fall back to leftPath above.
        regions.push({
          file: leftPath ?? file,
          side: "LEFT",
          startLine: delStart,
          endLine: delEnd,
        });
      }
    }
    inHunk = false;
    addStart = addEnd = delStart = delEnd = 0;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      flushHunk();
      rightPath = null;
      leftPath = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      flushHunk();
      leftPath = parseMinusMinusMinus(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      rightPath = parsePlusPlusPlus(line);
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      flushHunk();
      inHunk = true;
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      continue;
    }

    if (!inHunk) continue;

    // Within a hunk, classify each line by its leading marker.
    const marker = line[0];
    if (marker === "+") {
      if (addStart === 0) addStart = newLine;
      addEnd = newLine;
      newLine++;
    } else if (marker === "-") {
      if (delStart === 0) delStart = oldLine;
      delEnd = oldLine;
      oldLine++;
    } else if (marker === "\\") {
      // "\ No newline at end of file" — not a real line, advance nothing.
    } else {
      // Context line (starts with a space) or empty line inside the hunk body.
      oldLine++;
      newLine++;
    }
  }

  flushHunk();
  return regions;
}
