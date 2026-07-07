/**
 * Per changed file/region git history. We use `git log -L<start>,<end>:<file>`, which
 * walks the history of exactly the given line range (git tracks the range across
 * diffs), giving the recent commits that actually touched those lines rather than the
 * whole file. Results are mapped to HistoryEntry and bounded to a small count so the
 * Scaffolder (M3) has a tight, relevant slice to distill into the Context Bundle.
 *
 * The git invocation is injectable (`GitRunner`) so tests can drive `regionHistory`
 * off canned `git log` output without a real repository.
 */

import { simpleGit } from "simple-git";
import type { HistoryEntry } from "../domain/scaffold.ts";

/** How many commits to keep per region. Keeps the Bundle slice tight (CONTEXT.md). */
export const DEFAULT_HISTORY_LIMIT = 5;

/**
 * Runs a git command inside `worktreePath` and returns stdout. Injectable for tests.
 */
export type GitRunner = (worktreePath: string, args: string[]) => Promise<string>;

const defaultGitRunner: GitRunner = (worktreePath, args) =>
  simpleGit(worktreePath).raw(args);

// A record separator unlikely to appear in a commit subject, so we can split cleanly.
const REC_SEP = "\x1e";
const FIELD_SEP = "\x1f";

/**
 * Recent commits that touched lines `startLine`..`endLine` of `file`, newest first,
 * capped at `limit`. `whenRelevant` is the commit's relative date (e.g. "3 weeks ago")
 * — a human-readable hint the Scaffolder can fold into the Bundle.
 */
export async function regionHistory(
  worktreePath: string,
  file: string,
  startLine: number,
  endLine: number,
  limit: number = DEFAULT_HISTORY_LIMIT,
  gitRunner: GitRunner = defaultGitRunner,
): Promise<HistoryEntry[]> {
  // `-L a,b:file` follows the line range; `-s` suppresses the diff body; the pretty
  // format emits one record per commit with field/record separators we control.
  const format = `--format=${FIELD_SEP}%H${FIELD_SEP}%s${FIELD_SEP}%cr${REC_SEP}`;
  const args = [
    "log",
    `-L${startLine},${endLine}:${file}`,
    "-s",
    `--max-count=${limit}`,
    format,
  ];

  let out: string;
  try {
    out = await gitRunner(worktreePath, args);
  } catch {
    // A file with no history in this worktree (e.g. added in an uncommitted state) or
    // a range git can't follow — return nothing rather than failing the whole build.
    return [];
  }

  return parseLogOutput(out).slice(0, limit);
}

/**
 * Parse the record/field-separated `git log` output into HistoryEntry[]. Exported for
 * unit testing without a repo.
 */
export function parseLogOutput(stdout: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const record of stdout.split(REC_SEP)) {
    const trimmed = record.trim();
    if (trimmed === "") continue;
    // Each record begins with FIELD_SEP then sha/subject/date; leading noise before the
    // first FIELD_SEP (blank lines between records) is discarded.
    const firstSep = trimmed.indexOf(FIELD_SEP);
    if (firstSep === -1) continue;
    const fields = trimmed.slice(firstSep + 1).split(FIELD_SEP);
    const [sha, subject, whenRelevant] = fields;
    if (!sha) continue;
    entries.push({
      sha,
      subject: subject ?? "",
      whenRelevant: whenRelevant ?? "",
    });
  }
  return entries;
}
