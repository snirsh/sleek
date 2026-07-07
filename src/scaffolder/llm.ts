/**
 * The seam between the Scaffolder orchestration (scaffolder.ts) and the Anthropic API.
 *
 * `LlmRunner` is a single injectable method: given a system prompt, a message list, and
 * one strict tool, it returns the parsed tool-call `input`. The default implementation
 * talks to `@anthropic-ai/sdk`; tests inject a fake that returns canned tool outputs so
 * the whole Scaffolder is exercisable with NO network and NO API key.
 *
 * Model config (verified against the claude-api skill facts — not invented):
 *   - model "claude-opus-4-8"
 *   - adaptive thinking: `thinking: { type: "adaptive" }`
 *   - effort "xhigh" via `output_config: { effort: "xhigh" }`
 *   - structured output via STRICT TOOL USE: a single tool with `strict: true`, forced
 *     with `tool_choice: { type: "tool", name }`. The tool's `input_schema` is a
 *     per-phase JSON Schema (schemas.ts) with additionalProperties:false + full required.
 *   - streaming (`.stream()` then `.finalMessage()`) because per-Layer output can exceed
 *     16K tokens; `max_tokens` is set high (64K) which mandates streaming to avoid SDK
 *     HTTP timeouts.
 *
 * ── Prompt caching (ADR-0003: caching is load-bearing for the fan-out) ──────────────
 * The shared prefix — system prompt + the repo/diff context common to every call — is
 * marked `cache_control: { type: "ephemeral" }`. Render order is tools → system →
 * messages, and caching is a prefix match, so we place the breakpoint on the LAST shared
 * system block. The phase-3a skeleton call WRITES this cache; the phase-3b per-Layer
 * calls (same model, same system prefix) READ it at ~0.1x input cost.
 *
 * The per-call volatile content (the skeleton's "return boundaries" instruction, or a
 * given Layer's anchors) goes in the USER message AFTER the cached system prefix, so it
 * never invalidates the shared prefix.
 *
 * How to confirm caching works: inspect `usage.cache_creation_input_tokens` on the 3a
 * response (should be > 0 — the prefix was written) and `usage.cache_read_input_tokens`
 * on each 3b response (should be > 0 and roughly equal to the shared-prefix size — the
 * prefix was read). If 3b reads are zero, a byte in the shared prefix changed between
 * calls (a silent invalidator). The default runner surfaces these via `onUsage`.
 */

import Anthropic from "@anthropic-ai/sdk";

import type { JsonSchema } from "./schemas.ts";

/** Cache-relevant token counts from one API response, for confirming cache behavior. */
export interface LlmUsage {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

/** A single strict tool: the phase's output shape, forced via tool_choice. */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/**
 * One structured-output call. `system` is the shared, cache-written prefix; `userText`
 * is the per-call volatile content placed after it. Returns the tool call's parsed
 * `input` (already JSON, per the strict schema).
 */
export interface LlmRequest {
  system: string;
  userText: string;
  tool: LlmTool;
  /** Whether this call should WRITE the shared prefix to cache (3a) or READ it (3b). */
  cachePrefix: boolean;
}

/** The injectable seam. Returns the tool-call input as an unknown (caller validates). */
export interface LlmRunner {
  run(request: LlmRequest): Promise<{ toolInput: unknown; usage: LlmUsage }>;
}

export const SCAFFOLDER_MODEL = "claude-opus-4-8";

/** High ceiling; per-Layer detail output can exceed 16K, so we stream (see module doc). */
const MAX_TOKENS = 64_000;

export interface DefaultLlmRunnerOptions {
  client?: Anthropic;
  /** Optional hook to observe cache/token usage per call (for cost/cache confirmation). */
  onUsage?: (label: string, usage: LlmUsage) => void;
  /** Override the model; defaults to SCAFFOLDER_MODEL. */
  model?: string;
}

/**
 * Default {@link LlmRunner} backed by `@anthropic-ai/sdk`. Constructing this does NOT
 * require an API key at import time; the key is read when the client actually calls out.
 * Tests never construct this — they inject a fake — so `npm test` needs no key.
 */
export class DefaultLlmRunner implements LlmRunner {
  private readonly client: Anthropic;
  private readonly onUsage?: (label: string, usage: LlmUsage) => void;
  private readonly model: string;

  constructor(options: DefaultLlmRunnerOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.onUsage = options.onUsage;
    this.model = options.model ?? SCAFFOLDER_MODEL;
  }

  async run(request: LlmRequest): Promise<{ toolInput: unknown; usage: LlmUsage }> {
    // Shared system prefix. When cachePrefix is set, mark it ephemeral so 3a writes it
    // and every 3b call reads it. The prefix bytes MUST be byte-identical across calls.
    const systemBlock: Anthropic.TextBlockParam = {
      type: "text",
      text: request.system,
      ...(request.cachePrefix
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
    };

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      // effort lives inside output_config, not top-level.
      output_config: { effort: "xhigh" },
      system: [systemBlock],
      tools: [
        {
          name: request.tool.name,
          description: request.tool.description,
          // Strict tool use: `strict` is a sibling of name/description/input_schema.
          strict: true,
          input_schema: request.tool.inputSchema as Anthropic.Tool.InputSchema,
        },
      ],
      // Force the tool so the model must emit exactly this phase's shape.
      tool_choice: { type: "tool", name: request.tool.name },
      messages: [{ role: "user", content: request.userText }],
    });

    const message = await stream.finalMessage();

    const usage: LlmUsage = {
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
    this.onUsage?.(request.tool.name, usage);

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error(
        `Scaffolder LLM call for tool "${request.tool.name}" returned no tool_use block ` +
          `(stop_reason: ${message.stop_reason}).`,
      );
    }

    return { toolInput: toolUse.input, usage };
  }
}
