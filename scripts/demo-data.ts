/**
 * Reusable core of the demo pipeline (extracted from demo-review.ts so that
 * serve-demo.ts can share it): loading of authored reviews (supplied as
 * scripts/reviews/<pr>.json — see the format comment below) plus
 * buildDemoScaffold(), which runs the real Sleek pipeline with an injected
 * Scaffolder LLM (no Anthropic key needed):
 *   real gh ingest (M1) → real diff-region parsing (M2 diff.ts) → real M3
 *   assembly + tiling + zod validation.
 *
 * Not part of the product build. Imported by demo-review.ts and serve-demo.ts
 * (and by serve-pr.ts for the shared githubRepoUrl helper).
 */

import { fork } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { simpleGit } from "simple-git";

import {
  hashText,
  htmlKey,
  rendererVersionHash,
  type SleekCache,
} from "../src/cache/cache.ts";
import { parseChangedRegions } from "../src/context/diff.ts";
import type { ScaffoldProgressEvent } from "../src/server/serve.ts";
import type { StartServerOptions } from "../src/server/serve.ts";
import type { ContextInput, RegionContext } from "../src/context/index.ts";
import type {
  Anchor,
  Concern,
  HistoryEntry,
  Neighbor,
  ReviewScaffold,
  Severity,
} from "../src/domain/scaffold.ts";
import type { ChangeSet } from "../src/domain/scaffold.ts";
import { ingestPr, type GhRunner } from "../src/ingest/ingest.ts";
import type { Timeline } from "../src/perf/timing.ts";
import type { LlmRunner, LlmUsage } from "../src/scaffolder/llm.ts";
import { scaffold, type ScaffoldProgressEvent as ScaffolderProgressEvent } from "../src/scaffolder/scaffolder.ts";
import { scaffolderProviderInfo } from "../src/scaffolder/runners.ts";
import type { Store } from "../src/store/index.ts";
import { renderReviewHtml } from "./render.ts";
import type { WorkerConfig, WorkerMessage } from "./scaffold-worker.ts";

// Fallback for when the repo URL can't be derived from `origin` (see githubRepoUrl);
// used only to build the header links (renderReviewHtml itself stays generic — it just
// receives a prUrl).
export const GITHUB_REPO_URL = "https://github.com/example/repo";

/**
 * Derive the GitHub repo URL from the repo's `origin` remote — handles both the ssh
 * (`git@github.com:owner/repo.git`) and https forms, stripping a trailing `.git`.
 * Returns undefined when origin is missing or not a github.com URL. Shared with
 * serve-pr.ts, which appends `/pull/<n>` for its header link.
 */
