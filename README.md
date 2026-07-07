# Sleek

**A local PR code reviewer.** A large cloud model (the **Scaffolder**) analyzes a pull
request once and lays down a structured, layered review with pre-computed context; a
small local model (the **Assistant**, via Ollama) then answers your line-level questions
instantly and offline; you can escalate any answer back to the Scaffolder. You review in
a local three-panel web UI and submit the finished review to GitHub when — and only
when — you decide to.

## How it works

```
GitHub PR ──▶ Ingest (gh) ──▶ Context build (worktree + tree-sitter + git history)
                                      │
                                      ▼
                         Scaffolder (Claude Code / Codex CLI, one expensive run)
                                      │
                                      ▼
                     Review Scaffold: Layers + Findings + Context Bundles
                                      │
                                      ▼
              Local web UI ◀──▶ Assistant (Ollama, fast & offline)
                    │                 │
                    │            Escalation ("Ask the Scaffolder")
                    ▼
        Batched Review ──▶ export to GitHub (approve / request changes / comment)
```

- A **Layer** is a cluster of functionally connected changes. Layers completely tile the
  changeset, ordered foundational-first, so every changed line belongs to exactly one Layer.
- Each Layer carries a budgeted **Context Bundle** (summary, graph neighbors, relevant git
  history) so the small local model can answer questions without re-analyzing the codebase.
- **Findings** are the Scaffolder's observations, anchored to lines, tagged with a Concern
  (correctness, security, performance, tests, maintainability) and a severity.
- All discussion happens in anchored **Threads**; your pending comments batch into a
  **Review** that you submit with a verdict.

