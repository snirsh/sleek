/**
 * Cached wrapper around M2's buildContext (src/context/index.ts). History and graph
 * neighbors are deterministic per head SHA, so a built ContextInput is content-
 * addressed by (headSha, hash of the parsed changed regions): same SHA + same
 * regions → same context, no worktree, no git subprocesses. The regions hash guards
 * against the same SHA being paired with a different diff payload (e.g. a base
 * branch move changing the PR diff without a new head push).
 *
 * The JSON shape is protected by the cache's schema_version column (see cache.ts):
 * bumping CACHE_SCHEMA_VERSION after a ContextInput shape change makes old rows read
 * as misses.
 */

import { parseChangedRegions } from "../context/diff.ts";
import {
  buildContext,
  type BuildContextOptions,
  type ContextInput,
} from "../context/index.ts";
import type { ChangeSet } from "../domain/scaffold.ts";
import type { Timeline } from "../perf/timing.ts";
import { contextInputKey, hashText, type SleekCache } from "./cache.ts";

/**
 * buildContext through the pipeline cache. Records one "context build" timing row
 * (HIT/MISS) when a timeline is given.
 */
export async function buildContextCached(
  cache: SleekCache,
  changeSet: ChangeSet,
  repoPath: string,
  options: BuildContextOptions & { timeline?: Timeline } = {},
): Promise<ContextInput> {
  const { timeline, ...buildOptions } = options;
  const start = performance.now();

  const regionsHash = hashText(JSON.stringify(parseChangedRegions(changeSet.unifiedDiff)));
  const key = contextInputKey(changeSet.pr.headSha, regionsHash);

  const hit = cache.get("context", key);
  if (hit !== null) {
    timeline?.add("context build", performance.now() - start, "HIT");
    return JSON.parse(hit) as ContextInput;
  }

  const built = await buildContext(changeSet, repoPath, buildOptions);
  cache.set("context", key, JSON.stringify(built));
  timeline?.add("context build", performance.now() - start, "MISS");
  return built;
}
