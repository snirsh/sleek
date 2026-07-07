/**
 * Pure helpers for the Wave-8 diff-line context menu: menu item construction
 * from the anchor/selection/health shape, GitHub permalink URL formatting
 * (including L-ranges), path:line formatting, and blame-card text.
 *
 * SHIPPING MODEL (same as threadsui.ts / selection.ts): these exact functions
 * also run in the browser — client.ts injects each fn.toString() into
 * CLIENT_JS, so every body must stay fully self-contained: no imports, no
 * references to module scope, no TS-only runtime syntax.
 * menuui.test.ts covers the very functions the page runs.
 */

/** A resolved anchor for a single row or a selection range. */
export interface MenuAnchor {
  file: string;
  side: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
}

/** Subset of the health payload consumed by the menu. */
export interface MenuActions {
  blame: boolean;
  open: boolean;
  permalink: string | null;
}

/** One item in the rendered context menu. */
export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
}

/**
 * Build the ordered menu item list from the live/actions/anchor state.
 *
 * Items (in order):
 *  1. copy-pathline  — always present (static mode too)
 *  2. copy-permalink — present when live AND health.actions.permalink non-null
 *  3. blame          — present when live AND health.actions.blame
 *  4. open-source    — present when live AND health.actions.open
 */
export function menuItems(
  live: boolean,
  actions: MenuActions | null,
): MenuItem[] {
  const items: MenuItem[] = [];
  items.push({ id: "copy-pathline", label: "Copy path:line" });
  if (live && actions && actions.permalink) {
    items.push({ id: "copy-permalink", label: "Copy GitHub permalink" });
  }
  if (live && actions && actions.blame) {
    items.push({ id: "blame", label: "Git blame line" });
  }
  if (live && actions && actions.open) {
    items.push({ id: "open-source", label: "See source" });
  }
  return items;
}

/**
 * Format a path:line string for the Copy path:line menu item.
 * Single line: "path:N". Range: "path:start-end".
 */
export function formatPathLine(file: string, startLine: number, endLine: number): string {
  if (startLine === endLine) return file + ":" + startLine;
  return file + ":" + startLine + "-" + endLine;
}

/**
 * Format a GitHub permalink URL.
 * Single line: "...#LN". Range: "...#Lstart-Lend".
 * sha comes from DATA.pr.headSha (RIGHT side) or DATA.pr.baseSha (LEFT side).
 */
export function formatPermalink(
  permalinkBase: string,
  sha: string,
  file: string,
  startLine: number,
  endLine: number,
): string {
  const lineFragment =
    startLine === endLine
      ? "#L" + startLine
      : "#L" + startLine + "-L" + endLine;
  return permalinkBase + "/blob/" + sha + "/" + file + lineFragment;
}

/**
 * Format the text content of a blame card given a BlameInfo object.
 * Output: "<shortSha> <author> · <date> — <summary>"
 * where date is the first 10 chars of an ISO-8601 authorDate.
 */
export function blameCardText(blame: {
  shortSha: string;
  author: string;
  authorDate: string;
  summary: string;
}): string {
  const date = blame.authorDate ? blame.authorDate.slice(0, 10) : "";
  return blame.shortSha + " " + blame.author + " · " + date + " — " + blame.summary;
}

/**
 * Resolve the menu anchor for a single diff row. Returns the anchor with
 * side derived from the row: RIGHT for add/ctx, LEFT for pure del.
 */
export function anchorFromRow(
  file: string,
  row: { t: string; o: number | null; n: number | null },
): MenuAnchor | null {
  const side: "LEFT" | "RIGHT" = row.t === "d" ? "LEFT" : "RIGHT";
  const line = side === "RIGHT" ? row.n : row.o;
  if (line === null) return null;
  return { file: file, side: side, startLine: line, endLine: line };
}

/**
 * Resolve the menu anchor from a selection range (already computed by the
 * client's selectedRows() result). Takes the selection's dominant side:
 * LEFT when ALL selected rows are deletions, RIGHT otherwise.
 */
export function anchorFromSelection(
  file: string,
  rows: readonly { t: string; o: number | null; n: number | null }[],
): MenuAnchor | null {
  if (!rows.length) return null;
  const pureDel = rows.every(function(r) { return r.t === "d"; });
  const side: "LEFT" | "RIGHT" = pureDel ? "LEFT" : "RIGHT";
  const lines: number[] = [];
  for (var i = 0; i < rows.length; i++) {
    var v = side === "RIGHT" ? rows[i].n : rows[i].o;
    if (v !== null) lines.push(v);
  }
  if (!lines.length) return null;
  var start = Math.min.apply(null, lines);
  var end = Math.max.apply(null, lines);
  return { file: file, side: side, startLine: start, endLine: end };
}
