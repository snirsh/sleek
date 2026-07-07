/**
 * Compact, safe markdown → HTML renderer for the chat transcript (GFM subset):
 * paragraphs, # ## ### headings, **bold**, *italic*, `inline code`, ``` fenced code
 * blocks (optional language tag; syntax-highlighted through the optional `hl`
 * parameter — both render paths pass highlight.ts's highlightFence — else plain),
 * -/1. lists (one nesting level), > blockquotes, [links](http/https only, opened in a
 * new tab), ![images](http/https only), basic | tables, --- rules. Anything else
 * stays literal text.
 *
 * SECURITY MODEL: every text path is HTML-escaped FIRST, then markdown syntax is
 * transformed on the escaped text — there is no raw-HTML passthrough, and link hrefs
 * are dropped unless they start with http:// or https:// (javascript: etc. render as
 * their plain link text).
 *
 * SHIPPING MODEL: this exact function also runs in the browser — client.ts injects
 * renderMarkdown.toString() into CLIENT_JS (tsx/vitest strip the type annotations at
 * load, so the injected source is plain ES2020). The function body must therefore stay
 * fully self-contained: no imports, no references to module scope, no TS-only runtime
 * syntax. The vitest suite in markdown.test.ts covers the very function the page runs.
 */

/**
 * `hl` (optional) renders a fence's raw code to ESCAPED HTML (token spans only —
 * highlight.ts highlightFence escapes at emission). It replaces this module's own
 * escaping for that fence body, so there is no double-escaping; it must never
 * pass raw input through. When absent (or for callers that never wire it) fences
 * render plain-escaped exactly as before. The fence info string it receives is
 * already constrained to [\w-]* by the fence regex — it can never carry markup.
 */
