/**
 * HTML renderer for a Review Scaffold + unified diff — the assembly module of
 * src/render/ (see also: diffmodel.ts for the diff parser, highlight.ts for the
 * render-time tokenizer, intraline.ts for word-level del/add marks, filetree.ts for
 * the rail's Files tree, whitespace.ts for ws-only pair tagging, splitmodel.ts for
 * side-by-side pairing (ships into the client), client.ts for the inline client JS,
 * markdown.ts for the chat markdown renderer that ships inside it).
 * scripts/render.ts thinly re-exports this module's entry points.
 *
 * Produces one self-contained HTML file (inline CSS + JS, no external resources):
 *   left rail   — Reading order (Layers, foundational-first), click to scope the diff;
 *                 below it a Files tree (changed files, viewed checkboxes, scroll-spy)
 *   center      — GitHub-style per-file diff cards (ordered by owning Layer, not diff
 *                 order) with inline Thread cards (Wave 2b: each Finding renders as the
 *                 Thread it opens; toggleable from the header); gutters are sticky (and
 *                 user-select:none, with +/- markers as CSS generated content) so long
 *                 lines scroll under them and copying a selection yields clean code;
 *                 thread cards stay in the visible pane
 *   right panel — active Layer's "What the model knows" bundle + assistant chat: live
 *                 (streaming /api/ask, /api/escalate) when GET /api/health answers,
 *                 otherwise the static stub; a neutral "All layers" summary when no
 *                 Layer is active
 *
 * Anchor→row mapping (both here for finding placement and mirrored in the inline JS
 * for layer scoping): an anchor {file, side, startLine, endLine} COVERS rows of that
 * file whose side-line (RIGHT→newLine, LEFT→oldLine) lies in [startLine, endLine] AND
 * whose type matches the side (RIGHT→add, LEFT→del). Context rows whose side-line
 * falls inside the range are "in span": they stay at full opacity when a layer is
 * scoped (so interleaved hunks stay readable) but get no accent stripe and are not
 * counted in the layer's covered-line badge.
 *
 * Selection labels follow the GitHub model (selection.ts selLabel): single-side
 * selections label as "file:start–end"; mixed selections with contiguous new numbering
 * add a "(+N deleted lines not included)" disclosure (the Ask anchor stays new-side);
 * otherwise "file: old A–B / new C–D". Ranges are always min–max per side — never
 * reversed.
 */
import type { Anchor, Finding, Layer, ReviewScaffold, Severity } from "../domain/scaffold.ts";
import { CLIENT_JS } from "./client.ts";
import type { DiffFile, DiffRow, FileStatus, RowType } from "./diffmodel.ts";
import { parseUnifiedDiff } from "./diffmodel.ts";
import type { TreeNode } from "./filetree.ts";
import { buildFileTree, fileLang, fileFindingCounts } from "./filetree.ts";
import type { Lang } from "./highlight.ts";
import { escapeHtml as esc, highlightFence, langForPath, renderCodeHtml } from "./highlight.ts";
import { intralineMarks } from "./intraline.ts";
import { renderMarkdown } from "./markdown.ts";
import { highestRiskLayer } from "./risk.ts";
import { anchorLabel, splitSuggestionBlocks, suggestionHtml } from "./threadsui.ts";
import { wsOnlyRows } from "./whitespace.ts";

export { parseUnifiedDiff } from "./diffmodel.ts";

// ── Anchor → row mapping (server side, for inline finding placement) ───────────────────

function anchorSideLine(row: DiffRow, side: Anchor["side"]): number | null {
  return side === "RIGHT" ? row.newLine : row.oldLine;
}

function anchorTypeMatches(row: DiffRow, side: Anchor["side"]): boolean {
  return side === "RIGHT" ? row.type === "add" : row.type === "del";
}

/**
 * Row index the finding box should be inserted after: the LAST covered row of the
 * anchor. Fallbacks (defensive; real pipeline anchors always cover rows): last
 * in-range row of any type, else the file's last row. Null if the file is absent
 * from the diff entirely.
 */
function findingRowIndex(
  files: DiffFile[],
  fileIndex: Map<string, number>,
  anchor: Anchor,
): { fi: number; ri: number } | null {
  const fi = fileIndex.get(anchor.file);
  if (fi === undefined) return null;
  const rows = files[fi]!.rows;
  let covered = -1;
  let inRange = -1;
  for (let ri = 0; ri < rows.length; ri++) {
    const line = anchorSideLine(rows[ri]!, anchor.side);
    if (line === null || line < anchor.startLine || line > anchor.endLine) continue;
    inRange = ri;
    if (anchorTypeMatches(rows[ri]!, anchor.side)) covered = ri;
  }
  const ri = covered !== -1 ? covered : inRange !== -1 ? inRange : rows.length - 1;
  return ri >= 0 ? { fi, ri } : null;
}

// ── HTML helpers ───────────────────────────────────────────────────────────────────────

/**
 * A Comment body rendered for the page: markdown via renderMarkdown (escape-first,
 * fences highlighted through highlightFence), with ```suggestion fences swapped for
 * a mini-diff against the Anchor's current lines, its lines highlighted in the
 * Anchor file's language (Wave 2b suggestion Phase A — render only, no apply). The
 * client glue in client.ts composes the same injected functions identically, so
 * live-mode Comments render exactly like these.
 */
function commentBodyHtml(body: string, currentLines: readonly string[], lang: Lang): string {
  const lineHtml = (t: string): string => renderCodeHtml(t, lang, [], "ln-add");
  return splitSuggestionBlocks(body)
    .map((s) =>
      s.kind === "suggestion"
        ? suggestionHtml(currentLines, s.text, lineHtml)
        : renderMarkdown(s.text, highlightFence),
    )
    .join("");
}

/**
 * Raw text of every row the anchor addresses on its side (changed + in-span
 * context) — the "removed" half of a ```suggestion mini-diff. [] when the file
 * is absent from the diff.
 */
function anchorCurrentLines(
  files: DiffFile[],
  fileIndex: Map<string, number>,
  anchor: Anchor,
): string[] {
  const fi = fileIndex.get(anchor.file);
  if (fi === undefined) return [];
  const out: string[] = [];
  for (const row of files[fi]!.rows) {
    if (row.type === "hunk") continue;
    const line = anchorSideLine(row, anchor.side);
    if (line === null || line < anchor.startLine || line > anchor.endLine) continue;
    out.push(row.text);
  }
  return out;
}

/**
 * A Finding rendered as the Thread it opens (Wave 2b): one .thread card whose
 * opening Comment is finding-authored (severity chip + Concern tag + location
 * chip, as before). This static markup IS the read-only artifact rendering; in
 * live mode the client syncs the same card from GET /api/threads (the Store
 * seeds Threads under the identical `f-<li>-<k>` ids) and adds the reply /
 * resolve / ask footer.
 */
function findingThreadCard(f: Finding, li: number, k: number, currentLines: readonly string[]): string {
  return `<div class="thread sev-${f.severity}" data-tid="f-${li}-${k}">
    <div class="tcmts"><div class="tcmt">
      <div class="tchd"><span class="chip ${f.severity}">${f.severity}</span><span class="concern">${f.concern}</span><button class="floc" data-fid="f-${li}-${k}" title="Scope this layer and jump to these lines">${esc(anchorLabel(f.anchor))}</button></div>
      <div class="tcbody">${commentBodyHtml(f.text, currentLines, langForPath(f.anchor.file))}</div>
    </div></div>
  </div>`;
}

function findingThreadRow(f: Finding, li: number, k: number, currentLines: readonly string[]): string {
  return `<tr class="frow" id="f-${li}-${k}"><td colspan="3">${findingThreadCard(f, li, k, currentLines)}</td></tr>`;
}

// Compact row shape embedded as JSON for the inline JS (indexes align with DOM ids).
interface DataRow {
  t: "a" | "d" | "c" | "h";
  o: number | null;
  n: number | null;
  /** 1 when the row belongs to a whitespace-only del/add pair (see whitespace.ts). */
  w?: 1;
}

/** Files with more rows than this render collapsed behind a "Load diff" button. */
const LARGE_FILE_ROWS = 400;

/**
 * Default cumulative row budget for page-level lazy mode.
 * Override with the SLEEK_EMBED_ROW_BUDGET env variable (positive integer).
 * Only applies when lazyLargeFiles=true; has no effect on static/embed-all renders.
 */
const DEFAULT_EMBED_ROW_BUDGET = 5000;

// ── File tree markup (data shape from filetree.ts) ──────────────────────────────────────
// Dirs render EXPANDED (the client re-applies per-PR+SHA persisted collapses);
// data-path is the collapse-persistence key. Labels never wrap mid-word: .tdname
// ellipsizes (the title attr carries the full path).

/**
 * Compact a changed-lines count for display in layer-card meta rows.
 * Under 10,000: locale-formatted with commas ("1,246").
 * 10,000+: one decimal + "k" ("178.4k"). Always appends " lines".
 * Exported for unit tests; also inlined (self-contained copy) in client.ts.
 */
export function fmtLines(n: number): string {
  if (n < 10000) return n.toLocaleString("en-US") + " lines";
  return (Math.round(n / 100) / 10).toFixed(1) + "k lines";
}

// Shared inline SVGs (CSP-safe, currentColor so CSS tints them). The file icon is
// a document outline; the dir icon a folder. Both are aria-hidden decoration.
const FILE_SVG =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/></svg>';
const DIR_SVG =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.5c0-.6.4-1 1-1h3.6l1.5 1.5h6.9c.6 0 1 .4 1 1v7.5c0 .6-.4 1-1 1h-12c-.6 0-1-.4-1-1z"/></svg>';

/** The per-file icon markup for a path: a document glyph tinted per language via
 * a `.ficon.lang-{key}` class (the glyph itself is shared; only color varies). */
function fileIconHtml(path: string): string {
  return `<span class="ficon lang-${esc(fileLang(path))}" aria-hidden="true">${FILE_SVG}</span>`;
}

/**
 * Split a (possibly chain-collapsed) dir label into a head (all but the last
 * segment, the redundant common prefix — left-truncated in CSS) and a tail (the
 * last segment, always shown). Single-segment dirs return no head; the separator
 * "/" is re-added to the head in markup, so the tail is always a bare segment.
 */
function splitDirLabel(name: string): { head: string; tail: string } {
  const i = name.lastIndexOf("/");
  if (i === -1) return { head: "", tail: name };
  return { head: name.slice(0, i), tail: name.slice(i + 1) };
}

/** Right-aligned single status letter per file status (IDE convention). */
const STATUS_LETTER: Record<FileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
};

function treeHtml(nodes: TreeNode[]): string {
  return nodes
    .map((n) => {
      if (n.kind === "dir") {
        const { head, tail } = splitDirLabel(n.name);
        // Left-truncate the redundant common prefix: the outer span is RTL (so the
        // ellipsis lands on the LEFT), the inner <bdi> restores LTR reading order
        // and isolates the path's slashes from bidi reordering. A trailing "/" keeps
        // the head visually joined to the tail.
        const headSpan = head
          ? `<span class="tdhead"><bdi>${esc(head)}/</bdi></span>`
          : "";
        const tailSpan = head
          ? '<span class="tdtail">' + esc(tail) + '</span>'
          : '<span class="tdtail tdsolo"><bdi>' + esc(tail) + '</bdi></span>';
        // Rollup shown only under a collapsed dir (CSS): a plain amber findings count.
        const findChip =
          n.findings > 0
            ? `<span class="ffind" title="${n.findings} finding${n.findings === 1 ? "" : "s"} under this folder">${n.findings}</span>`
            : "";
        const agg = `<span class="dagg" aria-hidden="true">${findChip}</span>`;
        return `<li class="tdir"><button class="tdbtn" data-path="${esc(n.path)}" aria-expanded="true" title="${esc(n.path)} — ${n.fileCount} file${n.fileCount === 1 ? "" : "s"}, +${n.adds} −${n.dels}"><span class="tarrow" aria-hidden="true">▾</span><span class="dicon" aria-hidden="true">${DIR_SVG}</span><span class="tdname">${headSpan}${tailSpan}</span>${agg}</button><ul class="tkids">${treeHtml(n.children)}</ul></li>`;
      }
      const findChip =
        n.findings > 0
          ? `<span class="ffind" title="${n.findings} finding${n.findings === 1 ? "" : "s"} in this file">${n.findings}</span>`
          : "";
      const letter = STATUS_LETTER[n.status];
      const statLetter = `<span class="tfstat st-${n.status}" aria-hidden="true">${letter}</span>`;
      return `<li class="tf st-${n.status}" data-fi="${n.fi}"><button class="tfbtn" data-fi="${n.fi}" title="${esc(n.path)} (${n.status}) · +${n.adds} −${n.dels}">${fileIconHtml(n.path)}<span class="tfck" aria-hidden="true">✓</span><span class="tfname">${esc(n.name)}</span><span class="tfmeta">${findChip}${statLetter}</span></button><input type="checkbox" class="viewedcb tfcb" data-fi="${n.fi}" aria-label="Mark ${esc(n.path)} as viewed"></li>`;
    })
    .join("");
}

