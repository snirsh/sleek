import { describe, it, expect } from "vitest";
import {
  answer,
  askAssistant,
  collectText,
  DEFAULT_LOCAL_MODEL,
} from "./assistant.ts";
import type { LocalRunner } from "./assistant.ts";
import type { AssistantMessages } from "./prompt.ts";
import { makeAnchor, makeLayer, makeScaffold } from "./fixtures.ts";

/** A fake LocalRunner that records what it was asked and streams canned chunks. */
function fakeRunner(...chunks: string[]): LocalRunner & {
  lastMessages?: AssistantMessages;
  lastModel?: string;
} {
  const runner: LocalRunner & {
    lastMessages?: AssistantMessages;
    lastModel?: string;
  } = {
    async *run(messages: AssistantMessages, model: string) {
      runner.lastMessages = messages;
      runner.lastModel = model;
      yield* chunks;
    },
  };
  return runner;
}

describe("askAssistant", () => {
  const messages: AssistantMessages = { system: "sys", user: "usr" };

  it("streams the runner's chunks in order", async () => {
    const runner = fakeRunner("It uses ", "exponential ", "backoff.");
    const got: string[] = [];
    for await (const chunk of askAssistant(messages, { runner })) {
      got.push(chunk);
    }
    expect(got).toEqual(["It uses ", "exponential ", "backoff."]);
  });

  it("passes the messages and default model to the runner", async () => {
    const runner = fakeRunner("ok");
    await collectText(askAssistant(messages, { runner }));
    expect(runner.lastMessages).toEqual(messages);
    expect(runner.lastModel).toBe(DEFAULT_LOCAL_MODEL);
  });

  it("honors a model override", async () => {
    const runner = fakeRunner("ok");
    await collectText(askAssistant(messages, { runner, model: "qwen3:8b" }));
    expect(runner.lastModel).toBe("qwen3:8b");
  });

  it("propagates runner errors (e.g. Ollama unreachable)", async () => {
    const runner: LocalRunner = {
      async *run() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
    };
    await expect(
      collectText(askAssistant(messages, { runner })),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("answer", () => {
  const layer = makeLayer({
    id: "L1",
    anchors: [makeAnchor({ startLine: 10, endLine: 20 })],
  });
  const scaffold = makeScaffold([layer]);
  const selection = makeAnchor({ startLine: 12, endLine: 15 });

  it("returns the runner's accumulated text for a resolvable selection", async () => {
    const runner = fakeRunner("It uses ", "exponential backoff.");
    const result = await answer("Why?", scaffold, selection, { runner });
    expect(result.text).toBe("It uses exponential backoff.");
  });

  it("assembles a prompt containing the layer summary and question", async () => {
    const runner = fakeRunner("ok");
    await answer("Explain the retry", scaffold, selection, { runner });
    expect(runner.lastMessages?.user).toContain(layer.bundle.summary);
    expect(runner.lastMessages?.user).toContain("Explain the retry");
  });

  it("uses the default local model unless overridden", async () => {
    const runner = fakeRunner("ok");
    await answer("Q", scaffold, selection, { runner });
    expect(runner.lastModel).toBe(DEFAULT_LOCAL_MODEL);

    await answer("Q", scaffold, selection, { runner, model: "qwen3:8b" });
    expect(runner.lastModel).toBe("qwen3:8b");
  });

  it("passes hydrated neighbor source through to the prompt when provided", async () => {
    const runner = fakeRunner("ok");
    await answer("Q", scaffold, selection, {
      runner,
      hydrated: "function retry() { /* body */ }",
    });
    expect(runner.lastMessages?.user).toContain("Hydrated neighbor source");
    expect(runner.lastMessages?.user).toContain("/* body */");
  });

  it("throws when the selection resolves to no Layer", async () => {
    const runner = fakeRunner("ok");
    const outside = makeAnchor({ startLine: 999, endLine: 1000 });
    await expect(answer("Q", scaffold, outside, { runner })).rejects.toThrow(
      /does not resolve/i,
    );
  });
});