export async function githubRepoUrl(repoPath: string): Promise<string | undefined> {
  try {
    const remote = await simpleGit(repoPath).remote(["get-url", "origin"]);
    const normalized = (remote ?? "")
      .trim()
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/\.git$/, "");
    return normalized.includes("github.com") ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/** An authored finding location: side + line range in that side's file coordinates. */
interface AuthoredAnchor {
  side: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
}

// ── Authored reviews as JSON files (scripts/reviews/<pr>.json) ─────────────────────────
// Authored reviews are supplied as JSON files; the injected runner replays them as the
// Scaffolder LLM's output. Replay for a PR requires scripts/reviews/<prNumber>.json.
//
// File format (mirrors the two scaffolder phases — skeleton, then per-Layer detail):
// {
//   "layers": [
//     {
//       "id": "short-slug",              // Layer id; also keys the per-Layer detail call
//       "order": 0,                      // foundational-first
//       "title": "Rail title",           // shown in the UI's layer rail
//       "anchors": [ {"file","side":"LEFT"|"RIGHT","startLine","endLine"}, … ],
//         // Must match the REAL parsed changed regions EXACTLY (same file/side/lines),
//         // every region in exactly one layer — otherwise the scaffolder's tiling
//         // repair sweeps missed regions into a synthetic "__uncovered__" layer.
//         // Print the regions to tile with:
//         //   npx tsx scripts/dump-regions.ts <repoPath> <prNumber>
//       "bundle": {
//         "summary": "plain-language layer summary",
//         "neighbors": [ {"ref","signature","oneLine"}, … ],
//         "history":   [ {"sha","subject","whenRelevant"}, … ]
//       },
//       "findings": [
//         {
//           "anchor": {"file","side","startLine","endLine"},
//             // authored at the interesting line(s); kept VERBATIM when it falls within
//             // a parsed region for that file+side (anchorFor() resolution), snapped to
//             // a Layer region only as a warned fallback
//           "concern": "correctness" | "security" | "performance" | "tests" | "maintainability",
//           "severity": "critical" | "major" | "minor" | "info",
//           "text": "markdown prose; may contain a fenced code block"
//         }, …
//       ]
//     }, …
//   ]
// }
//
// Example — a synthetic review of PR #123 against github.com/acme/rocket, saved as
// scripts/reviews/123.json:
// {
//   "layers": [
//     {
//       "id": "countdown-abort",
//       "order": 0,
//       "title": "Abort the countdown on sensor fault",
//       "anchors": [
//         { "file": "src/launch/countdown.ts", "side": "RIGHT", "startLine": 12, "endLine": 30 }
//       ],
//       "bundle": {
//         "summary": "countdown() now polls the sensor bus each tick and aborts on fault.",
//         "neighbors": [
//           { "ref": "src/launch/sensors.ts", "signature": "readSensorBus(): SensorFrame",
//             "oneLine": "Source of the fault flag polled each tick." }
//         ],
//         "history": []
//       },
//       "findings": [
//         {
//           "anchor": { "file": "src/launch/countdown.ts", "side": "RIGHT", "startLine": 18, "endLine": 21 },
//           "concern": "correctness",
//           "severity": "major",
//           "text": "The abort path skips `releaseClamps()` — a fault after clamp release leaves them open."
//         }
//       ]
//     }
//   ]
// }
interface AuthoredJsonLayer {
  id: string;
  order: number;
  title: string;
  anchors: Anchor[];
  bundle: { summary: string; neighbors: Neighbor[]; history: HistoryEntry[] };
  findings: { anchor: Anchor; concern: Concern; severity: Severity; text: string }[];
}
interface AuthoredReviewJson {
  layers: AuthoredJsonLayer[];
}

/** Load scripts/reviews/<pr>.json if present (resolved relative to THIS file). */
function loadAuthoredReviewJson(prNumber: number): AuthoredReviewJson | undefined {
  const path = join(dirname(fileURLToPath(import.meta.url)), "reviews", `${prNumber}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as AuthoredReviewJson;
}

const NO_USAGE: LlmUsage = {
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Resolve an authored finding anchor against the Layer's REAL parsed region anchors.
 * An authored anchor that falls WITHIN a region (same side, region range ⊇ finding
 * range) is kept VERBATIM — the scaffolder and renderer handle sub-range anchors fine,
 * and this is what pins a finding to the exact interesting lines instead of the whole
 * region. Snapping to a Layer region remains only as a warned fallback for anchors
 * that match no region (authored lines off relative to the parsed diff): the first
 * region on the finding's side, else the first region. When the authored anchor
 * carries a file (the JSON path — a Layer may span several files), containment also
 * requires the file to match.
 */
function anchorFor(
  anchors: Anchor[],
  f: { side: "LEFT" | "RIGHT"; anchor?: AuthoredAnchor & { file?: string } },
): Anchor {
  if (f.anchor) {
    const a = f.anchor;
    const containing = anchors.find(
      (r) =>
        (a.file === undefined || r.file === a.file) &&
        r.side === a.side &&
        r.startLine <= a.startLine &&
        r.endLine >= a.endLine,
    );
    if (containing) {
      return {
        file: a.file ?? containing.file,
        side: a.side,
        startLine: a.startLine,
        endLine: a.endLine,
      };
    }
    console.warn(
      `  ⚠ authored finding anchor ${a.file ?? "(layer file)"} ${a.side} ` +
        `${a.startLine}-${a.endLine} falls within no parsed region — snapping to a ` +
        `Layer region; recheck it against: npx tsx scripts/dump-regions.ts <repoPath> <prNumber>`,
    );
  }
  return anchors.find((a) => a.side === f.side) ?? anchors[0]!;
}

/**
 * Canonical anchor key matching the scaffolder's own anchorKey (file/side/startLine/
 * endLine). Used to map an authored layer's anchors to region INDEXES for the skeleton
 * tool input, since the scaffolder now expects `regionIndexes` (indices into
 * contextInput.regions) rather than verbatim anchors.
 */
function anchorKey(a: Anchor): string {
  return `${a.file} ${a.side} ${a.startLine} ${a.endLine}`;
}

/**
 * Convert a replay skeleton's per-layer anchors into `regionIndexes` — indices into the
 * region list `regions` (in order) via anchor-key equality. Anchors that match no region
 * are dropped/skipped (consistent with the scaffolder's own drop-unknown behavior), so
 * the final scaffold is identical to what the anchor-based contract produced.
 */
function toRegionIndexes(
  layers: { id: string; order: number; anchors: Anchor[] }[],
  regions: Anchor[],
): { id: string; order: number; regionIndexes: number[] }[] {
  const indexByKey = new Map<string, number>();
  regions.forEach((r, i) => {
    const key = anchorKey(r);
    if (!indexByKey.has(key)) indexByKey.set(key, i);
  });
  return layers.map(({ id, order, anchors }) => ({
    id,
    order,
    regionIndexes: anchors
      .map((a) => indexByKey.get(anchorKey(a)))
      .filter((i): i is number => i !== undefined),
  }));
}

export interface DemoScaffoldResult {
  changeSet: ChangeSet;
  reviewScaffold: ReviewScaffold;
  layerTitles: Record<string, string>;
  prUrl: string;
}

/** Wave-5 pipeline options; all optional so bare calls behave as before. */
export interface DemoScaffoldOptions {
  /** Injectable gh runner (e.g. the caching runner from src/cache/gh.ts). */
  gh?: GhRunner;
  /**
   * Fast-path scaffold replay: when given, a scaffold already stored for this exact
   * (pr, headSha) is used instead of rebuilding (the injected-runner build is
   * deterministic per head SHA), and a rebuilt one is saved back via saveScaffold.
   */
  store?: Store;
  /** Per-stage timing (region parse / history / neighbors / scaffold rows). */
  timeline?: Timeline;
}

/** Header link derived from the repo's own origin remote, with the warned fallback. */
export async function demoPrUrl(repoPath: string, prNumber: number): Promise<string> {
  let repoUrl = await githubRepoUrl(repoPath);
  if (!repoUrl) {
    console.warn(
      `  ⚠ could not derive a github.com URL from origin of ${repoPath}; ` +
        `falling back to ${GITHUB_REPO_URL}`,
    );
    repoUrl = GITHUB_REPO_URL;
  }
  return `${repoUrl}/pull/${prNumber}`;
}

/**
 * Run the demo pipeline for (repoPath, prNumber): real ingest → real diff-region
 * parsing → real M3 scaffolding with the authored review injected as the LLM.
 * Logs progress to the console (same output demo-review.ts always produced).
 */
export async function buildDemoScaffold(
  repoPath: string,
  prNumber: number,
  options: DemoScaffoldOptions = {},
): Promise<DemoScaffoldResult> {
  const { gh, store, timeline } = options;

  console.log(`\n▶ Ingesting PR #${prNumber} from ${repoPath} …`);
  const changeSet = await ingestPr(prNumber, { cwd: repoPath, ...(gh ? { gh } : {}) });
  console.log(`  ${changeSet.pr.title}`);
  console.log(`  files: ${changeSet.files.join(", ")}`);

  // The authored JSON review for this PR (scripts/reviews/<pr>.json). Loaded before
  // the store fast path because layer titles come from the authored data on both paths.
  // Fail loudly when nothing authored covers this PR — the injected runner would
  // otherwise emit placeholder bundles ("Changes in <file>.") with zero findings, a
  // silently empty review.
  const authoredJson = loadAuthoredReviewJson(prNumber);
  if (!authoredJson) {
    throw new Error(
      [
        `No authored review for PR #${prNumber}: scripts/reviews/${prNumber}.json does not`,
        `exist. To author one:`,
        `  1. print the REAL changed regions the skeleton must tile:`,
        `       npx tsx scripts/dump-regions.ts ${repoPath} ${prNumber}`,
        `  2. write scripts/reviews/${prNumber}.json in the format documented above`,
        `     loadAuthoredReviewJson() in scripts/demo-data.ts.`,
      ].join("\n"),
    );
  }
  const layerTitles = Object.fromEntries(authoredJson.layers.map((l) => [l.id, l.title]));

  // Wave-5 fast path: a scaffold stored for this exact (pr, headSha) replays as-is —
  // the injected-runner build below is deterministic per head SHA — skipping region
  // parsing and the two-phase scaffold entirely.
  const lookupStart = performance.now();
  const stored = store?.getScaffold(prNumber, changeSet.pr.headSha) ?? null;
  if (stored) {
    timeline?.add("region parse", 0, "skipped (scaffold cached)");
    timeline?.add("history", 0, "skipped (demo replay)");
    timeline?.add("neighbors", 0, "skipped (demo replay)");
    timeline?.add("scaffold", performance.now() - lookupStart, "HIT (store)");
    console.log(
      `▶ Scaffold replayed from store (${changeSet.pr.headSha.slice(0, 12)}): ` +
        `${stored.layers.length} layers, ` +
        `${stored.layers.reduce((n, l) => n + l.findings.length, 0)} findings`,
    );
    const prUrl = await demoPrUrl(repoPath, prNumber);
    return { changeSet, reviewScaffold: stored, layerTitles, prUrl };
  }

  // Real diff-region parsing → real anchors. (Full M2 worktree/neighbors/history is
  // skipped in this demo to avoid fetching the whole commit; anchors + tiling are real.)
  const parseStart = performance.now();
  const regions = parseChangedRegions(changeSet.unifiedDiff);
  const contextInput: ContextInput = {
    headSha: changeSet.pr.headSha,
    regions: regions.map<RegionContext>((r) => ({
      anchor: { file: r.file, side: r.side, startLine: r.startLine, endLine: r.endLine },
      neighbors: [],
      history: [],
    })),
    dedup: { siblings: new Map(), groupSize: new Map() },
  };
  timeline?.add("region parse", performance.now() - parseStart);
  timeline?.add("history", 0, "skipped (demo replay)");
  timeline?.add("neighbors", 0, "skipped (demo replay)");
  console.log(`  changed regions: ${regions.length}`);

  /** Diagnose a per-Layer detail lookup that found nothing authored for `id`. */
  function warnDetailMiss(id: string): void {
    console.warn(
      id === "__uncovered__"
        ? `  ⚠ tiling repair added the "__uncovered__" Layer — the authored anchors do` +
            ` not tile the parsed regions exactly; recheck them against:` +
            ` npx tsx scripts/dump-regions.ts ${repoPath} ${prNumber}`
        : `  ⚠ authored per-Layer detail lookup missed Layer id "${id}" (layer id` +
            ` mismatch) — emitting a placeholder bundle with no findings`,
    );
  }

  // The authored layer↔anchor grouping IS the skeleton; it is verified against the
  // parsed regions (dump-regions.ts) so M3's tiling check passes for real.
  const skeletonLayers = [...authoredJson.layers]
    .map(({ id, order, anchors }) => ({ id, order, anchors }))
    .sort((a, b) => a.order - b.order);
  // The scaffolder skeleton tool now speaks region INDEXES, so translate the authored
  // anchor grouping to indices into the parsed regions (same order the scaffolder sees).
  const skeletonIndexLayers = toRegionIndexes(
    skeletonLayers,
    contextInput.regions.map((r) => r.anchor),
  );

  // Fake Scaffolder LLM: dispatch on the tool the orchestrator asks for.
  const runner: LlmRunner = {
    async run(req) {
      if (req.tool.name === "emit_layer_boundaries") {
        return { toolInput: { layers: skeletonIndexLayers }, usage: NO_USAGE };
      }
      // per-Layer detail — the Layer id is in the user text.
      const id = req.userText.match(/Layer "(.+?)"/)?.[1] ?? "";
      const layer = authoredJson.layers.find((l) => l.id === id);
      if (!layer) warnDetailMiss(id);
      const anchors = layer?.anchors ?? [];
      const bundle = layer
        ? { ...layer.bundle, learnings: [] }
        : { summary: `Changes in ${id}.`, neighbors: [], history: [], learnings: [] };
      const findings = (layer?.findings ?? []).map((f) => ({
        anchor: anchorFor(anchors, { side: f.anchor.side, anchor: f.anchor }),
        concern: f.concern,
        severity: f.severity,
        text: f.text,
      }));
      return { toolInput: { bundle, findings }, usage: NO_USAGE };
    },
  };

  console.log(`▶ Scaffolding (2-phase, injected authored review) …`);
  const scaffoldStart = performance.now();
  const reviewScaffold = await scaffold(changeSet, contextInput, { runner });
  timeline?.add(
    "scaffold",
    performance.now() - scaffoldStart,
    store ? "MISS (built)" : undefined,
  );
  console.log(`  ✓ validated: ${reviewScaffold.layers.length} layers, ` +
    `${reviewScaffold.layers.reduce((n, l) => n + l.findings.length, 0)} findings`);

  // Persist for the next start's fast path (upsert by (pr, headSha)).
  store?.saveScaffold(reviewScaffold);

  // Header link derives from the repo's own origin remote, not a hardcoded repo.
  const prUrl = await demoPrUrl(repoPath, prNumber);

  return { changeSet, reviewScaffold, layerTitles, prUrl };
}

/**
 * Render the review page through the Wave-5 HTML cache: keyed by (pr, headSha, a
 * hash of everything renderReviewHtml consumes — scaffold JSON + diff + titles +
 * prUrl + lazy render mode — and the renderer-version hash). Any landed
 * src/render/*.ts edit changes the renderer version, so cached HTML
 * self-invalidates across renderer changes;
 * a hit is byte-identical to a fresh render by construction. Shared by
 * serve-demo.ts and demo-review.ts.
 */
export function renderDemoHtmlCached(
  cache: SleekCache,
  result: DemoScaffoldResult,
  timeline?: Timeline,
  opts?: { lazyLargeFiles?: boolean },
): string {
  const { changeSet, reviewScaffold, layerTitles, prUrl } = result;
  const start = performance.now();
  const dataHash = hashText(
    [
      JSON.stringify(reviewScaffold),
      changeSet.unifiedDiff,
      JSON.stringify(layerTitles),
      prUrl,
      opts?.lazyLargeFiles ? "lazy:1" : "lazy:0",
    ].join("\u0000"),
  );
  const key = htmlKey(
    reviewScaffold.pr.number,
    reviewScaffold.pr.headSha,
    dataHash,
    rendererVersionHash(),
  );

  const hit = cache.get("html", key);
  if (hit !== null) {
    timeline?.add("render", performance.now() - start, "HIT");
    return hit;
  }
  const html = renderReviewHtml(
    reviewScaffold,
    changeSet.unifiedDiff,
    layerTitles,
    prUrl,
    opts,
  );
  cache.set("html", key, html);
  timeline?.add("render", performance.now() - start, "MISS");
  return html;
}

// ── Wave 7: Explore-first helpers ────────────────────────────────────────────────

/** True when a replay runner can be built for prNumber (scripts/reviews/<pr>.json exists). */
export function hasAuthoredReview(prNumber: number): boolean {
  const path = join(dirname(fileURLToPath(import.meta.url)), "reviews", `${prNumber}.json`);
  return existsSync(path);
}

/** Return an empty ReviewScaffold (layers: []) for explore-first startup. */
export function buildEmptyScaffold(changeSet: ChangeSet): ReviewScaffold {
  return { pr: changeSet.pr, layers: [] };
}

/** Make demoPrUrl exported for use in scaffolding closure. */

/**
 * Build the scaffolding capability closure for startServer (Wave 7).
 * Handles both replay (authored JSON) and live CLI scaffolding.
 */
export type InternalRunChoice =
  | { kind: "replay" }
  | { kind: "cli"; provider: "claude" | "codex"; model?: string };

/** Shared onProgress adapter: translates ScaffolderProgressEvent to stage events. */
export function makeProgressHandler(
  onEvent: (e: ScaffoldProgressEvent) => void,
): (e: ScaffolderProgressEvent) => void {
  let skeletonT0: number | undefined;
  let detailT0: number | undefined;
  return (e) => {
    if (e.phase === "skeleton" && e.status === "start") {
      skeletonT0 = performance.now();
      onEvent({ event: "stage", stage: "skeleton", status: "start" });
    } else if (e.phase === "skeleton" && e.status === "done") {
      onEvent({
        event: "stage",
        stage: "skeleton",
        status: "done",
        ms: skeletonT0 === undefined ? undefined : Math.round(performance.now() - skeletonT0),
      });
    } else if (e.phase === "detail" && e.status === "start") {
      detailT0 = performance.now();
      onEvent({ event: "stage", stage: "detail", status: "start" });
    } else if (e.phase === "detail" && e.status === "progress") {
      detailT0 ??= performance.now();
      onEvent({ event: "stage", stage: "detail", status: "progress", done: e.done, total: e.total });
    } else if (e.phase === "detail" && e.status === "done") {
      onEvent({
        event: "stage",
        stage: "detail",
        status: "done",
        ms: detailT0 === undefined ? undefined : Math.round(performance.now() - detailT0),
      });
    } else if (e.phase === "plan") {
      onEvent({ event: "plan", planLayers: e.layers.map((l) => ({ id: l.id, title: l.id, regionCount: l.regionCount, files: l.files })) });
      onEvent({ event: "partial-scaffold", layers: e.layers.map((l) => ({ id: l.id, title: l.id, order: l.order, anchors: l.anchors })) });
    } else if (e.phase === "detail-layer") {
      onEvent({ event: "detail", layer: e.layerId, status: e.status, ms: e.ms, findings: e.findings });
    } else if (e.phase === "activity") {
      onEvent({ event: "activity", layer: e.layer, text: e.text });
    }
  };
}

// ── Wave 9B: forked scaffold worker driver ─────────────────────────────────────

/**
 * Pipeline cache path the worker opens its OWN connection to. Matches the path
 * serve-pr.ts / serve-demo.ts pass to openCache (they hardcode ".sleek/cache.db"
 * relative to cwd). The closure signature is frozen, so this is derived here
 * rather than threaded through options.
 */
const WORKER_CACHE_DB = ".sleek/cache.db";
/** Resolve scripts/scaffold-worker.ts next to this file. */
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "scaffold-worker.ts");
/** Keep the tail of the worker's stderr for a postmortem in the rejection message. */
const STDERR_RING_LINES = 40;
/** Grace period after SIGTERM before escalating to SIGKILL on cancel. */
const KILL_ESCALATION_MS = 5000;

type WorkerResult = { changeSet: ChangeSet; scaffold: ReviewScaffold; layerTitles: Record<string, string> };

function workerResultFileError(path: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`scaffold worker result file missing or unreadable at ${path}: ${message}`);
}

