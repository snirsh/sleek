/**
 * Pure text math for the Wave-4C saved replies dropdown: inserting a saved
 * reply's body into a composer/reply textarea at the caret. The DOM glue
 * (dropdown, save-as-reply form, /api/replies calls) lives in client.ts;
 * this module owns only the value/caret arithmetic so it stays testable.
 *
 * SHIPPING MODEL (same as markdown.ts / palette.ts / markers.ts): this exact
 * function also runs in the browser — client.ts injects fn.toString() into
 * CLIENT_JS, so the body must stay fully self-contained: no imports, no
 * references to module scope, no TS-only runtime syntax. repliesui.test.ts
 * covers the very function the page runs.
 */

/**
 * Replace the [start, end) selection of `value` with `snippet` (a collapsed
 * caret — start === end — is a plain insertion), returning the new value and
 * the caret position just after the inserted text. Out-of-range or
 * non-numeric bounds (a textarea that never had focus reports none) append at
 * the end instead; a reversed range is treated as a caret at `start`.
 */
export function insertSnippet(
  value: string,
  start: number,
  end: number,
  snippet: string,
): { value: string; caret: number } {
  const len = value.length;
  const okStart = typeof start === "number" && isFinite(start) && start >= 0 && start <= len;
  const a = okStart ? Math.floor(start) : len;
  const okEnd = typeof end === "number" && isFinite(end) && end >= a && end <= len;
  const b = okEnd ? Math.floor(end) : a;
  const out = value.slice(0, a) + snippet + value.slice(b);
  return { value: out, caret: a + snippet.length };
}
