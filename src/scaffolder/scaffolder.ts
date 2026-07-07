/**
 * M3 Scaffolder — turns {ChangeSet (M1) + ContextInput (M2)} into a validated
 * ReviewScaffold (src/domain/scaffold.ts). Two-phase per ADR-0003:
 *
 *   Phase 3a — one skeleton call: given the diff + a compact indexed view of the changed
 *     regions, return ONLY the Layer boundaries (ordered list of { id, order,
 *     regionIndexes }). Each Layer answers with the INDICES of the changed regions it
 *     owns, into the "Changed regions" table in the shared system prompt — NOT verbatim
 *     anchors. Indices are prompt-native (the table and the fan-out instruction already
 *     speak them) and, critically, tiny: on a mega-PR (hundreds of regions) verbatim
 *     {file,side,startLine,endLine} anchors made this one call ~44KB of JSON and
 *     output-token-bound (~37 min measured); the index list is ~2KB. Sleek expands each
 *     index back to its anchor (contextInput.regions[i].anchor); the indexes across all
 *     Layers must TILE the changeset, which we validate + repair here on the EXPANDED
 *     anchors. For a claude CLI runner on a large changeset (see FANOUT_MIN_*), the
 *     skeleton userText additionally instructs a gated fan-out of parallel Explore
 *     subagents, one per independent area, that report region-index clusters the parent
 *     synthesizes into Layer boundaries (detail calls never see this instruction).
 *
 *   Phase 3b — per-Layer detail fan-out (one call PER Layer, in PARALLEL): given a
 *     Layer's anchors + the ContextInput regions those anchors cover, produce that
 *     Layer's distilled ContextBundle (summary, neighbors as refs+one-line, history,
 *     learnings: []) and Findings, within a per-Layer token budget (~8K target).
 *
 * The shared system prefix is written to the prompt cache by 3a and read by every 3b
 * call when the configured runner supports caching (see llm.ts). Model/provider wiring
 * is behind the injectable {@link LlmRunner}, so this orchestration — including tiling
 * validation and assembly — is unit-testable with a fake runner and no API key.
 */

import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContextInput, RegionContext } from "../context/index.ts";
import type {
  Anchor,
  ChangeSet,
  ContextBundle,
  Finding,
  Layer,
  Neighbor,
  ReviewScaffold,
} from "../domain/scaffold.ts";
import { parseReviewScaffold } from "../domain/scaffold.ts";
import { CliAgentLlmRunner, rtkBinaryAvailable } from "./cli-runner.ts";
import type { LlmRunner, LlmTool } from "./llm.ts";
import { DefaultLlmRunner, SCAFFOLDER_MODEL } from "./llm.ts";
import { createDefaultScaffolderRunner } from "./runners.ts";
import {
  CHEAP_TIER_THRESHOLD,
  DEFAULT_MAX_SHARD_EFFORT,
  scoreFile,
  splitLayerIntoShards,
  type LayerShard,
  type ShardInput,
} from "./riskscore.ts";
import { layerDetailToolSchema, skeletonToolSchema } from "./schemas.ts";
import {
  TRIAGE_TOOL,
  buildTriageUserText,
  type TriageFlag,
  type TriageOutput,
} from "./triage.ts";
import { refuteFindings, type AnnotatedFinding } from "./refuter.ts";
import { dedupFindings } from "./findingdedup.ts";

// ── Phase-shaped types the tool outputs are parsed into ─────────────────────────────

/**
 * Phase-3a skeleton output as the model emits it: Layer boundaries by region INDEX
 * (indices into the "Changed regions" table). Sleek expands these to anchors.
 */
interface RawSkeletonLayer {
  id: string;
  order: number;
  regionIndexes: number[];
}
interface SkeletonOutput {
  layers: RawSkeletonLayer[];
}

/**
 * A skeleton Layer after Sleek has expanded its region indexes to anchors. This is the
 * internal shape every downstream step (tiling repair, detail calls, assembly) uses.
 */
interface SkeletonLayer {
  id: string;
  order: number;
  anchors: Anchor[];
}

/** Phase-3b per-Layer output: bundle + findings (no anchors/order — fixed by 3a). */
interface LayerDetailOutput {
  bundle: {
    summary: string;
    neighbors: Neighbor[];
    history: ContextBundle["history"];
    learnings: unknown[];
  };
  // Findings without the reserved `suggestedFix` slot (see schemas.ts follow-up (2)).
  findings: Array<Omit<Finding, "suggestedFix">>;
}

/**
 * Progress event emitted by scaffold() around the two phases.
 * Consumed by POST /api/scaffold to stream NDJSON events to the client.
 */
export type ScaffoldProgressEvent =
  | { phase: "skeleton" | "detail"; status: "start" | "done" | "progress"; done?: number; total?: number }
  | { phase: "plan"; layers: Array<{ id: string; order: number; regionCount: number; files: string[]; anchors: Anchor[] }> }
  | { phase: "detail-layer"; layerId: string; status: "start" | "done" | "retry"; ms?: number; findings?: number }
  | { phase: "activity"; layer?: string; text: string }
  /** B5: two-pass triage events. */
  | { phase: "pass"; pass: 1 | 2; status: "start" | "done"; shardCount?: number; highCount?: number }
  /** B5: refuter events (one per refuted finding). */
  | { phase: "refute"; status: "start" | "done"; total?: number; refuted?: number };

