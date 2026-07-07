import { describe, expect, it } from "vitest";

import { CliAgentLlmRunner, type CliAgentConfig } from "./cli-runner.ts";
import { DefaultLlmRunner } from "./llm.ts";
import {
  createCliScaffolderRunner,
  createDefaultScaffolderRunner,
  listScaffolderChoices,
  parseScaffolderChoice,
  scaffolderProviderInfo,
} from "./runners.ts";

function cliConfigOf(runner: CliAgentLlmRunner): CliAgentConfig {
  const config = Object.getOwnPropertyDescriptor(runner, "config")?.value;
  expect(config).toBeDefined();
  return config as CliAgentConfig;
}

describe("scaffolderProviderInfo", () => {
  it("defaults unset scaffolder env to a CLI provider, preferring claude", () => {
    const info = scaffolderProviderInfo({});
    expect(["claude", "codex"]).toContain(info.provider);
    expect(["Claude Code CLI", "Codex CLI"]).toContain(info.label);
    expect(typeof info.live).toBe("boolean");
  });

  it("keeps explicit anthropic as the env-only DefaultLlmRunner escape hatch", () => {
    const info = scaffolderProviderInfo({
      SLEEK_SCAFFOLDER_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(info).toEqual({
      live: true,
      provider: "anthropic",
      label: "Anthropic API",
    });
  });

  it("reports explicit cursor as unsupported for scaffolding", () => {
    const info = scaffolderProviderInfo({ SLEEK_SCAFFOLDER_PROVIDER: "cursor" });
    expect(info).toEqual({
      live: false,
      provider: "cursor",
      label: "Cursor Agent CLI (not supported for scaffolding)",
    });
  });

  it("reports explicit ollama as unsupported for scaffolding", () => {
    const info = scaffolderProviderInfo({ SLEEK_SCAFFOLDER_PROVIDER: "ollama" });
    expect(info).toEqual({
      live: false,
      provider: "ollama",
      label: "Ollama (not supported for scaffolding)",
    });
  });

  it("returns custom provider when SLEEK_SCAFFOLDER_COMMAND is configured", () => {
    const info = scaffolderProviderInfo({
      SLEEK_SCAFFOLDER_COMMAND: "my-script.sh {promptFile}",
    });
    expect(info.provider).toBe("custom");
    expect(info.label).toBe("Custom CLI");
    expect(info.live).toBe(true);
  });
});

describe("createDefaultScaffolderRunner", () => {
  it("uses Claude Code CLI when no scaffolder provider env is configured", () => {
    const runner = createDefaultScaffolderRunner({}, "claude-opus-4-8");
    expect(runner).toBeInstanceOf(CliAgentLlmRunner);
    const config = cliConfigOf(runner as CliAgentLlmRunner);
    expect(config.provider).toBe("claude");
    expect(config.model).toBe("claude-opus-4-8");
  });

  it("keeps explicit anthropic env on DefaultLlmRunner", () => {
    const runner = createDefaultScaffolderRunner({
      SLEEK_SCAFFOLDER_PROVIDER: "anthropic",
    });
    expect(runner).toBeInstanceOf(DefaultLlmRunner);
  });

  it("uses a CLI runner for codex without forcing a passed Anthropic model id", () => {
    const runner = createDefaultScaffolderRunner(
      { SLEEK_SCAFFOLDER_PROVIDER: "codex" },
      "claude-opus-4-8",
    );
    expect(runner).toBeInstanceOf(CliAgentLlmRunner);
    const config = cliConfigOf(runner as CliAgentLlmRunner);
    expect(config.provider).toBe("codex");
    expect(config.model).toBeUndefined();
  });
});

describe("createCliScaffolderRunner", () => {
  it("returns a CliAgentLlmRunner for claude provider with model", () => {
    const runner = createCliScaffolderRunner("claude", "claude-opus-4-8");
    expect(runner).toBeInstanceOf(CliAgentLlmRunner);
    const config = cliConfigOf(runner);
    expect(config.provider).toBe("claude");
    expect(config.model).toBe("claude-opus-4-8");
  });

  it("returns a CliAgentLlmRunner for codex without model", () => {
    const runner = createCliScaffolderRunner("codex");
    expect(runner).toBeInstanceOf(CliAgentLlmRunner);
    const config = cliConfigOf(runner);
    expect(config.provider).toBe("codex");
    expect(config.model).toBeUndefined();
  });

  it("threads cwd into the runner's config and exposes it as runner.cwd", () => {
    const runner = createCliScaffolderRunner("claude", undefined, {
      cwd: "/worktrees/pr-42",
    });
    expect(runner.cwd).toBe("/worktrees/pr-42");
    expect(cliConfigOf(runner).cwd).toBe("/worktrees/pr-42");
  });
});

describe("listScaffolderChoices", () => {
  it("emits only Replay, Claude Code CLI, and Codex groups even with ANTHROPIC_API_KEY", () => {
    const choices = listScaffolderChoices(
      { ANTHROPIC_API_KEY: "sk-test" },
      { replay: true },
    );
    expect([...new Set(choices.map((c) => c.group))]).toEqual([
      "Replay",
      "Claude Code CLI",
      "Codex",
    ]);
    expect(choices.some((c) => c.group === "Cursor")).toBe(false);
    expect(choices.some((c) => c.group === "Ollama")).toBe(false);
    expect(choices.some((c) => c.group === "Anthropic API")).toBe(false);
  });

  it("orders Replay, Claude x3, then Codex x1", () => {
    const choices = listScaffolderChoices({}, { replay: true });
    expect(choices.map((c) => c.id)).toEqual([
      "replay",
      "claude:claude-fable-5",
      "claude:claude-opus-4-8",
      "claude:claude-sonnet-4-6",
      "codex",
    ]);
    expect(choices.map((c) => c.label)).toEqual([
      "Replay authored review",
      "Fable 5",
      "Opus 4.8",
      "Sonnet",
      "Codex (config default)",
    ]);
  });

  it("omits replay when opts.replay is false or absent", () => {
    expect(listScaffolderChoices({}).map((c) => c.id)).toEqual([
      "claude:claude-fable-5",
      "claude:claude-opus-4-8",
      "claude:claude-sonnet-4-6",
      "codex",
    ]);
  });

  it("does not emit removed Haiku, gpt-5.5, Cursor, Ollama, or Anthropic API rows", () => {
    const ids = listScaffolderChoices(
      { ANTHROPIC_API_KEY: "sk-test" },
      { replay: true },
    ).map((c) => c.id);
    expect(ids).not.toContain("claude:claude-haiku-4-5-20251001");
    expect(ids).not.toContain("codex:gpt-5.5");
    expect(ids).not.toContain("cursor:composer-2.5");
    expect(ids.some((id) => id.startsWith("ollama:"))).toBe(false);
    expect(ids).not.toContain("claude-opus-4-8");
  });

  it("has no duplicate ids", () => {
    const ids = listScaffolderChoices({}, { replay: true }).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parseScaffolderChoice", () => {
  it("parses replay, bare claude/codex, and arbitrary claude:/codex: models", () => {
    expect(parseScaffolderChoice("replay")).toEqual({ kind: "replay" });
    expect(parseScaffolderChoice("claude")).toEqual({ kind: "cli", provider: "claude" });
    expect(parseScaffolderChoice("codex")).toEqual({ kind: "cli", provider: "codex" });
    expect(parseScaffolderChoice("claude:any-model")).toEqual({
      kind: "cli",
      provider: "claude",
      model: "any-model",
    });
    expect(parseScaffolderChoice("codex:gpt-5.5")).toEqual({
      kind: "cli",
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  it("returns error for removed bare Anthropic model ids", () => {
    for (const raw of [
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]) {
      expect(parseScaffolderChoice(raw)).toEqual({
        error: "unaccepted scaffolder choice: " + raw,
      });
    }
  });

  it("returns error for removed cursor and ollama ids", () => {
    for (const raw of [
      "cursor",
      "cursor:composer-2.5",
      "ollama:qwen2.5-coder:32b",
      "ollama:",
    ]) {
      expect(parseScaffolderChoice(raw)).toEqual({
        error: "unaccepted scaffolder choice: " + raw,
      });
    }
  });

  it("returns error for unknown ids", () => {
    const result = parseScaffolderChoice("gpt:gpt-4o");
    expect(result).toHaveProperty("error");
  });

  it("every listed id parses to a non-error result", () => {
    const choices = listScaffolderChoices(
      { ANTHROPIC_API_KEY: "sk-test" },
      { replay: true },
    );
    for (const choice of choices) {
      const parsed = parseScaffolderChoice(choice.id);
      expect(parsed, `id "${choice.id}" should parse without error`).not.toHaveProperty("error");
    }
  });
});
