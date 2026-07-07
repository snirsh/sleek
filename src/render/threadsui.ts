/**
 * Pure helpers for the Wave-2b thread UI (Thread cards, ```suggestion mini-diffs,
 * the pending Review bar) — src/render/html.ts uses them at render time for the
 * finding-authored opening Comments, and src/render/client.ts wires them to the
 * DOM for live-mode Threads (replies, resolve, composer).
 *
 * SHIPPING MODEL (same as markdown.ts / splitmodel.ts / lsputil.ts): these exact
 * functions also run in the browser — client.ts injects each fn.toString() into
 * CLIENT_JS, so every body must stay fully self-contained: no imports, no
 * references to module scope, no TS-only runtime syntax. threadsui.test.ts
 * covers the very functions the page runs.
 */

/** One piece of a Comment body: plain markdown, or a ```suggestion fence's content. */
export interface CommentSegment {
  kind: "md" | "suggestion";
  text: string;
}

/**
 * Split a Comment body into markdown segments and ```suggestion blocks
 * (suggestion Phase A — see docs/UI-ROADMAP.md "Suggested changes").
 *
 * A ```suggestion fence opens a suggestion segment (closed by ``` or end of
 * input); any OTHER fence (```ts, bare ```) passes through verbatim INCLUDING
 * its content, so a "```suggestion" line inside a regular code block stays
 * literal. Newlines are normalized; segments never contain the fence lines.
 */
export function splitSuggestionBlocks(body: string): CommentSegment[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const segs: CommentSegment[] = [];
  let md: string[] = [];
  const flush = (): void => {
    if (md.some((l) => l.trim() !== "")) segs.push({ kind: "md", text: md.join("\n") });
    md = [];
  };
  let i = 0;
  while (i < lines.length) {
    if (/^```suggestion\s*$/.test(lines[i])) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // past the closing fence (or EOF)
      flush();
      segs.push({ kind: "suggestion", text: buf.join("\n") });
      continue;
    }
    if (/^```/.test(lines[i])) {
      // Regular fence: keep it (and its body) intact for the markdown renderer.
      md.push(lines[i]); i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { md.push(lines[i]); i++; }
      if (i < lines.length) { md.push(lines[i]); i++; }
      continue;
    }
    md.push(lines[i]); i++;
  }
  flush();
  return segs;
}

/**
 * Render one suggestion block as a mini-diff: the Anchor's current lines as
 * removed, the suggestion content as added. Monospace, tint-only (no borders
 * per line); the +/- markers are CSS ::before generated content on .sline, so
 * copying the block yields clean code (same clean-copy posture as the diff).
 *
 * SECURITY: both sides are HTML-escaped first — same escape-first posture as
 * renderMarkdown (markdown.ts). An empty suggestion renders as a pure
 * deletion; empty currentLines as a pure addition.
 *
 * `lineHtml` (optional) renders one raw line to ESCAPED HTML with syntax-token
 * spans (both callers pass highlight.ts renderCodeHtml keyed to the Anchor
 * file's language); it replaces this function's own escaping for that line, so
 * escape-at-emission is preserved and nothing double-escapes. Absent → plain
 * escaped text, exactly as before.
 */
export function suggestionHtml(
  currentLines: readonly string[],
  suggestion: string,
  lineHtml?: (text: string) => string,
): string {
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const render = typeof lineHtml === "function" ? lineHtml : escapeHtml;
  const line = (cls: string, text: string): string =>
    '<span class="sline ' + cls + '">' + render(text) + "</span>";
  const dels = currentLines.map((l) => line("sdel", l));
  const adds = suggestion === "" ? [] : suggestion.split("\n").map((l) => line("sadd", l));
  return (
    '<div class="sugg"><div class="sughd">Suggested change</div><pre><code>' +
    dels.concat(adds).join("") +
    "</code></pre></div>"
  );
}

/**
 * Index of the diff row a Thread's card is inserted after: the LAST row the
 * Anchor covers on its side (RIGHT→add, LEFT→del), else the last in-range row
 * of any type (context rows — Threads on unchanged lines), else the file's
 * last row (defensive; -1 only for an empty file). Mirrors the server-side
 * findingRowIndex in html.ts, on the client's compact DATA rows ({t,o,n}).
 */
export function threadRowIndex(
  rows: readonly { t: string; o: number | null; n: number | null }[],
  anchor: { side: string; startLine: number; endLine: number },
): number {
  let covered = -1;
  let inRange = -1;
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    if (r.t === "h") continue;
    const line = anchor.side === "RIGHT" ? r.n : r.o;
    if (line === null || line < anchor.startLine || line > anchor.endLine) continue;
    inRange = ri;
    if (anchor.side === "RIGHT" ? r.t === "a" : r.t === "d") covered = ri;
  }
  if (covered !== -1) return covered;
  if (inRange !== -1) return inRange;
  return rows.length - 1;
}

/**
 * First-line summary of a Comment body, for the resolved-Thread pill: the
 * first non-empty, non-fence line with its heading/quote/list marker stripped,
 * truncated to ~80 chars.
 */
export function firstLineSummary(md: string): string {
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) continue;
    const s = raw.trim().replace(/^#{1,3}\s+/, "").replace(/^>\s*/, "").replace(/^([-*]|\d+\.)\s+/, "");
    if (s === "") continue;
    return s.length > 80 ? s.slice(0, 79).trimEnd() + "…" : s;
  }
  return "(no text)";
}

/**
 * Display label for an Anchor: "file.ts:12" / "file.ts:12–14", with the side
 * as new/old words (GitHub RIGHT/LEFT is pipeline vocabulary, not UI copy).
 * Matches the label the server renders on finding-thread location chips.
 */
export function anchorLabel(anchor: {
  file: string;
  side: string;
  startLine: number;
  endLine: number;
}): string {
  const name = anchor.file.split("/").pop() || anchor.file;
  const range =
    anchor.endLine !== anchor.startLine
      ? anchor.startLine + "–" + anchor.endLine
      : String(anchor.startLine);
  return name + ":" + range + " (" + (anchor.side === "RIGHT" ? "new" : "old") + ")";
}

/** UI wording for a submitted Review verdict (src/domain/threads.ts ReviewVerdict). */
export function verdictLabel(verdict: string): string {
  if (verdict === "approve") return "Approved";
  if (verdict === "request_changes") return "Changes requested";
  return "Commented";
}

/**
 * One-line description of what a review export will post to GitHub — the
 * confirmation copy in the "Post to GitHub" modal (Wave 4A), fed by the
 * server's dry-run preview (src/export/github.ts ExportPreview).
 */
export function exportPreviewLabel(preview: {
  commentCount: number;
  files: string[];
  hasSummary: boolean;
}): string {
  if (preview.commentCount === 0) {
    return preview.hasSummary
      ? "Summary only — no inline comments"
      : "No inline comments and no summary";
  }
  const comments =
    preview.commentCount + " inline comment" + (preview.commentCount === 1 ? "" : "s");
  const files =
    preview.files.length + " file" + (preview.files.length === 1 ? "" : "s");
  return comments + " across " + files + (preview.hasSummary ? ", plus a summary" : "");
}
