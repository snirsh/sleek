import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ContextInput } from "../context/index.ts";
import type { Anchor, ChangeSet } from "../domain/scaffold.ts";
import { parseReviewScaffold } from "../domain/scaffold.ts";
import * as cliRunner from "./cli-runner.ts";
import { CliAgentLlmRunner, type CliAgentConfig } from "./cli-runner.ts";
import type { LlmRequest, LlmRunner, LlmUsage } from "./llm.ts";
import * as runners from "./runners.ts";
import {
  buildSharedSystem,
  FANOUT_MIN_FILES,
  FANOUT_MIN_REGIONS,
  findUncoveredRegions,
  scaffold,
  TilingError,
} from "./scaffolder.ts";
import type { ScaffoldProgressEvent } from "./scaffolder.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────

const CHANGE_SET: ChangeSet = {
  pr: {
    number: 7,
    title: "Add caching layer",
    description: "Introduces a cache in front of the store.",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
  },
  unifiedDiff: "diff --git a/src/cache.ts b/src/cache.ts\n@@ -0,0 +1,2 @@\n+export const cache = {};\n",
  files: ["src/cache.ts", "src/store.ts"],
  noiseFiles: [],
};

const ANCHOR_A: Anchor = { file: "src/cache.ts", side: "RIGHT", startLine: 1, endLine: 2 };
const ANCHOR_B: Anchor = { file: "src/store.ts", side: "RIGHT", startLine: 10, endLine: 12 };

const CONTEXT_INPUT: ContextInput = {
  headSha: "h".repeat(40),
  regions: [
    {
      anchor: ANCHOR_A,
      neighbors: [
        { ref: "src/cache.ts#cache", signature: "const cache: Record<string, unknown>", oneLine: "the cache map" },
      ],
      history: [{ sha: "abc1234", subject: "init", whenRelevant: "created the file" }],
    },
    {
      anchor: ANCHOR_B,
      neighbors: [
        { ref: "src/store.ts#read", signature: "function read(k: string): unknown", oneLine: "store reader" },
      ],
      history: [],
    },
  ],
  dedup: { siblings: new Map(), groupSize: new Map() },
};

const ZERO_USAGE: LlmUsage = {
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * A fake LlmRunner that returns canned skeleton + per-Layer tool outputs, keyed off the
 * tool name in each request. `skeleton` is returned for the 3a call; `detailFor(userText)`
 * produces a per-Layer 3b output. Records every request for assertions.
 */
function fakeRunner(config: {
  skeleton: unknown;
  detailFor: (request: LlmRequest) => unknown;
}): LlmRunner & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async run(request: LlmRequest) {
      requests.push(request);
      const toolInput =
        request.tool.name === "emit_layer_boundaries"
          ? config.skeleton
          : config.detailFor(request);
      return { toolInput, usage: ZERO_USAGE };
    },
  };
}

