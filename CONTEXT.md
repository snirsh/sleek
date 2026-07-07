# Sleek

A local PR code reviewer. A large cloud model (the **Scaffolder**) analyzes a pull
request once and lays down a structured, layered review with pre-computed context; a
small local model (the **Assistant**) then answers the reviewer's line-level questions
against that structure; the reviewer can escalate any answer back to the Scaffolder.

## Language

### Models & roles

**Scaffolder**:
The large-model role that performs the one-shot upfront analysis of a PR and produces the
Review Scaffold. Runs rarely and expensively, executed by a selectable Provider.
_Avoid_: big model, Opus (in prose), architect, engine

**Provider**:
The backend that executes a Scaffolder run — the Claude Code CLI or the Codex CLI, with a
model choice; or Replay, which replays an authored review instead of calling a model.
Selected per run.
_Avoid_: engine, backend, runner

**Assistant**:
The small local model (qwen3 on Ollama) that answers the reviewer's interactive
questions about specific lines, scoped to a single Layer's Context Bundle. Runs often
and cheaply, offline.
_Avoid_: small model, local LLM, qwen3 (in prose)

**Reviewer**:
The human using the tool to review a PR. Selects lines and asks questions.
_Avoid_: user, developer

### The scaffold

**Review Scaffold**:
The complete artifact the Scaffolder produces for one PR: the ordered set of Layers,
each with its Context Bundle and Findings, plus PR-level metadata. The structure the
Assistant works within.
_Avoid_: review plan, walkthrough, index

**Layer**:
The primary unit of a Review Scaffold — a change cohort: an independent cluster of
functionally connected changes. Layers **completely tile the changeset** — every changed
line belongs to exactly one Layer — so any selected line resolves to a Layer. Given an
ordered position (foundational changes before the code that depends on them; ties broken
by the Layer's highest Finding severity). A Layer is the retrieval unit: a question about
a line is answered using the Layer that owns that line.
_Avoid_: cohort, segment, chunk, group

**Anchor**:
Where a Layer or Finding attaches, in GitHub review-comment coordinates:
`{file, side, startLine, endLine}` where side is LEFT (old file) or RIGHT (new file), so
deleted lines can be addressed. The coordinate space in which Layers tile the changeset.
_Avoid_: position, location, range

**Context Bundle**:
A **budgeted, distilled** artifact the Scaffolder pre-computes and attaches to a Layer so
the Assistant can answer without re-analyzing the codebase: a plain-language summary,
graph neighbors as references + one-line descriptions (callers/callees/definitions —
their source is hydrated lazily by the backend, not pre-stuffed), relevant git history,
and applicable Learnings. Fits within a fixed per-Layer token budget so it fits the
Assistant's context window.
_Avoid_: memory, context, payload

### Findings & annotations

**Finding**:
A specific observation the Scaffolder attaches to an Anchor within a Layer — the hints
and suggestions the Reviewer sees in the UI before asking anything. Carries a Concern tag
and a severity, and optionally a `suggestedFix` (a reserved slot; v1 findings are prose,
which may contain a code block, with no one-click apply).
_Avoid_: comment, hint, suggestion, issue, annotation

**Concern**:
The review lens a Finding belongs to: correctness, security, performance, tests, or
maintainability. A tag on a Finding, never a unit of the scaffold's structure.
_Avoid_: category, dimension, lens, aspect

### Threads & review

**Thread**:
The single conversation primitive: an Anchor-attached discussion with a status
(open/resolved) and an ordered list of Comments. Scaffolder Findings open Threads; the
Reviewer and the Assistant reply into them. All commentary in Sleek is a Thread.
_Avoid_: discussion, conversation, comment chain

**Comment**:
One entry in a Thread, with a typed author (finding, reviewer, or assistant) and a
markdown body. Reviewer Comments start out pending (part of the Review draft) until the
Review is submitted.
_Avoid_: note, message, reply (a reply IS a Comment)

**Review**:
The Reviewer's batched verdict on a PR: pending Comments accumulate into it, and
submitting finalizes them with a verdict (approve, request changes, or comment) and an
optional summary.
_Avoid_: approval, sign-off

### Interaction & memory

**Escalation**:
Re-asking a Reviewer's question of the Scaffolder instead of the Assistant, **initiated by
the Reviewer** (an "Ask Opus" action; the UI may nudge when a question reaches outside the
Layer's budgeted Bundle). A fresh, small call carrying only the Layer's distilled Context
Bundle — deliberately independent of the scaffold-time prompt cache.
_Avoid_: fallback, handoff, deferral

**Learning**:
A durable piece of guidance that persists across PRs (e.g. a team convention or a
correction the Reviewer taught the tool), loaded into a Layer's Context Bundle when
applicable. Reserved concept — the schema keeps a slot, but v1 builds no capture path.
_Avoid_: rule, note, memory, preference
