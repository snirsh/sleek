/**
 * Wave-6 friendly error messages. Maps IngestError kinds and other known
 * failure modes to 2-3 line human messages with the exact next command.
 * Pure — no side-effects, fully testable.
 */

import type { IngestErrorKind } from "../ingest/ingest.ts";

export interface FriendlyError {
  /** Short headline (one line). */
  headline: string;
  /** 1-2 lines of detail / remediation. */
  detail: string;
  /** Exit code: 1 = user/env error, 2 = unexpected. */
  exitCode: 1 | 2;
}

/**
 * Map an IngestError kind to a friendly message with the exact next command.
 * Pass `context` for runtime info like the PR number and repo path.
 */
export function friendlyIngestError(
  kind: IngestErrorKind,
  context: { prNumber?: number; repoPath?: string } = {},
): FriendlyError {
  const { prNumber, repoPath } = context;

  switch (kind) {
    case "gh-not-installed":
      return {
        headline: "GitHub CLI (gh) is not installed.",
        detail:
          "Install it with:  brew install gh\n" +
          "Or set the path:  SLEEK_GH_BIN=/path/to/gh sleek review ...",
        exitCode: 1,
      };

    case "gh-not-authenticated":
      return {
        headline: "gh is not authenticated.",
        detail:
          "Run:  gh auth login\n" +
          "Then retry the sleek command.",
        exitCode: 1,
      };

    case "repo-not-found":
      return {
        headline: `Repository path not found: ${repoPath ?? "(unknown)"}`,
        detail:
          "Pass a valid repo path with:  --repo /path/to/your/repo\n" +
          "Or cd into the repo and run sleek from there.",
        exitCode: 1,
      };

    case "pr-not-found":
      return {
        headline: `PR #${prNumber ?? "?"} not found.`,
        detail:
          "List open PRs with:  gh pr list\n" +
          "Or pick interactively:  sleek review  (no args)",
        exitCode: 1,
      };

    case "gh-failed":
      return {
        headline: "gh command failed.",
        detail:
          "Try running manually to see the full error:\n" +
          `  gh pr view ${prNumber ?? "<pr>"} --json number,title,headRefOid`,
        exitCode: 1,
      };

    case "bad-output":
      return {
        headline: "gh returned unexpected output.",
        detail:
          "This is likely a gh version incompatibility. Check:  gh --version\n" +
          "Expected fields: number, title, body, baseRefOid, headRefOid, files.",
        exitCode: 2,
      };
  }
}

/**
 * Map the "missing authored review" error (thrown by buildDemoScaffold) to a
 * friendly message explaining the authoring workflow.
 */
export function friendlyMissingReviewError(
  prNumber: number,
  repoPath: string,
): FriendlyError {
  return {
    headline: `No authored review for PR #${prNumber}.`,
    detail:
      `Author one in scripts/reviews/${prNumber}.json:\n` +
      `  1. Print the regions to tile:\n` +
      `       npx tsx scripts/dump-regions.ts ${repoPath} ${prNumber}\n` +
      `  2. Write scripts/reviews/${prNumber}.json (see format in scripts/demo-data.ts).\n` +
      `\n` +
      `Or use a live scaffolder (no authored review needed):\n` +
      `  SLEEK_SCAFFOLDER_PROVIDER=claude (or codex) sleek review ${prNumber} --repo ${repoPath}\n` +
      `  See docs/CLI-AGENTS.md for all SLEEK_SCAFFOLDER_PROVIDER options.`,
    exitCode: 1,
  };
}

/** Format a FriendlyError for stderr output. */
export function formatFriendlyError(err: FriendlyError): string {
  return `Error: ${err.headline}\n${err.detail}`;
}
