import { describe, expect, it } from "vitest";

import type { GhRunner } from "../ingest/ingest.ts";
import { createTimeline } from "../perf/timing.ts";
import { openCache, type SleekCache } from "./cache.ts";
import { createCachingGhRunner } from "./gh.ts";

const VIEW_ARGS = ["pr", "view", "123", "--json", "number,headRefOid"];
const DIFF_ARGS = ["pr", "diff", "123"];
const VIEW_JSON = JSON.stringify({ number: 123, headRefOid: "headsha1" });

/** A scripted inner runner that counts calls per gh subcommand. */
function fakeInner(calls: string[]): GhRunner {
  return async (args) => {
    calls.push(args.slice(0, 2).join(" "));
    if (args[1] === "view") return VIEW_JSON;
    if (args[1] === "diff") return "diff-payload";
    return "other";
  };
}

function runner(
  cache: SleekCache,
  calls: string[],
  opts: { refresh?: boolean; timeline?: ReturnType<typeof createTimeline> } = {},
): GhRunner {
  return createCachingGhRunner({
    cache,
    repoUrl: "https://github.com/o/r",
    prNumber: 123,
    inner: fakeInner(calls),
    ...opts,
  });
}

describe("createCachingGhRunner", () => {
  it("caches view (TTL) and diff (immutable, keyed by the view's head SHA)", async () => {
    const cache = openCache(":memory:");
    const calls: string[] = [];

    const first = runner(cache, calls);
    expect(await first(VIEW_ARGS, "/repo")).toBe(VIEW_JSON);
    expect(await first(DIFF_ARGS, "/repo")).toBe("diff-payload");
    expect(calls).toEqual(["pr view", "pr diff"]);

    // A fresh runner (new process) within the TTL: both served from cache.
    const second = runner(cache, calls);
    expect(await second(VIEW_ARGS, "/repo")).toBe(VIEW_JSON);
    expect(await second(DIFF_ARGS, "/repo")).toBe("diff-payload");
    expect(calls).toEqual(["pr view", "pr diff"]); // no new inner calls
    cache.close();
  });

  it("records HIT/MISS timing rows for both stages", async () => {
    const cache = openCache(":memory:");
    const calls: string[] = [];
    const timeline = createTimeline();

    const gh = runner(cache, calls, { timeline });
    await gh(VIEW_ARGS, "/repo");
    await gh(DIFF_ARGS, "/repo");
    const again = runner(cache, calls, { timeline });
    await again(VIEW_ARGS, "/repo");
    await again(DIFF_ARGS, "/repo");

    expect(timeline.entries().map((e) => [e.stage, e.note])).toEqual([
      ["gh view", "MISS"],
      ["gh diff", "MISS"],
      ["gh view", "HIT"],
      ["gh diff", "HIT"],
    ]);
    cache.close();
  });

  it("refresh (SLEEK_REFRESH=1) always re-fetches the view but still writes back", async () => {
    const cache = openCache(":memory:");
    const calls: string[] = [];

    await runner(cache, calls)(VIEW_ARGS, "/repo");
    expect(calls).toEqual(["pr view"]);

    const refreshing = runner(cache, calls, { refresh: true });
    await refreshing(VIEW_ARGS, "/repo");
    expect(calls).toEqual(["pr view", "pr view"]); // bypassed the cached copy

    // The refreshed payload was written back: a normal runner now hits.
    await runner(cache, calls)(VIEW_ARGS, "/repo");
    expect(calls).toEqual(["pr view", "pr view"]);
    cache.close();
  });

  it("diff before a view (head SHA unknown) passes through uncached", async () => {
    const cache = openCache(":memory:");
    const calls: string[] = [];
    await runner(cache, calls)(VIEW_ARGS, "/repo");
    await runner(cache, calls)(DIFF_ARGS, "/repo"); // diff without a preceding view:
    // headSha unknown in THIS runner → passthrough, uncached.
    expect(calls).toEqual(["pr view", "pr diff"]);

    const gh = runner(cache, calls);
    await gh(VIEW_ARGS, "/repo"); // HIT (provides headsha1)
    await gh(DIFF_ARGS, "/repo"); // MISS: the passthrough above cached nothing
    expect(calls).toEqual(["pr view", "pr diff", "pr diff"]);
    await gh(DIFF_ARGS, "/repo"); // now cached under (repo, pr, headsha1)
    expect(calls).toEqual(["pr view", "pr diff", "pr diff"]);
    cache.close();
  });

  it("passes unrelated gh calls straight through", async () => {
    const cache = openCache(":memory:");
    const calls: string[] = [];
    const gh = runner(cache, calls);
    expect(await gh(["auth", "status"], "/repo")).toBe("other");
    expect(await gh(["auth", "status"], "/repo")).toBe("other");
    expect(calls).toEqual(["auth status", "auth status"]); // never cached
    cache.close();
  });
});