function readWorkerResultFile(path: string): WorkerResult {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkerResult;
  } catch (err) {
    throw workerResultFileError(path, err);
  }
}

function unlinkBestEffort(path: string | undefined): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // ignore
  }
}

/**
 * Fork scripts/scaffold-worker.ts, relay its IPC progress events to onEvent, and
 * resolve with the returned {changeSet, scaffold, layerTitles}. Rejects (with the
 * last stderr lines) when the worker exits non-zero without a result.
 *
 * - fork inherits execArgv, so the .ts worker runs under tsx (verified empirically).
 * - detached:true puts the child in its own process group so a cancel can
 *   process-group-kill it (`process.kill(-pid, "SIGTERM")`, SIGKILL after 5s),
 *   taking any grandchild CLI agents down with it.
 * - stderr is captured to a ring buffer AND appended to
 *   .sleek/scaffold-worker-<pr>.log for postmortems.
 * - The child is also killed if the PARENT process exits.
 */
export async function runWorker(
  config: WorkerConfig,
  onEvent: (e: ScaffoldProgressEvent) => void,
  signal: AbortSignal | undefined,
): Promise<WorkerResult> {
  // Write the config to a temp file the child reads from argv[2].
  const cfgDir = mkdtempSync(join(tmpdir(), "sleek-scaffold-"));
  const cfgPath = join(cfgDir, "config.json");
  writeFileSync(cfgPath, JSON.stringify(config));

  mkdirSync(".sleek", { recursive: true });
  const logPath = join(".sleek", `scaffold-worker-${config.prNumber}.log`);

  const child = fork(WORKER_PATH, [cfgPath], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });

  const stderrRing: string[] = [];
  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    try {
      appendFileSync(logPath, text);
    } catch {
      // best-effort log; never let logging break the run
    }
    stderrBuf += text;
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() ?? "";
    for (const line of lines) {
      stderrRing.push(line);
      if (stderrRing.length > STDERR_RING_LINES) stderrRing.shift();
    }
  });

  // Cancel: process-group-kill (negative pid), escalating to SIGKILL after a grace.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // group may already be gone
    }
    killTimer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }, KILL_ESCALATION_MS);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  // Also take the child down if the parent process exits.
  const onParentExit = (): void => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  };
  process.once("exit", onParentExit);

  return new Promise((resolve, reject) => {
    let result: WorkerResult | undefined;
    let workerError: string | undefined;
    let resultPath: string | undefined;

    const cleanup = (): void => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      process.removeListener("exit", onParentExit);
      unlinkBestEffort(resultPath);
      try {
        rmSync(cfgDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    child.on("message", (msg: WorkerMessage) => {
      if (msg.type === "event") {
        onEvent(msg.event);
      } else if (msg.type === "result") {
        if ("path" in msg) {
          resultPath = msg.path;
          try {
            result = readWorkerResultFile(msg.path);
          } catch (err) {
            cleanup();
            reject(err);
            return;
          } finally {
            unlinkBestEffort(resultPath);
            resultPath = undefined;
          }
        } else {
          result = { changeSet: msg.changeSet, scaffold: msg.scaffold, layerTitles: msg.layerTitles };
        }
      } else if (msg.type === "error") {
        workerError = msg.message;
      }
    });

    child.on("error", (err) => {
      cleanup();
      reject(new Error(`scaffold worker failed to start: ${err.message}`));
    });

    child.on("exit", (code, sigCode) => {
      cleanup();
      if (result) {
        resolve(result);
        return;
      }
      if (workerError) {
        reject(new Error(workerError));
        return;
      }
      const tail = stderrRing.slice(-10).join("\n").trim();
      reject(
        new Error(
          `scaffold worker exited (code=${code ?? "null"}, signal=${sigCode ?? "null"}) without a result` +
            (tail ? `:\n${tail}` : ""),
        ),
      );
    });
  });
}

export function buildScaffoldingClosure(
  repoPath: string,
  prNumber: number,
  options: { cache: SleekCache; store: Store; timeline?: Timeline; gh?: GhRunner },
): NonNullable<StartServerOptions["scaffolding"]> {
  // `store` (parent-only persistence, done server-side in serve.ts) and `gh`
  // (the worker does its own ingest) are no longer used here in Wave 9B; the
  // options shape stays fixed so serve-pr.ts / serve-demo.ts keep compiling.
  const { cache, timeline } = options;

  const providerInfo = scaffolderProviderInfo(process.env);

  // Wave 9B: the scaffold run lives in a forked child (scripts/scaffold-worker.ts)
  // so a crash rejects run() cleanly and the server survives. This closure
  // relays the child's IPC progress events to onEvent and renders the HTML in
  // the parent from the returned changeSet/scaffold/layerTitles.
  async function runScaffold(
    choice: InternalRunChoice,
    onEvent: (e: ScaffoldProgressEvent) => void,
    runOpts?: { signal?: AbortSignal; onPartialResult?: (result: { scaffold: ReviewScaffold; html: string }) => void },
  ): Promise<{ scaffold: ReviewScaffold; html: string }> {
    // Wave-3A: intercept partial-scaffold events to call onPartialResult.
    // We need the ChangeSet for rendering but only have it after runWorker resolves.
    // Strategy: capture the partial layers when the event arrives, then render
    // immediately after changeSet becomes available via a special early-return path.
    // Since runWorker is async and emits events before resolving, we buffer
    // partial layers from partial-scaffold and render them once changeSet arrives
    // from the worker result — but that's too late (happens at full completion).
    //
    // For the partial render we instead do an optimistic render with no diff content:
    // build a ReviewScaffold from the partial layers (empty bundles/findings), render it
    // with the pre-existing changeSet if we have it, or skip if not yet available.
    // The ChangeSet IS available after ingest (first worker events) — but we don't have it
    // in the parent until runWorker resolves. So we must resolve changeSet early.
    //
    // Solution: capture `partial-scaffold` event + snapshot changeSet from the worker
    // result file (the worker writes the result file before sending the `result` IPC message).
    // Simpler: just store partial layers and defer the render until after runWorker, then
    // call onPartialResult before returning. This is "after-skeleton" not "during-skeleton",
    // but gives the server the partial HTML as soon as the skeleton is done — still ~60-90s
    // earlier than the full run.
    let partialLayersEvent: Extract<ScaffoldProgressEvent, { event: "partial-scaffold" }> | undefined;
    const wrappedOnEvent = (e: ScaffoldProgressEvent): void => {
      onEvent(e);
      if (e.event === "partial-scaffold") {
        partialLayersEvent = e;
      }
    };

    const { changeSet, scaffold: reviewScaffold, layerTitles } = await runWorker(
      { repoPath, prNumber, choice, cacheDb: WORKER_CACHE_DB },
      wrappedOnEvent,
      runOpts?.signal,
    );

    const prUrl = await demoPrUrl(repoPath, prNumber);

    // Wave-3A: if skeleton-only layers are available and caller wants partial HTML,
    // render a partial scaffold (empty bundles/findings) and call onPartialResult.
    // This fires between skeleton-done and detail-done, giving the server a reviewable
    // skeleton page before all findings arrive.
    if (partialLayersEvent && runOpts?.onPartialResult) {
      const EMPTY_BUNDLE = { summary: "", neighbors: [], history: [], learnings: [] };
      const partialScaffold: ReviewScaffold = {
        pr: reviewScaffold.pr,
        layers: partialLayersEvent.layers.map((l) => ({
          id: l.id,
          order: l.order,
          anchors: l.anchors as ReviewScaffold["layers"][number]["anchors"],
          bundle: EMPTY_BUNDLE,
          findings: [],
        })),
      };
      try {
        const partialHtml = renderDemoHtmlCached(
          cache,
          { changeSet, reviewScaffold: partialScaffold, layerTitles, prUrl },
          undefined,
          { lazyLargeFiles: true },
        );
        runOpts.onPartialResult({ scaffold: partialScaffold, html: partialHtml });
      } catch {
        // Best-effort: partial render failure must not abort the full run.
      }
    }

    const html = renderDemoHtmlCached(
      cache,
      { changeSet, reviewScaffold, layerTitles, prUrl },
      timeline,
      { lazyLargeFiles: true },
    );
    return { scaffold: reviewScaffold, html };
  }

  return {
    anthropic: providerInfo.live,
    providerLabel: providerInfo.label,
    replay: hasAuthoredReview(prNumber),
    run(choice, onEvent, runOpts) {
      return runScaffold(choice as InternalRunChoice, onEvent, runOpts);
    },
  };
}

/**
 * Build the injected fake LLM runner that replays the authored review for prNumber.
 * Used by buildScaffoldingClosure for replay scaffolding.
 */
export function buildReplayRunner(
  prNumber: number,
  changeSet: ChangeSet,
): { runner: LlmRunner; layerTitles: Record<string, string> } {
  const authoredJson = loadAuthoredReviewJson(prNumber);
  if (!authoredJson) {
    throw new Error(
      `No authored review for PR #${prNumber}: scripts/reviews/${prNumber}.json does not exist ` +
        `(see the format documented in scripts/demo-data.ts).`,
    );
  }
  const layerTitles = Object.fromEntries(authoredJson.layers.map((l) => [l.id, l.title]));

  const regions = parseChangedRegions(changeSet.unifiedDiff);

  const skeletonLayers = [...authoredJson.layers]
    .map(({ id, order, anchors }) => ({ id, order, anchors }))
    .sort((a, b) => a.order - b.order);
  // The scaffolder skeleton tool now speaks region INDEXES: translate the authored anchor
  // grouping to indices into the parsed regions (same order the scaffolder sees).
  const skeletonIndexLayers = toRegionIndexes(
    skeletonLayers,
    regions.map((r) => ({ file: r.file, side: r.side, startLine: r.startLine, endLine: r.endLine })),
  );

  const runner: LlmRunner = {
    async run(req) {
      if (req.tool.name === "emit_layer_boundaries") {
        return { toolInput: { layers: skeletonIndexLayers }, usage: { cacheCreationInputTokens: 0, cacheReadInputTokens: 0, inputTokens: 0, outputTokens: 0 } };
      }
      const id = req.userText.match(/Layer "(.+?)"/)?.[1] ?? "";
      const layer = authoredJson.layers.find((l) => l.id === id);
      if (!layer) {
        console.warn(`  ⚠ authored per-Layer detail lookup missed Layer id "${id}" — emitting placeholder`);
      }
      const anchors = layer?.anchors ?? [];
      const bundle = layer
        ? { ...layer.bundle, learnings: [] }
        : { summary: `Changes in ${id}.`, neighbors: [], history: [], learnings: [] };
      const findings = (layer?.findings ?? []).map((f) => ({
        anchor: anchorFor(anchors, { side: f.anchor.side, anchor: f.anchor }),
        concern: f.concern,
        severity: f.severity,
        text: f.text,
      }));
      return { toolInput: { bundle, findings }, usage: { cacheCreationInputTokens: 0, cacheReadInputTokens: 0, inputTokens: 0, outputTokens: 0 } };
    },
  };

  return { runner, layerTitles };
}
