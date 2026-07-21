/**
 * Inline client JS for the review page, exported as a template string and embedded
 * verbatim by src/render/html.ts inside its <script> tag. Kept as one literal (not a
 * build step) so the emitted HTML stays a single self-contained file with no external
 * resources. The string below is exactly what ships between <script> and </script>;
 * it reads its data from the <script type="application/json" id="sleek-data"> element
 * that html.ts emits just before it.
 *
 * NOTE this file is a TS template literal: backslash escapes are source-level, so
 * regex literals inside the client code appear as \\d etc. Never introduce a backtick
 * or ${ inside the client code. (The markdown renderer is concatenated in BETWEEN the
 * template parts as a runtime string, so backticks in ITS source are fine.)
 */
import { applyExpansion, expandRange, hunkBoundaries } from "./expandctx.ts";
import { fileLayerIndex } from "./filetree.ts";
import {
  CSS_RE,
  EXT_LANG,
  FENCE_LANG,
  GENERIC_BUILTINS,
  GENERIC_RE,
  HTML_RE,
  JS_BUILTINS,
  JS_KEYWORDS,
  JS_RE,
  JSON_KEYWORDS,
  JSON_RE,
  TYPE_INTRO,
  classifyIdent,
  escapeHtml,
  highlightFence,
  langForFence,
  langForPath,
  nextNonSpace,
  prevNonSpace,
  push,
  renderCodeHtml,
  tokenize,
} from "./highlight.ts";
import { hunkStartRows } from "./keynav.ts";
import { diagRowIndex, lspLangLabel, textOffsetWithin } from "./lsputil.ts";
import {
  assistantModelOptions,
  processButtonVisible,
  scaffolderRadioOptions,
} from "./modelsui.ts";
import {
  failPhase,
  lastSeqFromEvents,
  layerHydrationState,
  nextPhase,
  parseNdjson,
  pickerDismissible,
  reattachDecision,
  scaffoldEtaMs,
  scaffoldLatestActivity,
  scaffoldLayerRows,
  scaffoldPartialLayers,
  scaffoldProgressPct,
  scaffoldStageLabel,
} from "./processui.ts";
import { renderGithubMarkdown, renderMarkdown } from "./markdown.ts";
import { markerStops } from "./markers.ts";
import { fuzzyScore, paletteMatches } from "./palette.ts";
import { groupPublishedComments } from "./publishedui.ts";
import { insertSnippet } from "./repliesui.ts";
import { selAskText, selLabel } from "./selection.ts";
import { fileFilterMatches } from "./treefilter.ts";
import { buildSplitPairs } from "./splitmodel.ts";
import {
  anchorLabel,
  exportPreviewLabel,
  firstLineSummary,
  splitSuggestionBlocks,
  suggestionHtml,
  threadRowIndex,
  verdictLabel,
} from "./threadsui.ts";
import {
  anchorFromRow,
  anchorFromSelection,
  blameCardText,
  formatPathLine,
  formatPermalink,
  menuItems,
} from "./menuui.ts";
import {
  excludedLocalLine,
  visChipClass,
  visPostValue,
  visToggleLabel,
  visToggleTitle,
} from "./visui.ts";
import {
  diffCountsLabel,
  diffSections,
  shortSha,
  versionDateLabel,
  versionOptionLabel,
  versionsBannerLabel,
} from "./versionsui.ts";

// The chat markdown renderer ships by SOURCE so the browser runs the exact function
// the vitest suite covers: markdown.ts authors it as self-contained ES2020 and
// toString() here yields its loaded (type-stripped) source. The tsx/vitest esbuild
// transform's keepNames option wraps inner helpers in an esbuild __name(fn, "name")
// helper call, so a no-op shim is emitted first (harmless when absent).
// buildSplitPairs (splitmodel.ts) ships the same way for the client-built split view,
// the Wave-LSP pure helpers (lsputil.ts) for hover/peek, and the Wave-2b
// thread helpers (threadsui.ts) for Thread cards / suggestion mini-diffs.
const MARKDOWN_JS =
  "var __name = (fn) => fn;\n" +
  renderMarkdown.toString() +
  "\n" +
  renderGithubMarkdown.toString();
const SPLIT_JS = buildSplitPairs.toString();
const LSP_UTIL_JS = [textOffsetWithin, lspLangLabel, diagRowIndex]
  .map((f) => f.toString())
  .join("\n");
const THREADS_UTIL_JS = [
  splitSuggestionBlocks,
  suggestionHtml,
  threadRowIndex,
  firstLineSummary,
  anchorLabel,
  verdictLabel,
  exportPreviewLabel,
]
  .map((f) => f.toString())
  .join("\n");
const PUBLISHED_UI_JS = [groupPublishedComments]
  .map((f) => f.toString())
  .join("\n");
// Wave-4B versions helpers (versionsui.ts) for the "changes since last
// scaffold" banner + panel (versionOptionLabel calls shortSha/versionDateLabel
// by name, so all ship together — the paletteMatches→fuzzyScore pattern).
const VERSIONS_UTIL_JS = [
  shortSha,
  versionDateLabel,
  versionOptionLabel,
  versionsBannerLabel,
  diffCountsLabel,
  diffSections,
]
  .map((f) => f.toString())
  .join("\n");
// Selection label/payload helpers (selection.ts) ship the same way.
const SELECTION_JS = [selLabel, selAskText].map((f) => f.toString()).join("\n");
// Wave-7 in-app model choice: the Scaffolder picker + Assistant dropdown decision
// helpers (modelsui.ts) and the /api/scaffold NDJSON parser + picker state machine
// (processui.ts) ship the same way — pure sources injected, browser runs the exact
// functions modelsui.test.ts / processui.test.ts cover.
const MODELS_UI_JS = [scaffolderRadioOptions, assistantModelOptions, processButtonVisible]
  .map((f) => f.toString())
  .join("\n");
const PROCESS_UI_JS = [parseNdjson, scaffoldStageLabel, nextPhase, failPhase, pickerDismissible, reattachDecision, lastSeqFromEvents, scaffoldProgressPct, scaffoldLayerRows, scaffoldLatestActivity, scaffoldPartialLayers, layerHydrationState, scaffoldEtaMs]
  .map((f) => f.toString())
  .join("\n");
// Expandable-context math (expandctx.ts) too.
const EXPAND_JS = [hunkBoundaries, expandRange, applyExpansion].map((f) => f.toString()).join("\n");
// file→layers membership for tree scoping (filetree.ts) ships the same way.
const TREE_JS = fileLayerIndex.toString();
// Wave-3 keyboard helpers ship the same way: jump-palette fuzzy matching
// (palette.ts — paletteMatches calls fuzzyScore, so both are serialized) and
// hunk iteration for j/k (keynav.ts).
const PALETTE_JS = [fuzzyScore, paletteMatches].map((f) => f.toString()).join("\n");
const KEYNAV_JS = hunkStartRows.toString();
// Wave-4C helpers ship the same way: scrollbar-marker position math (markers.ts),
// file-filter matching (treefilter.ts) and saved-reply caret insertion (repliesui.ts).
const MARKERS_JS = markerStops.toString();
const TREEFILTER_JS = fileFilterMatches.toString();
const REPLIES_UTIL_JS = insertSnippet.toString();
// Wave-8 visibility helpers (visui.ts) ship the same way.
const VIS_UI_JS = [visChipClass, visToggleLabel, visToggleTitle, visPostValue, excludedLocalLine]
  .map((f) => f.toString())
  .join("\n");
// Wave-8 context menu helpers (menuui.ts) ship the same way.
const MENU_UI_JS = [menuItems, formatPathLine, formatPermalink, blameCardText, anchorFromRow, anchorFromSelection]
  .map((f) => f.toString())
  .join("\n");
// The syntax highlighter (highlight.ts) highlights live-expanded context rows in the
// browser. Its functions reference module-level tables/regexes by name, so those are
// serialized alongside the function sources (Sets/records via JSON, regexes via their
// literal form; tokenize resets lastIndex itself, so shipping the /g literals is safe).
const HIGHLIGHT_JS = [
  "var EXT_LANG = " + JSON.stringify(EXT_LANG) + ";",
  "var FENCE_LANG = " + JSON.stringify(FENCE_LANG) + ";",
  "var JS_KEYWORDS = new Set(" + JSON.stringify([...JS_KEYWORDS]) + ");",
  "var JSON_KEYWORDS = new Set(" + JSON.stringify([...JSON_KEYWORDS]) + ");",
  "var JS_BUILTINS = new Set(" + JSON.stringify([...JS_BUILTINS]) + ");",
  "var GENERIC_BUILTINS = new Set(" + JSON.stringify([...GENERIC_BUILTINS]) + ");",
  "var TYPE_INTRO = new Set(" + JSON.stringify([...TYPE_INTRO]) + ");",
  "var JS_RE = " + JS_RE.toString() + ";",
  "var JSON_RE = " + JSON_RE.toString() + ";",
  "var CSS_RE = " + CSS_RE.toString() + ";",
  "var HTML_RE = " + HTML_RE.toString() + ";",
  "var GENERIC_RE = " + GENERIC_RE.toString() + ";",
  escapeHtml.toString(),
  langForPath.toString(),
  langForFence.toString(),
  highlightFence.toString(),
  push.toString(),
  prevNonSpace.toString(),
  nextNonSpace.toString(),
  classifyIdent.toString(),
  tokenize.toString(),
  renderCodeHtml.toString(),
].join("\n");

