/**
 * Escalation nudge — a pure heuristic that decides whether to *suggest*
 * escalating to the Scaffolder ("Ask Opus").
 *
 * Per CONTEXT.md/ADR-0001, Escalation is **Reviewer-triggered**, never gated on
 * a self-reported confidence score. This module does not escalate and does not
 * call any model — it only returns a suggestion the UI may surface, e.g. when a
 * question or selection reaches *outside* the Layer's budgeted Context Bundle.
 *
 * The heuristic fires when EITHER:
 *   1. The selection extends beyond the Layer's anchors — the Reviewer is
 *      asking about lines the Layer doesn't fully own, so the Bundle may not
 *      cover them.
 *   2. The question mentions an identifier that appears nowhere in the Layer's
 *      Bundle (summary text, neighbor refs/signatures/one-lines, or history
 *      subjects) — the Assistant would be answering about a symbol it has no
 *      distilled context for.
 *
 * Suggestion only: a `true` result means "offer the button", not "escalate".
 */

import type { Anchor, ContextBundle, Layer } from "../domain/scaffold.ts";

export interface NudgeResult {
  suggest: boolean;
  reason?: string;
}

/**
 * Extract candidate identifiers from a question: word tokens that look like
 * code symbols (contain an internal capital, an underscore, or a dot member
 * access, or are cam/PascalCase). We deliberately ignore ordinary prose words
 * so the heuristic keys on symbols the Bundle would be expected to mention.
 */
export function identifiersInQuestion(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Match identifier-ish tokens, optionally with dotted member access.
  const tokenRe = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g;
  for (const raw of question.match(tokenRe) ?? []) {
    // A token looks like a code symbol when it carries a marker that ordinary
    // prose words don't: an underscore, a dot member access, a `$`, or an
    // INTERNAL capital (camelCase/PascalCase). A single leading capital does
    // NOT qualify — that just marks a sentence-initial prose word ("Explain").
    const hasInternalCapital = /[a-z0-9].*[A-Z]|[A-Z].*[A-Z]/.test(raw);
    const looksLikeSymbol =
      raw.includes("_") ||
      raw.includes(".") ||
      raw.includes("$") ||
      hasInternalCapital;
    if (!looksLikeSymbol) continue;
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

/** All text the Bundle "knows about", lowercased, for membership testing. */
function bundleHaystack(bundle: ContextBundle): string {
  const parts: string[] = [bundle.summary];
  for (const n of bundle.neighbors) {
    parts.push(n.ref, n.signature, n.oneLine);
  }
  for (const h of bundle.history) {
    parts.push(h.subject);
  }
  return parts.join("\n").toLowerCase();
}

/** True if `sel` is fully contained within some anchor of `layer`. */
function selectionWithinLayer(layer: Layer, sel: Anchor): boolean {
  return layer.anchors.some(
    (a) =>
      a.file === sel.file &&
      a.side === sel.side &&
      sel.startLine >= a.startLine &&
      sel.endLine <= a.endLine,
  );
}

/**
 * Decide whether to suggest escalation. Pure heuristic; suggestion only.
 */
export function shouldSuggestEscalation(
  layer: Layer,
  selection: Anchor,
  question: string,
): NudgeResult {
  // 1) Selection reaches outside the Layer's anchors.
  if (!selectionWithinLayer(layer, selection)) {
    return {
      suggest: true,
      reason:
        "The selected lines extend beyond this Layer's anchors, so its Context Bundle may not cover them.",
    };
  }

  // 2) Question mentions a symbol absent from the Bundle.
  const haystack = bundleHaystack(layer.bundle);
  const idents = identifiersInQuestion(question);
  const missing = idents.filter((id) => !haystack.includes(id.toLowerCase()));
  if (missing.length > 0) {
    return {
      suggest: true,
      reason: `The question references ${missing
        .map((m) => `"${m}"`)
        .join(", ")}, which ${
        missing.length === 1 ? "is" : "are"
      } not in this Layer's Context Bundle.`,
    };
  }

  return { suggest: false };
}
