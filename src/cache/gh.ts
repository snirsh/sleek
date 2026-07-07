/**
 * A caching {@link GhRunner} — the Wave-5 seam between M1 Ingest and the pipeline
 * cache. ingestPr() already takes an injectable runner, so caching (and per-stage
 * timing) wraps around it without touching src/ingest at all.
 *
 * Recognized calls:
 *   - `gh pr view <n> --json …`  → "gh-view", keyed (repoUrl, pr), read with a short
 *     TTL ({@link GH_VIEW_TTL_MS}) so a restart skips the network but a new push is
 *     seen. `refresh: true` (SLEEK_REFRESH=1) skips the read entirely — gh is always
 *     asked — while still writing the fresh payload back.
 *   - `gh pr diff <n>`           → "gh-diff", keyed (repoUrl, pr, headSha) — immutable,
 *     no TTL. The head SHA comes from the view payload that always precedes the diff
 *     in ingestPr (cached or fresh); if it is somehow unknown, the call passes through
 *     uncached rather than guessing a key.
 *
 * Anything else passes straight through to `inner`. Each recognized call records a
 * "gh view" / "gh diff" timing row with a HIT/MISS note when a timeline is given.
 */

import type { GhRunner } from "../ingest/ingest.ts";
import type { Timeline } from "../perf/timing.ts";
import { GH_VIEW_TTL_MS, ghDiffKey, ghViewKey, type SleekCache } from "./cache.ts";

export interface CachingGhRunnerOptions {
  cache: SleekCache;
  /** Repo URL used in cache keys (from githubRepoUrl / origin remote). */
  repoUrl: string;
  prNumber: number;
  /** SLEEK_REFRESH=1: skip the gh-view read (always re-fetch); writes still happen. */
  refresh?: boolean;
  timeline?: Timeline;
  inner: GhRunner;
}

/** Pull `headRefOid` out of a `gh pr view --json …` payload; null when unparsable. */
function headShaOf(viewJson: string): string | null {
  try {
    const parsed = JSON.parse(viewJson) as { headRefOid?: unknown };
    return typeof parsed.headRefOid === "string" ? parsed.headRefOid : null;
  } catch {
    return null;
  }
}

export function createCachingGhRunner(options: CachingGhRunnerOptions): GhRunner {
  const { cache, repoUrl, prNumber, refresh = false, timeline, inner } = options;
  const n = String(prNumber);
  // Captured from the view payload (either source); keys the diff that follows it.
  let headSha: string | null = null;

  return async (args, cwd) => {
    const start = performance.now();
    const done = (stage: string, note: string): void => {
      timeline?.add(stage, performance.now() - start, note);
    };

    if (args[0] === "pr" && args[1] === "view" && args[2] === n) {
      const key = ghViewKey(repoUrl, prNumber);
      if (!refresh) {
        const hit = cache.get("gh-view", key, { ttlMs: GH_VIEW_TTL_MS });
        if (hit !== null) {
          headSha = headShaOf(hit);
          done("gh view", "HIT");
          return hit;
        }
      }
      const out = await inner(args, cwd);
      headSha = headShaOf(out);
      cache.set("gh-view", key, out);
      done("gh view", refresh ? "MISS (refresh)" : "MISS");
      return out;
    }

    if (args[0] === "pr" && args[1] === "diff" && args[2] === n && headSha !== null) {
      const key = ghDiffKey(repoUrl, prNumber, headSha);
      const hit = cache.get("gh-diff", key); // immutable per head SHA — no TTL
      if (hit !== null) {
        done("gh diff", "HIT");
        return hit;
      }
      const out = await inner(args, cwd);
      cache.set("gh-diff", key, out);
      done("gh diff", "MISS");
      return out;
    }

    return inner(args, cwd);
  };
}
