/**
 * Tests for renderReviewHtml (src/render/html.ts) covering the lazy-large-file
 * mode introduced in Slice P and the page-level row budget added in Slice 10B.
 *
 * Slice P invariants:
 *   Small PRs (no large files) render identically regardless of lazyLargeFiles.
 *   Large unanchored files are omitted from initial HTML when lazyLargeFiles=true.
 *   Anchored large files are always embedded even in lazy mode.
 *
 * Slice 10B invariants:
 *   Many small/medium files respect the page-level row budget in lazy mode.
 *   Finding-anchored files are always embedded and charged against the budget first.
 *   SLEEK_EMBED_ROW_BUDGET env overrides the default budget.
 *   lazyLargeFiles=false (non-lazy) renders byte-identically to today — budget irrelevant.
 */

import { afterEach, describe, expect, it } from "vitest";
import { renderReviewHtml, renderFileRowsHtml, fmtLines } from "./html.ts";
import { parseUnifiedDiff } from "./diffmodel.ts";
import { wsOnlyRows } from "./whitespace.ts";
import { makeAnchor, makeLayer, makeScaffold } from "../assistant/fixtures.ts";

// A small diff (< LARGE_FILE_ROWS = 400 rows): 3 context lines + 1 del + 1 add
const SMALL_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 0000000..1111111 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

/**
 * Build a synthetic diff with `n` rows (1 hunk header + n content rows)
 * so the file is treated as large (> 400 rows).
 */
function makeLargeDiff(path: string, rows: number): string {
  const dels = Array.from({ length: rows }, (_, i) => `-line${i + 1}`).join("\n");
  const adds = Array.from({ length: rows }, (_, i) => `+line${i + 1}b`).join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "index 0000000..1111111 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${rows} +1,${rows} @@`,
    dels,
    adds,
  ].join("\n") + "\n";
}

const LARGE_DIFF = makeLargeDiff("src/big.ts", 401);
const emptyScaffold = makeScaffold([]);

/** Extract just the #center main HTML from a full renderReviewHtml output. */
function extractCenter(html: string): string {
  const m = /<main id="center">([\s\S]*?)<\/main>/m.exec(html);
  return m ? m[1] : html;
}

describe("renderReviewHtml — lazy large-file mode", () => {
  it("renders GitHub refresh and a PR Comments side tab, not the old Conversation tab", () => {
    const html = renderReviewHtml(emptyScaffold, SMALL_DIFF, {}, undefined);

    expect(html).toContain('id="gh-refresh" hidden');
    expect(html).toContain('id="side-pr-comments"');
    expect(html).toContain('data-side-tab="prcomments"');
    expect(html).not.toContain('id="side-conversation"');
    expect(html).not.toContain('data-side-tab="conversation"');
  });

  it("small files render identically with and without lazyLargeFiles", () => {
    const scaffold = emptyScaffold;
    const html = renderReviewHtml(scaffold, SMALL_DIFF, {}, undefined);
    const htmlLazy = renderReviewHtml(scaffold, SMALL_DIFF, {}, undefined, { lazyLargeFiles: true });
    // Both should contain the diff table (small file is always embedded)
    const center = extractCenter(html);
    const centerLazy = extractCenter(htmlLazy);
    expect(center).toContain("<table");
    expect(centerLazy).toContain("<table");
    // No lazy marker on small files' card markup
    expect(centerLazy).not.toContain('data-lazy="1"');
  });

  it("large unanchored files are NOT embedded when lazyLargeFiles=true", () => {
    const scaffold = emptyScaffold;
    const htmlLazy = renderReviewHtml(scaffold, LARGE_DIFF, {}, undefined, { lazyLargeFiles: true });
    const center = extractCenter(htmlLazy);
    // The large file's rows should NOT be in the center HTML
    expect(center).not.toContain("row del");
    expect(center).not.toContain("row add");
    // But the "Load diff" button with data-lazy should be present in the card
    expect(center).toContain('data-lazy="1"');
    expect(center).toContain("Load diff");
  });

  it("large unanchored files ARE embedded when lazyLargeFiles=false (default)", () => {
    const scaffold = emptyScaffold;
    const html = renderReviewHtml(scaffold, LARGE_DIFF, {}, undefined);
    const center = extractCenter(html);
    // Default: rows are embedded
    expect(center).toContain("row del");
    // No lazy marker
    expect(center).not.toContain('data-lazy="1"');
  });

  it("large files with an inline Finding anchor are always embedded even in lazy mode", () => {
    const layer = makeLayer({
      anchors: [makeAnchor({ file: "src/big.ts", side: "RIGHT", startLine: 1, endLine: 5 })],
      findings: [
        {
          anchor: { file: "src/big.ts", side: "RIGHT", startLine: 1, endLine: 5 },
          concern: "correctness",
          severity: "major",
          text: "This is a finding.",
        },
      ],
    });
    const scaffold = makeScaffold([layer]);
    const htmlLazy = renderReviewHtml(scaffold, LARGE_DIFF, {}, undefined, { lazyLargeFiles: true });
    const center = extractCenter(htmlLazy);
    // Anchored file must be embedded even in lazy mode
    expect(center).toContain("row del");
    // No lazy marker on this file
    expect(center).not.toContain('data-lazy="1"');
  });
});

