/**
 * Wave-6 live progress lines. Extends Timeline ADDITIVELY with an optional
 * stage listener so each stage prints to stderr as it completes:
 *
 *   ✓ gh view          312.4ms  (HIT)
 *
 * Progress goes to stderr; stdout stays clean for --json.
 * The extended Timeline is a drop-in replacement for the existing one.
 */

import type { StageEntry, Timeline } from "../perf/timing.ts";
import { createTimeline } from "../perf/timing.ts";

export type StageListener = (entry: StageEntry) => void;

export interface ProgressTimelineOptions {
  /** Called whenever a stage completes (synchronously). */
  onStage?: StageListener;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Create a Timeline that calls `onStage` after every `.time()` and `.add()`.
 * When `onStage` is omitted the returned Timeline is identical to the base one.
 */
export function createProgressTimeline(opts: ProgressTimelineOptions = {}): Timeline {
  const { onStage, now } = opts;
  const base = createTimeline(now);

  if (!onStage) return base;

  return {
    async time<T>(stage: string, fn: () => T | Promise<T>, note?: string): Promise<T> {
      let result: T;
      let threw = false;
      let thrownErr: unknown;
      try {
        result = await base.time(stage, fn, note);
      } catch (err) {
        threw = true;
        thrownErr = err;
        result = undefined as unknown as T;
      }
      const entries = base.entries();
      const last = entries[entries.length - 1];
      if (last) onStage(last);
      if (threw) throw thrownErr;
      return result;
    },
    add(stage, ms, note) {
      base.add(stage, ms, note);
      const entries = base.entries();
      const last = entries[entries.length - 1];
      if (last) onStage(last);
    },
    entries: () => base.entries(),
    table: () => base.table(),
  };
}

/** Format a single stage entry as a progress line (no trailing newline). */
export function formatProgressLine(entry: StageEntry): string {
  const check = "✓"; // ✓
  const ms = entry.ms.toFixed(1) + "ms";
  const note = entry.note ? `  (${entry.note})` : "";
  // Stage name left-padded to 20 chars, ms right-aligned to 9 chars.
  const stage = entry.stage.padEnd(20);
  const msAligned = ms.padStart(9);
  return `${check} ${stage}  ${msAligned}${note}`;
}

/** Write a progress line to stderr. */
export function printProgress(entry: StageEntry): void {
  process.stderr.write(formatProgressLine(entry) + "\n");
}