export const CLIENT_JS = `(() => {
  "use strict";
  // ── Chat markdown renderer (source injected from src/render/markdown.ts) ──
` + MARKDOWN_JS + `
  // ── Split-view row pairing (source injected from src/render/splitmodel.ts) ──
` + SPLIT_JS + `
  // ── Wave-LSP pure helpers (source injected from src/render/lsputil.ts) ──
` + LSP_UTIL_JS + `
  // ── Wave-2b thread helpers (source injected from src/render/threadsui.ts) ──
` + THREADS_UTIL_JS + `
  // ── Published GitHub comment helpers (source injected from src/render/publishedui.ts) ──
` + PUBLISHED_UI_JS + `
  // ── Wave-4B versions helpers (source injected from src/render/versionsui.ts) ──
` + VERSIONS_UTIL_JS + `
  // ── Selection label/payload helpers (source injected from src/render/selection.ts) ──
` + SELECTION_JS + `
  // ── Wave-7 model-choice helpers (source injected from src/render/modelsui.ts) ──
` + MODELS_UI_JS + `
  // ── Wave-7 scaffold-run helpers (source injected from src/render/processui.ts) ──
` + PROCESS_UI_JS + `
  // ── Expandable-context math (source injected from src/render/expandctx.ts) ──
` + EXPAND_JS + `
  // ── file→layers membership index (source injected from src/render/filetree.ts) ──
` + TREE_JS + `
  // ── Jump-palette fuzzy matching (source injected from src/render/palette.ts) ──
` + PALETTE_JS + `
  // ── Hunk iteration for j/k (source injected from src/render/keynav.ts) ──
` + KEYNAV_JS + `
  // ── Scrollbar-marker math (source injected from src/render/markers.ts) ──
` + MARKERS_JS + `
  // ── File-filter matching (source injected from src/render/treefilter.ts) ──
` + TREEFILTER_JS + `
  // ── Saved-reply caret insertion (source injected from src/render/repliesui.ts) ──
` + REPLIES_UTIL_JS + `
  // ── Wave-8 visibility helpers (source injected from src/render/visui.ts) ──
` + VIS_UI_JS + `
  // ── Wave-8 context menu helpers (source injected from src/render/menuui.ts) ──
` + MENU_UI_JS + `
  // ── Syntax highlighter (source + tables injected from src/render/highlight.ts) ──
` + HIGHLIGHT_JS + `
  const DATA = JSON.parse(document.getElementById("sleek-data").textContent);
  const center = document.getElementById("center");
  const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const fileIndex = new Map(DATA.files.map((f, i) => [f.path, i]));
  const rowEl = (fi, ri) => document.getElementById("r-" + fi + "-" + ri);

  // ── Split-view registries (filled lazily by buildSplit on the first switch) ──
  // Marks/selection in split mode live on the owning SIDE's cells, so every helper
  // that touches a (fi, ri) row goes through cellsFor/visibleRowEl.
  const splitCells = []; // fi → Map(ri → [gutter/code tds of that row's side])
  const splitTrs = [];   // fi → Map(ri → the pair/ctx <tr> containing the row)
  let splitOn = false;
  // fi → DATA row indexes in DISPLAY order. Created lazily by the expandable-context
  // layer: expanded rows append to DATA.files[fi].rows (so every ri-keyed registry
  // stays valid) but display mid-file, so anything that walks a visual range (line
  // selection, split pairing) resolves order through here. Absent (the common case)
  // means index order IS display order.
  const rowOrder = [];
  const cellsFor = (fi, ri) => (splitCells[fi] && splitCells[fi].get(ri)) || [];
  function visibleRowEl(fi, ri) {
    if (splitOn && splitTrs[fi]) {
      const tr = splitTrs[fi].get(ri);
      if (tr) return tr;
    }
    return rowEl(fi, ri);
  }

  // Selection labels come from the injected selLabel (selection.ts): GitHub model,
  // with mixed selections disclosing the deleted rows the single-side Ask payload
  // drops ("file:A–B (+N deleted lines not included)").

  // Anchor→row mapping: hits = side-matching changed rows in range (get stripe +
  // count); span = context rows in range (stay bright when scoped, no stripe).
  function scopeOf(layer) {
    const hits = [], span = [];
    for (const a of layer.anchors) {
      const fi = fileIndex.get(a.file);
      if (fi === undefined) continue;
      DATA.files[fi].rows.forEach((r, ri) => {
        const line = a.side === "RIGHT" ? r.n : r.o;
        if (line === null || line < a.startLine || line > a.endLine) return;
        if (a.side === "RIGHT" ? r.t === "a" : r.t === "d") hits.push([fi, ri]);
        else if (r.t === "c") span.push([fi, ri]);
      });
    }
    const byPos = (x, y) => x[0] - y[0] || x[1] - y[1];
    hits.sort(byPos); span.sort(byPos);
    return { hits, span };
  }
  const scopes = DATA.layers.map(scopeOf);
  // file→layers membership (injected fileLayerIndex): FILE_LAYERS[fi] lists the
  // layers with ≥1 anchor in that file (many-to-many) — drives tree scoping.
  const FILE_LAYERS = fileLayerIndex(DATA.files.map((f) => f.path), DATA.layers);
  // fmtLines: compact display for changed-line counts (mirrors html.ts fmtLines).
  // Self-contained (no imports) — inlined here because this runs through fn.toString().
  function fmtLines(n) {
    if (n < 10000) return n.toLocaleString("en-US") + " lines";
    return (Math.round(n / 100) / 10).toFixed(1) + "k lines";
  }
  scopes.forEach((s, li) => {
    const el = document.querySelector('[data-rc="' + li + '"]');
    if (el) el.textContent = fmtLines(s.hits.length);
  });

  // All rows a finding's anchor covers (changed + in-span context), for jump/flash.
  function anchorRows(a) {
    const fi = fileIndex.get(a.file);
    if (fi === undefined) return [];
    const out = [];
    DATA.files[fi].rows.forEach((r, ri) => {
      if (r.t === "h") return;
      const line = a.side === "RIGHT" ? r.n : r.o;
      if (line === null || line < a.startLine || line > a.endLine) return;
      out.push([fi, ri]);
    });
    return out;
  }

  function currentLinesForAnchor(anchor) {
    return anchorRows(anchor).map(([fi, ri]) => {
      const el = rowEl(fi, ri);
      const code = el ? el.querySelector("td.code") : null;
      return code ? code.textContent : "";
    });
  }

  function commentBodyHtml(body, currentLines, lang) {
    const lineHtml = (t) => renderCodeHtml(t, lang, [], "ln-add");
    return splitSuggestionBlocks(body)
      .map((s) => (s.kind === "suggestion" ? suggestionHtml(currentLines, s.text, lineHtml) : renderMarkdown(s.text, highlightFence)))
      .join("");
  }

  function githubCommentBodyHtml(body, currentLines, lang) {
    const lineHtml = (t) => renderCodeHtml(t, lang, [], "ln-add");
    return splitSuggestionBlocks(body)
      .map((s) => (s.kind === "suggestion" ? suggestionHtml(currentLines, s.text, lineHtml) : renderGithubMarkdown(s.text, highlightFence)))
      .join("");
  }

  function sourceLabel(source) {
    if (source === "github-review-comment") return "GitHub inline";
    if (source === "github-review") return "GitHub review";
    if (source === "github-issue-comment") return "GitHub comment";
    return "GitHub";
  }

  // ── Layer state ──
  // Three states: neutral (no active layer, "All layers" panel), soft-active (rail
  // active + bundle + stripes, NO dimming — the load state and the "Show all" state),
  // scoped-active (all of the above + everything else dimmed).
  const layerBtns = [...document.querySelectorAll(".layerbtn")];
  const bundles = [...document.querySelectorAll(".bundle")];
  const showallBtn = document.getElementById("showall");
  let activeLayer = -1;
  let scoped = false;

  const showBundle = (key) => bundles.forEach((b) => b.classList.toggle("on", b.dataset.li === key));
  const railActive = (li) => layerBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.li) === li));
  function updateShowAll() {
    showallBtn.setAttribute("aria-disabled", String(!scoped));
  }
  function clearMarks() {
    document.querySelectorAll(".in, .hit").forEach((el) => el.classList.remove("in", "hit"));
  }
  function applyMarks(li) {
    clearMarks();
    const s = scopes[li];
    for (const [fi, ri] of s.hits) {
      const el = rowEl(fi, ri); if (el) el.classList.add("in", "hit");
      for (const c of cellsFor(fi, ri)) c.classList.add("in", "hit");
    }
    for (const [fi, ri] of s.span) {
      const el = rowEl(fi, ri); if (el) el.classList.add("in");
      for (const c of cellsFor(fi, ri)) c.classList.add("in");
    }
    for (const f of DATA.layers[li].findings) { const el = document.getElementById(f.id); if (el) el.classList.add("in"); }
    // Live reviewer Threads (Wave 2b) scope like findings: a thread card is
    // in-scope when its anchor row is. Seeded finding threads are the loop above;
    // only client-inserted thread rows carry data-tid on the <tr>.
    const inSet = new Set();
    for (const [fi, ri] of s.hits) inSet.add(fi + ":" + ri);
    for (const [fi, ri] of s.span) inSet.add(fi + ":" + ri);
    document.querySelectorAll("tr.frow[data-tid],tr.frow[data-ghid]").forEach((fr) => {
      if (inSet.has(fr.dataset.fi + ":" + fr.dataset.ri)) fr.classList.add("in");
    });
  }
  function softActivate(li) {
    activeLayer = li; scoped = false;
    center.classList.remove("scoped");
    applyMarks(li); railActive(li); showBundle(String(li)); updateShowAll(); updateTreeScope();
  }
  function activateLayer(li, scroll) {
    activeLayer = li; scoped = true;
    center.classList.add("scoped");
    applyMarks(li); railActive(li); showBundle(String(li)); updateShowAll(); updateTreeScope();
    if (!scroll) return;
    const s = scopes[li];
    const first = s.hits[0] || s.span[0];
    if (first) {
      const el = visibleRowEl(first[0], first[1]);
      if (el) {
        const card = el.closest(".filecard");
        if (card) setCardCollapsed(card, false);
        el.scrollIntoView({ behavior, block: "center" });
      }
    }
  }
  function deactivate() {
    activeLayer = -1; scoped = false;
    center.classList.remove("scoped");
    clearMarks(); railActive(-1); showBundle("all"); updateShowAll(); updateTreeScope();
  }

  // ── Comments visibility (header toggle + h key; hides tr.frow thread rows and
  // unanchored thread divs). The count starts at the embedded findings total and
  // tracks the live thread total once /api/threads answers. ──
  const ctoggle = document.getElementById("ctoggle");
  const totalFindings = DATA.layers.reduce((n, l) => n + l.findings.length, 0);
  let localThreadCount = totalFindings;
  let githubCommentCount = 0;
  let commentCount = localThreadCount + githubCommentCount;
  let commentsShown = true;
  function setComments(on) {
    commentsShown = on;
    document.body.classList.toggle("nocomments", !on);
    ctoggle.textContent = "Comments \xb7 " + commentCount;
    ctoggle.setAttribute("aria-pressed", String(on));
    scheduleMarkers(); // thread rows appear/disappear; offsets move
  }
  function refreshCommentCount() {
    commentCount = localThreadCount + githubCommentCount;
    setComments(commentsShown);
  }
  function updateLocalThreadCount(n) {
    localThreadCount = n;
    refreshCommentCount();
  }
  function updateGithubCommentCount(n) {
    githubCommentCount = n;
    refreshCommentCount();
  }
  ctoggle.addEventListener("click", () => setComments(!commentsShown));

  // ── Finding navigation: flash + per-layer cycling ──
  const findingCursor = new Map();
  function flashEl(el) {
    if (!el) return;
    el.classList.remove("flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1400);
  }
  function revealAndCenter(el) {
    const card = el.closest(".filecard");
    if (card) setCardCollapsed(card, false);
    el.scrollIntoView({ behavior, block: "center" });
  }
  function cycleFinding(li) {
    const ids = DATA.layers[li].findings.map((f) => f.id);
    if (!ids.length) return;
    if (!commentsShown) setComments(true); // hidden comments can't be cycled to
    if (activeLayer !== li || !scoped) activateLayer(li, false);
    const i = ((findingCursor.get(li) ?? -1) + 1) % ids.length;
    findingCursor.set(li, i);
    const el = document.getElementById(ids[i]);
    if (!el) return;
    revealAndCenter(el);
    flashEl(el.querySelector(".thread") || el);
  }

  layerBtns.forEach((b) => b.addEventListener("click", (e) => {
    const li = Number(b.dataset.li);
    if (e.target.closest(".fcount")) { cycleFinding(li); return; }
    if (li === activeLayer && scoped) deactivate();
    else activateLayer(li, true);
  }));
  // Keyboard path for finding-cycling (the .fcount span is mouse-only): on a focused
  // layer button, "f" cycles that layer's findings; Enter does too once the layer is
  // already scoped-active (otherwise Enter keeps its normal activate/toggle click).
  layerBtns.forEach((b) => b.addEventListener("keydown", (e) => {
    const li = Number(b.dataset.li);
    if (!DATA.layers[li].findings.length) return;
    if (e.key === "f" || e.key === "F" || (e.key === "Enter" && li === activeLayer && scoped)) {
      e.preventDefault(); // Enter: suppress the synthetic click that would deactivate
      e.stopPropagation(); // and keep the document-level f handler out of it
      cycleFinding(li);
    }
  }));
  // Global f (document-level, complements the focused-layer-button binding above):
  // cycle findings in the active scope — the scoped layer when one is scoped,
  // otherwise ALL findings in reading order (without scoping anything).
  const allFindingIds = [];
  DATA.layers.forEach((l) => l.findings.forEach((f) => allFindingIds.push(f.id)));
  let allFindingCursor = -1;
  function cycleAllFindings() {
    if (!allFindingIds.length) return;
    if (!commentsShown) setComments(true); // hidden comments can't be cycled to
    allFindingCursor = (allFindingCursor + 1) % allFindingIds.length;
    const el = document.getElementById(allFindingIds[allFindingCursor]);
    if (!el) return;
    revealAndCenter(el);
    flashEl(el.querySelector(".thread") || el);
  }
  showallBtn.addEventListener("click", () => {
    if (!scoped) return; // aria-disabled: nothing is scoped
    softActivate(activeLayer);
  });

  // Finding location chips: scope the owning layer, jump to + flash the anchor rows.
  document.addEventListener("click", (e) => {
    const chip = e.target.closest("button.floc");
    if (!chip) return;
    const m = /^f-(\\d+)-(\\d+)$/.exec(chip.dataset.fid || "");
    if (!m) return;
    const li = Number(m[1]), k = Number(m[2]);
    activateLayer(li, false);
    const rows = anchorRows(DATA.layers[li].findings[k].anchor);
    if (!rows.length) return;
    const first = visibleRowEl(rows[0][0], rows[0][1]);
    if (first) revealAndCenter(first);
    rows.forEach(([fi, ri]) => flashEl(visibleRowEl(fi, ri)));
  });

  // ── Sticky line selection + floating action bar ──
  const abar = document.getElementById("abar");
  const abarLabel = document.getElementById("abar-label");
  const chatInput = document.getElementById("chat-input");
  const askNote = document.getElementById("ask-note");
  let sel = null; // {fi, a, b} in click order; hunk rows are skipped when applied
  let selStartEl = null; // first/last selected row elements in DISPLAY order
  let selEndEl = null;
  let threadsApi = null; // set by initThreads (live threads mode only)
  let versionsApi = null; // set by initVersions (live versions mode only)
  let processApi = null; // set by initModels (live scaffold-picker mode only)
  let diffMenu = null; // floating diff-line context menu element, or null when closed

  // Selected rows in DISPLAY order (see rowOrder: expanded context rows have
  // out-of-sequence indexes, so the visual range is walked through the order map).
  function selectedRows() {
    if (!sel) return [];
    const rows = DATA.files[sel.fi].rows;
    const out = [];
    const ord = rowOrder[sel.fi];
    if (!ord) {
      const lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
      for (let ri = lo; ri <= hi; ri++) {
        const r = rows[ri];
        if (r && r.t !== "h") out.push([sel.fi, ri, r]);
      }
      return out;
    }
    const pa = ord.indexOf(sel.a), pb = ord.indexOf(sel.b);
    if (pa === -1 || pb === -1) return [];
    const lo = Math.min(pa, pb), hi = Math.max(pa, pb);
    for (let p = lo; p <= hi; p++) {
      const ri = ord[p];
      const r = rows[ri];
      if (r && r.t !== "h") out.push([sel.fi, ri, r]);
    }
    return out;
  }
  function owningLayer(rows) {
    const keys = new Set(rows.map(([fi, ri]) => fi + ":" + ri));
    const overlaps = (pairs) => pairs.some(([fi, ri]) => keys.has(fi + ":" + ri));
    let li = scopes.findIndex((s) => overlaps(s.hits));
    if (li === -1) li = scopes.findIndex((s) => overlaps(s.span));
    return li;
  }
  // The bar sits to the RIGHT of the sticky gutters. Vertically it NEVER covers ANY
  // selected row's band: it goes ABOVE the selection's FIRST row (bar bottom = first
  // row top − 6px) whenever the bar actually FITS between the sticky file header and
  // that row (bar height + 6px gap + 8px clamp margin, so the top clamp can never
  // push it back onto the row); otherwise BELOW the LAST row (bar top = last row
  // bottom + 6px) —
  // except when the element directly below the last row is a visible finding box
  // (tr.frow) or the inline composer, which the bar must not cover either, so it goes
  // above regardless. Final clamps only bite once the whole selection has scrolled out
  // of the pane (then the bar parks just inside the pane edge, under the sticky header).
  function positionBar() {
    if (!selStartEl || !selEndEl) return;
    const first = selStartEl.getBoundingClientRect();
    const last = selEndEl.getBoundingClientRect();
    const gn = selStartEl.querySelector("td.gn") || selEndEl.querySelector("td.gn");
    const gutterRight = gn ? gn.getBoundingClientRect().right : first.left;
    const c = center.getBoundingClientRect();
    const left = Math.max(c.left + 8, Math.min(gutterRight + 10, c.right - abar.offsetWidth - 16));
    const card = selStartEl.closest(".filecard");
    const fhead = card ? card.querySelector(".fhead") : null;
    const headerBottom = c.top + (fhead ? fhead.offsetHeight : 38);
    const barH = abar.offsetHeight;
    const next = selEndEl.nextElementSibling;
    // A visible thread card OR the inline composer directly below counts: the bar
    // must not cover either, so it goes above the selection instead.
    const frowBelow = Boolean(
      next &&
        (next.classList.contains("crow") ||
          (next.classList.contains("frow") && !document.body.classList.contains("nocomments"))),
    );
    const fitsAbove = first.top - headerBottom >= barH + 14; // 6px gap + 8px clamp margin
    let top = fitsAbove || frowBelow ? first.top - 6 - barH : last.bottom + 6;
    top = Math.min(Math.max(top, headerBottom + 8), c.bottom - barH - 8);
    abar.style.left = left + "px";
    abar.style.top = top + "px";
  }
  function renderSel() {
    document.querySelectorAll(".sel").forEach((el) => el.classList.remove("sel"));
    const rows = selectedRows();
    if (!rows.length) { abar.hidden = true; selStartEl = null; selEndEl = null; askNote.hidden = true; updateKeyhint(); return; }
    let first = null, last = null;
    for (const [fi, ri] of rows) {
      const el = rowEl(fi, ri);
      if (el) { el.classList.add("sel"); if (!splitOn) { if (!first) first = el; last = el; } }
      for (const c of cellsFor(fi, ri)) {
        c.classList.add("sel");
        if (splitOn) { if (!first) first = c.parentElement; last = c.parentElement; }
      }
    }
    selStartEl = first;
    selEndEl = last;
    abarLabel.textContent = selLabel(rows.map((x) => x[2]), DATA.files[sel.fi].path);
    abar.hidden = false;
    positionBar();
    updateKeyhint();
  }
  function clearSel() { sel = null; renderSel(); }
  function applySelect(fi, ri, extend) {
    if (extend && sel && sel.fi === fi) sel.b = ri;
    else sel = { fi, a: ri, b: ri };
    renderSel();
  }
  // Unified gutters carry coordinates on their <tr>; split gutters carry them on the
  // cell itself (per-side selection: the left gutter selects the del row, the right
  // the add row; a ctx row is the same row from either side).
  function coordOfGutter(g) {
    if (g.dataset.ri !== undefined) return { fi: Number(g.dataset.fi), ri: Number(g.dataset.ri) };
    const tr = g.closest("tr.row");
    // Hunk-header rows carry coordinates too (for the expandable-context layer)
    // but are never selectable.
    if (!tr || tr.dataset.ri === undefined || tr.classList.contains("hunk")) return null;
    return { fi: Number(tr.dataset.fi), ri: Number(tr.dataset.ri) };
  }
  center.addEventListener("click", (e) => {
    const g = e.target.closest("td.g");
    if (!g) return;
    const c = coordOfGutter(g);
    if (c) applySelect(c.fi, c.ri, e.shiftKey);
  });
  center.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const g = e.target instanceof Element ? e.target.closest('td.g[role="button"]') : null;
    if (!g) return;
    const c = coordOfGutter(g);
    if (!c) return;
    e.preventDefault();
    applySelect(c.fi, c.ri, e.shiftKey);
  });
  // Capture-phase scroll catches BOTH #center vertical scroll and .fbody horizontal
  // scroll; resize re-clamps.
  document.addEventListener("scroll", () => { if (selEndEl) positionBar(); }, { capture: true, passive: true });
  window.addEventListener("resize", () => { if (selEndEl) positionBar(); });

  // ── Diff-line context menu (Wave 8) ──
  // closeDiffMenu is declared here so the Esc handler above can call it even
  // though the full implementation follows.
  function closeDiffMenu() {
    if (!diffMenu) return;
    diffMenu.remove();
    diffMenu = null;
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Wave-8 context menu is FIRST in the Esc chain (transient popup).
    if (diffMenu) { closeDiffMenu(); return; }
    // Wave-7 process modal FIRST (per the contract). While a scaffold run is in
    // progress its dismiss() returns false, so Esc is swallowed (the modal must
    // not close mid-run) and the chain below is skipped anyway.
    if (processApi && processApi.escBlocked()) return;
    if (processApi && processApi.dismiss()) return;
    // Wave-3 overlays dismiss next (prepended to the chain). The palette input
    // normally consumes its own Esc; this also covers a blurred-but-open palette.
    if (!helpWrap.hidden) { closeHelp(); return; }
    if (!palWrap.hidden) { closePalette(); return; }
    // First Esc while typing only leaves the input; the selection survives.
    if (document.activeElement === chatInput) { chatInput.blur(); return; }
    // Expanded bundle panel restores next — prepended to the dismiss chain below
    // (help/palette stay first: they overlay the panel itself).
    if (sideExpanded) { setSideExpanded(false); return; }
    // Progressive dismiss: help/palette → versions panel → export modal →
    // submit modal → composer → selection → layer scope (thread reply editors
    // consume their own Esc before it bubbles).
    if (versionsApi && versionsApi.dismiss()) return;
    if (threadsApi && threadsApi.dismiss()) return;
    if (sel) { clearSel(); return; }
    if (scoped) deactivate();
  });
  document.getElementById("abar-close").addEventListener("click", clearSel);

  // ── Copy selection: the selected lines' CODE text only (no line numbers/markers).
  // EVERY visibly selected row copies, in display order — a mixed selection includes
  // its deleted lines (no silent data loss). Reads td.code textContent — CSS ::before
  // markers are generated content and never part of it.
  function codeTextOf(fi, ri) {
    const el = rowEl(fi, ri);
    const code = el ? el.querySelector("td.code") : null;
    return code ? code.textContent : "";
  }
  function selectedCode() {
    return selectedRows().map((x) => codeTextOf(x[0], x[1])).join("\\n");
  }
  // The Ask payload's selectedText: plain for single-side selections (identical to
  // Copy), unified-diff-style marking for mixed ones (injected selAskText).
  function selectedAskText() {
    return selAskText(selectedRows().map((x) => ({ t: x[2].t, text: codeTextOf(x[0], x[1]) })));
  }
  const copyBtn = document.getElementById("copy-sel");
  let copyTimer = 0;
  // Shared by the Copy button and the y key (Wave 3): button label + a brief
  // "Copied ✓" in the keyhint strip.
  function doCopy() {
    navigator.clipboard.writeText(selectedCode()).then(() => {
      copyBtn.textContent = "Copied";
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
      flashKeyhint("Copied ✓");
    }).catch(() => {});
  }
  copyBtn.addEventListener("click", doCopy);

  // ── File collapse (a collapsing card takes its selection with it). "remember"
  // persists the choice per PR+SHA (explicit collapse UI only — the button, the
  // guard, collapse-all; navigation reveals don't overwrite the user's default),
  // and persisted state beats the first-load highest-risk default. ──
  function setCardCollapsed(card, collapsed, remember) {
    card.classList.toggle("collapsed", collapsed);
    const b = card.querySelector(".collapse");
    if (b) b.setAttribute("aria-expanded", String(!collapsed));
    if (collapsed && sel && String(sel.fi) === card.dataset.fi) clearSel();
    if (remember) rememberCollapse(Number(card.dataset.fi), collapsed);
    refreshCollapseAll();
    scheduleMarkers(); // thread offsets moved with the card body
  }
  document.querySelectorAll(".collapse").forEach((b) => b.addEventListener("click", () => {
    const card = b.closest(".filecard");
    setCardCollapsed(card, !card.classList.contains("collapsed"), true);
  }));

  // ── Chat stub (static-artifact mode: M5 server not reachable) ──
  function showStubNote() {
    const rows = selectedRows();
    if (rows.length) {
      const li = owningLayer(rows);
      askNote.textContent = li >= 0
        ? 'Assistant (M5) not wired yet — this selection would be sent with Layer "' + DATA.layers[li].title + '"’s bundle.'
        : "Assistant (M5) not wired yet — no layer’s anchors cover this selection.";
    } else {
      askNote.textContent = "Assistant (M5) not wired yet — select lines in the diff to attach a layer’s bundle to your question.";
    }
    askNote.hidden = false;
  }
  function ask() {
    const rows = selectedRows();
    if (!rows.length) return;
    chatInput.value = selLabel(rows.map((x) => x[2]), DATA.files[sel.fi].path) + ": ";
    showStubNote();
    chatInput.focus();
  }

  // ── Live chat (feature-detected: GET /api/health; silent fallback to the stub) ──
  // API contract: POST /api/ask and /api/escalate take {question, layerId?, file?,
  // side?, startLine?, endLine?, selectedText?} and stream chunked text/plain;
  // errors are JSON {error} with 4xx/5xx status.
  const chatLog = document.getElementById("chat-log");
  const chatBusy = document.getElementById("chat-busy");
  const chatModel = document.getElementById("chat-model");
  const askQwen = document.getElementById("ask-qwen");
  const askOpus = document.getElementById("ask-opus");
  let live = null; // /api/health payload when the review server answers, else null
  let inflight = false;

  // Chat bubbles render markdown — assistant answers AND your questions (renderMarkdown
  // escapes all HTML before transforming, so wiring untrusted text through innerHTML
  // here is safe). System/error lines stay plain text.
  function addMsg(cls, text) {
    const d = document.createElement("div");
    d.className = "msg " + cls;
    if (cls === "sys") d.textContent = text;
    else d.innerHTML = renderMarkdown(text, highlightFence);
    chatLog.appendChild(d);
    chatLog.hidden = false;
    chatLog.scrollTop = chatLog.scrollHeight;
    return d;
  }
  // Copy buttons on fenced code blocks in chat markdown (same clipboard pattern as
  // #copy-sel). Delegated: bubbles re-render while streaming, so buttons are transient.
  chatLog.addEventListener("click", (e) => {
    const b = e.target.closest("button.mdcopy");
    if (!b) return;
    const pre = b.parentElement ? b.parentElement.querySelector("pre") : null;
    navigator.clipboard.writeText(pre ? pre.textContent : "").then(() => {
      b.textContent = "Copied";
      setTimeout(() => { if (b.isConnected) b.textContent = "Copy"; }, 1200);
    }).catch(() => {});
  });
  function setBusy(on) {
    inflight = on;
    chatBusy.hidden = !on;
    chatInput.disabled = on;
    askQwen.disabled = on;
    askOpus.disabled = on || Boolean(live && live.escalation === false);
  }
  async function submit(endpoint) {
    if (!live || inflight) return;
    const question = chatInput.value.trim();
    if (!question) { chatInput.focus(); return; }
    const body = { question, layerId: activeLayer >= 0 ? DATA.layers[activeLayer].id : null };
    const rows = selectedRows();
    if (rows.length) {
      const li = owningLayer(rows);
      if (li >= 0) body.layerId = DATA.layers[li].id;
      const pureDel = rows.every((x) => x[2].t === "d");
      const lines = rows.map((x) => (pureDel ? x[2].o : x[2].n)).filter((v) => v !== null);
      body.file = DATA.files[sel.fi].path;
      body.side = pureDel ? "LEFT" : "RIGHT";
      body.startLine = Math.min.apply(null, lines);
      body.endLine = Math.max.apply(null, lines);
      body.selectedText = selectedAskText();
    }
    addMsg("you", question);
    chatInput.value = "";
    askNote.hidden = true;
    setBusy(true);
    const out = addMsg("ai", "");
    // Streaming markdown: accumulate raw text and re-render the growing bubble at most
    // every ~150ms (immediately when a chunk carries a newline — block structure very
    // likely changed); one final render on stream end.
    let acc = "";
    let lastRender = 0;
    let renderTimer = 0;
    const renderAcc = () => {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
      lastRender = Date.now();
      out.innerHTML = renderMarkdown(acc, highlightFence);
      chatLog.scrollTop = chatLog.scrollHeight;
    };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = "request failed (" + res.status + ")";
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
        out.remove();
        addMsg("sys", msg);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = dec.decode(chunk.value, { stream: true });
        acc += text;
        if (text.indexOf("\\n") !== -1 || Date.now() - lastRender >= 150) renderAcc();
        else if (!renderTimer) renderTimer = setTimeout(renderAcc, 150);
      }
      acc += dec.decode();
      renderAcc(); // final render on stream end
    } catch (err) {
      out.remove();
      addMsg("sys", "network error: " + (err && err.message ? err.message : err));
    } finally {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
      setBusy(false);
    }
  }
  askQwen.addEventListener("click", () => { if (live) submit("/api/ask"); else ask(); });
  askOpus.addEventListener("click", () => {
    if (!live) { ask(); return; }
    if (live.escalation === false) return;
    submit("/api/escalate");
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (live) submit("/api/ask");
    else showStubNote();
  });

  // ── Right-pane tabs: Model Context, PR Comments (unanchored GitHub comments),
  // and Draft Comment (local pending reviewer drafts). Anchored GitHub review
  // comments render in the main diff.
  initSideTabs();
  function initSideTabs() {
    const tabs = [...document.querySelectorAll(".sidetab")];
    const panes = {
      context: document.getElementById("side-context"),
      prcomments: document.getElementById("side-pr-comments"),
      draft: document.getElementById("side-draft"),
    };
    function show(name) {
      tabs.forEach((t) => {
        const on = t.dataset.sideTab === name;
        t.classList.toggle("on", on);
        t.setAttribute("aria-selected", String(on));
      });
      Object.keys(panes).forEach((k) => {
        if (panes[k]) panes[k].classList.toggle("on", k === name);
      });
    }
    tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.sideTab || "context")));
  }

  let agentTabsReady = false;
  function initAgentTabs() {
    if (agentTabsReady) return;
    agentTabsReady = true;
    const refresh = document.getElementById("gh-refresh");
    if (refresh) refresh.hidden = false;
    if (refresh) refresh.addEventListener("click", () => refreshAgentComments(true));
    refreshAgentComments(false);
  }
  function renderDraftCard(opts) {
    const card = document.createElement("div");
    card.className = "tlcard local";
    const hd = document.createElement("div");
    hd.className = "tlhd";
    const who = document.createElement("span");
    who.className = "tlwho";
    who.textContent = "You";
    const src = document.createElement("span");
    src.className = "tlsrc local";
    src.textContent = opts.source;
    const time = document.createElement("span");
    time.textContent = opts.createdAt ? new Date(opts.createdAt).toLocaleString() : "";
    hd.append(who, src, time);
    if (opts.anchor) {
      const loc = document.createElement("span");
      loc.className = "tlloc";
      loc.textContent = anchorLabel(opts.anchor);
      hd.append(loc);
    }
    const body = document.createElement("div");
    body.className = "tlbody";
    body.innerHTML = renderMarkdown(opts.body || "", highlightFence);
    card.append(hd, body);
    return card;
  }

  function clearGithubComments() {
    document.querySelectorAll("tr.ghrow").forEach((el) => el.remove());
  }

  function hasCommentBody(comment) {
    return Boolean(comment && typeof comment.body === "string" && comment.body.trim());
  }

  function avatarEl(comment) {
    const url = comment && typeof comment.authorAvatarUrl === "string" ? comment.authorAvatarUrl : "";
    if (url) {
      const img = document.createElement("img");
      img.className = "ghavatar";
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      return img;
    }
    const fallback = document.createElement("span");
    fallback.className = "ghavatar fallback";
    fallback.textContent = (comment.authorLogin || "?").slice(0, 1).toUpperCase();
    return fallback;
  }

  function authorEl(comment, className) {
    const author = document.createElement(comment.authorUrl ? "a" : "span");
    author.className = className;
    author.textContent = comment.authorLogin || "unknown";
    if (comment.authorUrl) {
      author.href = comment.authorUrl;
      author.target = "_blank";
      author.rel = "noopener";
    }
    return author;
  }

  function groupVisibleCommentCount(group) {
    let n = hasCommentBody(group.root) ? 1 : 0;
    group.replies.forEach((reply) => { if (hasCommentBody(reply)) n++; });
    return n;
  }

  function githubCommentEl(comment, opening, anchor) {
    const d = document.createElement("div");
    d.className = "tcmt github-comment";
    const hd = document.createElement("div");
    hd.className = "tchd";
    const who = authorEl(comment, "tauthor");
    const src = document.createElement("span");
    src.className = "ghchip";
    src.textContent = sourceLabel(comment.source);
    const time = document.createElement(comment.htmlUrl ? "a" : "span");
    time.className = "ghtime";
    time.textContent = comment.createdAt ? new Date(comment.createdAt).toLocaleString() : "";
    if (comment.htmlUrl) {
      time.href = comment.htmlUrl;
      time.target = "_blank";
      time.rel = "noopener";
      time.title = "Open on GitHub";
    }
    hd.append(avatarEl(comment), who, src, time);
    if (comment.state) {
      const state = document.createElement("span");
      state.className = "ghstate";
      state.textContent = comment.state.replace(/_/g, " ").toLowerCase();
      hd.append(state);
    }
    if (opening && anchor) {
      const loc = document.createElement("button");
      loc.className = "floc ghtloc";
      loc.textContent = anchorLabel(anchor);
      loc.title = "Jump to these lines";
      loc.dataset.file = anchor.file;
      loc.dataset.side = anchor.side;
      loc.dataset.start = String(anchor.startLine);
      loc.dataset.end = String(anchor.endLine);
      hd.append(loc);
    }
    const body = document.createElement("div");
    body.className = "tcbody";
    const bodyAnchor = comment.anchor || anchor;
    body.innerHTML = githubCommentBodyHtml(
      comment.body || "",
      bodyAnchor ? currentLinesForAnchor(bodyAnchor) : [],
      langForPath(bodyAnchor ? bodyAnchor.file : ""),
    );
    d.append(hd, body);
    return d;
  }

  function githubCard(group) {
    const anchor = group.root.anchor;
    const card = document.createElement("div");
    card.className = "thread github";
    card.dataset.ghid = group.root.id;
    const cmts = document.createElement("div");
    cmts.className = "tcmts";
    cmts.append(githubCommentEl(group.root, true, anchor));
    group.replies.forEach((reply) => cmts.append(githubCommentEl(reply, false, reply.anchor || anchor)));
    card.append(cmts);
    return card;
  }

  function insertGithubCard(group) {
    const anchor = group.root.anchor;
    if (!anchor) return false;
    const fi = fileIndex.get(anchor.file);
    if (fi === undefined) return false;
    const rows = DATA.files[fi].rows;
    if (!rows.length) return false;
    const ri = threadRowIndex(rows, anchor);
    if (ri < 0) return false;
    let after = visibleRowEl(fi, ri);
    if (!after) return false;
    while (after.nextElementSibling && after.nextElementSibling.classList.contains("frow")) {
      after = after.nextElementSibling;
    }
    const tr = document.createElement("tr");
    tr.className = "frow ghrow";
    tr.dataset.fi = fi;
    tr.dataset.ri = ri;
    tr.dataset.ghid = group.root.id;
    const td = document.createElement("td");
    td.colSpan = splitOn ? 4 : 3;
    td.append(githubCard(group));
    tr.append(td);
    after.insertAdjacentElement("afterend", tr);
    return true;
  }

  function renderPrCommentCard(group) {
    const card = document.createElement("div");
    card.className = "tlcard github";
    const hd = document.createElement("div");
    hd.className = "tlhd";
    const who = authorEl(group.root, "tlwho");
    const src = document.createElement("span");
    src.className = "tlsrc";
    src.textContent = sourceLabel(group.root.source);
    const time = document.createElement(group.root.htmlUrl ? "a" : "span");
    time.className = "tllinktime";
    time.textContent = group.root.createdAt ? new Date(group.root.createdAt).toLocaleString() : "";
    if (group.root.htmlUrl) {
      time.href = group.root.htmlUrl;
      time.target = "_blank";
      time.rel = "noopener";
      time.title = "Open on GitHub";
    }
    hd.append(avatarEl(group.root), who, src, time);
    if (group.root.state) {
      const state = document.createElement("span");
      state.className = "tlsrc";
      state.textContent = group.root.state.replace(/_/g, " ").toLowerCase();
      hd.append(state);
    }
    const body = document.createElement("div");
    body.className = "tlbody";
    body.innerHTML = githubCommentBodyHtml(group.root.body || "", [], "");
    card.append(hd, body);
    group.replies.filter(hasCommentBody).forEach((reply) => {
      const r = document.createElement("div");
      r.className = "tlreply";
      const rhd = document.createElement("div");
      rhd.className = "tlhd";
      const rwho = authorEl(reply, "tlwho");
      const rtime = document.createElement(reply.htmlUrl ? "a" : "span");
      rtime.className = "tllinktime";
      rtime.textContent = reply.createdAt ? new Date(reply.createdAt).toLocaleString() : "";
      if (reply.htmlUrl) {
        rtime.href = reply.htmlUrl;
        rtime.target = "_blank";
        rtime.rel = "noopener";
      }
      rhd.append(avatarEl(reply), rwho, rtime);
      const rb = document.createElement("div");
      rb.className = "tlbody";
      rb.innerHTML = githubCommentBodyHtml(reply.body || "", [], "");
      r.append(rhd, rb);
      card.append(r);
    });
    return card;
  }

  function renderPrComments(groups, errors) {
    const list = document.getElementById("pr-comments-list");
    if (!list) return;
    list.textContent = "";
    const visible = groups.filter((group) => groupVisibleCommentCount(group) > 0);
    if (!visible.length && !errors.length) {
      const empty = document.createElement("p");
      empty.className = "emptytab";
      empty.textContent = "No PR comments.";
      list.append(empty);
    }
    visible.forEach((group) => list.append(renderPrCommentCard(group)));
    errors.forEach((err) => {
      const p = document.createElement("p");
      p.className = "tlerr";
      p.textContent = err;
      list.append(p);
    });
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("button.ghtloc");
    if (!b) return;
    const anchor = {
      file: b.dataset.file || "",
      side: b.dataset.side || "RIGHT",
      startLine: Number(b.dataset.start || 0),
      endLine: Number(b.dataset.end || 0),
    };
    const rows = anchorRows(anchor);
    if (!rows.length) return;
    const first = visibleRowEl(rows[0][0], rows[0][1]);
    if (first) revealAndCenter(first);
    rows.forEach(([fi, ri]) => flashEl(visibleRowEl(fi, ri)));
  });

  function renderAgentComments(data) {
    const drafts = document.getElementById("draft-list");
    if (!drafts) return;
    drafts.textContent = "";
    clearGithubComments();

    const published = data && data.published && Array.isArray(data.published.comments)
      ? data.published.comments
      : [];
    const errors = data && data.published && Array.isArray(data.published.errors)
      ? data.published.errors
      : [];
    const unanchored = [];
    let renderedGithubCount = 0;
    groupPublishedComments(published).forEach((group) => {
      if (group.root.anchor && groupVisibleCommentCount(group) > 0 && insertGithubCard(group)) {
        renderedGithubCount += groupVisibleCommentCount(group);
      } else {
        unanchored.push(group);
      }
    });
    renderPrComments(unanchored, errors);
    unanchored.forEach((group) => { renderedGithubCount += groupVisibleCommentCount(group); });
    updateGithubCommentCount(renderedGithubCount);
    if (activeLayer >= 0) applyMarks(activeLayer);
    scheduleMarkers();

    const localDrafts = data && Array.isArray(data.localDrafts) ? data.localDrafts : [];
    if (!localDrafts.length) {
      const empty = document.createElement("p");
      empty.className = "emptytab";
      empty.textContent = "No local draft comments.";
      drafts.append(empty);
    }
    localDrafts.forEach((d) => {
      drafts.append(renderDraftCard({
        source: d.comment && d.comment.visibility === "local" ? "Local draft" : "Publishable draft",
        createdAt: d.comment && d.comment.createdAt,
        anchor: d.anchor,
        body: d.comment && d.comment.body,
      }));
    });
  }
  async function refreshAgentComments(force) {
    try {
      const res = await fetch("/api/agent/comments" + (force ? "?refresh=1" : ""));
      if (!res.ok) return;
      renderAgentComments(await res.json());
      document.dispatchEvent(new CustomEvent("sleek:refreshthreads"));
    } catch (_) {}
  }

  function initFinish() {
    const btn = document.getElementById("finish-review");
    if (!btn) return;
    btn.hidden = false;
    btn.addEventListener("click", async () => {
      if (!confirm("Finish this review and remove its disposable cache/worktree?")) return;
      btn.disabled = true;
      btn.textContent = "Finishing…";
      try {
        const res = await fetch("/api/finish", { method: "POST" });
        if (!res.ok) {
          btn.disabled = false;
          btn.textContent = "Finish review";
          let msg = "finish failed (" + res.status + ")";
          try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
          addMsg("sys", msg);
          return;
        }
        btn.textContent = "Review finished";
      } catch (_) {
        btn.disabled = false;
        btn.textContent = "Finish review";
        addMsg("sys", "network error");
      }
    });
  }
  // A file:// artifact never probes the server AT ALL: fetch() on a file: URL logs a
  // console error before the promise even rejects, and the static bar is zero console
  // output. Every other live-only feature is gated behind this one probe.
  if (location.protocol !== "file:") fetch("/api/health")
    .then((r) => (r.ok ? r.json() : null))
    .then((h) => {
      if (!h || h.ok !== true) return;
      live = h;
      chatModel.textContent = h.model || "";
      chatInput.placeholder = "Ask about this PR — select lines to attach them";
      if (h.escalation === false) {
        askOpus.disabled = true;
        askOpus.title = "Escalation is not configured on this server";
        // The disabled reason must be readable, not just a title-attr on a
        // button that can't be hovered confidently: un-hide the chat caption.
        const escNote = document.getElementById("esc-note");
        if (escNote) escNote.hidden = false;
      }
      // Wave LSP is DOUBLY gated: live health AND a per-language lsp payload.
      // initLsp is the only entry point to any /api/lsp/* request or listener.
      if (h.lsp && typeof h.lsp === "object") initLsp(h.lsp);
      // Wave 2b threads gate the same way: initThreads is the only entry point
      // to any /api/threads* or /api/review* request or listener. Without it the
      // server-rendered Finding thread cards stay read-only (static behavior).
      if (h.threads === true) initThreads();
      if (h.agent === true) initAgentTabs();
      // Expandable context gates the same way: initExpanders is the only entry
      // point to any /api/context request or expander affordance.
      if (h.context === true) initExpanders();
      // Wave 4B versions gate the same way: initVersions is the only entry
      // point to any /api/versions* request; the banner stays hidden without it.
      if (h.versions === true) initVersions();
      if (h.finish === true) initFinish();
      // Wave 7 in-app model choice: initModels is the SINGLE entry point to
      // /api/models, /api/model and /api/scaffold. It wires the Assistant model
      // dropdown always (live), and the Process-PR button + picker only when the
      // scaffold is empty and the server can scaffold.
      initModels(h);
    })
    .catch(() => {}); // no server behind http(s): stub behavior stays

  // ── Files: tree, viewed + progress, collapse-all, split view, whitespace, keys ──
  const cards = [...center.querySelectorAll(".filecard[data-fi]")];
  const cardByFi = new Map(cards.map((c) => [Number(c.dataset.fi), c]));
  const treeFileBtns = new Map(
    [...document.querySelectorAll(".tfbtn")].map((b) => [Number(b.dataset.fi), b]),
  );
  const collapseAllBtn = document.getElementById("collapseall");
  const stoggle = document.getElementById("stoggle");
  const wtoggle = document.getElementById("wtoggle");
  const ztoggle = document.getElementById("ztoggle");
  const pfill = document.getElementById("pfill");
  const ptext = document.getElementById("ptext");
  // localStorage can throw (privacy modes); state just doesn't persist then.
  const persist = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };

  // ── "What the model knows" panel expander: ⤢ widens the panel leftward over
  // the diff (overlay — the diff never reflows); Esc or re-click restores;
  // the expanded state persists across reloads. ──
  const side = document.getElementById("side");
  const bexpand = document.getElementById("bexpand");
  let sideExpanded = false;
  function setSideExpanded(on) {
    sideExpanded = on;
    side.classList.toggle("expanded", on);
    bexpand.setAttribute("aria-pressed", String(on));
    bexpand.title = on ? "Restore panel width (Esc)" : "Expand panel over the diff (Esc restores)";
    persist.set("sleek:bexp", on ? "1" : "0");
  }
  bexpand.addEventListener("click", () => setSideExpanded(!sideExpanded));
  if (persist.get("sleek:bexp") === "1") setSideExpanded(true);

  // ── Per-file collapse preference (persisted per PR number + head SHA, like
  // viewed). Only EXPLICIT collapse UI writes it; it wins over both the viewed
  // auto-collapse and the first-load highest-risk default. ──
  const collapseKey = "sleek:collapse:" + DATA.pr.number + ":" + DATA.pr.headSha;
  let collapsePref = {};
  try {
    const j = JSON.parse(persist.get(collapseKey) || "{}");
    if (j && typeof j === "object" && !Array.isArray(j)) collapsePref = j;
  } catch (_) {}
  function rememberCollapse(fi, on) {
    collapsePref[DATA.files[fi].path] = on ? 1 : 0;
    persist.set(collapseKey, JSON.stringify(collapsePref));
  }

  function refreshCollapseAll() {
    const anyExpanded = cards.some((c) => !c.classList.contains("collapsed"));
    collapseAllBtn.textContent = anyExpanded ? "Collapse all" : "Expand all";
  }
  collapseAllBtn.addEventListener("click", () => {
    const anyExpanded = cards.some((c) => !c.classList.contains("collapsed"));
    cards.forEach((c) => setCardCollapsed(c, anyExpanded, true));
  });
  // Large-file guard: "Load diff" either un-hides embedded rows (non-lazy, the
  // static-artifact path) or fetches them from /api/filerows (lazy live mode).
  // In lazy mode the button carries data-lazy="1"; on success the fetched HTML
  // is injected into .fbody, the lazy marker is removed, and the card expands.
  // On failure the button keeps data-lazy="1" and gains an inline error span
  // (re-clickable: the fetch is retried on the next click).
  center.addEventListener("click", (e) => {
    const b = e.target.closest("button.loaddiff");
    if (!b) return;
    const card = b.closest(".filecard");
    if (!card) return;
    if (!b.dataset.lazy) {
      setCardCollapsed(card, false, true);
      return;
    }
    // Lazy fetch: guard against concurrent requests.
    if (b.dataset.loading) return;
    b.dataset.loading = "1";
    const fi = Number(card.dataset.fi);
    const filePath = DATA.files[fi] && DATA.files[fi].path;
    if (!filePath) { delete b.dataset.loading; return; }
    const errEl = b.parentElement && b.parentElement.querySelector(".loaderr");
    if (errEl) errEl.remove();
    fetch("/api/filerows?file=" + encodeURIComponent(filePath), { method: "GET" })
      .then(function(r) {
        if (!r.ok) return r.text().then(function(t) { throw new Error("HTTP " + r.status + ": " + t); });
        return r.text();
      })
      .then(function(html) {
        const fbody = card.querySelector(".fbody");
        if (fbody) fbody.innerHTML = html;
        // Remove lazy marker so subsequent clicks just expand.
        delete b.dataset.lazy;
        // Re-init expanders for this file's new rows if context is available.
        if (live && live.context) {
          const newRows = card.querySelectorAll("tr.row");
          // Dispatch a custom event so initExpanders can wire the new bands
          // without re-scanning all cards. If initExpanders isn't listening,
          // this is a no-op.
          card.dispatchEvent(new CustomEvent("sleek:rowsinserted", { bubbles: true, detail: { fi: fi } }));
        }
        // Recompute scopes (the lazy rows may fall in anchor spans) and markers.
        DATA.layers.forEach(function(l, li) { scopes[li] = scopeOf(l); });
        if (activeLayer >= 0) applyMarks(activeLayer);
        scheduleMarkers();
        setCardCollapsed(card, false, true);
        delete b.dataset.loading;
      })
      .catch(function(err) {
        delete b.dataset.loading;
        const span = document.createElement("span");
        span.className = "loaderr";
        span.textContent = " — " + (err && err.message ? err.message : "load failed");
        b.after(span);
      });
  });

  // ── Viewed state (persisted per PR number + head SHA: a re-scaffold resets) ──
  const viewedKey = "sleek:viewed:" + DATA.pr.number + ":" + DATA.pr.headSha;
  let storedViewed = [];
  try { storedViewed = JSON.parse(persist.get(viewedKey) || "[]"); } catch (_) {}
  const viewed = new Set(Array.isArray(storedViewed) ? storedViewed : []);
  const isViewed = (fi) => viewed.has(DATA.files[fi].path);
  function updateProgress() {
    const total = cards.length;
    let n = 0;
    for (const c of cards) if (isViewed(Number(c.dataset.fi))) n++;
    pfill.style.width = total ? (100 * n) / total + "%" : "0";
    ptext.textContent = n + "/" + total + " files viewed";
  }
  function syncViewedUi(fi) {
    const on = isViewed(fi);
    const card = cardByFi.get(fi);
    const cb = card && card.querySelector(".fhead .viewedcb");
    if (cb) cb.checked = on;
    const tbtn = treeFileBtns.get(fi);
    if (tbtn) {
      tbtn.parentElement.classList.toggle("viewed", on);
      const tcb = tbtn.parentElement.querySelector(".tfcb");
      if (tcb) tcb.checked = on;
    }
  }
  function nextUnviewedAfter(fi) {
    const start = cards.indexOf(cardByFi.get(fi));
    for (let i = start + 1; i < cards.length; i++) {
      const f2 = Number(cards[i].dataset.fi);
      if (!isViewed(f2)) return f2;
    }
    return -1;
  }
  function setViewed(fi, on, advance) {
    if (on) viewed.add(DATA.files[fi].path);
    else viewed.delete(DATA.files[fi].path);
    persist.set(viewedKey, JSON.stringify([...viewed]));
    syncViewedUi(fi);
    const card = cardByFi.get(fi);
    if (card) setCardCollapsed(card, on);
    updateProgress();
    if (on && advance) {
      const next = nextUnviewedAfter(fi);
      if (next !== -1) goToFile(next);
    }
  }
  // Both checkbox homes (card header + tree row) share the .viewedcb class.
  document.addEventListener("change", (e) => {
    const cb = e.target;
    if (!(cb instanceof Element) || !cb.classList.contains("viewedcb")) return;
    setViewed(Number(cb.dataset.fi), cb.checked, cb.checked);
  });

  // ── Active file: scroll-spy (TOPMOST visible file wins — GitHub semantics: the
  // card occupying the top edge of the pane is the one being read, so file 0 is
  // active at scroll top) + tree highlight. Explicit navigation (goToFile: keyboard
  // ]/[ , tree clicks, v-advance) sets a nav override the spy must not fight: spy
  // updates are suppressed until the programmatic scroll settles (the target reaches
  // the top, 'scrollend' fires, or a timeout fallback), and repeated ]/[ presses
  // mid-scroll retarget from the override because activeFile keeps its value. ──
  let activeFile = cards.length ? Number(cards[0].dataset.fi) : -1;
  let navHold = -1;  // goToFile target the spy must respect; -1 = spy drives
  let navTimer = 0;
  // Never yank the tree out from under the reviewer's cursor: while the pointer is
  // over the rail, suppress the auto-scroll-into-view of the active row.
  const rail = document.getElementById("rail");
  let pointerOnRail = false;
  if (rail) {
    rail.addEventListener("pointerenter", () => { pointerOnRail = true; });
    rail.addEventListener("pointerleave", () => { pointerOnRail = false; });
  }
  let treeScrollRAF = 0;
  function scrollTreeRowIntoView(fi) {
    if (pointerOnRail) return;
    if (treeScrollRAF) return;
    treeScrollRAF = requestAnimationFrame(() => {
      treeScrollRAF = 0;
      if (pointerOnRail) return;
      const b = treeFileBtns.get(fi);
      const li = b && b.parentElement;
      if (li && !li.classList.contains("fhide") && !li.classList.contains("scopehide")) {
        li.scrollIntoView({ block: "nearest" });
      }
    });
  }
  function setActiveFile(fi) {
    activeFile = fi;
    treeFileBtns.forEach((b, f2) => b.classList.toggle("active", f2 === fi));
    scrollTreeRowIntoView(fi);
  }
  // The file whose card spans the top edge of the pane (first card, in display
  // order, whose bottom sits below the top edge + a sticky-header allowance).
  function topmostFile() {
    const cTop = center.getBoundingClientRect().top;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (r.height > 0 && r.bottom > cTop + 36) return Number(c.dataset.fi);
    }
    return -1;
  }
  function releaseNav() {
    navHold = -1;
    clearTimeout(navTimer);
    navTimer = 0;
  }
  function goToFile(fi) {
    const card = cardByFi.get(fi);
    if (!card) return;
    setActiveFile(fi);
    navHold = fi;
    clearTimeout(navTimer);
    navTimer = setTimeout(releaseNav, 1500); // fallback when scrollend never fires
    card.scrollIntoView({ behavior, block: "start" });
  }
  const spy = new IntersectionObserver(() => {
    const top = topmostFile();
    if (navHold !== -1) {
      // Suppressed: only a sighting of the target itself settles the navigation
      // (keeps the override through every intermediate file the scroll passes).
      if (top === navHold) releaseNav();
      return;
    }
    if (top !== -1) setActiveFile(top);
  }, { root: center, threshold: [0, 0.05, 0.15, 0.3, 0.5, 0.75, 1] });
  cards.forEach((c) => spy.observe(c));
  // The programmatic smooth scroll settled (also fires after user scrolls, when
  // navHold is already -1 — harmless).
  center.addEventListener("scrollend", releaseNav);

  // Tree: dir rows collapse their subtree (EXPANDED is the default; collapses
  // persist per PR+SHA); file rows scroll to the card.
  const treeKey = "sleek:tree:" + DATA.pr.number + ":" + DATA.pr.headSha;
  let collapsedDirs = new Set();
  try {
    const a = JSON.parse(persist.get(treeKey) || "[]");
    if (Array.isArray(a)) collapsedDirs = new Set(a);
  } catch (_) {}
  function setDirCollapsed(btn, collapsed) {
    btn.setAttribute("aria-expanded", String(!collapsed));
    const kids = btn.nextElementSibling;
    if (kids) kids.hidden = collapsed;
  }
  const dirBtns = [...document.querySelectorAll(".tdbtn")];
  // Auto-collapse big PRs: ONLY on the first load for this PR+SHA (a one-shot,
  // marked so later explicit expands survive reloads — the store records collapses
  // only, so re-running would re-fold what the reviewer opened). Fold every
  // non-top-level dir (depth >= 1, post chain-collapse) so the tree shows the
  // handful of top-level landmarks (e.g. "packages") with only the folders that
  // hold findings / the initially-active file auto-expanded. (Depth is measured
  // AFTER chain-collapse, where a real monorepo flattens to one "packages" root
  // over ~100 sibling package dirs — folding only depth >= 2 would leave that root
  // fully expanded, defeating the landmark goal.) Explicit per-dir prefs always
  // win in both directions.
  const autoKey = "sleek:treeauto:" + DATA.pr.number + ":" + DATA.pr.headSha;
  if (DATA.files.length > 40 && persist.get(autoKey) !== "1") {
    const keepOpen = new Set(); // data-path of dirs that must stay expanded
    dirBtns.forEach((b) => {
      const li = b.parentElement; // li.tdir
      let hot = false;
      li.querySelectorAll("li.tf").forEach((f) => {
        if (f.querySelector(".ffind")) hot = true;
        if (Number(f.dataset.fi) === activeFile) hot = true;
      });
      if (hot) keepOpen.add(b.dataset.path);
    });
    dirBtns.forEach((b) => {
      const path = b.dataset.path;
      // Nesting depth = number of ANCESTOR dir rows (post chain-collapse), not the
      // slash count (a chain node holds many segments in one path). Top level = 0.
      let depth = 0;
      let p = b.parentElement && b.parentElement.parentElement; // up past li.tdir → ul.tkids
      while (p) {
        if (p.classList && p.classList.contains("tdir")) depth++;
        p = p.parentElement;
      }
      // Collapse every non-top-level dir unless it holds findings/the active file,
      // and only when the reviewer has not already stored a preference for it.
      if (depth >= 1 && !keepOpen.has(path) && !collapsedDirs.has(path)) {
        collapsedDirs.add(path);
      }
    });
    persist.set(treeKey, JSON.stringify([...collapsedDirs]));
    persist.set(autoKey, "1");
  }
  dirBtns.forEach((b) => {
    if (collapsedDirs.has(b.dataset.path)) setDirCollapsed(b, true);
  });
  // ── Tree collapse/expand-all (distinct from #collapseall = file cards). Toggles
  // ALL dirs through the same collapsedDirs + treeKey persistence. ──
  const treeCollapseBtn = document.getElementById("treecollapse");
  function refreshTreeCollapse() {
    if (!treeCollapseBtn) return;
    const anyExpanded = dirBtns.some((b) => b.getAttribute("aria-expanded") === "true");
    treeCollapseBtn.textContent = anyExpanded ? "⊟" : "⊞";
    treeCollapseBtn.setAttribute("aria-label", anyExpanded ? "Collapse tree" : "Expand tree");
    treeCollapseBtn.title = anyExpanded ? "Collapse all folders" : "Expand all folders";
    treeCollapseBtn.setAttribute("aria-pressed", anyExpanded ? "false" : "true");
  }
  if (treeCollapseBtn) {
    treeCollapseBtn.addEventListener("click", () => {
      const collapse = dirBtns.some((b) => b.getAttribute("aria-expanded") === "true");
      dirBtns.forEach((b) => {
        setDirCollapsed(b, collapse);
        if (collapse) collapsedDirs.add(b.dataset.path);
        else collapsedDirs.delete(b.dataset.path);
      });
      persist.set(treeKey, JSON.stringify([...collapsedDirs]));
      refreshTreeCollapse();
    });
    refreshTreeCollapse();
  }
  const treeEl = document.querySelector(".ftree");
  if (treeEl) treeEl.addEventListener("click", (e) => {
    const db = e.target.closest(".tdbtn");
    if (db) {
      const collapse = db.getAttribute("aria-expanded") === "true";
      setDirCollapsed(db, collapse);
      if (collapse) collapsedDirs.add(db.dataset.path);
      else collapsedDirs.delete(db.dataset.path);
      persist.set(treeKey, JSON.stringify([...collapsedDirs]));
      refreshTreeCollapse();
      return;
    }
    const fb = e.target.closest(".tfbtn");
    if (fb) goToFile(Number(fb.dataset.fi));
  });

  // ── Resizable rail: drag the grip on #rail's right edge (200–420px), double-
  // click resets to 260. Persists sleek:railw; the ≤1100/≤760 breakpoints override
  // grid-template-columns in CSS, so --railw is simply ignored there. ──
  const RAIL_MIN = 200, RAIL_MAX = 560, RAIL_DEFAULT = 260;
  const grid = document.querySelector(".grid");
  const railgrip = document.getElementById("railgrip");
  function applyRailWidth(w) {
    const clamped = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(w)));
    if (grid) grid.style.setProperty("--railw", clamped + "px");
    return clamped;
  }
  (function initRailWidth() {
    const stored = Number(persist.get("sleek:railw"));
    applyRailWidth(stored >= RAIL_MIN && stored <= RAIL_MAX ? stored : RAIL_DEFAULT);
  })();
  if (railgrip && grid) {
    let dragging = false;
    railgrip.addEventListener("pointerdown", (e) => {
      dragging = true;
      railgrip.classList.add("dragging");
      document.body.classList.add("railresizing");
      railgrip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    railgrip.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const left = grid.getBoundingClientRect().left;
      applyRailWidth(e.clientX - left);
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      railgrip.classList.remove("dragging");
      document.body.classList.remove("railresizing");
      try { railgrip.releasePointerCapture(e.pointerId); } catch (_) {}
      const w = grid.style.getPropertyValue("--railw").replace("px", "");
      if (w) persist.set("sleek:railw", String(parseInt(w, 10)));
    }
    railgrip.addEventListener("pointerup", endDrag);
    railgrip.addEventListener("pointercancel", endDrag);
    railgrip.addEventListener("dblclick", () => {
      applyRailWidth(RAIL_DEFAULT);
      persist.set("sleek:railw", String(RAIL_DEFAULT));
    });
  }

  // ── File filter (Wave 4C, GitHub style): the input above the tree hides
  // non-matching files (case-insensitive substring on the full path — injected
  // fileFilterMatches) and dirs left with no matching descendant; while active,
  // collapsed subtrees open VISUALLY (CSS .filtering, persisted state untouched)
  // so matches inside them stay reachable, and "n of m files" reads out below.
  // Esc in the input clears + blurs WITHOUT entering the global dismiss chain. ──
  const ffilter = document.getElementById("ffilter");
  const ffilterX = document.getElementById("ffilter-x");
  const ffcount = document.getElementById("ffcount");
  function applyFileFilter() {
    const q = ffilter.value.trim();
    const active = q !== "";
    ffilterX.hidden = !active;
    if (treeEl) treeEl.classList.toggle("filtering", active);
    document.querySelectorAll(".ftree .fhide").forEach((el) => el.classList.remove("fhide"));
    if (!active) { ffcount.hidden = true; return; }
    const keep = new Set(fileFilterMatches(DATA.files.map((f) => f.path), q));
    treeFileBtns.forEach((b, fi) => {
      if (!keep.has(fi)) b.parentElement.classList.add("fhide");
    });
    // A dir hides when its whole subtree hid (nested dirs follow via their own
    // li.tf query) — same walk as the layer-scope hiding below.
    document.querySelectorAll(".ftree li.tdir").forEach((dir) => {
      let any = false;
      dir.querySelectorAll("li.tf").forEach((f) => {
        if (!f.classList.contains("fhide")) any = true;
      });
      if (!any) dir.classList.add("fhide");
    });
    ffcount.textContent = keep.size + " of " + DATA.files.length + " files";
    ffcount.hidden = false;
  }
  if (ffilter) {
    ffilter.addEventListener("input", applyFileFilter);
    ffilter.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation(); // the document-level Esc chain must not also fire
        ffilter.value = "";
        applyFileFilter();
        ffilter.blur();
      } else if (e.key === "Enter") {
        e.preventDefault(); // no form to submit; keep the filter as-is
      }
    });
    ffilterX.addEventListener("click", () => {
      ffilter.value = "";
      applyFileFilter();
      ffilter.focus();
    });
  }

  // ── Layer scope → tree (uses FILE_LAYERS): hard scope HIDES files with no
  // anchor in the active layer (dirs whose whole subtree hid follow), soft-active
  // only DIMS them; neutral clears everything. Called by every layer-state change. ──
  function updateTreeScope() {
    document.querySelectorAll(".ftree .scopehide, .ftree .scopedim").forEach((el) => {
      el.classList.remove("scopehide", "scopedim");
    });
    if (activeLayer < 0) return;
    treeFileBtns.forEach((b, fi) => {
      if (FILE_LAYERS[fi].indexOf(activeLayer) !== -1) return;
      b.parentElement.classList.add(scoped ? "scopehide" : "scopedim");
    });
    if (!scoped) return;
    document.querySelectorAll(".ftree li.tdir").forEach((dir) => {
      let any = false;
      dir.querySelectorAll("li.tf").forEach((f) => {
        if (!f.classList.contains("scopehide")) any = true;
      });
      if (!any) dir.classList.add("scopehide");
    });
  }

  // ── Split (side-by-side) view — built CLIENT-side on first use: buildSplitPairs
  // pairs the DATA rows (del i ↔ add i, the intraline rule) and every code cell is
  // CLONED from the unified DOM, so syntax tokens and intraline marks carry over
  // without re-emitting any HTML server-side. Finding rows are MOVED between the two
  // tables (ids and handlers survive; colspan adjusts). ──
  function buildSplit(fi) {
    if (splitCells[fi]) return;
    const cellIdx = new Map();
    const trIdx = new Map();
    splitCells[fi] = cellIdx;
    splitTrs[fi] = trIdx;
    const card = cardByFi.get(fi);
    const body = card && card.querySelector(".fbody");
    const utable = body && body.querySelector("table.diff");
    if (!utable) return; // no textual diff
    const rows = DATA.files[fi].rows;
    // Pairing works on DISPLAY order (expanded context rows have out-of-sequence
    // indexes); pair positions map back to real row indexes through the order map.
    const ord = rowOrder[fi];
    const dispRows = ord ? ord.map((i) => rows[i]) : rows;
    const riOf = (pos) => (pos === null ? null : ord ? ord[pos] : pos);
    const srcCell = (ri) => {
      const tr = rowEl(fi, ri);
      return tr ? tr.querySelector("td.code") : null;
    };
    const reg = (ri, el) => {
      const a = cellIdx.get(ri) || [];
      a.push(el);
      cellIdx.set(ri, a);
    };
    const gutterCell = (side, ri) => {
      const td = document.createElement("td");
      td.className = "g " + (side === "l" ? "go" : "gn");
      if (ri === null) { td.classList.add("emp"); return td; }
      const num = side === "l" ? rows[ri].o : rows[ri].n;
      if (num === null) return td;
      td.textContent = num;
      td.dataset.fi = fi;
      td.dataset.ri = ri;
      td.tabIndex = 0;
      td.setAttribute("role", "button");
      td.setAttribute("aria-label", "Select " + (side === "l" ? "old" : "new") + " line " + num);
      return td;
    };
    const codeCell = (side, ri, tint) => {
      const td = document.createElement("td");
      if (ri === null) { td.className = "code sc emp"; return td; }
      td.className = "code sc " + (side === "l" ? "cl" : "cr") + (tint ? " " + tint : "");
      // Coordinates on the cell itself (unified rows carry them on the <tr>): the
      // LSP hover/peek layer resolves either shape through one lookup.
      td.dataset.fi = fi;
      td.dataset.ri = ri;
      const src = srcCell(ri);
      if (src) td.innerHTML = src.innerHTML;
      return td;
    };
    const tbody = document.createElement("tbody");
    for (const p of buildSplitPairs(dispRows)) {
      const tr = document.createElement("tr");
      if (p.k === "hunk") {
        tr.className = "row hunk";
        const c = document.createElement("td");
        c.className = "code";
        c.colSpan = 4;
        const hri = riOf(p.ri);
        const src = srcCell(hri);
        c.textContent = src ? src.textContent : "";
        tr.append(c);
        trIdx.set(hri, tr);
      } else if (p.k === "ctx") {
        tr.className = "srow sctx";
        const cri = riOf(p.ri);
        const els = [gutterCell("l", cri), codeCell("l", cri, ""), gutterCell("r", cri), codeCell("r", cri, "")];
        els.forEach((el) => reg(cri, el));
        tr.append(els[0], els[1], els[2], els[3]);
        trIdx.set(cri, tr);
      } else {
        tr.className = "srow spair";
        const d = riOf(p.d), a = riOf(p.a);
        if (d !== null && a !== null && rows[d].w && rows[a].w) tr.dataset.ws = "1";
        const gl = gutterCell("l", d), cl = codeCell("l", d, "sdel");
        const gr = gutterCell("r", a), cr = codeCell("r", a, "sadd");
        if (d !== null) { gl.classList.add("sdel"); reg(d, gl); reg(d, cl); trIdx.set(d, tr); }
        if (a !== null) { gr.classList.add("sadd"); reg(a, gr); reg(a, cr); trIdx.set(a, tr); }
        tr.append(gl, cl, gr, cr);
      }
      tbody.append(tr);
    }
    const table = document.createElement("table");
    table.className = "diff split";
    const cg = document.createElement("colgroup");
    for (let i = 0; i < 4; i++) {
      const col = document.createElement("col");
      if (i % 2 === 0) col.className = "cg";
      cg.append(col);
    }
    table.append(cg, tbody);
    body.append(table);
  }
  function moveFrows(fi, toSplit) {
    const card = cardByFi.get(fi);
    if (!card || !splitTrs[fi]) return;
    const frows = [...card.querySelectorAll("tr.frow")];
    // Anchor row = nearest preceding tr with data-ri; recorded once on the frow.
    for (const fr of frows) {
      if (fr.dataset.ri === undefined) {
        let p = fr.previousElementSibling;
        while (p && p.dataset.ri === undefined) p = p.previousElementSibling;
        if (p) fr.dataset.ri = p.dataset.ri;
      }
    }
    const lastAt = new Map(); // target tr → last frow already re-inserted after it
    for (const fr of frows) {
      const ri = Number(fr.dataset.ri);
      const target = toSplit ? splitTrs[fi].get(ri) : rowEl(fi, ri);
      if (!target) continue;
      const td = fr.querySelector("td");
      if (td) td.colSpan = toSplit ? 4 : 3;
      const after = lastAt.get(target) || target;
      after.insertAdjacentElement("afterend", fr);
      lastAt.set(target, fr);
    }
  }
  function setSplit(on) {
    splitOn = on;
    for (const c of cards) {
      const fi = Number(c.dataset.fi);
      if (on) buildSplit(fi);
      if (splitCells[fi]) moveFrows(fi, on);
    }
    document.body.classList.toggle("split", on);
    stoggle.textContent = on ? "Split" : "Unified";
    stoggle.setAttribute("aria-pressed", String(on));
    persist.set("sleek:viewmode", on ? "split" : "unified");
    if (activeLayer >= 0) applyMarks(activeLayer); // re-mark the now-visible layout
    renderSel(); // selection + action bar follow the visible layout
    // Decoupled hook: the LSP layer (live mode only) closes any open hover tooltip
    // and peek panel — both belong to the previous layout. No listeners in static.
    document.dispatchEvent(new CustomEvent("sleek:splitchange"));
  }
  stoggle.addEventListener("click", () => setSplit(!splitOn));

  // ── Whitespace toggle (rows tagged data-ws server-side; pure CSS collapse) ──
  let wsHidden = false;
  function setWs(on) {
    if (wtoggle.disabled) return; // 0 ws-only pairs in this PR
    wsHidden = on;
    document.body.classList.toggle("wshide", on);
    wtoggle.setAttribute("aria-pressed", String(on));
    if (selEndEl) positionBar(); // row heights changed above the selection
    scheduleMarkers();
  }
  wtoggle.addEventListener("click", () => setWs(!wsHidden));

  // ── Word wrap toggle (Wave 4C: z / the topbar pill; pure CSS — body.wrap
  // soft-wraps unified code cells). Persisted like the view mode. ──
  let wrapOn = false;
  function setWrap(on) {
    wrapOn = on;
    document.body.classList.toggle("wrap", on);
    ztoggle.textContent = "Wrap";
    ztoggle.setAttribute("aria-pressed", String(on));
    persist.set("sleek:wrap", on ? "1" : "0");
    if (selEndEl) positionBar(); // row heights changed above the selection
    scheduleMarkers();
  }
  ztoggle.addEventListener("click", () => setWrap(!wrapOn));

  // ── Keyboard (Wave 3 — the ? overlay lists the full map): ]/[ files · j/k
  // hunks · n/p unresolved threads · 1..9 layer N · f cycle findings · t/⌘K jump
  // palette · x/⇧X row-focus select · c comment · y copy · a/A ask/escalate ·
  // r-chord review · v viewed+advance · s split · w whitespace · z wrap ·
  // h comments · ? help. All typing-context-guarded; c/r additionally need
  // live threads. ──
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t instanceof Element && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    // ⌘K / Ctrl+K opens the jump palette (the one modified binding here).
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      if (typing) return;
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing) return;
    // Armed r-chord: a/n/c open the submit modal preloaded with the verdict;
    // any other key (bare modifiers aside) just cancels the chord.
    if (chordArmed) {
      if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt") return;
      cancelChord();
      const v = e.key === "a" ? "approve" : e.key === "n" ? "request_changes" : e.key === "c" ? "comment" : null;
      if (v && threadsApi) { e.preventDefault(); threadsApi.openSubmit(v); }
      return;
    }
    if (e.key === "?") {
      e.preventDefault();
      if (helpWrap.hidden) openHelp(); else closeHelp();
    } else if (e.key === "]" || e.key === "[") {
      if (!cards.length) return;
      e.preventDefault();
      // activeFile holds the nav override while a programmatic scroll is in
      // flight, so repeated presses retarget from it, never the spy's guess.
      const pos = cards.indexOf(cardByFi.get(activeFile));
      const next = e.key === "]" ? Math.min(pos + 1, cards.length - 1) : Math.max(pos - 1, 0);
      goToFile(Number(cards[next].dataset.fi));
    } else if (e.key === "j" || e.key === "k") {
      if (!hunkList.length) return;
      e.preventDefault();
      // First press starts from the viewport (last hunk above the pane top);
      // after that the cursor persists, so repeated presses walk every hunk.
      if (hunkCursor !== -1) goToHunk(hunkCursor + (e.key === "j" ? 1 : -1));
      else goToHunk(viewportHunk() + (e.key === "j" ? 1 : 0));
    } else if (e.key === "n" || e.key === "p") {
      cycleThread(e.key === "n" ? 1 : -1);
    } else if (/^[1-9]$/.test(e.key)) {
      jumpToLayer(Number(e.key) - 1);
    } else if (e.key === "t") {
      e.preventDefault();
      openPalette();
    } else if (e.key === "x" || e.key === "X") {
      // Row-focus selection path: x selects the focused row (j/k/n/p set it)
      // as if its gutter were clicked; shift+x extends. No focus → no-op.
      if (!focusedRow) return;
      const row = DATA.files[focusedRow.fi].rows[focusedRow.ri];
      if (!row || row.t === "h") return;
      e.preventDefault();
      applySelect(focusedRow.fi, focusedRow.ri, e.key === "X");
    } else if (e.key === "y") {
      if (sel) doCopy();
    } else if (e.key === "a" || e.key === "A") {
      // Ask about the selection — the action-bar wiring: submit() with an empty
      // chat input focuses it (context attaches from the live selection);
      // static mode gets the prefilled stub. A escalates; unavailable
      // escalation flashes the esc-note caption instead of failing silently.
      if (!sel) return;
      e.preventDefault();
      if (!live) { ask(); return; }
      if (e.key === "A") {
        if (live.escalation === false) { flashEscNote(); return; }
        submit("/api/escalate");
      } else {
        submit("/api/ask");
      }
    } else if (e.key === "r") {
      if (threadsApi) armChord(); // static (no live threads): r does nothing
    } else if (e.key === "f") {
      if (scoped && activeLayer >= 0) cycleFinding(activeLayer);
      else cycleAllFindings();
    } else if (e.key === "v") {
      if (activeFile < 0) return;
      const on = !isViewed(activeFile);
      setViewed(activeFile, on, on);
    } else if (e.key === "s") {
      setSplit(!splitOn);
    } else if (e.key === "w") {
      setWs(!wsHidden);
    } else if (e.key === "z") {
      setWrap(!wrapOn);
    } else if (e.key === "h") {
      setComments(!commentsShown);
    } else if (e.key === "c") {
      if (threadsApi && sel) { e.preventDefault(); threadsApi.openComposer(); }
    }
  });

  // ── Wave 3 — keyboard-first: help overlay, hunk (j/k) + unresolved-thread
  // (n/p) cycling, digit layer jumps, the t/⌘K jump palette, the row-focus
  // selection path (x/⇧X), the r-chord and the contextual keyhint strip.
  // Everything here is DOM-driven (no fetches), so it behaves identically in
  // the static artifact and live mode: n/p sees the read-only finding threads
  // in static (plus composer-created reviewer threads in live), and the
  // r-chord/c gate on threadsApi, which stays null in static. ──
  const helpWrap = document.getElementById("helpwrap");
  const palWrap = document.getElementById("palwrap");
  const palInput = document.getElementById("pal-input");
  const palList = document.getElementById("pal-list");
  const keyhintEl = document.getElementById("keyhint");

  // Row-level explicit navigation (j/k, n/p, digit/palette jumps): the same
  // navHold contract as goToFile, so the file scroll-spy never fights the
  // programmatic scroll and ]/[ retarget from the landed file.
  function holdNav(fi) {
    if (!cardByFi.get(fi)) return;
    setActiveFile(fi);
    navHold = fi;
    clearTimeout(navTimer);
    navTimer = setTimeout(releaseNav, 1500);
  }
  // Brief keyboard focus ring: 2px accent outline fading ~1s (.kring in the CSS).
  function ringEl(el) {
    if (!el) return;
    el.classList.remove("kring");
    void el.offsetWidth; // restart the animation
    el.classList.add("kring");
    setTimeout(() => el.classList.remove("kring"), 1100);
  }

  // ── j/k: next/prev change block. hunkStartRows (injected keynav.ts) runs on
  // the ORIGINAL rows once: expanded-context rows never create new hunks. ──
  const hunkList = []; // {fi, ri} of every hunk's first row, in display order
  for (const c of cards) {
    const fi = Number(c.dataset.fi);
    for (const ri of hunkStartRows(DATA.files[fi].rows)) hunkList.push({ fi: fi, ri: ri });
  }
  let hunkCursor = -1;   // index into hunkList; -1 = not walked yet
  let focusedRow = null; // {fi, ri} set by j/k and n/p; x / shift+x select from it
  // The hunk the viewport is in: the LAST hunk whose first row sits above the
  // pane top (+ sticky-header allowance); -1 when the pane is above every hunk.
  function viewportHunk() {
    const cTop = center.getBoundingClientRect().top + 40;
    let last = -1;
    for (let i = 0; i < hunkList.length; i++) {
      const el = visibleRowEl(hunkList[i].fi, hunkList[i].ri);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.top < cTop) last = i;
    }
    return last;
  }
  function goToHunk(i) {
    if (!hunkList.length) return;
    const at = Math.max(0, Math.min(i, hunkList.length - 1));
    hunkCursor = at;
    const h = hunkList[at];
    const el = visibleRowEl(h.fi, h.ri);
    if (!el) return;
    focusedRow = { fi: h.fi, ri: h.ri };
    holdNav(h.fi);
    revealAndCenter(el);
    ringEl(el);
  }

  // ── n/p: next/prev UNRESOLVED thread. DOM state is the source of truth:
  // every open .thread card in display order — server-rendered finding threads
  // (the read-only static set), live-inserted reviewer threads, and read-only
  // GitHub comments. ──
  let lastThreadEl = null; // cycling continues from the last visited card
  function openThreadCards() {
    return [...center.querySelectorAll(".thread[data-tid],.thread[data-ghid]")].filter((el) => !el.classList.contains("resolved"));
  }
  // The thread's anchor row (for the focused-row context + nav hold): inserted
  // reviewer rows carry coordinates on their <tr>; server-rendered finding rows
  // resolve through their f-<li>-<k> id → anchor → threadRowIndex.
  function rowOfThread(card) {
    const tr = card.closest("tr.frow");
    if (tr && tr.dataset.fi !== undefined && tr.dataset.ri !== undefined) {
      return { fi: Number(tr.dataset.fi), ri: Number(tr.dataset.ri) };
    }
    const m = /^f-(\\d+)-(\\d+)$/.exec(card.dataset.tid || "");
    if (!m) return null;
    const a = DATA.layers[Number(m[1])].findings[Number(m[2])].anchor;
    const fi = fileIndex.get(a.file);
    if (fi === undefined) return null;
    const ri = threadRowIndex(DATA.files[fi].rows, a);
    return ri < 0 ? null : { fi: fi, ri: ri };
  }
  function jumpToThread(card) {
    if (!commentsShown) setComments(true); // hidden comments can't be cycled to
    lastThreadEl = card;
    const rc = rowOfThread(card);
    if (rc) { focusedRow = rc; holdNav(rc.fi); }
    revealAndCenter(card);
    ringEl(card);
  }
  function cycleThread(dir) {
    const list = openThreadCards();
    if (!list.length) return;
    let at = lastThreadEl ? list.indexOf(lastThreadEl) : -1;
    at = at === -1 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length;
    jumpToThread(list[at]);
  }

  // ── 1..9: jump to layer N in reading order — SOFT-activate (rail + bundle +
  // stripes, no dimming) and scroll to the layer's first anchor row. ──
  function jumpToLayer(li) {
    if (li < 0 || li >= DATA.layers.length) return;
    softActivate(li);
    const s = scopes[li];
    const first = s.hits[0] || s.span[0];
    if (!first) return;
    const el = visibleRowEl(first[0], first[1]);
    if (!el) return;
    holdNav(first[0]);
    revealAndCenter(el);
    ringEl(el);
  }

  // ── ? help overlay (markup ships in the page, hidden) ──
  function openHelp() { helpWrap.hidden = false; }
  function closeHelp() { helpWrap.hidden = true; }
  helpWrap.addEventListener("click", (e) => { if (e.target === helpWrap) closeHelp(); });
  document.getElementById("help-close").addEventListener("click", closeHelp);

  // ── t / ⌘K jump palette: fuzzy across file paths, layer titles and open
  // threads' first lines (injected palette.ts scoring). Items snapshot at open
  // time, so live thread churn is picked up per invocation. ──
  let palItems = [];  // {kind: file|layer|thread, label, fi?|li?|el?}
  let palShown = [];  // palItems indexes currently listed, best first
  let palActive = 0;  // position within palShown
  function paletteItems() {
    const items = [];
    for (const c of cards) {
      const fi = Number(c.dataset.fi);
      items.push({ kind: "file", label: DATA.files[fi].path, fi: fi });
    }
    DATA.layers.forEach((l, li) => items.push({ kind: "layer", label: l.title, li: li }));
    for (const el of openThreadCards()) {
      const body = el.querySelector(".tcbody");
      let line = "";
      if (body) {
        for (const ln of body.textContent.split("\\n")) {
          if (ln.trim()) { line = ln.trim(); break; }
        }
      }
      if (line.length > 80) line = line.slice(0, 79) + "…";
      items.push({ kind: "thread", label: line || "(no text)", el: el });
    }
    return items;
  }
  function setPalActive(i) {
    palActive = i;
    [...palList.children].forEach((el, k) => el.classList.toggle("active", k === i));
    const el = palList.children[i];
    if (el) el.scrollIntoView({ block: "nearest" });
  }
  function renderPalette() {
    palShown = paletteMatches(palInput.value.trim(), palItems.map((it) => it.label), 12);
    palActive = 0;
    palList.textContent = "";
    palShown.forEach((idx, pos) => {
      const it = palItems[idx];
      const li = document.createElement("li");
      li.className = "palitem" + (pos === 0 ? " active" : "");
      const kind = document.createElement("span");
      kind.className = "palkind";
      kind.textContent = it.kind;
      const lab = document.createElement("span");
      lab.className = "pallabel";
      lab.textContent = it.label;
      li.append(kind, lab);
      li.addEventListener("click", () => pickPalette(pos));
      palList.append(li);
    });
    if (!palShown.length) {
      const li = document.createElement("li");
      li.className = "palempty";
      li.textContent = "No matches";
      palList.append(li);
    }
  }
  function pickPalette(pos) {
    const idx = palShown[pos];
    if (idx === undefined) return;
    const it = palItems[idx];
    closePalette();
    if (it.kind === "file") goToFile(it.fi);
    else if (it.kind === "layer") jumpToLayer(it.li);
    else jumpToThread(it.el);
  }
  function openPalette() {
    closeHelp();
    palItems = paletteItems();
    palWrap.hidden = false;
    palInput.value = "";
    renderPalette();
    palInput.focus();
  }
  function closePalette() {
    palWrap.hidden = true;
    palInput.blur();
  }
  palWrap.addEventListener("click", (e) => { if (e.target === palWrap) closePalette(); });
  palInput.addEventListener("input", renderPalette);
  palInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (palShown.length) setPalActive((palActive + (e.key === "ArrowDown" ? 1 : -1) + palShown.length) % palShown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickPalette(palActive);
    } else if (e.key === "Escape") {
      e.stopPropagation(); // the document-level Esc chain must not also fire
      closePalette();
    }
  });

  // ── r-chord (Graphite): r arms a 1.5s window; a/n/c open the submit modal
  // preloaded with approve / request-changes / comment (see the main handler).
  // The keyhint strip shows a "r →" pending indicator while armed. ──
  let chordArmed = false;
  let chordTimer = 0;
  function armChord() {
    chordArmed = true;
    clearTimeout(chordTimer);
    chordTimer = setTimeout(cancelChord, 1500);
    updateKeyhint();
  }
  function cancelChord() {
    if (!chordArmed) return;
    chordArmed = false;
    clearTimeout(chordTimer);
    chordTimer = 0;
    updateKeyhint();
  }

  // A (escalate) when escalation is unavailable: flash the esc-note caption
  // (already un-hidden by the health probe in that state) instead of silence.
  function flashEscNote() {
    const note = document.getElementById("esc-note");
    if (!note) return;
    note.hidden = false;
    note.classList.remove("attn");
    void note.offsetWidth; // restart the animation
    note.classList.add("attn");
    setTimeout(() => note.classList.remove("attn"), 1600);
  }

  // ── Contextual keyhint strip (rail bottom): default nav keys; selection →
  // comment/copy/ask/extend; composer open → submit/close; armed r-chord →
  // the verdict keys. Capped at ~5 hints; ? is always last. ──
  let khFlash = "";
  let khTimer = 0;
  function flashKeyhint(text) {
    khFlash = text;
    updateKeyhint();
    clearTimeout(khTimer);
    khTimer = setTimeout(() => { khFlash = ""; updateKeyhint(); }, 1200);
  }
  function kbd(k) { return "<kbd>" + k + "</kbd>"; }
  function updateKeyhint() {
    if (!keyhintEl) return;
    let parts;
    if (chordArmed) { // an armed chord outranks even a "Copied ✓" flash
      parts = ['<span class="kpend">r →</span>', kbd("a") + " approve", kbd("n") + " request changes", kbd("c") + " comment"];
    } else if (khFlash) {
      parts = ['<span class="kpend">' + khFlash + "</span>"];
    } else if (document.querySelector("tr.crow")) {
      parts = [kbd("⌘↵") + " comment", kbd("Esc") + " close"];
    } else if (sel) {
      parts = [];
      if (threadsApi) parts.push(kbd("c") + " comment");
      parts.push(kbd("y") + " copy", kbd("a") + " ask", kbd("⇧x") + " extend");
    } else {
      parts = [kbd("]") + kbd("[") + " files", kbd("j") + kbd("k") + " hunks", kbd("n") + kbd("p") + " threads", kbd("t") + " jump"];
    }
    parts.push(kbd("?") + " help");
    keyhintEl.innerHTML = parts.join(" · ");
  }

  // ── Scrollbar thread markers (Wave 4C, static AND live — DOM-driven, no
  // fetches): a slim fixed strip overlaying the right edge of the diff pane.
  // Every .thread card maps to a stop: its anchor ROW's document offset (the
  // row stays visible when comments are hidden or the card is in a collapsed
  // file — then the file card's offset stands in) over #center.scrollHeight,
  // through the injected markerStops (clamp/sort/merge — markers.ts). Kinds:
  // open (reviewer activity — accent), resolved (muted), untouched finding
  // (severity color). Clicking jumps via jumpToThread — the same reveal +
  // ring pattern as n/p. Refreshes are throttled through scheduleMarkers,
  // called on load, thread sync, split/collapse/comments/ws/wrap toggles,
  // context expansion and window resize. ──
  const markstrip = document.getElementById("markstrip");
  let markTimer = 0;
  function markerItems() {
    const cRect = center.getBoundingClientRect();
    const items = [];
    center.querySelectorAll(".thread[data-tid]").forEach((card) => {
      let kind = "finding";
      if (card.classList.contains("resolved")) kind = "resolved";
      else if (card.classList.contains("reviewer") || card.querySelectorAll(".tcmt").length > 1) kind = "open";
      const rc = rowOfThread(card);
      const rowEl2 = rc ? visibleRowEl(rc.fi, rc.ri) : null;
      let r = rowEl2 ? rowEl2.getBoundingClientRect() : null;
      if (!r || r.height === 0) r = card.getBoundingClientRect();
      if (r.height === 0) {
        const fc = card.closest(".filecard");
        if (fc) r = fc.getBoundingClientRect();
      }
      if (r.height === 0) return; // nothing visible to anchor the marker to
      const m = /(?:^|\\s)sev-(critical|major|minor|info)/.exec(card.className);
      items.push({
        top: r.top - cRect.top + center.scrollTop,
        kind: kind,
        card: card,
        sev: kind === "finding" && m ? m[1] : null,
      });
    });
    return items;
  }
  function refreshMarkers() {
    const items = markerItems();
    const stops = markerStops(items.map((it) => ({ top: it.top, kind: it.kind })), center.scrollHeight);
    const rect = center.getBoundingClientRect();
    markstrip.style.left = (rect.right - 12) + "px";
    markstrip.style.top = rect.top + "px";
    markstrip.style.height = rect.height + "px";
    markstrip.textContent = "";
    markstrip.hidden = stops.length === 0;
    const kindLabel = { open: "Open thread", finding: "Finding", resolved: "Resolved thread" };
    for (const s of stops) {
      const it = items[s.at];
      const b = document.createElement("button");
      b.className = "mk mk-" + s.kind;
      if (it.sev) b.style.background = "var(--sev-" + it.sev + ")";
      b.style.top = (s.frac * 100) + "%";
      const loc = it.card.querySelector(".floc");
      const label = kindLabel[s.kind] + (loc ? " · " + loc.textContent : "");
      b.title = label;
      b.setAttribute("aria-label", "Jump to " + label);
      b.addEventListener("click", () => jumpToThread(it.card));
      markstrip.append(b);
    }
  }
  function scheduleMarkers() {
    clearTimeout(markTimer);
    markTimer = setTimeout(refreshMarkers, 120);
  }
  document.addEventListener("sleek:splitchange", scheduleMarkers);
  window.addEventListener("resize", scheduleMarkers);

  // ── Wave LSP (LIVE MODE ONLY): hover tooltips, peek definition, status
  // chip. Inert in a static artifact: initLsp is the SINGLE entry point,
  // called only when /api/health succeeds AND its payload carries lsp — until
  // then no listener is bound, no element un-hidden, no /api/lsp request fired. ──
  function initLsp(langs) {
    // langs: health.lsp — { ts|rust|java: {available, state, installHint?} }
    const availLang = (label) => Boolean(label && langs[label] && langs[label].available);
    const fileOk = (fi) => availLang(lspLangLabel(DATA.files[fi].path));

    // (3) status chip in the header: green dot when any language answers;
    // tooltip lists per-language state incl. the install hint when unavailable.
    const lspChip = document.getElementById("lsp-chip");
    const anyReady = Object.keys(langs).some((k) => langs[k].available);
    lspChip.classList.toggle("on", anyReady);
    lspChip.title = "Language intelligence\\n" + Object.keys(langs).map((k) => {
      const s = langs[k];
      return k + ": " + s.state + (!s.available && s.installHint ? " — " + s.installHint : "");
    }).join("\\n");
    lspChip.hidden = false;

    // Coordinates of a code cell: split cells carry data attrs on the <td>
    // (set in buildSplit's codeCell); unified rows carry them on the <tr>.
    function codeCoord(td) {
      if (td.dataset.ri !== undefined) return { fi: Number(td.dataset.fi), ri: Number(td.dataset.ri) };
      const tr = td.closest("tr.row");
      if (!tr || tr.dataset.ri === undefined) return null;
      return { fi: Number(tr.dataset.fi), ri: Number(tr.dataset.ri) };
    }
    // Caret under (x, y) → 1-based column into the cell's raw text. The cell is
    // white-space:pre and its textContent IS the raw code line exactly (tokens/
    // marks are wrappers around text nodes; the +/- diff marker is CSS ::before
    // generated content, never in the text), so raw text offset + 1 = LSP column.
    function colAt(cell, x, y) {
      let node = null, off = 0;
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        if (p) { node = p.offsetNode; off = p.offset; }
      } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r) { node = r.startContainer; off = r.startOffset; }
      }
      if (!node || node.nodeType !== 3 || !cell.contains(node)) return null;
      const textOff = textOffsetWithin(cell, node, off);
      if (textOff === null) return null;
      const text = cell.textContent;
      const i = Math.min(textOff, text.length - 1);
      if (i < 0 || !/[A-Za-z0-9_$]/.test(text.charAt(i))) return null; // symbols only
      return i + 1;
    }
    // A hover/peek position exists only on rows present at head: RIGHT-side (add)
    // and context rows. LEFT/del rows are old-file text — skipped entirely.
    function lspTargetAt(e) {
      const cell = e.target instanceof Element ? e.target.closest("td.code") : null;
      if (!cell || !center.contains(cell) || cell.classList.contains("emp")) return null;
      const c = codeCoord(cell);
      if (!c || !fileOk(c.fi)) return null;
      const r = DATA.files[c.fi].rows[c.ri];
      if (!r || r.t === "h" || r.t === "d" || r.n === null) return null;
      const col = colAt(cell, e.clientX, e.clientY);
      if (col === null) return null;
      return { fi: c.fi, ri: c.ri, cell: cell, x: e.clientX, file: DATA.files[c.fi].path, line: r.n, col: col };
    }

    // ── (1) hover tooltips: 350ms of stillness over a symbol → /api/lsp/hover ──
    const tip = document.createElement("div");
    tip.id = "lsp-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
    let tipCtx = null;    // target of the open tooltip (also feeds the d-key peek)
    let hoverToken = 0;   // bumping it invalidates any in-flight response
    let hoverTimer = 0;
    const hoverCache = new Map(); // file:line:col → HoverResult | null (session cache)
    function hideTip() { hoverToken++; tip.hidden = true; tipCtx = null; }
    function showTip(target, contents) {
      tip.innerHTML = renderMarkdown(contents, highlightFence); // the injected chat markdown renderer
      tip.hidden = false;
      tipCtx = target;
      const row = target.cell.getBoundingClientRect();
      tip.style.left = "0px";
      tip.style.top = "0px";
      const w = tip.offsetWidth, h = tip.offsetHeight;
      const left = Math.max(8, Math.min(target.x - 24, window.innerWidth - w - 8));
      let top = row.top - h - 6;             // above the hovered line by default
      if (top < 8) top = row.bottom + 6;     // no room above → below, still off the line
      top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    }
    async function fireHover(target) {
      const key = target.file + ":" + target.line + ":" + target.col;
      const token = ++hoverToken;
      let hover;
      if (hoverCache.has(key)) hover = hoverCache.get(key);
      else {
        try {
          const res = await fetch("/api/lsp/hover", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: target.file, line: target.line, character: target.col }),
          });
          if (!res.ok) return;
          const j = await res.json();
          hover = j && j.available === true && j.hover ? j.hover : null;
          hoverCache.set(key, hover);
        } catch (_) { return; }
      }
      if (token !== hoverToken) return; // stale: mouse moved on or tip dismissed
      if (hover && hover.contents) showTip(target, hover.contents);
    }
    center.addEventListener("mousemove", (e) => {
      clearTimeout(hoverTimer);
      const cell = e.target instanceof Element ? e.target.closest("td.code") : null;
      if (tipCtx && cell !== tipCtx.cell) hideTip(); // left the hovered cell
      if (!cell) return;
      hoverTimer = setTimeout(() => {
        const t = lspTargetAt(e);
        if (t) fireHover(t);
      }, 350);
    });
    center.addEventListener("mouseleave", (e) => {
      clearTimeout(hoverTimer);
      // Moving onto the tooltip itself keeps it up (its body can scroll).
      if (e.relatedTarget instanceof Node && tip.contains(e.relatedTarget)) return;
      hideTip();
    });
    tip.addEventListener("mouseleave", hideTip);
    document.addEventListener("scroll", hideTip, { capture: true, passive: true });

    // ── (2) peek definition: alt/cmd-click a symbol, or d with a tooltip open ──
    let peekRow = null; // the injected <tr>; only one peek open at a time
    const defCache = new Map(); // file:line:col → DefResult[]
    function closePeek() { if (peekRow) { peekRow.remove(); peekRow = null; } }
    function rowInDiff(file, line) {
      const fi = fileIndex.get(file);
      if (fi === undefined) return null;
      const ri = diagRowIndex(DATA.files[fi].rows, line);
      return ri === -1 ? null : { fi: fi, ri: ri };
    }
    function jumpTo(fi, ri) {
      const el = visibleRowEl(fi, ri);
      if (!el) return;
      revealAndCenter(el);
      flashEl(el);
    }
    function openPeek(target, defs) {
      closePeek();
      const anchor = visibleRowEl(target.fi, target.ri);
      if (!anchor) return;
      const tr = document.createElement("tr");
      tr.className = "peekrow";
      const td = document.createElement("td");
      td.colSpan = splitOn ? 4 : 3;
      const box = document.createElement("div");
      box.className = "peek";
      const hd = document.createElement("div");
      hd.className = "pkhd";
      const label = document.createElement("span");
      label.className = "pkt";
      label.textContent = defs.length === 1
        ? defs[0].file + ":" + defs[0].startLine
        : defs.length + " definitions";
      const x = document.createElement("button");
      x.className = "pkx";
      x.textContent = "×";
      x.setAttribute("aria-label", "Close peek");
      x.addEventListener("click", closePeek);
      hd.append(label, x);
      const body = document.createElement("div");
      body.className = "pkbody";
      defs.forEach((d, i) => {
        const item = document.createElement("div");
        item.className = "pkitem" + (i === 0 ? " focus" : "");
        const loc = document.createElement("button");
        loc.className = "pkloc";
        loc.textContent = d.file + ":" + d.startLine;
        loc.addEventListener("click", () => {
          body.querySelectorAll(".pkitem").forEach((p) => p.classList.remove("focus"));
          item.classList.add("focus");
        });
        item.append(loc);
        const at = rowInDiff(d.file, d.startLine);
        if (at) {
          const jump = document.createElement("button");
          jump.className = "pkjump";
          jump.textContent = "jump in diff";
          jump.title = "This definition is part of this PR — scroll to it";
          jump.addEventListener("click", () => jumpTo(at.fi, at.ri));
          item.append(jump);
        }
        if (d.preview) {
          const pre = document.createElement("pre");
          pre.className = "pkprev";
          pre.textContent = d.preview;
          item.append(pre);
        }
        body.append(item);
      });
      box.append(hd, body);
      td.append(box);
      tr.append(td);
      anchor.insertAdjacentElement("afterend", tr);
      peekRow = tr;
    }
    async function firePeek(target) {
      hideTip();
      const key = target.file + ":" + target.line + ":" + target.col;
      let defs;
      if (defCache.has(key)) defs = defCache.get(key);
      else {
        try {
          const res = await fetch("/api/lsp/definition", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: target.file, line: target.line, character: target.col }),
          });
          if (!res.ok) return;
          const j = await res.json();
          defs = j && j.available === true && Array.isArray(j.definitions) ? j.definitions : [];
          defCache.set(key, defs);
        } catch (_) { return; }
      }
      if (defs.length) openPeek(target, defs);
    }
    center.addEventListener("click", (e) => {
      if (!e.altKey && !e.metaKey) return;
      const t = lspTargetAt(e);
      if (!t) return;
      e.preventDefault();
      firePeek(t);
    });
    // Capture phase so a consumed Esc never also clears the line selection (the
    // bubble-phase Esc handler above); d peeks at the open tooltip's position.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!tip.hidden) { hideTip(); e.stopPropagation(); }
        else if (peekRow) { closePeek(); e.stopPropagation(); }
        return;
      }
      if (e.key !== "d" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof Element && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (tipCtx) { e.preventDefault(); firePeek(tipCtx); }
    }, true);

    // Split rebuilds: a peek row belongs to the previous layout's table, so it
    // closes; the hover tooltip's anchor rect is stale too.
    document.addEventListener("sleek:splitchange", () => {
      closePeek();
      hideTip();
    });
  }

  // ── Wave 2b threads (LIVE MODE ONLY): replies, resolve, ask-in-thread, the
  // selection composer and the pending Review bar. Inert in a static artifact:
  // the server-rendered Finding thread cards are the read-only rendering, and
  // initThreads is the SINGLE entry point (same gating pattern as initLsp) —
  // until /api/health reports threads:true no listener is bound, no element
  // un-hidden, no /api/threads request fired. ──

  function initThreads() {
    const cardByTid = new Map(); // tid → .thread element (server-rendered + inserted)
    document.querySelectorAll(".thread[data-tid]").forEach((el) => cardByTid.set(el.dataset.tid, el));
    const anchorByTid = new Map(); // tid → Anchor (from GET /api/threads)
    const commentBtn = document.getElementById("comment-sel");
    const pendbar = document.getElementById("pendbar");
    const pendLabel = document.getElementById("pend-label");
    const pendSubmit = document.getElementById("pend-submit");
    const submitWrap = document.getElementById("submitwrap");
    const submitSummary = document.getElementById("submit-summary");
    const submitGo = document.getElementById("submit-go");
    // Wave 4A export UI: gated on health.githubExport (a server with a repo
    // identity + gh runner). Without it the button never un-hides and no
    // /api/review/export request fires.
    const canExport = live && live.githubExport === true;
    const pendExport = document.getElementById("pend-export");
    const exportWrap = document.getElementById("exportwrap");
    const exportPreviewEl = document.getElementById("export-preview");
    const exportErr = document.getElementById("export-err");
    const exportGo = document.getElementById("export-go");
    let review = null;   // the submitted Review, when one exists
    let reviewExport = null; // the recorded GitHub export, when one exists
    let askBusy = false; // one in-thread ask stream at a time
    let composerRow = null;
    commentBtn.hidden = false;

    const jsonHeaders = { "Content-Type": "application/json" };
    const threadUrl = (tid, action) => "/api/threads/" + encodeURIComponent(tid) + "/" + action;
    async function errText(res) {
      let msg = "request failed (" + res.status + ")";
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
      return msg;
    }

    // ── Saved replies (Wave 4C; gated on health.replies — a server without a
    // store never grows the button). ONE shared fixed-position dropdown (the
    // thread cards' overflow:hidden would clip an inline one) serves every
    // composer/reply textarea: picking a reply inserts its body at the caret
    // (injected insertSnippet), × deletes it, and "Save current text as
    // reply…" opens a tiny inline title form (never window.prompt). Replies
    // are re-fetched on every open, so all editors stay in sync. ──
    const canReplies = Boolean(live && live.replies === true);
    const rpanel = canReplies ? buildRepliesPanel() : null;
    function buildRepliesPanel() {
      const panel = document.createElement("div");
      panel.id = "rpanel";
      panel.hidden = true;
      document.body.appendChild(panel);
      let curTa = null;  // the textarea the open panel serves
      let curBtn = null; // the button that opened it (anchor + focus return)
      function close() {
        if (panel.hidden) return;
        panel.hidden = true;
        curTa = null;
        curBtn = null;
      }
      async function fetchReplies() {
        try {
          const res = await fetch("/api/replies");
          if (res.ok) {
            const j = await res.json();
            if (j && Array.isArray(j.replies)) return j.replies;
          }
        } catch (_) {}
        return [];
      }
      // Above the anchor button by default (composers sit low); below when
      // there's no room; clamped to the viewport either way.
      function place() {
        if (!curBtn) return;
        const r = curBtn.getBoundingClientRect();
        panel.style.left = "0px";
        panel.style.top = "0px";
        const w = panel.offsetWidth, h = panel.offsetHeight;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
        let top = r.top - h - 6;
        if (top < 8) top = Math.min(r.bottom + 6, window.innerHeight - h - 8);
        panel.style.left = left + "px";
        panel.style.top = top + "px";
      }
      function render(replies) {
        panel.textContent = "";
        if (!replies.length) {
          const p = document.createElement("p");
          p.className = "rempty";
          p.textContent = "No saved replies yet.";
          panel.append(p);
        }
        for (const rep of replies) {
          const row = document.createElement("div");
          row.className = "ritem";
          const use = document.createElement("button");
          use.className = "ruse";
          use.textContent = rep.title;
          use.title = firstLineSummary(rep.body);
          use.addEventListener("click", () => {
            const ta = curTa;
            close();
            if (!ta) return;
            const ins = insertSnippet(ta.value, ta.selectionStart, ta.selectionEnd, rep.body);
            ta.value = ins.value;
            ta.focus();
            ta.setSelectionRange(ins.caret, ins.caret);
          });
          const del = document.createElement("button");
          del.className = "rdel";
          del.textContent = "×";
          del.title = "Delete this saved reply";
          const normalizedTitle = rep.title.replace(/"/g, "");
          del.setAttribute("aria-label", 'Delete saved reply "' + normalizedTitle + '"');
          del.addEventListener("click", async () => {
            try { await fetch("/api/replies/" + rep.id, { method: "DELETE" }); } catch (_) {}
            render(await fetchReplies());
            place();
          });
          row.append(use, del);
          panel.append(row);
        }
        const saveRow = document.createElement("div");
        saveRow.className = "rsave";
        const saveBtn = document.createElement("button");
        saveBtn.className = "rsavebtn";
        saveBtn.textContent = "Save current text as reply…";
        const form = document.createElement("div");
        form.className = "rform";
        form.hidden = true;
        const titleIn = document.createElement("input");
        titleIn.placeholder = "Title for this reply";
        titleIn.setAttribute("aria-label", "Title for the new saved reply");
        const go = document.createElement("button");
        go.textContent = "Save";
        form.append(titleIn, go);
        saveRow.append(saveBtn, form);
        panel.append(saveRow);
        async function saveCurrent() {
          const title = titleIn.value.trim();
          if (!title) { titleIn.focus(); return; }
          const body = curTa ? curTa.value : "";
          if (!body.trim()) { close(); return; }
          try {
            const res = await fetch("/api/replies", {
              method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: title, body: body }),
            });
            if (!res.ok) return;
          } catch (_) { return; }
          render(await fetchReplies());
          place();
        }
        saveBtn.addEventListener("click", () => {
          if (!curTa || !curTa.value.trim()) {
            const ta = curTa;
            close();
            if (ta) ta.focus(); // nothing to save: back to writing
            return;
          }
          saveBtn.hidden = true;
          form.hidden = false;
          place();
          titleIn.focus();
        });
        go.addEventListener("click", saveCurrent);
        titleIn.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); saveCurrent(); }
          else if (e.key === "Escape") {
            e.stopPropagation(); // collapse the title form only
            form.hidden = true;
            saveBtn.hidden = false;
            place();
          }
        });
      }
      async function open(btn, ta) {
        curBtn = btn;
        curTa = ta;
        render(await fetchReplies());
        panel.hidden = false;
        place();
      }
      // Click-away closes; the anchor button's own click toggles instead.
      document.addEventListener("click", (e) => {
        if (panel.hidden) return;
        if (panel.contains(e.target) || (curBtn && curBtn.contains(e.target))) return;
        close();
      });
      // The panel is viewport-fixed: any scroll would detach it from its anchor.
      document.addEventListener("scroll", close, { capture: true, passive: true });
      panel.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation(); // never enters the global dismiss chain
        const b = curBtn;
        close();
        if (b) b.focus();
      });
      return {
        toggle(btn, ta) {
          if (!panel.hidden && curBtn === btn) close();
          else open(btn, ta);
        },
        dismiss() {
          if (panel.hidden) return false;
          close();
          return true;
        },
      };
    }
    // The "Saved replies" affordance in a composer/editor action row.
    function attachReplies(acts, ta) {
      if (!rpanel) return;
      const btn = document.createElement("button");
      btn.className = "tbtn rbtn";
      btn.textContent = "Saved replies";
      btn.title = "Insert a saved reply at the cursor";
      btn.addEventListener("click", () => rpanel.toggle(btn, ta));
      acts.insertBefore(btn, acts.querySelector(".thint"));
    }

    function authorLabelOf(a) {
      if (a.type === "reviewer") return "You";
      if (a.type === "assistant") return "Assistant (" + a.model + ")";
      return "Finding";
    }
    // One Comment block. The opening finding Comment reproduces the server-rendered
    // header (severity chip + Concern + layer-scoping location chip) exactly;
    // reviewer/assistant Comments get an author label (+ Pending chip while draft).
    function commentEl(anchor, c, opening, tid) {
      const d = document.createElement("div");
      d.className = "tcmt" + (c.pending ? " pending" : "") + (c.author.type === "assistant" ? " assistant" : "");
      const hd = document.createElement("div");
      hd.className = "tchd";
      if (c.author.type === "finding") {
        const chip = document.createElement("span");
        chip.className = "chip " + c.severity;
        chip.textContent = c.severity;
        const concern = document.createElement("span");
        concern.className = "concern";
        concern.textContent = c.concern;
        hd.append(chip, concern);
        // Adopt: copy this finding into a reply you can edit and post under your
        // name (findings are local-only and never post themselves).
        if (live) {
          const adopt = document.createElement("button");
          adopt.className = "vistoggle tcadopt";
          adopt.textContent = "Adopt as my comment";
          adopt.title = "Copy this finding into a reply you can edit and post under your name";
          adopt.addEventListener("click", () => {
            const card = d.closest(".thread");
            const ta = card && card.querySelector(".teditor textarea");
            if (!ta) return;
            card.classList.add("editing");
            ta.value = c.body;
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
          });
          hd.append(adopt);
        }
      } else {
        const who = document.createElement("span");
        who.className = "tauthor";
        who.textContent = authorLabelOf(c.author);
        hd.append(who);
        if (c.pending) {
          const p = document.createElement("span");
          p.className = "pendchip";
          p.textContent = "Pending";
          hd.append(p);
        }
        // Local-only chip: reviewer comments with visibility === "local" get a
        // .localchip (dashed, muted/warn tone, distinct from Pending's accent).
        // Publishable is the default/unmarked state — no chip shown.
        // Clicking the chip (or a hover affordance on publishable comments) toggles
        // via POST /api/threads/:tid/comments/:cid/visibility (live only).
        const localCls = visChipClass(c.author.type, c.visibility);
        if (localCls) {
          const lc = document.createElement("button");
          lc.className = localCls;
          lc.textContent = "Local-only";
          lc.title = "This comment will not be posted to GitHub. Click to make publishable.";
          lc.dataset.tid = tid;
          lc.dataset.cid = c.id;
          lc.dataset.vis = "local";
          hd.append(lc);
        } else if (c.author.type === "reviewer" && live) {
          // Publishable reviewer comments: show a hover affordance to make local-only.
          const pa = document.createElement("button");
          pa.className = "vistoggle";
          pa.textContent = "Publishable";
          pa.title = "This comment will be posted to GitHub. Click to make local-only.";
          pa.dataset.tid = tid;
          pa.dataset.cid = c.id;
          pa.dataset.vis = "publishable";
          hd.append(pa);
        }
        // Edit / Delete: only your own still-pending (unsubmitted) drafts.
        if (c.author.type === "reviewer" && c.pending && live) {
          const edit = document.createElement("button");
          edit.className = "vistoggle tcedit";
          edit.textContent = "Edit";
          edit.title = "Edit this draft comment";
          edit.addEventListener("click", () => startInlineEdit(d, body, tid, c));
          const del = document.createElement("button");
          del.className = "vistoggle tcdel";
          del.textContent = "Delete";
          del.title = "Delete this draft comment";
          del.addEventListener("click", () => startInlineDelete(d, body, tid, c.id));
          hd.append(edit, del);
        }
      }
      if (opening) {
        const loc = document.createElement("button");
        loc.textContent = anchorLabel(anchor);
        if (/^f-\\d+-\\d+$/.test(tid)) {
          // Seeded finding thread: the existing floc delegation scopes the layer.
          loc.className = "floc";
          loc.dataset.fid = tid;
          loc.title = "Scope this layer and jump to these lines";
        } else {
          loc.className = "floc tloc";
          loc.dataset.tid = tid;
          loc.title = "Jump to these lines";
        }
        hd.append(loc);
      }
      const body = document.createElement("div");
      body.className = "tcbody";
      body.innerHTML = commentBodyHtml(c.body, currentLinesForAnchor(anchor), langForPath(anchor.file)); // escape-first renderers
      d.append(hd, body);
      return d;
    }
    // Location chips of reviewer threads: jump + flash, no layer scoping.
    document.addEventListener("click", (e) => {
      const b = e.target.closest("button.tloc");
      if (!b) return;
      const anchor = anchorByTid.get(b.dataset.tid);
      if (!anchor) return;
      const rows = anchorRows(anchor);
      if (!rows.length) return;
      const first = visibleRowEl(rows[0][0], rows[0][1]);
      if (first) revealAndCenter(first);
      rows.forEach(([fi, ri]) => flashEl(visibleRowEl(fi, ri)));
    });

    // Visibility chip / publishable affordance: toggle comment visibility via
    // POST /api/threads/:tid/comments/:cid/visibility (live only).
    document.addEventListener("click", (e) => {
      const b = e.target.closest("button.localchip, button.vistoggle");
      if (!b) return;
      const tid = b.dataset.tid;
      const cid = b.dataset.cid;
      const currentVis = b.dataset.vis; // "local" or "publishable"
      if (!tid || !cid) return;
      const newVis = currentVis === "local" ? "publishable" : "local";
      b.disabled = true;
      fetch("/api/threads/" + tid + "/comments/" + cid + "/visibility", {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ visibility: newVis }),
      }).then((r) => {
        if (r.ok) refetchThreads();
        else b.disabled = false;
      }).catch(() => { b.disabled = false; });
    });

    // ── Reply editor (per card, built once so a draft survives re-syncs) ──
    function buildEditor(card) {
      const ed = document.createElement("div");
      ed.className = "teditor";
      const ta = document.createElement("textarea");
      ta.placeholder = "Reply (markdown) — or Ask the Assistant about this thread";
      const acts = document.createElement("div");
      acts.className = "tacts";
      const replyBtn = document.createElement("button");
      replyBtn.className = "askbtn";
      replyBtn.textContent = "Reply";
      const askBtn = document.createElement("button");
      askBtn.className = "askbtn ghost";
      askBtn.textContent = "Ask";
      askBtn.title = "Ask the Assistant in this thread";
      const cancel = document.createElement("button");
      cancel.className = "tbtn";
      cancel.textContent = "Cancel";
      const hint = document.createElement("span");
      hint.className = "thint";
      hint.textContent = "⌘Enter to reply";
      // Visibility toggle: cycles Publishable ⇄ Local-only; default Publishable.
      let replyLocal = false;
      const visBtn = document.createElement("button");
      visBtn.className = "visbtn";
      visBtn.textContent = visToggleLabel(replyLocal);
      visBtn.title = visToggleTitle(replyLocal);
      visBtn.addEventListener("click", () => {
        replyLocal = !replyLocal;
        visBtn.textContent = visToggleLabel(replyLocal);
        visBtn.title = visToggleTitle(replyLocal);
        visBtn.classList.toggle("vis-local", replyLocal);
      });
      const err = document.createElement("p");
      err.className = "terr";
      err.hidden = true;
      acts.append(replyBtn, askBtn, visBtn, cancel, hint);
      attachReplies(acts, ta); // saved-replies dropdown (Wave 4C)
      ed.append(ta, acts, err);
      const collapse = () => { card.classList.remove("editing"); err.hidden = true; };
      replyBtn.addEventListener("click", () => postReply(card, ta, err, replyBtn, () => visPostValue(replyLocal)));
      askBtn.addEventListener("click", () => {
        const q = ta.value.trim();
        ta.value = "";
        collapse();
        askThread(card, q);
      });
      cancel.addEventListener("click", collapse);
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postReply(card, ta, err, replyBtn, () => visPostValue(replyLocal)); }
        else if (e.key === "Escape") { e.stopPropagation(); collapse(); } // selection survives
      });
      return ed;
    }
    async function postReply(card, ta, err, btn, getVis) {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      btn.disabled = true;
      err.hidden = true;
      try {
        const vis = typeof getVis === "function" ? getVis() : null;
        const body = { body: text };
        if (vis) body.visibility = vis;
        const res = await fetch(threadUrl(card.dataset.tid, "comments"), {
          method: "POST", headers: jsonHeaders, body: JSON.stringify(body),
        });
        if (!res.ok) { err.textContent = await errText(res); err.hidden = false; return; }
        ta.value = "";
        card.classList.remove("editing");
        await refetchThreads();
      } catch (_) {
        err.textContent = "network error";
        err.hidden = false;
      } finally { btn.disabled = false; }
    }

    // ── Edit a pending draft in place: PATCH /api/threads/:tid/comments/:cid ──
    function startInlineEdit(commentDiv, bodyEl, tid, c) {
      if (commentDiv.querySelector(".tcedit-form")) return;
      const form = document.createElement("div");
      form.className = "teditor tcedit-form";
      const ta = document.createElement("textarea");
      ta.value = c.body;
      const acts = document.createElement("div");
      acts.className = "tacts";
      const save = document.createElement("button");
      save.className = "askbtn";
      save.textContent = "Save";
      const cancel = document.createElement("button");
      cancel.className = "tbtn";
      cancel.textContent = "Cancel";
      const err = document.createElement("p");
      err.className = "terr";
      err.hidden = true;
      acts.append(save, cancel);
      form.append(ta, acts, err);
      bodyEl.hidden = true;
      commentDiv.append(form);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      const done = () => { form.remove(); bodyEl.hidden = false; };
      cancel.addEventListener("click", done);
      const doSave = async () => {
        const text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        save.disabled = true;
        err.hidden = true;
        try {
          const res = await fetch("/api/threads/" + tid + "/comments/" + c.id, {
            method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ body: text }),
          });
          if (!res.ok) { err.textContent = await errText(res); err.hidden = false; save.disabled = false; return; }
          await refetchThreads();
        } catch (_) {
          err.textContent = "network error";
          err.hidden = false;
          save.disabled = false;
        }
      };
      save.addEventListener("click", doSave);
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSave(); }
        else if (e.key === "Escape") { e.stopPropagation(); done(); }
      });
    }

    // ── Delete a pending draft: inline confirm (no window.confirm), then
    // DELETE /api/threads/:tid/comments/:cid ──
    function startInlineDelete(commentDiv, bodyEl, tid, cid) {
      if (commentDiv.querySelector(".tcdel-form")) return;
      const form = document.createElement("div");
      form.className = "teditor tcdel-form";
      const msg = document.createElement("p");
      msg.className = "thint";
      msg.textContent = "Delete this draft comment? This cannot be undone.";
      const acts = document.createElement("div");
      acts.className = "tacts";
      const go = document.createElement("button");
      go.className = "askbtn";
      go.textContent = "Delete";
      const cancel = document.createElement("button");
      cancel.className = "tbtn";
      cancel.textContent = "Cancel";
      const err = document.createElement("p");
      err.className = "terr";
      err.hidden = true;
      acts.append(go, cancel);
      form.append(msg, acts, err);
      bodyEl.hidden = true;
      commentDiv.append(form);
      go.focus();
      const done = () => { form.remove(); bodyEl.hidden = false; };
      cancel.addEventListener("click", done);
      go.addEventListener("click", async () => {
        go.disabled = true;
        err.hidden = true;
        try {
          const res = await fetch("/api/threads/" + tid + "/comments/" + cid, { method: "DELETE" });
          if (!res.ok) { err.textContent = await errText(res); err.hidden = false; go.disabled = false; return; }
          await refetchThreads();
        } catch (_) {
          err.textContent = "network error";
          err.hidden = false;
          go.disabled = false;
        }
      });
    }

    // ── Ask the Assistant in-thread: post the question as a (pending) Comment,
    // stream the answer into a temporary bubble with the chat panel's throttled
    // markdown re-render, then REFETCH — the persisted assistant Comment comes
    // from GET /api/threads, never from the stream itself (see serve.ts). ──
    async function askThread(card, question) {
      if (askBusy) return;
      askBusy = true;
      const tid = card.dataset.tid;
      const anchor = anchorByTid.get(tid);
      const cmts = card.querySelector(".tcmts");
      const tmp = document.createElement("div");
      tmp.className = "tcmt assistant";
      const hd = document.createElement("div");
      hd.className = "tchd";
      const who = document.createElement("span");
      who.className = "tauthor";
      who.textContent = "Assistant";
      const busy = document.createElement("span");
      busy.className = "thinking";
      busy.textContent = "thinking…";
      hd.append(who, busy);
      const body = document.createElement("div");
      body.className = "tcbody";
      tmp.append(hd, body);
      try {
        if (question) {
          const cres = await fetch(threadUrl(tid, "comments"), {
            method: "POST", headers: jsonHeaders, body: JSON.stringify({ body: question }),
          });
          if (cres.ok) cmts.append(commentEl(anchor, await cres.json(), false, tid));
        }
        cmts.append(tmp);
        const res = await fetch(threadUrl(tid, "ask"), {
          method: "POST", headers: jsonHeaders, body: JSON.stringify(question ? { question: question } : {}),
        });
        if (!res.ok) { busy.remove(); body.textContent = await errText(res); return; }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let acc = "";
        let lastRender = 0;
        let renderTimer = 0;
        const renderAcc = () => {
          if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
          lastRender = Date.now();
          body.innerHTML = renderMarkdown(acc, highlightFence);
        };
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const text = dec.decode(chunk.value, { stream: true });
          acc += text;
          if (text.indexOf("\\n") !== -1 || Date.now() - lastRender >= 150) renderAcc();
          else if (!renderTimer) renderTimer = setTimeout(renderAcc, 150);
        }
        acc += dec.decode();
        renderAcc();
        busy.remove();
        await refetchThreads(); // swaps the temp bubble for the persisted Comment
      } catch (err2) {
        busy.remove();
        body.textContent = "network error: " + (err2 && err2.message ? err2.message : err2);
      } finally { askBusy = false; }
    }

    // ── Resolve / unresolve ──
    async function toggleResolve(card, btn) {
      btn.disabled = true;
      const action = card.classList.contains("resolved") ? "unresolve" : "resolve";
      try {
        const res = await fetch(threadUrl(card.dataset.tid, action), { method: "POST" });
        if (res.ok) await refetchThreads();
      } catch (_) {}
      btn.disabled = false;
    }

    // ── Card sync: rebuild the Comment list from server state (idempotent — the
    // client-built markup matches the server-rendered opening exactly); the pill,
    // editor and footer are created once and updated in place. ──
    function syncThread(card, t) {
      anchorByTid.set(t.id, t.anchor);
      card.classList.toggle("resolved", t.status === "resolved");
      if (t.status === "open") card.classList.remove("expanded");
      const cmts = card.querySelector(".tcmts");
      cmts.textContent = "";
      t.comments.forEach((c, i) => cmts.append(commentEl(t.anchor, c, i === 0, t.id)));
      let pill = card.querySelector(".tpill");
      if (!pill) {
        pill = document.createElement("button");
        pill.className = "tpill";
        pill.title = "Show resolved thread";
        pill.addEventListener("click", () => card.classList.toggle("expanded"));
        card.prepend(pill);
      }
      pill.textContent = "";
      const ok = document.createElement("span");
      ok.className = "ok";
      ok.textContent = "✓ resolved";
      pill.append(ok, document.createTextNode(" · " + firstLineSummary(t.comments[0].body)));
      if (!card.querySelector(".teditor")) card.append(buildEditor(card));
      let foot = card.querySelector(".tfoot");
      if (!foot) {
        foot = document.createElement("div");
        foot.className = "tfoot";
        const reply = document.createElement("button");
        reply.className = "treply";
        reply.textContent = "Reply…";
        reply.addEventListener("click", () => {
          card.classList.add("editing");
          card.querySelector(".teditor textarea").focus();
        });
        const resolve = document.createElement("button");
        resolve.className = "tbtn tresolve";
        resolve.addEventListener("click", () => toggleResolve(card, resolve));
        foot.append(reply, resolve);
        card.append(foot);
      }
      foot.querySelector(".tresolve").textContent = t.status === "resolved" ? "Unresolve" : "Resolve";
    }

    // Reviewer-created Threads arrive only via the API: build a card and insert
    // its row at the anchor (threadRowIndex mirrors the server's placement),
    // after any thread rows already on that row.
    function insertThreadCard(t) {
      const fi = fileIndex.get(t.anchor.file);
      if (fi === undefined) return null;
      const rows = DATA.files[fi].rows;
      if (!rows.length) return null;
      const ri = threadRowIndex(rows, t.anchor);
      if (ri < 0) return null;
      let after = visibleRowEl(fi, ri);
      if (!after) return null;
      while (after.nextElementSibling && after.nextElementSibling.classList.contains("frow")) after = after.nextElementSibling;
      const tr = document.createElement("tr");
      tr.className = "frow";
      tr.dataset.fi = fi;
      tr.dataset.ri = ri;
      tr.dataset.tid = t.id;
      const td = document.createElement("td");
      td.colSpan = splitOn ? 4 : 3;
      const card = document.createElement("div");
      card.className = "thread reviewer";
      card.dataset.tid = t.id;
      const cmts = document.createElement("div");
      cmts.className = "tcmts";
      card.append(cmts);
      td.append(card);
      tr.append(td);
      after.insertAdjacentElement("afterend", tr);
      return card;
    }

    function applyState(state) {
      for (const t of state.threads) {
        let card = cardByTid.get(t.id);
        if (!card) {
          card = insertThreadCard(t);
          if (card) cardByTid.set(t.id, card);
        }
        if (card) syncThread(card, t);
      }
      review = state.review;
      reviewExport = state.reviewExport || null;
      updatePendBar(state.pendingCount);
      updateLocalThreadCount(state.threads.length);
      if (activeLayer >= 0) applyMarks(activeLayer); // newly inserted rows join the scope
      scheduleMarkers(); // create/resolve/refetch: the strip mirrors thread state
    }
    async function refetchThreads() {
      try {
        const res = await fetch("/api/threads");
        if (res.ok) applyState(await res.json());
      } catch (_) {}
    }
    document.addEventListener("sleek:refreshthreads", refetchThreads);

    // ── Pending-review bar: N pending → Submit; submitted → the verdict, plus
    // "Post to GitHub" when the server can really export (health.githubExport) ──
    function updatePendBar(pendingCount) {
      pendLabel.textContent = "";
      pendExport.hidden = true;
      if (pendingCount > 0) {
        pendLabel.textContent = pendingCount + " pending comment" + (pendingCount === 1 ? "" : "s");
        pendSubmit.hidden = false;
        pendbar.hidden = false;
      } else if (review) {
        const v = document.createElement("span");
        v.className = "verdict " + review.verdict;
        v.textContent = verdictLabel(review.verdict);
        pendLabel.append(document.createTextNode("Review submitted · "), v);
        pendSubmit.hidden = true;
        if (canExport) {
          pendExport.textContent = reviewExport ? "Posted to GitHub ✓" : "Post to GitHub";
          pendExport.hidden = false;
        }
        pendbar.hidden = false;
      } else {
        pendbar.hidden = true;
      }
    }

    // ── Submit modal: verdict radios + optional markdown summary ──
    function closeSubmit() { submitWrap.hidden = true; }
    async function doSubmit() {
      const checked = document.querySelector('input[name="verdict"]:checked');
      submitGo.disabled = true;
      try {
        const res = await fetch("/api/review/submit", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ verdict: checked ? checked.value : "comment", summary: submitSummary.value }),
        });
        if (res.ok) {
          closeSubmit();
          await refetchThreads(); // pending chips/borders clear; the bar shows the verdict
        }
      } catch (_) {}
      submitGo.disabled = false;
    }
    pendSubmit.addEventListener("click", () => {
      submitWrap.hidden = false;
      submitSummary.focus();
    });
    submitGo.addEventListener("click", doSubmit);
    document.getElementById("submit-cancel").addEventListener("click", closeSubmit);
    submitWrap.addEventListener("click", (e) => { if (e.target === submitWrap) closeSubmit(); });
    submitWrap.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSubmit(); }
    });

    // ── Post to GitHub (Wave 4A): two explicit steps. Opening the modal fetches
    // the DRY-RUN preview (never touches gh); only the confirm button performs
    // the real POST /api/review/export. ──
    function closeExport() { exportWrap.hidden = true; }
    function showExportError(msg) {
      exportErr.textContent = msg;
      exportErr.hidden = false;
    }
    function previewLine(cls, nodes) {
      const p = document.createElement("p");
      p.className = cls;
      nodes.forEach((n) => p.append(n));
      exportPreviewEl.append(p);
      return p;
    }
    // The posted state: green confirmation + the GitHub review link.
    function renderExportDone(rec) {
      exportPreviewEl.textContent = "";
      const done = previewLine("xdone", [document.createTextNode("Posted to GitHub. ")]);
      if (rec && rec.url) {
        const a = document.createElement("a");
        a.href = rec.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = rec.url;
        done.append(a);
      } else if (rec) {
        done.append(document.createTextNode("GitHub review #" + rec.githubReviewId + "."));
      }
      exportGo.hidden = true;
    }
    // The confirmation step, from the server's dry-run response.
    function renderExportPreview(d) {
      exportPreviewEl.textContent = "";
      exportGo.hidden = false;
      exportGo.disabled = true;
      if (d.reviewExport) { renderExportDone(d.reviewExport); return; }
      if (d.available === false) {
        exportPreviewEl.textContent = "Export is unavailable on this server — no GitHub repo is configured.";
        exportGo.hidden = true;
        return;
      }
      const badge = document.createElement("span");
      badge.className = "verdict " + d.preview.verdict;
      badge.textContent = verdictLabel(d.preview.verdict);
      previewLine("xline", [document.createTextNode("Verdict: "), badge]);
      previewLine("xline", [document.createTextNode(exportPreviewLabel(d.preview))]);
      // Wave-8: if the plan excluded local-only comments, report how many.
      const excLine = excludedLocalLine(d.excludedLocalCount || 0);
      if (excLine) previewLine("xline xlocal", [document.createTextNode(excLine)]);
      if (typeof d.excludedPendingCount === "number" && d.excludedPendingCount > 0) {
        previewLine("xline", [document.createTextNode(d.excludedPendingCount + " pending comment(s) not included — submit them with a review first")]);
      }
      if (d.preview.files.length) {
        const ul = document.createElement("ul");
        ul.className = "xfiles";
        d.preview.files.forEach((f) => {
          const li = document.createElement("li");
          li.textContent = f;
          ul.append(li);
        });
        exportPreviewEl.append(ul);
      }
      previewLine("xwarn", [document.createTextNode("This posts the review to the real pull request on GitHub.")]);
      exportGo.disabled = false;
    }
    async function openExport() {
      exportWrap.hidden = false;
      exportErr.hidden = true;
      exportGo.hidden = false;
      exportGo.disabled = true;
      exportPreviewEl.textContent = "Building preview…";
      try {
        const res = await fetch("/api/review/export", {
          method: "POST", headers: jsonHeaders, body: JSON.stringify({ dryRun: true }),
        });
        if (!res.ok) { exportPreviewEl.textContent = ""; showExportError(await errText(res)); return; }
        let data;
        try {
          data = await res.json();
        } catch (_) {
          exportPreviewEl.textContent = "";
          showExportError("GitHub export preview returned invalid JSON");
          return;
        }
        renderExportPreview(data);
      } catch (_) {
        exportPreviewEl.textContent = "";
        showExportError("network error");
      }
    }
    async function doExport() {
      exportGo.disabled = true;
      exportErr.hidden = true;
      try {
        const res = await fetch("/api/review/export", {
          method: "POST", headers: jsonHeaders, body: JSON.stringify({}),
        });
        if (!res.ok) { showExportError(await errText(res)); exportGo.disabled = false; return; }
        const d = await res.json();
        // A dryRun answer to a real request means the server can't export
        // (target unconfigured): re-render the safe state instead of claiming success.
        if (d.dryRun === true) { renderExportPreview(d); return; }
        renderExportDone(d.reviewExport);
        await refetchThreads(); // the pend bar flips to "Posted to GitHub ✓"
      } catch (_) {
        showExportError("network error");
        exportGo.disabled = false;
      }
    }
    pendExport.addEventListener("click", openExport);
    exportGo.addEventListener("click", doExport);
    document.getElementById("export-cancel").addEventListener("click", closeExport);
    exportWrap.addEventListener("click", (e) => { if (e.target === exportWrap) closeExport(); });

    // ── Composer: a new Thread on the current selection (c key / Comment button).
    // The Anchor is captured at open time; ctx rows anchor RIGHT with their
    // new-file numbers, so commenting on unchanged lines just works. ──
    function closeComposer() {
      if (!composerRow) return;
      if (rpanel) rpanel.dismiss(); // a dropdown serving the composer dies with it
      composerRow.remove();
      composerRow = null;
      updateKeyhint();
    }
    function openComposer() {
      const rows = selectedRows();
      if (!rows.length || !selEndEl) return;
      closeComposer();
      const pureDel = rows.every((x) => x[2].t === "d");
      const lines = rows.map((x) => (pureDel ? x[2].o : x[2].n)).filter((v) => v !== null);
      if (!lines.length) return;
      const anchor = {
        file: DATA.files[sel.fi].path,
        side: pureDel ? "LEFT" : "RIGHT",
        startLine: Math.min.apply(null, lines),
        endLine: Math.max.apply(null, lines),
      };
      const tr = document.createElement("tr");
      tr.className = "crow";
      const td = document.createElement("td");
      td.colSpan = splitOn ? 4 : 3;
      const box = document.createElement("div");
      box.className = "composer";
      const lab = document.createElement("span");
      lab.className = "clabel";
      lab.textContent = "New thread on " + selLabel(rows.map((x) => x[2]), DATA.files[sel.fi].path);
      const ta = document.createElement("textarea");
      ta.placeholder = "Leave a comment (markdown; suggestion fences render as a mini-diff)";
      const acts = document.createElement("div");
      acts.className = "tacts";
      const go = document.createElement("button");
      go.className = "askbtn";
      go.textContent = "Comment";
      const cancel = document.createElement("button");
      cancel.className = "tbtn";
      cancel.textContent = "Cancel";
      const hint = document.createElement("span");
      hint.className = "thint";
      hint.textContent = "⌘Enter to comment · Esc to close";
      // Visibility toggle: cycles Publishable ⇄ Local-only; default Publishable.
      let composerLocal = false;
      const composerVisBtn = document.createElement("button");
      composerVisBtn.className = "visbtn";
      composerVisBtn.textContent = visToggleLabel(composerLocal);
      composerVisBtn.title = visToggleTitle(composerLocal);
      composerVisBtn.addEventListener("click", () => {
        composerLocal = !composerLocal;
        composerVisBtn.textContent = visToggleLabel(composerLocal);
        composerVisBtn.title = visToggleTitle(composerLocal);
        composerVisBtn.classList.toggle("vis-local", composerLocal);
      });
      const err = document.createElement("p");
      err.className = "terr";
      err.hidden = true;
      acts.append(go, composerVisBtn, cancel, hint);
      attachReplies(acts, ta); // saved-replies dropdown (Wave 4C)
      box.append(lab, ta, acts, err);
      td.append(box);
      tr.append(td);
      // Under the selection: after the selection-end row and any thread rows on it.
      let after = selEndEl;
      while (after.nextElementSibling && after.nextElementSibling.classList.contains("frow")) after = after.nextElementSibling;
      after.insertAdjacentElement("afterend", tr);
      composerRow = tr;
      const submitNew = async () => {
        const text = ta.value.trim();
        if (!text) { ta.focus(); return; }
        go.disabled = true;
        err.hidden = true;
        try {
          const vis = visPostValue(composerLocal);
          const payload = { anchor: anchor, body: text };
          if (vis) payload.visibility = vis;
          const res = await fetch("/api/threads", {
            method: "POST", headers: jsonHeaders, body: JSON.stringify(payload),
          });
          if (!res.ok) { err.textContent = await errText(res); err.hidden = false; go.disabled = false; return; }
          closeComposer();
          clearSel();
          await refetchThreads();
        } catch (_) {
          err.textContent = "network error";
          err.hidden = false;
          go.disabled = false;
        }
      };
      go.addEventListener("click", submitNew);
      cancel.addEventListener("click", closeComposer);
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitNew(); }
        else if (e.key === "Escape") { e.stopPropagation(); closeComposer(); } // selection survives
      });
      positionBar(); // the composer sits below the row; the bar moves above it
      ta.focus();
      updateKeyhint();
    }
    commentBtn.addEventListener("click", openComposer);
    // The composer row belongs to the previous layout's table, so it closes on a
    // split/unified switch (thread rows are frows — moveFrows carries those over).
    document.addEventListener("sleek:splitchange", closeComposer);

    threadsApi = {
      openComposer: openComposer,
      // r-chord target (Wave 3): the submit modal preloaded with a verdict.
      openSubmit(verdict) {
        const radio = document.querySelector('input[name="verdict"][value="' + verdict + '"]');
        if (radio) radio.checked = true;
        submitWrap.hidden = false;
        submitSummary.focus();
      },
      // Progressive Esc, one layer per press: saved-replies dropdown (it
      // overlays the composer/editor it serves), export modal, submit modal,
      // composer.
      dismiss() {
        if (rpanel && rpanel.dismiss()) return true;
        if (!exportWrap.hidden) { closeExport(); return true; }
        if (!submitWrap.hidden) { closeSubmit(); return true; }
        if (composerRow) { closeComposer(); return true; }
        return false;
      },
    };
    refetchThreads(); // restores threads + review + pendingCount on load
  }

  // ── "Changes since last scaffold" (Wave 4B, LIVE MODE ONLY, gated on
  // health.versions): one GET /api/versions probe on load. When the store holds
  // older scaffold versions of this PR, the slim banner under the topbar appears
  // ("Scaffold updated · N previous versions · What changed?"); the panel it
  // opens fetches GET /api/versions/diff?from=<sha> (server-side diff,
  // src/domain/scaffolddiff.ts) and renders it through the injected versionsui
  // helpers (diffCountsLabel/diffSections — counts line up top, then plain ULs;
  // items are textContent, nothing needs escaping). With 2+ previous versions a
  // pill picker chooses "from" (default: the immediately preceding version).
  // Esc closes the panel via versionsApi.dismiss(), FIRST in the progressive
  // dismiss chain; the banner's × dismisses the banner for this page load.
  // initVersions is the SINGLE entry point (same gating pattern as initThreads):
  // a static artifact never shows the banner and never probes /api/versions. ──
  function initVersions() {
    const banner = document.getElementById("verbanner");
    const bannerLabel = document.getElementById("verbanner-label");
    const wrap = document.getElementById("verswrap");
    const picker = document.getElementById("vers-picker");
    const countsEl = document.getElementById("vers-counts");
    const sectionsEl = document.getElementById("vers-sections");
    const versErr = document.getElementById("vers-err");
    let previous = []; // stored versions other than the served one, newest first
    let selectedFrom = null; // the picker's current "from" sha

    function closeVersions() { wrap.hidden = true; }
    function showVersError(msg) {
      countsEl.textContent = "";
      versErr.textContent = msg;
      versErr.hidden = false;
    }
    function renderPicker() {
      picker.textContent = "";
      picker.hidden = previous.length < 2; // one previous version needs no picker
      if (picker.hidden) return;
      for (const v of previous) {
        const b = document.createElement("button");
        b.className = "vpick" + (v.headSha === selectedFrom ? " on" : "");
        b.textContent = versionOptionLabel(v);
        b.title = "Compare against scaffold " + v.headSha;
        b.addEventListener("click", () => {
          selectedFrom = v.headSha;
          renderPicker();
          loadDiff();
        });
        picker.append(b);
      }
    }
    async function loadDiff() {
      versErr.hidden = true;
      sectionsEl.textContent = "";
      countsEl.textContent = "Comparing…";
      try {
        const res = await fetch("/api/versions/diff?from=" + encodeURIComponent(selectedFrom));
        if (!res.ok) {
          let msg = "request failed (" + res.status + ")";
          try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
          showVersError(msg);
          return;
        }
        const d = await res.json();
        countsEl.textContent = diffCountsLabel(d.diff.counts);
        for (const sec of diffSections(d.diff)) {
          const h4 = document.createElement("h4");
          h4.textContent = sec.title;
          const ul = document.createElement("ul");
          for (const item of sec.items) {
            const li = document.createElement("li");
            li.textContent = item;
            ul.append(li);
          }
          sectionsEl.append(h4, ul);
        }
      } catch (_) {
        showVersError("network error");
      }
    }
    function openVersions() {
      wrap.hidden = false;
      renderPicker();
      loadDiff();
    }

    document.getElementById("verbanner-open").addEventListener("click", openVersions);
    document.getElementById("verbanner-close").addEventListener("click", () => { banner.hidden = true; });
    document.getElementById("vers-close").addEventListener("click", closeVersions);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) closeVersions(); });

    versionsApi = {
      // Progressive Esc: the versions panel (an overlay) closes first.
      dismiss() {
        if (!wrap.hidden) { closeVersions(); return true; }
        return false;
      },
    };

    fetch("/api/versions")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.versions)) return;
        previous = data.versions.filter((v) => v && v.current !== true);
        if (data.versions.length < 2 || !previous.length) return; // nothing to compare
        selectedFrom = previous[0].headSha;
        bannerLabel.textContent = versionsBannerLabel(previous.length) +
          (data.stale === true ? " · a newer scaffold exists" : "");
        banner.hidden = false;
      })
      .catch(() => {}); // versions stay invisible when the probe fails
  }

  // ── Wave-7 model choice + scaffold run (LIVE MODE ONLY): the Assistant model
  // dropdown by #chat-model-select, the Process-PR button in the topbar, and the
  // Scaffolder picker modal with NDJSON progress. initModels is the SINGLE entry
  // point to /api/models, /api/model, and /api/scaffold — a static artifact never
  // calls it. ──
  function initModels(h) {
    const procBtn = document.getElementById("procpr");
    const procWrap = document.getElementById("procwrap");
    const procChoices = document.getElementById("proc-choices");
    const procErr = document.getElementById("proc-err");
    const procProgress = document.getElementById("proc-progress");
    const procStages = document.getElementById("proc-stages");
    const procGo = document.getElementById("proc-go");
    const procRetry = document.getElementById("proc-retry");
    const procCancel = document.getElementById("proc-cancel");
    const procTimer = document.getElementById("proc-timer");
    const modelSelect = document.getElementById("chat-model-select");
    const modelNote = document.getElementById("chat-model-note");
    // Non-blocking progress chip (topbar) — shown once a run starts; the modal closes.
    const procChip = document.getElementById("procchip");
    const procChipLabel = document.getElementById("procchip-label");
    const procChipRetry = document.getElementById("procchip-retry");
    const procChipX = document.getElementById("procchip-x");

    // Scaffolder picker phase; drives Esc / click-away lock.
    var pickerPhase = "idle";
    // AbortController for the running stream fetch (NOT the job — closing the modal
    // no longer cancels the job; only the chip X button does via POST /api/scaffold/cancel).
    var scaffoldAbort = null;
    // Wave-9: last seq seen in the event log (for ?since= on reattach).
    var lastSeq = -1;
    // Wave-2: all events seen in the current run (for per-layer progress rows).
    var allEvents = [];
    // Wave-9: silence-detection timer handle (>20s with no event and no hb → reattach).
    var silenceTimer = null;
    // Wave-9: reattach attempt counter (for backoff).
    var reattachAttempts = 0;
    // Elapsed timer state.
    var elapsedStart = 0;
    var elapsedInterval = null;

    // — Assistant model dropdown (always wired if we have models) —
    function renderModelSelect(data) {
      var opts = assistantModelOptions(data.assistant);
      if (!opts.length) { modelSelect.hidden = true; return; }
      modelSelect.innerHTML = "";
      for (var i = 0; i < opts.length; i++) {
        var op = document.createElement("option");
        op.value = opts[i].value;
        op.textContent = opts[i].label;
        if (opts[i].selected) op.selected = true;
        modelSelect.appendChild(op);
      }
      modelSelect.hidden = false;
    }
    modelSelect.addEventListener("change", function() {
      var prev = modelSelect.dataset.prev || "";
      modelSelect.dataset.prev = modelSelect.value;
      if (modelNote) { modelNote.hidden = true; modelNote.textContent = ""; }
      fetch("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelSelect.value }),
      }).then(function(r) {
        if (r.ok) {
          chatModel.textContent = modelSelect.value;
          return;
        }
        // 400 = unknown model → revert
        modelSelect.value = prev || modelSelect.options[0].value;
        if (modelNote) {
          modelNote.textContent = "Model not available — reverted.";
          modelNote.hidden = false;
        }
      }).catch(function() {
        modelSelect.value = prev || modelSelect.options[0].value;
        if (modelNote) {
          modelNote.textContent = "Network error — reverted.";
          modelNote.hidden = false;
        }
      });
    });

    // — Picker modal rendering —
    function renderChoices(scaffolder) {
      procChoices.innerHTML = "";
      var rows = scaffolderRadioOptions(scaffolder);
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.isHeader) {
          var hdr = document.createElement("div");
          hdr.className = "procgroup";
          hdr.textContent = row.label;
          procChoices.appendChild(hdr);
          continue;
        }
        var lbl = document.createElement("label");
        lbl.className = "procopt" + (row.disabled ? " disabled" : "");
        var inp = document.createElement("input");
        inp.type = "radio";
        inp.name = "scaffolder";
        inp.value = row.value;
        inp.disabled = row.disabled;
        if (row.checked) inp.checked = true;
        var span = document.createElement("span");
        span.textContent = row.label;
        lbl.appendChild(inp);
        lbl.appendChild(span);
        if (row.hint) {
          var reason = document.createElement("span");
          reason.className = "procreason";
          reason.textContent = row.hint;
          lbl.appendChild(reason);
        }
        procChoices.appendChild(lbl);
      }
    }

    function stopElapsed() {
      if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
      if (procTimer) procTimer.textContent = "";
    }
    function startElapsed() {
      stopElapsed();
      elapsedStart = Date.now();
      if (!procTimer) return;
      function tick() {
        var s = Math.floor((Date.now() - elapsedStart) / 1000);
        var mm = Math.floor(s / 60);
        var ss = s % 60;
        procTimer.textContent = (mm < 10 ? "0" + mm : "" + mm) + ":" + (ss < 10 ? "0" + ss : "" + ss);
      }
      tick();
      elapsedInterval = setInterval(tick, 1000);
    }
    function openProcPicker() {
      procErr.hidden = true;
      procErr.textContent = "";
      procProgress.hidden = true;
      procStages.innerHTML = "";
      procGo.hidden = false;
      procGo.disabled = false;
      procRetry.hidden = true;
      pickerPhase = "idle";
      stopElapsed();
      // Reset spinner visibility for a fresh open.
      var hd = document.getElementById("proc-progress-hd");
      if (hd) hd.hidden = false;
      procWrap.hidden = false;
      // Move focus inside the modal to the first enabled radio or the Start button.
      var firstRadio = procChoices.querySelector("input[name=scaffolder]:not(:disabled)");
      if (firstRadio) { firstRadio.focus(); } else { procGo.focus(); }
    }
    function closeProcPicker() {
      if (!pickerDismissible(pickerPhase)) return; // not dismissible while running or reloading
      // Wave-9: do NOT abort the scaffold stream — closing the picker modal no longer
      // cancels the background job. The reviewer uses the chip X button to cancel.
      stopElapsed();
      procWrap.hidden = true;
      pickerPhase = "idle";
      // Return focus to the trigger button.
      if (procBtn) procBtn.focus();
    }
    function addStage(text, cls) {
      var li = document.createElement("li");
      li.textContent = text;
      if (cls) li.className = cls;
      procStages.appendChild(li);
      procProgress.hidden = false;
      // Scroll the stages wrapper (the element with overflow:auto).
      var wrap = document.getElementById("proc-stages-wrap");
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
    }

    // — Progress chip (topbar): the non-blocking replacement for the modal, live
    //   while a run streams. The reviewer keeps full use of the diff behind it. —
    function showChip(text, mode) {
      if (!procChip) return;
      procChip.classList.remove("done", "err");
      if (mode) procChip.classList.add(mode);
      if (procChipLabel) procChipLabel.textContent = text;
      if (procChipRetry) procChipRetry.hidden = mode !== "err";
      // On terminal error, the ✕ becomes a dismiss; while running it cancels.
      if (procChipX) procChipX.title = mode === "err" ? "Dismiss" : "Cancel processing";
      procChip.hidden = false;
    }
    function hideChip() {
      if (procChip) procChip.hidden = true;
    }

    // — Wave-9 silence detection helpers —
    function clearSilenceTimer() {
      if (silenceTimer !== null) { clearTimeout(silenceTimer); silenceTimer = null; }
    }
    function resetSilenceTimer() {
      clearSilenceTimer();
      // >20s with no event and no hb while phase=running → attempt reattach.
      silenceTimer = setTimeout(function() {
        silenceTimer = null;
        if (pickerPhase !== "running") return;
        startReattach();
      }, 20000);
    }

    // — Wave-9 reattach flow —
    // Called when transport fails or silence timer fires while phase=running.
    // Polls GET /api/scaffold/status then reconnects.
    function startReattach() {
      // Abort the old stream reader if any.
      if (scaffoldAbort) { scaffoldAbort.abort(); scaffoldAbort = null; }
      showChip("Reconnecting…", null);
      pollStatus();
    }

    function pollStatus() {
      if (pickerPhase !== "running") return;
      fetch("/api/scaffold/status", { signal: AbortSignal.timeout(5000) })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (pickerPhase !== "running") return;
          if (!data) {
            // Unreachable.
            var dec2 = reattachDecision("unreachable", reattachAttempts);
            if (dec2.action === "give-up") {
              stopElapsed();
              clearSilenceTimer();
              applyStep(failPhase("lost contact with the server"));
              return;
            }
            reattachAttempts++;
            showChip("Reconnecting…", null);
            setTimeout(pollStatus, dec2.delayMs);
            return;
          }
          reattachAttempts = 0;
          var state = data.state;
          if (state === "idle") {
            // No job running — unexpected; surface as error.
            stopElapsed();
            clearSilenceTimer();
            applyStep(failPhase("lost contact with the server"));
            return;
          }
          // Any known state (running/done/error/cancelled): attach stream to replay.
          attachStream(lastSeq);
        })
        .catch(function() {
          if (pickerPhase !== "running") return;
          var dec3 = reattachDecision("unreachable", reattachAttempts);
          if (dec3.action === "give-up") {
            stopElapsed();
            clearSilenceTimer();
            applyStep(failPhase("lost contact with the server"));
            return;
          }
          reattachAttempts++;
          showChip("Reconnecting…", null);
          setTimeout(pollStatus, dec3.delayMs);
        });
    }

    // Attach (or reattach) to GET /api/scaffold/stream?since=<seq>.
    // Works for both live and finished jobs (finished jobs replay through terminal
    // event then close naturally).
    function attachStream(since) {
      if (scaffoldAbort) { scaffoldAbort.abort(); }
      var ctrl = new AbortController();
      scaffoldAbort = ctrl;
      resetSilenceTimer();

      var url = "/api/scaffold/stream?since=" + since;
      fetch(url, { signal: ctrl.signal })
        .then(function(res) {
          if (!res.ok) {
            if (pickerPhase !== "running") return;
            startReattach();
            return;
          }
          showChip("Processing…", null);
          var reader = res.body.getReader();
          var dec = new TextDecoder();
          var buf = "";
          function pump() {
            return reader.read().then(function(chunk) {
              if (chunk.done) {
                // Flush trailing partial line.
                if (buf.trim()) {
                  var last = parseNdjson(buf + "\\n");
                  last.events.forEach(handleEvent);
                }
                if (pickerPhase === "running") {
                  // Stream closed without terminal event — reattach.
                  startReattach();
                }
                return;
              }
              resetSilenceTimer();
              buf += dec.decode(chunk.value, { stream: true });
              var parsed = parseNdjson(buf);
              buf = parsed.rest;
              parsed.events.forEach(handleEvent);
              if (pickerPhase !== "running") return;
              return pump();
            });
          }
          return pump();
        })
        .catch(function(err) {
          if (err && err.name === "AbortError") return;
          if (pickerPhase !== "running") return;
          startReattach();
        });
    }

    // — POST /api/scaffold: start a new run and stream from seq 0 —
    function runScaffold() {
      var checked = procChoices.querySelector("input[name=scaffolder]:checked");
      if (!checked) return;
      var choice = checked.value;
      procErr.hidden = true;
      procStages.innerHTML = "";
      pickerPhase = "running";
      lastSeq = -1;
      allEvents = [];
      reattachAttempts = 0;
      startElapsed();
      // Hand off from the modal to the non-blocking chip: close the picker (its
      // job — choosing a provider — is done) and surface progress in the topbar so
      // the reviewer can browse the diff while the Scaffolder runs.
      procWrap.hidden = true;
      if (procBtn) procBtn.hidden = true; // no re-trigger while a run is live
      showChip("Processing…", null);

      // Abort any previous stream (but NOT a background job).
      if (scaffoldAbort) { scaffoldAbort.abort(); }
      var ctrl = new AbortController();
      scaffoldAbort = ctrl;
      resetSilenceTimer();

      fetch("/api/scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scaffolder: choice }),
        signal: ctrl.signal,
      }).then(function(res) {
        if (res.status === 409) {
          // Wave-9: a job is already running — attach to it instead of erroring.
          return res.json().catch(function() { return null; }).then(function(j) {
            if (pickerPhase !== "running") return;
            // Attach to the running stream from the beginning.
            attachStream(-1);
          });
        }
        if (!res.ok) {
          return res.json().catch(function() { return null; }).then(function(j) {
            var msg = j && j.error ? j.error : "Request failed (" + res.status + ")";
            stopElapsed();
            clearSilenceTimer();
            applyStep(failPhase(msg));
          });
        }
        // Successful POST: server streams NDJSON from seq 0.
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = "";
        function pump() {
          return reader.read().then(function(chunk) {
            if (chunk.done) {
              // Flush any remaining partial line at stream end.
              if (buf.trim()) {
                var last = parseNdjson(buf + "\\n");
                last.events.forEach(handleEvent);
              }
              if (pickerPhase === "running") {
                // Stream ended without done/error — transport failure; try reattach.
                startReattach();
              }
              return;
            }
            resetSilenceTimer();
            buf += dec.decode(chunk.value, { stream: true });
            var parsed = parseNdjson(buf);
            buf = parsed.rest;
            parsed.events.forEach(handleEvent);
            if (pickerPhase !== "running") return;
            return pump();
          });
        }
        return pump();
      }).catch(function(err) {
        // AbortError means we intentionally aborted (reattach or chip X) — ignore here.
        if (err && err.name === "AbortError") return;
        if (pickerPhase !== "running") return;
        startReattach();
      });
    }

    function renderProgressRows() {
      var rows = scaffoldLayerRows(allEvents);
      var pct = scaffoldProgressPct(allEvents);
      var bar = document.getElementById("procchip-bar-inner");
      if (bar) bar.style.width = pct + "%";
      var rowsEl = document.getElementById("procchip-rows");
      if (!rowsEl) return;
      if (rows.length === 0) { rowsEl.hidden = true; return; }
      rowsEl.hidden = false;
      // Wave-3A: ETA display on the bar label.
      var etaMs = scaffoldEtaMs(allEvents, null);
      var etaEl = document.getElementById("procchip-eta");
      if (etaEl) {
        if (etaMs !== null && etaMs > 0) {
          var etaMins = Math.ceil(etaMs / 60000);
          etaEl.textContent = "~" + etaMins + " min remaining";
          etaEl.hidden = false;
        } else {
          etaEl.hidden = true;
        }
      }
      // Wave-3A: per-row hydration — re-use existing DOM rows keyed by layer id
      // when possible (hydration in place), or rebuild the list when count changed.
      var existingById = {};
      var existingRows = rowsEl.querySelectorAll(".prow[data-layer-id]");
      for (var k = 0; k < existingRows.length; k++) {
        var er = existingRows[k];
        existingById[er.getAttribute("data-layer-id")] = er;
      }
      // If rows count changed or none exist yet, full rebuild.
      var needRebuild = existingRows.length !== rows.length;
      if (needRebuild) {
        rowsEl.innerHTML = "";
      }
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var hydration = layerHydrationState(r);
        if (!needRebuild && existingById[r.id]) {
          // Hydrate in place: update class + indicator + meta only.
          var existing = existingById[r.id];
          existing.className = "prow prow-" + r.status + (hydration === "shimmer" ? " prow-shimmer" : "");
          var existInd = existing.querySelector(".prow-ind");
          if (existInd) existInd.textContent = hydration === "hydrated" ? "✓" : hydration === "shimmer" ? "●" : "○";
          var existMeta = existing.querySelector(".prow-meta");
          if (existMeta) {
            if (hydration === "hydrated") {
              existMeta.textContent = r.findings + (r.findings === 1 ? " finding" : " findings");
              existMeta.className = "prow-meta";
            } else if (hydration === "shimmer") {
              existMeta.textContent = "analyzing…";
              existMeta.className = "prow-meta prow-shimmer-text";
            } else {
              existMeta.textContent = r.regionCount + (r.regionCount === 1 ? " region" : " regions");
              existMeta.className = "prow-meta";
            }
          }
        } else {
          var div = document.createElement("div");
          div.className = "prow prow-" + r.status + (hydration === "shimmer" ? " prow-shimmer" : "");
          div.setAttribute("data-layer-id", r.id);
          var ind = document.createElement("span");
          ind.className = "prow-ind";
          ind.textContent = hydration === "hydrated" ? "✓" : hydration === "shimmer" ? "●" : "○";
          var title = document.createElement("span");
          title.className = "prow-title";
          title.textContent = r.title;
          var meta = document.createElement("span");
          if (hydration === "hydrated") {
            meta.className = "prow-meta";
            meta.textContent = r.findings + (r.findings === 1 ? " finding" : " findings");
          } else if (hydration === "shimmer") {
            meta.className = "prow-meta prow-shimmer-text";
            meta.textContent = "analyzing…";
          } else {
            meta.className = "prow-meta";
            meta.textContent = r.regionCount + (r.regionCount === 1 ? " region" : " regions");
          }
          div.appendChild(ind);
          div.appendChild(title);
          div.appendChild(meta);
          rowsEl.appendChild(div);
        }
      }
    }

    function handleEvent(e) {
      // Wave-2: accumulate all events for per-layer progress.
      allEvents.push(e);
      // Wave-9: track last seq for reattach ?since= parameter.
      if (typeof e.seq === "number") { lastSeq = lastSeqFromEvents([e], lastSeq); }
      var step = nextPhase(pickerPhase, e);
      if (e.event === "stage") {
        var lbl = scaffoldStageLabel(e);
        // Stage progress rides the topbar chip now (the modal is already closed).
        if (lbl) showChip("Processing… " + lbl, null);
      }
      if (e.event === "plan") { renderProgressRows(); }
      // Wave-3A: partial-scaffold arrives after skeleton — render shimmer rows in progress panel.
      if (e.event === "partial-scaffold") { renderProgressRows(); }
      if (e.event === "detail") { renderProgressRows(); }
      if (e.event === "activity" && e.text) {
        var actEl = document.getElementById("procchip-activity");
        if (actEl) { actEl.textContent = e.text; actEl.hidden = false; }
      }
      applyStep(step);
    }

    function applyStep(step) {
      pickerPhase = step.phase;
      if (step.phase === "done") {
        stopElapsed();
        clearSilenceTimer();
        scaffoldAbort = null;
        showChip("✓ Scaffold ready — reloading…", "done");
        // Brief pause so the reviewer sees the message, then reload (approved shape).
        setTimeout(function() { location.reload(); }, 1200);
      } else if (step.phase === "error") {
        stopElapsed();
        clearSilenceTimer();
        scaffoldAbort = null;
        // Surface the real error text on the chip with a Retry that reopens the picker.
        showChip(step.message, "err");
      }
    }

    // — Wave-9: page-load status probe — if a run is active when the page loads,
    // restore the chip and attach to the stream from where we left off (lastSeq=-1
    // since we have no prior seq — replay from beginning). This survives mid-run
    // browser refresh.
    fetch("/api/scaffold/status", { signal: AbortSignal.timeout(3000) })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || data.state !== "running") return;
        // A run is active — surface the chip and attach.
        pickerPhase = "running";
        lastSeq = -1;
        reattachAttempts = 0;
        if (procBtn) procBtn.hidden = true;
        startElapsed();
        showChip("Processing…", null);
        attachStream(-1);
      })
      .catch(function() {}); // silently ignore — just won't auto-reattach on load

    procGo.addEventListener("click", runScaffold);
    procRetry.addEventListener("click", function() {
      procErr.hidden = true;
      procErr.textContent = "";
      procRetry.hidden = true;
      procStages.innerHTML = "";
      procCancel.textContent = "Cancel";
      runScaffold();
    });
    procCancel.addEventListener("click", closeProcPicker);

    // — Progress-chip controls —
    // X : while running -> POST /api/scaffold/cancel (chip shows "Cancelling..." until
    //     the cancelled event arrives); on terminal error -> dismiss the chip.
    if (procChipX) {
      procChipX.addEventListener("click", function() {
        if (pickerPhase === "running") {
          // Wave-9: send cancel request; keep the stream open to receive the
          // cancelled event which will call applyStep and surface "Cancelled." chip.
          showChip("Cancelling…", null);
          fetch("/api/scaffold/cancel", { method: "POST" }).catch(function() {});
          return;
        }
        // Terminal error state — dismiss the chip.
        if (scaffoldAbort) { scaffoldAbort.abort(); scaffoldAbort = null; }
        stopElapsed();
        clearSilenceTimer();
        pickerPhase = "idle";
        hideChip();
        // Re-offer Process PR now that the run is cancelled / dismissed.
        if (procBtn) procBtn.hidden = false;
      });
    }
    // Retry (error only): dismiss the chip and reopen the picker to choose again.
    if (procChipRetry) {
      procChipRetry.addEventListener("click", function() {
        pickerPhase = "idle";
        hideChip();
        if (procBtn) procBtn.hidden = false;
        openProcPicker();
      });
    }

    // Click-away on the backdrop.
    procWrap.addEventListener("click", function(e) {
      if (e.target === procWrap) closeProcPicker();
    });

    // Focus trap: keep Tab cycling inside the modal while it is open.
    procWrap.addEventListener("keydown", function(e) {
      if (e.key !== "Tab" || procWrap.hidden) return;
      var focusable = Array.prototype.slice.call(
        procWrap.querySelectorAll("input:not(:disabled),button:not(:disabled)")
      ).filter(function(el) { return !el.hidden && el.offsetParent !== null; });
      if (!focusable.length) { e.preventDefault(); return; }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      var active = document.activeElement;
      if (e.shiftKey) {
        if (active === first) { e.preventDefault(); last.focus(); }
      } else {
        if (active === last) { e.preventDefault(); first.focus(); }
      }
    });

    // — Process PR button —
    if (procBtn) {
      var scaffoldInfo = h.scaffold;
      var available = scaffoldInfo && scaffoldInfo.available;
      if (processButtonVisible(true, Boolean(available), DATA.layers.length)) {
        procBtn.hidden = false;
      }
      procBtn.addEventListener("click", openProcPicker);
    }

    processApi = {
      // The picker never blocks Esc anymore: while a run streams, the modal is
      // CLOSED and progress rides the non-blocking chip, so Esc must fall through
      // to the normal diff chain (nothing to swallow). Kept for the Esc contract.
      escBlocked: function() { return false; },
      dismiss: function() {
        // Only intercept Esc when the picker modal is actually open (selection
        // phase). The chip owns its own ✕ / Retry; Esc doesn't touch it.
        if (procWrap.hidden) return false;
        closeProcPicker();
        return true;
      },
    };

    // Fetch /api/models — populates the dropdown and the picker choice list.
    fetch("/api/models")
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        renderModelSelect(data);
        // Pre-populate choice list when scaffold is available (needed even if
        // the picker isn't currently open — openProcPicker() re-renders too).
        if (data.scaffolder && data.scaffolder.available) {
          renderChoices(data.scaffolder);
          // Re-wire button visibility with actual scaffolder data (the /api/health
          // scaffold field is the authoritative gate; /api/models may add detail).
          if (procBtn && processButtonVisible(true, true, DATA.layers.length)) {
            procBtn.hidden = false;
          }
        }
      })
      .catch(function() {}); // stay silent; button + dropdown just don't populate
  }

  // ── Diff-line context menu (Wave 8): right-click on a diff row opens a floating
  // menu at the cursor, clamped to the viewport. Items degrade gracefully: Copy
  // path:line is always present; blame/permalink/open-source gate on live + health.
  // The menu is keyboard-navigable (arrows + Enter) and dismisses on Esc (FIRST in
  // the chain, handled above), click-away, scroll, and resize. ──

  // Build the menu DOM from the item list and anchor.
  function openDiffMenu(x, y, anchor) {
    closeDiffMenu(); // close any existing menu first
    const items = menuItems(live !== null, live && live.actions ? live.actions : null);
    const menu = document.createElement("div");
    menu.className = "diffmenu";
    menu.setAttribute("role", "menu");
    const btns = [];
    menu.addEventListener("keydown", function(e) {
      const active = document.activeElement;
      const list = Array.prototype.slice.call(menu.querySelectorAll(".dmitem"));
      let idx = list.indexOf(active);
      if (idx < 0) idx = 0;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        list[(idx + 1) % list.length].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        list[(idx - 1 + list.length) % list.length].focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (active && typeof active.click === "function") active.click();
      }
    });
    items.forEach(function(item, idx) {
      const btn = document.createElement("button");
      btn.className = "dmitem";
      btn.setAttribute("role", "menuitem");
      btn.textContent = item.label;
      btn.dataset.id = item.id;
      btn.tabIndex = idx === 0 ? 0 : -1;
      btn.addEventListener("click", function() {
        handleMenuAction(item.id, anchor, btn);
      });
      btns.push(btn);
      menu.append(btn);
    });
    document.body.append(menu);
    diffMenu = menu;
    // Clamp position to viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x, top = y;
    // Measure after append
    const mw = menu.offsetWidth || 180;
    const mh = menu.offsetHeight || items.length * 36;
    if (left + mw > vw - 8) left = Math.max(8, vw - mw - 8);
    if (top + mh > vh - 8) top = Math.max(8, vh - mh - 8);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    if (btns.length) btns[0].focus();
  }

  // Execute a context menu action.
  function handleMenuAction(id, anchor, btn) {
    if (id === "copy-pathline") {
      const text = formatPathLine(anchor.file, anchor.startLine, anchor.endLine);
      navigator.clipboard.writeText(text).then(function() {
        btn.textContent = "Copied";
        setTimeout(function() { btn.textContent = "Copy path:line"; }, 1200);
        closeDiffMenu();
      }).catch(function() { closeDiffMenu(); });
      return;
    }
    if (id === "copy-permalink") {
      const sha = anchor.side === "LEFT" ? (DATA.pr.baseSha || "") : DATA.pr.headSha;
      const pl = live && live.actions && live.actions.permalink ? live.actions.permalink : "";
      const url = formatPermalink(pl, sha, anchor.file, anchor.startLine, anchor.endLine);
      navigator.clipboard.writeText(url).then(function() {
        btn.textContent = "Copied";
        setTimeout(function() { btn.textContent = "Copy GitHub permalink"; }, 1200);
        closeDiffMenu();
      }).catch(function() { closeDiffMenu(); });
      return;
    }
    if (id === "blame") {
      // Replace button with loading state; morph to blame card on success.
      btn.textContent = "Loading blame…";
      btn.disabled = true;
      const qs = "?file=" + encodeURIComponent(anchor.file) + "&side=" + anchor.side + "&line=" + anchor.startLine;
      fetch("/api/blame" + qs).then(function(r) {
        return r.ok ? r.json() : null;
      }).then(function(info) {
        if (!diffMenu || !btn.isConnected) return;
        if (info) {
          btn.textContent = blameCardText(info);
          // Add a "Copy SHA" sub-action inside the card.
          const copyBtn = document.createElement("button");
          copyBtn.className = "dmitem dmsub";
          copyBtn.textContent = "Copy SHA";
          copyBtn.addEventListener("click", function() {
            navigator.clipboard.writeText(info.sha).then(function() {
              copyBtn.textContent = "Copied";
              setTimeout(function() { if (copyBtn.isConnected) copyBtn.textContent = "Copy SHA"; }, 1200);
            }).catch(function() {});
          });
          btn.insertAdjacentElement("afterend", copyBtn);
        } else {
          btn.textContent = "blame unavailable";
        }
        btn.disabled = false;
      }).catch(function() {
        if (btn.isConnected) { btn.textContent = "blame unavailable"; btn.disabled = false; }
      });
      return;
    }
    if (id === "open-source") {
      btn.disabled = true;
      btn.textContent = "Opening…";
      fetch("/api/open", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: anchor.file, line: anchor.startLine }),
      }).then(function(r) {
        return r.ok ? r.json() : { ok: false };
      }).then(function(d) {
        if (d && d.ok) { closeDiffMenu(); }
        else {
          if (btn.isConnected) { btn.textContent = "couldn't open editor"; btn.disabled = false; }
        }
      }).catch(function() {
        if (btn.isConnected) { btn.textContent = "couldn't open editor"; btn.disabled = false; }
      });
      return;
    }
  }

  // contextmenu on tr.row (skip hunk rows)
  center.addEventListener("contextmenu", function(e) {
    const tr = e.target.closest ? e.target.closest("tr.row") : null;
    if (!tr || tr.classList.contains("hunk")) return; // skip hunk rows
    // Resolve anchor: from data-fi/data-ri
    const fi = tr.dataset.fi !== undefined ? Number(tr.dataset.fi) : null;
    const ri = tr.dataset.ri !== undefined ? Number(tr.dataset.ri) : null;
    if (fi === null || ri === null) return;
    const file = DATA.files[fi] ? DATA.files[fi].path : null;
    if (!file) return;
    const row = DATA.files[fi].rows[ri];
    if (!row) return;
    // If the clicked row is inside the current selection, use the selection range.
    let anchor;
    if (sel && sel.fi === fi) {
      const sRows = selectedRows();
      const inSel = sRows.some(function(x) { return x[1] === ri; });
      if (inSel) {
        anchor = anchorFromSelection(file, sRows.map(function(x) { return x[2]; }));
      }
    }
    if (!anchor) anchor = anchorFromRow(file, row);
    if (!anchor) return;
    e.preventDefault();
    openDiffMenu(e.clientX, e.clientY, anchor);
  });

  // Click-away, scroll, and resize dismiss the context menu.
  document.addEventListener("click", function(e) {
    if (!diffMenu) return;
    if (diffMenu.contains(e.target)) return;
    closeDiffMenu();
  }, { capture: true });
  document.addEventListener("scroll", function() { if (diffMenu) closeDiffMenu(); }, { capture: true, passive: true });
  window.addEventListener("resize", function() { if (diffMenu) closeDiffMenu(); });

  // ── Expandable context (LIVE MODE ONLY, gated on health.context): GitHub-style
  // expanders in the gutter zone at every hunk boundary — above the first hunk,
  // between hunks, and below the last one (the EOF gap, whose size is unknown until
  // a short /api/context response reveals the end of the file). One click fetches up
  // to 20 lines toward the gap: both directions when the gap is large (↓ continues
  // the content above, ↑ backfills before the content below), one combined ↕
  // "expand all" when the gap fits in a click. Expanded lines become REAL context
  // rows: appended to DATA.files[fi].rows so every ri-keyed registry stays valid,
  // display-ordered through rowOrder, numbered on BOTH sides (LEFT = RIGHT + the
  // unchanged region's constant old−new delta from hunkBoundaries), highlighted by
  // the injected highlight.ts functions, and selectable/copyable like any context
  // row. They carry into the split view (the file's split build is invalidated and
  // rebuilt on the next switch); the expander bands themselves live in the unified
  // table only, so split mode simply doesn't show them. initExpanders is the SINGLE
  // entry point (same gating pattern as initLsp/initThreads): in a static artifact
  // no band exists and no /api/context request ever fires. ──
  function initExpanders() {
    const XSTEP = 20; // GitHub's ~20 lines per click

    // Expanded rows change the unified DOM a split build was cloned from: drop the
    // stale build (setSplit lazily rebuilds it, expanded rows included).
    function invalidateSplit(fi) {
      if (!splitCells[fi]) return;
      const card = cardByFi.get(fi);
      const stale = card && card.querySelector("table.diff.split");
      if (stale) stale.remove();
      splitCells[fi] = undefined;
      splitTrs[fi] = undefined;
    }
    function ensureOrder(fi) {
      if (!rowOrder[fi]) rowOrder[fi] = DATA.files[fi].rows.map((r, i) => i);
      return rowOrder[fi];
    }
    function makeCtxRow(fi, n, o, text, lang) {
      const ri = DATA.files[fi].rows.push({ t: "c", o: o, n: n }) - 1;
      const tr = document.createElement("tr");
      tr.className = "row ctx";
      tr.id = "r-" + fi + "-" + ri;
      tr.dataset.fi = fi;
      tr.dataset.ri = ri;
      const gutter = (cls, num, word) => {
        const td = document.createElement("td");
        td.className = "g " + cls;
        td.textContent = num;
        td.tabIndex = 0;
        td.setAttribute("role", "button");
        td.setAttribute("aria-label", "Select " + word + " line " + num);
        return td;
      };
      const code = document.createElement("td");
      code.className = "code";
      code.innerHTML = renderCodeHtml(text, lang, [], "ln-add");
      tr.append(gutter("go", o, "old"), gutter("gn", n, "new"), code);
      return { el: tr, ri: ri };
    }
    function xbtn(glyph, label, fn) {
      const b = document.createElement("button");
      b.className = "xbtn";
      b.textContent = glyph;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.addEventListener("click", fn);
      return b;
    }
    function renderBand(st) {
      const size = st.gapEnd === null ? null : st.gapEnd - st.gapStart + 1;
      if (size !== null && size <= 0) { st.band.remove(); return; }
      st.g.textContent = "";
      if (size !== null && size <= XSTEP) {
        const lbl = "Expand all " + size + " hidden line" + (size === 1 ? "" : "s");
        st.g.append(xbtn("↕", lbl, () => expand(st, "up")));
      } else {
        // Top-of-file gaps only grow upward from the hunk; EOF gaps only downward.
        if (!st.top && st.prevRi !== null) st.g.append(xbtn("↓", "Expand " + XSTEP + " lines down", () => expand(st, "down")));
        if (st.upTr) st.g.append(xbtn("↑", "Expand " + XSTEP + " lines up", () => expand(st, "up")));
      }
      st.msg.textContent = size === null ? "⋯" : "⋯ " + size + " hidden line" + (size === 1 ? "" : "s");
    }
    // A fully-expanded gap merges the hunks (GitHub behavior): the band goes,
    // and so does the @@ hunk-header row the gap sat above. The DATA "h" row
    // stays (every ri-keyed registry remains valid); dropping it from rowOrder
    // keeps it out of split rebuilds and visual-range walks. j/k is unaffected:
    // hunkList holds first CONTENT rows, never header rows.
    function closeGap(st) {
      st.band.remove();
      if (st.hunkRi === null) return; // EOF gap: no header below it
      const header = rowEl(st.fi, st.hunkRi);
      if (header) header.remove();
      const ord = ensureOrder(st.fi);
      const at = ord.indexOf(st.hunkRi);
      if (at !== -1) ord.splice(at, 1);
    }
    async function expand(st, dir) {
      if (st.busy) return;
      st.busy = true;
      const r = expandRange(st.gapStart, st.gapEnd, dir, XSTEP);
      let lines = null;
      try {
        const res = await fetch("/api/context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: DATA.files[st.fi].path, startLine: r.start, endLine: r.end }),
        });
        if (res.ok) {
          const j = await res.json();
          if (j && Array.isArray(j.lines)) lines = j.lines;
        }
      } catch (_) {}
      st.busy = false;
      if (!lines) { st.msg.textContent = "context unavailable"; return; }
      const out = applyExpansion(st.gapStart, st.gapEnd, dir, Boolean(st.upTr), r.start, r.end, lines.length);
      const ord = ensureOrder(st.fi);
      const lang = langForPath(DATA.files[st.fi].path);
      const made = lines.map((ln) => makeCtxRow(st.fi, ln.line, ln.line + st.delta, ln.text, lang));
      if (out.side === "up") {
        // Ascending lines directly ABOVE the hunk-header row: they belong to the
        // gap above the hunk, so they must never render below its @@ header. A
        // later batch carries earlier lines, so it lands above the batches
        // already inserted (st.upRi tracks the topmost up-inserted row; the
        // header itself before any).
        const before = st.upRi === null ? st.upTr : rowEl(st.fi, st.upRi);
        const pos = ord.indexOf(st.upRi === null ? st.hunkRi : st.upRi);
        let at = null;
        made.forEach((m, k) => {
          if (at === null) before.insertAdjacentElement("beforebegin", m.el);
          else at.insertAdjacentElement("afterend", m.el);
          at = m.el;
          ord.splice(pos + k, 0, m.ri);
        });
        if (made.length) st.upRi = made[0].ri;
      } else {
        // Ascending lines directly above the band — after everything already shown
        // from this gap's top (tracked by prevRi).
        for (const m of made) {
          st.band.insertAdjacentElement("beforebegin", m.el);
          ord.splice(ord.indexOf(st.prevRi) + 1, 0, m.ri);
          st.prevRi = m.ri;
        }
      }
      st.gapStart = out.gapStart;
      st.gapEnd = out.gapEnd;
      invalidateSplit(st.fi);
      // Expanded rows can fall inside layer anchors (in-span context): recompute
      // scopes so they stay bright when their layer is scoped.
      DATA.layers.forEach((l, li) => { scopes[li] = scopeOf(l); });
      if (activeLayer >= 0) applyMarks(activeLayer);
      renderSel(); // row heights above a selection changed; the bar follows
      scheduleMarkers(); // expanded rows moved every offset below them
      if (out.closed) closeGap(st);
      else renderBand(st);
    }

    for (const card of cards) {
      const fi = Number(card.dataset.fi);
      const table = card.querySelector(".fbody table.diff:not(.split)");
      if (!table) continue;
      const tbody = table.querySelector("tbody");
      for (const b of hunkBoundaries(DATA.files[fi].rows)) {
        const band = document.createElement("tr");
        band.className = "xrow";
        const g = document.createElement("td");
        g.className = "g xg";
        g.colSpan = 2;
        const msg = document.createElement("td");
        msg.className = "xmsg";
        band.append(g, msg);
        let upTr = null;
        if (b.hunkRi !== null) {
          upTr = rowEl(fi, b.hunkRi);
          if (!upTr) continue;
          upTr.insertAdjacentElement("beforebegin", band);
        } else {
          tbody.append(band);
        }
        // The last displayed row above the band (down-expansions insert after it,
        // in rowOrder terms; the DOM inserts before the band itself).
        let prevRi = null;
        for (let p = band.previousElementSibling; p; p = p.previousElementSibling) {
          if (p.dataset.ri !== undefined) { prevRi = Number(p.dataset.ri); break; }
        }
        renderBand({
          fi: fi, hunkRi: b.hunkRi, gapStart: b.gapStart, gapEnd: b.gapEnd,
          delta: b.delta, band: band, g: g, msg: msg, upTr: upTr, prevRi: prevRi,
          upRi: null, top: b.hunkRi !== null && b.gapStart === 1, busy: false,
        });
      }
    }
  }

  // ── Files init: restore viewed + collapse prefs + view mode, seed progress. ──
  // Initial collapse precedence per card: explicit user pref (collapsePref) >
  // viewed auto-collapse > the highest-risk default — on a fresh load only files
  // hosting an anchor of the highest-risk layer (DATA.risk, computed at render
  // time) start expanded. Large files keep their Load-diff guard either way
  // unless the user pref says expanded.
  const riskLi = typeof DATA.risk === "number" ? DATA.risk : -1;
  const riskFiles = new Set();
  if (riskLi >= 0) {
    for (const a of DATA.layers[riskLi].anchors) {
      const rfi = fileIndex.get(a.file);
      if (rfi !== undefined) riskFiles.add(rfi);
    }
  }
  for (const c of cards) {
    const fi = Number(c.dataset.fi);
    syncViewedUi(fi);
    const pref = collapsePref[DATA.files[fi].path];
    if (pref !== undefined) setCardCollapsed(c, pref === 1);
    else if (isViewed(fi)) setCardCollapsed(c, true);
    else if (riskLi >= 0 && !c.classList.contains("large")) setCardCollapsed(c, !riskFiles.has(fi));
  }
  updateProgress();
  refreshCollapseAll();
  updateKeyhint();
  if (cards.length) setActiveFile(Number(cards[0].dataset.fi));
  if (persist.get("sleek:viewmode") === "split") setSplit(true);
  if (persist.get("sleek:wrap") === "1") setWrap(true);

  // ── Initial state: layer 0 selected (rail + bundle) but nothing dimmed ──
  if (DATA.layers.length) softActivate(0);
  else { showBundle("all"); updateShowAll(); }
  scheduleMarkers(); // initial scrollbar thread markers (collapse state settled)
})();`;
