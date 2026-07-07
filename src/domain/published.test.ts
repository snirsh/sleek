import { describe, expect, it } from "vitest";

import {
  normalizeGithubIssueComments,
  normalizeGithubReviewComments,
  normalizeGithubReviews,
} from "./published.ts";

describe("published conversation normalization", () => {
  it("normalizes GitHub PR review comments with anchors and replies", () => {
    const comments = normalizeGithubReviewComments([
      {
        id: 10,
        pull_request_review_id: 7,
        user: {
          login: "octo",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
          html_url: "https://github.com/octo",
        },
        body: "inline",
        created_at: "2026-01-01T00:00:00Z",
        html_url: "https://github.test/review-comment",
        path: "src/a.ts",
        side: "RIGHT",
        start_line: 4,
        line: 6,
      },
      {
        id: 11,
        pull_request_review_id: 7,
        in_reply_to_id: 10,
        user: { login: "hubot" },
        body: "reply",
        created_at: "2026-01-01T00:01:00Z",
        html_url: "https://github.test/reply",
        path: "src/a.ts",
        side: "RIGHT",
        line: 6,
      },
    ]);

    expect(comments).toEqual([
      {
        id: "github-review-comment:10",
        source: "github-review-comment",
        authorLogin: "octo",
        authorAvatarUrl: "https://avatars.githubusercontent.com/u/1",
        authorUrl: "https://github.com/octo",
        body: "inline",
        createdAt: "2026-01-01T00:00:00Z",
        htmlUrl: "https://github.test/review-comment",
        reviewId: "7",
        anchor: { file: "src/a.ts", side: "RIGHT", startLine: 4, endLine: 6 },
      },
      {
        id: "github-review-comment:11",
        source: "github-review-comment",
        authorLogin: "hubot",
        body: "reply",
        createdAt: "2026-01-01T00:01:00Z",
        htmlUrl: "https://github.test/reply",
        reviewId: "7",
        inReplyToId: "github-review-comment:10",
        anchor: { file: "src/a.ts", side: "RIGHT", startLine: 6, endLine: 6 },
      },
    ]);
  });

  it("normalizes PR review summaries", () => {
    expect(
      normalizeGithubReviews([
        {
          id: 99,
          state: "CHANGES_REQUESTED",
          user: { login: "reviewer" },
          body: "summary",
          submitted_at: "2026-01-02T00:00:00Z",
          html_url: "https://github.test/review",
        },
      ]),
    ).toEqual([
      {
        id: "github-review:99",
        source: "github-review",
        authorLogin: "reviewer",
        body: "summary",
        createdAt: "2026-01-02T00:00:00Z",
        htmlUrl: "https://github.test/review",
        reviewId: "99",
        state: "CHANGES_REQUESTED",
      },
    ]);
  });

  it("normalizes general PR conversation comments from issue comments", () => {
    expect(
      normalizeGithubIssueComments([
        {
          id: 123,
          user: { login: "commenter" },
          body: "top level",
          created_at: "2026-01-03T00:00:00Z",
          html_url: "https://github.test/issue-comment",
        },
      ]),
    ).toEqual([
      {
        id: "github-issue-comment:123",
        source: "github-issue-comment",
        authorLogin: "commenter",
        body: "top level",
        createdAt: "2026-01-03T00:00:00Z",
        htmlUrl: "https://github.test/issue-comment",
      },
    ]);
  });
});
