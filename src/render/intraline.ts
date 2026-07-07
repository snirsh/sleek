/**
 * Word-level (token-LCS) intraline diff for paired del/add rows.
 *
 * Pairing rule: within a hunk, a run of N consecutive del rows immediately followed
 * by a run of M consecutive add rows pairs del i with add i — but ONLY when N === M.
 * Unequal runs (2 del / 3 add, …) have no reliable line correspondence: index pairing
 * matches lines that aren't counterparts (e.g. a rewrapped comment block) and the
 * "marks" become noise, so the whole run gets plain full-line coloring instead.
 * Context rows and hunk headers break runs.
 *
 * Lines diff at TOKEN granularity — word runs ([letters/digits/_/$]+), whitespace
 * runs, single punctuation — so a mark can never start or end mid-word (GitHub
 * behavior; char-level LCS marked fragments like "tripOrphanArrayElements").
 *
 * A pair is left unmarked (null) when any of these bail-outs trip:
 *   - either line exceeds MAX_LINE chars;
 *   - similarity — 2·(chars in LCS-matched tokens) / (non-ws chars of both lines) —
 *     is below MIN_SIMILARITY: the lines are "different lines", not "one edited
 *     line". Char weighting matters: `stripOrphanArrayElements?: boolean` vs
 *     `isResponsive?: boolean` share 3 of ~4 tokens but only 9 of 54 chars — the
 *     shared `?: boolean` suffix must not glue unrelated fields together;
 *   - the result is confetti: more than MAX_SEGMENTS mark ranges on a side;
 *   - the change dominates a side: unmatched non-ws chars exceed MAX_MARKED_FRACTION
 *     of that side's non-ws chars ("too different, no intraline").
 *
 * Changed ranges separated by fewer than MERGE_GAP unchanged chars are merged (the
 * swallowed gap is always whole short tokens, so boundaries stay on token edges).
 *
 * Output is offset ranges into the RAW row text (del rows → ranges in old text, add
 * rows → ranges in new text); html.ts hands them to highlight.renderCodeHtml, which
 * wraps them in <mark class="ln-del"|"ln-add"> during emission.
 */

import type { DiffRow } from "./diffmodel.ts";
import type { MarkRange } from "./highlight.ts";

export type { MarkRange } from "./highlight.ts";

const MAX_LINE = 500;
const MIN_SIMILARITY = 0.5;
const MERGE_GAP = 3;
const MAX_SEGMENTS = 4;
const MAX_MARKED_FRACTION = 0.6;

// Word runs (unicode letters/digits plus _ and $), whitespace runs, or a single
// other char. Everything matches, so tokens tile the line exactly.
const TOKEN_RE = /[\p{L}\p{N}_$]+|\s+|./gu;

interface Token {
  text: string;
  start: number;
  /** Whitespace tokens don't count toward similarity or dominance. */
  ws: boolean;
}

function tokenize(line: string): Token[] {
  const out: Token[] = [];
  for (const m of line.matchAll(TOKEN_RE)) {
    out.push({ text: m[0], start: m.index, ws: /^\s/.test(m[0]) });
  }
  return out;
}

interface PairDiff {
  del: MarkRange[];
  add: MarkRange[];
}

/** Merge ranges separated by < MERGE_GAP unchanged chars; drop empties. */
function mergeRanges(ranges: MarkRange[]): MarkRange[] {
  const out: MarkRange[] = [];
  for (const r of ranges) {
    if (r.start >= r.end) continue;
    const last = out[out.length - 1];
    if (last && r.start - last.end < MERGE_GAP) last.end = r.end;
    else out.push({ ...r });
  }
  return out;
}

/** Sum of non-whitespace chars across tokens (matched === undefined) or across the
 *  tokens whose matched flag is false (the changed ones). */
function nonWsChars(tokens: Token[], matched?: boolean[]): number {
  let sum = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.ws) continue;
    if (matched && matched[i]) continue;
    sum += tokens[i]!.text.length;
  }
  return sum;
}

/** Unmatched-token runs → char ranges into the raw line, merged. */
function rangesOf(tokens: Token[], matched: boolean[]): MarkRange[] {
  const out: MarkRange[] = [];
  let start = -1;
  for (let i = 0; i <= tokens.length; i++) {
    const changed = i < tokens.length && !matched[i];
    if (changed && start === -1) start = tokens[i]!.start;
    if (!changed && start !== -1) {
      const prev = tokens[i - 1]!;
      out.push({ start, end: prev.start + prev.text.length });
      start = -1;
    }
  }
  return mergeRanges(out);
}

