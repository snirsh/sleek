# Two-model split: cloud Scaffolder, local Assistant, with escalation

We split review work across two models rather than using one. A large cloud model (the
**Scaffolder**, Opus) runs once per PR to build the Review Scaffold — the expensive,
whole-PR reasoning that produces Layers and their Context Bundles. A small local model
(the **Assistant**, qwen3 on Ollama) then handles the many cheap, interactive line-level
questions offline. The Reviewer can **escalate any answer back to the Scaffolder** on
demand ("Ask Opus"); the UI may nudge when a question reaches outside the Layer's budgeted
Bundle. Escalation is user-initiated, not gated on a self-reported confidence score —
small-model confidence is too miscalibrated to trust as an automatic gate.

## Why

The two workloads have opposite economics: scaffolding is rare, deep, and worth cloud
cost; interactive Q&A is frequent, shallow, latency-sensitive, and benefits from running
locally (cost, privacy, offline). A single model forces one compromise for both. The
local model performs adequately *only because* the Scaffolder pre-computes a tight
Context Bundle per Layer — the split is what makes the small model viable.

## Consequences

- The Context Bundle is the contract between the two models; its quality caps the
  Assistant's quality. It is budgeted and distilled so it fits the Assistant's window.
- Escalation is a fresh, small call carrying only the Layer's distilled Bundle — it does
  not depend on the scaffold-time prompt cache, so session length never interacts with
  cache TTL.
- Fully offline operation is possible after scaffolding, except when the Reviewer chooses
  to escalate.
