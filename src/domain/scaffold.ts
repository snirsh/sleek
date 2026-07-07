import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * The M0 contract: the Review Scaffold schema — the two-model contract between the
 * Scaffolder (large cloud model) and the Assistant (small local model).
 *
 * Zod schemas are the single source of truth. From each schema we derive both the
 * inferred TypeScript type and (for ReviewScaffold) a plain JSON Schema suitable for
 * Anthropic strict tool use.
 *
 * See CONTEXT.md for vocabulary and docs/PLAN.md §4 for the locked contract.
 */

const intSchema = z.number().int();

// --- Anchor (ADR-0004) --------------------------------------------------------------
// Where a Layer or Finding attaches, in GitHub review-comment coordinates.
export const AnchorSchema = z
  .object({
    file: z.string(),
    side: z.enum(["LEFT", "RIGHT"]),
    startLine: intSchema,
    endLine: intSchema,
  })
  .refine((a) => a.endLine >= a.startLine, {
    message: "endLine must be >= startLine",
    path: ["endLine"],
  });
export type Anchor = z.infer<typeof AnchorSchema>;

// --- Concern ------------------------------------------------------------------------
// The review lens a Finding belongs to. A tag on a Finding, never a structural unit.
export const ConcernSchema = z.enum([
  "correctness",
  "security",
  "performance",
  "tests",
  "maintainability",
]);
export type Concern = z.infer<typeof ConcernSchema>;

// --- Severity -----------------------------------------------------------------------
export const SeveritySchema = z.enum(["critical", "major", "minor", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

// --- Neighbor -----------------------------------------------------------------------
// A graph neighbor (caller/callee/definition) as a reference + one-line description.
// Source is hydrated lazily by the backend, NOT inlined here.
export const NeighborSchema = z.object({
  ref: z.string(),
  signature: z.string(),
  oneLine: z.string(),
});
export type Neighbor = z.infer<typeof NeighborSchema>;

// --- HistoryEntry -------------------------------------------------------------------
export const HistoryEntrySchema = z.object({
  sha: z.string(),
  subject: z.string(),
  whenRelevant: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// --- ContextBundle ------------------------------------------------------------------
// Budgeted, distilled artifact the Scaffolder attaches to a Layer.
// `learnings` is a reserved slot — always [] in v1 (ADR: Learning deferred).
export const ContextBundleSchema = z.object({
  summary: z.string(),
  neighbors: z.array(NeighborSchema),
  history: z.array(HistoryEntrySchema),
  learnings: z.array(z.unknown()),
});
export type ContextBundle = z.infer<typeof ContextBundleSchema>;

// --- Finding ------------------------------------------------------------------------
// A specific observation attached to an Anchor within a Layer.
// `suggestedFix` is a reserved slot; v1 findings are prose, no one-click apply.
export const FindingSchema = z.object({
  anchor: AnchorSchema,
  concern: ConcernSchema,
  severity: SeveritySchema,
  text: z.string(),
  suggestedFix: z.null().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

// --- Layer --------------------------------------------------------------------------
// The primary unit of a Review Scaffold — a change cohort. `anchors` is non-empty.
export const LayerSchema = z.object({
  id: z.string(),
  anchors: z.array(AnchorSchema).nonempty(),
  order: intSchema,
  bundle: ContextBundleSchema,
  findings: z.array(FindingSchema),
});
export type Layer = z.infer<typeof LayerSchema>;

// --- PrMeta -------------------------------------------------------------------------
export const PrMetaSchema = z.object({
  number: intSchema,
  title: z.string(),
  description: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  stackedOnto: z.string().nullable().optional(),
});
export type PrMeta = z.infer<typeof PrMetaSchema>;

// --- ReviewScaffold -----------------------------------------------------------------
// The complete artifact the Scaffolder produces for one PR.
export const ReviewScaffoldSchema = z.object({
  pr: PrMetaSchema,
  layers: z.array(LayerSchema),
});
export type ReviewScaffold = z.infer<typeof ReviewScaffoldSchema>;

// --- ChangeSet (input; types only) --------------------------------------------------
// What Ingest (M1) will produce. Defined for typing only; not validated here.

/** A noise file entry: a file whose diff was collapsed by B1 noise stripping. */
export interface NoiseFileEntry {
  path: string;
  reason: string;
  added: number;
  removed: number;
}

export interface ChangeSet {
  pr: PrMeta;
  unifiedDiff: string;
  files: string[];
  noiseFiles: NoiseFileEntry[];
}

/**
 * JSON Schema for the Review Scaffold, derived from the zod schema and suitable for
 * Anthropic strict tool use: `additionalProperties: false` on every object and a
 * `required` array listing every non-optional property.
 */
export const reviewScaffoldJsonSchema = zodToJsonSchema(ReviewScaffoldSchema, {
  target: "openApi3",
  $refStrategy: "none",
});

/**
 * Validate arbitrary data as a ReviewScaffold. Throws (ZodError) on failure.
 */
export function parseReviewScaffold(data: unknown): ReviewScaffold {
  return ReviewScaffoldSchema.parse(data);
}