/**
 * Token-level LCS diff of one del/add line pair. Null = "leave the pair unmarked"
 * (over-long, too dissimilar, too fragmented, or too dominated by the change).
 * Common token prefix/suffix are trimmed first, so the DP table only covers the
 * edited middle.
 */
export function tokenDiff(a: string, b: string): PairDiff | null {
  if (a.length > MAX_LINE || b.length > MAX_LINE) return null;
  if (a === b) return { del: [], add: [] };

  const ta = tokenize(a);
  const tb = tokenize(b);

  // Trim common token prefix/suffix (suffix must not overlap the prefix).
  let pre = 0;
  const max = Math.min(ta.length, tb.length);
  while (pre < max && ta[pre]!.text === tb[pre]!.text) pre++;
  let suf = 0;
  while (suf < max - pre && ta[ta.length - 1 - suf]!.text === tb[tb.length - 1 - suf]!.text) suf++;

  // matchedA/B[i] = token i participates in the LCS. Prefix/suffix are matched.
  const matchedA = new Array<boolean>(ta.length).fill(false);
  const matchedB = new Array<boolean>(tb.length).fill(false);
  for (let i = 0; i < pre; i++) {
    matchedA[i] = true;
    matchedB[i] = true;
  }
  for (let i = 0; i < suf; i++) {
    matchedA[ta.length - 1 - i] = true;
    matchedB[tb.length - 1 - i] = true;
  }

  // LCS DP over the middle tokens (each side ≤ MAX_LINE tokens).
  const n = ta.length - suf - pre;
  const m = tb.length - suf - pre;
  if (n > 0 && m > 0) {
    const width = m + 1;
    const dp = new Uint16Array((n + 1) * width);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i * width + j] =
          ta[pre + i - 1]!.text === tb[pre + j - 1]!.text
            ? dp[(i - 1) * width + (j - 1)]! + 1
            : Math.max(dp[(i - 1) * width + j]!, dp[i * width + (j - 1)]!);
      }
    }
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
      if (ta[pre + i - 1]!.text === tb[pre + j - 1]!.text) {
        matchedA[pre + i - 1] = true;
        matchedB[pre + j - 1] = true;
        i--;
        j--;
      } else if (dp[(i - 1) * width + j]! >= dp[i * width + (j - 1)]!) i--;
      else j--;
    }
  }

  // Similarity gate, char-weighted over non-whitespace tokens. Matched tokens have
  // identical text, so summing one side's matched chars stands for both.
  const totalA = nonWsChars(ta);
  const totalB = nonWsChars(tb);
  const changedA = nonWsChars(ta, matchedA);
  const changedB = nonWsChars(tb, matchedB);
  if (totalA + totalB > 0) {
    const matchedChars = totalA - changedA; // = totalB - changedB
    if ((2 * matchedChars) / (totalA + totalB) < MIN_SIMILARITY) return null;
  }

  const del = rangesOf(ta, matchedA);
  const add = rangesOf(tb, matchedB);

  // Fragmentation gate: confetti reads worse than plain full-line coloring.
  if (del.length > MAX_SEGMENTS || add.length > MAX_SEGMENTS) return null;
  // Dominance gate: when most of a side changed, marks add nothing but noise.
  if (totalA > 0 && changedA / totalA > MAX_MARKED_FRACTION) return null;
  if (totalB > 0 && changedB / totalB > MAX_MARKED_FRACTION) return null;

  return { del, add };
}

/**
 * Compute intraline mark ranges for every pairable del/add row in a file's rows.
 * Returns rowIndex → ranges (into that row's raw text). Rows without an entry get
 * no marks. Only `type`/`text` of the rows are consulted.
 */
export function intralineMarks(
  rows: readonly Pick<DiffRow, "type" | "text">[],
): Map<number, MarkRange[]> {
  const marks = new Map<number, MarkRange[]>();
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.type !== "del") {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.type === "del") j++;
    let k = j;
    while (k < rows.length && rows[k]!.type === "add") k++;
    // Only equal-length runs have a trustworthy i↔i correspondence; skewed runs
    // (rewrapped prose, inserted lines) pair non-counterparts and produce noise.
    if (j - i !== k - j) {
      i = k;
      continue;
    }
    const pairs = j - i;
    for (let p = 0; p < pairs; p++) {
      const d = tokenDiff(rows[i + p]!.text, rows[j + p]!.text);
      if (!d) continue;
      if (d.del.length) marks.set(i + p, d.del);
      if (d.add.length) marks.set(j + p, d.add);
    }
    i = k;
  }
  return marks;
}