/** A well-formed per-Layer detail whose neighbors are refs only (no inlined source). */
function goodDetail() {
  return {
    bundle: {
      summary: "Adds a cache map and wires the store reader through it.",
      neighbors: [
        { ref: "src/cache.ts#cache", signature: "const cache", oneLine: "the cache map" },
      ],
      history: [{ sha: "abc1234", subject: "init", whenRelevant: "created the file" }],
      learnings: [],
    },
    findings: [
      {
        anchor: ANCHOR_A,
        concern: "maintainability",
        severity: "minor",
        text: "Consider a typed cache instead of `{}`.",
      },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────────────

describe("scaffold — two-phase orchestration", () => {
  it("fans out per Layer and assembles a scaffold that passes parseReviewScaffold", async () => {
    const runner = fakeRunner({
      skeleton: {
        layers: [
          { id: "L0", order: 0, regionIndexes: [0] },
          { id: "L1", order: 1, regionIndexes: [1] },
        ],
      },
      detailFor: () => goodDetail(),
    });

    const result = await scaffold(CHANGE_SET, CONTEXT_INPUT, { runner });

    // Does not throw — and the returned value round-trips through the domain validator.
    expect(() => parseReviewScaffold(result)).not.toThrow();
    expect(result.pr.number).toBe(7);
    expect(result.layers).toHaveLength(2);
    expect(result.layers.map((l) => l.id)).toEqual(["L0", "L1"]);

    // One skeleton call (3a, cachePrefix) + one detail call per Layer (3b), fanned out.
    expect(runner.requests).toHaveLength(3);
    const skeletonReqs = runner.requests.filter((r) => r.cachePrefix);
    const detailReqs = runner.requests.filter((r) => !r.cachePrefix);
    expect(skeletonReqs).toHaveLength(1);
    expect(detailReqs).toHaveLength(2);

    // The shared system prefix is byte-identical across all calls (so it caches).
    const systems = new Set(runner.requests.map((r) => r.system));
    expect(systems.size).toBe(1);
    // Only the 3a call writes the cache; 3b calls read it.
    expect(skeletonReqs[0]!.cachePrefix).toBe(true);
    expect(detailReqs.every((r) => !r.cachePrefix)).toBe(true);
  });

  it("assembles bundles whose neighbors are refs only — no full source is inlined", async () => {
    const runner = fakeRunner({
      skeleton: { layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }] },
      detailFor: () => goodDetail(),
    });

    const result = await scaffold(CHANGE_SET, CONTEXT_INPUT, { runner });
    const bundle = result.layers[0]!.bundle;

    // Neighbors carry ref/signature/oneLine only — the shape has no `source`/`body` field.
    for (const n of bundle.neighbors) {
      expect(Object.keys(n).sort()).toEqual(["oneLine", "ref", "signature"]);
    }
    // learnings is always [] (reserved slot).
    expect(bundle.learnings).toEqual([]);
    // suggestedFix is omitted from produced Findings (reserved slot).
    for (const f of result.layers[0]!.findings) {
      expect("suggestedFix" in f).toBe(false);
    }
  });

  it("repairs an incomplete tiling by sweeping dropped regions into a trailing Layer", async () => {
    // Skeleton drops ANCHOR_B — only covers ANCHOR_A.
    const runner = fakeRunner({
      skeleton: { layers: [{ id: "L0", order: 0, regionIndexes: [0] }] },
      detailFor: () => goodDetail(),
    });

    const result = await scaffold(CHANGE_SET, CONTEXT_INPUT, { runner });

    // The dropped region is swept into a synthetic trailing Layer, so the scaffold still
    // tiles the changeset. Two detail calls fan out (original + repair Layer).
    expect(result.layers).toHaveLength(2);
    const repair = result.layers.find((l) => l.id === "__uncovered__");
    expect(repair).toBeDefined();
    expect(repair!.anchors).toContainEqual(ANCHOR_B);
    expect(() => parseReviewScaffold(result)).not.toThrow();
  });

  it("throws TilingError when a region is dropped and repair is disabled", async () => {
    const runner = fakeRunner({
      skeleton: { layers: [{ id: "L0", order: 0, regionIndexes: [0] }] },
      detailFor: () => goodDetail(),
    });

    await expect(
      scaffold(CHANGE_SET, CONTEXT_INPUT, { runner, onIncompleteTiling: "throw" }),
    ).rejects.toBeInstanceOf(TilingError);
  });
});

describe("findUncoveredRegions — tiling validation", () => {
  it("flags a changed region that belongs to no Layer", () => {
    const skeleton = { layers: [{ id: "L0", order: 0, anchors: [ANCHOR_A] }] };
    const missing = findUncoveredRegions(skeleton, CONTEXT_INPUT);
    expect(missing.map((r) => r.anchor)).toEqual([ANCHOR_B]);
  });

  it("returns empty when the Layers tile the changeset exactly", () => {
    const skeleton = {
      layers: [
        { id: "L0", order: 0, anchors: [ANCHOR_A] },
        { id: "L1", order: 1, anchors: [ANCHOR_B] },
      ],
    };
    expect(findUncoveredRegions(skeleton, CONTEXT_INPUT)).toEqual([]);
  });
});

describe("scaffold — skeleton region-index validation", () => {
  it("drops an invalid region index and emits a warning; tiling repair still covers the region", async () => {
    // Skeleton claims an out-of-range index (99, no such region) alongside index 0
    // (ANCHOR_A) only. Index 1 (ANCHOR_B) is not claimed at all, so it is repaired.
    const runner = fakeRunner({
      skeleton: {
        layers: [{ id: "L0", order: 0, regionIndexes: [0, 99] }],
      },
      detailFor: () => goodDetail(),
    });

    const warnings: string[] = [];
    const result = await scaffold(CHANGE_SET, CONTEXT_INPUT, {
      runner,
      onWarning: (msg) => warnings.push(msg),
    });

    // The invalid index must have been warned and dropped.
    expect(warnings.some((w) => w.includes("invalid region index 99") && w.includes("dropped"))).toBe(true);

    // ANCHOR_B (index 1) was uncovered, so a repair layer should cover it.
    const repair = result.layers.find((l) => l.id === "__uncovered__");
    expect(repair).toBeDefined();
    expect(repair!.anchors).toContainEqual(ANCHOR_B);

    // Overall scaffold is valid.
    expect(() => parseReviewScaffold(result)).not.toThrow();
  });

  it("keeps first claim on a duplicate region index; second layer emits a warning", async () => {
    // L0 claims index 0 first; L1 also claims index 0 (duplicate) plus index 1.
    const runner = fakeRunner({
      skeleton: {
        layers: [
          { id: "L0", order: 0, regionIndexes: [0] },
          { id: "L1", order: 1, regionIndexes: [0, 1] },
        ],
      },
      detailFor: () => goodDetail(),
    });

    const warnings: string[] = [];
    const result = await scaffold(CHANGE_SET, CONTEXT_INPUT, {
      runner,
      onWarning: (msg) => warnings.push(msg),
    });

    // Warning for the duplicate from L1.
    expect(warnings.some((w) => w.includes("L1") && w.includes("dropped"))).toBe(true);

    // L0 keeps ANCHOR_A (index 0); L1 should still have ANCHOR_B (its non-duplicate index).
    const l0 = result.layers.find((l) => l.id === "L0");
    const l1 = result.layers.find((l) => l.id === "L1");
    expect(l0).toBeDefined();
    expect(l1).toBeDefined();
    expect(l0!.anchors).toContainEqual(ANCHOR_A);
    expect(l1!.anchors).toContainEqual(ANCHOR_B);
    expect(l1!.anchors.some((a) => a.file === ANCHOR_A.file && a.startLine === ANCHOR_A.startLine)).toBe(false);
  });

  it("drops a layer entirely when all its region indexes are invalid", async () => {
    // L0 only has an invalid index (99) → zero valid indexes → layer dropped.
    // L1 has indexes 0 and 1 → stays.
    const runner = fakeRunner({
      skeleton: {
        layers: [
          { id: "L0", order: 0, regionIndexes: [99] },
          { id: "L1", order: 1, regionIndexes: [0, 1] },
        ],
      },
      detailFor: () => goodDetail(),
    });

    const warnings: string[] = [];
    const result = await scaffold(CHANGE_SET, CONTEXT_INPUT, {
      runner,
      onWarning: (msg) => warnings.push(msg),
    });

    // L0 should not be present in the output.
    expect(result.layers.find((l) => l.id === "L0")).toBeUndefined();
    // L1 must be present with both anchors.
    const l1 = result.layers.find((l) => l.id === "L1");
    expect(l1).toBeDefined();
    // Warning emitted for the dropped layer.
    expect(warnings.some((w) => w.includes("L0") && w.includes("dropped"))).toBe(true);
    expect(() => parseReviewScaffold(result)).not.toThrow();
  });
});

describe("scaffold — detail finding anchor validation", () => {
  it("drops a finding whose anchor is outside the layer's anchors with a warning", async () => {
    // The finding anchor is in a completely different file/range — outside L0's ANCHOR_A.
    const outOfLayerFinding = {
      anchor: { file: "src/other.ts", side: "RIGHT" as const, startLine: 1, endLine: 5 },
      concern: "correctness" as const,
      severity: "major" as const,
      text: "This should be dropped.",
    };
    const runner = fakeRunner({
      skeleton: {
        layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }],
      },
      detailFor: () => ({
        ...goodDetail(),
        findings: [outOfLayerFinding],
      }),
    });

    const warnings: string[] = [];
    const result = await scaffold(CHANGE_SET, CONTEXT_INPUT, {
      runner,
      onWarning: (msg) => warnings.push(msg),
    });

    // Finding must have been dropped.
    expect(result.layers[0]!.findings).toHaveLength(0);
    // Warning emitted.
    expect(warnings.some((w) => w.includes("src/other.ts") && w.includes("dropped"))).toBe(true);
  });

  it("keeps a finding whose anchor is a contained sub-range of a layer anchor", async () => {
    // ANCHOR_A covers lines 1-2; finding is on line 1-1 (sub-range — valid).
    const narrowFinding = {
      anchor: { file: "src/cache.ts", side: "RIGHT" as const, startLine: 1, endLine: 1 },
      concern: "maintainability" as const,
      severity: "minor" as const,
      text: "Sub-range finding — should be kept.",
    };
    const runner = fakeRunner({
      skeleton: {
        layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }],
      },
      detailFor: () => ({
        ...goodDetail(),
        findings: [narrowFinding],
      }),
    });

    const warnings: string[] = [];
    const result = await scaffold(CHANGE_SET, CONTEXT_INPUT, {
      runner,
      onWarning: (msg) => warnings.push(msg),
    });

    // Finding must be kept.
    expect(result.layers[0]!.findings).toHaveLength(1);
    expect(result.layers[0]!.findings[0]!.anchor.startLine).toBe(1);
    expect(result.layers[0]!.findings[0]!.anchor.endLine).toBe(1);
    // No warnings.
    expect(warnings).toHaveLength(0);
  });
});

