import type { ChangeSet, ReviewScaffold } from "./scaffold.ts";
import type { GhRunner } from "../ingest/ingest.ts";
import type { Timeline } from "../perf/timing.ts";
import type { Store } from "../store/index.ts";

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