const ROW_T: Record<RowType, DataRow["t"]> = { add: "a", del: "d", ctx: "c", hunk: "h" };

const SEV_ORDER: Severity[] = ["critical", "major", "minor", "info"];

/** First sentence of a summary, for the neutral "All layers" panel one-liners. */
function firstSentence(s: string): string {
  const m = /^[\s\S]*?\.(?=\s|$)/.exec(s);
  return m ? m[0] : s;
}

/**
 * Render markdown inline: run renderMarkdown, and if the result is exactly one <p>...</p>
 * block (no other top-level elements), return its inner HTML. Otherwise fall back to plain
 * escaped text (to avoid block HTML in inline contexts like spans).
 */
function inlineMd(s: string): string {
  const html = renderMarkdown(s, highlightFence);
  const match = /^<p>([\s\S]*)<\/p>$/.exec(html.trim());
  if (match) return match[1];
  // More than one block or other top-level structure: fall back to plain escape
  return esc(s);
}

// ── Wave-3 "?" help overlay (static markup, hidden until the ? key) ─────────────────────

const kbd = (s: string): string => `<kbd>${s}</kbd>`;
const helpRow = (keys: string, desc: string): string =>
  `<div class="hrow"><span class="hkeys">${keys}</span><span class="hdesc">${desc}</span></div>`;
const helpGroup = (title: string, rows: [string, string][]): string =>
  `<section class="helpgroup"><h4>${title}</h4>${rows.map(([k, d]) => helpRow(k, d)).join("")}</section>`;

/** The full keyboard map, grouped like the roadmap's Wave-3 table. */
const HELP_HTML = `<div id="helpwrap" hidden role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
  <div id="helpmodal">
    <div class="helphd"><h3>Keyboard shortcuts</h3><button id="help-close" aria-label="Close help">×</button></div>
    <div class="helpcols">
      ${helpGroup("Navigate", [
        [kbd("]") + kbd("["), "Next / previous file"],
        [kbd("j") + kbd("k"), "Next / previous change block"],
        [kbd("n") + kbd("p"), "Next / previous unresolved thread"],
        [kbd("1") + "…" + kbd("9"), "Jump to layer N (reading order)"],
        [kbd("f"), "Cycle findings (scoped layer, else all)"],
        [kbd("t") + " " + kbd("⌘K"), "Jump palette: files · layers · threads"],
      ])}
      ${helpGroup("Select &amp; comment", [
        [kbd("↵"), "Select line (focused gutter; ⇧ extends)"],
        [kbd("x"), "Select the focused row (after j/k/n/p)"],
        [kbd("⇧X"), "Extend selection to the focused row"],
        [kbd("c"), "Comment on selection (opens composer)"],
        [kbd("y"), "Copy selected code"],
        [kbd("⌘↵"), "Submit comment / reply"],
      ])}
      ${helpGroup("Toggle", [
        [kbd("v"), "Mark file viewed + advance"],
        [kbd("s"), "Split / unified view"],
        [kbd("w"), "Hide whitespace-only changes"],
        [kbd("z"), "Wrap long lines"],
        [kbd("h"), "Show / hide comments"],
      ])}
      ${helpGroup("AI", [
        [kbd("a"), "Ask the Assistant about the selection"],
        [kbd("⇧A"), "Ask Opus (escalation)"],
        [kbd("d"), "Peek definition (hover tooltip open)"],
      ])}
      ${helpGroup("Review", [
        [kbd("r") + kbd("a"), "Submit review: approve"],
        [kbd("r") + kbd("n"), "Submit review: request changes"],
        [kbd("r") + kbd("c"), "Submit review: comment"],
        [kbd("⌘⇧↵"), "Submit review (modal open)"],
        [kbd("Esc"), "Progressive dismiss (overlay → modal → composer → selection → scope)"],
        [kbd("?"), "This overlay"],
      ])}
    </div>
  </div>
</div>`;

/** The t/⌘K jump palette shell (the client fills #pal-list). */
const PALETTE_HTML = `<div id="palwrap" hidden>
  <div id="palette" role="dialog" aria-modal="true" aria-label="Jump to a file, layer, or thread">
    <input id="pal-input" placeholder="Jump to a file, layer, or thread…" autocomplete="off" spellcheck="false" aria-label="Jump to a file, layer, or thread">
    <ul id="pal-list"></ul>
  </div>
</div>`;

// ── Per-file row renderer (reused by the server's /api/filerows route) ────────────────

/**
 * Render the diff rows for a single file. `fi` is the file index (for DOM ids),
 * `ws` is the whitespace-only row set for this file (from wsOnlyRows), and
 * `inlineFindings` is the per-row finding-thread HTML (may be empty/undefined).
 * Returns the inner HTML of the .fbody element: either a <table> or a .nodiff <p>.
 *
 * Exported so the live server's GET /api/filerows route can call it without
 * duplicating the row-rendering logic.
 */
export function renderFileRowsHtml(
  fi: number,
  f: import("./diffmodel.ts").DiffFile,
  ws: ReturnType<typeof wsOnlyRows>,
  inlineFindings: Map<number, string[]> = new Map(),
): string {
  const lang = langForPath(f.path);
  const marks = intralineMarks(f.rows);
  const rowsHtml = f.rows
    .map((r, ri) => {
      let tr: string;
      if (r.type === "hunk") {
        tr = `<tr class="row hunk" id="r-${fi}-${ri}" data-fi="${fi}" data-ri="${ri}"><td class="g go"></td><td class="g gn"></td><td class="code">${esc(r.text)}</td></tr>`;
      } else {
        const goLabel = r.oldLine !== null ? `Select old line ${r.oldLine}` : "Select line";
        const gnLabel = r.newLine !== null ? `Select new line ${r.newLine}` : "Select line";
        const cell = renderCodeHtml(r.text, lang, marks.get(ri) ?? [], r.type === "del" ? "ln-del" : "ln-add");
        const wsAttr = ws.rows.has(ri) ? ' data-ws="1"' : "";
        tr = `<tr class="row ${r.type}" id="r-${fi}-${ri}" data-fi="${fi}" data-ri="${ri}"${wsAttr}><td class="g go" tabindex="0" role="button" aria-label="${goLabel}">${r.oldLine ?? ""}</td><td class="g gn" tabindex="0" role="button" aria-label="${gnLabel}">${r.newLine ?? ""}</td><td class="code">${cell}</td></tr>`;
      }
      const boxes = inlineFindings.get(ri);
      return boxes ? tr + boxes.join("") : tr;
    })
    .join("\n");
  return f.rows.length
    ? `<table class="diff"><tbody>${rowsHtml}</tbody></table>`
    : `<p class="nodiff">No textual changes (binary or metadata-only).</p>`;
}

// ── Main entry ─────────────────────────────────────────────────────────────────────────

export interface RenderReviewHtmlOptions {
  /**
   * When true, large files that have no inline Finding anchors are rendered
   * WITHOUT their diff rows — the "Load diff" button carries a data-lazy="1"
   * attribute and the client fetches rows on demand from GET /api/filerows.
   * Static artifact mode (default false) keeps today's embed-all behaviour so
   * the file is self-contained.
   *
   * Page-level row budget: files are embedded in file order until the cumulative
   * embedded row count exceeds the budget (SLEEK_EMBED_ROW_BUDGET env, default
   * DEFAULT_EMBED_ROW_BUDGET). Finding-anchored files are always embedded and are
   * charged against the budget first. Any file past the budget renders lazy,
   * regardless of per-file size.
   */
  lazyLargeFiles?: boolean;
}

