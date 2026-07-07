import { describe, expect, it } from "vitest";

import { groupPublishedComments, publishedCommentCount } from "./publishedui.ts";

describe("published GitHub comment UI helpers", () => {
  it("groups review-comment replies under their parent in chronological order", () => {
    const comments = [
      { id: "github-review-comment:1", body: "root" },
      {
        id: "github-review-comment:2",
        inReplyToId: "github-review-comment:1",
        body: "first reply",
      },
      {
        id: "github-review-comment:3",
        inReplyToId: "github-review-comment:1",
        body: "second reply",
      },
      { id: "github-issue-comment:4", body: "issue comment" },
    ];

    expect(groupPublishedComments(comments)).toEqual([
      {
        root: comments[0],
        replies: [comments[1], comments[2]],
      },
      {
        root: comments[3],
        replies: [],
      },
    ]);
  });

  it("keeps orphan replies as standalone groups", () => {
    const orphan = {
      id: "github-review-comment:2",
      inReplyToId: "github-review-comment:missing",
      body: "orphan reply",
    };

    expect(groupPublishedComments([orphan])).toEqual([{ root: orphan, replies: [] }]);
  });

  it("counts every synced GitHub comment, including replies", () => {
    expect(publishedCommentCount([{ id: "a" }, { id: "b", inReplyToId: "a" }])).toBe(2);
  });
});
