/**
 * B5 — Cross-shard finding dedup / aggregation.
 *
 * After pass-2 detail calls, the same finding may appear in multiple shards when
 * overlapping context causes two detail calls to observe the same issue. This
 * module deduplicates findings across shards/layers by normalized-text hash,
 * reusing the same primitives from src/context/dedup.ts (fnv1a32, whitespace
 * normalisation). Identical hash on the same anchor file → keep one, drop duplicates.
 *
 * Normalisation strategy: strip punctuation and whitespace, lowercase — similar to
 * normaliseHunk but tuned for prose finding text (not diff hunks).
 */

import { fnv1a32 } from "../context/dedup.ts";
import type { Finding } from "../domain/scaffold.ts";

// ---------------------------------------------------------------------------
// Text normalisation for finding prose
// ---------------------------------------------------------------------------

/**
 * Normalise finding text for dedup hashing.
 * - Lowercase
 * - Strip punctuation
 * - Collapse whitespace runs to a single space
 * - Trim
 *
 * This is intentionally aggressive so near-identical findings (same issue,
 * slightly different phrasing) collapse to the same hash.
 */
export function normaliseFindingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Dedup key
// ---------------------------------------------------------------------------

/**
 * A dedup key is the FNV-1a hash of (normalised text + anchor file).
 * We anchor dedup on the file so a finding about foo.ts and an identical-text
 * finding about bar.ts are treated as distinct.
 */
export function findingDedupKey(finding: Finding): string {
  const normalised = normaliseFindingText(finding.text);
  return fnv1a32(`${finding.anchor.file}::${normalised}`);
}

// ---------------------------------------------------------------------------
// Public dedup
// ---------------------------------------------------------------------------

/**
 * Deduplicate findings across shards/layers by normalized-text hash.
 * Within each group of identical-hash findings, the first occurrence (array
 * order, i.e. by layer/shard order) is kept; subsequent duplicates are dropped.
 *
 * Returns the de-duplicated finding list, preserving original order for
 * non-duplicate entries.
 */
export function dedupFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const f of findings) {
    const key = findingDedupKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(f);
  }
  return result;
}