export interface ScaffoldOptions {
  /** Injected for tests; defaults to the real Anthropic-backed runner. */
  runner?: LlmRunner;
  /**
   * How to handle a skeleton that does not tile the changeset (drops changed regions).
   * "repair" (default) sweeps every uncovered region into a synthetic trailing Layer.
   * "throw" rejects instead.
   */
  onIncompleteTiling?: "repair" | "throw";
  /**
   * Progress callback: emitted around phase 3a (skeleton) and 3b (detail fan-out).
   * Called before/after each phase and after each layer detail completes.
   */
  onProgress?: (e: ScaffoldProgressEvent) => void;
  /**
   * Override the model threaded to DefaultLlmRunner (default: SCAFFOLDER_MODEL = claude-opus-4-8).
   * Only used when `runner` is not explicitly set.
   */
  model?: string;
  /**
   * Warning callback for non-fatal validation drops (invented anchors, duplicate claims,
   * out-of-layer findings). Default: no-op. Does NOT change ScaffoldProgressEvent shape.
   */
  onWarning?: (message: string) => void;
  /**
   * Maximum number of concurrent detail calls in phase 3b. Defaults to
   * SLEEK_SCAFFOLDER_DETAIL_CONCURRENCY env var (if set, positive integer) then 6.
   * Option wins over env.
   */
  detailConcurrency?: number;
  /**
   * Optional AbortSignal for early cancellation. When aborted, the phase-3b
   * worker pool stops launching new detail calls (best-effort: in-flight calls
   * are not interrupted, only the next scheduled one is dropped).
   */
  signal?: AbortSignal;
  /**
   * Environment used to probe for the RTK binary when deriving the RTK guidance block
   * (default: process.env). Should be the same env the CLI runner spawns with, so the
   * "is rtk available?" answer matches what the spawned agent will actually see. Only
   * consulted for a claude/codex CLI runner; ignored otherwise.
   */
  env?: NodeJS.ProcessEnv;

  // ── B4: balanced shards + model tiering ──────────────────────────────────────────────
  /**
   * Maximum effort per shard (LOC * risk). Layers whose total effort exceeds this
   * are split into multiple sub-shards before detail dispatch. Default: 200.
   * Only applied when the changeset is above the fan-out thresholds (gate: same as
   * FANOUT_MIN_FILES / FANOUT_MIN_REGIONS) so small PRs keep current single-pass behavior.
   */
  maxShardEffort?: number;
  /**
   * Model to use for LOW-RISK shards (avgRisk < CHEAP_TIER_THRESHOLD) when tiering is
   * enabled. Defaults to "claude-sonnet-4-6". Only meaningful when SLEEK_SCAFFOLDER_TIERING
   * env var is "1" (or `tieringEnabled` option is true).
   */
  cheapModel?: string;
  /**
   * Explicitly enable/disable model tiering. When true, low-risk shards route to
   * `cheapModel`. Defaults to `SLEEK_SCAFFOLDER_TIERING=1` env var. When disabled,
   * all shards use the same runner (safe conservative default).
   */
  tieringEnabled?: boolean;

  // ── B5: two-pass depth + adversarial refuter + cross-shard finding dedup ─────────────
  /**
   * Enable two-pass depth (B5). Pass 1 (cheap model) triages shards; pass 2 (strong
   * model) runs full detail only on high-risk shards. Low-risk shards get a triage
   * summary + no findings. Only applied when the size gate fires (large PR). Defaults
   * to SLEEK_SCAFFOLDER_TWO_PASS=1 env var. When no cheapRunner is available (e.g.
   * only one injected fake runner), degrades gracefully to single-pass.
   */
  twoPassEnabled?: boolean;
  /**
   * Enable adversarial refuter (B5). After findings are collected, critical/major
   * findings are challenged by a single cheap-model call. Refuted findings are demoted
   * to "minor". Only runs on large PRs. Defaults to SLEEK_SCAFFOLDER_REFUTER=1 env var.
   */
  refuterEnabled?: boolean;
  /**
   * Enable cross-shard finding dedup (B5). Before final assembly, findings with
   * identical normalized-text hash on the same anchor file are collapsed to one.
   * Defaults to true (always on — safe, conservative, no model calls).
   */
  dedupEnabled?: boolean;
}

/** Raised when the skeleton drops changed regions and repair is disabled. */
export class TilingError extends Error {
  readonly missing: Anchor[];
  constructor(missing: Anchor[]) {
    super(
      `Skeleton does not tile the changeset: ${missing.length} changed region(s) belong to no Layer.`,
    );
    this.name = "TilingError";
    this.missing = missing;
  }
}

// ── Anchor helpers ──────────────────────────────────────────────────────────────────

/** Canonical key for an Anchor so we can compare region coverage set-wise. */
function anchorKey(a: Anchor): string {
  return `${a.file} ${a.side} ${a.startLine} ${a.endLine}`;
}

// ── Prompt assembly ─────────────────────────────────────────────────────────────────

/**
 * How the unified diff is delivered in the shared system prompt.
 *
 * - "inline": the raw diff text is embedded directly in a ```diff fence. Used by
 *   the Anthropic-API runner (DefaultLlmRunner) which benefits from prompt caching
 *   and handles large payloads well.
 *
 * - "file": the diff has been written to `path` on disk. The prompt instructs the
 *   CLI agent to read that file rather than embedding the diff inline. Used by CLI
 *   runners (CliAgentLlmRunner) to avoid piping tens of megabytes over stdin on
 *   every skeleton + detail call.
 */
type DiffVariant =
  | { kind: "inline" }
  | { kind: "file"; path: string };

/**
 * Optional guidance appended to the shared system prompt.
 *
 * `rtk` — when a CLI Provider has the RTK proxy available, append a block steering
 * repo exploration through `rtk`-prefixed commands (compact, LLM-optimized output).
 * The phrasing differs per Provider (see buildRtkGuidance). Omit/false → no block, so
 * the prompt stays byte-identical to today (protects the Anthropic-API cache path).
 */
interface SharedSystemGuidance {
  rtk?: "claude" | "codex" | false;
}