describe("scaffold — detail fan-out concurrency cap", () => {
  it("never exceeds the concurrency cap and returns results in layer order", async () => {
    // Six layers, each with its own anchor in a purpose-built ContextInput.
    const anchors: Anchor[] = Array.from({ length: 6 }, (_, i) => ({
      file: "src/file.ts",
      side: "RIGHT" as const,
      startLine: i * 10 + 1,
      endLine: i * 10 + 5,
    }));
    const bigContextInput: ContextInput = {
      headSha: "h".repeat(40),
      regions: anchors.map((a) => ({ anchor: a, neighbors: [], history: [] })),
      dedup: { siblings: new Map(), groupSize: new Map() },
    };

    // Synchronous in-flight tracking: the fake runner resolves immediately but records
    // the peak concurrency. Because the worker pool dispatches up to cap=2 calls before
    // awaiting any of them, even with instant resolution we observe the peak.
    let inFlight = 0;
    let maxInFlight = 0;

    const trackingRunner: LlmRunner & { requests: LlmRequest[] } = {
      requests: [],
      async run(request: LlmRequest) {
        trackingRunner.requests.push(request);
        if (request.tool.name === "emit_layer_boundaries") {
          return {
            toolInput: {
              layers: anchors.map((_a, i) => ({ id: `L${i}`, order: i, regionIndexes: [i] })),
            },
            usage: ZERO_USAGE,
          };
        }
        // Each detail call increments the counter, yields to let other microtasks run,
        // then decrements. The yield is essential: without it, the async scheduler never
        // hands control back so a second worker could observe the concurrent count.
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await Promise.resolve(); // yield — lets other workers advance into their increment
        inFlight--;
        return {
          toolInput: {
            bundle: { summary: "test", neighbors: [], history: [], learnings: [] },
            findings: [],
          },
          usage: ZERO_USAGE,
        };
      },
    };

    const result = await scaffold(CHANGE_SET, bigContextInput, {
      runner: trackingRunner,
      detailConcurrency: 2,
    });

    // Peak concurrency must never exceed the cap.
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(2);

    // Results must come back in layer order regardless of completion order.
    expect(result.layers.map((l) => l.id)).toEqual(["L0", "L1", "L2", "L3", "L4", "L5"]);
  });
});

