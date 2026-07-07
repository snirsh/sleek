import { describe, expect, it } from "vitest";

import type { Anchor } from "../domain/scaffold.ts";
import type { Comment, Review, Thread } from "../domain/threads.ts";
import { buildReviewExport, parseRepoIdentity } from "./github.ts";

const NOW = "2026-07-02T10:00:00.000Z";

function makeAnchor(partial: Partial<Anchor> = {}): Anchor {
  return {
    file: "src/util.ts",
    side: "RIGHT",
    startLine: 10,
    endLine: 10,
    ...partial,
  };
}

let nextId = 0;
function comment(
  author: Comment["author"],
  body: string,
  extra: Partial<Comment> = {},
): Comment {
  return {
    id: `c-${nextId++}`,
    author,
    body,
    createdAt: NOW,
    pending: false,
    ...extra,
  };
}

function findingComment(body: string): Comment {
  return comment({ type: "finding" }, body, {
    concern: "correctness",
    severity: "major",
  });
}

function thread(anchor: Anchor, comments: [Comment, ...Comment[]]): Thread {
  return { id: `t-${nextId++}`, anchor, status: "open", comments };
}

function review(partial: Partial<Review> = {}): Review {
  return {
    verdict: "comment",
    summary: "Overall looks good.",
    submittedAt: NOW,
    ...partial,
  };
}

