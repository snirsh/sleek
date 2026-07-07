# Sleek — Implementation Plan

> Vocabulary: [CONTEXT.md](../CONTEXT.md). Decisions: [docs/adr/](adr/) (0001–0004).
> This plan reflects the design after grilling.

## 1. Shape

A **local web app**. A Node backend serves a React frontend over localhost; the frontend
is a three-panel diff reviewer (file tree · diff with inline Findings · chat panel).
Nothing leaves the machine except the Scaffolder calls and any Reviewer-initiated
Escalation calls; the Assistant, the store, PR fetch, and repo analysis are all local.

## 2. Stack

- **TypeScript end-to-end.** Backend: Node + Fastify. Frontend: React + Vite.
- Scaffolder runs via CLI agents (Claude Code CLI / Codex CLI) or Replay (authored-JSON).
  `@anthropic-ai/sdk` remains for Escalation and the env-only `anthropic` escape hatch.
  Ollama HTTP at `localhost:11434` (Assistant) · `gh` shell-out (PR metadata + diff) ·
  `web-tree-sitter` (graph neighbors) · `simple-git` + git worktrees (checkout, blame/history).
- Store: SQLite via `better-sqlite3`.
- Models: Scaffolder = Claude Code CLI (Fable 5 / Opus 4.8 / Sonnet) or Codex CLI, running
  under the user's existing subscription quota (no per-token billing). Assistant = qwen3 on
  Ollama (30B-class quant; treat usable window ≈ 32K).

## 3. Data flow

```
GitHub PR ─▶ [1] Ingest ─▶ ChangeSet (diff + metadata + head SHA)
                              │
        [2] Context Builder (git worktree @ head SHA, tree-sitter graph, git blame)
                              │
        [3] Scaffolder — TWO PHASE (ADR-0003):
              3a skeleton call  → Layer boundaries (anchors → Layer), ordered
              3b per-Layer fan-out (parallel) → distilled Context Bundle + Findings
                              │  (3a writes prompt cache; 3b reads it)
                              ▼
                    Review Scaffold ─▶ [4] Store (SQLite, keyed by PR + head SHA)
                              │
                              ▼
        [5] UI: diff + inline Findings + LOC selection + chat + "Ask Opus"
                              │  question about selected lines → owning Layer
                              ▼
        [6] Assistant (qwen3): answer scoped to the Layer's budgeted Bundle;
             backend hydrates neighbor source lazily within remaining window
                              │  Reviewer clicks "Ask Opus" (or nudged)
                              ▼
        [7] Escalation → Opus with the Layer's distilled Bundle (fresh, cache-independent)
```

## 4. Contracts (lock these first)

### Anchor (ADR-0004)
`{ file: string, side: "LEFT" | "RIGHT", startLine: int, endLine: int }`.

### Review Scaffold schema (M3 output — the two-model contract)
```
ReviewScaffold {
  pr: { number, title, description, baseSha, headSha }
  layers: Layer[]                      // ordered foundational-first, ties by max severity
}
Layer {
  id
  anchors: Anchor[]                    // tiles the changeset; every changed line in one Layer
  order: int
  bundle: ContextBundle
  findings: Finding[]
}
ContextBundle {                        // budgeted (~8K tokens), distilled
  summary: string
  neighbors: { ref, signature, oneLine }[]   // source hydrated lazily, NOT inlined
  history: { sha, subject, whenRelevant }[]
  learnings: []                        // reserved slot, empty in v1 (ADR: Learning deferred)
}
Finding {
  anchor: Anchor
  concern: "correctness"|"security"|"performance"|"tests"|"maintainability"
  severity: "critical"|"major"|"minor"|"info"
  text: string                         // prose; may contain a code block
  suggestedFix?: null                  // reserved; no one-click apply in v1
}
```

## 5. Milestones (subagents implement; orchestrator reviews on landing)

- **M0 Scaffold-schema + types** — the contract above as TS types + a JSON Schema for
  strict tool use. Lock before anything depends on it.
- **M1 Ingest** — ChangeSet from a GitHub PR via `gh` (diff + metadata + head SHA).
- **M2 Context Builder** — git worktree at head SHA (never touches the user's tree);
  tree-sitter graph neighbors + `git blame`/log per changed hunk; bounded.
- **M3 Scaffolder** — two-phase: skeleton call (Layer boundaries) → parallel per-Layer
  detail calls (Bundle + Findings), strict tool use, streaming, prompt cache on the shared
  prefix, per-Layer token budget. Emits a validated Review Scaffold.
- **M4 Store** — SQLite for scaffolds (keyed by PR + head SHA); staleness check on load
  (compare stored vs current head SHA → warn + offer full re-scaffold; never auto-run).
- **M5 Assistant + Escalation** — Ollama client; per-Layer prompt assembly from the
  budgeted Bundle; lazy neighbor-source hydration; Reviewer-triggered "Ask Opus" escalation
  (fresh small Opus call with the Bundle) + heuristic nudge when a question reaches outside
  the Bundle.
- **M6 UI** — diff viewer, inline Findings, LOC selection → Layer resolution, chat panel,
  "Ask Opus" button, staleness banner.

Deferred (not v1): Learnings capture, one-click fix apply, incremental re-scaffold, fresh
clone fallback, standalone packaging.

## 6. Cost
Scaffolder is the only heavy cost. Skeleton call is small; per-Layer detail calls read the
cached prefix at ~0.1×. A large PR lands on the order of ~$1–2. Assistant Q&A is free;
Escalation is an occasional small call.