describe("scaffold — onProgress callbacks", () => {
  it("emits skeleton start/done and detail progress events in order", async () => {
    const runner = fakeRunner({
      skeleton: {
        layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }],
      },
      detailFor: () => goodDetail(),
    });

    const events: ScaffoldProgressEvent[] = [];
    await scaffold(CHANGE_SET, CONTEXT_INPUT, {
      runner,
      onProgress: (e) => events.push(e),
    });

    // Filter to skeleton/detail phase events only (plan and detail-layer are new Wave-2 events).
    const phaseEvents = events.filter((e) => e.phase === "skeleton" || e.phase === "detail");
    expect(phaseEvents).toEqual([
      { phase: "skeleton", status: "start" },
      { phase: "skeleton", status: "done" },
      { phase: "detail", status: "start" },
      { phase: "detail", status: "progress", done: 1, total: 1 },
      { phase: "detail", status: "done" },
    ]);
  });

  it("emits a progress event per layer in multi-layer scaffolds", async () => {
    const runner = fakeRunner({
      skeleton: {
        layers: [
          { id: "L0", order: 0, regionIndexes: [0] },
          { id: "L1", order: 1, regionIndexes: [1] },
        ],
      },
      detailFor: () => goodDetail(),
    });

    const progressEvents: Array<{ phase: "detail"; status: "progress"; done?: number; total?: number }> = [];
    await scaffold(CHANGE_SET, CONTEXT_INPUT, {
      runner,
      onProgress: (e) => {
        if (e.phase === "detail" && e.status === "progress") {
          progressEvents.push(e as { phase: "detail"; status: "progress"; done?: number; total?: number });
        }
      },
    });

    // Two layers → two progress events with done=1 and done=2 (order may vary since parallel)
    expect(progressEvents).toHaveLength(2);
    const doneValues = progressEvents.map((e) => e.done).sort();
    expect(doneValues).toEqual([1, 2]);
    expect(progressEvents.every((e) => e.total === 2)).toBe(true);
  });
});

// ── buildSharedSystem — diff variant ─────────────────────────────────────────────────

describe("buildSharedSystem — diff variants", () => {
  it("inline variant embeds the unified diff in a ```diff fence", () => {
    const system = buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, { kind: "inline" });
    expect(system).toContain("Unified diff:");
    expect(system).toContain("```diff");
    expect(system).toContain(CHANGE_SET.unifiedDiff);
  });

  it("file variant references the absolute path and does NOT embed the raw diff", () => {
    const diffPath = "/tmp/sleek-test.patch";
    const system = buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, { kind: "file", path: diffPath });
    // Must NOT contain the raw diff text
    expect(system).not.toContain(CHANGE_SET.unifiedDiff);
    // Must NOT contain the diff fence
    expect(system).not.toContain("```diff");
    // Must reference the file path
    expect(system).toContain(diffPath);
    // Must mention changed files
    expect(system).toContain("src/cache.ts");
  });

  it("file variant includes the changed files list from changeSet.files", () => {
    const system = buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, { kind: "file", path: "/x/diff.patch" });
    for (const f of CHANGE_SET.files) {
      expect(system).toContain(f);
    }
  });

  it("defaults to inline when no diffVariant is passed", () => {
    const system = buildSharedSystem(CHANGE_SET, CONTEXT_INPUT);
    expect(system).toContain("```diff");
    expect(system).toContain(CHANGE_SET.unifiedDiff);
  });

  it("both variants include the PR title and region listing", () => {
    const inline = buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, { kind: "inline" });
    const file = buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, { kind: "file", path: "/x/diff.patch" });
    for (const system of [inline, file]) {
      expect(system).toContain("Add caching layer");
      expect(system).toContain("src/cache.ts");
      expect(system).toContain("Changed regions");
    }
  });
});

// ── scaffold — diff file lifecycle for CLI runners ───────────────────────────────────

