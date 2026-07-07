/**
 * B5 — Adversarial refuter.
 *
 * After findings are collected from pass-2 detail calls, every finding with
 * severity "critical" or "major" is challenged by a single cheap-model call
 * that tries to REFUTE the finding. If the refuter is convinced the finding
 * is wrong / a false-positive, the finding is demoted to "minor". Uncertain
 * refutations are treated as NOT refuted (conservative default — keep the
 * finding at its original severity).
 *
 * The verdict is recorded on the finding as an optional annotation so the UI
 * can surface it (e.g. "challenged by refuter: <reason>").
 */

import type { JsonSchema } from "./schemas.ts";
import type { LlmTool, LlmRunner } from "./llm.ts";
import type { Anchor, Finding } from "../domain/scaffold.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefuterVerdict = "refuted" | "uncertain" | "confirmed";

export interface RefuterAnnotation {
  verdict: RefuterVerdict;
  reason: string;
}

/** A Finding extended with an optional refuter annotation (B5). */
export interface AnnotatedFinding extends Finding {
  refutation?: RefuterAnnotation;
}

interface RefuterOutput {
  verdict: RefuterVerdict;
  reason: string;
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const refuterOutputSchema: JsonSchema = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["refuted", "uncertain", "confirmed"],
      description:
        "refuted = the finding is a false positive, it should be dismissed. " +
        "uncertain = not enough information to decide (keep the finding). " +
        "confirmed = the finding is valid.",
    },
    reason: {
      type: "string",
      description: "One-sentence explanation of the verdict.",
    },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

const REFUTER_TOOL: LlmTool = {
  name: "emit_refuter_verdict",
  description:
    "You are an adversarial reviewer. A finding has been raised against the diff. " +
    "Your job is to CHALLENGE it: look for reasons it is wrong, over-stated, or a " +
    "false positive given the actual code context. " +
    "If you find a convincing reason to dismiss it, emit verdict=refuted. " +
    "If you are unsure, emit verdict=uncertain. " +
    "Only emit verdict=confirmed when you are sure the finding is correct.",
  inputSchema: refuterOutputSchema,
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildRefuterUserText(finding: Finding, regionContext: string): string {
  return [
    "Finding to challenge:",
    `  severity: ${finding.severity}`,
    `  concern: ${finding.concern}`,
    `  anchor: ${finding.anchor.file} ${finding.anchor.side} ${finding.anchor.startLine}-${finding.anchor.endLine}`,
    `  text: ${finding.text}`,
    "",
    "Anchor context (the changed code lines this finding refers to):",
    regionContext || "(no region context available)",
    "",
    "Challenge this finding. Is it a real issue given the code, or is it overstated / a false positive?",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the adversarial refuter over a batch of critical/major findings.
 * Returns an array of AnnotatedFinding: refuted ones are demoted to "minor",
 * uncertain/confirmed ones keep their original severity.
 *
 * @param findings    The full finding list for a layer (all severities).
 * @param system      The shared system prompt (same as used for detail calls — gives the diff).
 * @param getRegionContext  Callback that returns a brief text excerpt for a finding's anchor.
 * @param cheapRunner The cheap-model runner to use for refutation calls.
 */
export async function refuteFindings(
  findings: Finding[],
  system: string,
  getRegionContext: (anchor: Anchor) => string,
  cheapRunner: LlmRunner,
): Promise<AnnotatedFinding[]> {
  const annotated: AnnotatedFinding[] = [];

  for (const finding of findings) {
    if (finding.severity !== "critical" && finding.severity !== "major") {
      // Only challenge critical/major findings.
      annotated.push(finding);
      continue;
    }

    let annotation: RefuterAnnotation;
    try {
      const regionContext = getRegionContext(finding.anchor);
      const result = await cheapRunner.run({
        system,
        userText: buildRefuterUserText(finding, regionContext),
        tool: REFUTER_TOOL,
        cachePrefix: false,
      });
      const output = result.toolInput as RefuterOutput;
      annotation = { verdict: output.verdict, reason: output.reason };
    } catch {
      // If the refuter call fails, treat as uncertain (conservative).
      annotation = { verdict: "uncertain", reason: "refuter call failed; keeping finding" };
    }

    if (annotation.verdict === "refuted") {
      // Demote severity from critical/major to minor.
      annotated.push({
        ...finding,
        severity: "minor",
        refutation: annotation,
      });
    } else {
      annotated.push({ ...finding, refutation: annotation });
    }
  }

  return annotated;
}
