/**
 * Per-phase JSON Schemas for Anthropic **strict tool use** (M3 Scaffolder, ADR-0003).
 *
 * The Scaffolder is two-phase, and the two phases have DIFFERENT output shapes than
 * the full ReviewScaffold (src/domain/scaffold.ts):
 *   - Phase 3a (skeleton): returns ONLY Layer boundaries — an ordered list of
 *     { id, order, regionIndexes[] }, where each index refers to a row of the
 *     "Changed regions" table in the shared system prompt. No anchors, no bundles,
 *     no findings. (Sleek expands each index back to its anchor.) Emitting indices
 *     instead of verbatim anchors keeps the skeleton output tiny on large PRs, where
 *     verbatim-anchor JSON made the skeleton call output-token-bound.
 *   - Phase 3b (per-Layer detail): returns ONE Layer's { bundle, findings } — no
 *     anchors/order (those are already fixed by 3a).
 * So we build a bespoke JSON Schema per phase here rather than reuse
 * `reviewScaffoldJsonSchema`.
 *
 * ── Resolved M0-review follow-up (1): schema target ──────────────────────────────
 * `src/domain/scaffold.ts`'s `reviewScaffoldJsonSchema` is generated with
 * zod-to-json-schema target "openApi3", which can emit OpenAPI-isms (e.g. `nullable`)
 * that Anthropic strict tool use rejects. These phase schemas are therefore authored
 * as plain, standards-track JSON Schema (draft-07 / "jsonSchema7" shape) by hand:
 * every object carries `additionalProperties: false` and a `required` array listing
 * EVERY property. No `nullable`, no `$ref`, no OpenAPI-only keywords.
 *
 * ── Resolved M0-review follow-up (2): the reserved optional `suggestedFix` ────────
 * Strict tool use requires every property to appear in `required`, so an *optional*
 * field is awkward. `Finding.suggestedFix` is a reserved slot (v1 findings are prose;
 * no one-click apply — see CONTEXT.md / PLAN §4). We CHOSE TO OMIT `suggestedFix` from
 * the tool input schema entirely: the model never emits it, the field is absent from
 * the tool output, and the Scaffolder leaves it unset when assembling Findings.
 * `FindingSchema` in the domain marks it `.optional()`, so the assembled scaffold still
 * validates. This keeps the strict schema clean (no `required`-null gymnastics) while
 * preserving the reserved slot for a future version.
 */

/** A JSON Schema object node with all the strict-tool-use invariants baked in. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  description?: string;
  minItems?: number;
  maxItems?: number;
}

// --- Anchor (ADR-0004), shared by both phases ---------------------------------------
const anchorSchema: JsonSchema = {
  type: "object",
  properties: {
    file: { type: "string", description: "Repo-relative path the anchor attaches to." },
    side: {
      type: "string",
      enum: ["LEFT", "RIGHT"],
      description: "LEFT = old-file lines (deletions), RIGHT = new-file lines.",
    },
    startLine: { type: "integer", description: "First line of the range (inclusive)." },
    endLine: { type: "integer", description: "Last line of the range (inclusive, >= startLine)." },
  },
  required: ["file", "side", "startLine", "endLine"],
  additionalProperties: false,
};

// ── Phase 3a — skeleton tool input schema ──────────────────────────────────────────
// The model returns ONLY the Layer boundaries. Each Layer lists the INDICES of the
// changed regions it owns (indices into the "Changed regions" table in the system
// prompt). The indexes across all layers must TILE the changeset — every region index
// assigned to exactly one Layer (validated in scaffolder.ts, not expressible in JSON
// Schema). Sleek expands each index back to its anchor.
const skeletonLayerSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable Layer id, unique within this scaffold." },
    order: {
      type: "integer",
      description: "0-based position, foundational-first (deps before dependents).",
    },
    regionIndexes: {
      type: "array",
      minItems: 1,
      items: { type: "integer" },
      description:
        "Indexes into the \"Changed regions\" table (the [i] column) that this Layer " +
        "owns. Every changed region index belongs to exactly one Layer.",
    },
  },
  required: ["id", "order", "regionIndexes"],
  additionalProperties: false,
};

/** JSON Schema for the phase-3a skeleton tool input: `{ layers: SkeletonLayer[] }`. */
export const skeletonToolSchema: JsonSchema = {
  type: "object",
  properties: {
    layers: {
      type: "array",
      minItems: 1,
      items: skeletonLayerSchema,
      description:
        "Ordered list of Layers whose region indexes (from the \"Changed regions\" " +
        "table) together tile the entire changeset.",
    },
  },
  required: ["layers"],
  additionalProperties: false,
};

// ── Phase 3b — per-Layer detail tool input schema ──────────────────────────────────
const neighborSchema: JsonSchema = {
  type: "object",
  properties: {
    ref: { type: "string", description: "Symbol reference, e.g. `src/foo.ts#bar`." },
    signature: { type: "string", description: "One-line signature; NOT the full source." },
    oneLine: { type: "string", description: "One-line description of the neighbor's role." },
  },
  required: ["ref", "signature", "oneLine"],
  additionalProperties: false,
};

const historyEntrySchema: JsonSchema = {
  type: "object",
  properties: {
    sha: { type: "string", description: "Commit SHA." },
    subject: { type: "string", description: "Commit subject line." },
    whenRelevant: { type: "string", description: "Why this commit is relevant to the Layer." },
  },
  required: ["sha", "subject", "whenRelevant"],
  additionalProperties: false,
};

const bundleSchema: JsonSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Plain-language summary of what this Layer changes and why.",
    },
    neighbors: {
      type: "array",
      items: neighborSchema,
      description:
        "Distilled/selected graph neighbors as refs + one-liners. Source is hydrated lazily by the backend — do NOT inline source here.",
    },
    history: {
      type: "array",
      items: historyEntrySchema,
      description: "Relevant git history for this Layer's regions.",
    },
    // `learnings` is a reserved slot — always empty in v1 (ADR: Learning deferred).
    // Modelled as an array of strings so the strict schema has a concrete item type;
    // the model is instructed to return []. The assembled bundle sets learnings: [].
    learnings: {
      type: "array",
      items: { type: "string" },
      description: "Reserved slot — always return an empty array in v1.",
    },
  },
  required: ["summary", "neighbors", "history", "learnings"],
  additionalProperties: false,
};

// NOTE: `suggestedFix` is intentionally ABSENT (see follow-up (2) above).
const findingSchema: JsonSchema = {
  type: "object",
  properties: {
    anchor: anchorSchema,
    concern: {
      type: "string",
      enum: ["correctness", "security", "performance", "tests", "maintainability"],
      description: "The review lens this Finding belongs to.",
    },
    severity: {
      type: "string",
      enum: ["critical", "major", "minor", "info"],
    },
    text: {
      type: "string",
      description: "Prose observation; may contain a fenced code block.",
    },
  },
  required: ["anchor", "concern", "severity", "text"],
  additionalProperties: false,
};

/** JSON Schema for the phase-3b per-Layer tool input: `{ bundle, findings[] }`. */
export const layerDetailToolSchema: JsonSchema = {
  type: "object",
  properties: {
    bundle: bundleSchema,
    findings: {
      type: "array",
      items: findingSchema,
      description:
        "Findings attached to anchors within this Layer. May be empty if the Layer is clean.",
    },
  },
  required: ["bundle", "findings"],
  additionalProperties: false,
};