/**
 * The RTK guidance block, differentiated per Provider. Returns the lines to append
 * after the diff section. Only called when guidance.rtk is truthy.
 *
 * Common core: prefer `rtk`-prefixed shell commands when exploring the repository.
 * claude leads with the git-history commands (its only path to git history, feeding the
 * Context Bundle) and notes only rtk-prefixed commands are pre-approved for Bash; codex
 * prefixes everything with rtk and falls back to the plain command if rtk is missing.
 */
function buildRtkGuidance(rtk: "claude" | "codex"): string[] {
  const common = [
    "Tooling: prefer `rtk`-prefixed shell commands when exploring the repository — they",
    "produce compact, LLM-optimized output. The forms you will use:",
    "  rtk read <file>          rtk grep <pattern> <path>   rtk ls <dir>   rtk find",
    "  rtk git log --oneline -- <file>   rtk git diff   rtk git blame <file>   rtk git show",
  ];
  if (rtk === "claude") {
    return [
      ...common,
      "",
      "LEAD with the git-history commands (`rtk git log` / `rtk git blame` / `rtk git show`):",
      "they are your only way to see git history and feed the Context Bundle's history",
      "section. Use `rtk grep` / `rtk ls` for bulk scans across many files. Keep the built-in",
      "Read tool for precise single-file inspection. Only rtk-prefixed commands are",
      "pre-approved for the Bash tool — other shell commands will be blocked.",
    ];
  }
  return [
    ...common,
    "",
    "Prefix all exploration commands with `rtk`. If rtk is missing or fails, run the plain",
    "command instead.",
  ];
}

/**
 * The shared system prefix — identical across the 3a and all 3b calls so it caches
 * (see llm.ts). Contains the Scaffolder's role, the vocabulary, and the whole diff +
 * a compact region listing. MUST be byte-stable across calls: no timestamps, no ids.
 *
 * When `diffVariant` is "file", the raw diff is NOT embedded; instead the prompt
 * references the absolute path so the CLI agent can read it directly from disk.
 *
 * When `guidance.rtk` is a Provider, an RTK guidance block is appended after the diff
 * section. When omitted/false the output is BYTE-IDENTICAL to the no-guidance prompt.
 */
export function buildSharedSystem(
  changeSet: ChangeSet,
  contextInput: ContextInput,
  diffVariant: DiffVariant = { kind: "inline" },
  guidance: SharedSystemGuidance = {},
): string {
  const regionLines = contextInput.regions
    .map(
      (r, i) =>
        `  [${i}] ${r.anchor.file} ${r.anchor.side} ${r.anchor.startLine}-${r.anchor.endLine}` +
        ` (neighbors: ${r.neighbors.length}, history: ${r.history.length})`,
    )
    .join("\n");

  const diffSection =
    diffVariant.kind === "file"
      ? [
          "The complete unified diff for this PR is in the file at:",
          diffVariant.path,
          "Read that file to see every change. You may also read any changed source file",
          "directly from the worktree as needed for deeper context.",
          "",
          "Changed files: " + changeSet.files.join(", "),
        ].join("\n")
      : ["Unified diff:", "```diff", changeSet.unifiedDiff, "```"].join("\n");

  const groupingHints = buildGroupingHints(contextInput);
  const lines = [
    "You are the Scaffolder for Sleek, a local PR reviewer. You perform the one-shot,",
    "whole-PR analysis that produces a layered Review Scaffold for a small local model to",
    "work within.",
    "",
    "A Layer is a change cohort: a cluster of functionally connected changes. Layers",
    "completely TILE the changeset — every changed region belongs to exactly one Layer.",
    "Order Layers foundational-first (changes others depend on come before their",
    "dependents).",
    "",
    "An Anchor is {file, side, startLine, endLine} where side is LEFT (old file) or RIGHT",
    "(new file), in GitHub review-comment coordinates.",
    "",
    `PR #${changeSet.pr.number}: ${changeSet.pr.title}`,
    changeSet.pr.description ? `\n${changeSet.pr.description}\n` : "",
    "Changed regions (index, anchor, available context counts):",
    regionLines,
    ...(groupingHints ? [groupingHints, ""] : [""]),
    diffSection,
  ];

  // Append the RTK guidance block ONLY when a Provider is given. Omitting it keeps the
  // prompt byte-identical to today's output (protects the Anthropic-API cache path).
  if (guidance.rtk) {
    lines.push("", ...buildRtkGuidance(guidance.rtk));
  }

  return lines.join("\n");
}

/**
 * Skeleton fan-out gate thresholds (exported for tests/tuning). When a claude CLI
 * Provider runs a changeset with more than FANOUT_MIN_FILES changed files OR more than
 * FANOUT_MIN_REGIONS changed regions, the skeleton userText gains a subagent fan-out
 * instruction. Straw-man values — tune against the `ms` skeleton-stage timing events.
 */
export const FANOUT_MIN_FILES = 8;
export const FANOUT_MIN_REGIONS = 25;

/**
 * The subagent fan-out paragraph appended to the SKELETON userText only (phase 3a) when
 * the claude gate fires. Detail calls (phase 3b) must never see it. `diffVariant` lets
 * the paragraph name the concrete diff file path when the diff was written to disk.
 */
/**
 * B3 — compact "Grouping hints" section injected into the skeleton system prompt when a
 * dependency graph is available. Returns "" when no graph so the prompt stays
 * byte-identical to pre-B3 output (protects the Anthropic-API cache path). Callers must
 * push NOTHING when this returns "".
 */
