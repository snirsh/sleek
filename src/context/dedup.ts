/**
 * B2 — Hunk dedup by normalized hash.
 *
 * After parseChangedRegions() produces a flat list, some regions may carry
 * identical (or near-identical) hunks — e.g. a mechanical rename applied to
 * dozens of files, a repeated boilerplate insertion, or a generated block that
 * slipped through noise stripping. Reviewing each copy independently wastes
 * tokens and inflates the layer count.
 *
 * This module:
 *   1. Normalises each region's hunk text deterministically (whitespace only;
 *      no tree-sitter rename needed — one-token diffs hash differently and stay
 *      independent, as tested).
 *   2. Hashes with a stable, non-crypto FNV-1a 32-bit hash.
 *   3. Groups regions by hash. Groups with only one member are left untouched.
 *   4. For groups with >=2 members: the first region (diff order) is the
 *      REPRESENTATIVE; the rest become SIBLINGS that carry a machine note and are
 *      excluded from context building + detail review.
 *   5. Exposes a DedupMap so the render layer can echo the representative's
 *      findings back onto its siblings (anchored per file).
 *
 * The sibling note format is deterministic so snapshots stay stable:
 *   "same edit as <file>:<startLine>-<endLine>; N total occurrence(s)"
 */

import type { ChangedRegion } from "./diff.ts";

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a hunk body for hashing. Strategy: strip leading/trailing whitespace
 * from every line, collapse runs of internal spaces/tabs to a single space, then
 * join lines with "\n". This normalises indentation differences while preserving
 * token identity — a one-token difference (e.g. different identifier) produces a
 * different hash and the regions remain independently reviewed.
 */
export function normaliseHunk(hunkText: string): string {
  return hunkText
    .split("\n")
    .map((l) => l.trim().replace(/[ \t]+/g, " "))
    .join("\n");
}

// ---------------------------------------------------------------------------
// FNV-1a 32-bit hash (stable, non-crypto)
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash of a UTF-8 string. Returns a hex string.
 * Chosen because it is fast, has no dependencies, and is deterministic
 * across all JS runtimes (pure integer arithmetic).
 */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Multiply by FNV prime 0x01000193 using 32-bit unsigned arithmetic.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Dedup types
// ---------------------------------------------------------------------------

/**
 * A region that has been identified as a duplicate. Carries the identity of
 * the representative and a machine note for the reader / detail prompt.
 */
export interface SiblingRegion {
  /** The original region. */
  region: ChangedRegion;
  /** Anchor key of the representative: "<file> <side> <start>-<end>". */
  representativeKey: string;
  /** Human-readable note to embed in prompts / rendered review. */
  note: string;
  /** The normalised hash shared with the representative. */
  hash: string;
}

/**
 * Output of dedupRegions. `unique` is the de-duplicated list to feed into
 * context building (representatives only). `siblings` maps each sibling
 * region (by anchor key) to its metadata; `groupSize` gives the full group
 * size (representative + siblings) for each hash group.
 */
export interface DedupResult {
  /** De-duplicated regions — one representative per hash group, plus all singletons. */
  unique: ChangedRegion[];
  /** Sibling regions, keyed by anchorKey(region). */
  siblings: Map<string, SiblingRegion>;
  /** Hash → total occurrences (including representative). Only populated for groups >=2. */
  groupSize: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Anchor key (same logic as scaffolder.ts, duplicated to avoid coupling)
// ---------------------------------------------------------------------------

function anchorKey(r: ChangedRegion): string {
  return `${r.file} ${r.side} ${r.startLine} ${r.endLine}`;
}

function representativeKey(r: ChangedRegion): string {
  return `${r.file}:${r.startLine}-${r.endLine}`;
}

// ---------------------------------------------------------------------------
// Core dedup
// ---------------------------------------------------------------------------

/**
 * Extract the hunk lines from a region's portion of the unified diff.
 *
 * When a full unified diff string is supplied, we slice out the lines that
 * belong to this region so the hash captures actual content rather than just
 * the coordinate metadata. If no diff is supplied (or no matching lines are
 * found) we fall back to hashing the anchor key itself — this is non-empty and
 * stable but means two regions at different coordinates never collide (safe
 * conservative fallback).
 */
export function extractHunkLines(
  region: ChangedRegion,
  unifiedDiff: string,
): string {
  // Walk the diff looking for the file's hunk that covers this region.
  // We return as soon as we've collected the lines from the target file so later
  // `diff --git` blocks (for other files) do not reset our results.
  const lines = unifiedDiff.split("\n");
  let inFile = false;
  const hunkLines: string[] = [];
  let newLine = 0;
  let oldLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      // If we were already in the target file, stop — we have all lines.
      if (inFile && hunkLines.length > 0) break;
      inFile = false;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      const filePath = line.slice(6).trim();
      inFile = filePath === region.file;
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      inFile = false;
      continue;
    }
    if (!inFile) continue;

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (region.side === "RIGHT") {
      if (line.startsWith("+")) {
        if (newLine >= region.startLine && newLine <= region.endLine) {
          hunkLines.push(line);
        }
        newLine++;
      } else if (line.startsWith("-")) {
        oldLine++;
      } else if (!line.startsWith("\\")) {
        oldLine++;
        newLine++;
      }
    } else {
      // LEFT side
      if (line.startsWith("-")) {
        if (oldLine >= region.startLine && oldLine <= region.endLine) {
          hunkLines.push(line);
        }
        oldLine++;
      } else if (line.startsWith("+")) {
        newLine++;
      } else if (!line.startsWith("\\")) {
        oldLine++;
        newLine++;
      }
    }
  }

  if (hunkLines.length === 0) {
    // Fallback: use the anchor key so the hash is still deterministic + unique.
    return anchorKey(region);
  }
  return hunkLines.join("\n");
}