describe("scaffold — diff file lifecycle for CLI runners", () => {
  it("does NOT write a diff file when the runner is not a CliAgentLlmRunner (API path)", async () => {
    // The fakeRunner from above is not a CliAgentLlmRunner, so scaffold must use
    // the inline variant and must NOT write any temp file.
    let receivedSystem: string | undefined;
    const capturingRunner: LlmRunner = {
      async run(request: LlmRequest) {
        receivedSystem = request.system;
        if (request.tool.name === "emit_layer_boundaries") {
          return {
            toolInput: { layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }] },
            usage: ZERO_USAGE,
          };
        }
        return {
          toolInput: {
            bundle: { summary: "s", neighbors: [], history: [], learnings: [] },
            findings: [],
          },
          usage: ZERO_USAGE,
        };
      },
    };

    await scaffold(CHANGE_SET, CONTEXT_INPUT, { runner: capturingRunner });

    // API runner: system must embed the diff inline.
    expect(receivedSystem).toBeDefined();
    expect(receivedSystem).toContain(CHANGE_SET.unifiedDiff);
    expect(receivedSystem).toContain("```diff");
  });

  it("writes a diff file and references its path in the system prompt for CliAgentLlmRunner", async () => {
    // Use a custom provider that echoes back the prompt file content so we can
    // inspect the system the runner received.
    let capturedSystem: string | undefined;

    // Intercept at the LlmRunner.run level by subclassing CliAgentLlmRunner and
    // overriding run() to capture the request without spawning anything.
    class CapturingCliRunner extends CliAgentLlmRunner {
      captured: LlmRequest[] = [];
      constructor() {
        super({ provider: "custom", commandTemplate: "echo ok" });
      }
      override async run(request: LlmRequest): Promise<{ toolInput: unknown; usage: LlmUsage }> {
        this.captured.push(request);
        capturedSystem = request.system;
        if (request.tool.name === "emit_layer_boundaries") {
          return {
            toolInput: { layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }] },
            usage: ZERO_USAGE,
          };
        }
        return {
          toolInput: {
            bundle: { summary: "s", neighbors: [], history: [], learnings: [] },
            findings: [],
          },
          usage: ZERO_USAGE,
        };
      }
    }

    const runner = new CapturingCliRunner();
    await scaffold(CHANGE_SET, CONTEXT_INPUT, { runner });

    expect(capturedSystem).toBeDefined();
    // CLI runner: system must NOT embed the raw diff inline.
    expect(capturedSystem).not.toContain("```diff");
    // System must reference a file path that ends with .patch.
    expect(capturedSystem).toMatch(/\.patch/);
    // The raw diff must NOT appear in the prompt (that's the whole point).
    expect(capturedSystem).not.toContain(CHANGE_SET.unifiedDiff);
  });

  it("cleans up the diff temp file after the scaffold completes", async () => {
    let capturedDiffPath: string | undefined;

    class CapturingCliRunner extends CliAgentLlmRunner {
      constructor() {
        super({ provider: "custom", commandTemplate: "echo ok" });
      }
      override async run(request: LlmRequest): Promise<{ toolInput: unknown; usage: LlmUsage }> {
        // Extract the diff file path from the system prompt on the skeleton call.
        if (request.tool.name === "emit_layer_boundaries" && !capturedDiffPath) {
          const match = /(\S+\.patch)/u.exec(request.system);
          if (match) capturedDiffPath = match[1];
        }
        if (request.tool.name === "emit_layer_boundaries") {
          return {
            toolInput: { layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }] },
            usage: ZERO_USAGE,
          };
        }
        return {
          toolInput: {
            bundle: { summary: "s", neighbors: [], history: [], learnings: [] },
            findings: [],
          },
          usage: ZERO_USAGE,
        };
      }
    }

    await scaffold(CHANGE_SET, CONTEXT_INPUT, { runner: new CapturingCliRunner() });

    // After scaffold completes, the diff file must have been cleaned up.
    expect(capturedDiffPath).toBeDefined();
    expect(existsSync(capturedDiffPath!)).toBe(false);
  });

  it("cleans up the diff temp file even when scaffold throws (e.g. TilingError)", async () => {
    let capturedDiffPath: string | undefined;

    class CapturingCliRunner extends CliAgentLlmRunner {
      constructor() {
        super({ provider: "custom", commandTemplate: "echo ok" });
      }
      override async run(request: LlmRequest): Promise<{ toolInput: unknown; usage: LlmUsage }> {
        if (request.tool.name === "emit_layer_boundaries") {
          if (!capturedDiffPath) {
            const match = /(\S+\.patch)/u.exec(request.system);
            if (match) capturedDiffPath = match[1];
          }
          // Return a skeleton that covers only ANCHOR_A — ANCHOR_B will be uncovered,
          // triggering TilingError when onIncompleteTiling="throw".
          return {
            toolInput: { layers: [{ id: "L0", order: 0, regionIndexes: [0] }] },
            usage: ZERO_USAGE,
          };
        }
        return {
          toolInput: {
            bundle: { summary: "s", neighbors: [], history: [], learnings: [] },
            findings: [],
          },
          usage: ZERO_USAGE,
        };
      }
    }

    await expect(
      scaffold(CHANGE_SET, CONTEXT_INPUT, {
        runner: new CapturingCliRunner(),
        onIncompleteTiling: "throw",
      }),
    ).rejects.toBeInstanceOf(TilingError);

    // File must be cleaned up even on failure.
    expect(capturedDiffPath).toBeDefined();
    expect(existsSync(capturedDiffPath!)).toBe(false);
  });

  it("writes the diff file into runner.cwd when cwd is set", async () => {
    // Create a real temp dir to act as the runner's cwd (simulating a worktree).
    const fakeCwd = await mkdtemp(join(tmpdir(), "sleek-test-cwd-"));
    try {
      let capturedSystem: string | undefined;

      class CwdCapturingRunner extends CliAgentLlmRunner {
        constructor() {
          super({ provider: "custom", commandTemplate: "echo ok", cwd: fakeCwd });
        }
        override async run(request: LlmRequest): Promise<{ toolInput: unknown; usage: LlmUsage }> {
          capturedSystem = request.system;
          if (request.tool.name === "emit_layer_boundaries") {
            return {
              toolInput: { layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }] },
              usage: ZERO_USAGE,
            };
          }
          return {
            toolInput: {
              bundle: { summary: "s", neighbors: [], history: [], learnings: [] },
              findings: [],
            },
            usage: ZERO_USAGE,
          };
        }
      }

      await scaffold(CHANGE_SET, CONTEXT_INPUT, { runner: new CwdCapturingRunner() });

      // The system prompt must reference a path inside fakeCwd.
      expect(capturedSystem).toBeDefined();
      expect(capturedSystem).toContain(fakeCwd);
      // The diff file must be gone (cleaned up by scaffold's finally block).
      expect(existsSync(join(fakeCwd, ".sleek-scaffold-diff.patch"))).toBe(false);
    } finally {
      // Belt-and-suspenders cleanup of the fake cwd.
      await rm(fakeCwd, { recursive: true, force: true });
    }
  });

  it("falls back to tmpdir when runner.cwd is not set", async () => {
    let capturedSystem: string | undefined;

    class NoCwdRunner extends CliAgentLlmRunner {
      constructor() {
        super({ provider: "custom", commandTemplate: "echo ok" });
      }
      override async run(request: LlmRequest): Promise<{ toolInput: unknown; usage: LlmUsage }> {
        capturedSystem = request.system;
        if (request.tool.name === "emit_layer_boundaries") {
          return {
            toolInput: { layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }] },
            usage: ZERO_USAGE,
          };
        }
        return {
          toolInput: {
            bundle: { summary: "s", neighbors: [], history: [], learnings: [] },
            findings: [],
          },
          usage: ZERO_USAGE,
        };
      }
    }

    await scaffold(CHANGE_SET, CONTEXT_INPUT, { runner: new NoCwdRunner() });

    // System must reference a .patch path under tmpdir().
    expect(capturedSystem).toBeDefined();
    expect(capturedSystem).toContain(tmpdir());
    expect(capturedSystem).toContain(".sleek-scaffold-diff.patch");
  });
});

