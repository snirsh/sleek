import {
  CliAgentLlmRunner,
  cliConfigFromEnv,
  cliBinaryAvailable,
  providerFromEnv,
  type CliAgentProvider,
} from "./cli-runner.ts";
import { DefaultLlmRunner, type LlmRunner } from "./llm.ts";

function scaffolderProviderFromEnv(
  env: NodeJS.ProcessEnv,
): ReturnType<typeof providerFromEnv> {
  if (
    env.SLEEK_SCAFFOLDER_PROVIDER === undefined &&
    env.SLEEK_SCAFFOLDER_COMMAND === undefined &&
    env.SLEEK_BASE_PROVIDER === undefined
  ) {
    return "claude";
  }
  return providerFromEnv(env, "SLEEK_SCAFFOLDER");
}

export function createDefaultScaffolderRunner(
  env: NodeJS.ProcessEnv = process.env,
  model?: string,
): LlmRunner {
  const provider = scaffolderProviderFromEnv(env);
  if (provider === "anthropic") {
    return model !== undefined ? new DefaultLlmRunner({ model }) : new DefaultLlmRunner();
  }
  if (provider === "ollama" || provider === "cursor") {
    throw new Error(`${provider} is not supported for scaffolding`);
  }
  const config = cliConfigFromEnv(env, "SLEEK_SCAFFOLDER", provider as CliAgentProvider);
  // The scaffold choice's model ids are Anthropic ids ("claude-opus-4-8" etc.);
  // only the claude CLI accepts them. Env-configured model always wins; other
  // CLI providers keep their env/default model.
  if (provider === "claude" && config.model === undefined && model !== undefined) {
    config.model = model;
  }
  return new CliAgentLlmRunner(config);
}

/** Info about the active scaffolder provider derived from the environment. */
export interface ScaffolderProviderInfo {
  /** True when a live scaffold run can be attempted. */
  live: boolean;
  /** The resolved provider name. */
  provider: "anthropic" | "codex" | "cursor" | "claude" | "custom" | "ollama";
  /** Human-readable label for the UI (e.g. "Anthropic API", "Claude Code CLI"). */
  label: string;
}

/**
 * Resolve the scaffolder provider from the given environment and return a live
 * flag plus a human-readable label. With no scaffolder/base env configured,
 * scaffolding defaults to Claude Code CLI; if claude is absent but codex is
 * present, the UI reports Codex CLI as the live provider. Explicit anthropic
 * and custom remain env-only escape hatches. Explicit cursor/ollama configs are
 * reported as unsupported for scaffolding.
 */
export function scaffolderProviderInfo(
  env: NodeJS.ProcessEnv,
): ScaffolderProviderInfo {
  let provider: "anthropic" | "codex" | "cursor" | "claude" | "custom" | "ollama";
  try {
    provider = scaffolderProviderFromEnv(env);
  } catch {
    provider = "claude";
  }

  const explicitProvider =
    env.SLEEK_SCAFFOLDER_PROVIDER !== undefined ||
    env.SLEEK_SCAFFOLDER_COMMAND !== undefined ||
    env.SLEEK_BASE_PROVIDER !== undefined;

  if (provider === "anthropic") {
    return {
      live: Boolean(env.ANTHROPIC_API_KEY),
      provider: "anthropic",
      label: "Anthropic API",
    };
  }

  if (provider === "ollama") {
    return {
      live: false,
      provider: "ollama",
      label: "Ollama (not supported for scaffolding)",
    };
  }

  if (provider === "codex") {
    return {
      live: cliBinaryAvailable("codex", env),
      provider: "codex",
      label: "Codex CLI",
    };
  }

  if (provider === "cursor") {
    return {
      live: false,
      provider: "cursor",
      label: "Cursor Agent CLI (not supported for scaffolding)",
    };
  }

  if (provider === "claude") {
    const claudeLive = cliBinaryAvailable("claude", env);
    if (!explicitProvider && !claudeLive && cliBinaryAvailable("codex", env)) {
      return { live: true, provider: "codex", label: "Codex CLI" };
    }
    return {
      live: claudeLive,
      provider: "claude",
      label: "Claude Code CLI",
    };
  }

  // custom: operator-supplied command; assume live
  return { live: true, provider: "custom", label: "Custom CLI" };
}

