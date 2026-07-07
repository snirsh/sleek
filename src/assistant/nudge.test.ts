import { describe, it, expect } from "vitest";
import { shouldSuggestEscalation, identifiersInQuestion } from "./nudge.ts";
import { makeAnchor, makeLayer } from "./fixtures.ts";

describe("identifiersInQuestion", () => {
  it("extracts symbol-like tokens and ignores plain prose", () => {
    const ids = identifiersInQuestion(
      "Does the retryHandler call fetchData or use the cache?",
    );
    expect(ids).toContain("retryHandler");
    expect(ids).toContain("fetchData");
    // plain lowercase words are not treated as symbols
    expect(ids).not.toContain("the");
    expect(ids).not.toContain("call");
  });

  it("keeps dotted member access", () => {
    const ids = identifiersInQuestion("Where is config.maxRetries set?");
    expect(ids).toContain("config.maxRetries");
  });
});

describe("shouldSuggestEscalation", () => {
  const layer = makeLayer({
    anchors: [makeAnchor({ startLine: 10, endLine: 20 })],
  });

  it("does not suggest for an in-scope question about a known symbol", () => {
    const sel = makeAnchor({ startLine: 12, endLine: 15 });
    const result = shouldSuggestEscalation(
      layer,
      sel,
      "Why does retry use backoff?",
    );
    expect(result.suggest).toBe(false);
  });

  it("suggests when the selection extends beyond the Layer's anchors", () => {
    // Layer owns 10-20; selection runs to 40.
    const sel = makeAnchor({ startLine: 15, endLine: 40 });
    const result = shouldSuggestEscalation(layer, sel, "What is retry?");
    expect(result.suggest).toBe(true);
    expect(result.reason).toMatch(/beyond/i);
  });

  it("suggests when the question mentions a symbol absent from the bundle", () => {
    const sel = makeAnchor({ startLine: 12, endLine: 15 });
    const result = shouldSuggestEscalation(
      layer,
      sel,
      "How does this interact with GlobalScheduler?",
    );
    expect(result.suggest).toBe(true);
    expect(result.reason).toContain("GlobalScheduler");
  });

  it("does not suggest when the mentioned symbol IS in the bundle (case-insensitive)", () => {
    const sel = makeAnchor({ startLine: 12, endLine: 15 });
    // "Backoff" appears in the bundle neighbors as "backoff".
    const result = shouldSuggestEscalation(
      layer,
      sel,
      "Explain the Backoff strategy",
    );
    expect(result.suggest).toBe(false);
  });
});