// ── buildSharedSystem — RTK guidance block ───────────────────────────────────────────

describe("buildSharedSystem — RTK guidance", () => {
  const variant = { kind: "file" as const, path: "/x/diff.patch" };

  it("appends a claude-flavored rtk block that leads with git-history commands", () => {
    const system = buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, variant, { rtk: "claude" });
    expect(system).toContain("rtk read <file>");
    expect(system).toContain("rtk git log --oneline -- <file>");
    // claude flavor: leads with git history + Bash pre-approval note.
    expect(system).toContain("LEAD with the git-history commands");
    expect(system).toContain("Only rtk-prefixed commands are");
    expect(system).toContain("pre-approved for the Bash tool");
    expect(system).toContain("Keep the built-in");
    // claude flavor must NOT carry the codex fallback wording.
    expect(system).not.toContain("run the plain");
  });

  it("appends a codex-flavored rtk block that prefixes all commands and falls back", () => {
    const system = buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, variant, { rtk: "codex" });
    expect(system).toContain("rtk read <file>");
    expect(system).toContain("Prefix all exploration commands with `rtk`");
    expect(system).toContain("If rtk is missing or fails, run the plain");
    // codex flavor must NOT carry the claude Bash pre-approval wording.
    expect(system).not.toContain("pre-approved for the Bash tool");
  });

  it("omits the rtk block entirely when guidance is not given", () => {
    const system = buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, variant);
    // Exact absence: not a single mention of rtk.
    expect(system).not.toContain("rtk");
  });

  it("is byte-identical to the no-guidance output when rtk is omitted or false", () => {
    const base = buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, variant);
    // Passing an empty guidance object and { rtk: false } must both be byte-identical.
    expect(buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, variant, {})).toBe(base);
    expect(buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, variant, { rtk: false })).toBe(base);
    // The guided output is strictly longer (a block was appended).
    expect(buildSharedSystem(CHANGE_SET, CONTEXT_INPUT, variant, { rtk: "claude" }).length)
      .toBeGreaterThan(base.length);
    // And the no-guidance output never mentions rtk.
    expect(base).not.toContain("rtk");
  });
});

// ── scaffold — RTK guidance + subagent fan-out wiring ────────────────────────────────

/**
 * Build a changeset + context input above the fan-out gate: more than FANOUT_MIN_FILES
 * changed files AND more than FANOUT_MIN_REGIONS regions. Regions carry unique anchors so
 * the skeleton can tile them cleanly.
 */
function bigFixture(): { changeSet: ChangeSet; contextInput: ContextInput; anchors: Anchor[] } {
  const regionCount = FANOUT_MIN_REGIONS + 5;
  const anchors: Anchor[] = Array.from({ length: regionCount }, (_, i) => ({
    file: `src/mod${i}.ts`,
    side: "RIGHT" as const,
    startLine: 1,
    endLine: 3,
  }));
  const files = Array.from({ length: FANOUT_MIN_FILES + 4 }, (_, i) => `src/mod${i}.ts`);
  const changeSet: ChangeSet = {
    pr: {
      number: 42,
      title: "Big refactor",
      description: "Touches many modules.",
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
    },
    unifiedDiff: "diff --git a/src/mod0.ts b/src/mod0.ts\n@@ -0,0 +1,3 @@\n+x\n",
    files,
    noiseFiles: [],
  };
  const contextInput: ContextInput = {
    headSha: "h".repeat(40),
    regions: anchors.map((a) => ({ anchor: a, neighbors: [], history: [] })),
    dedup: { siblings: new Map(), groupSize: new Map() },
  };
  return { changeSet, contextInput, anchors };
}

/**
 * A skeleton output that puts every region into a single Layer (tiles the changeset).
 * The skeleton contract speaks region INDEXES, so this claims indexes 0..count-1 — which
 * for bigFixture (regions built 1:1 from anchors, in order) covers every anchor.
 */
function skeletonCovering(anchors: Anchor[]): unknown {
  return { layers: [{ id: "L0", order: 0, regionIndexes: anchors.map((_, i) => i) }] };
}

