import { describe, expect, it } from "vitest";

import {
  anchorLabel,
  exportPreviewLabel,
  firstLineSummary,
  splitSuggestionBlocks,
  suggestionHtml,
  threadRowIndex,
  verdictLabel,
} from "./threadsui.ts";

describe("splitSuggestionBlocks", () => {
  it("returns a single md segment for a body without suggestions", () => {
    expect(splitSuggestionBlocks("plain **markdown** text")).toEqual([
      { kind: "md", text: "plain **markdown** text" },
    ]);
  });

  it("extracts a suggestion block between md segments", () => {
    expect(splitSuggestionBlocks("before\n```suggestion\nnew line\n```\nafter")).toEqual([
      { kind: "md", text: "before" },
      { kind: "suggestion", text: "new line" },
      { kind: "md", text: "after" },
    ]);
  });

  it("keeps multi-line suggestion content intact", () => {
    expect(splitSuggestionBlocks("```suggestion\na\nb\n```")).toEqual([
      { kind: "suggestion", text: "a\nb" },
    ]);
  });

  it("runs an unclosed suggestion fence to end of input", () => {
    expect(splitSuggestionBlocks("```suggestion\nonly")).toEqual([
      { kind: "suggestion", text: "only" },
    ]);
  });

  it("yields an empty suggestion (a deletion) for an empty fence", () => {
    expect(splitSuggestionBlocks("```suggestion\n```")).toEqual([
      { kind: "suggestion", text: "" },
    ]);
  });

  it("leaves regular fences (and a ```suggestion line inside one) as markdown", () => {
    expect(splitSuggestionBlocks("```ts\n```suggestion\nx\n```\ntail")).toEqual([
      { kind: "md", text: "```ts\n```suggestion\nx\n```\ntail" },
    ]);
  });

  it("normalizes CRLF line endings", () => {
    expect(splitSuggestionBlocks("a\r\n```suggestion\r\nb\r\n```")).toEqual([
      { kind: "md", text: "a" },
      { kind: "suggestion", text: "b" },
    ]);
  });
});

describe("suggestionHtml", () => {
  it("renders current lines as removed and suggestion lines as added", () => {
    const html = suggestionHtml(["old line"], "new line");
    expect(html).toBe(
      '<div class="sugg"><div class="sughd">Suggested change</div><pre><code>' +
        '<span class="sline sdel">old line</span><span class="sline sadd">new line</span>' +
        "</code></pre></div>",
    );
  });

  it("escapes HTML on both sides (escape-first posture)", () => {
    const html = suggestionHtml(['<img src=x onerror="a">'], "a < b && c");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;a&quot;&gt;");
    expect(html).toContain("a &lt; b &amp;&amp; c");
  });

  it("renders an empty suggestion as a pure deletion", () => {
    const html = suggestionHtml(["gone"], "");
    expect(html).toContain('class="sline sdel"');
    expect(html).not.toContain("sadd");
  });

  it("renders empty current lines as a pure addition", () => {
    const html = suggestionHtml([], "added");
    expect(html).toContain('class="sline sadd"');
    expect(html).not.toContain("sdel");
  });

  it("keeps +/- markers out of the text (CSS ::before, clean copy)", () => {
    const html = suggestionHtml(["a"], "b");
    expect(html).not.toContain(">-a<");
    expect(html).not.toContain(">+b<");
  });

  it("renders lines through the injected highlighter (escaped output goes in as-is)", () => {
    const hl = (t: string): string =>
      '<span class="tok-kw">' + t.replace(/</g, "&lt;") + "</span>";
    const html = suggestionHtml(["const a"], "const b", hl);
    expect(html).toContain('<span class="sline sdel"><span class="tok-kw">const a</span></span>');
    expect(html).toContain('<span class="sline sadd"><span class="tok-kw">const b</span></span>');
    // Without a highlighter the plain-escape behavior is unchanged.
    expect(suggestionHtml(["a<b"], "")).toContain(">a&lt;b<");
  });
});

