import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { AssistantMessages } from "../assistant/prompt.ts";
import type { LlmRequest, LlmRunner, LlmUsage } from "./llm.ts";

export type CliAgentProvider = "codex" | "cursor" | "claude" | "custom";

export interface CliAgentConfig {
  provider: CliAgentProvider;
  model?: string;
  /** Shell command template for provider=custom. Supports {promptFile}, {schemaFile}, {outputFile}, {model}. */
  commandTemplate?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Explicit binary path for the provider's CLI executable.
   * When set, bypasses the well-known-path probing in resolveBinary.
   * Intended for tests that inject a fake binary and need to bypass PATH resolution.
   */
  binaryPath?: string;
}

interface RunFiles {
  dir: string;
  promptFile: string;
  schemaFile?: string;
  outputFile: string;
}

interface CommandSpec {
  command: string;
  args: string[];
  input?: string;
  outputFile?: string;
}

const ZERO_USAGE: LlmUsage = {
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Parsed envelope from `claude --output-format json`.
 * Only the fields we use are typed; the envelope contains many more.
 */
interface ClaudeJsonEnvelope {
  result: string;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Returns true when session-fork mode is active for a claude provider call. */
function isForkEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.SLEEK_CLI_SESSION_FORK !== "0";
}

/**
 * Parse a `claude --output-format json` envelope.
 * Returns null if the text is not valid JSON or missing the `result` field.
 */
function parseClaudeJsonEnvelope(text: string): ClaudeJsonEnvelope | null {
  try {
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    if (typeof parsed.result !== "string") return null;
    const env: ClaudeJsonEnvelope = { result: parsed.result };
    if (typeof parsed.session_id === "string") {
      env.session_id = parsed.session_id;
    }
    const u = parsed.usage;
    if (u && typeof u === "object") {
      const usage = u as Record<string, unknown>;
      env.usage = {
        input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        cache_creation_input_tokens:
          typeof usage.cache_creation_input_tokens === "number"
            ? usage.cache_creation_input_tokens
            : 0,
        cache_read_input_tokens:
          typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : 0,
      };
    }
    return env;
  } catch {
    return null;
  }
}

/**
 * Map a parsed claude JSON envelope's usage block to {@link LlmUsage}.
 */
function usageFromEnvelope(env: ClaudeJsonEnvelope): LlmUsage {
  if (!env.usage) return ZERO_USAGE;
  return {
    inputTokens: env.usage.input_tokens ?? 0,
    outputTokens: env.usage.output_tokens ?? 0,
    cacheCreationInputTokens: env.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: env.usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Reduced prompt for fork calls: omits the shared system context (the session
 * already carries it) and sends only the per-call user instruction + schema block.
 */
export function buildForkPrompt(request: LlmRequest, schema: string): string {
  return [
    request.userText,
    "",
    "Return ONLY a valid JSON object. Do not include markdown fences, prose, comments,",
    "or any text before or after the JSON.",
    "Emit the JSON directly in your reply. Do NOT write it to a file first.",
    "",
    "The JSON object must match this schema for " + request.tool.name + ":",
    "```json",
    schema,
    "```",
  ].join("\n");
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Default retry count: 1 retry = 2 total attempts. Override with SLEEK_AGENT_RETRIES. */
const DEFAULT_AGENT_RETRIES = 1;

/** Pause between retry attempts in milliseconds. */
const RETRY_DELAY_MS = 2000;

/**
 * Inline JSON string for --mcp-config when lean spawns are enabled.
 * An empty mcpServers object tells claude to load no MCP servers.
 */
const LEAN_MCP_CONFIG_JSON = '{"mcpServers":{}}';

/**
 * Scoped RTK read rules for claude plan-mode spawns.
 *
 * These are scoped rules (not blanket Bash(rtk:*)) so mutating commands like
 * `rtk git push` stay blocked; claude plan-mode blocks Bash otherwise, so this
 * both unlocks git history access and compacts output; CliAgentCloudRunner
 * (escalation) shares commandSpec so escalation's claude spawns also gain
 * these -- intentional read-only widening; kill switch SLEEK_CLI_RTK=0.
 */
const RTK_ALLOWED_TOOLS = [
  "--allowedTools",
  "Bash(rtk grep:*)",
  "Bash(rtk rg:*)",
  "Bash(rtk read:*)",
  "Bash(rtk ls:*)",
  "Bash(rtk tree:*)",
  "Bash(rtk find:*)",
  "Bash(rtk wc:*)",
  "Bash(rtk git log:*)",
  "Bash(rtk git diff:*)",
  "Bash(rtk git show:*)",
  "Bash(rtk git blame:*)",
];

function retriesFromEnv(env: NodeJS.ProcessEnv): number {
  const val = env.SLEEK_AGENT_RETRIES;
  if (!val) return DEFAULT_AGENT_RETRIES;
  const n = Number(val);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_AGENT_RETRIES;
}

function isLeanEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.SLEEK_CLI_LEAN !== "0";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function providerFromEnv(
  env: NodeJS.ProcessEnv,
  prefix: "SLEEK_SCAFFOLDER" | "SLEEK_ESCALATION",
): CliAgentProvider | "anthropic" | "ollama" {
  const configured = env[`${prefix}_PROVIDER`];
  const command = env[`${prefix}_COMMAND`];
  const fallback =
    prefix === "SLEEK_ESCALATION"
      ? env.SLEEK_SCAFFOLDER_PROVIDER ?? env.SLEEK_BASE_PROVIDER
      : env.SLEEK_BASE_PROVIDER;
  const value = configured ?? (command ? "custom" : fallback) ?? "anthropic";
  if (
    value === "anthropic" ||
    value === "codex" ||
    value === "cursor" ||
    value === "claude" ||
    value === "custom" ||
    value === "ollama"
  ) {
    return value;
  }
  throw new Error(
    `${prefix}_PROVIDER must be one of: anthropic, codex, cursor, claude, custom, ollama.`,
  );
}

export function cliConfigFromEnv(
  env: NodeJS.ProcessEnv,
  prefix: "SLEEK_SCAFFOLDER" | "SLEEK_ESCALATION",
  provider: CliAgentProvider,
): CliAgentConfig {
  return {
    provider,
    model: env[`${prefix}_MODEL`] ?? env.SLEEK_BASE_MODEL,
    commandTemplate: env[`${prefix}_COMMAND`],
    cwd: env[`${prefix}_CWD`],
    timeoutMs: numberFromEnv(env[`${prefix}_TIMEOUT_MS`] ?? env.SLEEK_AGENT_TIMEOUT_MS),
    env,
  };
}

export class CliAgentLlmRunner implements LlmRunner {
  /** The configured CLI provider for this runner. */
  readonly provider: CliAgentProvider;

  /** The working directory passed to spawned CLI agents, if configured. */
  readonly cwd: string | undefined;

  /**
   * Captured session_id from the base (cachePrefix=true) call.
   * Set once on the first session-fork base call; subsequent fork calls reuse it.
   * Null when fork mode is disabled, provider is not claude, or the base call
   * did not return a session_id (triggering stateless fallback for all calls).
   */
  private sessionId: string | null = null;

  /**
   * Whether the base call has been attempted.  Used to distinguish "not yet
   * attempted" (null sessionId, forks should wait for base) from "attempted but
   * no session_id returned" (null sessionId, fall back to stateless).
   */
  private baseCallAttempted = false;

  constructor(private readonly config: CliAgentConfig) {
    this.provider = config.provider;
    this.cwd = config.cwd;
  }

  async run(request: LlmRequest): Promise<{ toolInput: unknown; usage: LlmUsage }> {
    const schema = JSON.stringify(request.tool.inputSchema, null, 2);
    const env = { ...process.env, ...(this.config.env ?? {}) };

    // Session-fork mode: claude provider only, opt-out via SLEEK_CLI_SESSION_FORK=0.
    if (this.config.provider === "claude" && isForkEnabled(env)) {
      if (request.cachePrefix) {
        // BASE call: run with JSON output, capture session_id.
        return await this.runClaudeBase(request, schema, env);
      } else {
        // FORK call: if base has been attempted and we have a sessionId, fork.
        // If base was never attempted (shouldn't happen normally), fall through to stateless.
        if (this.baseCallAttempted && this.sessionId) {
          return await this.runClaudeFork(request, schema, env);
        }
        // No session_id available (base returned none, or base not yet called) — fall through.
        if (this.baseCallAttempted && !this.sessionId) {
          console.warn("[sleek:session-fork] No session_id from base call; using stateless fallback for fork call.");
        }
      }
    }

    // Stateless path: all other providers, or fallback from above.
    const prompt = buildStructuredPrompt(request, schema);
    const output = await runCliAgent(this.config, prompt, {
      schema,
      retryOnEmpty: true,
      validateOutput: (text) => { extractJsonObject(text); },
    });
    return { toolInput: extractJsonObject(output), usage: ZERO_USAGE };
  }

  /**
   * Run the base (skeleton) call for claude provider with session-fork mode.
   * Uses --output-format json (no --no-session-persistence so the session is saved).
   * Captures the session_id from the envelope for subsequent fork calls.
   */
  private async runClaudeBase(
    request: LlmRequest,
    schema: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ toolInput: unknown; usage: LlmUsage }> {
    this.baseCallAttempted = true;
    const prompt = buildStructuredPrompt(request, schema);
    let output: string;
    try {
      output = await runCliAgent(
        this.config,
        prompt,
        {
          schema,
          retryOnEmpty: true,
          validateOutput: (text) => { parseAndExtractFromEnvelope(text); },
          claudeJsonMode: true,
        },
      );
    } catch (err) {
      // Base call failed entirely — no session_id, callers get stateless fallback.
      console.warn(
        "[sleek:session-fork] Base call failed: " +
          (err instanceof Error ? err.message : String(err)) +
          ". Subsequent fork calls will use stateless fallback.",
      );
      throw err;
    }

    const envelope = parseClaudeJsonEnvelope(output);
    if (envelope && envelope.session_id) {
      this.sessionId = envelope.session_id;
    } else {
      console.warn(
        "[sleek:session-fork] Base call did not return a session_id; " +
          "subsequent fork calls will use stateless fallback.",
      );
    }

    const text = envelope ? envelope.result : output;
    return {
      toolInput: extractJsonObject(text),
      usage: envelope ? usageFromEnvelope(envelope) : ZERO_USAGE,
    };
  }

  /**
   * Run a fork (detail) call by resuming from the base session.
   * Uses --resume <sessionId> --fork-session with a reduced prompt.
   * Falls back to a stateless full-prompt call on any failure.
   */
  private async runClaudeFork(
    request: LlmRequest,
    schema: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ toolInput: unknown; usage: LlmUsage }> {
    const sessionId = this.sessionId!;
    const forkPrompt = buildForkPrompt(request, schema);

    try {
      const output = await runCliAgent(
        this.config,
        forkPrompt,
        {
          schema,
          retryOnEmpty: true,
          validateOutput: (text) => { parseAndExtractFromEnvelope(text); },
          claudeJsonMode: true,
          claudeForkSessionId: sessionId,
        },
      );

      const envelope = parseClaudeJsonEnvelope(output);
      const text = envelope ? envelope.result : output;
      return {
        toolInput: extractJsonObject(text),
        usage: envelope ? usageFromEnvelope(envelope) : ZERO_USAGE,
      };
    } catch (err) {
      // Fork failed — fall back to stateless full-prompt call with warning.
      console.warn(
        "[sleek:session-fork] Fork call failed (" +
          (err instanceof Error ? err.message : String(err)) +
          "); falling back to stateless full-prompt call.",
      );
      const prompt = buildStructuredPrompt(request, schema);
      const fallbackOutput = await runCliAgent(this.config, prompt, {
        schema,
        retryOnEmpty: true,
        validateOutput: (text) => { extractJsonObject(text); },
      });
      return { toolInput: extractJsonObject(fallbackOutput), usage: ZERO_USAGE };
    }
  }
}

export class CliAgentCloudRunner {
  constructor(private readonly config: CliAgentConfig) {}

  async *run(messages: AssistantMessages, model: string): AsyncIterable<string> {
    const prompt = [messages.system, messages.user].filter(Boolean).join("\n\n");
    const selectedModel =
      this.config.model ?? (model === "claude-opus-4-8" ? undefined : model);
    const output = await runCliAgent({ ...this.config, model: selectedModel }, prompt);
    if (output) yield output;
  }
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function buildStructuredPrompt(request: LlmRequest, schema: string): string {
  return [
    request.system,
    "",
    request.userText,
    "",
    "Return ONLY a valid JSON object. Do not include markdown fences, prose, comments,",
    "or any text before or after the JSON.",
    "Emit the JSON directly in your reply. Do NOT write it to a file first.",
    "",
    `The JSON object must match this schema for ${request.tool.name}:`,
    "```json",
    schema,
    "```",
  ].join("\n");
}

/**
 * Helper for claudeJsonMode validation: attempt to parse the envelope and
 * extract the result, then validate it contains a JSON object.
 * Throws if the text is not a valid claude JSON envelope with a result field.
 */
function parseAndExtractFromEnvelope(text: string): void {
  const envelope = parseClaudeJsonEnvelope(text);
  if (!envelope) {
    // Maybe the output is just raw JSON (non-envelope fallback), try that.
    extractJsonObject(text);
    return;
  }
  extractJsonObject(envelope.result);
}

async function runCliAgent(
  config: CliAgentConfig,
  prompt: string,
  options: {
    schema?: string;
    signal?: AbortSignal;
    retryOnEmpty?: boolean;
    /** When provided, called with the output string; should throw if the output is invalid. */
    validateOutput?: (output: string) => void;
    /**
     * When true, the claude provider uses --output-format json instead of text.
     * The raw stdout is the full JSON envelope (not just the result text).
     * Only applies to provider=claude.
     */
    claudeJsonMode?: boolean;
    /**
     * When set, the claude provider uses --resume <id> --fork-session.
     * Only applies to provider=claude with claudeJsonMode=true.
     */
    claudeForkSessionId?: string;
  } = {},
): Promise<string> {
  const env = { ...process.env, ...(config.env ?? {}) };
  const maxRetries = retriesFromEnv(env);
  const providerName = config.provider;

  const dir = await mkdtemp(join(tmpdir(), "sleek-agent-"));
  const files: RunFiles = {
    dir,
    promptFile: join(dir, "prompt.txt"),
    schemaFile: options.schema ? join(dir, "schema.json") : undefined,
    outputFile: join(dir, "output.txt"),
  };

  try {
    await writeFile(files.promptFile, prompt);
    if (files.schemaFile && options.schema) await writeFile(files.schemaFile, options.schema);

    const spec = commandSpec(config, files, prompt, {
      claudeJsonMode: options.claudeJsonMode,
      claudeForkSessionId: options.claudeForkSessionId,
    });
    const spawnOpts = {
      cwd: config.cwd ?? process.cwd(),
      env,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Never retry after an abort signal has fired.
      if (options.signal?.aborted) {
        throw new Error("CLI agent call aborted (provider: " + providerName + ")");
      }

      if (attempt > 0) {
        await sleep(RETRY_DELAY_MS);
        // Check abort again after the sleep.
        if (options.signal?.aborted) {
          throw new Error("CLI agent call aborted (provider: " + providerName + ")");
        }
      }

      // Clear any output file left by a previous attempt so a stale result from
      // attempt N cannot be read as attempt N+1's output (e.g. partial JSON that
      // passed the write but failed validation, while the next attempt exits 0
      // without writing anything).
      if (spec.outputFile) {
        await rm(spec.outputFile, { force: true });
      }

      try {
        const result = await spawnCollect(spec, spawnOpts, options.signal);

        let output: string;
        if (spec.outputFile && existsSync(spec.outputFile)) {
          const fileOutput = await readFile(spec.outputFile, "utf8");
          output = fileOutput.trim() ? fileOutput : result.stdout.trim() || result.stderr.trim();
        } else {
          output = result.stdout.trim() || result.stderr.trim();
        }

        // Empty output is retriable when the caller explicitly requests it
        // (structured output path). Text/streaming callers may legitimately return "".
        if (!output && options.retryOnEmpty) {
          lastError = new Error(
            "CLI agent returned empty output (provider: " + providerName + ", attempt " + (attempt + 1) + ")",
          );
          continue;
        }

        // Validate the output (e.g. JSON parse check). Validation failures are retriable.
        if (options.validateOutput) {
          try {
            options.validateOutput(output);
          } catch (validationErr) {
            lastError = new Error(
              (validationErr instanceof Error ? validationErr.message : String(validationErr)) +
                " (provider: " + providerName + ", attempt " + (attempt + 1) + ")",
            );
            continue;
          }
        }

        return output;
      } catch (err) {
        // Abort errors are never retried.
        if (err instanceof Error && err.message.includes("aborted")) {
          throw err;
        }
        lastError = new Error(
          (err instanceof Error ? err.message : String(err)) +
            " (provider: " + providerName + ", attempt " + (attempt + 1) + ")",
        );
        // Non-zero exit and timeout are retriable — loop continues.
      }
    }

    throw lastError ?? new Error("CLI agent failed (provider: " + providerName + ")");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function commandSpec(
  config: CliAgentConfig,
  files: RunFiles,
  prompt: string,
  extra: { claudeJsonMode?: boolean; claudeForkSessionId?: string } = {},
): CommandSpec {
  switch (config.provider) {
    case "codex":
      return {
        command: resolveBinary("codex", [
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          join(homedir(), ".local/bin/codex"),
          join(homedir(), ".superset/bin/codex"),
        ]),
        args: [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--output-last-message",
          files.outputFile,
          ...(files.schemaFile ? ["--output-schema", files.schemaFile] : []),
          ...(config.model ? ["--model", config.model] : []),
          "-",
        ],
        input: prompt,
        outputFile: files.outputFile,
      };
    case "cursor":
      return {
        command: resolveBinary("agent", [
          join(homedir(), ".local/bin/agent"),
          "/opt/homebrew/bin/agent",
          "/usr/local/bin/agent",
          join(homedir(), ".superset/bin/agent"),
        ]),
        args: [
          "--print",
          "--output-format",
          "text",
          "--mode",
          "ask",
          "--trust",
          ...(config.model ? ["--model", config.model] : []),
        ],
        input: prompt,
      };
    case "claude": {
      const env = config.env ?? process.env;
      const lean = isLeanEnabled(env);
      const leanArgs = lean
        ? [
            "--strict-mcp-config",
            "--mcp-config",
            LEAN_MCP_CONFIG_JSON,
            "--setting-sources",
            "",
            "--disable-slash-commands",
          ]
        : [];
      const rtkAllowedTools =
        rtkBinaryAvailable(env) && env.SLEEK_CLI_RTK !== "0"
          ? RTK_ALLOWED_TOOLS
          : [];
      // Use explicit binaryPath when provided (test injection); otherwise probe well-known paths.
      const claudeBinary = config.binaryPath ?? resolveBinary("claude", [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        join(homedir(), ".local/bin/claude"),
        join(homedir(), ".superset/bin/claude"),
      ]);

      if (extra.claudeJsonMode) {
        // Session-fork mode: use --output-format json, no --no-session-persistence.
        // For fork calls: --resume <sessionId> --fork-session go BEFORE the prompt arg.
        const forkArgs: string[] = extra.claudeForkSessionId
          ? ["--resume", extra.claudeForkSessionId, "--fork-session"]
          : [];
        return {
          command: claudeBinary,
          args: [
            "--print",
            "--output-format",
            "json",
            "--permission-mode",
            "plan",
            // No --no-session-persistence: session must be saved so --resume works.
            ...forkArgs,
            // Lean spawn flags: skip user MCP servers, skills, and user settings.
            // Verified empirically: lean flags work with --resume/--fork-session.
            // Escape hatch: SLEEK_CLI_LEAN=0 reverts to no lean flags.
            ...leanArgs,
            ...rtkAllowedTools,
            ...(config.model ? ["--model", config.model] : []),
          ],
          input: prompt,
        };
      }

      // Stateless path: original behavior with --output-format text and --no-session-persistence.
      return {
        command: claudeBinary,
        args: [
          "--print",
          "--output-format",
          "text",
          "--permission-mode",
          "plan",
          "--no-session-persistence",
          // Lean spawn flags: skip user MCP servers, skills, and user settings.
          // Verified empirically: ~2.9-4.1s vs ~6s baseline (32-52% faster).
          // File tools remain available so the prompt can read the diff file from cwd.
          // Escape hatch: SLEEK_CLI_LEAN=0 reverts to today's args.
          ...leanArgs,
          ...rtkAllowedTools,
          ...(config.model ? ["--model", config.model] : []),
        ],
        input: prompt,
      };
    }
    case "custom":
      if (!config.commandTemplate) {
        throw new Error(
          "SLEEK_*_COMMAND is required when provider=custom. " +
            "Use {promptFile}, {schemaFile}, {outputFile}, and {model} placeholders as needed.",
        );
      }
      return {
        command: "/bin/sh",
        args: ["-lc", renderTemplate(config.commandTemplate, config, files)],
        input: config.commandTemplate.includes("{promptFile}") ? undefined : prompt,
        outputFile: config.commandTemplate.includes("{outputFile}")
          ? files.outputFile
          : undefined,
      };
  }
}

function renderTemplate(
  template: string,
  config: CliAgentConfig,
  files: RunFiles,
): string {
  return template
    .replaceAll("{promptFile}", shellQuote(files.promptFile))
    .replaceAll("{schemaFile}", shellQuote(files.schemaFile ?? ""))
    .replaceAll("{outputFile}", shellQuote(files.outputFile))
    .replaceAll("{model}", shellQuote(config.model ?? ""));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveBinary(name: string, candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function spawnCollect(
  spec: CommandSpec,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(spec.command, spec.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    };
    const succeed = (value: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      fail(new Error("CLI agent call aborted: " + spec.command));
    };
    if (signal) {
      if (signal.aborted) {
        // Already aborted before we even started.
        child.kill("SIGTERM");
        reject(new Error("CLI agent call aborted: " + spec.command));
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error("CLI agent timed out after " + opts.timeoutMs + "ms: " + spec.command));
    }, opts.timeoutMs);

    let stdout = "";
    let stderr = "";
    let size = 0;
    const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        fail(new Error("CLI agent output exceeded " + MAX_OUTPUT_BYTES + " bytes."));
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", (err) => fail(err));
    child.on("close", (code) => {
      if (code === 0) succeed({ stdout, stderr });
      else fail(new Error("CLI agent exited " + code + ": " + (stderr.trim() || stdout.trim())));
    });

    if (spec.input) child.stdin.end(spec.input);
    else child.stdin.end();
  });
}

/** Per-provider availability cache: populated on first call, reused within the process. */
const availabilityCache = new Map<"claude" | "codex" | "cursor", boolean>();
let rtkAvailabilityCache: boolean | undefined;

/**
 * Returns true when the binary for the given provider is actually present on
 * disk — either at a well-known absolute path or somewhere on the user's PATH.
 * Returns false when genuinely absent so callers can surface a meaningful
 * "binary not found" reason rather than discovering the failure at runtime.
 *
 * When called with the default `process.env`, the result is cached per-provider
 * in a module-level Map so repeated GET /api/models calls do not re-probe the
 * filesystem (availability does not change within a process lifetime).
 *
 * When called with a custom `env` object (e.g. in tests), caching is bypassed
 * so each call performs a fresh probe against the supplied PATH.
 */
export function cliBinaryAvailable(
  provider: "claude" | "codex" | "cursor",
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Only cache when using the real process environment.
  if (env === process.env) {
    const cached = availabilityCache.get(provider);
    if (cached !== undefined) return cached;
    const result = resolveBinaryHonest(provider, env);
    availabilityCache.set(provider, result);
    return result;
  }
  return resolveBinaryHonest(provider, env);
}

/**
 * Returns true when the rtk binary is actually present on disk — either at a
 * well-known absolute path or somewhere on the user's PATH.
 *
 * Like cliBinaryAvailable, only calls using the real process.env are cached.
 * Custom env objects bypass the cache so tests and callers can probe a specific
 * PATH honestly.
 */
export function rtkBinaryAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env === process.env) {
    if (rtkAvailabilityCache !== undefined) return rtkAvailabilityCache;
    rtkAvailabilityCache = resolveRtkBinaryHonest(env);
    return rtkAvailabilityCache;
  }
  return resolveRtkBinaryHonest(env);
}

/**
 * Probe the filesystem for the provider's binary without touching the cache.
 * Checks well-known absolute paths first (fast path), then walks PATH dirs.
 */
function resolveBinaryHonest(
  provider: "claude" | "codex" | "cursor",
  env: NodeJS.ProcessEnv,
): boolean {
  const binaryName: Record<typeof provider, string> = {
    claude: "claude",
    codex: "codex",
    cursor: "agent",
  };
  const wellKnown: Record<typeof provider, string[]> = {
    codex: [
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      join(homedir(), ".local/bin/codex"),
      join(homedir(), ".superset/bin/codex"),
    ],
    cursor: [
      join(homedir(), ".local/bin/agent"),
      "/opt/homebrew/bin/agent",
      "/usr/local/bin/agent",
      join(homedir(), ".superset/bin/agent"),
    ],
    claude: [
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      join(homedir(), ".local/bin/claude"),
      join(homedir(), ".superset/bin/claude"),
    ],
  };

  // Fast path: check well-known absolute paths first.
  for (const c of wellKnown[provider]) {
    if (existsSync(c)) return true;
  }

  // Genuine PATH resolution: split PATH on the platform delimiter and check
  // each directory for the binary name. macOS binaries have no extension.
  const name = binaryName[provider];
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (existsSync(join(dir, name))) return true;
  }

  return false;
}

/**
 * Probe the filesystem for rtk without touching the cache.
 * Checks well-known absolute paths first (fast path), then walks PATH dirs.
 */
function resolveRtkBinaryHonest(env: NodeJS.ProcessEnv): boolean {
  const wellKnown = [
    "/opt/homebrew/bin/rtk",
    "/usr/local/bin/rtk",
    join(homedir(), ".cargo/bin/rtk"),
    join(homedir(), ".local/bin/rtk"),
  ];

  for (const candidate of wellKnown) {
    if (existsSync(candidate)) return true;
  }

  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (existsSync(join(dir, "rtk"))) return true;
  }

  return false;
}

export function extractJsonObject(text: string): unknown {
  const trimmed = stripFence(text.trim());
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to balanced-object extraction below.
  }

  const candidate = firstBalancedJsonObject(trimmed);
  if (!candidate) {
    throw new Error("CLI agent did not return a JSON object.");
  }
  return JSON.parse(candidate);
}

function stripFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1]!.trim() : text;
}

function firstBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = inString;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
