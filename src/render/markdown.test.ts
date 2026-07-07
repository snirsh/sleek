import { describe, expect, it } from "vitest";

import { highlightFence } from "./highlight.ts";
import { renderGithubMarkdown, renderMarkdown } from "./markdown.ts";

describe("renderMarkdown — rendering", () => {
  it("renders paragraphs with bold, italic and inline code", () => {
    expect(renderMarkdown("**bold** and *ital* and `x = 1`")).toBe(
      "<p><strong>bold</strong> and <em>ital</em> and <code>x = 1</code></p>",
    );
  });

  it("separates paragraphs on blank lines and breaks single newlines", () => {
    expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
  });

  it("renders # ## ### headings and --- rules; #### stays literal", () => {
    expect(renderMarkdown("# A\n## B\n### C\n---")).toBe("<h1>A</h1><h2>B</h2><h3>C</h3><hr>");
    expect(renderMarkdown("#### D")).toBe("<p>#### D</p>");
  });

  it("renders fenced code blocks with a Copy button and escaped plain content", () => {
    const html = renderMarkdown("```ts\nconst a: Set<string> = b && c;\n```");
    expect(html).toBe(
      '<div class="mdfence"><button type="button" class="mdcopy">Copy</button>' +
        '<pre><code class="lang-ts">const a: Set&lt;string&gt; = b &amp;&amp; c;</code></pre></div>',
    );
  });

  it("leaves an unclosed fence readable (runs to end of input)", () => {
    expect(renderMarkdown("```\nabc")).toContain("<pre><code>abc</code></pre>");
  });

  it("does not apply inline formatting inside code spans or fences", () => {
    expect(renderMarkdown("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
    expect(renderMarkdown("```\n**not bold**\n```")).toContain("<code>**not bold**</code>");
  });

  it("renders unordered and ordered lists with one nesting level", () => {
    expect(renderMarkdown("- a\n- b\n  - b1\n  - b2\n- c")).toBe(
      "<ul><li>a</li><li>b<ul><li>b1</li><li>b2</li></ul></li><li>c</li></ul>",
    );
    expect(renderMarkdown("1. x\n2. y")).toBe("<ol><li>x</li><li>y</li></ol>");
  });

  it("renders blockquotes", () => {
    expect(renderMarkdown("> quoted **hard**\n> second")).toBe(
      "<blockquote><p>quoted <strong>hard</strong><br>second</p></blockquote>",
    );
  });

  it("renders basic pipe tables", () => {
    expect(renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |")).toBe(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead>" +
        "<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>",
    );
  });

  it("highlights fenced code through the injected highlighter (both render paths pass it)", () => {
    const html = renderMarkdown('```ts\nconst a = "s"; // c\n```', highlightFence);
    expect(html).toContain('<code class="lang-ts">');
    expect(html).toContain('<span class="tok-kw">const</span>');
    expect(html).toContain('<span class="tok-str">&quot;s&quot;</span>');
    expect(html).toContain('<span class="tok-com">// c</span>');
  });

  it("falls back to plain escaped fences for unknown languages, with no double-escaping", () => {
    const html = renderMarkdown("```mystery\na && b\n```", highlightFence);
    expect(html).toContain('<code class="lang-mystery">a &amp;&amp; b</code>');
    expect(html).not.toContain("&amp;amp;");
    // Identical bytes to the highlighter-less rendering.
    expect(html.replace(' class="lang-mystery"', "")).toBe(renderMarkdown("```\na && b\n```"));
  });

  it("renders http/https links with target=_blank rel=noopener", () => {
    expect(renderMarkdown("[docs](https://example.com/a?b=1)")).toBe(
      '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener">docs</a></p>',
    );
    expect(renderMarkdown("[plain](http://example.com)")).toContain('href="http://example.com"');
  });

  it("renders http/https images with safe attributes", () => {
    expect(renderMarkdown("![screenshot](https://github.com/o/r/assets/1.png)")).toBe(
      '<p><a class="mdimglink" href="https://github.com/o/r/assets/1.png" target="_blank" rel="noopener"><img class="mdimg" src="https://github.com/o/r/assets/1.png" alt="screenshot" loading="lazy"></a></p>',
    );
    expect(renderMarkdown("![**not bold**](https://example.com/a.png)")).toContain(
      'alt="**not bold**"',
    );
  });
});

describe("renderMarkdown — security", () => {
  it("keeps <script> injection escaped, never live markup", () => {
    const html = renderMarkdown('hi <script>alert("x")</script>');
    expect(html).toBe("<p>hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
    expect(html).not.toContain("<script");
  });

  it("never passes raw HTML through (tags, attributes, event handlers)", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> and <b>b</b>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("neutralizes javascript: links to their plain text", () => {
    expect(renderMarkdown("[click](javascript:alert(1))")).not.toContain("<a");
    expect(renderMarkdown("[click](javascript:void0)")).toBe("<p>click</p>");
    expect(renderMarkdown("[click](data:text/html;x)")).toBe("<p>click</p>");
  });

  it("neutralizes non-http images to their alt text", () => {
    expect(renderMarkdown("![bad](javascript:alert(1))")).not.toContain("<img");
    expect(renderMarkdown("![bad](javascript:void0)")).toBe("<p>bad</p>");
    expect(renderMarkdown("![bad](data:image/png;base64,abc)")).toBe("<p>bad</p>");
  });

  it("keeps plain text containing < & > intact (escaped, nothing lost)", () => {
    expect(renderMarkdown("a < b & c > d")).toBe("<p>a &lt; b &amp; c &gt; d</p>");
  });

  it("cannot be tricked by NUL placeholder forgery in user text", () => {
    // A literal \u0000 in the input is stripped before the code-span placeholder pass.
    expect(renderMarkdown("a`x`b \u00000\u0000")).toBe("<p>a<code>x</code>b 0</p>");
  });

  it("escapes quotes so a crafted URL cannot break out of the href attribute", () => {
    const html = renderMarkdown('[t](https://e.com/"onload=x)');
    expect(html).toContain('href="https://e.com/&quot;onload=x"');
    expect(html).not.toContain('"onload');
  });

  it("keeps <script> in a HIGHLIGHTED fence escaped — the highlighter never revives markup", () => {
    const html = renderMarkdown('```ts\n<script>alert("x")</script>\n```', highlightFence);
    expect(html).not.toContain("<script");
    // The angle brackets are escaped (the tokenizer may now wrap them as separate
    // <op> spans, so assert the escaped entities are present rather than a
    // contiguous "&lt;script&gt;" run — the security property is "never raw markup").
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
    expect(html).toContain("script");
    // And unclosed hostile fences too (run to end of input).
    const open = renderMarkdown("```html\n<img src=x onerror=alert(1)>", highlightFence);
    expect(open).not.toContain("<img");
  });

  it("a malicious fence info string never reaches the class attribute or the highlighter", () => {
    // The fence regex only admits [\w-]* info: this line is NOT a fence, so the
    // whole block renders as escaped paragraph text.
    const html = renderMarkdown('```"><script>alert(1)</script>\ncode\n```', highlightFence);
    expect(html).not.toContain("<script");
    expect(html).not.toContain('class="lang-');
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderGithubMarkdown", () => {
  it("renders sanitized bot HTML used in GitHub comments", () => {
    const html = renderGithubMarkdown(
      '<h3> &#9989;&nbsp; Status: Passed! </h3>\n' +
        '<table text-align="center" style="width: 100%">' +
        '<tr><td colspan="5"><b>Your build is <a href="https://example.com/log">here</a></b></td></tr>' +
        "</table>\n" +
        "<details open><summary>More</summary><sub>Support</sub></details>",
    );

    expect(html).toContain("<h3> &#9989;&nbsp; Status: Passed! </h3>");
    expect(html).toContain("<table>");
    expect(html).toContain('<td colspan="5">');
    expect(html).toContain('<a href="https://example.com/log" target="_blank" rel="noopener">here</a>');
    expect(html).toContain("<details open><summary>More</summary><sub>Support</sub></details>");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("text-align");
  });

  it("renders markdown around and inside sanitized GitHub HTML blocks", () => {
    const html = renderGithubMarkdown(
      "### Build Failure Analysis\n\n" +
        "**Root Cause:** service returned 500\n\n" +
        "<details>\n" +
        "<summary>Show full details</summary>\n\n" +
        "- first\n" +
        "- second\n\n" +
        "**Next Steps:**\n" +
        "1. Check logs\n" +
        "2. Retry\n\n" +
        "</details>\n\n" +
        "<sub>Support: #support-channel</sub>",
    );

    expect(html).toContain("<h3>Build Failure Analysis</h3>");
    expect(html).toContain("<strong>Root Cause:</strong>");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Show full details</summary>");
    expect(html).toContain("<ul><li>first</li><li>second</li></ul>");
    expect(html).toContain("<ol><li>Check logs</li><li>Retry</li></ol>");
    expect(html).toContain("<sub>Support: #support-channel</sub>");
  });

  it("sanitizes raw GitHub HTML images", () => {
    const html = renderGithubMarkdown(
      '<img src="https://example.com/a.png" alt="shot" width="999" onerror="alert(1)">',
    );

    expect(html).toBe('<img class="mdimg" src="https://example.com/a.png" alt="shot" loading="lazy">');
  });

  it("strips dangerous HTML while preserving safe text", () => {
    const html = renderGithubMarkdown(
      '<img src="javascript:alert(1)" onerror="alert(1)" alt="bad">' +
        '<script>alert(1)</script>' +
        '<a href="javascript:alert(1)" onclick="alert(1)">bad</a>' +
        '<a href="https://example.com" onclick="alert(1)">good</a>' +
        '<span onclick="alert(1)">plain</span>',
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
    expect(html).toContain("<a>bad</a>");
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener">good</a>');
    expect(html).toContain("plain");
  });

  it("keeps ordinary markdown behavior for comments without raw HTML", () => {
    expect(renderGithubMarkdown("**ok** [docs](https://example.com)")).toBe(
      renderMarkdown("**ok** [docs](https://example.com)"),
    );
  });
});
