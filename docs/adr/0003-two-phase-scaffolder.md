# The Scaffolder is two-phase: skeleton call, then per-Layer detail fan-out

*Amended by [0005](0005-cli-agent-providers-for-scaffolding.md): the skeleton now answers in region indices rather than verbatim anchors.*

The Scaffolder does not produce the whole Review Scaffold in one call. Phase 1 is a cheap
**skeleton** call: Opus reads the ChangeSet + built repo context and returns only the Layer
boundaries (which anchors belong to which Layer, ordered). Phase 2 **fans out** one small
call per Layer, in parallel, each producing that Layer's distilled Context Bundle and
Findings against a fixed per-Layer token budget.

## Why

A single monolithic structured-output call must tile the entire diff, distill every Bundle,
and attach every Finding in one response — for a large PR this approaches the 128K output
cap and is exactly where models get lazy (thinning coverage late in the response). Splitting
keeps each call small enough to stay high-quality, lets the per-Layer budget (see the
Context Bundle contract) be enforced per call, and parallelizes.

The shared repo-context prefix is written to the prompt cache by the skeleton call and read
by every per-Layer detail call at ~0.1× input cost — so the fan-out is much cheaper than the
call count suggests. This makes prompt caching load-bearing, scoped to the fan-out window.

## Consequences

- Prompt caching is a correctness/cost dependency of the fan-out, not an optional nicety.
- The per-Layer budget is enforced at the detail call, keeping Bundles inside the Assistant's
  window.
- A high PR-size cap remains as a guardrail against pathological inputs.
