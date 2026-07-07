/**
 * Scaffold worker (Wave 9B) — the child process that runs a single scaffold to
 * completion, isolated from the server. Forked by scripts/demo-data.ts'
 * buildScaffoldingClosure with `child_process.fork(workerPath, [configPath])`
 * (execArgv is inherited, so tsx transpiles this .ts child — verified
 * empirically). Isolating the run in a child means a crash rejects the parent's
 * run() and surfaces as a clean `error` event; the server stays up.
 *
 * Protocol (over process IPC):
 *   parent → child: argv[2] is a path to a JSON config file
 *                   {repoPath, prNumber, choice, cacheDb}
 *   child → parent: {type:"event", event}   — one per scaffold progress event
 *                   {type:"result", path}    — JSON result temp file, then exit 0
 *                   {type:"error", message}  then exit 1
 *
 * Any uncaughtException / unhandledRejection is caught and sent as
 * {type:"error"} before exiting 1 — a worker crash must never look like a
 * silent hang to the parent.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCache } from "../src/cache/cache.ts";
import { buildContextCached } from "../src/cache/context.ts";
import { parseChangedRegions } from "../src/context/diff.ts";
import { withWorktree } from "../src/context/worktree.ts";
import type { ContextInput, RegionContext } from "../src/context/index.ts";
import type { ChangeSet, ReviewScaffold } from "../src/domain/scaffold.ts";
import { ingestPr } from "../src/ingest/ingest.ts";
import { scaffold } from "../src/scaffolder/scaffolder.ts";
import { createCliScaffolderRunner } from "../src/scaffolder/runners.ts";
import type { ScaffoldProgressEvent } from "../src/server/serve.ts";
import { buildReplayRunner, makeProgressHandler, type InternalRunChoice } from "./demo-data.ts";

/** JSON config the parent writes to a temp file and passes as argv[2]. */
export interface WorkerConfig {
  repoPath: string;
  prNumber: number;
  choice: InternalRunChoice;
  /** Path to the pipeline cache db (the worker opens its OWN connection). */
  cacheDb: string;
}

/** Messages the worker sends back to the parent over IPC. */
export type WorkerMessage =
  | { type: "event"; event: ScaffoldProgressEvent }
  | {
      type: "result";
      changeSet: ChangeSet;
      scaffold: ReviewScaffold;
      layerTitles: Record<string, string>;
    }
  | { type: "result"; path: string }
  | { type: "error"; message: string };

function send(msg: WorkerMessage): void {
  process.send?.(msg);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

// A crash in scaffold()/ingest/an errant dependency must surface as an error
// event, not a silent child death. Install these BEFORE any real work.
let crashed = false;
function fatal(err: unknown): void {
  if (crashed) return;
  crashed = true;
  send({ type: "error", message: errorMessage(err) });
  // Give the IPC message a tick to flush before exiting.
  setTimeout(() => process.exit(1), 50);
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

async function run(config: WorkerConfig): Promise<void> {
  const { repoPath, prNumber, choice, cacheDb } = config;

  // The worker opens its OWN cache connection (WAL + busy_timeout via openCache),
  // so concurrent parent access cannot produce "database is locked".
  const cache = openCache(cacheDb);

  let peakRss = 0;
  let peakHeap = 0;
  function sampleMemory(): void {
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
  }

  const onEvent = (event: ScaffoldProgressEvent): void => {
    send({ type: "event", event });
    if (
      event.event === "stage" &&
      event.status === "done" &&
      (event.stage === "ingest" || event.stage === "skeleton" || event.stage === "detail")
    ) {
      sampleMemory();
    }
  };
  const onProgress = makeProgressHandler(onEvent);

  try {
    // --- Stage: ingest ---
    const t0 = performance.now();
    onEvent({ event: "stage", stage: "ingest", status: "start" });
    const changeSet = await ingestPr(prNumber, { cwd: repoPath });

    // Lite context (regions only) is enough for the replay path; the live paths
    // build full context (neighbors + history) via buildContextCached.
    const regions = parseChangedRegions(changeSet.unifiedDiff);
    const liteContext: ContextInput = {
      headSha: changeSet.pr.headSha,
      regions: regions.map<RegionContext>((r) => ({
        anchor: { file: r.file, side: r.side, startLine: r.startLine, endLine: r.endLine },
        neighbors: [],
        history: [],
      })),
      dedup: { siblings: new Map(), groupSize: new Map() },
    };
    onEvent({
      event: "stage",
      stage: "ingest",
      status: "done",
      ms: Math.round(performance.now() - t0),
      files: changeSet.files.length,
      regions: regions.length,
      noiseFiles: (changeSet as unknown as { noiseFiles?: string[] }).noiseFiles?.length ?? 0,
    });

    let reviewScaffold: ReviewScaffold;
    let layerTitles: Record<string, string> = {};

    if (choice.kind === "replay") {
      const { runner, layerTitles: lt } = buildReplayRunner(prNumber, changeSet);
      layerTitles = lt;
      reviewScaffold = await scaffold({ ...changeSet }, liteContext, { runner, onProgress });
    } else if (choice.kind === "cli") {
      // Full context + a detached head-SHA worktree so the CLI agent can read
      // the changed source and the diff file from its cwd. fetchRefs makes an
      // unfetched PR head resolvable (Wave 9A's withWorktree option).
      const fullContext = await buildContextCached(cache, changeSet, repoPath);
      reviewScaffold = await withWorktree(
        repoPath,
        changeSet.pr.headSha,
        async (worktreePath) => {
          // env: process.env so SLEEK_SCAFFOLDER_TIMEOUT_MS / SLEEK_AGENT_* tuning
          // reaches the runner config; the picker's explicit model still wins over
          // any env model because createCliScaffolderRunner applies it last.
          const runner = createCliScaffolderRunner(choice.provider, choice.model, {
            cwd: worktreePath,
            env: process.env,
          });
          return scaffold(changeSet, fullContext, { runner, onProgress });
        },
        { fetchRefs: [`pull/${prNumber}/head`] },
      );
    } else {
      throw new Error("unsupported scaffold choice kind");
    }

    cache.close();
    sampleMemory();
    onEvent({
      event: "stage",
      stage: "stats",
      status: "done",
      note: `peakRss=${mb(peakRss)}MB heap=${mb(peakHeap)}MB`,
    });
    const resultPath = join(tmpdir(), `sleek-scaffold-result-${randomUUID()}.json`);
    writeFileSync(resultPath, JSON.stringify({ changeSet, scaffold: reviewScaffold, layerTitles }));
    send({ type: "result", path: resultPath });
    // Let the IPC message flush before exiting.
    setTimeout(() => process.exit(0), 50);
  } catch (err) {
    try {
      cache.close();
    } catch {
      // ignore
    }
    fatal(err);
  }
}

const configPath = process.argv[2];
if (!configPath) {
  send({ type: "error", message: "scaffold-worker: missing config path (argv[2])" });
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as WorkerConfig;
void run(config);
