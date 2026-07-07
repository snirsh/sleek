/**
 * Graph neighbors via tree-sitter. For a changed region we surface the nearby graph:
 * the function/class DEFINITIONS the region lives in, and the top-level symbols the
 * region REFERENCES that are defined elsewhere in the same file (callees/definitions).
 *
 * Per CONTEXT.md / ADR, a Neighbor carries only a `ref` + `signature` + one-line
 * description — NOT source. Source is hydrated lazily by the backend later (M5). We
 * therefore never inline bodies here; we extract the signature line and a terse
 * description ("function foo", "class Bar", etc).
 *
 * Language coverage (scoped pragmatically per the milestone): JavaScript, TypeScript,
 * and TSX. Files in any other language return [] (best-effort) — multi-language support
 * is explicitly out of scope for M2. See `LANGUAGE_BY_EXT`.
 *
 * WASM loading: `web-tree-sitter` needs (1) its own runtime wasm and (2) a grammar wasm
 * per language. We load the runtime (`tree-sitter.wasm`) from the installed
 * `web-tree-sitter` package and the grammar wasms from the prebuilt `tree-sitter-wasms`
 * package, both resolved as absolute file paths from node_modules via `createRequire`.
 * `Parser.init()` and each `Language.load()` are memoized so we pay the wasm load once
 * per process.
 *
 * Version note: `web-tree-sitter` is pinned to 0.25.x. The 0.26 line changed the
 * grammar-wasm dylink ABI and fails to load the prebuilt `tree-sitter-wasms@0.1.13`
 * grammars (`getDylinkMetadata` error); 0.25.x loads them cleanly. Keep them aligned.
 */

import { createRequire } from "node:module";
import { extname } from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { Neighbor } from "../domain/scaffold.ts";

const require = createRequire(import.meta.url);

/** Cap on neighbors returned per region (CONTEXT.md: bounded). */
export const DEFAULT_NEIGHBOR_CAP = 10;

type GrammarName = "typescript" | "tsx" | "javascript";

/** Map a file extension to the grammar that parses it, or null if unsupported. */
const LANGUAGE_BY_EXT: Record<string, GrammarName> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "tsx",
};

/** Grammar wasm filenames within the tree-sitter-wasms package `out/` dir. */
const GRAMMAR_WASM: Record<GrammarName, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
};

let parserInit: Promise<void> | null = null;
const languageCache = new Map<GrammarName, Promise<Language>>();

function initParser(): Promise<void> {
  if (!parserInit) {
    const runtimeWasm = require.resolve("web-tree-sitter/tree-sitter.wasm");
    parserInit = Parser.init({
      locateFile: () => runtimeWasm,
    });
  }
  return parserInit;
}

function loadLanguage(name: GrammarName): Promise<Language> {
  let cached = languageCache.get(name);
  if (!cached) {
    const wasmPath = require.resolve(`tree-sitter-wasms/out/${GRAMMAR_WASM[name]}`);
    cached = Language.load(wasmPath);
    languageCache.set(name, cached);
  }
  return cached;
}

/** Node types that introduce a named definition we treat as a graph node. */
const DEFINITION_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "method_definition",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "lexical_declaration", // const/let — may bind an arrow fn or value
  "variable_declaration",
]);

interface Definition {
  name: string;
  kind: string; // human word for the oneLine, e.g. "function", "class"
  signature: string;
  startLine: number; // 1-based
  endLine: number; // 1-based
  node: Node;
}

/**
 * Graph neighbors for the changed region [startLine,endLine] (1-based, RIGHT-side / new
 * file coordinates) of `file` within `worktreePath`. Returns [] for unsupported
 * languages or unreadable files — best-effort, never throws for those cases.
 */
export async function findNeighbors(
  worktreePath: string,
  file: string,
  startLine: number,
  endLine: number,
  cap: number = DEFAULT_NEIGHBOR_CAP,
): Promise<Neighbor[]> {
  const grammar = LANGUAGE_BY_EXT[extname(file).toLowerCase()];
  if (!grammar) return []; // unsupported language

  const { readFile } = await import("node:fs/promises");
  const { join, isAbsolute } = await import("node:path");
  const abs = isAbsolute(file) ? file : join(worktreePath, file);

  let source: string;
  try {
    source = await readFile(abs, "utf8");
  } catch {
    return [];
  }

  return neighborsFromSource(source, grammar, startLine, endLine, cap);
}

/**
 * The pure core: given source text + grammar, compute neighbors for a line range.
 * Exported for unit tests (no filesystem, no worktree).
 */