/**
 * Group changed regions by normalised-hunk hash and return the dedup result.
 *
 * @param regions   The output of parseChangedRegions — order preserved.
 * @param unifiedDiff  The raw unified diff from the ChangeSet. Used to extract
 *                  hunk content for hashing. When empty string is passed the
 *                  anchor key is used as the hash input (no dedup possible).
 */
export function dedupRegions(
  regions: ChangedRegion[],
  unifiedDiff: string,
): DedupResult {
  // Step 1: compute the normalised hash for every region.
  const hashes: string[] = regions.map((r) => {
    const hunkText = extractHunkLines(r, unifiedDiff);
    return fnv1a32(normaliseHunk(hunkText));
  });

  // Step 2: group regions by hash (preserving diff order).
  const groupsByHash = new Map<string, number[]>(); // hash → region indices
  for (let i = 0; i < regions.length; i++) {
    const h = hashes[i]!;
    const group = groupsByHash.get(h);
    if (group) {
      group.push(i);
    } else {
      groupsByHash.set(h, [i]);
    }
  }

  // Step 3: build result.
  const unique: ChangedRegion[] = [];
  const siblings = new Map<string, SiblingRegion>();
  const groupSize = new Map<string, number>();

  for (const [hash, indices] of groupsByHash) {
    if (indices.length === 1) {
      unique.push(regions[indices[0]!]!);
      continue;
    }

    // Multi-occurrence group: first in diff order is representative.
    groupSize.set(hash, indices.length);
    const repIdx = indices[0]!;
    const rep = regions[repIdx]!;
    unique.push(rep);

    const repKey = representativeKey(rep);

    for (let s = 1; s < indices.length; s++) {
      const sibRegion = regions[indices[s]!]!;
      const note =
        `same edit as ${repKey}; ${indices.length} total occurrence(s)`;
      siblings.set(anchorKey(sibRegion), {
        region: sibRegion,
        representativeKey: anchorKey(rep),
        note,
        hash,
      });
    }
  }

  return { unique, siblings, groupSize };
}

// ---------------------------------------------------------------------------
// Finding echo
// ---------------------------------------------------------------------------

/**
 * Echo findings from a representative region onto its siblings.
 *
 * Given the assembled findings for the representative (keyed by their anchor
 * key), this returns a synthetic Finding-like list for each sibling anchor.
 * The anchor is rewritten to the sibling's location; the text is prefixed with
 * a machine note so reviewers can see it is an echo.
 *
 * This is called AFTER phase 3b completes, when we have real Finding objects.
 */
export interface EchoableFinding {
  anchor: {
    file: string;
    side: "LEFT" | "RIGHT";
    startLine: number;
    endLine: number;
  };
  concern: string;
  severity: string;
  text: string;
}

export function echoFindingsToSiblings(
  representativeFindingsByAnchorKey: Map<string, EchoableFinding[]>,
  siblings: Map<string, SiblingRegion>,
): Map<string, EchoableFinding[]> {
  const result = new Map<string, EchoableFinding[]>();

  for (const [sibKey, sib] of siblings) {
    const repFindings = representativeFindingsByAnchorKey.get(sib.representativeKey) ?? [];
    if (repFindings.length === 0) continue;

    const echoed: EchoableFinding[] = repFindings.map((f) => ({
      ...f,
      anchor: {
        file: sib.region.file,
        side: sib.region.side,
        startLine: sib.region.startLine,
        endLine: sib.region.endLine,
      },
      text: `[echo from ${sib.representativeKey}] ${f.text}`,
    }));

    result.set(sibKey, echoed);
  }

  return result;
}
