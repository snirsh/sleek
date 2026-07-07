# CLI Agent Scaffolder Providers

Sleek defaults to Claude Code CLI for the Scaffolder. You can use Claude Code CLI,
Codex, or Replay for scaffolding; custom and Anthropic remain env-only escape hatches.
Escalation keeps the full provider set.

## Sleek agent skill

Sleek ships a root-level agent skill at `skills/sleek-agent/SKILL.md`. Install it with
the open skills CLI instead of having Sleek mutate agent config directly:

```bash
# From a local checkout of this repo, for Codex.
npx skills add . --skill sleek-agent --agent codex --global

# For Claude Code.
npx skills add . --skill sleek-agent --agent claude-code --global

# For Cursor.
npx skills add . --skill sleek-agent --agent cursor --global

# From a hosted repository source, swap "." for the repo source.
npx skills add <owner>/<repo> --skill sleek-agent --agent codex --global
npx skills add <owner>/<repo> --skill sleek-agent --agent claude-code --global
npx skills add <owner>/<repo> --skill sleek-agent --agent cursor --global
```

The same source works for other supported agents by changing `--agent`. For one-off use
without installation, the skills CLI also supports `npx skills use <source> --skill
sleek-agent`.

The skill teaches agents to run `sleek connect --json`, read `/api/agent/context`, inspect
`/api/agent/comments`, and create local-only draft comments. It explicitly keeps GitHub
submission/export under human control.

## Built-in providers

```bash
# Use Codex for the upfront Scaffolder and escalation.
SLEEK_SCAFFOLDER_PROVIDER=codex \
SLEEK_SCAFFOLDER_MODEL=gpt-5 \
npx tsx scripts/serve-pr.ts /path/to/repo 123 5173

# Use Claude Code CLI.
SLEEK_SCAFFOLDER_PROVIDER=claude \
SLEEK_SCAFFOLDER_MODEL=opus \
npx tsx scripts/serve-pr.ts /path/to/repo 123 5173
```

`SLEEK_ESCALATION_PROVIDER` defaults to the Scaffolder provider. Set it separately when
you want the upfront scaffold and the "Ask Scaffolder" action to use different engines.

```bash
SLEEK_SCAFFOLDER_PROVIDER=codex \
SLEEK_ESCALATION_PROVIDER=anthropic \
ANTHROPIC_API_KEY=... \
npx tsx scripts/serve-pr.ts /path/to/repo 123 5173
```

## Custom CLI agents

Use `custom` as an env-only escape hatch when your agent has a different command line interface:

```bash
SLEEK_SCAFFOLDER_PROVIDER=custom \
SLEEK_SCAFFOLDER_COMMAND='my-agent --schema {schemaFile} < {promptFile}' \
npx tsx scripts/serve-pr.ts /path/to/repo 123 5173
```

Available placeholders:

- `{promptFile}`: file containing the full prompt.
- `{schemaFile}`: JSON Schema file for structured Scaffolder calls.
- `{outputFile}`: optional file the command can write its final answer to.
- `{model}`: value of `SLEEK_SCAFFOLDER_MODEL` or `SLEEK_ESCALATION_MODEL`.

If the command template does not include `{promptFile}`, Sleek pipes the prompt to stdin.
CLI Scaffolder calls must return a single JSON object for scaffold phases.

## RTK integration

When `rtk` is installed (detected on PATH), claude spawns carry scoped
`--allowedTools "Bash(rtk git log:*)" "Bash(rtk git blame:*)" "Bash(rtk git show:*)"` rules
(and similar read-only rtk commands) so plan-mode agents get git-history access without
broad shell permissions. The shared system prompt also includes an rtk-guidance block
instructing the agent to prefer `rtk` prefixes for all eligible commands.

Kill switch: set `SLEEK_CLI_RTK=0` to disable both the allowedTools rules and the guidance
block. The prompt is byte-stable when RTK is off or when rtk is not installed.

## Skeleton subagent fan-out (claude only)

When the PR is large (changed files > 8 **or** changed regions > 25), the skeleton call
instructs Claude to spawn up to 4 built-in Explore subagents, each covering an independent
cluster of the region table. Each subagent reports region-index clusters; the parent
synthesizes them into Layer boundaries.

The fan-out thresholds are exported as `FANOUT_MIN_FILES` and `FANOUT_MIN_REGIONS` in
`src/scaffolder/scaffolder.ts` and can be overridden at compile time. This gate is
claude-only; Codex and Replay skip it.

## Index-based skeleton output

`emit_layer_boundaries` takes `regionIndexes` (integers into the prompt's "Changed regions"
table) rather than verbatim anchor objects. Sleek expands indices to anchors server-side and
validates by index (invalid or duplicate indices are dropped; first claim wins; tiling repair
runs after). This keeps skeleton output around ~3KB on large PRs instead of ~44KB, which
previously made the skeleton call output-token-bound on mega-PRs.

Measured on a large benchmark PR (431 regions / 178 files): skeleton 372s, detail 474s for 15 layers,
62 findings, completed in ~14.5 min total. Before the index change the same PR never finished
(skeleton timed out past 37 min).

The Replay runner maps authored verbatim anchors to indices so stored scaffolds remain
byte-identical after re-expansion.

## Timeouts

| Variable | Default | Notes |
|---|---|---|
| `SLEEK_SCAFFOLDER_TIMEOUT_MS` | 1 800 000 (30 min) | Per-phase CLI call timeout |
| `SLEEK_AGENT_TIMEOUT_MS` | 1 800 000 (30 min) | Per-subagent timeout |
| `SLEEK_SCAFFOLD_RUN_TIMEOUT_MS` | 2 700 000 (45 min) | Job-level watchdog |

`SLEEK_SCAFFOLDER_TIMEOUT_MS` is passed through the scaffold-worker into the CLI runner;
before wave 10 it could not reach CLI calls. For interactive runs 600 000 ms (10 min) per
phase is a reasonable starting point when you want faster failure feedback.

## Session fork

The base skeleton call captures a `session_id`. Each per-Layer detail call resumes it with
`--resume <id> --fork-session`, so the skeleton's reasoning is live in each forked context
without re-sending the full prompt. This replaces prompt caching as the fan-out efficiency
mechanism.

Opt out with `SLEEK_CLI_SESSION_FORK=0`.
