import { describe, it, expect } from "vitest";
import {
  askOpus,
  escalate,
  buildEscalationPrompt,
  createDefaultCloudRunner,
  ESCALATION_MODEL,
} from "./escalate.ts";
import type { CloudRunner } from "./escalate.ts";
import type { AssistantMessages } from "./prompt.ts";
import { collectText } from "./assistant.ts";
import { makeAnchor, makeLayer } from "./fixtures.ts";

function fakeRunner(...chunks: string[]): CloudRunner & {
  lastMessages?: AssistantMessages;
  lastModel?: string;
  calls: number;
} {
  const runner: CloudRunner & {
    lastMessages?: AssistantMessages;
    lastModel?: string;
    calls: number;
  } = {
    calls: 0,
    async *run(messages: AssistantMessages, model: string) {
      runner.calls += 1;
      runner.lastMessages = messages;
      runner.lastModel = model;
      yield* chunks;
    },
  };
  return runner;
}

describe("buildEscalationPrompt", () => {
  const layer = makeLayer();
  const selection = makeAnchor({ startLine: 12, endLine: 15 });

  it("carries the Layer's bundle summary, neighbors, and the question", () => {
    const prompt = buildEscalationPrompt(layer, selection, "Is this correct?");
    expect(prompt).toContain(layer.bundle.summary);
    expect(prompt).toContain("retry");
    expect(prompt).toContain("Is this correct?");
    expect(prompt).toContain("lines 12-15");
  });

  it("is deterministic", () => {
    const a = buildEscalationPrompt(layer, selection, "Q");
    const b = buildEscalationPrompt(layer, selection, "Q");
    expect(a).toBe(b);
  });
});

describe("askOpus", () => {
  const messages: AssistantMessages = { system: "sys", user: "usr" };

  it("streams the cloud runner's chunks in order", async () => {
    const runner = fakeRunner("This looks ", "correct because…");
    const got: string[] = [];
    for await (const chunk of askOpus(messages, { runner })) {
      got.push(chunk);
    }
    expect(got).toEqual(["This looks ", "correct because…"]);
  });

  it("uses the Opus model by default and passes the messages through", async () => {
    const runner = fakeRunner("ok");
    await collectText(askOpus(messages, { runner }));
    expect(runner.lastModel).toBe(ESCALATION_MODEL);
    expect(runner.lastMessages).toEqual(messages);
  });

  it("honors a model override", async () => {
    const runner = fakeRunner("ok");
    await collectText(askOpus(messages, { runner, model: "claude-opus-4-7" }));
    expect(runner.lastModel).toBe("claude-opus-4-7");
  });
});

describe("escalate", () => {
  const layer = makeLayer();
  const selection = makeAnchor({ startLine: 12, endLine: 15 });

  it("returns the cloud runner's accumulated text", async () => {
    const runner = fakeRunner("This looks ", "correct because…");
    const result = await escalate("Is this correct?", layer, selection, {
      runner,
    });
    expect(result.text).toBe("This looks correct because…");
  });

  it("makes exactly one fresh call using the Opus model by default", async () => {
    const runner = fakeRunner("ok");
    await escalate("Q", layer, selection, { runner });
    expect(runner.calls).toBe(1);
    expect(runner.lastModel).toBe(ESCALATION_MODEL);
  });
});

describe("createDefaultCloudRunner — missing API key guard", () => {
  it("throws a clear error on run() when provider is anthropic and ANTHROPIC_API_KEY is absent", async () => {
    // Simulate an environment with no API key and no provider override.
    const env: NodeJS.ProcessEnv = {};
    // Construction must not throw (server starts before any escalation call).
    const runner = createDefaultCloudRunner(env);
    // run() must throw with a clear message.
    const messages: import("./prompt.ts").AssistantMessages = { system: "", user: "Q" };
    await expect(collectText(runner.run(messages, ESCALATION_MODEL))).rejects.toThrow(
      "Escalation needs ANTHROPIC_API_KEY",
    );
    await expect(collectText(runner.run(messages, ESCALATION_MODEL))).rejects.toThrow(
      "SLEEK_ESCALATION_PROVIDER",
    );
  });

  it("constructs without throwing when ANTHROPIC_API_KEY is present", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "test-key" };
    // Should not throw at construction time.
    expect(() => createDefaultCloudRunner(env)).not.toThrow();
  });
});