/**
 * Create a CliAgentLlmRunner for the given provider, with an optional model
 * override on top of what the environment supplies via SLEEK_SCAFFOLDER_*.
 *
 * @param opts.cwd - Working directory for spawned CLI agents (e.g. a PR-head
 *   worktree path). When supplied, the diff file is written there so it is
 *   within the read-only sandbox's read scope.
 * @param opts.env - Environment variables for SLEEK_SCAFFOLDER_* config
 *   resolution (defaults to empty, not process.env).
 */
export function createCliScaffolderRunner(
  provider: "claude" | "codex",
  model?: string,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): CliAgentLlmRunner {
  const config = cliConfigFromEnv(opts.env ?? {}, "SLEEK_SCAFFOLDER", provider);
  if (model !== undefined) config.model = model;
  if (opts.cwd !== undefined) config.cwd = opts.cwd;
  return new CliAgentLlmRunner(config);
}

/** One selectable scaffolder choice surfaced by GET /api/models. */
export interface ScaffolderChoice {
  /**
   * The value sent to POST /api/scaffold.
   * Examples: "claude:claude-opus-4-8", "codex", "replay".
   */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Display group, e.g. "Claude Code CLI", "Ollama", "Replay". */
  group: string;
  /** Whether this choice can actually run right now. */
  available: boolean;
  /** Optional plain-text reason when unavailable. */
  reason?: string;
  /** Which backend will run. */
  provider: "claude" | "codex" | "replay";
}

/**
 * Return the full ordered list of scaffolder choices.
 *
 * Order (frozen contract):
 *   1. "Replay" — only when opts.replay is true
 *   2. "Claude Code CLI" — 3 entries (fable-5, opus-4-8, sonnet-4-6)
 *   3. "Codex" — one bare config-default entry
 */
export function listScaffolderChoices(
  env: NodeJS.ProcessEnv,
  opts?: { replay?: boolean },
): ScaffolderChoice[] {
  const claudeAvailable = cliBinaryAvailable("claude", env);
  const codexAvailable = cliBinaryAvailable("codex", env);

  const choices: ScaffolderChoice[] = [];

  // 0. Replay — when authored JSON exists it is the instant, zero-cost default, so it
  // leads the list (and is the first enabled row the picker pre-selects).
  if (opts?.replay) {
    choices.push({ id: "replay", label: "Replay authored review", group: "Replay", available: true, provider: "replay" });
  }

  // 1. Claude Code CLI family
  const claudeReason = claudeAvailable ? undefined : "claude binary not found on PATH";
  choices.push(
    { id: "claude:claude-fable-5", label: "Fable 5", group: "Claude Code CLI", available: claudeAvailable, ...(claudeReason ? { reason: claudeReason } : {}), provider: "claude" },
    { id: "claude:claude-opus-4-8", label: "Opus 4.8", group: "Claude Code CLI", available: claudeAvailable, ...(claudeReason ? { reason: claudeReason } : {}), provider: "claude" },
    { id: "claude:claude-sonnet-4-6", label: "Sonnet", group: "Claude Code CLI", available: claudeAvailable, ...(claudeReason ? { reason: claudeReason } : {}), provider: "claude" },
  );

  // 2. Codex
  const codexReason = codexAvailable ? undefined : "codex binary not found on PATH";
  choices.push(
    { id: "codex", label: "Codex (config default)", group: "Codex", available: codexAvailable, ...(codexReason ? { reason: codexReason } : {}), provider: "codex" },
  );

  return choices;
}

/** The parsed run-choice produced by parseScaffolderChoice. */
export type ParsedScaffolderChoice =
  | { kind: "replay" }
  | { kind: "cli"; provider: "claude" | "codex"; model?: string }
  | { error: string };

/**
 * Parse the raw scaffolder choice id string into a typed run-choice.
 *
 * @param raw - the raw id string from the picker
 */
export function parseScaffolderChoice(raw: string): ParsedScaffolderChoice {
  if (raw === "replay") return { kind: "replay" };

  // Split on FIRST colon only
  const colonIdx = raw.indexOf(":");
  if (colonIdx === -1) {
    // "codex" bare default
    if (raw === "codex") return { kind: "cli", provider: "codex" };
    if (raw === "claude") return { kind: "cli", provider: "claude" };
    return { error: "unaccepted scaffolder choice: " + raw };
  }

  const providerPart = raw.slice(0, colonIdx);
  const modelPart = raw.slice(colonIdx + 1);

  if (providerPart === "claude") {
    return { kind: "cli", provider: "claude", model: modelPart || undefined };
  }
  if (providerPart === "codex") {
    return { kind: "cli", provider: "codex", model: modelPart || undefined };
  }

  return { error: "unaccepted scaffolder choice: " + raw };
}