export async function neighborsFromSource(
  source: string,
  grammar: GrammarName,
  startLine: number,
  endLine: number,
  cap: number = DEFAULT_NEIGHBOR_CAP,
): Promise<Neighbor[]> {
  await initParser();
  const language = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(language);

  const tree = parser.parse(source);
  if (!tree) return [];
  const root = tree.rootNode;

  // Collect all named definitions in the file (top-level + nested methods).
  const defs = collectDefinitions(root);

  const neighbors: Neighbor[] = [];
  const seenRefs = new Set<string>();
  const push = (n: Neighbor) => {
    if (seenRefs.has(n.ref)) return;
    seenRefs.add(n.ref);
    neighbors.push(n);
  };

  // 1) Enclosing definitions: any def whose range overlaps the changed region. These
  // are the "you are here" graph nodes — the region's own function/class.
  const enclosing = defs.filter(
    (d) => d.startLine <= endLine && d.endLine >= startLine,
  );
  for (const d of enclosing) {
    push(toNeighbor(d, "definition enclosing the changed lines"));
  }

  // 2) Referenced symbols: identifiers used inside the region that resolve to a
  // top-level definition elsewhere in the file (callees / used definitions).
  const referencedNames = collectIdentifiersInRange(root, startLine, endLine);
  const enclosingSet = new Set(enclosing);
  for (const d of defs) {
    if (enclosingSet.has(d)) continue;
    if (referencedNames.has(d.name)) {
      push(toNeighbor(d, "referenced by the changed lines"));
    }
    if (neighbors.length >= cap) break;
  }

  tree.delete();
  parser.delete();
  return neighbors.slice(0, cap);
}

function toNeighbor(d: Definition, why: string): Neighbor {
  return {
    ref: `${d.name}`,
    signature: d.signature,
    oneLine: `${d.kind} ${d.name} — ${why}`,
  };
}

/** Walk the tree collecting named definitions. */
function collectDefinitions(root: Node): Definition[] {
  const out: Definition[] = [];
  const visit = (node: Node) => {
    if (DEFINITION_TYPES.has(node.type)) {
      const def = describeDefinition(node);
      if (def) out.push(def);
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return out;
}

/** Extract name/kind/signature from a definition node, or null if it has no name. */
function describeDefinition(node: Node): Definition | null {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const mk = (name: string | null, kind: string): Definition | null => {
    if (!name) return null;
    return { name, kind, signature: signatureOf(node), startLine, endLine, node };
  };

  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      return mk(nameField(node), "function");
    case "class_declaration":
      return mk(nameField(node), "class");
    case "interface_declaration":
      return mk(nameField(node), "interface");
    case "type_alias_declaration":
      return mk(nameField(node), "type");
    case "enum_declaration":
      return mk(nameField(node), "enum");
    case "method_definition":
      return mk(nameField(node), "method");
    case "lexical_declaration":
    case "variable_declaration": {
      // Take the first variable_declarator with an identifier name. Classify as
      // "function" when it binds an arrow/function expression, else "value".
      const declarator = node.namedChildren.find(
        (c) => c?.type === "variable_declarator",
      );
      if (!declarator) return null;
      const nameNode = declarator.childForFieldName("name");
      const value = declarator.childForFieldName("value");
      const kind =
        value &&
        (value.type === "arrow_function" ||
          value.type === "function_expression" ||
          value.type === "function")
          ? "function"
          : "value";
      return mk(nameNode?.text ?? null, kind);
    }
    default:
      return null;
  }
}

function nameField(node: Node): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

/**
 * A one-line signature: the definition's first source line, trimmed. For a body-bearing
 * definition we cut at the opening `{` so we never inline the body (source is hydrated
 * lazily, not here).
 */
function signatureOf(node: Node): string {
  const firstLine = node.text.split("\n")[0] ?? "";
  const braceIdx = firstLine.indexOf("{");
  const sig = braceIdx === -1 ? firstLine : firstLine.slice(0, braceIdx);
  return sig.trim();
}

/** Names of identifiers appearing within the [startLine,endLine] range (1-based). */
function collectIdentifiersInRange(
  root: Node,
  startLine: number,
  endLine: number,
): Set<string> {
  const names = new Set<string>();
  const visit = (node: Node) => {
    const nodeStart = node.startPosition.row + 1;
    const nodeEnd = node.endPosition.row + 1;
    // Prune subtrees entirely outside the range.
    if (nodeEnd < startLine || nodeStart > endLine) return;
    if (
      node.type === "identifier" ||
      node.type === "type_identifier" ||
      node.type === "property_identifier"
    ) {
      if (nodeStart >= startLine && nodeStart <= endLine) {
        names.add(node.text);
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return names;
}
