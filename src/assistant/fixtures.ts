/**
 * Shared test fixtures for the assistant tests. Not part of the runtime path.
 */

import type {
  Anchor,
  ContextBundle,
  Layer,
  ReviewScaffold,
} from "../domain/scaffold.ts";

export function makeAnchor(partial: Partial<Anchor> = {}): Anchor {
  return {
    file: "src/util.ts",
    side: "RIGHT",
    startLine: 10,
    endLine: 20,
    ...partial,
  };
}

export function makeBundle(partial: Partial<ContextBundle> = {}): ContextBundle {
  return {
    summary: "Refactors the retry helper to use exponential backoff.",
    neighbors: [
      {
        ref: "retry",
        signature: "function retry(fn, opts)",
        oneLine: "function retry — definition enclosing the changed lines",
      },
      {
        ref: "backoff",
        signature: "function backoff(attempt)",
        oneLine: "function backoff — referenced by the changed lines",
      },
    ],
    history: [
      {
        sha: "abcdef1234567890",
        subject: "Introduce retry helper",
        whenRelevant: "3 weeks ago",
      },
    ],
    learnings: [],
    ...partial,
  };
}

export function makeLayer(partial: Partial<Layer> = {}): Layer {
  return {
    id: "layer-1",
    anchors: [makeAnchor()],
    order: 0,
    bundle: makeBundle(),
    findings: [],
    ...partial,
  };
}

export function makeScaffold(layers: Layer[]): ReviewScaffold {
  return {
    pr: {
      number: 1,
      title: "Add backoff",
      description: "",
      baseSha: "base",
      headSha: "head",
    },
    layers,
  };
}
