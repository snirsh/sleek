/**
 * B5 — Pass-1 triage (breadth sweep).
 *
 * The two-pass depth strategy sends a CHEAP model over each shard first. This
 * pass emits only a risk flag (high | low) per shard, NOT full findings. Pass 2
 * (strong model, full detail) then runs ONLY on shards flagged high. Low-risk
 * shards keep the triage summary as their bundle text and emit no/minimal findings.
 *
 * Tool schema design follows the same strict-JSON-Schema conventions as schemas.ts:
 * every object has additionalProperties:false and a required array for every property.
 */

import type { JsonSchema } from "./schemas.ts";
import type { LlmTool } from "./llm.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriageRiskLevel = "high" | "low";

export interface TriageFlag {
  /** Matches the shard's layerId (including ":shardN" suffix for split layers). */
  shardId: string;
  riskLevel: TriageRiskLevel;
  /** One-sentence rationale — surfaced as pass-1 bundle summary for low-risk shards. */
  reason: string;
}

export interface TriageOutput {
  flags: TriageFlag[];
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const triageFlagSchema: JsonSchema = {
  type: "object",
  properties: {
    shardId: {
      type: "string",
      description: "The shard identifier from the user prompt (layer id, possibly :shardN).",
    },
    riskLevel: {
      type: "string",
      enum: ["high", "low"],
      description:
        "high = this shard warrants full deep review (will be reviewed by the strong model). " +
        "low = routine change, no deep review needed.",
    },
    reason: {
      type: "string",
      description: "One-sentence rationale for the risk level.",
    },
  },
  required: ["shardId", "riskLevel", "reason"],
  additionalProperties: false,
};

const triageOutputSchema: JsonSchema = {
  type: "object",
  properties: {
    flags: {
      type: "array",
      minItems: 1,
      items: triageFlagSchema,
      description: "One flag per shard listed in the user prompt.",
    },
  },
  required: ["flags"],
  additionalProperties: false,
};

export const TRIAGE_TOOL: LlmTool = {
  name: "emit_triage_flags",
  description:
    "Emit a risk flag (high or low) for EACH shard listed below. " +
    "Flag a shard HIGH when you see logic mutations, security-sensitive paths, " +
    "public API surface changes, or complex control flow. Flag LOW for " +
    "mechanical changes: rename-only, config values, generated code, docs. " +
    "Do NOT emit findings — this is a triage sweep only.",
  inputSchema: triageOutputSchema,
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the userText for the pass-1 triage call over a batch of shards.
 * The model receives the shared system prompt (diff + region table) and this
 * user text listing shard ids + their anchors in compact form.
 */
export function buildTriageUserText(
  shards: Array<{ shardId: string; anchors: Array<{ file: string; startLine: number; endLine: number }> }>,
): string {
  const lines = [
    "Triage the following shards. For each shardId emit a risk flag (high or low) with a one-sentence reason.",
    "",
    "Shards to triage:",
  ];
  for (const s of shards) {
    const anchorSummary = s.anchors
      .map((a) => `${a.file}:${a.startLine}-${a.endLine}`)
      .join(", ");
    lines.push(`  ${s.shardId}: ${anchorSummary}`);
  }
  return lines.join("\n");
}
