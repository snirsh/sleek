/**
 * Wave-5 baseline instrumentation: a tiny per-stage timing helper for the pipeline
 * scripts (serve-demo.ts / demo-review.ts). Stages are recorded in the order they
 * complete and printed as one compact aligned table at startup — this table IS the
 * perf UI (docs/UI-ROADMAP.md Wave 5), so it stays even after the caches land.
 *
 * A stage's optional `note` carries cache outcomes ("HIT" / "MISS" / "reused") so the
 * fast-path assembly reads at a glance. Formatting is a pure function
 * ({@link formatStageTable}) so it is unit-testable without timers.
 */

/** One completed pipeline stage. `ms` is wall time; `note` is e.g. "HIT" / "MISS". */
export interface StageEntry {
  stage: string;
  ms: number;
  note?: string;
}

export interface Timeline {
  /** Time an async (or sync) stage; the entry is recorded when `fn` settles. */
  time<T>(stage: string, fn: () => T | Promise<T>, note?: string): Promise<T>;
  /** Record a stage measured elsewhere (e.g. inside an injected runner). */
  add(stage: string, ms: number, note?: string): void;
  /** Entries in completion order (a copy). */
  entries(): StageEntry[];
  /** The aligned table, ready for console.log. */
  table(): string;
}

/** Format `ms` with one decimal, e.g. "512.3". */
function fmtMs(ms: number): string {
  return ms.toFixed(1);
}

/**
 * Render entries as a compact aligned table (stage left-aligned, ms right-aligned,
 * note trailing), with a `total` row summing all stages. Pure — exported for tests.
 *
 *   stage             ms
 *   gh view        512.3  MISS
 *   render          88.0  HIT
 *   total          600.3
 */
export function formatStageTable(entries: StageEntry[]): string {
  const rows: [string, string, string][] = entries.map((e) => [
    e.stage,
    fmtMs(e.ms),
    e.note ?? "",
  ]);
  const total = entries.reduce((sum, e) => sum + e.ms, 0);
  rows.push(["total", fmtMs(total), ""]);

  const stageWidth = Math.max("stage".length, ...rows.map(([s]) => s.length));
  const msWidth = Math.max("ms".length, ...rows.map(([, ms]) => ms.length));

  const lines = [`  ${"stage".padEnd(stageWidth)}  ${"ms".padStart(msWidth)}`];
  for (const [stage, ms, note] of rows) {
    lines.push(
      `  ${stage.padEnd(stageWidth)}  ${ms.padStart(msWidth)}${note ? `  ${note}` : ""}`,
    );
  }
  return lines.join("\n");
}

/**
 * Create a Timeline. `now` is injectable for tests; defaults to the monotonic
 * high-resolution clock.
 */
export function createTimeline(now: () => number = () => performance.now()): Timeline {
  const entries: StageEntry[] = [];
  return {
    async time<T>(stage: string, fn: () => T | Promise<T>, note?: string): Promise<T> {
      const start = now();
      try {
        return await fn();
      } finally {
        entries.push({ stage, ms: now() - start, ...(note ? { note } : {}) });
      }
    },
    add(stage, ms, note) {
      entries.push({ stage, ms, ...(note ? { note } : {}) });
    },
    entries: () => entries.map((e) => ({ ...e })),
    table: () => formatStageTable(entries),
  };
}
