import { describe, expect, it } from "vitest";

import { escapeHtml, highlightFence, langForFence, langForPath, renderCodeHtml, tokenize } from "./highlight.ts";

/** Recover textContent from emitted cell HTML: strip tags, then unescape entities. */
function textContent(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

describe("langForPath", () => {
  it("keys ts/tsx/js/jsx to the js tokenizer", () => {
    for (const p of ["a.ts", "b.tsx", "src/c.js", "d.jsx", "e.mjs"]) {
      expect(langForPath(p)).toBe("js");
    }
  });

  it("keys json/css/html and generic code-ish extensions", () => {
    expect(langForPath("package.json")).toBe("json");
    expect(langForPath("style.css")).toBe("css");
    expect(langForPath("index.html")).toBe("html");
    expect(langForPath("script.py")).toBe("generic");
  });

  it("unknown or missing extensions get no tokenizer", () => {
    expect(langForPath("notes.xyz")).toBe("none");
    expect(langForPath("Makefile")).toBe("none");
    expect(langForPath(".gitignore")).toBe("none");
  });
});

describe("tokenize (js)", () => {
  it("classifies keyword, number, string and comment in one line", () => {
    const line = `const x = 1 // foo "not a string"`;
    const toks = tokenize(line, "js").map((t) => ({ ...t, text: line.slice(t.start, t.end) }));
    expect(toks).toContainEqual({ start: 0, end: 5, cls: "kw", text: "const" });
    expect(toks).toContainEqual({ start: 10, end: 11, cls: "num", text: "1" });
    expect(toks).toContainEqual({
      start: 12,
      end: line.length,
      cls: "com",
      text: `// foo "not a string"`,
    });
    // The quotes inside the comment must NOT produce a string token.
    expect(toks.filter((t) => t.cls === "str")).toEqual([]);
  });

  it("treats template literals as strings and protects identifier digits", () => {
    const line = "const x5 = `tpl ${y}` + 2";
    const toks = tokenize(line, "js").map((t) => ({ cls: t.cls, text: line.slice(t.start, t.end) }));
    expect(toks).toContainEqual({ cls: "str", text: "`tpl ${y}`" });
    expect(toks).toContainEqual({ cls: "num", text: "2" });
    // the 5 in x5 is part of the identifier, not a number token
    expect(toks.filter((t) => t.cls === "num")).toHaveLength(1);
  });
});

describe("renderCodeHtml", () => {
  it("escapes </script> and <b>& inside strings (escape-then-wrap, never raw)", () => {
    const line = `const s = "</script>" + '<b>&'`;
    const html = renderCodeHtml(line, "js");
    expect(html).not.toContain("</script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain(`<span class="tok-str">&quot;&lt;/script&gt;&quot;</span>`);
    expect(html).toContain(`<span class="tok-str">'&lt;b&gt;&amp;'</span>`);
    expect(textContent(html)).toBe(line);
  });

  it("unknown extension → plain escaped text, byte-equal to escapeHtml", () => {
    const line = `const "x" <b> & 42 // nope`;
    expect(renderCodeHtml(line, "none")).toBe(escapeHtml(line));
  });

  it("adds no characters to textContent (alignment invariant)", () => {
    const lines = [
      `\tif (a < b && c > "d") return \`e\`; // f`,
      `{"key": "value", "n": 3.14, "ok": true}`,
      `.cls { color: #4C8DFF; width: 12px; } /* c */`,
      `<div class="x" data-n="7"><!-- hi --></div>`,
    ];
    const langs = ["js", "json", "css", "html"] as const;
    lines.forEach((line, i) => {
      expect(textContent(renderCodeHtml(line, langs[i]!))).toBe(line);
    });
  });

  it("composes intraline marks with token spans by splitting at boundaries", () => {
    // mark [3,7) crosses the "const" keyword token boundary at 5
    const html = renderCodeHtml("const x", "js", [{ start: 3, end: 7 }], "ln-add");
    expect(html).toBe(
      `<span class="tok-kw">con</span>` +
        `<mark class="ln-add"><span class="tok-kw">st</span></mark>` +
        `<mark class="ln-add"> x</mark>`,
    );
    expect(textContent(html)).toBe("const x");
  });

  it("escapes marked text on plain (none) lang and clamps out-of-range marks", () => {
    const html = renderCodeHtml("a<b", "none", [{ start: 1, end: 99 }], "ln-del");
    expect(html).toBe(`a<mark class="ln-del">&lt;b</mark>`);
    expect(textContent(html)).toBe("a<b");
  });
});

describe("tokenize (js) — fn / type / builtin / op / punc", () => {
  const toks = (line: string) =>
    tokenize(line, "js").map((t) => ({ cls: t.cls, text: line.slice(t.start, t.end) }));

  it("classifies a call site's callee as fn", () => {
    expect(toks("foo(1)")).toContainEqual({ cls: "fn", text: "foo" });
  });

  it("classifies a method call's name as fn (after a dot)", () => {
    const r = toks("arr.map(x)");
    expect(r).toContainEqual({ cls: "fn", text: "map" });
    expect(r).toContainEqual({ cls: "punc", text: "." });
    // the receiver is a plain identifier, not fn
    expect(r.filter((t) => t.text === "arr")).toEqual([]);
  });

  it("classifies a function-definition name as fn", () => {
    const r = toks("function bar(a) {}");
    expect(r).toContainEqual({ cls: "kw", text: "function" });
    expect(r).toContainEqual({ cls: "fn", text: "bar" });
  });

  it("classifies const-arrow definition name as fn (name before '(')", () => {
    const r = toks("const baz = (a) => a");
    expect(r).toContainEqual({ cls: "fn", text: "baz" });
    expect(r).toContainEqual({ cls: "op", text: "=>" });
  });

  it("classifies PascalCase identifiers as type", () => {
    // no trailing '(' so the call-site heuristic doesn't outrank type
    const r = toks("let x: Widget = y");
    expect(r).toContainEqual({ cls: "type", text: "Widget" });
  });

  it("fn outranks type at a constructor call (Widget( -> fn)", () => {
    const r = toks("let x = new Widget()");
    expect(r).toContainEqual({ cls: "kw", text: "new" });
    expect(r).toContainEqual({ cls: "fn", text: "Widget" });
  });

  it("classifies a name after a type-intro keyword as type", () => {
    const r = toks("class app extends base {}");
    expect(r).toContainEqual({ cls: "type", text: "app" });
    expect(r).toContainEqual({ cls: "type", text: "base" });
  });

  it("classifies a name in a ':' type annotation as type when PascalCase", () => {
    const r = toks("let v: Foo = y");
    expect(r).toContainEqual({ cls: "type", text: "Foo" });
    // lowercase after ':' (a value/property) is not a type
    expect(toks("obj: value")).not.toContainEqual({ cls: "type", text: "value" });
  });

  it("does NOT treat ALL-CAPS constants as types", () => {
    const r = toks("const MAX = 5");
    expect(r.filter((t) => t.cls === "type")).toEqual([]);
  });

  it("classifies builtins (true/false/null/this) distinctly from keywords", () => {
    const r = toks("this.ok = null");
    expect(r).toContainEqual({ cls: "builtin", text: "this" });
    expect(r).toContainEqual({ cls: "builtin", text: "null" });
    expect(r.filter((t) => t.cls === "kw")).toEqual([]);
  });

  it("classifies operators and punctuation, with punc for delimiters", () => {
    const r = toks("a === b && c");
    expect(r).toContainEqual({ cls: "op", text: "===" });
    expect(r).toContainEqual({ cls: "op", text: "&&" });
    const r2 = toks("x = { a: [1] };");
    for (const p of ["{", ":", "[", "]", "}", ";"]) {
      expect(r2).toContainEqual({ cls: "punc", text: p });
    }
    expect(r2).toContainEqual({ cls: "op", text: "=" });
  });

  it("precedence holds: '(' inside a string never makes an fn token", () => {
    const r = toks(`const s = "call foo(" + bar()`);
    expect(r).toContainEqual({ cls: "str", text: `"call foo("` });
    // only the real call bar( becomes fn
    expect(r.filter((t) => t.cls === "fn")).toEqual([{ cls: "fn", text: "bar" }]);
  });

  it("precedence holds: operators/punc inside a comment stay in the comment", () => {
    const line = "x = 1 // a === b { }";
    const r = tokenize(line, "js");
    // the comment is one token; nothing else starts at or beyond its start
    const com = r.find((t) => t.cls === "com");
    expect(com && line.slice(com.start)).toBe("// a === b { }");
    expect(r.filter((t) => t.start >= com!.start && t.cls !== "com")).toEqual([]);
  });
});

describe("tokenize (json / generic) new classes", () => {
  it("json: literals are builtin, braces/colons are punc", () => {
    const r = tokenize(`{"ok": true, "n": null}`, "json").map((t) => ({
      cls: t.cls,
      text: `{"ok": true, "n": null}`.slice(t.start, t.end),
    }));
    expect(r).toContainEqual({ cls: "builtin", text: "true" });
    expect(r).toContainEqual({ cls: "builtin", text: "null" });
    expect(r).toContainEqual({ cls: "punc", text: "{" });
    expect(r).toContainEqual({ cls: "punc", text: ":" });
  });

  it("generic: call sites become fn, Pascal names become type, nil is builtin", () => {
    const line = "def Handle() { return Foo.bar(nil) }";
    const r = tokenize(line, "generic").map((t) => ({ cls: t.cls, text: line.slice(t.start, t.end) }));
    expect(r).toContainEqual({ cls: "fn", text: "Handle" });
    expect(r).toContainEqual({ cls: "type", text: "Foo" });
    expect(r).toContainEqual({ cls: "fn", text: "bar" });
    expect(r).toContainEqual({ cls: "builtin", text: "nil" });
  });
});

describe("renderCodeHtml — new classes escape + align", () => {
  it("wraps fn/type/op/punc/builtin spans and keeps textContent byte-equal", () => {
    const line = "const w: Widget = build(this, 1) && ok;";
    const html = renderCodeHtml(line, "js");
    expect(html).toContain('<span class="tok-type">Widget</span>');
    expect(html).toContain('<span class="tok-fn">build</span>');
    expect(html).toContain('<span class="tok-builtin">this</span>');
    expect(html).toContain('<span class="tok-op">&amp;&amp;</span>'); // && escaped-safe
    expect(html).toContain('<span class="tok-punc">;</span>');
    expect(textContent(html)).toBe(line);
  });

  it("escapes hostile identifiers-as-types (no raw markup revives)", () => {
    const line = `new X<"</script>">`;
    const html = renderCodeHtml(line, "js");
    expect(html).not.toContain("</script>");
    expect(html).toContain("&lt;/script&gt;");
    expect(textContent(html)).toBe(line);
  });
});

describe("langForFence", () => {
  it("keys the short and spelled-out js-family aliases, case-insensitively", () => {
    for (const info of ["ts", "tsx", "js", "jsx", "typescript", "JavaScript", "TS"]) {
      expect(langForFence(info)).toBe("js");
    }
  });

  it("keys json/css/html and generic aliases", () => {
    expect(langForFence("json")).toBe("json");
    expect(langForFence("scss")).toBe("css");
    expect(langForFence("html")).toBe("html");
    expect(langForFence("python")).toBe("generic");
    expect(langForFence("bash")).toBe("generic");
  });

  it("unknown or empty info → none (plain)", () => {
    expect(langForFence("brainfuck")).toBe("none");
    expect(langForFence("")).toBe("none");
    // Object.prototype names must not leak through the record lookup.
    expect(langForFence("constructor")).toBe("none");
  });
});

describe("highlightFence", () => {
  it("tokenizes each line independently and keeps textContent byte-equal to the code", () => {
    const code = 'const a = 1;\nreturn "two"; // done';
    const html = highlightFence(code, "ts");
    expect(html).toContain('<span class="tok-kw">const</span>');
    expect(html).toContain('<span class="tok-kw">return</span>');
    expect(html).toContain('<span class="tok-str">&quot;two&quot;</span>');
    expect(html).toContain('<span class="tok-com">// done</span>');
    expect(textContent(html)).toBe(code);
  });

  it("escapes hostile code — token spans never revive raw markup", () => {
    const html = highlightFence('const s = "</script><img onerror=x>";', "js");
    expect(html).not.toContain("</script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;/script&gt;");
  });

  it("unknown info renders plain, byte-equal to escapeHtml (no double-escaping)", () => {
    const code = "a && b < c\nd > e";
    expect(highlightFence(code, "mystery")).toBe(escapeHtml(code));
    expect(highlightFence(code, "mystery")).not.toContain("&amp;amp;");
  });
});
