/**
 * Pure helpers for the Wave-8 comment-visibility UI (Local-only chip and
 * Publishable/Local-only toggle in the composer and reply editor).
 *
 * SHIPPING MODEL (same as threadsui.ts / selection.ts): these exact functions
 * also run in the browser — client.ts injects each fn.toString() into
 * CLIENT_JS, so every body must stay fully self-contained: no imports, no
 * references to module scope, no TS-only runtime syntax.
 * visui.test.ts covers the very functions the page runs.
 */

/**
 * Returns the CSS class for the visibility chip in a comment header.
 * Only reviewer comments with visibility === "local" show the chip;
 * all other cases return null (no chip rendered).
 */
export function visChipClass(authorType: string, visibility: string | undefined): string | null {
  if (authorType !== "reviewer") return null;
  if (visibility === "local") return "localchip";
  return null;
}

/**
 * Text label for the visibility toggle button in the composer / reply editor.
 * Cycles between "Publishable" and "Local-only" states.
 */
export function visToggleLabel(local: boolean): string {
  return local ? "Local-only" : "Publishable";
}

/**
 * Title attribute for the visibility toggle button — explains the semantics.
 */
export function visToggleTitle(local: boolean): string {
  return local
    ? "Local-only comments are never posted to GitHub. Click to make publishable."
    : "This comment will be posted to GitHub. Click to make local-only.";
}

/**
 * Returns the `visibility` field value to include in a POST body, or null
 * when the visibility is the default (publishable) and should be omitted.
 * The contract says: omit when publishable, include "local" when local.
 */
export function visPostValue(local: boolean): string | null {
  return local ? "local" : null;
}

/**
 * Returns a one-line description of excluded local comments for the export
 * modal preview, or null when there are none.
 */
export function excludedLocalLine(excludedLocalCount: number): string | null {
  if (!excludedLocalCount) return null;
  return excludedLocalCount + " local-only comment" + (excludedLocalCount === 1 ? "" : "s") + " excluded";
}
