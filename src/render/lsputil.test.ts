import { describe, expect, it } from "vitest";

import type { NodeLike } from "./lsputil.ts";
import { diagRowIndex, lspLangLabel, textOffsetWithin } from "./lsputil.ts";

// ── mock DOM helpers (nodeType 3 = text) ────────────────────────────────────────────────

const text = (s: string): NodeLike => ({ nodeType: 3, nodeValue: s });
const el = (...childNodes: NodeLike[]): NodeLike => ({ nodeType: 1, childNodes });

describe("textOffsetWithin", () => {
  it("returns the offset directly for a bare text node", () => {
    const t = text("const x = 1;");
    const root = el(t);
    expect(textOffsetWithin(root, t, 6)).toBe(6);
  });

  it("accumulates lengths of preceding text nodes across span/mark wrappers", () => {
    // <td>const <span>renderCode</span>Html(<mark>text</mark>)</td>
    const target = text("Html(");
    const root = el(
      text("const "),
      el(text("renderCode")),
      target,
      el(text("text")),
      text(")"),
    );
    // "const " (6) + "renderCode" (10) = 16, plus 2 into "Html("
    expect(textOffsetWithin(root, target, 2)).toBe(18);
  });

  it("handles deep nesting (mark wrapping a token span)", () => {
    const target = text("bar");
    const root = el(text("foo."), el(el(target)), text("()"));
    expect(textOffsetWithin(root, target, 0)).toBe(4);
  });

  it("returns 0 for the very first character", () => {
    const t = text("import x");
    expect(textOffsetWithin(el(t), t, 0)).toBe(0);
  });

  it("returns null when the target is not a descendant of root", () => {
    const stranger = text("elsewhere");
    const root = el(text("abc"));
    expect(textOffsetWithin(root, stranger, 1)).toBeNull();
  });

  it("ignores empty wrappers and empty text nodes", () => {
    const target = text("x");
    const root = el(el(), text(""), el(text("ab")), target);
    expect(textOffsetWithin(root, target, 1)).toBe(3);
  });
});

describe("lspLangLabel", () => {
  it("maps the ts family to \"ts\"", () => {
    for (const ext of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
      expect(lspLangLabel("src/deep/file." + ext)).toBe("ts");
    }
  });

  it("maps rust and java", () => {
    expect(lspLangLabel("crates/core/lib.rs")).toBe("rust");
    expect(lspLangLabel("app/src/Main.java")).toBe("java");
  });

  it("is case-insensitive on the extension", () => {
    expect(lspLangLabel("a/B.TS")).toBe("ts");
  });

  it("returns null for unknown extensions, dotfiles, and extension-less paths", () => {
    expect(lspLangLabel("styles/site.css")).toBeNull();
    expect(lspLangLabel(".gitignore")).toBeNull();
    expect(lspLangLabel("Makefile")).toBeNull();
    expect(lspLangLabel("dir.with.dots/file")).toBeNull();
  });
});

describe("diagRowIndex", () => {
  const rows = [
    { t: "h", n: null },
    { t: "c", n: 10 },
    { t: "d", n: null },
    { t: "a", n: 11 },
    { t: "a", n: 12 },
    { t: "c", n: 13 },
  ];

  it("maps a new-side line to its add row", () => {
    expect(diagRowIndex(rows, 11)).toBe(3);
    expect(diagRowIndex(rows, 12)).toBe(4);
  });

  it("maps a new-side line to its context row", () => {
    expect(diagRowIndex(rows, 10)).toBe(1);
    expect(diagRowIndex(rows, 13)).toBe(5);
  });

  it("returns -1 for lines not present in the diff", () => {
    expect(diagRowIndex(rows, 99)).toBe(-1);
    expect(diagRowIndex(rows, 1)).toBe(-1);
  });

  it("never matches hunk or del rows", () => {
    // A del row's n is null; asking for null-ish lines must not hit them.
    expect(diagRowIndex([{ t: "d", n: null }], 0)).toBe(-1);
  });
});
