# The Scaffolder runs on CLI-agent Providers only

The Scaffolder executes exclusively via CLI-agent Providers — the Claude Code CLI or the
Codex CLI, with a model choice — plus Replay, which replays an authored review without
calling a model. The direct Anthropic API path and Ollama-as-Scaffolder are removed from
the selectable surface.

## Why

CLI agents run under the user's existing subscription quota rather than billing per token,
which changes the economics of a scaffold run from "metered API call" to "included in plan."
Beyond cost, they bring capabilities the direct API path does not: tool-driven exploration
of the PR-head worktree (Read, Bash, grep, git history), Claude session-fork reuse across
the per-Layer detail fan-out so the skeleton's reasoning is live in each forked context,
and the ability for the skeleton call to spawn built-in subagents (Explore) for independent
areas of the changeset.

The direct API path offered prompt caching (load-bearing for fan-out cost, per ADR-0003),
typed structured-output tool calls, and per-call usage metering. We chose the CLI side
because the worktree-exploration and session-fork capabilities have a larger impact on
Anchor precision and skeleton quality than per-token caching does, and the subscription
economics remove the marginal-cost friction that discourages thorough exploration.

Ollama-as-Scaffolder is dropped for output quality: the whole-PR reasoning that tiling and
Context Bundle distillation require is out of reach for local-weight models at practical
sizes. The Assistant keeps Ollama per ADR-0001 — that workload is scoped, shallow, and
latency-sensitive in a way the Scaffolder's is not.

## Consequences

- `SLEEK_SCAFFOLDER_PROVIDER=anthropic` remains as an env-only escape hatch for users who
  need the direct API path; `DefaultLlmRunner` is kept in src/scaffolder/llm.ts for this
  purpose and is not reachable through the picker.
- The zero-config default becomes the Claude Code CLI; Codex is offered as a single row
  (bare `codex`, using ~/.codex/config.toml's model default).
- Escalation's provider surface (`SLEEK_ESCALATION_*`, including cursor and custom) is
  unchanged — Escalation is a separate call that does not share the Scaffolder's provider
  restriction.
- The fan-out detail calls continue to use Claude session-fork (`--resume <id>
  --fork-session`) by default (opt out with `SLEEK_CLI_SESSION_FORK=0`), reusing the
  skeleton's live session across all per-Layer calls.
- Prompt caching is no longer a dependency of the CLI fan-out path; session-fork reuse
  replaces it as the mechanism that keeps repeated context cheap across detail calls.
- The skeleton's `emit_layer_boundaries` takes `regionIndexes` (integers into the prompt's
  region table) instead of anchor objects — output shrinks ~95% (~44KB → ~3KB), keeping
  mega-PR skeletons inside timeouts (measured: 372s on a 431-region PR vs 40+ min before).
