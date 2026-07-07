/**
 * Render-time syntax highlighting for diff code cells — zero dependencies, no CDN.
 *
 * A compact per-LINE tokenizer (diff rows are independent lines, so multi-line
 * constructs like unclosed block comments are not tracked across rows — an accepted
 * limitation). Token classes map onto CSS custom properties defined in html.ts:
 *   kw → --tok-kw · str → --tok-str · num → --tok-num · com → --tok-com
 *   fn → --tok-fn (call/definition names) · type → --tok-type (PascalCase / type
 *   positions) · builtin → --tok-builtin (true/false/null/this/…) · op → --tok-op
 *   (operators) · punc → --tok-punc (delimiters, deliberately dimmed).
 * Highlighting is deliberately subtle: the diff add/del tints stay the dominant
 * signal; tokens are secondary, and punctuation recedes below code.
 *
 * Escaping/composition order (the robust one): tokenize the RAW line first, keep
 * tokens and intraline marks as OFFSET RANGES into the raw text, then emit — every
 * segment between range boundaries is HTML-escaped at emission time and wrapped in
 * its span/mark. No element ever spans a boundary: a mark crossing several tokens is
 * emitted as adjacent <mark> elements (visually seamless — the mark style has no
 * border/padding/radius). Consequence: emitted textContent equals the raw line
 * exactly, so column alignment (white-space:pre) can never break.
 *
 * SHIPPING MODEL: besides render-time use in html.ts, these functions also run in
 * the browser to highlight live-expanded context rows — client.ts injects each
 * fn.toString() PLUS serialized copies of the module-level tables/regexes below
 * (that's why they are exported): every function may reference sibling exports by
 * name but nothing else outside itself.
 */

export type Lang = "js" | "json" | "css" | "html" | "generic" | "none";

export type TokenClass =
  | "kw"
  | "str"
  | "num"
  | "com"
  | "fn"
  | "type"
  | "op"
  | "punc"
  | "builtin";

export interface Token {
  start: number;
  end: number;
  cls: TokenClass;
}

/** A raw-text offset range to wrap in <mark> (computed by intraline.ts). */
export interface MarkRange {
  start: number;
  end: number;
}

/** Same escaping as the rest of the renderer (esc in html.ts re-exports this). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Language keying (by file extension) ─────────────────────────────────────────────────
// "generic" = strings/numbers/comments via common patterns for known code-ish
// extensions; truly unknown extensions get "none" → plain escaped text.

export const EXT_LANG: Record<string, Lang> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  json: "json", jsonc: "json",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
  py: "generic", rb: "generic", sh: "generic", bash: "generic", zsh: "generic",
  go: "generic", rs: "generic", java: "generic", kt: "generic", c: "generic",
  h: "generic", cpp: "generic", hpp: "generic", cc: "generic", swift: "generic",
  php: "generic", yaml: "generic", yml: "generic", toml: "generic", sql: "generic",
};

export function langForPath(path: string): Lang {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "none"; // no extension (or dotfile like .gitignore)
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? "none";
}

// ── Fence-info keying (markdown ``` blocks) ─────────────────────────────────────────────
// Same target langs as EXT_LANG plus the spelled-out aliases people type in fence
// info strings; unknown / empty info → "none" → plain escaped text.

export const FENCE_LANG: Record<string, Lang> = {
  ts: "js", tsx: "js", typescript: "js", js: "js", jsx: "js", javascript: "js",
  mjs: "js", cjs: "js", mts: "js", cts: "js", node: "js",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
  sh: "generic", bash: "generic", zsh: "generic", shell: "generic",
  py: "generic", python: "generic", rb: "generic", ruby: "generic",
  go: "generic", golang: "generic", rs: "generic", rust: "generic",
  java: "generic", kt: "generic", kotlin: "generic", c: "generic", cpp: "generic",
  swift: "generic", php: "generic", yaml: "generic", yml: "generic",
  toml: "generic", sql: "generic",
};

/**
 * Tokenizer for a markdown fence info string ("ts", "TypeScript", …). Own-key
 * lookup: prototype names ("constructor") must not resolve to a lang.
 */
