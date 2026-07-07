/**
 * The Assistant: answer a Reviewer's line-level question locally (qwen3 on
 * Ollama), scoped to the owning Layer's budgeted Context Bundle.
 *
 * Flow (CONTEXT.md §data-flow [6]): resolve the selection to its Layer, assemble
 * the per-Layer prompt (prompt.ts) — optionally with lazily-hydrated neighbor
 * source (hydrate.ts) — and run it through a `LocalRunner`. The runner is
 * injectable so tests never touch Ollama; the default calls the `ollama`
 * package chat API with stream:true against http://localhost:11434.
 *
 * `askAssistant` is the streaming entrypoint the server uses: it yields answer
 * chunks as they arrive. `answer` is the buffered convenience wrapper.
 */

import type { Anchor, ReviewScaffold } from "../domain/scaffold.ts";
import { layerForAnchor } from "./resolve.ts";
import { buildAssistantPrompt } from "./prompt.ts";
import type { AssistantMessages } from "./prompt.ts";

/** Default local model (qwen3 on Ollama). Configurable per call/deps. */
export const DEFAULT_LOCAL_MODEL = "qwen3:30b";

/**
 * Runs a system+user message pair against a local model, streaming answer
 * chunks. Injectable so tests never touch Ollama.
 */
export interface LocalRunner {
  run(messages: AssistantMessages, model: string): AsyncIterable<string>;
}

export interface AskDeps {
  runner: LocalRunner;
  model?: string;
}

export interface AnswerDeps extends AskDeps {
  /**
   * OPTIONAL hydrated neighbor source to inline into the prompt (produced by
   * hydrate.ts upstream). When omitted, the prompt carries neighbor references
   * only, per ADR-0001.
   */
  hydrated?: string;
}

/**
 * The default LocalRunner: streams a chat completion from Ollama, yielding
 * deltas as they arrive. Imports `ollama` lazily so tests (and offline
 * tooling) never load it.
 */
export function createOllamaRunner(host?: string): LocalRunner {
  return {
    async *run(messages: AssistantMessages, model: string): AsyncIterable<string> {
      const { Ollama } = await import("ollama");
      const client = new Ollama(host ? { host } : undefined);
      const stream = await client.chat({
        model,
        messages: [
          ...(messages.system ? [{ role: "system", content: messages.system }] : []),
          { role: "user", content: messages.user },
        ],
        stream: true,
        think: false,
      });
      for await (const part of stream) {
        const delta = part.message?.content ?? "";
        if (delta) yield delta;
      }
    },
  };
}

/**
 * Stream the Assistant's answer to an assembled message pair.
 *
 * Deterministic given a deterministic runner, so it is fully testable with a
 * fake. Any runner error (e.g. Ollama unreachable) propagates to the caller.
 */
export async function* askAssistant(
  messages: AssistantMessages,
  deps: AskDeps,
): AsyncIterable<string> {
  const model = deps.model ?? DEFAULT_LOCAL_MODEL;
  yield* deps.runner.run(messages, model);
}

/** Collect an async iterable of chunks into the full text. */
export async function collectText(chunks: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}

/**
 * Answer a question about `selection` within `scaffold`, locally (buffered).
 *
 * Throws if the selection resolves to no Layer (the caller should have offered
 * escalation or a different selection).
 */
export async function answer(
  question: string,
  scaffold: ReviewScaffold,
  selection: Anchor,
  deps: AnswerDeps,
): Promise<{ text: string }> {
  const layer = layerForAnchor(scaffold, selection);
  if (!layer) {
    throw new Error(
      "Selection does not resolve to any Layer; cannot answer locally.",
    );
  }

  const prompt = buildAssistantPrompt(layer, selection, question, deps.hydrated);
  const text = await collectText(
    askAssistant({ system: "", user: prompt }, deps),
  );
  return { text };
}