// ── Helpers for 10B budget tests ─────────────────────────────────────────────

/**
 * Build a multi-file unified diff where each file has `contentLinesPerSide` del +
 * add lines (plus 1 hunk header row). Total rows per file = 2*contentLinesPerSide + 1.
 * Files are named src/file0.ts … src/file<n-1>.ts.
 * Keep contentLinesPerSide ≤ 199 to stay below the LARGE_FILE_ROWS=400 threshold.
 */
function makeMultiFileDiff(fileCount: number, contentLinesPerSide: number): string {
  const parts: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    const path = `src/file${i}.ts`;
    const dels = Array.from({ length: contentLinesPerSide }, (_, r) => `-line${r + 1}`).join("\n");
    const adds = Array.from({ length: contentLinesPerSide }, (_, r) => `+line${r + 1}b`).join("\n");
    parts.push(
      [`diff --git a/${path} b/${path}`,
        "index 0000000..1111111 100644",
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -1,${contentLinesPerSide} +1,${contentLinesPerSide} @@`,
        dels,
        adds,
      ].join("\n"),
    );
  }
  return parts.join("\n") + "\n";
}

/**
 * Count how many files in the rendered HTML have an embedded diff table
 * (non-lazy body) vs. a lazy placeholder.
 */
function countEmbeddedVsLazy(html: string): { embedded: number; lazy: number } {
  const center = (() => {
    const m = /<main id="center">([\s\S]*?)<\/main>/m.exec(html);
    return m ? m[1] : html;
  })();
  // Each filecard section either has data-lazy="1" on its loaddiff button (lazy)
  // or contains an actual <table> (embedded). Count sections.
  const sections = center.split('<section class="filecard');
  let embedded = 0;
  let lazy = 0;
  for (const sec of sections.slice(1)) {
    if (sec.includes('data-lazy="1"')) {
      lazy++;
    } else if (sec.includes("<table")) {
      embedded++;
    }
    // A file with no rows has a nodiff paragraph — counts as embedded.
    else if (sec.includes("nodiff")) {
      embedded++;
    }
  }
  return { embedded, lazy };
}

describe("renderReviewHtml — page-level row budget (10B)", () => {
  afterEach(() => {
    // Restore any env overrides to avoid test pollution.
    delete process.env["SLEEK_EMBED_ROW_BUDGET"];
  });

  it("many small files: embedded rows stay within budget in lazy mode", () => {
    // Each file: 100 del + 100 add + 1 hunk header = 201 rows. Not large (< 400).
    // Default budget = 5000. floor(5000 / 201) = 24 files fit exactly before
    // the 25th would push the total to 24*201 + 201 = 5025 > 5000 → lazy.
    // With 30 files: 24 embedded, 6 lazy.
    const fileCount = 30;
    const contentLinesPerSide = 100; // 2*100+1 = 201 rows, well below LARGE_FILE_ROWS
    const diff = makeMultiFileDiff(fileCount, contentLinesPerSide);
    const html = renderReviewHtml(emptyScaffold, diff, {}, undefined, { lazyLargeFiles: true });
    const { embedded, lazy } = countEmbeddedVsLazy(html);
    // 24 * 201 = 4824 ≤ 5000; 25th would add 201 → 5025 > 5000 → lazy
    expect(embedded).toBe(24);
    expect(lazy).toBe(6);
  });

  it("non-lazy mode: static renders are byte-identical regardless of budget", () => {
    // 30 files × 201 rows each = 6030 rows total, which exceeds the default
    // budget 5000 — but budget must be ignored when lazyLargeFiles is off.
    const diff = makeMultiFileDiff(30, 100);
    // Default (no lazy):
    const html1 = renderReviewHtml(emptyScaffold, diff, {}, undefined);
    // Explicitly false:
    const html2 = renderReviewHtml(emptyScaffold, diff, {}, undefined, { lazyLargeFiles: false });
    // With a tiny budget (should be ignored in non-lazy mode):
    process.env["SLEEK_EMBED_ROW_BUDGET"] = "1";
    const html3 = renderReviewHtml(emptyScaffold, diff, {}, undefined);
    delete process.env["SLEEK_EMBED_ROW_BUDGET"];
    // All three are identical — non-lazy always embeds everything.
    expect(html1).toBe(html2);
    expect(html1).toBe(html3);
    const { embedded, lazy } = countEmbeddedVsLazy(html1);
    expect(lazy).toBe(0);
    expect(embedded).toBe(30);
  });

  it("finding-anchored files are always embedded and charged first against budget", () => {
    // Anchored file: 100 del + 100 add + 1 hunk = 201 rows (not large). Always embedded.
    // Plain files: 50 del + 50 add + 1 hunk = 101 rows each. Not large.
    // Budget: 350 rows.
    // Budget pre-charged with anchored: 350 - 201 = 149 remaining.
    // file0 (plain, 101 rows): 0 + 101 = 101 ≤ 149 remaining → embed. remaining = 48.
    // file1 (plain, 101 rows): 101 + 101 = 202 (embeddedRows after anchored+file0)
    //   → embeddedRows(201+101=302) + 101 = 403 > 350 → lazy.
    // file2, file3: also lazy.
    // Total: anchored(1) + file0(1) = 2 embedded; file1..file3 = 3 lazy.
    const anchoredPath = "src/anchored.ts";
    const anchoredContentLines = 100; // 201 rows total
    const plainContentLines = 50; // 101 rows total
    const anchoredDels = Array.from({ length: anchoredContentLines }, (_, r) => `-line${r + 1}`).join("\n");
    const anchoredAdds = Array.from({ length: anchoredContentLines }, (_, r) => `+line${r + 1}b`).join("\n");
    const anchoredFileDiff = [
      `diff --git a/${anchoredPath} b/${anchoredPath}`,
      "index 0000000..1111111 100644",
      `--- a/${anchoredPath}`,
      `+++ b/${anchoredPath}`,
      `@@ -1,${anchoredContentLines} +1,${anchoredContentLines} @@`,
      anchoredDels,
      anchoredAdds,
    ].join("\n");
    const plainDiff = makeMultiFileDiff(4, plainContentLines);
    const diff = anchoredFileDiff + "\n" + plainDiff;

    // Budget just enough for anchored (201) + one plain (101) = 302.
    // Use 350 so anchored(201) is pre-charged, remaining=149 ≥ 101 for file0.
    process.env["SLEEK_EMBED_ROW_BUDGET"] = "350";

    const layer = makeLayer({
      anchors: [makeAnchor({ file: anchoredPath, side: "RIGHT", startLine: 1, endLine: 5 })],
      findings: [
        {
          anchor: { file: anchoredPath, side: "RIGHT", startLine: 1, endLine: 5 },
          concern: "correctness",
          severity: "major",
          text: "Finding on anchored file.",
        },
      ],
    });
    const scaffold = makeScaffold([layer]);
    const html = renderReviewHtml(scaffold, diff, {}, undefined, { lazyLargeFiles: true });
    const { embedded, lazy } = countEmbeddedVsLazy(html);

    expect(embedded).toBe(2);
    expect(lazy).toBe(3);

    // The anchored file must appear embedded (has diff rows, not data-lazy).
    const center = (() => {
      const m = /<main id="center">([\s\S]*?)<\/main>/m.exec(html);
      return m ? m[1] : html;
    })();
    const anchoredIdx = center.indexOf(anchoredPath);
    expect(anchoredIdx).toBeGreaterThan(-1);
    const fromAnchor = center.slice(Math.max(0, anchoredIdx - 500), anchoredIdx + 500);
    expect(fromAnchor).toContain("<table");
    expect(fromAnchor).not.toContain('data-lazy="1"');
  });

  it("SLEEK_EMBED_ROW_BUDGET env overrides the default budget", () => {
    // Each file: 40 del + 40 add + 1 hunk = 81 rows per file. Not large.
    // Budget = 200:
    //   file0: 0+81=81 ≤ 200 → embed. embeddedRows=81.
    //   file1: 81+81=162 ≤ 200 → embed. embeddedRows=162.
    //   file2: 162+81=243 > 200 → lazy.
    //   file3: lazy.
    process.env["SLEEK_EMBED_ROW_BUDGET"] = "200";
    const diff = makeMultiFileDiff(4, 40);
    const html = renderReviewHtml(emptyScaffold, diff, {}, undefined, { lazyLargeFiles: true });
    const { embedded, lazy } = countEmbeddedVsLazy(html);
    expect(embedded).toBe(2);
    expect(lazy).toBe(2);
  });
});

describe("renderFileRowsHtml", () => {
  it("returns a table with del and add rows for a small diff", () => {
    const files = parseUnifiedDiff(SMALL_DIFF);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    const ws = wsOnlyRows(f.rows);
    const html = renderFileRowsHtml(0, f, ws);
    expect(html).toContain("<table");
    expect(html).toContain("class=\"row del");
    expect(html).toContain("class=\"row add");
  });

  it("assigns the correct fi index in row ids", () => {
    const files = parseUnifiedDiff(SMALL_DIFF);
    const f = files[0]!;
    const ws = wsOnlyRows(f.rows);
    const html7 = renderFileRowsHtml(7, f, ws);
    // Row ids should use fi=7
    expect(html7).toContain('id="r-7-');
    expect(html7).not.toContain('id="r-0-');
  });

  it("returns nodiff paragraph for a file with no rows", () => {
    const files = parseUnifiedDiff(SMALL_DIFF);
    const f = files[0]!;
    const emptyFile = { ...f, rows: [] as typeof f.rows };
    const ws = wsOnlyRows(emptyFile.rows);
    const html = renderFileRowsHtml(0, emptyFile, ws);
    expect(html).toContain("nodiff");
    expect(html).not.toContain("<table");
  });
});

// changeBarWidth and the change-bar feature were removed in the IDE restyle (brief v2).

describe("file-tree markup (IDE restyle)", () => {
  // Two sibling dirs sharing a long common prefix + a nested file, so the tree has
  // chain-collapsed dir nodes to exercise the head/tail split, icons, and rollups.
  const TREE_DIFF = [
    SMALL_DIFF.trim(),
    makeLargeDiff("pkg/rocket-viewer-model/src/a.ts", 2).trim(),
    makeLargeDiff("pkg/rocket-viewer-model-vsm/src/b.ts", 2).trim(),
    makeLargeDiff("pkg/rocket-viewer-model-vsm/src/deep/c.ts", 2).trim(),
  ].join("\n") + "\n";

  function treeHtmlOf(withFinding: boolean): string {
    const layers = withFinding
      ? [
          makeLayer({
            anchors: [makeAnchor({ file: "pkg/rocket-viewer-model/src/a.ts", startLine: 1, endLine: 2 })],
            findings: [
              {
                anchor: makeAnchor({ file: "pkg/rocket-viewer-model/src/a.ts", startLine: 1, endLine: 2 }),
                concern: "correctness",
                severity: "major",
                text: "x",
              },
            ],
          }),
        ]
      : [];
    const scaffold = makeScaffold(layers as never);
    const html = renderReviewHtml(scaffold, TREE_DIFF, {}, undefined);
    const m = /<ul class="ftree">([\s\S]*?)<\/ul>\s*<p class="keyhint"/.exec(html);
    return m ? m[0] : html;
  }

  it("splits dir labels into head (prefix) + tail (last segment), no folder glyph text", () => {
    const html = treeHtmlOf(false);
    expect(html).toContain('class="tdhead"');
    expect(html).toContain('class="tdtail"');
    expect(html).toContain('<span class="tdtail tdsolo"><bdi>src</bdi></span>');
    expect(html).toMatch(
      /<span class="tdname"><span class="tdhead"><bdi>[^<]+\/<\/bdi><\/span><span class="tdtail">[^<]+<\/span><\/span>/,
    );
    // Only chevron + dir icon (SVG); the old text .tfolder glyph is gone.
    expect(html).not.toContain("tfolder");
    expect(html).toContain('class="tarrow"');
    expect(html).toContain('class="dicon"');
    // The distinguishing suffix segment is preserved verbatim in a tail span.
    expect(html).toContain(">src</span>");
  });

  it("emits per-file icons (ficon) and no change bars or badge chips", () => {
    const html = treeHtmlOf(false);
    // File icon present, lang class on it
    expect(html).toMatch(/class="ficon lang-ts"/);
    // No change-bar elements
    expect(html).not.toContain('class="cbar"');
    expect(html).not.toContain('class="tfnums"');
    // No old badge chips
    expect(html).not.toContain('class="fbadge');
    expect(html).not.toContain('class="dagn"');
  });

  it("emits status letters (M/A/D) on file rows", () => {
    const html = treeHtmlOf(false);
    // modified files get a tfstat.st-modified "M"
    expect(html).toMatch(/class="tfstat st-modified"[^>]*>M<\/span>/);
  });

  it("emits collapsed-only dir rollups (.dagg) with no file-count span", () => {
    const html = treeHtmlOf(false);
    expect(html).toContain('class="dagg"');
    // .dagn (file count text) should be gone
    expect(html).not.toContain('class="dagn"');
  });

  it("shows a plain amber findings count on a dir when a descendant has findings", () => {
    const html = treeHtmlOf(true);
    // .ffind element inside .dagg for the dir with findings
    expect(html).toMatch(/class="dagg"[\s\S]*?class="ffind"/);
    // no pill border/background markup (plain number, no border= attrs in CSS)
  });

  it("gives each file row a viewed ✓ hook (.tfck) and a title with +N −N", () => {
    const html = treeHtmlOf(false);
    expect(html).toContain('class="tfck"');
    expect(html).toMatch(/title="[^"]*· \+\d+ −\d+"/);
  });
});

describe("fmtLines (compact changed-line count display)", () => {
  it("formats small counts with locale separators", () => {
    expect(fmtLines(0)).toBe("0 lines");
    expect(fmtLines(1)).toBe("1 lines");
    expect(fmtLines(1246)).toBe("1,246 lines");
    expect(fmtLines(9999)).toBe("9,999 lines");
  });

  it("formats 10k+ with one decimal and k suffix", () => {
    expect(fmtLines(10000)).toBe("10.0k lines");
    expect(fmtLines(178367)).toBe("178.4k lines");
    expect(fmtLines(50000)).toBe("50.0k lines");
    expect(fmtLines(100000)).toBe("100.0k lines");
  });

  it("rounds correctly at the boundary", () => {
    // 10,000 → 10.0k
    expect(fmtLines(10000)).toBe("10.0k lines");
    // 9,999 stays locale-formatted
    expect(fmtLines(9999)).toBe("9,999 lines");
    // 10,049 → Math.round(10049/100)/10 = Math.round(100.49)/10 = 100/10 = 10.0k
    expect(fmtLines(10049)).toBe("10.0k lines");
    // 10,050 → Math.round(10050/100)/10 = Math.round(100.5)/10 = 101/10 = 10.1k
    expect(fmtLines(10050)).toBe("10.1k lines");
  });
});

describe("layer card slug suppression", () => {
  it("suppresses .lfile when title equals the layer id (no authored title)", () => {
    const html = renderReviewHtml(
      makeScaffold([makeLayer({ id: "my-layer-id" })]),
      SMALL_DIFF,
      { "other-layer": "Other Layer" },
      undefined,
    );
    // No authored title for "my-layer-id" → title() falls back to l.id → slug suppressed.
    const m = /<button class="layerbtn"[\s\S]*?<\/button>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain('class="lfile"');
  });

  it("shows .lfile when an authored title differs from the id", () => {
    const html = renderReviewHtml(
      makeScaffold([makeLayer({ id: "my-layer-id" })]),
      SMALL_DIFF,
      { "my-layer-id": "My Authored Title" },
      undefined,
    );
    // Authored title differs from id → slug should appear.
    expect(html).toContain('class="lfile"');
    expect(html).toContain("my-layer-id");
  });

  it("suppresses .lfile when layer.id is __uncovered__ (even with different title)", () => {
    const html = renderReviewHtml(
      makeScaffold([makeLayer({ id: "__uncovered__" })]),
      SMALL_DIFF,
      {},
      undefined,
    );

    const layerCard = /<button class="layerbtn"[\s\S]*?<\/button>/.exec(html);
    expect(layerCard).not.toBeNull();
    expect(layerCard![0]).toContain("Uncovered changes");
    expect(layerCard![0]).not.toContain('class="lfile"');

    const bundlePanel = /<div class="bundle" data-li="0">[\s\S]*?<\/div>/.exec(html);
    expect(bundlePanel).not.toBeNull();
    expect(bundlePanel![0]).toContain("Uncovered changes");
    expect(bundlePanel![0]).not.toContain('class="bfile"');
  });
});

describe("right panel related code refs", () => {
  it("renders neighbor refs with flex layout protecting the #symbol", () => {
    const html = renderReviewHtml(
      makeScaffold([
        makeLayer({
          bundle: {
            summary: "Touches site assets.",
            neighbors: [
              {
                ref: "packages/rocket-core/src/siteAssets#symbol",
                signature: "function symbol()",
                oneLine: "symbol used by the changed lines",
              },
            ],
            history: [],
            learnings: [],
          },
        }),
      ]),
      SMALL_DIFF,
      {},
      undefined,
    );

    const nref = /<span class="nref">[\s\S]*?<\/span><\/span>/.exec(html);
    expect(nref).not.toBeNull();
    expect(nref![0]).toContain('<span class="npath">packages/rocket-core/src/siteAssets</span>');
    expect(nref![0]).toContain('<span class="nsym">#symbol</span>');
    expect(html).toContain(".nref{display:flex;align-items:baseline;min-width:0;");
    expect(html).toContain(".npath{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
    expect(html).toContain(".nsym{flex:0 0 auto;white-space:nowrap;");
  });
});