See [CONTEXT.md](CONTEXT.md) for the full domain language and
[docs/adr/](docs/adr/) for design decisions.

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 20 | ESM project, run via `tsx` |
| `git` and [`gh`](https://cli.github.com/) | `gh` must be authenticated (`gh auth status`) — used for PR ingest and export |
| [Ollama](https://ollama.com/) | Local Assistant. Pull a qwen3 model, e.g. `ollama pull qwen3:30b` |
| Claude Code CLI and/or Codex CLI | The Scaffolder provider. At least one is required for real scaffold runs (not needed for replay mode) |

## Install

```bash
git clone https://github.com/snirsh/sleek
cd sleek
npm install        # builds better-sqlite3 native module
npm link           # optional: makes `sleek` available on PATH
```

Without `npm link`, substitute `npx tsx scripts/sleek.ts` for `sleek` everywhere below.

## Quickstart

```bash
cd /path/to/repo-under-review
sleek review 1234 --process --open
```

This ingests PR #1234, runs the Scaffolder (a Claude Code run by default — expect
minutes on a large PR), stores the scaffold in `.sleek/demo.db`, and serves the review
UI on a free local port. Without `--process`, Sleek opens an explore-first view and you
trigger the scaffold from the UI.

Run `sleek review` with no arguments for an interactive repo + PR picker
(scans `SLEEK_REPO_ROOTS`).

When you're done reviewing:

```bash
sleek finish 1234 --yes    # removes the PR's pooled worktree and disposable cache
```

## CLI

| Command | Purpose |
|---|---|
| `sleek review [<pr>]` | Full pipeline + serve the UI. Flags: `--repo <path>`, `--port <n>`, `--open`, `--refresh`, `--process`, `--json` |
| `sleek connect` | Print the active local server and `/api/agent` endpoints for this repo/PR. Flags: `--repo`, `--pr <n>`, `--json` |
| `sleek list` | List scaffolds stored in `.sleek/demo.db` |
| `sleek regions <pr>` | Dump the PR's changed regions/anchors (useful for authoring replay reviews) |
| `sleek clean` | Delete caches and stale pooled worktrees (dry-run by default; `--yes` to apply). Never touches `demo.db` |
| `sleek finish <pr>` | Remove the PR's worktree and disposable cache |

Exit codes: `0` success, `1` user/environment error, `2` internal error.

## Configuration

Everything is environment variables and CLI flags — there is no config file.

### Scaffolder

| Variable | Default | Purpose |
|---|---|---|
| `SLEEK_SCAFFOLDER_PROVIDER` | `claude` | `claude` or `codex` (plus env-only `anthropic` / `custom` escape hatches) |
| `SLEEK_SCAFFOLDER_MODEL` | provider default | Model passed to the provider CLI (e.g. `opus`, `gpt-5`) |
| `SLEEK_SCAFFOLDER_COMMAND` | — | Custom provider command template; placeholders `{promptFile}` `{schemaFile}` `{outputFile}` `{model}` |
| `SLEEK_ESCALATION_PROVIDER` / `SLEEK_ESCALATION_MODEL` | scaffolder's | Separate engine for escalations |
| `ANTHROPIC_API_KEY` | — | Required only for the `anthropic` provider |
| `SLEEK_SCAFFOLDER_TIMEOUT_MS` | `1800000` | Per scaffolder CLI call |
| `SLEEK_AGENT_TIMEOUT_MS` | `1800000` | Per agent call |
| `SLEEK_SCAFFOLD_RUN_TIMEOUT_MS` | `2700000` | Whole-job watchdog |
| `SLEEK_AGENT_RETRIES` | `1` | Retries per CLI call |
| `SLEEK_SCAFFOLDER_DETAIL_CONCURRENCY` | — | Parallel per-Layer detail calls |
| `SLEEK_SCAFFOLDER_DIFF_MAX_CHARS` | — | Diff truncation budget |
| `SLEEK_CLI_RTK=0` / `SLEEK_CLI_SESSION_FORK=0` / `SLEEK_CLI_LEAN` | — | Kill switches for rtk rules, session forking, lean prompts |

### Assistant & environment

| Variable | Default | Purpose |
|---|---|---|
| `SLEEK_OLLAMA_MODEL` | auto-picked qwen3, prefers `qwen3:30b` | Assistant model |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `SLEEK_REPO_ROOTS` | — | Colon-separated roots the repo picker scans; first is the clone target |
| `SLEEK_REFRESH=1` | — | Bypass the `gh` response cache |
| `SLEEK_GH_BIN` / `SLEEK_OPEN_CMD` / `SLEEK_URL` | — | Binary / browser-open / URL overrides |
| `SLEEK_LSP_MAX_PROJECTS` | — | Cap on LSP projects per worktree |

### Per-repo state (`.sleek/`)

- `demo.db` — scaffolds, threads, reviews, saved replies. Durable; never auto-deleted.
- `cache.db` — disposable `gh`/context cache; removed by `sleek clean` / `sleek finish`.
- `serve-<port>.log`, `scaffold-worker-<pr>.log` — server and worker logs.

## Replay mode (no model required)

If `scripts/reviews/<pr>.json` exists for a PR, Sleek replays that authored review
instead of calling any model — useful for demos, tests, and authoring reviews by hand.
Use `sleek regions <pr>` to get valid anchors; the format is documented in
`scripts/demo-data.ts`.

## Agent integration

Sleek exposes a read/write API so coding agents (Claude Code, Codex, Cursor) can
participate in a review without touching GitHub:

```bash
npx skills add . --skill sleek-agent --agent claude-code --global
```

An agent then runs `sleek connect --json` to discover the local server, reads the
scaffold via `GET /api/agent/context`, and files draft comments via
`POST /api/agent/comments`. Agent comments stay local-only; submitting anything to
GitHub remains a human action. See [skills/sleek-agent/SKILL.md](skills/sleek-agent/SKILL.md)
and [docs/CLI-AGENTS.md](docs/CLI-AGENTS.md).

## HTTP API overview

The server binds to a local port per repo/PR (discover it with `sleek connect`).
Key routes:

- `GET /` — the review UI. `GET /api/health`.
- `GET/POST /api/threads`, `POST /api/threads/:id/{comments,resolve,unresolve,ask}` — threads; `ask` streams an Assistant answer.
- `POST /api/ask`, `POST /api/escalate` — streaming Q&A against the Assistant / Scaffolder.
- `GET /api/review`, `POST /api/review/submit`, `POST /api/review/export` — the batched review and GitHub export.
- `POST /api/scaffold`, `GET /api/scaffold/{stream,status}`, `POST /api/scaffold/cancel` — scaffold jobs (NDJSON progress).
- `GET /api/lsp/status`, `POST /api/lsp/{hover,definition,diagnostics}` — LSP-backed code intel.
- `GET /api/agent/context`, `GET/POST /api/agent/comments` — the agent API.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (colocated *.test.ts)
npm run test:e2e    # Playwright (e2e/*.spec.ts)
```

Project layout (`src/`): `domain/` scaffold types · `ingest/` gh-based PR ingest ·
`context/` diff regions + context builder · `scaffolder/` two-phase scaffolder and
providers · `assistant/` Ollama Q&A + escalation · `server/` HTTP server + scaffold
jobs · `store/` + `cache/` SQLite · `render/` the single-page UI · `export/` GitHub
review payload · `lsp/` per-worktree LSP · `cli/` command layer · `perf/` timing.

## Limitations (v1)

- **Learnings** (durable cross-PR guidance) and **suggestedFix** are reserved schema
  slots — no capture path or one-click apply yet.
- No incremental re-scaffold: a stale scaffold (PR head moved) warns and offers a full re-run.
- Escalation is always reviewer-initiated.
- The server is meant for localhost use on a trusted machine — do not expose it to a network.

## License

MIT