/** A canned per-Layer detail with no findings (keeps detail responses valid + trivial). */
function emptyDetail(): unknown {
  return {
    bundle: { summary: "s", neighbors: [], history: [], learnings: [] },
    findings: [],
  };
}

/** Route a request to skeleton or detail output based on its tool name. */
function respond(request: LlmRequest, anchors: Anchor[]) {
  return {
    toolInput:
      request.tool.name === "emit_layer_boundaries"
        ? skeletonCovering(anchors)
        : emptyDetail(),
    usage: ZERO_USAGE,
  };
}

const FANOUT_MARKER = "launch parallel `Explore` subagents";

/** An env whose PATH contains a real dir with a fake `rtk` binary, so the probe passes. */
async function envWithFakeRtk(): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sleek-rtk-bin-"));
  await rm(join(dir, "rtk"), { force: true });
  await import("node:fs/promises").then((m) => m.writeFile(join(dir, "rtk"), "#!/bin/sh\n"));
  return { env: { PATH: dir }, dir };
}

describe("scaffold — subagent fan-out gate (claude)", () => {
  it("adds the fan-out paragraph to the skeleton userText only, above the threshold", async () => {
    const { changeSet, contextInput, anchors } = bigFixture();
    const cwd = await mkdtemp(join(tmpdir(), "sleek-fanout-cwd-"));
    const { env, dir } = await envWithFakeRtk();
    try {
      const runner = new CliAgentLlmRunner({ provider: "claude", cwd, env });
      const spy = vi.spyOn(runner, "run").mockImplementation(async (request: LlmRequest) =>
        respond(request, anchors),
      );

      await scaffold(changeSet, contextInput, { runner, env });

      const skeletonReqs = spy.mock.calls.map((c) => c[0]).filter((r) => r.cachePrefix);
      const detailReqs = spy.mock.calls.map((c) => c[0]).filter((r) => !r.cachePrefix);
      expect(skeletonReqs).toHaveLength(1);
      expect(detailReqs.length).toBeGreaterThan(0);
      // (a) skeleton carries the fan-out paragraph.
      expect(skeletonReqs[0]!.userText).toContain(FANOUT_MARKER);
      // The paragraph names the concrete diff file path (file variant).
      expect(skeletonReqs[0]!.userText).toContain(".sleek-scaffold-diff.patch");
      expect(skeletonReqs[0]!.userText).toContain("REGION INDICES");
      // Every detail request must NOT carry it.
      for (const r of detailReqs) expect(r.userText).not.toContain(FANOUT_MARKER);
      // (c) system is identical across the skeleton and all detail requests.
      const systems = new Set(spy.mock.calls.map((c) => c[0].system));
      expect(systems.size).toBe(1);
      // rtk block present (claude flavor) on that shared system.
      expect(skeletonReqs[0]!.system).toContain("LEAD with the git-history commands");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does NOT add the fan-out paragraph below the threshold", async () => {
    // CHANGE_SET has 2 files / 2 regions — well below both thresholds.
    const cwd = await mkdtemp(join(tmpdir(), "sleek-fanout-cwd-"));
    const { env, dir } = await envWithFakeRtk();
    try {
      const runner = new CliAgentLlmRunner({ provider: "claude", cwd, env });
      const spy = vi.spyOn(runner, "run").mockImplementation(async (request: LlmRequest) =>
        respond(request, [ANCHOR_A, ANCHOR_B]),
      );

      await scaffold(CHANGE_SET, CONTEXT_INPUT, { runner, env });

      // (b) no request carries the paragraph.
      for (const call of spy.mock.calls) {
        expect(call[0].userText).not.toContain(FANOUT_MARKER);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("(d) codex gets the rtk block but never the fan-out paragraph, even above threshold", async () => {
    const { changeSet, contextInput, anchors } = bigFixture();
    const cwd = await mkdtemp(join(tmpdir(), "sleek-fanout-cwd-"));
    const { env, dir } = await envWithFakeRtk();
    try {
      const runner = new CliAgentLlmRunner({ provider: "codex", cwd, env });
      const spy = vi.spyOn(runner, "run").mockImplementation(async (request: LlmRequest) =>
        respond(request, anchors),
      );

      await scaffold(changeSet, contextInput, { runner, env });

      for (const call of spy.mock.calls) {
        expect(call[0].userText).not.toContain(FANOUT_MARKER);
      }
      // codex rtk flavor present on the shared system.
      const system = spy.mock.calls[0]![0].system;
      expect(system).toContain("Prefix all exploration commands with `rtk`");
      expect(system).not.toContain("pre-approved for the Bash tool");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("(e) a plain non-CLI fake runner gets neither the rtk block nor the fan-out paragraph", async () => {
    const { changeSet, contextInput, anchors } = bigFixture();
    const runner = fakeRunner({
      skeleton: skeletonCovering(anchors),
      detailFor: () => emptyDetail(),
    });

    await scaffold(changeSet, contextInput, { runner });

    for (const r of runner.requests) {
      expect(r.userText).not.toContain(FANOUT_MARKER);
      expect(r.system).not.toContain("rtk");
    }
  });

  it("(f) claude runner with rtk absent gets no rtk block (probe mocked to false)", async () => {
    const { changeSet, contextInput, anchors } = bigFixture();
    const cwd = await mkdtemp(join(tmpdir(), "sleek-fanout-cwd-"));
    // The well-known-path probe (/opt/homebrew/bin/rtk) exists on this machine, so the
    // only honest way to simulate "rtk absent" is to mock the probe itself.
    const spyProbe = vi.spyOn(cliRunner, "rtkBinaryAvailable").mockReturnValue(false);
    try {
      const runner = new CliAgentLlmRunner({ provider: "claude", cwd });
      const spy = vi.spyOn(runner, "run").mockImplementation(async (request: LlmRequest) =>
        respond(request, anchors),
      );

      await scaffold(changeSet, contextInput, { runner });

      // No rtk block on any request (rtk absent).
      for (const call of spy.mock.calls) {
        expect(call[0].system).not.toContain("rtk");
      }
      // The fan-out paragraph is gated on claude + size only (NOT on rtk), so it is
      // still present on the skeleton — but it must not mention the rtk-only block.
      const skeleton = spy.mock.calls.map((c) => c[0]).find((r) => r.cachePrefix);
      expect(skeleton!.userText).toContain(FANOUT_MARKER);
    } finally {
      spyProbe.mockRestore();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── B4: model tiering — CLI provider path ────────────────────────────────────────────
//
// These tests verify that when tiering is enabled and NO runner is explicitly injected,
// scaffold() calls createDefaultScaffolderRunner a second time with the cheap model id.
// We spy on the runners module so we can observe the model passed without needing to
// run real CLI scaffolding.

describe("scaffold — model tiering (no injected runner)", () => {
  it("calls createDefaultScaffolderRunner with cheapModel when tiering is enabled", async () => {
    // Spy on createDefaultScaffolderRunner: first call returns a fake runner for
    // the primary model; second call (cheap tier) also returns a fake runner.
    // We capture the model argument from each call.
    const capturedModels: Array<string | undefined> = [];
    const spyFactory = vi.spyOn(runners, "createDefaultScaffolderRunner").mockImplementation(
      (_env, model) => {
        capturedModels.push(model);
        // Return a simple fake runner for both the primary and cheap calls.
        return {
          async run(request: LlmRequest) {
            if (request.tool.name === "emit_layer_boundaries") {
              return {
                toolInput: {
                  layers: [
                    { id: "L0", order: 0, regionIndexes: [0] },
                    { id: "L1", order: 1, regionIndexes: [1] },
                  ],
                },
                usage: ZERO_USAGE,
              };
            }
            return {
              toolInput: {
                bundle: { summary: "s", neighbors: [], history: [], learnings: [] },
                findings: [],
              },
              usage: ZERO_USAGE,
            };
          },
        } as LlmRunner;
      },
    );

    try {
      // No runner injected → scaffold builds its own runner via createDefaultScaffolderRunner.
      await scaffold(CHANGE_SET, CONTEXT_INPUT, {
        tieringEnabled: true,
        cheapModel: "claude-sonnet-4-6",
        // No `runner` option — this triggers the factory-based cheap runner path.
      });

      // The factory should have been called at least twice:
      //   call 1: primary runner (with options.model = undefined or the configured model)
      //   call 2: cheap runner (with cheapModelId = "claude-sonnet-4-6")
      expect(capturedModels.length).toBeGreaterThanOrEqual(2);
      expect(capturedModels).toContain("claude-sonnet-4-6");
    } finally {
      spyFactory.mockRestore();
    }
  });

  it("does NOT call createDefaultScaffolderRunner a second time when tiering is disabled", async () => {
    const capturedModels: Array<string | undefined> = [];
    const spyFactory = vi.spyOn(runners, "createDefaultScaffolderRunner").mockImplementation(
      (_env, model) => {
        capturedModels.push(model);
        return {
          async run(request: LlmRequest) {
            if (request.tool.name === "emit_layer_boundaries") {
              return {
                toolInput: {
                  layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }],
                },
                usage: ZERO_USAGE,
              };
            }
            return {
              toolInput: {
                bundle: { summary: "s", neighbors: [], history: [], learnings: [] },
                findings: [],
              },
              usage: ZERO_USAGE,
            };
          },
        } as LlmRunner;
      },
    );

    try {
      await scaffold(CHANGE_SET, CONTEXT_INPUT, {
        tieringEnabled: false,
        cheapModel: "claude-sonnet-4-6",
      });

      // Only one call (the primary runner); no cheap-runner factory call.
      expect(capturedModels).toHaveLength(1);
      expect(capturedModels).not.toContain("claude-sonnet-4-6");
    } finally {
      spyFactory.mockRestore();
    }
  });

  it("does NOT call createDefaultScaffolderRunner for cheap runner when runner is injected", async () => {
    // With an explicitly injected fake runner that is not a DefaultLlmRunner,
    // tiering should not fabricate a cheap runner via the factory.
    const spyFactory = vi.spyOn(runners, "createDefaultScaffolderRunner");

    try {
      const injectedRunner = fakeRunner({
        skeleton: { layers: [{ id: "L0", order: 0, regionIndexes: [0, 1] }] },
        detailFor: () => goodDetail(),
      });

      await scaffold(CHANGE_SET, CONTEXT_INPUT, {
        runner: injectedRunner,
        tieringEnabled: true,
        cheapModel: "claude-sonnet-4-6",
      });

      // The factory must NOT have been called (no runner was built by the factory path).
      expect(spyFactory).not.toHaveBeenCalled();
    } finally {
      spyFactory.mockRestore();
    }
  });
});