describe("buildReviewExport", () => {
  it("maps each verdict to its GitHub event", () => {
    expect(buildReviewExport(review({ verdict: "approve" }), []).payload.event).toBe(
      "APPROVE",
    );
    expect(
      buildReviewExport(review({ verdict: "request_changes" }), []).payload.event,
    ).toBe("REQUEST_CHANGES");
    expect(buildReviewExport(review({ verdict: "comment" }), []).payload.event).toBe(
      "COMMENT",
    );
  });

  it("uses the review summary as the payload body", () => {
    const { payload } = buildReviewExport(review({ summary: "ship it" }), []);
    expect(payload.body).toBe("ship it");
  });

  it("exports only reviewer-authored comments (finding/assistant stay local)", () => {
    const t = thread(makeAnchor(), [
      findingComment("possible off-by-one"),
      comment({ type: "reviewer" }, "agreed, please fix"),
      comment({ type: "assistant", model: "qwen3" }, "the loop bound is exclusive"),
    ]);
    const { payload } = buildReviewExport(review(), [t]);
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]!.body).toBe("agreed, please fix");
  });

  it("filters local-only reviewer comments from the payload", () => {
    const t = thread(makeAnchor(), [
      comment({ type: "reviewer" }, "publish this"),
      comment({ type: "reviewer" }, "keep local", { visibility: "local" }),
      comment({ type: "reviewer" }, "explicitly publish", {
        visibility: "publishable",
      }),
    ]);
    const { payload, excludedLocalCount } = buildReviewExport(review(), [t]);
    expect(payload.comments.map((c) => c.body)).toEqual([
      "publish this",
      "explicitly publish",
    ]);
    expect(excludedLocalCount).toBe(1);
  });

  it("counts excludedLocalCount only for reviewer-authored local comments", () => {
    const t = thread(makeAnchor(), [
      findingComment("finding"),
      comment({ type: "assistant", model: "qwen3" }, "assistant", {
        visibility: "local",
      }),
      comment({ type: "reviewer" }, "reviewer local", {
        visibility: "local",
      }),
    ]);
    const { payload, excludedLocalCount } = buildReviewExport(review(), [t]);
    expect(payload.comments).toEqual([]);
    expect(excludedLocalCount).toBe(1);
  });

  it("anchors a single-line comment at endLine WITHOUT start_line/start_side", () => {
    const t = thread(makeAnchor({ startLine: 12, endLine: 12 }), [
      comment({ type: "reviewer" }, "rename this"),
    ]);
    const { payload } = buildReviewExport(review(), [t]);
    expect(payload.comments[0]).toEqual({
      path: "src/util.ts",
      side: "RIGHT",
      line: 12,
      body: "rename this",
    });
    expect(payload.comments[0]).not.toHaveProperty("start_line");
    expect(payload.comments[0]).not.toHaveProperty("start_side");
  });

  it("includes start_line/start_side for multi-line ranges", () => {
    const t = thread(makeAnchor({ startLine: 3, endLine: 7 }), [
      comment({ type: "reviewer" }, "extract this block"),
    ]);
    const { payload } = buildReviewExport(review(), [t]);
    expect(payload.comments[0]).toEqual({
      path: "src/util.ts",
      side: "RIGHT",
      line: 7,
      start_line: 3,
      start_side: "RIGHT",
      body: "extract this block",
    });
  });

  it("addresses deleted lines via LEFT-side anchors", () => {
    const t = thread(
      makeAnchor({ side: "LEFT", startLine: 40, endLine: 42, file: "old.ts" }),
      [comment({ type: "reviewer" }, "why was this removed?")],
    );
    const { payload } = buildReviewExport(review(), [t]);
    expect(payload.comments[0]).toMatchObject({
      path: "old.ts",
      side: "LEFT",
      line: 42,
      start_line: 40,
      start_side: "LEFT",
    });
  });

  it("passes suggestion fences through verbatim", () => {
    const body =
      "Use the helper instead:\n```suggestion\nconst x = clamp(y);\n```\n";
    const t = thread(makeAnchor(), [comment({ type: "reviewer" }, body)]);
    const { payload } = buildReviewExport(review(), [t]);
    expect(payload.comments[0]!.body).toBe(body);
  });

  it("exports multiple reviewer comments on one thread as separate entries, in order", () => {
    const anchor = makeAnchor({ startLine: 5, endLine: 9 });
    const t = thread(anchor, [
      findingComment("finding"),
      comment({ type: "reviewer" }, "first"),
      comment({ type: "assistant", model: "qwen3" }, "answer"),
      comment({ type: "reviewer" }, "second"),
    ]);
    const { payload } = buildReviewExport(review(), [t]);
    expect(payload.comments.map((c) => c.body)).toEqual(["first", "second"]);
    expect(payload.comments[0]).toMatchObject({ line: 9, start_line: 5 });
    expect(payload.comments[1]).toMatchObject({ line: 9, start_line: 5 });
  });

  it("skips threads with zero reviewer comments", () => {
    const t = thread(makeAnchor(), [findingComment("only a finding")]);
    const { payload, preview } = buildReviewExport(review(), [t]);
    expect(payload.comments).toEqual([]);
    expect(preview.commentCount).toBe(0);
    expect(preview.files).toEqual([]);
  });

  it("builds a valid summary-only payload when there are no comments at all", () => {
    const { payload, preview } = buildReviewExport(
      review({ verdict: "approve", summary: "LGTM" }),
      [],
    );
    expect(payload).toEqual({ event: "APPROVE", body: "LGTM", comments: [] });
    expect(preview).toEqual({
      verdict: "approve",
      event: "APPROVE",
      commentCount: 0,
      files: [],
      hasSummary: true,
    });
  });

  it("previews comment count and unique files in first-seen order", () => {
    const threads = [
      thread(makeAnchor({ file: "b.ts" }), [comment({ type: "reviewer" }, "one")]),
      thread(makeAnchor({ file: "a.ts" }), [comment({ type: "reviewer" }, "two")]),
      thread(makeAnchor({ file: "b.ts", startLine: 30, endLine: 30 }), [
        comment({ type: "reviewer" }, "three"),
      ]),
    ];
    const { preview } = buildReviewExport(review({ summary: "  " }), threads);
    expect(preview.commentCount).toBe(3);
    expect(preview.files).toEqual(["b.ts", "a.ts"]);
    expect(preview.hasSummary).toBe(false);
  });

  it("excludes pending reviewer comments and counts them in excludedPendingCount", () => {
    const t = thread(makeAnchor(), [
      comment({ type: "reviewer" }, "pending draft", { pending: true }),
      comment({ type: "reviewer" }, "submitted comment", { pending: false }),
    ]);
    const { payload, excludedPendingCount, excludedLocalCount } = buildReviewExport(review(), [t]);
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]!.body).toBe("submitted comment");
    expect(excludedPendingCount).toBe(1);
    expect(excludedLocalCount).toBe(0);
  });

  it("returns excludedPendingCount:0 when there are no pending reviewer comments", () => {
    const { excludedPendingCount } = buildReviewExport(review(), []);
    expect(excludedPendingCount).toBe(0);
  });
});

describe("parseRepoIdentity", () => {
  it("parses https URLs, with and without .git / trailing slash", () => {
    expect(parseRepoIdentity("https://github.com/acme/rocket")).toEqual(
      { owner: "acme", repo: "rocket" },
    );
    expect(parseRepoIdentity("https://github.com/o/r.git")).toEqual({
      owner: "o",
      repo: "r",
    });
    expect(parseRepoIdentity("https://github.com/o/r/")).toEqual({
      owner: "o",
      repo: "r",
    });
  });

  it("parses the ssh remote form", () => {
    expect(parseRepoIdentity("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseRepoIdentity("https://gitlab.com/o/r")).toBeNull();
    expect(parseRepoIdentity("not a url")).toBeNull();
  });
});
