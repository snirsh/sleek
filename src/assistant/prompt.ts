/**
 * Assemble the Assistant (qwen3) prompt for a line-level question, scoped to a
 * single Layer's budgeted Context Bundle.
 *
 * Per CONTEXT.md/ADR-0001 the Assistant answers *within* the Layer's distilled
 * Bundle: a plain-language summary, graph neighbors as references + one-line
 * descriptions (their SOURCE is hydrated lazily and is NOT inlined unless the
 * backend passes it in), relevant git history, and the selected lines. This
 * module is pure/deterministic so it is unit-testable and cache-friendly.
 *
 * ## Token budget (local ~32K window)
 *
 * The Assistant is qwen3 (30B-class quant) with a usable window treated as
 * ~32K tokens (docs/PLAN.md §2). We budget the prompt to leave generous room
 * for the model's own reasoning + answer:
 *
 *   - The Context Bundle is already budgeted by the Scaffolder to ~8K tokens
 *     (docs/PLAN.md §4), so we pass it through mostly verbatim.
 *   - We cap the ASSEMBLED prompt at PROMPT_TOKEN_BUDGET ≈ 24K tokens, leaving
 *     ~8K for the response within the 32K window.
 *   - Lazily-hydrated neighbor source (`hydrated`), when supplied, is the one
 *     large, optional input; it is capped to HYDRATED_TOKEN_BUDGET ≈ 8K so a
 *     single neighbor can never crowd out the Bundle or the question.
 *
 * We estimate tokens with a simple, deterministic chars/4 heuristic (good
 * enough for budgeting; no tokenizer dependency). Truncation is explicit and
 * marked so the model knows content was elided.
 */

import type { Anchor, ContextBundle, Layer } from "../domain/scaffold.ts";

/** Assembled-prompt cap, in tokens (~24K of a ~32K window). */
export const PROMPT_TOKEN_BUDGET = 24_000;

/** Cap for the optional lazily-hydrated neighbor source, in tokens (~8K). */
export const HYDRATED_TOKEN_BUDGET = 8_000;

/** Cap for the system+user pair built by buildAssistantMessages (~8K total). */
export const MESSAGES_TOKEN_BUDGET = 8_000;

/** Selected text is truncated to this many lines before entering the prompt. */
export const SELECTED_TEXT_MAX_LINES = 120;

/** Deterministic, tokenizer-free token estimate (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TRUNCATION_MARKER = "\n… [truncated to fit the local window]";

/**
 * Truncate `text` to at most `maxTokens` INCLUDING the marker, so the returned
 * string never exceeds the budget.
 */
function capToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = maxTokens * 4 - TRUNCATION_MARKER.length;
  return text.slice(0, Math.max(0, maxChars)) + TRUNCATION_MARKER;
}

function renderAnchor(a: Anchor): string {
  return `${a.file} [${a.side}] lines ${a.startLine}-${a.endLine}`;
}

function renderBundle(bundle: ContextBundle): string {
  const lines: string[] = [];

  lines.push("## Layer summary");
  lines.push(bundle.summary || "(none)");
  lines.push("");

  lines.push("## Graph neighbors (references only — source not inlined)");
  if (bundle.neighbors.length === 0) {
    lines.push("(none)");
  } else {
    for (const n of bundle.neighbors) {
      lines.push(`- ${n.ref} — ${n.signature} — ${n.oneLine}`);
    }
  }
  lines.push("");

  lines.push("## Relevant history");
  if (bundle.history.length === 0) {
    lines.push("(none)");
  } else {
    for (const h of bundle.history) {
      lines.push(`- ${h.sha.slice(0, 12)} ${h.subject} (${h.whenRelevant})`);
    }
  }

  return lines.join("\n");
}

const SYSTEM_INSTRUCTION = [
  "You are the Assistant: a local code reviewer's helper.",
  "Answer the Reviewer's question about the selected lines using ONLY the",
  "Layer's Context Bundle below (its summary, graph-neighbor references, and",
  "history) plus any hydrated neighbor source explicitly provided. If the",
  "answer requires information not present here, say so plainly and suggest",
  'escalating to the Scaffolder rather than guessing.',
].join(" ");

/**
 * Build the assistant prompt (a single deterministic string).
 *
 * @param layer     the owning Layer (source of the Context Bundle + anchors)
 * @param selection the Reviewer's selected line range
 * @param question  the Reviewer's question
 * @param hydrated  OPTIONAL lazily-hydrated neighbor source; when omitted, no
 *                  neighbor source appears in the prompt (only references).
 */
