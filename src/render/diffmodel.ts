/**
 * Unified-diff → files/hunks/rows model for the review renderer.
 *
 * parseUnifiedDiff turns `git diff` / `gh pr diff` text into {@link DiffFile}s whose
 * rows carry exact old/new line numbers — the coordinate system every other render
 * module (anchor mapping, layer scoping, intraline pairing) is built on.
 */

export type RowType = "add" | "del" | "ctx" | "hunk";

export interface DiffRow {
  type: RowType;
  /** Old-file line number (del/ctx rows), null otherwise. */
  oldLine: number | null;
  /** New-file line number (add/ctx rows), null otherwise. */
  newLine: number | null;
  /** Line content WITHOUT the +/-/space marker; full header text for hunk rows. */
  text: string;
}

export type FileStatus = "added" | "deleted" | "modified";

export interface DiffFile {
  path: string;
  rows: DiffRow[];
  adds: number;
  dels: number;
  /** From the ---/+++ header pair: /dev/null on the left → added, right → deleted. */
  status: FileStatus;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripAbPrefix(raw: string): string | null {
  if (raw === "/dev/null") return null;
  if (raw.startsWith("a/") || raw.startsWith("b/")) return raw.slice(2);
  return raw;
}

/**
 * Parse a unified diff (git diff / gh pr diff) into files → rows with exact old/new
 * line numbers. Hunk body extents are tracked via the @@ counts, so content lines
 * that themselves start with "---"/"+++" cannot be mistaken for file headers.
 * "\ No newline at end of file" markers are dropped and advance no counter.
 */
export function parseUnifiedDiff(unifiedDiff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let leftPath: string | null = null;
  let rightPath: string | null = null;

  // Remaining hunk-body lines per the current @@ header's counts.
  let oldRemain = 0;
  let newRemain = 0;
  let oldLine = 0;
  let newLine = 0;

  const inHunk = () => oldRemain > 0 || newRemain > 0;

  for (const line of unifiedDiff.split("\n")) {
    if (inHunk() && cur) {
      const marker = line[0];
      if (marker === "\\") continue; // "\ No newline at end of file": not a real line
      if (marker === "+") {
        cur.rows.push({ type: "add", oldLine: null, newLine, text: line.slice(1) });
        cur.adds++;
        newLine++;
        newRemain--;
      } else if (marker === "-") {
        cur.rows.push({ type: "del", oldLine, newLine: null, text: line.slice(1) });
        cur.dels++;
        oldLine++;
        oldRemain--;
      } else {
        // Context line (leading space) or bare empty line git sometimes emits.
        cur.rows.push({ type: "ctx", oldLine, newLine, text: line.slice(1) });
        oldLine++;
        newLine++;
        oldRemain--;
        newRemain--;
      }
      continue;
    }

    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = {
        path: m?.[2] ?? line.slice("diff --git ".length),
        rows: [],
        adds: 0,
        dels: 0,
        status: "modified",
      };
      files.push(cur);
      leftPath = null;
      rightPath = null;
      continue;
    }
    if (line.startsWith("--- ") && cur) {
      leftPath = stripAbPrefix(line.slice(4).trim());
      continue;
    }
    if (line.startsWith("+++ ") && cur) {
      rightPath = stripAbPrefix(line.slice(4).trim());
      // Prefer the RIGHT path (matches anchor keying in src/context/diff.ts).
      cur.path = rightPath ?? leftPath ?? cur.path;
      cur.status = leftPath === null ? "added" : rightPath === null ? "deleted" : "modified";
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header && cur) {
      oldLine = Number(header[1]);
      oldRemain = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      newRemain = header[4] === undefined ? 1 : Number(header[4]);
      cur.rows.push({ type: "hunk", oldLine: null, newLine: null, text: line });
      continue;
    }
    // Anything else (index/mode/rename/Binary lines) carries no rows.
  }
  return files;
}
