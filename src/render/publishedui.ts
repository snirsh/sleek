export interface PublishedUiComment {
  id: string;
  inReplyToId?: string;
  anchor?: {
    file: string;
    side: string;
    startLine: number;
    endLine: number;
  };
}

export interface PublishedCommentGroup<T extends PublishedUiComment = PublishedUiComment> {
  root: T;
  replies: T[];
}

/**
 * Group GitHub review-comment replies under their parent while preserving the
 * incoming chronological order. Orphan replies become standalone roots so a
 * partial GitHub response never drops visible comments.
 *
 * SHIPPING MODEL: this helper is injected into the browser from client.ts, so
 * keep the body self-contained and free of imports/module references.
 */
export function groupPublishedComments<T extends PublishedUiComment>(
  comments: readonly T[],
): PublishedCommentGroup<T>[] {
  const byId = new Map<string, T>();
  for (const c of comments) byId.set(c.id, c);

  const replies = new Map<string, T[]>();
  const replyIds = new Set<string>();
  for (const c of comments) {
    if (!c.inReplyToId || !byId.has(c.inReplyToId)) continue;
    replyIds.add(c.id);
    const list = replies.get(c.inReplyToId) || [];
    list.push(c);
    replies.set(c.inReplyToId, list);
  }

  const groups: PublishedCommentGroup<T>[] = [];
  for (const c of comments) {
    if (replyIds.has(c.id)) continue;
    groups.push({ root: c, replies: replies.get(c.id) || [] });
  }
  return groups;
}

export function publishedCommentCount(comments: readonly PublishedUiComment[]): number {
  return comments.length;
}