function buildGroupingHints(contextInput: ContextInput): string {
  const graph = contextInput.graph;
  if (!graph) return "";

  const lines: string[] = ["", "Grouping hints (from dependency graph):"];
  for (const cluster of graph.clusters) {
    const deps = graph.edges
      .filter((e) => e.from === cluster.project)
      .map((e) => {
        const depCluster = graph.clusters.find((c) => c.project === e.to);
        return depCluster
          ? e.to + " (regions [" + depCluster.regionIndexes.join(",") + "])"
          : e.to;
      });
    const depsStr = deps.length > 0 ? " — depends on " + deps.join(", ") : "";
    lines.push(
      "- Project " + cluster.project + ": regions [" + cluster.regionIndexes.join(",") + "]" + depsStr,
    );
  }
  return lines.join("\n");
}

function buildFanoutParagraph(diffVariant: DiffVariant): string {
  const diffRef =
    diffVariant.kind === "file"
      ? "the unified diff file at " + diffVariant.path
      : "the unified diff above";
  return [
    "",
    "This is a large changeset. If an Agent (subagent) tool is available, fan out the",
    "analysis: launch parallel `Explore` subagents — up to 4, one per independent area of",
    "the changeset. Group the changed files into areas by directory/subsystem from the",
    "changed-file list before spawning (decide the grouping from the file paths; you do not",
    "need to read any files first). Give each subagent its area and instruct it to read its",
    "portion of " + diffRef + " plus any source files it needs from the worktree.",
    "Each subagent must report using the REGION INDICES from the \"Changed regions\" table",
    "in the system prompt: which indices cluster together functionally, the dependencies",
    "between clusters, and one line of rationale per cluster. Then synthesize the subagent",
    "reports yourself into the final Layer boundaries — every region index assigned to",
    "exactly one Layer, ordered foundational-first. If no Agent tool is available, perform",
    "this analysis directly.",
  ].join("\n");
}

const SKELETON_TOOL: LlmTool = {
  name: "emit_layer_boundaries",
  description:
    "Emit the ordered Layers for this changeset. Each Layer lists the region INDEXES it " +
    "owns — integers from the [i] column of the \"Changed regions\" table above, NOT " +
    "anchors. The indexes across ALL layers must tile the changeset: assign every region " +
    "index to exactly one Layer, with no index left out and none invented. Order " +
    "foundational-first.",
  inputSchema: skeletonToolSchema,
};

const LAYER_DETAIL_TOOL: LlmTool = {
  name: "emit_layer_detail",
  description:
    "Emit this one Layer's distilled Context Bundle and Findings. The bundle must fit a " +
    "~8K-token budget: a concise summary, neighbors as references + one-line descriptions " +
    "(NEVER inline full source — the backend hydrates it lazily), relevant history, and an " +
    "empty learnings array. Attach Findings to anchors within this Layer only.",
  inputSchema: layerDetailToolSchema,
};

/** Per-call user text for phase 3b: the Layer's anchors + the covered ContextInput. */
function buildLayerUserText(layer: SkeletonLayer, covered: RegionContext[]): string {
  const anchorsJson = JSON.stringify(layer.anchors, null, 2);
  // Give the model the RAW per-region context to DISTILL — not to copy verbatim.
  const contextJson = JSON.stringify(
    covered.map((r) => ({
      anchor: r.anchor,
      neighbors: r.neighbors,
      history: r.history,
    })),
    null,
    2,
  );
  return [
    `Produce the detail for Layer "${layer.id}" (order ${layer.order}).`,
    "",
    "This Layer's anchors:",
    anchorsJson,
    "",
    "Raw context for the regions these anchors cover (distill this into the bundle —",
    "select and compress; do not copy source):",
    contextJson,
  ].join("\n");
}

// ── Tiling validation ────────────────────────────────────────────────────────────────

/**
 * Validate that the skeleton's anchors tile the changeset's regions. Returns the list of
 * ContextInput regions whose anchor is covered by NO Layer (the dropped regions). An
 * empty result means a perfect tiling.
 */
export function findUncoveredRegions(
  skeleton: { layers: SkeletonLayer[] },
  contextInput: ContextInput,
): RegionContext[] {
  const covered = new Set<string>();
  for (const layer of skeleton.layers) {
    for (const anchor of layer.anchors) covered.add(anchorKey(anchor));
  }
  return contextInput.regions.filter((r) => !covered.has(anchorKey(r.anchor)));
}

// ── Orchestration ────────────────────────────────────────────────────────────────────

/**
 * Run the two-phase Scaffolder and return a validated ReviewScaffold.
 *
 * @throws {TilingError}   when the skeleton drops regions and `onIncompleteTiling` is "throw".
 * @throws {ZodError}      when the assembled scaffold fails `parseReviewScaffold`.
 */
