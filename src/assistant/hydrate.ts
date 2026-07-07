/**
 * Lazy neighbor-source hydration.
 *
 * Per CONTEXT.md/ADR-0001, a Context Bundle carries graph neighbors as
 * references + one-line descriptions only — their **source is hydrated lazily
 * by the backend**, never pre-stuffed into the Bundle. This module reads a
 * neighbor's source from the worktree on demand, bounded, when the Assistant
 * (or Reviewer) wants to look closer at a specific neighbor.
 *
 * ## Neighbor `ref` format (reconcile with M2's neighbors.ts)
 *
 * M2's `neighbors.ts` currently emits a **bare symbol name** as the `ref`
 * (e.g. `"helper"`) — a symbol defined somewhere in the *same file* as the
 * changed region. A bare name alone can't be located on disk, so hydration
 * needs a file to resolve against.
 *
 * We therefore define a small superset ref grammar and parse it here; a bare
 * name is the degenerate case:
 *
 *   ref            := <path>["#"<symbol>] | <path>":"<start>["-"<end>] | <symbol>
 *   e.g.  "src/util.ts#helper"    → file + symbol (line range unknown → whole file, bounded)
 *         "src/util.ts:10-42"     → file + explicit 1-based line range
 *         "src/util.ts"           → whole file (bounded)
 *         "helper"                → bare symbol; requires a `fileHint` to locate
 *
 * When the ref has no file part (the M2 bare-name case), the caller must supply
 * `fileHint` — the file the neighbor was found in (the changed region's file).
 * With a symbol but no line range, we return the file's head (bounded) rather
 * than trying to re-parse it; the Assistant reads the symbol out of that slice.
 * This keeps hydration dependency-free and deterministic. When M2 is upgraded
 * to emit `path#symbol` or `path:start-end` refs, this parser already accepts
 * them with no change.
 */

import { isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";

/** Default cap on hydrated lines, so a neighbor never blows the window. */
export const DEFAULT_MAX_LINES = 120;

/** Injectable file reader so tests need no filesystem. */
export type FileReader = (absPath: string) => Promise<string>;

const defaultFileReader: FileReader = (absPath) => readFile(absPath, "utf8");

/**
 * Containment check mirroring `fileWithinRoot` in src/server/opensource.ts
 * (not importable from here without an assistant→server dependency): resolve
 * the path against the root, reject anything that escapes lexically, then
 * re-check through symlinks. Returns the absolute path when inside the root,
 * null otherwise.
 */
function fileWithinRoot(root: string, file: string): string | null {
  if (file.trim() === "") return null;
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  // Symlink re-check: resolve through symlinks and verify containment again.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  let realAbs: string;
  try {
    realAbs = realpathSync(abs);
  } catch {
    // File doesn't exist — no symlink to exploit; pass through as null-safe.
    return abs;
  }
  const realRel = relative(realRoot, realAbs);
  if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) return null;
  return abs;
}

/** A parsed neighbor ref. `startLine`/`endLine` are 1-based when present. */
export interface ParsedRef {
  file: string | null;
  symbol: string | null;
  startLine: number | null;
  endLine: number | null;
}

/**
 * Parse a neighbor ref into its parts. Exported for unit testing and reuse.
 *
 * A ref is treated as "has a file" when it contains a path separator, a dot
 * (extension), or an explicit `#`/`:` marker; otherwise it's a bare symbol.
 */
export function parseRef(ref: string): ParsedRef {
  const empty: ParsedRef = {
    file: null,
    symbol: null,
    startLine: null,
    endLine: null,
  };

  // path#symbol
  const hashIdx = ref.indexOf("#");
  if (hashIdx !== -1) {
    return {
      ...empty,
      file: ref.slice(0, hashIdx) || null,
      symbol: ref.slice(hashIdx + 1) || null,
    };
  }

  // path:start[-end]  — the colon must precede a line number to count as a range
  const colonIdx = ref.lastIndexOf(":");
  if (colonIdx !== -1) {
    const rangePart = ref.slice(colonIdx + 1);
    const m = /^(\d+)(?:-(\d+))?$/.exec(rangePart);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] !== undefined ? Number(m[2]) : start;
      return {
        ...empty,
        file: ref.slice(0, colonIdx) || null,
        startLine: start,
        endLine: end,
      };
    }
  }

  // Looks like a file path (has a separator or a dot) → whole-file ref
  if (ref.includes("/") || ref.includes(".")) {
    return { ...empty, file: ref };
  }

  // Bare symbol (the M2 case)
  return { ...empty, symbol: ref };
}

/**
 * Read a neighbor's source from the worktree, bounded to `maxLines`.
 *
 * @param worktreePath  the git worktree the scaffold was built against (M2)
 * @param ref           a neighbor `ref` (see the grammar above)
 * @param maxLines      cap on returned lines (default DEFAULT_MAX_LINES)
 * @param opts.fileHint file to resolve a bare-symbol ref against (M2 refs)
 * @param opts.readFile injectable reader (tests)
 *
 * Best-effort: returns "" if the file can't be located or read, rather than
 * throwing — a missing neighbor source must never break the answer path.
 */
export async function hydrateNeighborSource(
  worktreePath: string,
  ref: string,
  maxLines: number = DEFAULT_MAX_LINES,
  opts: { fileHint?: string; readFile?: FileReader } = {},
): Promise<string> {
  const parsed = parseRef(ref);
  const file = parsed.file ?? opts.fileHint ?? null;
  if (!file) return ""; // bare symbol with no file to resolve against

  // Refs are model/PR-derived: never read outside the worktree, even via
  // absolute paths or `..` segments (fileWithinRoot also re-checks symlinks).
  const abs = fileWithinRoot(
    resolve(worktreePath),
    isAbsolute(file) ? file : join(worktreePath, file),
  );
  if (abs === null) return "";
  const read = opts.readFile ?? defaultFileReader;

  let source: string;
  try {
    source = await read(abs);
  } catch {
    return "";
  }

  const lines = source.split("\n");

  // Explicit line range → slice it (1-based, inclusive), then cap.
  if (parsed.startLine !== null) {
    const start = Math.max(1, parsed.startLine);
    const end = parsed.endLine ?? start;
    const slice = lines.slice(start - 1, end);
    return slice.slice(0, maxLines).join("\n");
  }

  // Symbol-only or whole-file → return the head of the file, bounded.
  return lines.slice(0, maxLines).join("\n");
}