export function renderReviewHtml(
  scaffold: ReviewScaffold,
  unifiedDiff: string,
  layerTitles: Record<string, string> = {},
  prUrl?: string,
  opts: RenderReviewHtmlOptions = {},
): string {
  const layers: Layer[] = [...scaffold.layers].sort((a, b) => a.order - b.order);
  const totalFindings = layers.reduce((n, l) => n + l.findings.length, 0);
  const title = (l: Layer): string => l.id === "__uncovered__" ? "Uncovered changes" : (layerTitles[l.id] ?? l.id);
  const shouldShowSlug = (l: Layer): boolean => title(l) !== l.id && l.id !== "__uncovered__";

  // Center shows file cards in READING order: the file for the most foundational layer
  // that anchors into it comes first; files no layer claims keep diff order, at the end.
  const layerOrderOfFile = (path: string): number => {
    let o = Number.POSITIVE_INFINITY;
    for (const l of layers) {
      if (l.anchors.some((a) => a.file === path)) o = Math.min(o, l.order);
    }
    return o;
  };
  const files = parseUnifiedDiff(unifiedDiff)
    .map((f, i) => ({ f, i }))
    .sort((a, b) => layerOrderOfFile(a.f.path) - layerOrderOfFile(b.f.path) || a.i - b.i)
    .map((x) => x.f);
  const fileIndex = new Map(files.map((f, i) => [f.path, i]));

  // Whitespace-only del/add pairs (per file), for the header toggle + row tagging.
  const wsPerFile = files.map((f) => wsOnlyRows(f.rows));
  const wsPairsTotal = wsPerFile.reduce((n, w) => n + w.pairs, 0);

  // Place each finding's Thread card after its anchor's last covered row.
  const inline = new Map<number, Map<number, string[]>>();
  const unanchored: string[] = [];
  layers.forEach((l, li) => {
    l.findings.forEach((f, k) => {
      const at = findingRowIndex(files, fileIndex, f.anchor);
      const currentLines = anchorCurrentLines(files, fileIndex, f.anchor);
      if (!at) {
        // File absent from the diff (defensive): still show the finding's thread,
        // with its id so layer navigation can reach it.
        unanchored.push(`<div id="f-${li}-${k}">${findingThreadCard(f, li, k, currentLines)}</div>`);
        return;
      }
      const perFile = inline.get(at.fi) ?? new Map<number, string[]>();
      const perRow = perFile.get(at.ri) ?? [];
      perRow.push(findingThreadRow(f, li, k, currentLines));
      perFile.set(at.ri, perRow);
      inline.set(at.fi, perFile);
    });
  });

  // Helper: split a file path at the last "/" so dir can be muted and basename bold.
  function pathHtml(path: string): string {
    const i = path.lastIndexOf("/");
    if (i === -1) return `<span class="pbase">${esc(path)}</span>`;
    return `<span class="pdir">${esc(path.slice(0, i + 1))}</span><span class="pbase">${esc(path.slice(i + 1))}</span>`;
  }

  // ── Center: file cards ──
  // Files with at least one Finding anchor rendered inline must always be embedded
  // (not lazily loaded) so Finding threads / layer jump targets exist on page load.
  const anchoredFileIndexes = new Set<number>();
  layers.forEach((l) => {
    l.findings.forEach((f) => {
      const idx = fileIndex.get(f.anchor.file);
      if (idx !== undefined) anchoredFileIndexes.add(idx);
    });
  });

  // Page-level row budget (lazy mode only): limit the total embedded rows so a PR
  // with hundreds of small/medium files does not balloon the initial payload.
  // Read from env at render time so callers don't need to thread it through opts.
  // lazyLargeFiles=false: budget is irrelevant — every file is always embedded.
  const embedBudget: number = (() => {
    if (opts.lazyLargeFiles !== true) return Infinity;
    const raw = typeof process !== "undefined" ? process.env["SLEEK_EMBED_ROW_BUDGET"] : undefined;
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return DEFAULT_EMBED_ROW_BUDGET;
  })();

  // Charge anchored files against the budget first (they are always embedded).
  let embeddedRows = 0;
  for (const fi of anchoredFileIndexes) {
    embeddedRows += files[fi]!.rows.length;
  }

  const cards = files
    .map((f, fi) => {
      const isLarge = f.rows.length > LARGE_FILE_ROWS;
      // Lazy-mode decision: a file is lazy when lazyLargeFiles=true AND it is not
      // anchored AND either (a) the old per-file size rule fires (isLarge) OR
      // (b) embedding it would exceed the page-level row budget.
      let isLazy = false;
      if (opts.lazyLargeFiles === true && !anchoredFileIndexes.has(fi)) {
        const wouldExceedBudget = embeddedRows + f.rows.length > embedBudget;
        isLazy = isLarge || wouldExceedBudget;
        if (!isLazy) {
          // This file will be embedded; charge it against the running total.
          embeddedRows += f.rows.length;
        }
      }

      const body = isLazy
        ? `<div class="fbody"></div>`
        : `<div class="fbody">${renderFileRowsHtml(fi, f, wsPerFile[fi]!, inline.get(fi) ?? new Map())}</div>`;

      // A file that is lazy for any reason (per-file size OR page-level budget)
      // needs the guard button with data-lazy="1" and the collapsed card class so
      // the client can fetch rows on demand and the empty fbody is hidden.
      const needsGuard = isLarge || isLazy;
      const guard = needsGuard
        ? `\n  <div class="guard"><button class="loaddiff"${isLazy ? ' data-lazy="1"' : ""}>Load diff (${f.rows.length} lines)</button></div>`
        : "";
      return `<section class="filecard${needsGuard ? " large collapsed" : ""}" data-fi="${fi}">
  <div class="fhead">
    <button class="collapse" aria-expanded="${!needsGuard}" aria-label="Toggle file">▾</button>
    <span class="path">${pathHtml(f.path)}</span>
    <span class="stat"><span class="plus">+${f.adds}</span> <span class="minus">−${f.dels}</span></span>
    <label class="viewedlbl"><input type="checkbox" class="viewedcb" data-fi="${fi}" aria-label="Mark ${esc(f.path)} as viewed"> Viewed</label>
  </div>${guard}
${body}
</section>`;
    })
    .join("\n");

  const unanchoredHtml = unanchored.length
    ? `<section class="filecard"><div class="fhead"><span class="path">Unanchored findings</span></div><div class="fbody pad">${unanchored.join("")}</div></section>`
    : "";

  // ── Left rail ──
  // Explore-first: an empty scaffold (layers: []) has no reading order yet.
  // The rail shows a short placeholder instead of an empty list; the client's
  // Process-PR button (live mode) drives generating layers + findings.
  const railEmpty = `<li class="railhint">No scaffold yet — <strong>Process PR</strong> to generate layers &amp; findings.</li>`;
  const rail = layers.length === 0
    ? railEmpty
    : layers
    .map((l, li) => {
      const maxSev = SEV_ORDER.find((s) => l.findings.some((f) => f.severity === s));
      const sevCount = maxSev ? l.findings.filter((f) => f.severity === maxSev).length : 0;
      const sevChip = maxSev
        ? `<span class="sevchip"><i class="dot" style="background:var(--sev-${maxSev})"></i>${sevCount} ${maxSev}</span> · `
        : "";
      const fcount = l.findings.length
        ? `<span class="fcount" title="Cycle through this layer's findings">${l.findings.length} finding${l.findings.length === 1 ? "" : "s"}</span>`
        : "0 findings";
      const btnLabel = `Layer ${li + 1}: ${title(l)} (${l.id}) — ${
        l.findings.length
          ? `${l.findings.length} finding${l.findings.length === 1 ? "" : "s"}; press f, or Enter when active, to cycle findings`
          : "no findings"
      }`;
      // Show the slug only for authored titles on real layers.
      const slug = shouldShowSlug(l) ? '<span class="lfile">' + esc(l.id) + "</span>" : "";
      return `<li><button class="layerbtn" data-li="${li}" aria-label="${esc(btnLabel)}">
    <span class="ord">${li + 1}</span>
    <span class="lbody">
      <span class="ltitle">${esc(title(l))}</span>
      ${slug}
      <span class="lmeta">${sevChip}${fcount} · <span data-rc="${li}"></span></span>
    </span>
  </button></li>`;
    })
    .join("\n");

  // ── Left rail: Files section (tree from filetree.ts; Layers stay above it) ──
  // Per-file Finding counts (across all layers' anchors) → tree count badges.
  const findingCounts = fileFindingCounts(files.map((f) => f.path), layers);
  const tree = buildFileTree(
    files.map((f, fi) => ({
      path: f.path,
      adds: f.adds,
      dels: f.dels,
      status: f.status,
      findings: findingCounts[fi] ?? 0,
    })),
  );
  const filesec = `<div id="filesec">
    <div class="fsechead"><h2 class="sect">Files (${files.length})</h2><button id="treecollapse" aria-label="Collapse tree" aria-pressed="false" title="Collapse all folders">⊟</button><button id="collapseall">Collapse all</button></div>
    <div id="ffwrap"><input id="ffilter" placeholder="Filter files…" aria-label="Filter files" autocomplete="off" spellcheck="false"><button id="ffilter-x" hidden aria-label="Clear file filter">×</button></div>
    <p id="ffcount" hidden role="status"></p>
    <ul class="ftree">${treeHtml(tree)}</ul>
    <p class="keyhint" id="keyhint"><kbd>]</kbd><kbd>[</kbd> files · <kbd>j</kbd><kbd>k</kbd> hunks · <kbd>n</kbd><kbd>p</kbd> threads · <kbd>t</kbd> jump · <kbd>?</kbd> help</p>
  </div>`;

  // ── Right panel bundles ──
  const nrefSplit = (ref: string): { path: string; sym: string } => {
    const i = ref.lastIndexOf("#");
    return i === -1 ? { path: "", sym: ref } : { path: ref.slice(0, i), sym: ref.slice(i) };
  };
  const bundles = layers
    .map((l, li) => {
      const neighbors = l.bundle.neighbors.length
        ? `<ul class="neighbors">${l.bundle.neighbors
            .map((n) => {
              const nr = nrefSplit(n.ref);
              return `<li class="nbr"><span class="nref"><span class="npath">${esc(nr.path)}</span><span class="nsym">${esc(nr.sym)}</span></span><span class="nsig">${esc(n.signature)}</span><span class="one">${inlineMd(n.oneLine)}</span></li>`;
            })
            .join("")}</ul>`
        : `<p class="muted">No related code for this layer.</p>`;
      const history = l.bundle.history.length
        ? `<ul class="history">${l.bundle.history
            .map(
              (h) =>
                `<li><code>${esc(h.sha.slice(0, 10))}</code> ${esc(h.subject)}<span class="one">${inlineMd(h.whenRelevant)}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="muted">No recent history for these files.</p>`;
      // Suppress slug under the panel title unless a real layer has an authored title.
      const bslug = shouldShowSlug(l) ? `<p class="bfile">${esc(l.id)}</p>` : "";
      return `<div class="bundle" data-li="${li}">
    <h3>${esc(title(l))}</h3>
    ${bslug}
    <div class="summary">${renderMarkdown(l.bundle.summary, highlightFence)}</div>
    <h4 class="sect">Related code</h4>${neighbors}
    <h4 class="sect">History</h4>${history}
  </div>`;
    })
    .join("\n");

  // Neutral panel when no layer is active: PR title + per-layer one-liners.
  const allPanel = `<div class="bundle" data-li="all">
    <h3>All layers</h3>
    <p class="summary">${esc(scaffold.pr.title)}</p>
    <ul class="alllayers">${layers
      .map(
        (l, li) =>
          `<li><span class="ord">${li + 1}</span><strong>${esc(title(l))}</strong><span class="one">${inlineMd(firstSentence(l.bundle.summary))}</span></li>`,
      )
      .join("")}</ul>
  </div>`;

  // ── Header links (optional; kept generic — any GitHub-shaped prUrl works) ──
  const repoUrl = prUrl?.includes("/pull/") ? prUrl.slice(0, prUrl.indexOf("/pull/")) : null;
  const prNoHtml = prUrl
    ? `<a class="lnk" href="${esc(prUrl)}" target="_blank" rel="noopener">PR #${scaffold.pr.number}</a>`
    : `PR #${scaffold.pr.number}`;
  const shaShort = esc(scaffold.pr.headSha.slice(0, 10));
  const shaHtml = repoUrl
    ? `<a class="lnk" href="${esc(`${repoUrl}/commit/${scaffold.pr.headSha}`)}" target="_blank" rel="noopener"><code>${shaShort}</code></a>`
    : `<code>${shaShort}</code>`;

  // ── Embedded DATA for the inline JS ──
  const data = {
    pr: { number: scaffold.pr.number, headSha: scaffold.pr.headSha, baseSha: scaffold.pr.baseSha },
    files: files.map((f, fi) => ({
      path: f.path,
      rows: f.rows.map<DataRow>((r, ri) => {
        const row: DataRow = { t: ROW_T[r.type], o: r.oldLine, n: r.newLine };
        if (wsPerFile[fi]!.rows.has(ri)) row.w = 1;
        return row;
      }),
    })),
    layers: layers.map((l, li) => ({
      id: l.id,
      title: title(l),
      anchors: l.anchors as Anchor[],
      findings: l.findings.map((f, k) => ({ id: `f-${li}-${k}`, anchor: f.anchor })),
    })),
    // Highest-risk layer (reading-order index; -1 = no findings anywhere): the
    // client's first-load collapse default expands only this layer's files.
    risk: highestRiskLayer(layers),
  };
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!-- generated by src/render/html.ts (entry: scripts/render.ts) -->
<title>Sleek — PR #${scaffold.pr.number}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{
  --bg:#0E1116;--panel:#151B23;--line:#262D38;--fg:#D7DCE4;--mut:#8B95A6;--acc:#4C8DFF;
  --sev-critical:#F4726D;--sev-major:#E8975A;--sev-minor:#D9B54A;--sev-info:#6FA8E8;
  --add-fg:#3FB950;--del-fg:#F85149;
  --add-bg:rgba(63,185,80,.13);--add-g:rgba(63,185,80,.25);
  --del-bg:rgba(248,81,73,.12);--del-g:rgba(248,81,73,.22);
  --sel-bg:rgba(76,141,255,.16);--sel-g:rgba(76,141,255,.28);
  /* syntax tokens — deliberately subtle so add/del tints stay the dominant signal.
     fn/type carry the informative color (blue kin of the accent + a teal that reads
     clearly apart from it); builtins go warm; operators are quiet; punctuation dims
     BELOW the code foreground so delimiters recede. */
  --tok-kw:#C792EA;--tok-str:#8DC891;--tok-num:#E0A458;--tok-com:#5F6B7C;
  --tok-fn:#6CB6FF;--tok-type:#5FD3BC;--tok-builtin:#E8926B;--tok-op:#9DA9BC;--tok-punc:#5A6474;
  /* intraline word-level marks: slightly stronger than the row tint, no borders */
  --mark-add:rgba(63,185,80,.32);--mark-del:rgba(248,81,73,.30);
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column;overflow:hidden}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:4px}
code{font-family:var(--mono);background:#1C2430;padding:1px 5px;border-radius:4px;font-size:11px}
.muted{color:var(--mut)}
/* header */
.topbar{flex:none;display:flex;align-items:baseline;gap:12px;padding:12px 18px;background:var(--panel);border-bottom:1px solid var(--line)}
.topbar h1{margin:0;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wordmark{font:700 13.5px/1 var(--sans);color:var(--fg);white-space:nowrap}
.wdot{color:var(--acc)}
.topbar .prno{color:var(--mut);font-weight:400}
.topbar .meta{margin-left:auto;color:var(--mut);font-size:12px;white-space:nowrap}
.topbar .meta code{background:none;padding:0}
.topbar a.lnk{color:inherit;text-decoration:none}
.topbar a.lnk:hover{color:var(--acc);text-decoration:underline;text-decoration-color:var(--acc)}
#ctoggle,#gh-refresh,#stoggle,#wtoggle,#ztoggle{flex:none;display:inline-flex;align-items:center;height:22px;padding:0 9px;border:1px solid var(--line);border-radius:6px;color:var(--mut);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
#gh-refresh[hidden]{display:none}
#procpr{flex:none;padding:3px 12px;border:1px solid var(--acc);border-radius:999px;background:var(--acc);color:#0E1116;font-size:12px;font-weight:600;white-space:nowrap}
#procpr[hidden]{display:none}
#procpr:hover{filter:brightness(1.08)}
/* Wave-7 non-blocking progress chip (replaces the blocking modal once a run starts):
   a compact live status in the topbar; the diff stays fully browsable behind it */
#procchip{flex:none;display:inline-flex;align-items:center;gap:7px;padding:3px 6px 3px 11px;border:1px solid var(--acc);border-radius:999px;background:rgba(76,141,255,.12);color:var(--fg);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
#procchip[hidden]{display:none}
#procchip .proc-spinner{width:11px;height:11px}
#procchip #procchip-label{color:var(--fg)}
#procchip.done{border-color:var(--add-fg);background:rgba(63,185,80,.14)}
#procchip.done .proc-spinner{display:none}
#procchip.err{border-color:var(--sev-critical);background:rgba(248,81,73,.12)}
#procchip.err .proc-spinner{display:none}
#procchip.err #procchip-label{color:var(--sev-critical)}
#procchip-retry{flex:none;padding:1px 9px;border:1px solid var(--acc);border-radius:999px;color:var(--acc);font-size:11px;font-weight:600}
#procchip-retry[hidden]{display:none}
#procchip-retry:hover{background:var(--sel-bg)}
#procchip-x{flex:none;padding:0 4px;color:var(--mut);font-size:14px;line-height:1}
#procchip-x:hover{color:var(--fg)}
#procchip-bar{height:2px;background:var(--border,#2a2a2a);margin:4px 0 6px;border-radius:1px;overflow:hidden}
#procchip-bar-inner{height:100%;width:0%;background:var(--accent,#4a9eff);transition:width 0.3s ease}
#procchip-rows{display:flex;flex-direction:column;gap:2px;margin-top:4px;min-width:260px}
.prow{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-muted,#888);line-height:1.4}
.prow-done{color:var(--text,#ccc)}
.prow-running{color:var(--text,#ccc)}
.prow-ind{width:10px;text-align:center;flex-shrink:0}
.prow-done .prow-ind{color:var(--accent,#4a9eff)}
.prow-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.prow-meta{flex-shrink:0;font-size:10px;color:var(--text-muted,#888)}
#procchip-activity{font-size:10px;color:var(--text-muted,#888);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}
#procchip-eta{font-size:10px;color:var(--mut,#8B95A6);margin-top:2px}
/* Wave-3A: shimmer row — muted italic "analyzing…" fades slowly while a layer runs */
.prow-shimmer-text{font-style:italic;color:var(--mut,#8B95A6);animation:shimmer-fade 2s ease-in-out infinite}
@keyframes shimmer-fade{0%,100%{opacity:.5}50%{opacity:1}}
#ctoggle:hover,#gh-refresh:hover,#stoggle:hover,#ztoggle:hover,#wtoggle:hover:not(:disabled){border-color:var(--acc);color:var(--fg)}
#ctoggle[aria-pressed="false"]{color:var(--mut);border-style:dashed}
#stoggle[aria-pressed="true"],#wtoggle[aria-pressed="true"],#ztoggle[aria-pressed="true"]{border-color:var(--acc);color:var(--fg)}
#wtoggle:disabled{opacity:.45;cursor:default}
/* viewed progress (slim bar + count) */
#fprog{flex:none;display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
#fprog .pbar{width:90px;height:3px;background:var(--line);border-radius:999px;overflow:hidden}
#fprog #pfill{display:block;height:100%;width:0;background:var(--acc);border-radius:999px}
#fprog #ptext{color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}
/* comments hidden: inline thread rows + unanchored thread divs vanish; the rail's
   finding-counts dim + strike so a seemingly-inert click is explained at a glance */
body.nocomments tr.frow,body.nocomments .fbody.pad>div{display:none}
body.nocomments .fcount{opacity:.45;text-decoration:line-through}
/* layout */
.grid{flex:1;min-height:0;display:grid;grid-template-columns:var(--railw,260px) 1fr 340px;position:relative}
.grid>*{overflow-y:auto;min-width:0}
#rail{padding:14px;border-right:1px solid var(--line);position:relative;container:rail/inline-size}
/* slim grab handle on the rail's right edge (drag: resize; dblclick: reset).
   ::before — always-visible grip pill (quiet, IDE-style affordance).
   ::after  — full-height hairline that brightens on hover/drag. */
#railgrip{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;z-index:5;background:transparent}
#railgrip::before{content:"";position:absolute;top:50%;right:2px;transform:translateY(-50%);width:3px;height:28px;border-radius:999px;background:var(--line);transition:background .12s}
#railgrip:hover::before,#railgrip.dragging::before{background:var(--acc)}
#railgrip::after{content:"";position:absolute;top:0;bottom:0;right:3px;width:1px;background:transparent;transition:background .12s}
#railgrip:hover::after,#railgrip.dragging::after{background:var(--acc)}
body.railresizing{cursor:col-resize;user-select:none}
#center{padding:0 16px 16px}
#center>.filecard:first-child{margin-top:16px}
#side{padding:16px;border-left:1px solid var(--line)}
h2.sect{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:0 0 10px}
/* left rail */
#rail ul{list-style:none;margin:0;padding:0}
#showall{display:flex;align-items:center;justify-content:center;width:100%;height:22px;margin-bottom:10px;border:1px dashed var(--line);border-radius:6px;color:var(--mut);font-size:11px;text-align:center}
#showall:hover{border-color:var(--acc);color:var(--fg)}
#showall[aria-disabled="true"]{opacity:.5;cursor:default}
#showall[aria-disabled="true"]:hover{border-color:var(--line);color:var(--mut)}
#rail>ul>li{position:relative}
#rail>ul>li::before{content:"";position:absolute;left:19px;top:0;width:1px;height:100%;background:var(--line);pointer-events:none}
#rail>ul>li:first-child::before{top:50%}
#rail>ul>li:last-child::before{height:50%}
.layerbtn{display:flex;gap:10px;width:100%;text-align:left;padding:10px;margin-bottom:8px;background:var(--panel);border:1px solid var(--line);border-radius:8px}
.layerbtn:hover{border-color:var(--acc)}
.layerbtn.active{box-shadow:inset 2px 0 0 var(--acc)}
.layerbtn.active .ord{border-color:var(--acc);color:var(--acc)}
.ord{flex:none;width:18px;height:18px;display:grid;place-items:center;background:var(--bg);border:1px solid var(--line);border-radius:50%;color:var(--mut);font-family:var(--mono);font-size:10.5px;font-variant-numeric:tabular-nums}
.lbody{min-width:0}
.ltitle{display:block;font-family:var(--sans);font-size:12.5px;font-weight:600}
.lfile{display:block;margin-top:2px;color:var(--mut);font-family:var(--mono);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lmeta{display:block;margin-top:4px;color:var(--mut);font-family:var(--mono);font-size:10.5px;font-variant-numeric:tabular-nums}
.sevchip{display:inline-flex;align-items:center;gap:4px}
.sevchip .dot{display:inline-block;width:7px;height:7px;border-radius:50%}
.fcount{cursor:pointer}
.fcount:hover{color:var(--fg);text-decoration:underline}
/* left rail: Files section (tree built by filetree.ts) */
#filesec{margin-top:18px}
/* the head + filter stick to the top of #rail (the scroll container) while the
   tree scrolls under them; opaque background so rows never show through */
.fsechead{display:flex;align-items:center;gap:8px;margin-bottom:8px;position:sticky;top:-14px;z-index:3;background:var(--bg);padding-top:14px;margin-top:-14px}
.fsechead h2.sect{margin:0;flex:1}
#collapseall{flex:none;display:inline-flex;align-items:center;height:22px;color:var(--mut);font-size:11px;padding:0 8px;border:1px solid var(--line);border-radius:6px}
#collapseall:hover{border-color:var(--acc);color:var(--fg)}
/* tree collapse/expand-all toggle (distinct from #collapseall which folds cards) */
#treecollapse{flex:none;display:grid;place-items:center;width:22px;height:22px;color:var(--mut);border:1px solid var(--line);border-radius:6px;font-size:11px;line-height:1}
#treecollapse:hover{border-color:var(--acc);color:var(--fg)}
#treecollapse:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.ftree,.tkids{list-style:none;margin:0;padding:0}
/* indent guide: a low-alpha hairline behind the rows; padding retuned so total
   indent stays ~14px and the guide reads BEHIND the file-status left edges */
.tkids{padding-left:13px;margin-left:1px;border-left:1px solid rgba(38,45,56,.7)}
.tkids[hidden]{display:none}
.tdbtn{display:flex;align-items:center;gap:5px;width:100%;min-width:0;text-align:left;padding:3px 4px;border-radius:6px;color:var(--mut)}
.tdbtn:hover{color:var(--fg);background:var(--panel)}
.tdbtn:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}
.tarrow{flex:none;font-size:9px;width:11px;text-align:center;transition:transform .12s;color:var(--mut)}
.tdbtn:hover .tarrow,.tdbtn[aria-expanded="true"] .tarrow{color:var(--acc)}
.tdbtn[aria-expanded="false"] .tarrow{display:inline-block;transform:rotate(-90deg)}
/* dir label: head (redundant prefix) truncates from the LEFT so distinguishing
   suffixes survive; tail (last segment) is flex-none at full brightness */
.tdname{flex:1;min-width:0;display:flex;align-items:baseline;font-family:var(--sans);font-size:12.5px;overflow:hidden}
.tdhead{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;direction:rtl;text-align:left;color:var(--mut)}
.tdhead bdi{unicode-bidi:isolate}
.tdtail{flex:0 0 auto;white-space:nowrap;color:var(--fg)}
.tdtail.tdsolo{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
/* subtree rollups — shown ONLY when the dir is collapsed (expanded dirs stay quiet) */
.dagg{flex:none;display:none;align-items:center;gap:5px;margin-left:auto;padding-left:6px;font-family:var(--mono);font-size:10px;font-variant-numeric:tabular-nums;color:var(--mut)}
.tdbtn[aria-expanded="false"] .dagg{display:inline-flex}
li.tf{display:flex;align-items:center;gap:2px;border-radius:6px}
/* viewed checkbox: kept in layout but invisible until the row is hovered/focused
   or already checked — cuts the always-on visual noise the brief flags */
li.tf .tfcb{flex:none;margin:0 2px;accent-color:var(--acc);opacity:0;transition:opacity .1s}
li.tf:hover .tfcb,li.tf:focus-within .tfcb,li.tf .tfcb:checked{opacity:1}
/* padding-left reserves the chevron slot (11px arrow + 5px gap = 16px extra) so
   .ficon x-aligns with .dicon and .tfname x-aligns with .tdname at the same depth */
.tfbtn{display:flex;align-items:center;gap:5px;flex:1;min-width:0;text-align:left;padding:3px 4px 3px 20px;border-radius:6px}
.tfbtn:hover{background:var(--panel)}
.tfbtn.active{background:var(--panel)}
/* active row: full-row panel background; NO accent inset (IDE-clean) */
li.tf:has(.tfbtn.active){background:var(--panel)}
/* file icon: a document outline tinted per language; generic files get muted gray */
.ficon{flex:none;width:14px;height:14px;display:grid;place-items:center;color:#8C97A9}
.ficon.lang-ts{color:#7FB0FF}
.ficon.lang-js{color:#E0C05A}
.ficon.lang-json{color:#AEB7C6}
.ficon.lang-css{color:#6FD6C1}
.ficon.lang-html{color:#EC9D77}
.ficon.lang-md{color:#C79AEA}
.ficon.lang-py{color:#6FA8E8}
.ficon.lang-rs{color:#E8975A}
.ficon.lang-go{color:#66D0E8}
.ficon.lang-rb{color:#F0736C}
.ficon.lang-sh{color:#5DC46B}
.ficon.lang-yaml{color:#9FA9BA}
.ficon.lang-sql{color:#7FB0FF}
.ficon.lang-java,.ficon.lang-c,.ficon.lang-swift,.ficon.lang-php{color:#D9A05A}
/* dir icon: a folder glyph, neutral gray always; tints to accent on hover only */
.dicon{flex:none;width:14px;height:14px;display:grid;place-items:center;color:#7A8699}
.tdbtn:hover .dicon{color:var(--acc)}
/* viewed ✓ replaces the file icon in-place (same 14px cell) — plain green glyph,
   no chip/background; hidden until the row gets the .viewed class */
.tfck{flex:none;display:none;place-items:center;width:14px;height:14px;margin-left:-14px;color:var(--add-fg);font-size:11px;font-weight:700;line-height:1}
.tfname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--sans);font-size:12.5px}
/* status tint on the filename (IDE convention: color, not a left edge) */
li.tf.st-modified .tfname{color:#D9B54A}
li.tf.st-added .tfname{color:var(--add-fg)}
li.tf.st-deleted .tfname{color:var(--del-fg);text-decoration:line-through}
/* right-side meta container: findings number + status letter */
.tfmeta{flex:none;display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10.5px;font-variant-numeric:tabular-nums;font-weight:600}
/* plain amber findings count — no pill, no border */
.ffind{flex:none;color:var(--sev-major);font-family:var(--mono);font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums}
/* status letter (M/A/D) */
.tfstat{flex:none;width:9px;text-align:center;font-weight:600;opacity:.85}
.tfstat.st-modified{color:#D9B54A}
.tfstat.st-added{color:var(--add-fg)}
.tfstat.st-deleted{color:var(--del-fg)}
/* viewed: row dims to .55; ✓ replaces the file icon */
li.tf.viewed .tfbtn{opacity:.55}
li.tf.viewed .ficon{visibility:hidden}
li.tf.viewed .tfck{display:inline-grid}
/* layer scope → tree (the client classifies rows): hard scope HIDES files with no
   anchor in the layer (and dirs whose whole subtree hid); soft-active only DIMS */
.ftree .scopehide{display:none}
.ftree li.tf.scopedim{opacity:.4}
/* file filter (Wave 4C): the input above the tree; .fhide hides non-matching files
   (and dirs with no matching descendant); while filtering, collapsed subtrees open
   VISUALLY so matches inside them are reachable (the persisted collapse state is
   untouched) */
/* the filter sticks just under the (also-sticky) section head so it stays reachable
   while the tree scrolls; opaque bg + a hairline base so rows never show through */
#ffwrap{position:sticky;top:34px;z-index:2;margin:0 0 8px;background:var(--bg);padding-bottom:2px}
#ffilter{width:100%;padding:5px 26px 5px 8px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--fg);font:11px/1.5 var(--mono)}
#ffilter::placeholder{color:var(--mut)}
#ffilter:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
#ffilter-x{position:absolute;right:2px;top:50%;transform:translateY(-50%);padding:0 7px;color:var(--mut);font-size:13px;line-height:1}
#ffilter-x:hover{color:var(--fg)}
#ffilter-x[hidden]{display:none}
#ffcount{margin:0 0 6px;color:var(--mut);font-size:11px;font-variant-numeric:tabular-nums}
#ffcount[hidden]{display:none}
.ftree .fhide{display:none}
.ftree.filtering .tkids[hidden]{display:block}
/* contextual keyboard hint strip (Wave 3: the client swaps its content per state —
   default nav / selection / composer / armed r-chord; the ? overlay has the full map) */
.keyhint{margin:12px 0 0;color:var(--mut);font-size:11px}
.keyhint kbd{font-family:var(--mono);background:#1C2430;border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-right:2px;font-size:10px}
.keyhint .kpend{color:var(--acc);font-weight:600}
/* file cards */
.filecard{margin-bottom:16px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.fhead{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--panel);border-bottom:1px solid var(--line);border-radius:0}
.fhead .path{font-family:var(--mono);font-size:12px;word-break:break-all}
.pdir{color:var(--mut)}
.pbase{color:var(--fg);font-weight:600}
.fhead .stat{margin-left:auto;font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.stat .plus{color:var(--add-fg)}
.stat .minus{color:var(--del-fg)}
.collapse{flex:none;color:var(--mut);padding:0 4px}
.filecard.collapsed .collapse{transform:rotate(-90deg)}
.filecard.collapsed .fbody{display:none}
.filecard.collapsed .fhead{border-bottom:0}
/* per-file Viewed checkbox (card header, right side) */
.viewedlbl{flex:none;display:inline-flex;align-items:center;gap:5px;margin-left:10px;color:var(--mut);font-size:12px;cursor:pointer;user-select:none;-webkit-user-select:none}
.viewedlbl:hover{color:var(--fg)}
.viewedlbl input{margin:0;accent-color:var(--acc)}
/* large-file guard: embedded-but-hidden diff behind a "Load diff" button */
.guard{display:none}
.filecard.large.collapsed .guard{display:block;padding:14px;border-top:1px solid var(--line)}
.filecard.large.collapsed .fhead{border-bottom:0}
.loaddiff{display:block;margin:0 auto;padding:5px 14px;border:1px dashed var(--line);border-radius:8px;color:var(--mut)}
.loaddiff:hover{border-color:var(--acc);color:var(--fg)}
.fbody{overflow-x:auto;background:var(--bg);border-radius:0 0 8px 8px}
.fbody.pad{padding:10px}
.nodiff{margin:0;padding:12px;color:var(--mut)}
/* diff table — border-collapse:separate so sticky gutter cells behave everywhere */
table.diff{border-collapse:separate;border-spacing:0;width:100%;font-family:var(--mono);font-size:12px;line-height:1.7}
td.g{position:sticky;z-index:1;width:44px;min-width:44px;padding:0 8px;text-align:right;vertical-align:top;color:var(--mut);font-variant-numeric:tabular-nums;user-select:none;-webkit-user-select:none;cursor:pointer;background-color:var(--bg)}
td.go{left:0}
td.gn{left:44px}
td.g:focus-visible{outline:2px solid var(--acc);outline-offset:-2px;border-radius:0}
tr.row:not(.hunk) td.g:hover{color:var(--fg)}
tr.hunk td.g{cursor:default}
td.code{white-space:pre;padding:0 12px 0 4px;tab-size:4}
/* +/- markers are CSS generated content, not DOM text: selecting the code column and
   copying yields clean code (gutters are user-select:none; ::before never copies) */
tr.row:not(.hunk) td.code::before{content:"";display:inline-block;width:1.5ch;user-select:none;-webkit-user-select:none}
tr.add td.code::before{content:"+";color:var(--add-fg)}
tr.del td.code::before{content:"-";color:var(--del-fg)}
tr.hunk td{background-color:var(--panel);color:var(--mut);border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding-top:3px;padding-bottom:3px}
/* expandable-context bands (live mode only; the client inserts them at hunk
   boundaries — unified table only, so split mode hides them with the table).
   Whole band is user-select:none: its glyphs/labels never enter a copied range. */
tr.xrow{user-select:none;-webkit-user-select:none}
tr.xrow td{background-color:rgba(76,141,255,.07);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
td.xg{position:sticky;left:0;z-index:1;width:88px;min-width:88px;padding:0;text-align:center;background-color:var(--bg);background-image:linear-gradient(rgba(76,141,255,.12),rgba(76,141,255,.12))}
.xbtn{padding:0 10px;color:var(--acc);font-size:12px;line-height:1.7}
.xbtn:hover{background:var(--sel-bg)}
td.xmsg{padding:0 12px;color:var(--mut);font-size:11px;font-family:var(--mono)}
/* row tints are background-image layers so the sticky cells stay opaque over code */
tr.add td.code{background-image:linear-gradient(var(--add-bg),var(--add-bg))}
tr.add td.g{background-image:linear-gradient(var(--add-g),var(--add-g))}
tr.del td.code{background-image:linear-gradient(var(--del-bg),var(--del-bg))}
tr.del td.g{background-image:linear-gradient(var(--del-g),var(--del-g))}
/* syntax tokens (render-time tokenizer, src/render/highlight.ts) */
.tok-kw{color:var(--tok-kw)}
.tok-str{color:var(--tok-str)}
.tok-num{color:var(--tok-num)}
.tok-com{color:var(--tok-com);font-style:italic}
.tok-fn{color:var(--tok-fn)}
.tok-type{color:var(--tok-type)}
.tok-builtin{color:var(--tok-builtin)}
.tok-op{color:var(--tok-op)}
.tok-punc{color:var(--tok-punc)}
/* intraline word-level marks (src/render/intraline.ts) — a mark spanning several
   tokens is emitted as adjacent <mark>s, so no padding/radius (seams would show) */
td.code mark{color:inherit;padding:0}
mark.ln-add{background:var(--mark-add)}
mark.ln-del{background:var(--mark-del)}
/* split (side-by-side) view — table built CLIENT-side from the unified rows (cloned
   code cells keep syntax tokens + intraline marks); body.split swaps visibility */
table.diff.split{display:none;table-layout:fixed;width:100%}
body.split .fbody>table.diff:not(.split){display:none}
body.split table.diff.split{display:table}
table.split col.cg{width:44px}
table.split td.sc{white-space:pre-wrap;word-break:break-word;vertical-align:top}
table.split td.sc.cl,table.split td.sc.cr{padding:0 12px 0 4px}
table.split td.sc.cl::before,table.split td.sc.cr::before{content:"";display:inline-block;width:1.5ch;user-select:none;-webkit-user-select:none}
table.split td.sc.sadd::before{content:"+";color:var(--add-fg)}
table.split td.sc.sdel::before{content:"-";color:var(--del-fg)}
table.split td.sc.sadd{background-image:linear-gradient(var(--add-bg),var(--add-bg))}
table.split td.g.sadd{background-image:linear-gradient(var(--add-g),var(--add-g))}
table.split td.sc.sdel{background-image:linear-gradient(var(--del-bg),var(--del-bg))}
table.split td.g.sdel{background-image:linear-gradient(var(--del-g),var(--del-g))}
table.split td.emp{background:#10151C}
/* split: selection + layer marks live on the CELLS of the owning side */
table.split td.sc.sel{background-image:linear-gradient(var(--sel-bg),var(--sel-bg))}
table.split td.g.sel{background-image:linear-gradient(var(--sel-g),var(--sel-g));color:var(--fg)}
table.split td.g.hit{box-shadow:inset 3px 0 0 var(--acc)}
#center.scoped table.split tr:not(.hunk):not(.frow):not(.peekrow)>td:not(.in){opacity:.35}
/* whitespace-only pairs (data-ws, computed by whitespace.ts): body.wshide collapses
   each pair to a single ctx-styled row — unified hides the del and neutralizes the
   add; split neutralizes the pair row (both sides already on one row) */
body.wshide tr.del[data-ws]{display:none}
body.wshide tr.add[data-ws] td.code,body.wshide tr.add[data-ws] td.g{background-image:none}
body.wshide tr.add[data-ws] td.code::before{content:""}
body.wshide tr.add[data-ws] td.code mark{background:none}
body.wshide table.split tr[data-ws] td.sc,body.wshide table.split tr[data-ws] td.g{background-image:none}
body.wshide table.split tr[data-ws] td.sc::before{content:""}
body.wshide table.split tr[data-ws] td.sc mark{background:none}
/* word wrap (Wave 4C: z / the topbar toggle): unified code cells soft-wrap instead of
   scrolling under the sticky gutters. Split cells already wrap (table-layout:fixed),
   so the class only needs to touch the unified table. */
body.wrap table.diff:not(.split) td.code{white-space:pre-wrap;word-break:break-word}
/* layer scoping (hunk headers are never dimmed — they orient the reader) */
#center.scoped tr.row:not(.in):not(.hunk){opacity:.35}
#center.scoped tr.frow:not(.in),#center.scoped .fbody.pad>div:not(.in){opacity:.35}
tr.hit td.go{box-shadow:inset 3px 0 0 var(--acc)}
/* sticky line selection (declared after add/del so it wins at equal specificity) */
tr.sel td.code{background-image:linear-gradient(var(--sel-bg),var(--sel-bg))}
tr.sel td.g{background-image:linear-gradient(var(--sel-g),var(--sel-g));color:var(--fg)}
/* flash highlight (finding navigation) */
tr.flash>td,.thread.flash{box-shadow:inset 0 0 0 999px rgba(76,141,255,.22)}
/* inline Threads (Wave 2b) — findings render as the Threads they open; the card
   stays pinned to the visible pane while code scrolls */
tr.frow>td{padding:4px 12px}
.thread{position:sticky;left:12px;overflow:hidden;width:min(760px,calc(100vw - 640px));min-width:280px;background:var(--panel);border:1px solid var(--line);border-radius:8px;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:normal}
.thread::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;z-index:1}
.thread.sev-critical::before{background:var(--sev-critical)}
.thread.sev-major::before{background:var(--sev-major)}
.thread.sev-minor::before{background:var(--sev-minor)}
.thread.sev-info::before{background:var(--sev-info)}
.thread.reviewer::before{background:var(--acc)}
.thread.github::before{background:var(--mut)}
.tcmt{padding:8px 12px 10px 14px;border-top:1px solid var(--line)}
.tcmts>.tcmt:first-child{border-top:0}
.tchd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 0 2px}
.chip{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:1px 8px;border:1px solid currentColor;border-radius:999px}
.chip.critical{color:var(--sev-critical)}
.chip.major{color:var(--sev-major)}
.chip.minor{color:var(--sev-minor)}
.chip.info{color:var(--sev-info)}
.concern{color:var(--mut);font-size:11px}
.floc{margin-left:auto;padding:0;color:var(--mut);font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums}
.floc:hover{color:var(--acc);text-decoration:underline}
.tcbody{padding-top:2px}
.tauthor{font-weight:600;font-size:12px;color:var(--fg);text-decoration:none}
.tauthor:hover,.tlwho:hover{color:var(--acc);text-decoration:underline}
.tcmt.assistant .tauthor{color:var(--sev-info)}
.tcmt.github-comment .tauthor{color:var(--fg)}
.ghavatar{flex:none;width:20px;height:20px;border-radius:50%;background:#1C2430;object-fit:cover}
.ghavatar.fallback{display:inline-grid;place-items:center;border:1px solid var(--line);color:var(--mut);font-size:10px;font-weight:700}
.ghchip,.ghstate{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:1px 7px;border:1px solid currentColor;border-radius:999px;color:var(--mut)}
.ghstate{text-transform:none;letter-spacing:0}
.ghtime{color:var(--mut);font-size:11px;text-decoration:none}
.ghtime:hover{color:var(--acc);text-decoration:underline}
.ghrow .thread,.ghunanchored .thread{border-color:#30363d;background:#151B23}
.ghunanchored{margin-bottom:8px}
.mdimglink{display:inline-block;max-width:100%;margin:6px 0}
.mdimg{display:block;max-width:100%;max-height:520px;border:1px solid var(--line);border-radius:6px;background:var(--bg)}
.thinking{color:var(--mut);font-size:11px}
/* pending reviewer Comments (part of the Review draft): dashed border + chip */
.tcmt.pending{border:1px dashed rgba(76,141,255,.45);border-radius:8px;margin:6px 8px;padding:6px 10px 8px}
.pendchip{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:1px 8px;border:1px dashed var(--acc);border-radius:999px;color:var(--acc)}
/* thread footer (live mode only; the client injects it): Reply… + Resolve */
.tfoot{display:flex;align-items:center;gap:8px;padding:8px 12px 10px 14px;border-top:1px solid var(--line)}
.treply{flex:1;text-align:left;padding:5px 10px;border:1px dashed var(--line);border-radius:6px;color:var(--mut);font-size:12px}
.treply:hover{border-color:var(--acc);color:var(--fg)}
.tbtn{flex:none;padding:3px 10px;border:1px solid var(--line);border-radius:999px;color:var(--mut);font-size:12px}
.tbtn:hover:not(:disabled){border-color:var(--acc);color:var(--fg)}
.tbtn:disabled{opacity:.45;cursor:default}
/* reply editor (collapsed to the Reply… affordance until opened) */
.teditor{display:none;padding:8px 12px 10px 14px;border-top:1px solid var(--line)}
.thread.editing .teditor{display:block}
.thread.editing .tfoot{display:none}
.teditor textarea,.composer textarea{width:100%;min-height:64px;resize:vertical;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--fg);font:12px/1.5 var(--mono);padding:8px 10px}
.teditor textarea:focus-visible,.composer textarea:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.tacts{display:flex;align-items:center;gap:8px;margin-top:6px}
.tacts .thint{margin-left:auto;color:var(--mut);font-size:11px}
.terr{margin:6px 0 0;color:var(--sev-critical);font-size:12px}
/* resolved threads collapse to a pill; click expands (Unresolve in the footer) */
.thread.resolved .tcmts,.thread.resolved .teditor,.thread.resolved .tfoot{display:none}
.thread.resolved.expanded .tcmts{display:block}
.thread.resolved.expanded .tfoot{display:flex}
.thread.resolved .treply{display:none}
.thread.resolved::before{background:var(--line)}
.tpill{display:none;width:100%;text-align:left;padding:8px 12px 8px 14px;color:var(--mut);font-size:12px}
.thread.resolved .tpill{display:block}
.tpill:hover{color:var(--fg)}
.tpill .ok{color:var(--add-fg)}
/* suggestion-fence mini-diff (Phase A, render only — threadsui.ts suggestionHtml):
   tint-only lines, +/- markers are ::before content so copying yields clean code */
.sugg{margin:6px 0;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.sughd{padding:3px 10px;background:#1C2430;color:var(--mut);font-size:11px;border-bottom:1px solid var(--line)}
.sugg pre{margin:0;padding:6px 0;background:#0d1117;overflow-x:auto;font:11px/1.6 var(--mono)}
.sugg code{display:block;background:none;padding:0;font-size:inherit}
.sline{display:block;padding:0 10px 0 4px;white-space:pre}
.sline::before{content:"";display:inline-block;width:1.5ch;user-select:none;-webkit-user-select:none}
.sline.sdel{background:var(--del-bg)}
.sline.sdel::before{content:"-";color:var(--del-fg)}
.sline.sadd{background:var(--add-bg)}
.sline.sadd::before{content:"+";color:var(--add-fg)}
/* inline composer (live mode only): a new Thread on the current selection */
tr.crow>td{padding:4px 12px}
.composer{position:sticky;left:12px;overflow:hidden;width:min(760px,calc(100vw - 640px));min-width:280px;background:var(--panel);border:1px solid var(--acc);border-radius:8px;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:normal;padding:8px 12px 10px}
.composer .clabel{display:block;margin-bottom:6px;color:var(--mut);font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums}
/* pending-review bar (pinned; live mode only) + submit modal */
#pendbar{position:fixed;z-index:20;left:50%;bottom:14px;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:8px 14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
#pendbar[hidden]{display:none}
#pend-label{font-size:12px}
#pend-label .verdict{font-weight:600}
#pend-label .verdict.approve{color:var(--add-fg)}
#pend-label .verdict.request_changes{color:var(--sev-critical)}
#pend-label .verdict.comment{color:var(--acc)}
#submitwrap,#exportwrap{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.55);display:grid;place-items:center}
#submitwrap[hidden],#exportwrap[hidden]{display:none}
#submitmodal,#exportmodal{width:min(460px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.6)}
#submitmodal h3,#exportmodal h3{margin:0 0 10px;font-size:14px}
#export-preview{font-size:13px;margin-bottom:10px}
#export-preview .xline{margin:0 0 6px}
#export-preview .xline .verdict{font-weight:600}
#export-preview .xline .verdict.approve{color:var(--add-fg)}
#export-preview .xline .verdict.request_changes{color:var(--sev-critical)}
#export-preview .xline .verdict.comment{color:var(--acc)}
#export-preview .xfiles{margin:0 0 6px;padding-left:18px;max-height:120px;overflow:auto;font:11px/1.6 var(--mono);color:var(--mut)}
#export-preview .xwarn{margin:6px 0 0;color:var(--sev-major);font-size:12px}
#export-preview .xdone{margin:0;color:var(--add-fg)}
#export-preview .xdone a{color:var(--acc);word-break:break-all}
/* Wave 4B: "Changes since last scaffold" — slim dismissible banner under the
   topbar (shown by the client only when the store holds older versions) + the
   what-changed panel it opens */
#verbanner{flex:none;display:flex;align-items:center;gap:10px;padding:5px 18px;background:var(--panel);border-bottom:1px solid var(--line);font-size:12px;color:var(--mut)}
#verbanner[hidden]{display:none}
#verbanner .vdot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--sev-info)}
#verbanner .vlnk{padding:0;color:var(--acc)}
#verbanner .vlnk:hover{text-decoration:underline}
#verbanner-close{margin-left:auto;padding:0 4px;color:var(--mut);font-size:14px;line-height:1}
#verbanner-close:hover{color:var(--fg)}
#verswrap{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.55);display:grid;place-items:center}
#verswrap[hidden]{display:none}
#versmodal{width:min(600px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.6)}
#versmodal h3{margin:0 0 10px;font-size:14px}
#vers-picker{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
#vers-picker[hidden]{display:none}
.vpick{padding:3px 10px;border:1px solid var(--line);border-radius:999px;color:var(--mut);font:11px/1.6 var(--mono);font-variant-numeric:tabular-nums}
.vpick:hover{border-color:var(--acc);color:var(--fg)}
.vpick.on{border-color:var(--acc);color:var(--fg)}
#vers-counts{margin:0 0 4px;font-size:12px;color:var(--fg)}
#vers-sections h4{margin:12px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
#vers-sections ul{margin:0;padding-left:18px}
#vers-sections li{font:11px/1.8 var(--mono);word-break:break-word}
.verdicts{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
.verdicts label{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
.verdicts input{accent-color:var(--acc);margin:0}
#submit-summary{width:100%;min-height:84px;resize:vertical;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--fg);font:12px/1.5 var(--mono);padding:8px 10px;margin-bottom:10px}
/* Wave 7: Scaffolder picker modal (Process PR) */
#procwrap{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.55);display:grid;place-items:center}
#procwrap[hidden]{display:none}
#procmodal{width:min(440px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.6)}
#procmodal h3{margin:0 0 6px;font-size:14px}
.prochelp{margin:0 0 12px;color:var(--mut);font-size:12px}
#proc-choices{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
/* Group header label row */
.procgroup{font:10px/2 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--mut);padding:0 2px;margin-top:6px;border-bottom:1px solid var(--line)}
.procgroup:first-child{margin-top:0}
.procopt{display:flex;align-items:baseline;gap:8px;font-size:13px;cursor:pointer;padding:2px 4px;border-radius:4px}
.procopt:hover:not(.disabled){background:rgba(255,255,255,.04)}
.procopt input{accent-color:var(--acc);margin:0;flex:none;position:relative;top:1px}
.procopt.disabled{color:var(--mut);cursor:default}
/* Reason text for disabled rows — replaces the old .prochint */
.procreason{color:var(--mut);font-size:11px;font-style:italic;margin-left:auto;white-space:nowrap}
.prochint{color:var(--mut);font-size:11px;font-style:italic}
/* Progress area: spinner + elapsed timer + stage list */
#proc-progress{margin:0 0 12px}
#proc-progress-hd{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.proc-spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--acc);border-radius:50%;animation:proc-spin .7s linear infinite}
@keyframes proc-spin{to{transform:rotate(360deg)}}
#proc-timer{font:11px/1 var(--mono);color:var(--mut);min-width:36px}
#proc-stages-wrap{max-height:160px;overflow:auto}
#proc-stages{list-style:none;margin:0;padding:0}
#proc-stages li{font:11px/1.7 var(--mono);color:var(--mut);padding-left:14px;position:relative}
#proc-stages li::before{content:"›";position:absolute;left:0;color:var(--acc)}
#proc-stages li.pdone{color:var(--fg)}
#proc-stages li.perror{color:var(--sev-critical)}
#proc-stages li.pgood::before{content:"✓";color:var(--add-fg)}
/* Assistant model dropdown by #chat-model */
#chat-model-select{background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--fg);font-family:var(--mono);font-size:11px;padding:1px 4px;margin-left:6px}
#chat-model-select[hidden]{display:none}
#chat-model-note[hidden]{display:none}
/* unscaffolded left-rail hint (explore-first) */
.railhint{list-style:none;margin:6px 0;padding:10px 12px;border:1px dashed var(--line);border-radius:8px;color:var(--mut);font-size:12px;line-height:1.5}
.railhint strong{color:var(--fg);font-weight:600}
/* right panel — the ⤢ toggle widens it LEFTWARD over the diff as an overlay
   (absolute within .grid, so it never reflows the diff); Esc or re-click restores */
.sidehd{display:flex;align-items:center;gap:8px;margin:0 0 10px}
.sidehd h2.sect{flex:1;margin:0}
.sidetabs{flex:1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px}
.sidetab{min-width:0;padding:4px 6px;border:1px solid var(--line);border-radius:6px;color:var(--mut);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sidetab:hover{border-color:var(--acc);color:var(--fg)}
.sidetab.on{border-color:var(--acc);background:var(--sel-bg);color:var(--fg)}
.sidepane{display:none}
.sidepane.on{display:block}
#bexpand{flex:none;color:var(--mut);font-size:12px;line-height:1.4;padding:0 7px;border:1px solid var(--line);border-radius:6px}
#bexpand:hover{border-color:var(--acc);color:var(--fg)}
#bexpand[aria-pressed="true"]{border-color:var(--acc);color:var(--fg)}
#side.expanded{position:absolute;top:0;right:0;bottom:0;z-index:25;width:min(680px,calc(100vw - 300px));background:var(--panel);border-left:1px solid var(--line);box-shadow:-14px 0 44px rgba(0,0,0,.55)}
.bundle{display:none}
.bundle.on{display:block}
.bundle h3{margin:0 0 4px;font-size:13px}
.bfile{margin:0 0 10px;color:var(--mut);font-family:var(--mono);font-size:11px;word-break:break-all}
.bundle h4{margin:16px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.summary{margin:0;color:var(--fg)}
.neighbors,.history{list-style:none;margin:0;padding:0}
.neighbors li,.history li{margin-bottom:8px}
.sig{display:block;color:var(--mut);font-size:11px;margin-top:2px}
.one{display:block;color:var(--mut);font-size:12px;margin-top:2px}
h4.sect{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:12px 0 6px}
li.nbr{list-style:none;padding:4px 0;border-bottom:1px solid var(--line)}
li.nbr:last-child{border-bottom:0}
.nref{display:flex;align-items:baseline;min-width:0;font-family:var(--mono);font-size:11px;overflow:hidden}
.npath{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mut)}
.nsym{flex:0 0 auto;white-space:nowrap;color:var(--fg)}
.nsig{display:block;font-family:var(--mono);font-size:10.5px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nbr .one{display:block;font-family:var(--sans);font-size:12px;color:var(--fg)}
.alllayers{list-style:none;margin:12px 0 0;padding:0}
.alllayers li{margin-bottom:12px}
.alllayers .ord{display:inline-grid;width:20px;height:20px;margin-right:6px;font-size:11px;vertical-align:middle}
.chat{margin-top:18px;border-top:1px solid var(--line);padding-top:14px}
#conv-tools{display:flex;align-items:center;gap:8px;margin:0 0 10px}
#conv-refresh{margin-left:auto;padding:3px 10px;border:1px solid var(--line);border-radius:6px;color:var(--mut);font-size:11px}
#conv-refresh:hover{border-color:var(--acc);color:var(--fg)}
.timeline{display:flex;flex-direction:column;gap:8px}
.tlcard{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.tlcard.github{border-left:3px solid var(--mut)}
.tlcard.local{border-left:3px solid var(--acc);border-style:dashed}
.tlhd{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;color:var(--mut);font-size:11px}
.tlwho{color:var(--fg);font-weight:600;text-decoration:none}
.tlsrc{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:1px 7px;border:1px solid currentColor;border-radius:999px;color:var(--mut)}
.tlsrc.local{color:#D9B54A;border-style:dashed}
.tlloc{margin-left:auto;color:var(--mut);font-family:var(--mono);font-size:10.5px}
.tllinktime{color:var(--mut);font-size:11px;text-decoration:none}
.tllinktime:hover{color:var(--acc);text-decoration:underline}
.tlbody{font-size:12px;line-height:1.5}
.tlbody>:first-child{margin-top:0}
.tlbody>:last-child{margin-bottom:0}
.tlreply{margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.tlerr{color:var(--sev-major);font-size:12px}
.emptytab{margin:8px 0;color:var(--mut);font-size:12px}
#chat-model{text-transform:none;letter-spacing:0;font-weight:400;color:var(--mut);font-family:var(--mono);font-size:11px}
#chat-log{display:flex;flex-direction:column;gap:8px;max-height:44vh;overflow-y:auto;margin:0 0 10px}
#chat-log[hidden]{display:none}
.msg{padding:6px 10px;border-radius:8px;font-family:var(--mono);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg.you{align-self:flex-end;max-width:92%;background:#1C2430}
.msg.ai{align-self:stretch;background:var(--panel);border:1px solid var(--line)}
.msg.sys{padding:2px 0;color:var(--mut);font-size:11px}
/* markdown bodies (renderMarkdown in markdown.ts, shipped inside the inline JS):
   chat you/ai bubbles AND thread Comment bodies (.tcbody) hold rendered HTML, so
   prose spacing comes from margins, not pre-wrap */
.msg.you,.msg.ai{white-space:normal;font:12px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.msg>:first-child,.tcbody>:first-child{margin-top:0}
.msg>:last-child,.tcbody>:last-child{margin-bottom:0}
.msg p,.msg ul,.msg ol,.msg blockquote,.msg table,.tcbody p,.tcbody ul,.tcbody ol,.tcbody blockquote,.tcbody table{margin:6px 0}
.msg h1,.msg h2,.msg h3,.tcbody h1,.tcbody h2,.tcbody h3{margin:10px 0 4px;line-height:1.3}
.msg h1,.tcbody h1{font-size:14px}
.msg h2,.tcbody h2{font-size:13px}
.msg h3,.tcbody h3{font-size:12px}
.msg ul,.msg ol,.tcbody ul,.tcbody ol{padding-left:18px}
.msg li,.tcbody li{margin:2px 0}
.msg li>ul,.msg li>ol,.tcbody li>ul,.tcbody li>ol{margin:2px 0}
.msg blockquote,.tcbody blockquote{padding:2px 10px;border-left:3px solid var(--line);color:var(--mut)}
.msg a,.tcbody a{color:var(--acc)}
.msg hr,.tcbody hr{border:0;border-top:1px solid var(--line);margin:8px 0}
.msg table,.tcbody table{display:block;overflow-x:auto;max-width:100%;border-collapse:collapse}
.msg th,.msg td,.tcbody th,.tcbody td{border:1px solid var(--line);padding:3px 8px;text-align:left}
.msg th,.tcbody th{background:#1C2430}
.mdfence{position:relative;margin:6px 0}
.mdfence pre{margin:0;padding:8px 10px;background:#0d1117;border:1px solid var(--line);border-radius:6px;overflow-x:auto;font:11px/1.6 var(--mono)}
.mdfence code{display:block;background:none;padding:0;font-size:inherit;white-space:pre}
.mdcopy{position:absolute;top:5px;right:5px;padding:1px 8px;background:var(--panel);border:1px solid var(--line);border-radius:6px;color:var(--mut);font-size:11px}
.mdcopy:hover{border-color:var(--mut);color:var(--fg)}
#chat-input{width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--fg);font:12px/1.5 var(--mono)}
#chat-input:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
#chat-input:disabled{opacity:.6}
#chat-busy{margin:6px 0 0;color:var(--mut);font-size:12px}
#ask-note{margin:8px 0 0;color:var(--mut);font-size:12px}
.chat .hint{margin:8px 0 0;color:var(--mut);font-size:12px}
/* ── Wave LSP (live mode only; every element below stays hidden/absent in a static
   artifact — the client injects/un-hides them only after /api/health carries lsp) ── */
/* header status chip */
#lsp-chip{flex:none;display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;color:var(--mut);font-size:12px;white-space:nowrap;cursor:default}
#lsp-chip[hidden]{display:none}
#lsp-chip .dot{width:7px;height:7px;border-radius:50%;background:var(--mut)}
#lsp-chip.on{color:var(--fg)}
#lsp-chip.on .dot{background:var(--add-fg)}
/* hover tooltip: floating panel, never covering the hovered line (above by default) */
#lsp-tip{position:fixed;z-index:30;max-width:480px;max-height:260px;overflow:auto;padding:8px 12px;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5);font:12px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
#lsp-tip[hidden]{display:none}
#lsp-tip>:first-child{margin-top:0}
#lsp-tip>:last-child{margin-bottom:0}
#lsp-tip p,#lsp-tip ul,#lsp-tip ol{margin:6px 0}
/* fenced signatures inside the tooltip reuse the chat .mdfence monospace styling */
/* peek definition: inline expandable panel injected below the current row */
tr.peekrow>td{padding:4px 12px}
.peek{position:sticky;left:12px;overflow:hidden;width:min(760px,calc(100vw - 640px));min-width:280px;background:var(--panel);border:1px solid var(--acc);border-radius:8px;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:normal}
.pkhd{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line)}
.pkt{font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums}
.pkx{margin-left:auto;color:var(--mut);font-size:14px;padding:0 4px}
.pkx:hover{color:var(--fg)}
.pkbody{max-height:220px;overflow:auto;padding:6px 10px}
.pkitem{margin:4px 0}
.pkloc{padding:0;color:var(--mut);font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums}
.pkloc:hover{color:var(--acc);text-decoration:underline}
.pkitem.focus .pkloc{color:var(--acc)}
.pkjump{margin-left:8px;padding:0 8px;border:1px solid var(--acc);border-radius:999px;color:var(--acc);font-size:11px}
.pkjump:hover{background:var(--sel-bg)}
.pkprev{display:none;margin:4px 0 0;padding:6px 8px;background:#0d1117;border:1px solid var(--line);border-radius:6px;overflow-x:auto;font:11px/1.6 var(--mono);color:var(--fg);white-space:pre}
.pkitem.focus .pkprev{display:block}
/* scrollbar thread markers (Wave 4C): a slim fixed strip overlaying the right edge
   of the diff pane (never a replacement scrollbar). Document offsets map to strip
   fractions via markers.ts; open threads take the accent, resolved go muted, and
   findings nobody engaged with yet carry their severity color (inline, from the
   card's sev-* class). Only the markers take the pointer, never the strip. */
#markstrip{position:fixed;z-index:15;width:10px;pointer-events:none}
#markstrip[hidden]{display:none}
.mk{position:absolute;left:2px;width:6px;height:4px;margin-top:-2px;padding:0;border-radius:2px;pointer-events:auto;background:var(--mut)}
.mk:hover{left:0;width:10px}
.mk-open{background:var(--acc)}
.mk-resolved{background:#414B5C}
/* saved replies (Wave 4C, live threads only): one shared fixed dropdown, opened from
   a "Saved replies" button in the composer / reply editors (position set by the
   client — fixed, so the thread cards' overflow:hidden never clips it) */
#rpanel{position:fixed;z-index:45;width:min(340px,72vw);background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.55);padding:6px;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
#rpanel[hidden]{display:none}
.ritem{display:flex;align-items:center;gap:4px}
.ruse{flex:1;min-width:0;text-align:left;padding:4px 6px;border-radius:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.ruse:hover{background:#1C2430}
.rdel{flex:none;padding:0 6px;color:var(--mut);font-size:13px}
.rdel:hover{color:var(--sev-critical)}
.rempty{margin:2px 4px 6px;color:var(--mut);font-size:12px}
.rsave{border-top:1px solid var(--line);margin-top:4px;padding-top:4px}
.rsavebtn{display:block;width:100%;text-align:left;padding:4px 6px;border-radius:6px;color:var(--mut);font-size:12px}
.rsavebtn:hover{background:#1C2430;color:var(--fg)}
.rsavebtn[hidden]{display:none}
.rform{display:flex;gap:6px;padding:2px}
.rform[hidden]{display:none}
.rform input{flex:1;min-width:0;padding:4px 8px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--fg);font:11px/1.5 var(--mono)}
.rform button{flex:none;padding:2px 10px;border:1px solid var(--acc);border-radius:999px;color:var(--acc);font-size:11px}
/* floating action bar — pointer-events guard: only the buttons take the pointer, so
   the bar's chrome (label, padding, gaps) never blocks re-clicking a gutter under it */
#abar{position:fixed;z-index:10;display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5);pointer-events:none}
#abar button{pointer-events:auto}
#abar[hidden]{display:none}
#abar-label{color:var(--mut);font-family:var(--mono);font-size:11px;font-variant-numeric:tabular-nums}
.askbtn{padding:4px 10px;border-radius:6px;font-size:12px;background:var(--acc);color:#0E1116;font-weight:600}
.askbtn.ghost{background:none;border:1px solid var(--acc);color:var(--acc);font-weight:400}
.askbtn:disabled,.askbtn[aria-disabled="true"]{opacity:.45;cursor:default}
.copybtn{padding:4px 10px;border:1px solid var(--line);border-radius:6px;color:var(--mut);font-size:12px}
.copybtn:hover{border-color:var(--mut);color:var(--fg)}
#abar-close{padding:0 4px;color:var(--mut);font-size:14px}
#abar-close:hover{color:var(--fg)}
/* ── Wave 3 — keyboard-first ── */
/* brief keyboard focus ring (j/k hunk rows, n/p thread cards, layer jumps): 2px
   accent outline; fades ~1s via the animation in the reduced-motion block below
   (the client removes the class after ~1.1s either way) */
.kring{outline:2px solid var(--acc);outline-offset:-2px}
/* (the esc-note .attn flash for unavailable escalation also lives in that block) */
/* ? help overlay: all bindings, grouped; Esc / ? / click-outside dismiss */
#helpwrap{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.55);display:grid;place-items:center}
#helpwrap[hidden]{display:none}
#helpmodal{width:min(780px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.6)}
.helphd{display:flex;align-items:center;margin-bottom:4px}
.helphd h3{margin:0;font-size:14px}
#help-close{margin-left:auto;color:var(--mut);font-size:16px;padding:0 6px}
#help-close:hover{color:var(--fg)}
.helpcols{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:2px 26px}
.helpgroup h4{margin:12px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.hrow{display:flex;align-items:baseline;gap:10px;padding:2px 0;font-size:12px}
.hkeys{flex:none;width:92px;text-align:right;white-space:nowrap;color:var(--fg)}
.hkeys kbd{font-family:var(--mono);background:#1C2430;border:1px solid var(--line);border-radius:4px;padding:0 5px;margin-left:2px;font-size:10px}
.hdesc{color:var(--mut)}
/* t / ⌘K jump palette: centered input over a dimmed backdrop */
#palwrap{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.55)}
#palwrap[hidden]{display:none}
#palette{width:min(560px,calc(100vw - 32px));margin:12vh auto 0;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.6);overflow:hidden}
#pal-input{display:block;width:100%;padding:10px 14px;background:var(--panel);border:0;border-bottom:1px solid var(--line);color:var(--fg);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;outline:none}
#pal-input::placeholder{color:var(--mut)}
#pal-list{list-style:none;margin:0;padding:6px;max-height:320px;overflow-y:auto}
.palitem{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px}
.palitem:hover{background:#1C2430}
.palitem.active{background:var(--sel-bg)}
.palkind{flex:none;width:52px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:0 6px}
.palitem.active .palkind{color:var(--acc);border-color:var(--acc)}
.pallabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:11px}
.palempty{padding:8px;color:var(--mut);font-size:12px;text-align:center}
/* responsive: two columns below 1100px (right panel drops below the diff), single
   column below 760px (rail becomes a horizontal strip). Horizontal overflow stays
   contained in .fbody / #rail — never a page-level scrollbar (body is overflow:hidden). */
@media (max-width:1100px){
  .grid{grid-template-columns:220px 1fr;grid-template-rows:minmax(0,1fr) minmax(0,34vh);grid-template-areas:"rail center" "side side"}
  #rail{grid-area:rail}
  #center{grid-area:center}
  #side{grid-area:side;border-left:0;border-top:1px solid var(--line)}
  /* the panel already spans the full width here: expansion is a no-op */
  #side.expanded{position:static;width:auto;box-shadow:none;border-left:0}
  .thread,.peek,.composer{width:min(760px,calc(100vw - 340px))}
}
@media (max-width:760px){
  .grid{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr) minmax(0,34vh);grid-template-areas:"rail" "center" "side"}
  #rail{display:flex;align-items:stretch;gap:8px;overflow-x:auto;overflow-y:hidden;padding:10px 12px;border-right:0;border-bottom:1px solid var(--line)}
  #rail h2.sect{display:none}
  /* the horizontal layer strip has no room for the tree or the progress bar */
  #filesec{display:none}
  #fprog{display:none}
  #showall{width:auto;flex:none;margin:0;white-space:nowrap}
  #rail ul{display:flex;gap:8px}
  #rail li{flex:none}
  .layerbtn{width:auto;max-width:300px;margin:0}
  .lfile{display:none}
  .thread,.peek,.composer{width:min(760px,calc(100vw - 120px))}
}
@media (prefers-reduced-motion: no-preference){
  .collapse{transition:transform .12s}
  tr.flash>td,.thread.flash{animation:flashfade 1.2s ease-out forwards}
  @keyframes flashfade{0%{box-shadow:inset 0 0 0 999px rgba(76,141,255,.3)}100%{box-shadow:inset 0 0 0 999px rgba(76,141,255,0)}}
  .kring{animation:kringfade 1s ease-out forwards}
  @keyframes kringfade{0%{outline-color:var(--acc)}100%{outline-color:transparent}}
  .hint.attn{animation:escpulse 1.5s ease-out}
  @keyframes escpulse{0%,60%{color:var(--sev-major)}100%{color:var(--mut)}}
}
/* Wave 8 — comment visibility chip + toggle */
/* Local-only chip: dashed border, muted/warn tone — distinct from the accent Pending chip */
.localchip{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:1px 8px;border:1px dashed #D9B54A;border-radius:999px;color:#D9B54A;cursor:pointer}
.localchip:hover{border-color:#F4BE5A;color:#F4BE5A}
/* Publishable affordance: hidden by default, shown on .tchd hover (hover CSS trick) */
.vistoggle{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:1px 8px;border:1px dashed transparent;border-radius:999px;color:transparent;cursor:pointer;transition:color .15s,border-color .15s}
.tchd:hover .vistoggle{color:var(--mut);border-color:var(--line)}
.tchd:hover .vistoggle:hover{color:var(--fg);border-color:var(--acc)}
/* Visibility toggle in composer and reply editor */
.visbtn{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:1px 8px;border:1px dashed var(--line);border-radius:999px;color:var(--mut);cursor:pointer}
.visbtn:hover{border-color:var(--acc);color:var(--fg)}
.visbtn.vis-local{border-color:#D9B54A;color:#D9B54A}
.visbtn.vis-local:hover{border-color:#F4BE5A;color:#F4BE5A}
/* Export modal excluded-local line */
.xlocal{color:var(--sev-minor);font-size:12px}
/* Wave 8 — diff-line context menu */
.diffmenu{position:fixed;z-index:60;min-width:180px;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.55);padding:4px;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.dmitem{display:block;width:100%;text-align:left;padding:6px 10px;border-radius:6px;color:var(--fg);font-size:12px;white-space:nowrap}
.dmitem:hover:not(:disabled){background:#1C2430}
.dmitem:focus{outline:2px solid var(--acc);outline-offset:-2px;border-radius:6px}
.dmitem:disabled{opacity:.6;cursor:default}
.dmsub{padding-left:22px;color:var(--mut);font-size:11px}
.dmsub:hover:not(:disabled){color:var(--fg)}
</style>
<header class="topbar">
  <span class="wordmark">sleek<span class="wdot">.</span></span>
  <h1><span class="prno">${prNoHtml}</span> ${esc(scaffold.pr.title)}</h1>
  <button id="ctoggle" aria-pressed="true" title="Show or hide all inline review comments">Comments · ${totalFindings}</button>
  <button id="gh-refresh" hidden title="Refresh synced GitHub comments">Refresh GitHub</button>
  <button id="stoggle" aria-pressed="false" title="Toggle side-by-side diff view (s)">Unified</button>
  <button id="wtoggle" aria-pressed="false"${wsPairsTotal === 0 ? " disabled" : ""} title="${wsPairsTotal === 0 ? "No whitespace-only changes in this PR" : "Collapse whitespace-only changes (w)"}">Whitespace${wsPairsTotal > 0 ? " · " + wsPairsTotal : ""}</button>
  <button id="ztoggle" aria-pressed="false" title="Soft-wrap long code lines instead of scrolling (z)">Wrap</button>
  <span id="fprog"><span class="pbar" aria-hidden="true"><i id="pfill"></i></span><span id="ptext" role="status">0/${files.length} files viewed</span></span>
  <span id="lsp-chip" hidden><i class="dot"></i>LSP</span>
  <button id="procpr" hidden title="Run the Scaffolder to generate layers and findings for this PR">Process PR</button>
  <button id="finish-review" hidden title="Close this review and remove its disposable cache/worktree">Finish review</button>
  <span id="procchip" hidden role="status" aria-live="polite">
    <span class="proc-spinner" aria-hidden="true"></span>
    <span id="procchip-label">Processing…</span>
    <div id="procchip-bar"><div id="procchip-bar-inner"></div></div>
    <div id="procchip-rows" hidden></div>
    <div id="procchip-eta" hidden></div>
    <div id="procchip-activity" hidden></div>
    <button id="procchip-retry" hidden title="Retry — reopen the Scaffolder picker">Retry</button>
    <button id="procchip-x" title="Cancel processing">×</button>
  </span>
  <span class="meta">${shaHtml} · ${layers.length} layers · ${totalFindings} findings</span>
</header>
<div id="verbanner" hidden>
  <i class="vdot" aria-hidden="true"></i>
  <span id="verbanner-label"></span>
  <button class="vlnk" id="verbanner-open">What changed?</button>
  <button id="verbanner-close" aria-label="Dismiss the scaffold-versions banner">×</button>
</div>
<div class="grid">
  <nav id="rail" aria-label="Layers and files">
    <h2 class="sect">Reading order</h2>
    <button id="showall" aria-disabled="true">Show all</button>
    <ul>${rail}</ul>
    ${filesec}
    <div id="railgrip" role="separator" aria-orientation="vertical" aria-label="Resize file rail" title="Drag to resize · double-click to reset"></div>
  </nav>
  <main id="center">
${cards}
${unanchoredHtml}
  </main>
  <aside id="side">
    <div class="sidehd">
      <div class="sidetabs" role="tablist" aria-label="Right pane">
        <button class="sidetab on" data-side-tab="context" role="tab" aria-selected="true">Model Context</button>
        <button class="sidetab" data-side-tab="prcomments" role="tab" aria-selected="false">PR Comments</button>
        <button class="sidetab" data-side-tab="draft" role="tab" aria-selected="false">Draft Comment</button>
      </div>
      <button id="bexpand" aria-pressed="false" title="Expand panel over the diff (Esc restores)">⤢</button>
    </div>
    <div class="sidepane on" id="side-context">
${bundles}
${allPanel}
    <div class="chat">
      <h2 class="sect">Ask about this PR <span id="chat-model"></span><select id="chat-model-select" hidden aria-label="Assistant model"></select></h2>
      <p class="hint" id="chat-model-note" hidden></p>
      <div id="chat-log" hidden></div>
      <input id="chat-input" placeholder="Select lines in the diff, then ask — or type a question">
      <p id="chat-busy" hidden>thinking…</p>
      <p id="ask-note" hidden></p>
      <p class="hint" id="esc-note" hidden>Ask Opus is disabled — escalation is not configured on this server.</p>
      <p class="hint">Click a line number to select (Enter/Space when focused); shift extends. Esc clears.</p>
    </div>
    </div>
    <div class="sidepane" id="side-pr-comments">
      <h2 class="sect">PR Comments</h2>
      <div id="pr-comments-list" class="timeline"><p class="emptytab">Connect to the live server to load PR comments.</p></div>
    </div>
    <div class="sidepane" id="side-draft">
      <h2 class="sect">Draft Comment</h2>
      <div id="draft-list" class="timeline"><p class="emptytab">Local draft comments will appear here.</p></div>
    </div>
  </aside>
</div>
<div id="markstrip" hidden aria-label="Thread positions in the diff"></div>
<div id="abar" hidden>
  <span id="abar-label"></span>
  <button class="copybtn" id="copy-sel" title="Copy the selected lines' code text">Copy</button>
  <button class="askbtn ghost" id="comment-sel" hidden title="Start a thread on the selected lines (c)">Comment</button>
  <button class="askbtn" id="ask-qwen">Ask qwen (local)</button>
  <button class="askbtn ghost" id="ask-opus">Ask Opus</button>
  <button id="abar-close" aria-label="Clear selection">×</button>
</div>
<div id="pendbar" hidden>
  <span id="pend-label"></span>
  <button class="askbtn" id="pend-submit" hidden>Submit review</button>
  <button class="askbtn ghost" id="pend-export" hidden title="Post the submitted review to the GitHub PR">Post to GitHub</button>
</div>
<div id="submitwrap" hidden role="dialog" aria-modal="true" aria-labelledby="submit-title">
  <div id="submitmodal">
    <h3 id="submit-title">Submit review</h3>
    <div class="verdicts">
      <label><input type="radio" name="verdict" value="approve"> Approve</label>
      <label><input type="radio" name="verdict" value="request_changes"> Request changes</label>
      <label><input type="radio" name="verdict" value="comment" checked> Comment</label>
    </div>
    <textarea id="submit-summary" placeholder="Optional summary (markdown)"></textarea>
    <div class="tacts"><button class="askbtn" id="submit-go">Submit review</button><button class="tbtn" id="submit-cancel">Cancel</button><span class="thint">⌘⇧Enter to submit</span></div>
  </div>
</div>
<div id="exportwrap" hidden role="dialog" aria-modal="true" aria-labelledby="export-title">
  <div id="exportmodal">
    <h3 id="export-title">Post review to GitHub</h3>
    <div id="export-preview"></div>
    <p class="terr" id="export-err" hidden></p>
    <div class="tacts"><button class="askbtn" id="export-go" disabled>Post to GitHub</button><button class="tbtn" id="export-cancel">Cancel</button></div>
  </div>
</div>
<div id="verswrap" hidden role="dialog" aria-modal="true" aria-labelledby="vers-title">
  <div id="versmodal">
    <h3 id="vers-title">Changes since last scaffold</h3>
    <div id="vers-picker" hidden></div>
    <p id="vers-counts"></p>
    <div id="vers-sections"></div>
    <p class="terr" id="vers-err" hidden></p>
    <div class="tacts"><button class="tbtn" id="vers-close">Close</button><span class="thint">Esc to close</span></div>
  </div>
</div>
<div id="procwrap" hidden role="dialog" aria-modal="true" aria-labelledby="proc-title">
  <div id="procmodal">
    <h3 id="proc-title">Process this PR</h3>
    <p class="prochelp">Run the Scaffolder to generate the layered review — layers, context bundles and findings.</p>
    <div id="proc-choices" role="radiogroup" aria-label="Scaffolder"></div>
    <p class="terr" id="proc-err" hidden></p>
    <div id="proc-progress" hidden>
      <div id="proc-progress-hd"><span class="proc-spinner" aria-hidden="true"></span><span id="proc-timer"></span></div>
      <div id="proc-stages-wrap"><ul id="proc-stages"></ul></div>
    </div>
    <div class="tacts">
      <button class="askbtn" id="proc-go">Start</button>
      <button class="askbtn" id="proc-retry" hidden>Retry</button>
      <button class="tbtn" id="proc-cancel">Cancel</button>
    </div>
  </div>
</div>
${HELP_HTML}
${PALETTE_HTML}
<script type="application/json" id="sleek-data">${dataJson}</script>
<script>
${CLIENT_JS}
</script>
`;
}