export function buildAssistantPrompt(
  layer: Layer,
  selection: Anchor,
  question: string,
  hydrated?: string,
): string {
  const sections: string[] = [];

  sections.push(SYSTEM_INSTRUCTION);
  sections.push("");
  sections.push(`# Layer ${layer.id}`);
  sections.push("");
  sections.push(renderBundle(layer.bundle));
  sections.push("");

  if (hydrated !== undefined && hydrated.trim() !== "") {
    sections.push("## Hydrated neighbor source");
    sections.push("```");
    sections.push(capToTokens(hydrated, HYDRATED_TOKEN_BUDGET));
    sections.push("```");
    sections.push("");
  }

  sections.push("## Selected lines");
  sections.push(renderAnchor(selection));
  sections.push("");

  sections.push("## Question");
  sections.push(question);

  const assembled = sections.join("\n");
  return capToTokens(assembled, PROMPT_TOKEN_BUDGET);
}

// ── Chat-shaped assembly (system/user pair) ─────────────────────────────────────────────

/** A system+user message pair, the shape the local chat API consumes. */
export interface AssistantMessages {
  system: string;
  user: string;
}

export interface AssistantMessageOpts {
  /** File the selection lives in, if any. */
  file?: string;
  /** Human-readable line label, e.g. "[RIGHT] lines 10-14". */
  lineLabel?: string;
  /** The selected source text; truncated to SELECTED_TEXT_MAX_LINES. */
  selectedText?: string;
  /** The Reviewer's question. */
  question: string;
  /** PR title, for orientation. */
  prTitle: string;
}

const SELECTED_LINES_TRUNCATION = "… [selection truncated to 120 lines]";

function capToLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), SELECTED_LINES_TRUNCATION].join("\n");
}

/**
 * Build the Assistant's chat messages for a Reviewer question.
 *
 * The system message explains the role — a local code-review assistant
 * answering within a Layer's pre-computed context — and, when a Layer is
 * available, carries its Context Bundle (summary, neighbor references +
 * one-lines, history). The user message carries the selection + question.
 *
 * When `layer` is null (the selection resolved to no Layer, or there was no
 * selection) the system message still frames the role sensibly and tells the
 * model it has no Layer context to lean on.
 *
 * Pure/deterministic. The pair stays under MESSAGES_TOKEN_BUDGET (~8K tokens):
 * selectedText is truncated to SELECTED_TEXT_MAX_LINES, and each message is
 * capped so system+user never exceed the budget.
 */
export function buildAssistantMessages(
  layer: Layer | null,
  opts: AssistantMessageOpts,
): AssistantMessages {
  const systemParts: string[] = [];
  systemParts.push(
    [
      "You are the Assistant: a local code-review helper. The Reviewer is",
      `reviewing the pull request "${opts.prTitle}" and asks questions about`,
      "selected lines of the diff. Answer concisely and concretely.",
    ].join(" "),
  );
  systemParts.push("");

  if (layer) {
    systemParts.push(
      [
        "The selection belongs to the Layer below — an independent cluster of",
        "functionally connected changes. Answer using ONLY this Layer's",
        "pre-computed context (summary, graph-neighbor references, history)",
        "plus the selected lines in the user message. If the answer requires",
        "information not present here, say so plainly and suggest escalating",
        "to the Scaffolder rather than guessing.",
      ].join(" "),
    );
    systemParts.push("");
    systemParts.push(`# Layer ${layer.id}`);
    systemParts.push("");
    systemParts.push(renderBundle(layer.bundle));
  } else {
    systemParts.push(
      [
        "No Layer context is available for this question (the selection did",
        "not resolve to a known change cohort). Answer from the selected",
        "lines and general knowledge, be explicit about what you cannot know",
        "without more context, and suggest selecting changed lines or",
        "escalating to the Scaffolder when appropriate.",
      ].join(" "),
    );
  }

  // Split the ~8K budget: the bundle-bearing system message gets the larger
  // share; the user message (selection + question) gets the remainder.
  const systemBudget = Math.floor(MESSAGES_TOKEN_BUDGET * 0.6);
  const system = capToTokens(systemParts.join("\n"), systemBudget);
  const userBudget = MESSAGES_TOKEN_BUDGET - estimateTokens(system);

  const userParts: string[] = [];
  if (opts.file) {
    userParts.push(
      `Selection: ${opts.file}${opts.lineLabel ? ` ${opts.lineLabel}` : ""}`,
    );
  } else if (opts.lineLabel) {
    userParts.push(`Selection: ${opts.lineLabel}`);
  }
  const questionLine = `Question: ${opts.question}`;
  if (opts.selectedText !== undefined && opts.selectedText.trim() !== "") {
    // The selection is the one potentially large user input: cap it to what
    // remains after the header + question, so the question always survives.
    const selectionBudget = Math.max(
      0,
      userBudget -
        estimateTokens(userParts.join("\n")) -
        estimateTokens(questionLine) -
        8, // fences + blank lines
    );
    userParts.push("```");
    userParts.push(
      capToTokens(
        capToLines(opts.selectedText, SELECTED_TEXT_MAX_LINES),
        selectionBudget,
      ),
    );
    userParts.push("```");
  }
  if (userParts.length > 0) userParts.push("");
  userParts.push(questionLine);

  // Safety net for pathological headers/questions.
  const user = capToTokens(userParts.join("\n"), userBudget);
  return { system, user };
}
