import { describe, it, expect } from "vitest";
import {
  buildAssistantMessages,
  buildAssistantPrompt,
  estimateTokens,
  MESSAGES_TOKEN_BUDGET,
  PROMPT_TOKEN_BUDGET,
  SELECTED_TEXT_MAX_LINES,
} from "./prompt.ts";
import { makeAnchor, makeLayer, makeBundle } from "./fixtures.ts";

describe("buildAssistantPrompt", () => {
  const layer = makeLayer();
  const selection = makeAnchor({ startLine: 12, endLine: 15 });
  const question = "Why does retry use exponential backoff here?";

  it("includes the bundle summary and the question", () => {
    const prompt = buildAssistantPrompt(layer, selection, question);
    expect(prompt).toContain(layer.bundle.summary);
    expect(prompt).toContain(question);
  });

  it("includes neighbor references but NOT their source when not hydrated", () => {
    const prompt = buildAssistantPrompt(layer, selection, question);
    // References appear...
    expect(prompt).toContain("retry");
    expect(prompt).toContain("function retry(fn, opts)");
    // ...but no hydrated-source section.
    expect(prompt).not.toContain("Hydrated neighbor source");
  });

  it("includes hydrated neighbor source only when `hydrated` is passed", () => {
    const source = "function retry(fn, opts) {\n  // full body\n}";
    const prompt = buildAssistantPrompt(layer, selection, question, source);
    expect(prompt).toContain("Hydrated neighbor source");
    expect(prompt).toContain("full body");
  });

  it("treats empty/whitespace hydrated source as not provided", () => {
    const prompt = buildAssistantPrompt(layer, selection, question, "   \n  ");
    expect(prompt).not.toContain("Hydrated neighbor source");
  });

  it("renders the selected line range", () => {
    const prompt = buildAssistantPrompt(layer, selection, question);
    expect(prompt).toContain("lines 12-15");
    expect(prompt).toContain("[RIGHT]");
  });

  it("stays within the prompt token budget even with a huge bundle + hydration", () => {
    const bigSummary = "x ".repeat(50_000); // ~25K tokens on its own
    const bigLayer = makeLayer({ bundle: makeBundle({ summary: bigSummary }) });
    const hugeHydrated = "y ".repeat(50_000);

    const prompt = buildAssistantPrompt(
      bigLayer,
      selection,
      question,
      hugeHydrated,
    );
    expect(estimateTokens(prompt)).toBeLessThanOrEqual(PROMPT_TOKEN_BUDGET);
  });

  it("is deterministic for identical inputs", () => {
    const a = buildAssistantPrompt(layer, selection, question);
    const b = buildAssistantPrompt(layer, selection, question);
    expect(a).toBe(b);
  });
});

describe("buildAssistantMessages", () => {
  const layer = makeLayer();
  const opts = {
    file: "src/util.ts",
    lineLabel: "[RIGHT] lines 12-15",
    selectedText: "const delay = base * 2 ** attempt;",
    question: "Why does retry use exponential backoff here?",
    prTitle: "Add backoff",
  };

  it("puts the bundle summary in the system message and the question in the user message", () => {
    const { system, user } = buildAssistantMessages(layer, opts);
    expect(system).toContain(layer.bundle.summary);
    expect(system).toContain(opts.prTitle);
    expect(user).toContain(opts.question);
    expect(user).toContain(opts.selectedText);
    expect(user).toContain("src/util.ts");
    expect(user).toContain("[RIGHT] lines 12-15");
  });

  it("carries neighbor references and history in the system message", () => {
    const { system } = buildAssistantMessages(layer, opts);
    expect(system).toContain("function retry(fn, opts)");
    expect(system).toContain("Introduce retry helper");
  });

  it("still forms a sensible prompt with layer=null", () => {
    const { system, user } = buildAssistantMessages(null, opts);
    expect(system).toContain("code-review");
    expect(system).toContain("No Layer context");
    expect(system).toContain(opts.prTitle);
    expect(user).toContain(opts.question);
  });

  it("works with only a question (no selection at all)", () => {
    const { user } = buildAssistantMessages(null, {
      question: "What does this PR do?",
      prTitle: "Add backoff",
    });
    expect(user).toContain("What does this PR do?");
    expect(user).not.toContain("```");
  });

  it("truncates selectedText to 120 lines", () => {
    const selectedText = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const { user } = buildAssistantMessages(layer, { ...opts, selectedText });
    expect(user).toContain("line 0");
    expect(user).toContain(`line ${SELECTED_TEXT_MAX_LINES - 1}`);
    expect(user).not.toContain(`line ${SELECTED_TEXT_MAX_LINES}\n`);
    expect(user).toContain("truncated");
  });

  it("keeps the pair under the ~8K token budget even with huge inputs", () => {
    const bigLayer = makeLayer({
      bundle: makeBundle({ summary: "x ".repeat(60_000) }),
    });
    const hugeSelection = Array.from({ length: 5_000 }, () => "y".repeat(400)).join("\n");
    const { system, user } = buildAssistantMessages(bigLayer, {
      ...opts,
      selectedText: hugeSelection,
    });
    expect(estimateTokens(system) + estimateTokens(user)).toBeLessThanOrEqual(
      MESSAGES_TOKEN_BUDGET,
    );
    // The question must survive truncation.
    expect(user).toContain(opts.question);
  });

  it("is deterministic", () => {
    const a = buildAssistantMessages(layer, opts);
    const b = buildAssistantMessages(layer, opts);
    expect(a).toEqual(b);
  });
});
