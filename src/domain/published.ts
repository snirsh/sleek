import { AnchorSchema, type Anchor } from "./scaffold.ts";

export type PublishedCommentSource =
  | "github-review-comment"
  | "github-review"
  | "github-issue-comment";

export interface PublishedComment {
  id: string;
  source: PublishedCommentSource;
  authorLogin: string;
  authorAvatarUrl?: string;
  authorUrl?: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
  anchor?: Anchor;
  reviewId?: string;
  inReplyToId?: string;
  state?: string;
}

export interface PublishedConversationSnapshot {
  fetchedAt: string;
  comments: PublishedComment[];
  errors: string[];
}

interface GhUser {
  login?: unknown;
  avatar_url?: unknown;
  html_url?: unknown;
}

interface GhReviewComment {
  id?: unknown;
  pull_request_review_id?: unknown;
  user?: GhUser | null;
  body?: unknown;
  created_at?: unknown;
  html_url?: unknown;
  path?: unknown;
  side?: unknown;
  line?: unknown;
  start_side?: unknown;
  start_line?: unknown;
  original_side?: unknown;
  original_line?: unknown;
  in_reply_to_id?: unknown;
}

interface GhReview {
  id?: unknown;
  user?: GhUser | null;
  body?: unknown;
  submitted_at?: unknown;
  html_url?: unknown;
  state?: unknown;
}

interface GhIssueComment {
  id?: unknown;
  user?: GhUser | null;
  body?: unknown;
  created_at?: unknown;
  html_url?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function id(value: unknown): string | null {
  return typeof value === "number" || typeof value === "string" ? String(value) : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function login(user: GhUser | null | undefined): string {
  return typeof user?.login === "string" ? user.login : "unknown";
}

function userExtras(user: GhUser | null | undefined): Pick<PublishedComment, "authorAvatarUrl" | "authorUrl"> {
  return {
    ...(typeof user?.avatar_url === "string" ? { authorAvatarUrl: user.avatar_url } : {}),
    ...(typeof user?.html_url === "string" ? { authorUrl: user.html_url } : {}),
  };
}

function reviewCommentAnchor(c: GhReviewComment): Anchor | undefined {
  const file = str(c.path);
  if (!file) return undefined;

  const rawSide = str(c.side) ?? str(c.original_side);
  const side = rawSide === "LEFT" ? "LEFT" : rawSide === "RIGHT" ? "RIGHT" : undefined;
  const endLine = int(c.line) ?? int(c.original_line);
  if (!side || endLine === null) return undefined;

  const startLine = int(c.start_line) ?? int(c.line) ?? endLine;
  const startSide = str(c.start_side);
  const anchor = {
    file,
    side: startSide === "LEFT" || startSide === "RIGHT" ? startSide : side,
    startLine,
    endLine,
  };
  const parsed = AnchorSchema.safeParse(anchor);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeGithubReviewComments(
  comments: readonly unknown[],
): PublishedComment[] {
  const out: PublishedComment[] = [];
  for (const raw of comments) {
    const c = raw as GhReviewComment;
    const commentId = id(c.id);
    const body = str(c.body);
    const createdAt = str(c.created_at);
    const htmlUrl = str(c.html_url);
    if (!commentId || body === null || !createdAt || !htmlUrl) continue;

    const reviewId = id(c.pull_request_review_id);
    const inReplyToId = id(c.in_reply_to_id);
    const anchor = reviewCommentAnchor(c);
    out.push({
      id: `github-review-comment:${commentId}`,
      source: "github-review-comment",
      authorLogin: login(c.user),
      ...userExtras(c.user),
      body,
      createdAt,
      htmlUrl,
      ...(reviewId ? { reviewId } : {}),
      ...(inReplyToId ? { inReplyToId: `github-review-comment:${inReplyToId}` } : {}),
      ...(anchor ? { anchor } : {}),
    });
  }
  return out;
}

export function normalizeGithubReviews(reviews: readonly unknown[]): PublishedComment[] {
  const out: PublishedComment[] = [];
  for (const raw of reviews) {
    const r = raw as GhReview;
    const reviewId = id(r.id);
    const createdAt = str(r.submitted_at);
    const htmlUrl = str(r.html_url);
    if (!reviewId || !createdAt || !htmlUrl) continue;
    out.push({
      id: `github-review:${reviewId}`,
      source: "github-review",
      authorLogin: login(r.user),
      ...userExtras(r.user),
      body: str(r.body) ?? "",
      createdAt,
      htmlUrl,
      reviewId,
      ...(str(r.state) ? { state: str(r.state)! } : {}),
    });
  }
  return out;
}

export function normalizeGithubIssueComments(
  comments: readonly unknown[],
): PublishedComment[] {
  const out: PublishedComment[] = [];
  for (const raw of comments) {
    const c = raw as GhIssueComment;
    const commentId = id(c.id);
    const body = str(c.body);
    const createdAt = str(c.created_at);
    const htmlUrl = str(c.html_url);
    if (!commentId || body === null || !createdAt || !htmlUrl) continue;
    out.push({
      id: `github-issue-comment:${commentId}`,
      source: "github-issue-comment",
      authorLogin: login(c.user),
      ...userExtras(c.user),
      body,
      createdAt,
      htmlUrl,
    });
  }
  return out;
}

export function emptyPublishedConversation(): PublishedConversationSnapshot {
  return { fetchedAt: new Date().toISOString(), comments: [], errors: [] };
}
