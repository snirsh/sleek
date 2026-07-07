# Sleek — Guide for coding agents

This file tells an AI coding agent (Claude Code, Codex, Cursor, …) how to work with a
running Sleek review session. For the human-facing overview, read [README.md](README.md);
for the domain language (Scaffolder, Layer, Finding, Thread, …), read [CONTEXT.md](CONTEXT.md).

## What Sleek gives you

Sleek serves a **Review Scaffold** for one PR on a local HTTP port: the changeset split
into ordered **Layers**, each with **Findings** (anchored observations with a Concern tag
and severity) and a distilled **Context Bundle**. You can read all of it and file
**draft comments** that the human reviewer sees in the UI. You cannot submit anything to
GitHub — that is always a human action.

## Connecting

Discover the active server for the current repo/PR:

```bash
sleek connect --json
# → { "url": "http://127.0.0.1:<port>", "pr": <n>, "agent": { ...endpoint paths } }
```

If nothing is running, the human starts one with `sleek review <pr>`.

## Agent API

All endpoints are on the server URL from `sleek connect`:

- `GET /api/agent/context` — the full scaffold: PR metadata, Layers in review order,
  Findings with anchors, thread state. Start here; it is designed to be read once.
- `GET /api/agent/comments` — comments filed so far (yours and others').
- `POST /api/agent/comments` — file a draft comment. Body: an anchor
  (`{file, side: "LEFT"|"RIGHT", startLine, endLine}`) plus a markdown `body`.
  Anchors must land on changed lines — use the anchors from `/api/agent/context`
  or `sleek regions <pr> --json` as your source of truth.
- `POST /api/agent/comments/:id/visibility` — show/hide one of your comments.

Supporting endpoints you may also use read-only:

- `GET /api/context`, `GET /api/filerows` — diff rows and per-file context as the UI sees them.
- `POST /api/lsp/{hover,definition,diagnostics}` — LSP-backed code intel inside the PR's
  worktree (check `GET /api/lsp/status` first).

## Rules of engagement

1. **Never call GitHub.** No `gh pr review`, no review submission. Your output is local
   draft comments; the human batches and submits the Review.
2. **Anchor precisely.** Comments must use GitHub review coordinates (LEFT = old file,
   RIGHT = new file, 1-based inclusive lines) on lines that are part of the changeset.
3. **Respect the Layer structure.** Questions and comments about a line belong to the
   Layer that owns it; the Layer's Context Bundle is the intended context for reasoning
   about it.
4. **Don't mutate state you don't own.** Do not resolve/unresolve threads or touch
   `/api/review/*`, `/api/scaffold/*`, or `/api/finish` — those belong to the reviewer.

## Installing the skill

The repo ships a ready-made skill that encodes all of the above:

```bash
npx skills add . --skill sleek-agent --agent claude-code --global   # or codex | cursor
```

## Working on the Sleek codebase itself

- `npm run typecheck` · `npm test` (vitest) · `npm run test:e2e` (Playwright).
- Source map: see the Development section of [README.md](README.md).
- Design decisions live in [docs/adr/](docs/adr/); the scaffolder's provider/CLI
  mechanics in [docs/CLI-AGENTS.md](docs/CLI-AGENTS.md).
- Replay fixtures (`scripts/reviews/<pr>.json`) let you exercise the full pipeline
  without any model calls.
