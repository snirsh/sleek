import { z } from "zod";

import { AnchorSchema, ConcernSchema, SeveritySchema } from "./scaffold.ts";

/**
 * The Wave-2 thread model: the single conversation primitive (see CONTEXT.md
 * "Threads & review" and docs/UI-ROADMAP.md "The one structural decision").
 *
 * A Thread is an Anchor-attached discussion with a status and an ordered,
 * non-empty list of Comments. Scaffolder Findings open Threads (their opening
 * Comment is finding-authored and carries the Finding's Concern + severity);
 * the Reviewer and the Assistant reply into them. Reviewer Comments start out
 * pending (part of the Review draft) until the Review is submitted with a
 * verdict.
 *
 * Zod schemas are the single source of truth; types are inferred.
 */

// --- CommentAuthor --------------------------------------------------------------------
// The typed author of a Comment: the Scaffolder's Finding that opened the Thread,
// the human Reviewer, or the Assistant (tagged with the local model that answered).
export const CommentAuthorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("finding") }),
  z.object({ type: z.literal("reviewer") }),
  z.object({ type: z.literal("assistant"), model: z.string() }),
]);
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;

// --- Comment ----------------------------------------------------------------------------
// One entry in a Thread. `pending: true` means the Comment is part of the Review
// draft (not yet submitted). Finding-authored comments additionally carry the
// Finding's Concern + severity; the refinement below enforces that.
export const CommentSchema = z
  .object({
    id: z.string(),
    author: CommentAuthorSchema,
    body: z.string(), // markdown
    createdAt: z.string().datetime(), // ISO-8601 UTC
    pending: z.boolean(),
    concern: ConcernSchema.optional(),
    severity: SeveritySchema.optional(),
    visibility: z.enum(["publishable", "local"]).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.author.type !== "finding") return;
    if (c.concern === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["concern"],
        message: "finding-authored comments must carry a concern",
      });
    }
    if (c.severity === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["severity"],
        message: "finding-authored comments must carry a severity",
      });
    }
  });
export type Comment = z.infer<typeof CommentSchema>;

// --- Thread -----------------------------------------------------------------------------
export const ThreadStatusSchema = z.enum(["open", "resolved"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ThreadSchema = z.object({
  id: z.string(),
  anchor: AnchorSchema,
  status: ThreadStatusSchema,
  comments: z.array(CommentSchema).nonempty(),
});
export type Thread = z.infer<typeof ThreadSchema>;

// --- Review -----------------------------------------------------------------------------
// The Reviewer's batched verdict on a PR: submitting finalizes all pending
// Comments with a verdict and an optional (possibly empty) markdown summary.
export const ReviewVerdictSchema = z.enum([
  "approve",
  "request_changes",
  "comment",
]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewSchema = z.object({
  verdict: ReviewVerdictSchema,
  summary: z.string(), // markdown
  submittedAt: z.string().datetime(), // ISO-8601 UTC
});
export type Review = z.infer<typeof ReviewSchema>;

// --- Parse helpers ------------------------------------------------------------------------

/** Validate arbitrary data as a Comment. Throws (ZodError) on failure. */
export function parseComment(data: unknown): Comment {
  return CommentSchema.parse(data);
}

/** Validate arbitrary data as a Thread. Throws (ZodError) on failure. */
export function parseThread(data: unknown): Thread {
  return ThreadSchema.parse(data);
}

/** Validate arbitrary data as a Review. Throws (ZodError) on failure. */
export function parseReview(data: unknown): Review {
  return ReviewSchema.parse(data);
}