export function langForFence(info: string): Lang {
  const key = (info || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(FENCE_LANG, key) ? FENCE_LANG[key]! : "none";
}

/**
 * Escaped, token-wrapped HTML for a fenced code block's raw text: each line
 * tokenized independently (the same per-line model as the diff) and joined back
 * with newlines, so textContent equals the raw code exactly. Escape-at-emission
 * via renderCodeHtml — safe to place inside markdown.ts's <pre><code> as-is
 * (renderMarkdown passes this as its fence highlighter on both the server and
 * client render paths). Unknown info → plain escaped text, byte-equal to the
 * unhighlighted rendering.
 */
export function highlightFence(code: string, info: string): string {
  const lang = langForFence(info);
  if (lang === "none") return escapeHtml(code);
  return code
    .split("\n")
    .map((ln) => renderCodeHtml(ln, lang, [], "ln-add"))
    .join("\n");
}

// ── Tokenizers ──────────────────────────────────────────────────────────────────────────
// One alternation regex per language, scanned left-to-right; alternative ORDER is the
// precedence (comment before string before number before identifier). The identifier
// alternative usually emits no token — it exists to consume names so their digit
// suffixes ("x5", "grid2") can't be misread as numbers.

export const JS_KEYWORDS = new Set([
  "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch",
  "class", "const", "continue", "debugger", "declare", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "from", "function",
  "get", "if", "implements", "import", "in", "infer", "instanceof", "interface",
  "keyof", "let", "namespace", "never", "new", "null", "number", "object", "of",
  "override", "private", "protected", "public", "readonly", "return", "satisfies",
  "set", "static", "string", "super", "switch", "symbol", "this", "throw", "true",
  "try", "type", "typeof", "undefined", "unknown", "var", "void", "while", "yield",
]);

// Language literals / references that read better in their own hue than as plain
// keywords: booleans, nullish literals, and the self-references. A subset of
// JS_KEYWORDS — checked BEFORE the keyword test so they win.
export const JS_BUILTINS = new Set([
  "true", "false", "null", "undefined", "this", "super", "NaN", "Infinity",
  "self", "arguments", "globalThis", "console",
]);

// Keywords that INTRODUCE a type name in the following identifier position, so the
// name after them is classified `type` rather than a bare identifier.
export const TYPE_INTRO = new Set([
  "class", "interface", "extends", "implements", "struct", "enum", "trait",
  "type", "namespace", "new", "instanceof", "satisfies", "is", "as", "keyof",
]);

export const JS_RE =
  /(\/\/.*|\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(0[xXoObB][0-9a-fA-F_]+n?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)|([A-Za-z_$][\w$]*)|(=>|\.\.\.|[-+*/%=!<>&|^~?]+)|([{}()[\];,.:@])/g;

export const JSON_RE = /("(?:[^"\\]|\\.)*"?)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|([{}[\],:])/g;

export const JSON_KEYWORDS = new Set(["true", "false", "null"]);

export const CSS_RE =
  /(\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(@[\w-]+)|(#[0-9a-fA-F]{3,8}\b|[-+]?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?)|([A-Za-z_-][\w-]*)|([{}();,>~+*]|::?)/g;

export const HTML_RE = /(<!--.*?(?:-->|$))|(<\/?[A-Za-z][\w-]*)|("[^"]*"?|'[^']*'?)|(\d[\d.]*)|([A-Za-z_][\w-]*(?==))|([=/>])/g;

export const GENERIC_RE =
  /(#.*|\/\/.*|\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(=>|:=|->|[-+*/%=!<>&|^~?]+)|([{}()[\];,.:@])/g;

// Shared JS/generic builtin literal set used by the generic tokenizer too.
export const GENERIC_BUILTINS = new Set([
  "true", "false", "null", "nil", "None", "True", "False", "undefined",
  "this", "self", "super",
]);

export function push(out: Token[], m: RegExpExecArray, cls: TokenClass, from = 0): void {
  if (m.index + from < m.index + m[0].length) {
    out.push({ start: m.index + from, end: m.index + m[0].length, cls });
  }
}

/**
 * Index of the last non-whitespace character strictly before `pos` (−1 if none).
 * Used by the identifier classifier to peek at the preceding delimiter.
 */
export function prevNonSpace(text: string, pos: number): number {
  let i = pos - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  return i;
}

/**
 * Index of the next non-whitespace character at/after `pos` (text.length if none).
 */
export function nextNonSpace(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  return i;
}

/**
 * Context classifier for a bare identifier at [start,end) in `text`, given the
 * word BEFORE it (`prevWord`, "" if the preceding char isn't an identifier char).
 * Heuristic, regex-free: returns a TokenClass to wrap the name in, or null to
 * leave it as plain text. Precedence, most-specific first:
 *   fn      — name immediately followed by "(" (call or definition site)
 *   type    — name after a type-introducing keyword (class/interface/new/…), OR
 *             a name in a ":" / "<" type position, OR a PascalCase identifier
 * Everything else (locals, properties, plain refs) stays unclassified.
 */
export function classifyIdent(
  text: string,
  start: number,
  end: number,
  prevWord: string,
): TokenClass | null {
  const word = text.slice(start, end);
  const nAt = nextNonSpace(text, end);
  const next = nAt < text.length ? text[nAt] : "";
  // Call / definition site: foo( — the strongest, most reliable signal.
  if (next === "(") return "fn";
  // Arrow / function assignment: `name = (…) =>` or `name = function` or
  // `name = async (…) =>`. Peek past a single "=" (not "==") to a "(" or the
  // words function/async — a common definition shape the bare-"(" test misses.
  if (next === "=" && text[nAt + 1] !== "=" && text[nAt + 1] !== ">") {
    const aAt = nextNonSpace(text, nAt + 1);
    const rest = text.slice(aAt);
    if (rest.charAt(0) === "(" || /^(?:function|async)\b/.test(rest)) return "fn";
  }
  // A name the parser is clearly declaring/using as a type.
  if (prevWord && TYPE_INTRO.has(prevWord)) return "type";
  const pAt = prevNonSpace(text, start);
  const prev = pAt >= 0 ? text[pAt] : "";
  // Type annotation / generic position: `: Foo`, `<Foo`, `extends Foo` (handled
  // above via prevWord). A leading ":" or "<" only implies a type for an
  // uppercase-led name (avoids painting ternary branches / object values).
  if ((prev === ":" || prev === "<" || prev === "|" || prev === "&") && /^[A-Z]/.test(word)) {
    return "type";
  }
  // PascalCase identifier: Uppercase-led, contains a lowercase letter (so all-caps
  // CONSTANTS are NOT treated as types) — the common convention for a type/class.
  if (/^[A-Z][A-Za-z0-9]*$/.test(word) && /[a-z]/.test(word)) return "type";
  return null;
}

/** Classified, non-overlapping, sorted tokens over the raw (unescaped) line. */
export function tokenize(text: string, lang: Lang): Token[] {
  if (lang === "none" || text.length === 0) return [];
  const out: Token[] = [];
  const re =
    lang === "js" ? JS_RE
    : lang === "json" ? JSON_RE
    : lang === "css" ? CSS_RE
    : lang === "html" ? HTML_RE
    : GENERIC_RE;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  // The previous identifier/keyword word (bare, no delimiters) — drives the type
  // classifier's "name after class/new/…" heuristic. Reset on any non-word token.
  let prevWord = "";
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++; // defensive: never stall the scan on a zero-length match
      continue;
    }
    let nextPrevWord = "";
    if (lang === "js" || lang === "generic") {
      const builtins = lang === "js" ? JS_BUILTINS : GENERIC_BUILTINS;
      const kws = lang === "js" ? JS_KEYWORDS : null;
      if (m[1] !== undefined) push(out, m, "com");
      else if (m[2] !== undefined) push(out, m, "str");
      else if (m[3] !== undefined) push(out, m, "num");
      else if (m[4] !== undefined) {
        // Identifier group: builtin literal, keyword, or context-classified name.
        if (builtins.has(m[0])) push(out, m, "builtin");
        else if (kws && kws.has(m[0])) { push(out, m, "kw"); nextPrevWord = m[0]; }
        else {
          const cls = classifyIdent(text, m.index, m.index + m[0].length, prevWord);
          if (cls) push(out, m, cls);
          nextPrevWord = m[0];
        }
      } else if (m[5] !== undefined) push(out, m, "op");
      else if (m[6] !== undefined) push(out, m, "punc");
    } else if (lang === "json") {
      if (m[1] !== undefined) push(out, m, "str");
      else if (m[2] !== undefined) push(out, m, "num");
      else if (m[3] !== undefined) { if (JSON_KEYWORDS.has(m[0])) push(out, m, "builtin"); }
      else if (m[4] !== undefined) push(out, m, "punc");
    } else if (lang === "css") {
      if (m[1] !== undefined) push(out, m, "com");
      else if (m[2] !== undefined) push(out, m, "str");
      else if (m[3] !== undefined) push(out, m, "kw");
      else if (m[4] !== undefined) push(out, m, "num");
      else if (m[6] !== undefined) push(out, m, "punc");
      // m[5] (bare identifier: property / value / selector word) stays plain.
    } else if (lang === "html") {
      if (m[1] !== undefined) push(out, m, "com");
      else if (m[2] !== undefined) push(out, m, "kw", m[0].startsWith("</") ? 2 : 1);
      else if (m[3] !== undefined) push(out, m, "str");
      else if (m[4] !== undefined) push(out, m, "num");
      else if (m[5] !== undefined) push(out, m, "type"); // attribute name
      else if (m[6] !== undefined) push(out, m, "punc");
    }
    prevWord = nextPrevWord;
  }
  return out;
}

// ── Emission ────────────────────────────────────────────────────────────────────────────

/**
 * Emit the HTML for one code cell: raw line text → escaped text with token spans and
 * (optional) intraline <mark>s. Adds NO characters to textContent besides the tags
 * themselves. Boundaries of tokens and marks partition the line; each segment is
 * escaped then wrapped (span innermost, mark outermost), so partial overlap between a
 * mark and a token can never produce mis-nested HTML.
 */
export function renderCodeHtml(
  text: string,
  lang: Lang,
  marks: readonly MarkRange[] = [],
  markCls: "ln-add" | "ln-del" = "ln-add",
): string {
  const tokens = tokenize(text, lang);
  const clamped = marks
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(text.length, r.end) }))
    .filter((r) => r.start < r.end)
    .sort((a, b) => a.start - b.start);
  if (tokens.length === 0 && clamped.length === 0) return escapeHtml(text);

  const cuts = new Set<number>([0, text.length]);
  for (const t of tokens) { cuts.add(t.start); cuts.add(t.end); }
  for (const r of clamped) { cuts.add(r.start); cuts.add(r.end); }
  const points = [...cuts].sort((a, b) => a - b);

  let html = "";
  let ti = 0;
  let mi = 0;
  for (let p = 0; p < points.length - 1; p++) {
    const a = points[p]!;
    const b = points[p + 1]!;
    while (ti < tokens.length && tokens[ti]!.end <= a) ti++;
    while (mi < clamped.length && clamped[mi]!.end <= a) mi++;
    const tok = ti < tokens.length && tokens[ti]!.start <= a ? tokens[ti]! : null;
    const marked = mi < clamped.length && clamped[mi]!.start <= a;
    let piece = escapeHtml(text.slice(a, b));
    if (tok) piece = `<span class="tok-${tok.cls}">${piece}</span>`;
    if (marked) piece = `<mark class="${markCls}">${piece}</mark>`;
    html += piece;
  }
  return html;
}
