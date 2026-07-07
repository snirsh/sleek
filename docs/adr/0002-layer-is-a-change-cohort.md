# A Layer is a change cohort, not a concern or a depth pass

A Layer — the primary unit of the Review Scaffold — is an architectural **change cohort**
(a cluster of functionally connected changes), following CodeRabbit's usage. It is
explicitly *not* a semantic concern (security/performance/…) and *not* a progressive depth
pass (shallow→deep). Layers **completely tile the changeset**: every changed line belongs
to exactly one Layer, so any selected line resolves to a Layer (not just flagged regions).

## Why

The system is fundamentally a line-level Q&A tool, and a Q&A tool indexes by *where the
code is*. When the Reviewer asks about a line, we must map that line to one unit that
owns a self-contained context. Only a region/cohort gives that: it is line-range-anchored
and doubles as the context-window budget for the small local Assistant.

Concern is *how you label what you found* — it becomes a tag on each Finding, not the
structure. Layers surface in the UI ordered foundational-first, ties broken by the Layer's
highest Finding severity.

## Considered and rejected

- **Concern as the primary axis** (Sourcery, Qodo): a line spans concerns, so it can't be
  the retrieval unit. Kept as a Finding tag.
- **Progressive depth pass** (Cursor Bugbot, Copilot effort levels): depth is a knob, not
  a place to anchor a question. Folded into Escalation.
- **Risk Score as a per-Layer field** (RADAR): justified only by a multi-pass depth-routing
  story we don't have (the Scaffolder is one-shot per Layer). Dropped — Layer ordering uses
  max Finding severity instead. Reintroduce only if a genuine risk-driven second pass lands.
