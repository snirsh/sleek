/**
 * Wave 4A — pure mapping from Sleek's submitted Review + Threads to the GitHub
 * review payload for `POST /repos/{owner}/{repo}/pulls/{pr}/reviews`.
 *
 * Our Anchor format ({file, side: LEFT|RIGHT, startLine, endLine}) IS GitHub's
 * review-comment coordinate space (see docs/adr/0004-github-anchor-coordinates.md),
 * so the mapping is a projection, not a translation:
 *
 *   - `event` comes from the Review verdict, `body` from its summary.
 *   - `comments[]` carries every REVIEWER-authored Comment — finding- and
 *     assistant-authored comments are Sleek-local and never leave the machine.
 *   - Each comment is anchored at its Thread's Anchor. GitHub 422s when a
 *     single-line comment carries `start_line`, so the start_* fields appear
 *     only for true multi-line ranges.
 *   - Bodies pass through verbatim, so ```suggestion fences arrive intact.
 *
 * No I/O here: the `gh api` invocation lives in the server route
 * (POST /api/review/export in src/server/serve.ts); this module is the
 * unit-testable payload builder plus the human-readable preview the UI shows
 * before the Reviewer confirms the real post.
 */

import type { Review, ReviewVerdict, Thread } from "../domain/threads.ts";

/** One entry of the GitHub payload's `comments[]` (GitHub's field names). */
export interface GithubReviewComment {
  path: string;
  side: "LEFT" | "RIGHT";
  /** GitHub anchors a comment at its LAST line: our Anchor's endLine. */
  line: number;
  /** Present only for multi-line ranges (GitHub 422s on single-line start_line). */
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

export type GithubReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** The exact JSON body for `POST /repos/{owner}/{repo}/pulls/{pr}/reviews`. */
export interface GithubReviewPayload {
  event: GithubReviewEvent;
  body: string;
  comments: GithubReviewComment[];
}

/** What the UI shows in the confirmation step before the real post. */
export interface ExportPreview {
  verdict: ReviewVerdict;
  event: GithubReviewEvent;
  /** Number of reviewer Comments that will be posted inline. */
  commentCount: number;
  /** Files touched by those comments — unique, first-seen order. */
  files: string[];
  /** True when the Review summary is non-empty (it becomes the review body). */
  hasSummary: boolean;
}

export interface ReviewExportPlan {
  payload: GithubReviewPayload;
  preview: ExportPreview;
  /** Reviewer comments hidden from GitHub because they are local-only. */
  excludedLocalCount: number;
  /** Reviewer comments hidden from GitHub because they are still pending (draft Review). */
  excludedPendingCount: number;
}

const EVENT_BY_VERDICT: Record<ReviewVerdict, GithubReviewEvent> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

/**
 * Build the GitHub payload (and its UI preview) for a submitted Review.
 *
 * Only reviewer-authored Comments export; a Thread with none contributes
 * nothing (Finding threads the Reviewer never replied to stay local). A
 * Thread with several reviewer Comments exports each as its own entry at the
 * same Anchor, in Thread order. A review with zero exportable comments is
 * still valid — GitHub accepts a summary-only review.
 */
export function buildReviewExport(
  review: Review,
  threads: readonly Thread[],
): ReviewExportPlan {
  const comments: GithubReviewComment[] = [];
  const files: string[] = [];
  let excludedLocalCount = 0;
  let excludedPendingCount = 0;

  for (const thread of threads) {
    const { anchor } = thread;
    for (const comment of thread.comments) {
      if (comment.author.type !== "reviewer") continue;
      if (comment.pending) {
        excludedPendingCount++;
        continue;
      }
      if (comment.visibility === "local") {
        excludedLocalCount++;
        continue;
      }
      const multiLine = anchor.startLine !== anchor.endLine;
      comments.push({
        path: anchor.file,
        side: anchor.side,
        line: anchor.endLine,
        ...(multiLine
          ? { start_line: anchor.startLine, start_side: anchor.side }
          : {}),
        body: comment.body,
      });
      if (!files.includes(anchor.file)) files.push(anchor.file);
    }
  }

  const event = EVENT_BY_VERDICT[review.verdict];
  return {
    payload: { event, body: review.summary, comments },
    preview: {
      verdict: review.verdict,
      event,
      commentCount: comments.length,
      files,
      hasSummary: review.summary.trim() !== "",
    },
    excludedLocalCount,
    excludedPendingCount,
  };
}

/** The owner/name pair `gh api repos/{owner}/{repo}/…` needs. */
export interface RepoIdentity {
  owner: string;
  repo: string;
}

/**
 * Pull {owner, repo} out of a GitHub remote/repo URL — both the https form
 * (`https://github.com/owner/repo`, optionally `.git` or a trailing slash) and
 * the ssh form (`git@github.com:owner/repo.git`). Null for anything that is
 * not a github.com repo URL, in which case export is simply unavailable.
 */
export function parseRepoIdentity(url: string): RepoIdentity | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  );
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}
