/**
 * Escalation: re-ask the Reviewer's question of the Scaffolder instead of the Assistant.
 *
 * Per CONTEXT.md/ADR-0001 this is **Reviewer-triggered**, never a
 * confidence gate. It is a FRESH, SMALL call carrying ONLY the Layer's distilled
 * Context Bundle — deliberately **independent of the scaffold-time prompt
 * cache**, so session length never interacts with cache TTL. We therefore build
 * the escalation prompt from the Bundle alone (no shared prefix, no cache
 * breakpoints) and make a single stateless call.
 *
 * The `CloudRunner` is injectable so tests never hit the network. The configured
 * default is Anthropic Opus unless SLEEK_ESCALATION_PROVIDER/SLEEK_SCAFFOLDER_PROVIDER
 * selects a CLI agent provider.
 *
 * `askOpus` is the streaming entrypoint the server uses; `escalate` is the
 * buffered convenience wrapper.
 */

import type { Anchor, ContextBundle, Layer } from "../domain/scaffold.ts";
import {
  CliAgentCloudRunner,
  cliConfigFromEnv,
  providerFromEnv,
  type CliAgentProvider,
} from "../scaffolder/cli-runner.ts";
import type { AssistantMessages } from "./prompt.ts";
import { collectText } from "./assistant.ts";

/** The Scaffolder model (docs/PLAN.md §2). */
export const ESCALATION_MODEL = "claude-opus-4-8";

/**
 * Runs a system+user message pair against the cloud model, streaming answer
 * chunks. Injectable so tests never hit the network.
 */
export interface CloudRunner {
  run(messages: AssistantMessages, model: string): AsyncIterable<string>;
}

export interface EscalateDeps {
  runner: CloudRunner;
  model?: string;
}

/**
 * Assemble the escalation prompt from the Layer's distilled Bundle only.
 * Pure/deterministic and cache-independent by construction (no shared prefix).
 * Exported for testing.
 */
export function buildEscalationPrompt(
  layer: Layer,
  selection: Anchor,
  question: string,
): string {
  const bundle: ContextBundle = layer.bundle;
  const lines: string[] = [];

  lines.push(
    "You are the Scaffolder, re-answering a code reviewer's question that the",
    "local assistant could not resolve. You are given ONLY the distilled",
    "Context Bundle for the relevant Layer — treat it as the whole of your",
    "prior analysis for this Layer. Answer the question directly.",
    "",
    `# Layer ${layer.id}`,
    "",
    "## Summary",
    bundle.summary || "(none)",
    "",
    "## Graph neighbors",
  );
  if (bundle.neighbors.length === 0) {
    lines.push("(none)");
  } else {
    for (const n of bundle.neighbors) {
      lines.push(`- ${n.ref} — ${n.signature} — ${n.oneLine}`);
    }
  }
  lines.push("", "## Relevant history");
  if (bundle.history.length === 0) {
    lines.push("(none)");
  } else {
    for (const h of bundle.history) {
      lines.push(`- ${h.sha.slice(0, 12)} ${h.subject} (${h.whenRelevant})`);
    }
  }
  lines.push(
    "",
    "## Selected lines",
    `${selection.file} [${selection.side}] lines ${selection.startLine}-${selection.endLine}`,
    "",
    "## Question",
    question,
  );

  return lines.join("\n");
}

/**
 * The default CloudRunner: a fresh, cache-independent Opus call with adaptive
 * thinking, streamed. Imports the SDK lazily and constructs the client inside
 * run() so the API key is read from env at call time; tests and offline
 * tooling never load the SDK.
 */
export function createAnthropicRunner(): CloudRunner {
  return {
    async *run(messages: AssistantMessages, model: string): AsyncIterable<string> {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env now
      // Small, fresh call — stream so a long answer doesn't hit HTTP timeouts.
      const stream = client.messages.stream({
        model,
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        ...(messages.system ? { system: messages.system } : {}),
        messages: [{ role: "user", content: messages.user }],
      });
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    },
  };
}

export function createDefaultCloudRunner(
  env: NodeJS.ProcessEnv = process.env,
): CloudRunner {
  const provider = providerFromEnv(env, "SLEEK_ESCALATION");
  if (provider === "anthropic") {
    // Capture the key (or its absence) now. The guard fires in run() — before any
    // SDK import or network call — so the error is always clear and early, but the
    // server can still start without a key (escalation is gated by isEscalationAvailable).
    const apiKey = env.ANTHROPIC_API_KEY;
    return {
      async *run(messages: AssistantMessages, model: string): AsyncIterable<string> {
        if (!apiKey) {
          throw new Error(
            "Escalation needs ANTHROPIC_API_KEY, or set SLEEK_ESCALATION_PROVIDER (or SLEEK_SCAFFOLDER_PROVIDER) to claude|codex|cursor|custom.",
          );
        }
        yield* createAnthropicRunner().run(messages, model);
      },
    };
  }
  return new CliAgentCloudRunner(
    cliConfigFromEnv(env, "SLEEK_ESCALATION", provider as CliAgentProvider),
  );
}

export function isEscalationAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const provider = providerFromEnv(env, "SLEEK_ESCALATION");
  return provider === "anthropic" ? Boolean(env.ANTHROPIC_API_KEY) : true;
}

/**
 * Stream the Scaffolder's answer to an assembled message pair.
 * Fresh, small, cache-independent. Testable with a fake runner.
 */
export async function* askOpus(
  messages: AssistantMessages,
  deps: EscalateDeps,
): AsyncIterable<string> {
  const model = deps.model ?? ESCALATION_MODEL;
  yield* deps.runner.run(messages, model);
}

/**
 * Escalate a question to the Scaffolder (buffered convenience wrapper).
 */
export async function escalate(
  question: string,
  layer: Layer,
  selection: Anchor,
  deps: EscalateDeps,
): Promise<{ text: string }> {
  const prompt = buildEscalationPrompt(layer, selection, question);
  const text = await collectText(
    askOpus({ system: "", user: prompt }, deps),
  );
  return { text };
}
