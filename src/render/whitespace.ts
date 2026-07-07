/**
 * Whitespace-only change detection for the "Hide whitespace" toggle.
 *
 * A del/add PAIR (same del-run/add-run pairing as intraline.ts: within a hunk, del i
 * ↔ add i) is whitespace-only when the two lines are identical once ALL whitespace is
 * removed — indentation changes, trailing spaces, spaces-around-operators, and tabs↔
 * spaces all qualify; any non-whitespace character difference does not.
 *
 * html.ts calls wsOnlyRows at render time, tags both rows of each qualifying pair
 * with data-ws="1" (and the w:1 flag in the DATA blob for the client's split view),
 * and puts the pair count on the header control; the client toggle is pure CSS
 * (hide the del row, restyle the add row as context).
 */
import type { DiffRow } from "./diffmodel.ts";

const WS_RE = /\s+/g;

/** True when a and b differ at most in whitespace (equal strings qualify too). */
export function isWsOnly(a: string, b: string): boolean {
  return a.replace(WS_RE, "") === b.replace(WS_RE, "");
}

export interface WsOnlyResult {
  /** Row indices (both the del and the add of each qualifying pair). */
  rows: Set<number>;
  /** Number of qualifying del/add pairs. */
  pairs: number;
}

/**
 * Find whitespace-only del/add pairs in a file's rows (same pairing walk as
 * intraline.ts). Only `type`/`text` of the rows are consulted.
 */
export function wsOnlyRows(rows: readonly Pick<DiffRow, "type" | "text">[]): WsOnlyResult {
  const out: WsOnlyResult = { rows: new Set(), pairs: 0 };
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
    const pairs = Math.min(j - i, k - j);
    for (let p = 0; p < pairs; p++) {
      if (isWsOnly(rows[i + p]!.text, rows[j + p]!.text)) {
        out.rows.add(i + p);
        out.rows.add(j + p);
        out.pairs++;
      }
    }
    i = k;
  }
  return out;
}
