/**
 * Pure helpers for the Wave-LSP client UI (hover tooltips, peek definition)
 * — src/render/client.ts wires them to the DOM.
 *
 * SHIPPING MODEL (same as markdown.ts / splitmodel.ts): these exact functions
 * also run in the browser — client.ts injects each fn.toString() into
 * CLIENT_JS, so every body must stay fully self-contained: no imports, no
 * references to module scope, no TS-only runtime syntax. lsputil.test.ts
 * covers the very functions the page runs.
 *
 * Coordinates follow src/lsp/types.ts: lines and columns are 1-BASED.
 */

/**
 * Minimal structural view of a DOM node — keeps textOffsetWithin unit-testable
 * in node (mock trees) while accepting real Nodes in the browser unchanged.
 * nodeType 3 is a text node (Node.TEXT_NODE).
 */
export interface NodeLike {
  nodeType: number;
  nodeValue?: string | null;
  childNodes?: ArrayLike<NodeLike>;
}

/**
 * Raw-text offset of (target text node, offsetInTarget) within root's
 * textContent: walks text nodes in document order, accumulating lengths until
 * target is reached. Returns null when target is not a descendant of root.
 * Used to turn a caretRangeFromPoint/caretPositionFromPoint hit inside a
 * code cell (which may nest <span>/<mark> wrappers) into a column: the cell's
 * textContent equals the raw code line exactly (the diff +/- marker is CSS
 * ::before generated content — it contributes nothing here), so the 1-based
 * column is simply this offset + 1.
 */
export function textOffsetWithin(
  root: NodeLike,
  target: NodeLike,
  offsetInTarget: number,
): number | null {
  let acc = 0;
  let found: number | null = null;
  const walk = (n: NodeLike): boolean => {
    if (n === target) {
      found = acc + offsetInTarget;
      return true;
    }
    if (n.nodeType === 3) {
      acc += (n.nodeValue || "").length;
      return false;
    }
    const kids = n.childNodes;
    if (!kids) return false;
    for (let i = 0; i < kids.length; i++) {
      if (walk(kids[i]!)) return true;
    }
    return false;
  };
  walk(root);
  return found;
}

/**
 * Provider label ("ts" | "rust" | "java") serving a file path, or null when no
 * provider family handles its extension. MUST mirror the server registry
 * (src/lsp/manager.ts providers + each provider's `languages` list) so the
 * client never fires a request the server would answer {available:false}.
 */
export function lspLangLabel(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like .gitignore
  const ext = base.slice(dot + 1).toLowerCase();
  if (
    ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts" ||
    ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs"
  ) {
    return "ts";
  }
  if (ext === "rs") return "rust";
  if (ext === "java") return "java";
  return null;
}

/**
 * Index of the diff row showing new-side line `line` (add or context rows —
 * the rows that exist at head), or -1 when that line is not in the diff.
 * `rows` is the client's compact DATA shape ({t, o, n} per row). Used by
 * peek-definition to offer "jump in diff" for definitions inside this PR.
 */
export function diagRowIndex(
  rows: readonly { t: string; n: number | null }[],
  line: number,
): number {
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri]!;
    if (r.t !== "h" && r.t !== "d" && r.n === line) return ri;
  }
  return -1;
}