describe("threadRowIndex", () => {
  // Compact DATA rows: hunk, ctx 1/1, del 2, add 2, add 3, ctx 3/4.
  const rows = [
    { t: "h", o: null, n: null },
    { t: "c", o: 1, n: 1 },
    { t: "d", o: 2, n: null },
    { t: "a", o: null, n: 2 },
    { t: "a", o: null, n: 3 },
    { t: "c", o: 3, n: 4 },
  ];

  it("returns the LAST covered row for a RIGHT anchor over adds", () => {
    expect(threadRowIndex(rows, { side: "RIGHT", startLine: 2, endLine: 3 })).toBe(4);
  });

  it("returns the del row for a LEFT anchor", () => {
    expect(threadRowIndex(rows, { side: "LEFT", startLine: 2, endLine: 2 })).toBe(2);
  });

  it("falls back to the in-range context row for anchors on unchanged lines", () => {
    expect(threadRowIndex(rows, { side: "RIGHT", startLine: 4, endLine: 4 })).toBe(5);
  });

  it("falls back to the file's last row when nothing is in range", () => {
    expect(threadRowIndex(rows, { side: "RIGHT", startLine: 99, endLine: 99 })).toBe(5);
  });

  it("returns -1 for an empty file", () => {
    expect(threadRowIndex([], { side: "RIGHT", startLine: 1, endLine: 1 })).toBe(-1);
  });
});

describe("firstLineSummary", () => {
  it("returns the first non-empty line", () => {
    expect(firstLineSummary("\n\nThe gist.\nMore detail.")).toBe("The gist.");
  });

  it("strips heading, quote and list markers", () => {
    expect(firstLineSummary("## Heading first")).toBe("Heading first");
    expect(firstLineSummary("> quoted")).toBe("quoted");
    expect(firstLineSummary("- item")).toBe("item");
    expect(firstLineSummary("1. item")).toBe("item");
  });

  it("skips fence lines", () => {
    expect(firstLineSummary("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("truncates long lines to ~80 chars with an ellipsis", () => {
    const long = "x".repeat(120);
    const out = firstLineSummary(long);
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back for an all-blank body", () => {
    expect(firstLineSummary("  \n\n")).toBe("(no text)");
  });
});

describe("anchorLabel", () => {
  it("labels a single new-side line with the file basename", () => {
    expect(anchorLabel({ file: "src/a/b.ts", side: "RIGHT", startLine: 12, endLine: 12 })).toBe(
      "b.ts:12 (new)",
    );
  });

  it("labels a range and the old side", () => {
    expect(anchorLabel({ file: "b.ts", side: "LEFT", startLine: 3, endLine: 7 })).toBe(
      "b.ts:3–7 (old)",
    );
  });
});

describe("verdictLabel", () => {
  it("maps every ReviewVerdict to its UI wording", () => {
    expect(verdictLabel("approve")).toBe("Approved");
    expect(verdictLabel("request_changes")).toBe("Changes requested");
    expect(verdictLabel("comment")).toBe("Commented");
  });
});

describe("exportPreviewLabel", () => {
  it("describes a summary-only export", () => {
    expect(exportPreviewLabel({ commentCount: 0, files: [], hasSummary: true })).toBe(
      "Summary only — no inline comments",
    );
  });

  it("describes a fully empty export", () => {
    expect(exportPreviewLabel({ commentCount: 0, files: [], hasSummary: false })).toBe(
      "No inline comments and no summary",
    );
  });

  it("pluralizes comments and files", () => {
    expect(
      exportPreviewLabel({ commentCount: 1, files: ["a.ts"], hasSummary: false }),
    ).toBe("1 inline comment across 1 file");
    expect(
      exportPreviewLabel({ commentCount: 3, files: ["a.ts", "b.ts"], hasSummary: true }),
    ).toBe("3 inline comments across 2 files, plus a summary");
  });
});