export async function scaffold(
  changeSet: ChangeSet,
  contextInput: ContextInput,
  options: ScaffoldOptions = {},
): Promise<ReviewScaffold> {
  const runnerInjected = options.runner !== undefined;
  const runner =
    options.runner ?? createDefaultScaffolderRunner(process.env, options.model);
  const onIncompleteTiling = options.onIncompleteTiling ?? "repair";
  const onProgress = options.onProgress;
  const onWarning = options.onWarning ?? ((_msg: string) => undefined);
  const signal = options.signal;

  // Resolve detail concurrency: option wins, then env var (positive integer), then 6.
  let detailConcurrency = 6;
  if (options.detailConcurrency !== undefined) {
    detailConcurrency = options.detailConcurrency;
  } else {
    const envVal = process.env.SLEEK_SCAFFOLDER_DETAIL_CONCURRENCY;
    if (envVal !== undefined) {
      const parsed = Number(envVal);
      if (Number.isInteger(parsed) && parsed > 0) detailConcurrency = parsed;
    }
  }

  // For CLI runners, write the unified diff to a temp file and reference it by path
  // in the prompt instead of embedding it inline. This avoids piping tens of megabytes
  // over stdin on every skeleton + detail call (which causes timeouts on large PRs).
  // The API runner (DefaultLlmRunner) keeps the inline diff to preserve prompt caching.
  const isCliRunner = runner instanceof CliAgentLlmRunner;
  let diffFilePath: string | undefined;
  let diffVariant: DiffVariant = { kind: "inline" };

  // The CLI Provider driving this run, if any. Drives both the RTK guidance flavor and
  // the skeleton fan-out gate. Undefined for the API runner and any non-CLI fake.
  const cliProvider = isCliRunner ? (runner as CliAgentLlmRunner).provider : undefined;

  if (isCliRunner) {
    // Write the diff into the runner's cwd when set (e.g. a PR-head worktree), or
    // fall back to tmpdir(). Using cwd ensures the file is inside the CLI agent's
    // working directory, which is within a read-only sandbox's read scope (codex
    // --sandbox read-only restricts writes but not reads from cwd).
    const diffDir = (runner as CliAgentLlmRunner).cwd ?? tmpdir();
    diffFilePath = join(diffDir, ".sleek-scaffold-diff.patch");
    await writeFile(diffFilePath, changeSet.unifiedDiff, "utf8");
    diffVariant = { kind: "file", path: diffFilePath };
  }

  // Derive the RTK guidance flavor ONCE per run so the shared system prompt is byte-stable
  // across phase 3a and every phase-3b call. Only claude/codex CLI Providers with the rtk
  // binary present get the block; everything else (API runner, other providers, rtk
  // absent) gets `false` and the byte-identical no-guidance prompt.
  const rtkGuidance: "claude" | "codex" | false =
    (cliProvider === "claude" || cliProvider === "codex") &&
    rtkBinaryAvailable(options.env ?? process.env)
      ? cliProvider
      : false;

  const system = buildSharedSystem(changeSet, contextInput, diffVariant, { rtk: rtkGuidance });

  // Skeleton fan-out gate: claude CLI Provider on a large changeset. Appended to the
  // SKELETON userText only — never to the detail calls (which must stay byte-stable).
  const fanoutParagraph =
    cliProvider === "claude" &&
    (changeSet.files.length > FANOUT_MIN_FILES ||
      contextInput.regions.length > FANOUT_MIN_REGIONS)
      ? buildFanoutParagraph(diffVariant)
      : "";

  if (fanoutParagraph) {
    options.onProgress?.({ phase: "activity", text: "Skeleton fan-out: launching parallel subagents for large changeset" });
  }

  try {
    // Index regions by anchor for fast per-Layer coverage lookup.
    const regionByAnchor = new Map<string, RegionContext>();
    for (const r of contextInput.regions) regionByAnchor.set(anchorKey(r.anchor), r);

    // ── Phase 3a: skeleton call (WRITES the shared prefix to cache). ──────────────────
    onProgress?.({ phase: "skeleton", status: "start" });
    const skeletonResult = await runner.run({
      system,
      userText:
        "Return the Layer boundaries for the changeset described above. Answer with region " +
        "INDEXES from the \"Changed regions\" table (the [i] column) — assign every region " +
        "index to exactly one Layer, none left out and none invented; order " +
        "foundational-first." +
        fanoutParagraph,
      tool: SKELETON_TOOL,
      cachePrefix: true,
    });
    const skeleton = skeletonResult.toolInput as SkeletonOutput;
    onProgress?.({ phase: "skeleton", status: "done" });

    // ── Skeleton region-index validation + expansion to anchors. ──────────────────────
    // The model answers in region INDEXES (into contextInput.regions). We validate each
    // index and expand valid ones to their anchor: drop non-integer / out-of-range indices
    // (invented), drop an index already claimed by an earlier layer (first claim in layer
    // order wins), and drop a whole layer that ends up with zero valid indices. Same
    // warning channel + drop semantics as the prior anchor validation.
    const regionCount = contextInput.regions.length;
    const claimedByLayer = new Map<number, string>(); // region index → first layer id
    const cleanedLayers: SkeletonLayer[] = [];
    for (const layer of skeleton.layers) {
      const validAnchors: Anchor[] = [];
      for (const index of layer.regionIndexes) {
        if (!Number.isInteger(index) || index < 0 || index >= regionCount) {
          // Invented: not a valid row of the "Changed regions" table.
          onWarning(
            `skeleton: layer "${layer.id}" claimed invalid region index ${index} (dropped)`,
          );
          continue;
        }
        const prior = claimedByLayer.get(index);
        if (prior !== undefined) {
          // Duplicate: a previous layer already owns this region index.
          onWarning(
            `skeleton: layer "${layer.id}" duplicates region index ${index} already claimed by "${prior}" (dropped)`,
          );
          continue;
        }
        claimedByLayer.set(index, layer.id);
        validAnchors.push(contextInput.regions[index]!.anchor);
      }
      if (validAnchors.length === 0) {
        // Every index was dropped — discard the whole layer.
        onWarning(`skeleton: layer "${layer.id}" has no valid region indexes after validation (dropped)`);
        continue;
      }
      cleanedLayers.push({ id: layer.id, order: layer.order, anchors: validAnchors });
    }

    // ── Tiling validation + repair. ───────────────────────────────────────────────────
    const uncovered = findUncoveredRegions({ layers: cleanedLayers }, contextInput);
    const layers: SkeletonLayer[] = [...cleanedLayers];
    if (uncovered.length > 0) {
      if (onIncompleteTiling === "throw") {
        throw new TilingError(uncovered.map((r) => r.anchor));
      }
      // Repair: sweep every dropped region into a synthetic trailing Layer so the scaffold
      // still tiles the changeset (any selected line resolves to a Layer). Flag it via a
      // recognizable id so the UI/reviewer can see coverage was auto-completed.
      const maxOrder = layers.reduce((m, l) => Math.max(m, l.order), -1);
      layers.push({
        id: "__uncovered__",
        order: maxOrder + 1,
        anchors: uncovered.map((r) => r.anchor) as [Anchor, ...Anchor[]],
      });
    }

    // ── A1 Wave-2: emit plan event so the client can build a layer-row breakdown UI. ────
    onProgress?.({
      phase: "plan",
      layers: layers.map((l) => ({
        id: l.id,
        order: l.order,
        regionCount: l.anchors.length,
        files: Array.from(new Set(l.anchors.map((a) => a.file))),
        anchors: l.anchors,
      })),
    });

    // ── B4: risk scoring + balanced shard plan. ──────────────────────────────────────────
    // Only engage shard-splitting above the fan-out thresholds (same gate as skeleton
    // fan-out) so small PRs keep current single-pass latency and identical output.
    const isLargePr =
      changeSet.files.length > FANOUT_MIN_FILES ||
      contextInput.regions.length > FANOUT_MIN_REGIONS;

    const maxShardEffort = options.maxShardEffort ?? DEFAULT_MAX_SHARD_EFFORT;

    // Resolve tiering: option wins over env var.
    const tieringEnabled =
      options.tieringEnabled ??
      (process.env.SLEEK_SCAFFOLDER_TIERING === "1");

    // Resolve B5 options: two-pass, refuter, dedup.
    const twoPassEnabled =
      options.twoPassEnabled ??
      (process.env.SLEEK_SCAFFOLDER_TWO_PASS === "1");
    const refuterEnabled =
      options.refuterEnabled ??
      (process.env.SLEEK_SCAFFOLDER_REFUTER === "1");
    // Dedup defaults to true (pure in-process, no model calls).
    const dedupEnabled = options.dedupEnabled !== false;

    // Build cheap-tier runner when tiering or B5 two-pass/refuter is enabled.
    //
    // When the runner was NOT explicitly injected (the real production path): build the
    // cheap runner via createDefaultScaffolderRunner so it honours the configured
    // provider. For the claude CLI default this produces a CliAgentLlmRunner with
    // config.model set to the cheap model id. For the anthropic API provider it
    // produces a DefaultLlmRunner. For codex the Anthropic cheap-model id won't map
    // to a Codex model — the CLI will use its configured default, which is fine; the
    // shard is still routed to a separate runner call and model selection happens there.
    //
    // When the runner WAS explicitly injected (tests, custom callers): keep conservative
    // behavior — only build a cheap runner if the injected runner is a DefaultLlmRunner
    // (we can't fabricate a meaningful cheap runner for an arbitrary injected fake).
    const cheapModelId = options.cheapModel ?? "claude-sonnet-4-6";
    let cheapRunner: LlmRunner | undefined;
    const needsCheapRunner = tieringEnabled || twoPassEnabled || refuterEnabled;
    if (needsCheapRunner) {
      if (!runnerInjected) {
        cheapRunner = createDefaultScaffolderRunner(options.env ?? process.env, cheapModelId);
      } else if (runner instanceof DefaultLlmRunner) {
        cheapRunner = new DefaultLlmRunner({ model: cheapModelId });
      }
    }

    // Build the shard plan: compute risk per file, then split oversized layers.
    // For each layer we build a ShardInput mapping region index → risk score.
    const diffLines = changeSet.unifiedDiff.split("\n");

    // Map file → pre-computed risk score (one scoreFile call per unique file).
    const riskByFile = new Map<string, number>();
    const uniqueFiles = Array.from(new Set(contextInput.regions.map((r) => r.anchor.file)));
    for (const file of uniqueFiles) {
      const fileRegions = contextInput.regions.filter((r) => r.anchor.file === file);
      const churnCount = Math.max(...fileRegions.map((r) => r.history.length), 0);
      const neighborCount = Math.max(...fileRegions.map((r) => r.neighbors.length), 0);
      const centrality = contextInput.graph?.centralityByFile?.[file];
      riskByFile.set(
        file,
        scoreFile({
          churnCount,
          filePath: file,
          diffLines,
          allChangedFiles: changeSet.files,
          neighborCount,
          ...(centrality !== undefined ? { centrality } : {}),
        }),
      );
    }

    // Build per-layer shards. When not a large PR, each layer is one shard (no splitting).
    interface ShardEntry {
      shard: LayerShard;
      layerIndex: number; // index into `layers`
    }
    const allShards: ShardEntry[] = [];

    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li]!;
      if (!isLargePr) {
        // Small PR: trivial single shard per layer (same as pre-B4 behavior).
        allShards.push({
          shard: {
            layerId: layer.id,
            shardIndex: 0,
            totalShards: 1,
            regionIndices: layer.anchors.map((_, ai) => {
              // Map anchor back to region index in contextInput.
              const r = regionByAnchor.get(anchorKey(layer.anchors[ai]!));
              return r ? contextInput.regions.indexOf(r) : -1;
            }).filter((i) => i >= 0),
            effort: 0,
            avgRisk: 0,
          },
          layerIndex: li,
        });
        continue;
      }

      const shardInput: ShardInput = {
        layerId: layer.id,
        regions: layer.anchors
          .map((a) => {
            const r = regionByAnchor.get(anchorKey(a));
            if (!r) return null;
            const idx = contextInput.regions.indexOf(r);
            return {
              regionIndex: idx,
              file: a.file,
              startLine: a.startLine,
              endLine: a.endLine,
              riskScore: riskByFile.get(a.file) ?? 0.5,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null),
      };

      const shards = splitLayerIntoShards(shardInput, maxShardEffort);
      for (const shard of shards) {
        allShards.push({ shard, layerIndex: li });
      }
    }

    // ── B5 pass-1 triage (large PR + two-pass enabled + cheap runner available). ──────
    // Builds a map from shardId → TriageFlag. Shards not present in the map (e.g. when
    // triage is disabled or fails) are treated as high-risk (conservative default).
    const triageFlagsByShardId = new Map<string, TriageFlag>();

    const canTwoPass = isLargePr && twoPassEnabled && cheapRunner !== undefined;
    if (canTwoPass) {
      onProgress?.({ phase: "pass", pass: 1, status: "start", shardCount: allShards.length });
      try {
        const triageShards = allShards.map(({ shard, layerIndex }) => {
          const layer = layers[layerIndex]!;
          const shardId =
            shard.totalShards === 1 ? layer.id : `${layer.id}:shard${shard.shardIndex}`;
          const anchors = shard.regionIndices
            .map((ri) => contextInput.regions[ri]?.anchor)
            .filter((a): a is Anchor => a !== undefined)
            .map((a) => ({ file: a.file, startLine: a.startLine, endLine: a.endLine }));
          return { shardId, anchors };
        });

        const triageResult = await cheapRunner!.run({
          system,
          userText: buildTriageUserText(triageShards),
          tool: TRIAGE_TOOL,
          cachePrefix: false,
        });
        const triageOutput = triageResult.toolInput as TriageOutput;
        for (const flag of triageOutput.flags ?? []) {
          triageFlagsByShardId.set(flag.shardId, flag);
        }
        const highCount = Array.from(triageFlagsByShardId.values()).filter(
          (f) => f.riskLevel === "high",
        ).length;
        onProgress?.({ phase: "pass", pass: 1, status: "done", shardCount: allShards.length, highCount });
      } catch {
        // Triage call failed: treat all shards as high-risk (conservative fallback).
        onProgress?.({ phase: "activity", text: "Pass-1 triage failed; falling back to single-pass for all shards" });
      }
    }

    // ── Phase 3b: per-shard detail fan-out, concurrency-limited. ─────────────────────
    onProgress?.({ phase: "detail", status: "start" });
    if (canTwoPass) {
      onProgress?.({ phase: "pass", pass: 2, status: "start" });
    }
    let detailDone = 0;
    const total = allShards.length;

    // Shard results keyed by [layerIndex][shardIndex]. We merge shards per layer in assembly.
    const shardResults: Map<number, Map<number, LayerDetailOutput>> = new Map();
    for (let li = 0; li < layers.length; li++) shardResults.set(li, new Map());

    let nextShardIndex = 0;

    async function runOneShard(si: number): Promise<void> {
      const entry = allShards[si]!;
      const { shard, layerIndex } = entry;
      const layer = layers[layerIndex]!;

      // Resolve which regions this shard covers.
      const shardAnchors: Anchor[] = shard.regionIndices
        .map((ri) => contextInput.regions[ri]?.anchor)
        .filter((a): a is Anchor => a !== undefined);

      // For shards of split layers, pass only the shard's anchors so the model
      // stays within its token budget. The layer id is preserved so findings
      // assemble back correctly.
      const shardId =
        shard.totalShards === 1 ? layer.id : `${layer.id}:shard${shard.shardIndex}`;
      const shardLayer: SkeletonLayer = {
        id: shardId,
        order: layer.order,
        anchors: shardAnchors,
      };

      const covered = shardAnchors
        .map((a) => regionByAnchor.get(anchorKey(a)))
        .filter((r): r is RegionContext => r !== undefined);

      // B5 two-pass: if triage ran and flagged this shard LOW, use a light summary
      // (no full detail call). If not flagged at all (triage missing entry) or HIGH,
      // proceed with the full detail call. Conservative default: missing → HIGH.
      const triageFlag = triageFlagsByShardId.get(shardId);
      if (canTwoPass && triageFlag !== undefined && triageFlag.riskLevel === "low") {
        // Low-risk shard: use triage reason as the bundle summary, no findings.
        const lightDetail: LayerDetailOutput = {
          bundle: {
            summary: triageFlag.reason,
            neighbors: [],
            history: [],
            learnings: [],
          },
          findings: [],
        };
        detailDone++;
        onProgress?.({ phase: "detail", status: "progress", done: detailDone, total });
        shardResults.get(layerIndex)!.set(shard.shardIndex, lightDetail);
        return;
      }

      // Pick the runner for this shard: cheap model for low-risk shards (tiering).
      const shardRunner =
        cheapRunner !== undefined && shard.avgRisk < CHEAP_TIER_THRESHOLD
          ? cheapRunner
          : runner;

      onProgress?.({ phase: "detail-layer", layerId: layer.id, status: "start" });
      const t0Layer = performance.now();
      const result = await shardRunner.run({
        system,
        userText: buildLayerUserText(shardLayer, covered),
        tool: LAYER_DETAIL_TOOL,
        cachePrefix: false,
      });
      const msLayer = Math.round(performance.now() - t0Layer);
      detailDone++;
      onProgress?.({ phase: "detail", status: "progress", done: detailDone, total });
      const layerFindings = (result.toolInput as LayerDetailOutput).findings ?? [];
      onProgress?.({ phase: "detail-layer", layerId: layer.id, status: "done", ms: msLayer, findings: layerFindings.length });
      shardResults.get(layerIndex)!.set(shard.shardIndex, result.toolInput as LayerDetailOutput);
    }

    async function worker(): Promise<void> {
      while (true) {
        if (signal?.aborted) throw new Error("aborted");
        const i = nextShardIndex++;
        if (i >= allShards.length) break;
        await runOneShard(i);
      }
    }

    const workerCount = Math.min(detailConcurrency, allShards.length);
    const workers: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w++) workers.push(worker());
    await Promise.all(workers);

    if (canTwoPass) {
      onProgress?.({ phase: "pass", pass: 2, status: "done" });
    }
    onProgress?.({ phase: "detail", status: "done" });

    // ── Assemble the ReviewScaffold. ────────────────────────────────────────────────────
    // Merge shard results per layer: concatenate findings from all shards; merge bundles
    // by taking the first shard's summary/history and concatenating neighbors.
    const assembledLayers: Layer[] = layers.map((skel, i) => {
      const layerShardMap = shardResults.get(i) ?? new Map<number, LayerDetailOutput>();
      const sortedShardOutputs = Array.from(layerShardMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([, v]) => v);

      // Merge: use first shard for the bundle summary/history; union neighbors.
      const firstDetail = sortedShardOutputs[0] ?? {
        bundle: { summary: "", neighbors: [], history: [], learnings: [] },
        findings: [],
      };
      const mergedNeighbors = sortedShardOutputs.flatMap((d) => d.bundle.neighbors);
      const mergedHistory = sortedShardOutputs.flatMap((d) => d.bundle.history);
      const allRawFindings = sortedShardOutputs.flatMap((d) => d.findings);

      const bundle: ContextBundle = {
        summary: firstDetail.bundle.summary,
        neighbors: mergedNeighbors,
        history: mergedHistory,
        // Reserved slot — always [] in v1 regardless of what the model returned.
        learnings: [],
      };
      // Findings carry no `suggestedFix` (reserved slot omitted from the tool schema).
      // Validate each finding anchor: must share file+side with one of the layer's anchors
      // AND have its line range contained within that anchor's range (narrower is valid).
      const findings: Finding[] = [];
      for (const f of allRawFindings) {
        const layerAnchor = skel.anchors.find(
          (a) =>
            a.file === f.anchor.file &&
            a.side === f.anchor.side &&
            f.anchor.startLine >= a.startLine &&
            f.anchor.endLine <= a.endLine,
        );
        if (layerAnchor === undefined) {
          onWarning(
            `detail: layer "${skel.id}" finding anchor ${f.anchor.file}:${f.anchor.startLine}-${f.anchor.endLine} is outside the layer's anchors (dropped)`,
          );
          continue;
        }
        findings.push({
          anchor: f.anchor,
          concern: f.concern,
          severity: f.severity,
          text: f.text,
        });
      }
      return {
        id: skel.id,
        order: skel.order,
        anchors: skel.anchors as [Anchor, ...Anchor[]],
        bundle,
        findings,
      };
    });

    // ── B5: cross-shard finding dedup (always on by default, pure in-process). ────────
    // Dedup is CROSS-LAYER: the same finding may appear in two separate layers/shards
    // when overlapping context causes two detail calls to observe the same issue.
    // We deduplicate globally by normalized-text+file hash, keeping the first occurrence
    // across layers in layer order.
    if (dedupEnabled) {
      const globalSeen = new Set<string>();
      const { findingDedupKey: dedupKey } = await import("./findingdedup.ts");
      for (const layer of assembledLayers) {
        const kept: Finding[] = [];
        for (const f of layer.findings) {
          const key = dedupKey(f);
          if (!globalSeen.has(key)) {
            globalSeen.add(key);
            kept.push(f);
          }
        }
        (layer as { findings: Finding[] }).findings = kept;
      }
    }

    // ── B5: adversarial refuter (large PR only, requires cheap runner). ───────────────
    if (isLargePr && refuterEnabled && cheapRunner !== undefined) {
      // Build a region-context lookup: file:startLine-endLine → compact excerpt.
      // We use the unifiedDiff as the context source — extract the changed lines
      // matching the anchor's file. This is a best-effort excerpt for the refuter.
      const diffByFile = new Map<string, string[]>();
      for (const line of changeSet.unifiedDiff.split("\n")) {
        if (line.startsWith("diff --git")) {
          // No-op — we use anchor file matching below.
        }
      }
      function getRegionContext(anchor: Anchor): string {
        // Return the first few diff lines touching this file as context.
        const lines = changeSet.unifiedDiff.split("\n");
        const relevant = lines.filter(
          (l) => l.includes(anchor.file) || l.startsWith("+") || l.startsWith("-"),
        );
        return relevant.slice(0, 20).join("\n");
      }

      const totalFindings = assembledLayers.reduce((s, l) => s + l.findings.length, 0);
      const critMajorCount = assembledLayers.reduce(
        (s, l) =>
          s + l.findings.filter((f) => f.severity === "critical" || f.severity === "major").length,
        0,
      );
      onProgress?.({ phase: "refute", status: "start", total: critMajorCount });

      let refutedCount = 0;
      for (const layer of assembledLayers) {
        const annotated = await refuteFindings(
          layer.findings,
          system,
          getRegionContext,
          cheapRunner,
        );
        refutedCount += annotated.filter(
          (f) => f.refutation?.verdict === "refuted",
        ).length;
        // Cast: AnnotatedFinding is a superset of Finding (extra optional field).
        (layer as { findings: Finding[] }).findings = annotated as Finding[];
      }
      onProgress?.({ phase: "refute", status: "done", total: critMajorCount, refuted: refutedCount });
    }

    const scaffoldOut = {
      pr: changeSet.pr,
      layers: assembledLayers,
    };

    // Validate against the domain schema — throws ZodError on any shape violation.
    return parseReviewScaffold(scaffoldOut);
  } finally {
    // Clean up the diff temp file after all phases complete (success or failure).
    // Only created for CLI runners; safe to skip when diffFilePath is undefined.
    if (diffFilePath !== undefined) {
      await rm(diffFilePath, { force: true });
    }
  }
}