export function renderMarkdown(src: string, hl?: (code: string, info: string) => string): string {
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Inline spans over ONE escaped line: code first (its contents are shielded from the
  // other transforms via \u0000 placeholders — real NULs are stripped up front so user
  // text can never forge one), then links, bold, italic.
  const inline = (raw: string): string => {
    let s = escapeHtml(raw.replace(/\u0000/g, ""));
    const codes: string[] = [];
    const images: string[] = [];
    s = s.replace(/`([^`]+)`/g, (_m, c) => {
      codes.push("<code>" + c + "</code>");
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    s = s.replace(/!\[([^\]]*)\]\(([^()\s]+)\)/g, (_m, alt, href) =>
      /^https?:\/\//i.test(href) ? (() => {
        images.push('<a class="mdimglink" href="' + href + '" target="_blank" rel="noopener"><img class="mdimg" src="' + href + '" alt="' + alt + '" loading="lazy"></a>');
        return "\u0000img" + (images.length - 1) + "\u0000";
      })() : alt,
    );
    s = s.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (_m, text, href) =>
      /^https?:\/\//i.test(href)
        ? '<a href="' + href + '" target="_blank" rel="noopener">' + text + "</a>"
        : text,
    );
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\s][^*]*)\*/g, "<em>$1</em>");
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)] || "");
    s = s.replace(/\u0000img(\d+)\u0000/g, (_m, i) => images[Number(i)] || "");
    return s;
  };

  const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.+)$/;
  const HR_RE = /^\s*---+\s*$/;
  const HEAD_RE = /^(#{1,3})\s+(.+)$/;
  const isTableSep = (s: string | undefined): boolean =>
    s !== undefined && /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && s.includes("-");
  const tableCells = (s: string): string[] => {
    let t = s.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|")) t = t.slice(0, -1);
    return t.split("|").map((c) => inline(c.trim()));
  };

  const blocks = (lines: string[]): string => {
    const out: string[] = [];
    let i = 0;
    const startsBlock = (s: string): boolean =>
      /^```/.test(s) || HEAD_RE.test(s) || HR_RE.test(s) || /^\s*>/.test(s) || LIST_RE.test(s);
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") { i++; continue; }

      // ``` fenced code block (optional language; closed by ``` or end of input)
      const fence = /^```([\w-]*)\s*$/.exec(line);
      if (fence) {
        i++;
        const buf: string[] = [];
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // past the closing fence (or EOF)
        const code = buf.join("\n");
        out.push(
          '<div class="mdfence"><button type="button" class="mdcopy">Copy</button><pre><code' +
            (fence[1] ? ' class="lang-' + fence[1] + '"' : "") +
            ">" + (typeof hl === "function" ? hl(code, fence[1]) : escapeHtml(code)) + "</code></pre></div>",
        );
        continue;
      }

      const head = HEAD_RE.exec(line);
      if (head) {
        const n = head[1].length;
        out.push("<h" + n + ">" + inline(head[2]) + "</h" + n + ">");
        i++;
        continue;
      }

      if (HR_RE.test(line)) { out.push("<hr>"); i++; continue; }

      // > blockquote — consecutive quoted lines, inner content parsed recursively
      if (/^\s*>/.test(line)) {
        const buf: string[] = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*> ?/, ""));
          i++;
        }
        out.push("<blockquote>" + blocks(buf) + "</blockquote>");
        continue;
      }

      // -/1. lists; an item indented ≥2 spaces nests one level under the item above
      if (LIST_RE.test(line)) {
        const items: { nested: boolean; ordered: boolean; text: string }[] = [];
        while (i < lines.length) {
          const m = LIST_RE.exec(lines[i]);
          if (!m) break;
          items.push({ nested: m[1].length >= 2, ordered: /\d/.test(m[2]), text: m[3] });
          i++;
        }
        const topTag = items[0].ordered ? "ol" : "ul";
        let html = "";
        let j = 0;
        while (j < items.length) {
          const it = items[j];
          let li = "<li>" + inline(it.text);
          j++;
          if (!it.nested && j < items.length && items[j].nested) {
            const subTag = items[j].ordered ? "ol" : "ul";
            let sub = "";
            while (j < items.length && items[j].nested) {
              sub += "<li>" + inline(items[j].text) + "</li>";
              j++;
            }
            li += "<" + subTag + ">" + sub + "</" + subTag + ">";
          }
          html += li + "</li>";
        }
        out.push("<" + topTag + ">" + html + "</" + topTag + ">");
        continue;
      }

      // | table — a header row with pipes followed by a |---| separator line
      if (line.includes("|") && isTableSep(lines[i + 1])) {
        const headCells = tableCells(line);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          rows.push(tableCells(lines[i]));
          i++;
        }
        out.push(
          "<table><thead><tr>" +
            headCells.map((h) => "<th>" + h + "</th>").join("") +
            "</tr></thead><tbody>" +
            rows.map((r) => "<tr>" + r.map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("") +
            "</tbody></table>",
        );
        continue;
      }

      // paragraph — consecutive plain lines; single newlines render as <br> (chat text)
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !startsBlock(lines[i]) &&
        !(lines[i].includes("|") && isTableSep(lines[i + 1]))
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push("<p>" + buf.map(inline).join("<br>") + "</p>");
    }
    return out.join("");
  };

  return blocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

/**
 * Render GitHub-authored/synced comment bodies. GitHub comments can contain raw
 * HTML generated by bots; normal renderMarkdown intentionally escapes that. This
 * helper allows a small, presentation-only HTML subset and strips unsafe tags,
 * event handlers, styles, and non-http links.
 *
 * SHIPPING MODEL: client.ts injects this function source next to renderMarkdown,
 * so keep the body self-contained and reference only renderMarkdown by name.
 */
export function renderGithubMarkdown(src: string, hl?: (code: string, info: string) => string): string {
  if (!/<\/?[a-zA-Z][^>]*>/.test(src)) return renderMarkdown(src, hl);

  const allowed = new Set([
    "a", "b", "blockquote", "br", "code", "del", "details", "em", "h1", "h2",
    "h3", "h4", "hr", "i", "img", "li", "ol", "p", "pre", "strong", "sub",
    "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul",
  ]);
  const voidTags = new Set(["br", "hr", "img"]);
  const dropContent = /<\s*(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\/\s*\1\s*>/gi;
  const escapeText = (s: string): string =>
    s
      .replace(/&(?!(?:#\d+|#x[\da-fA-F]+|[a-zA-Z][\w]+);)/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const escapeAttr = (s: string): string =>
    s
      .replace(/&(?!(?:#\d+|#x[\da-fA-F]+|[a-zA-Z][\w]+);)/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const attrsOf = (raw: string): Record<string, string> => {
    const attrs: Record<string, string> = {};
    raw.replace(
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/g,
      (_m, name, value) => {
        const v = String(value);
        attrs[String(name).toLowerCase()] =
          v[0] === '"' || v[0] === "'" ? v.slice(1, -1) : v;
        return "";
      },
    );
    return attrs;
  };
  const safeUrl = (value: string | undefined): string | null =>
    value && /^https?:\/\//i.test(value) ? value : null;
  const safeInt = (value: string | undefined): string | null =>
    value && /^\d{1,2}$/.test(value) ? value : null;
  const safeAlign = (value: string | undefined): string | null =>
    value && /^(left|center|right)$/i.test(value) ? value.toLowerCase() : null;

  const sanitizeTag = (raw: string): string => {
    const m = /^<\s*(\/)?\s*([a-zA-Z][\w-]*)\b([\s\S]*?)(\/)?\s*>$/.exec(raw);
    if (!m) return escapeText(raw);
    const closing = Boolean(m[1]);
    const tag = m[2].toLowerCase();
    if (!allowed.has(tag)) return "";
    if (closing) return voidTags.has(tag) ? "" : "</" + tag + ">";

    const attrs = attrsOf(m[3]);
    if (tag === "a") {
      const href = safeUrl(attrs.href);
      if (!href) return "<a>";
      return '<a href="' + escapeAttr(href) + '" target="_blank" rel="noopener">';
    }
    if (tag === "img") {
      const srcUrl = safeUrl(attrs.src);
      if (!srcUrl) return "";
      const alt = attrs.alt ? ' alt="' + escapeAttr(attrs.alt) + '"' : ' alt=""';
      return '<img class="mdimg" src="' + escapeAttr(srcUrl) + '"' + alt + ' loading="lazy">';
    }
    if (tag === "td" || tag === "th") {
      const bits: string[] = [];
      const colspan = safeInt(attrs.colspan);
      const rowspan = safeInt(attrs.rowspan);
      const align = safeAlign(attrs.align);
      if (colspan) bits.push('colspan="' + colspan + '"');
      if (rowspan) bits.push('rowspan="' + rowspan + '"');
      if (align) bits.push('align="' + align + '"');
      return "<" + tag + (bits.length ? " " + bits.join(" ") : "") + ">";
    }
    if (tag === "table") {
      const align = safeAlign(attrs.align);
      return "<table" + (align ? ' align="' + align + '"' : "") + ">";
    }
    if (tag === "details" && /\bopen\b/i.test(m[3])) {
      return "<details open>";
    }
    return "<" + tag + ">";
  };

  const sanitizeHtmlLine = (line: string): string => {
    let out = "";
    let last = 0;
    line.replace(/<\/?[a-zA-Z][^>]*>/g, (tag, offset) => {
      out += escapeText(line.slice(last, offset));
      out += sanitizeTag(tag);
      last = offset + tag.length;
      return "";
    });
    out += escapeText(line.slice(last));
    return out;
  };

  const out: string[] = [];
  let md: string[] = [];
  const flushMd = (): void => {
    if (!md.length) return;
    out.push(renderMarkdown(md.join("\n"), hl));
    md = [];
  };
  for (const line of src.replace(dropContent, "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/<\/?[a-zA-Z][^>]*>/.test(line)) {
      flushMd();
      out.push(sanitizeHtmlLine(line));
    } else {
      md.push(line);
    }
  }
  flushMd();
  return out.join("\n");
}
