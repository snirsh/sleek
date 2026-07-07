import { describe, expect, it } from "vitest";

import { parseChangedRegions } from "../context/diff.ts";
import type { ContextInput } from "../context/index.ts";
import type { ChangeSet } from "../domain/scaffold.ts";
import { contextInputKey, hashText, openCache } from "./cache.ts";
import { buildContextCached } from "./context.ts";

const DIFF = [
  "diff --git a/sample.ts b/sample.ts",
  "--- a/sample.ts",
  "+++ b/sample.ts",
  "@@ -1,2 +1,2 @@",
  "-export const a = 1;",
  "+export const a = 10;",
  " export const b = 2;",
  "",
].join("\n");

const changeSet: ChangeSet = {
  pr: {
    number: 7,
    title: "t",
    description: "",
    baseSha: "base",
    headSha: "headsha1",
  },
  unifiedDiff: DIFF,
  files: ["sample.ts"],
  noiseFiles: [],
};

describe("buildContextCached", () => {
  it("serves a hit without touching git (repoPath may not even exist)", async () => {
    const cache = openCache(":memory:");
    // Note: dedup is intentionally omitted here — Maps don't round-trip through
    // JSON.stringify/parse, and the cache path uses JSON storage. The dedup field
    // is optional (backward-compat) so cached entries without it are valid.
    const cached: ContextInput = {
      headSha: "headsha1",
      regions: [
        {
          anchor: { file: "sample.ts", side: "RIGHT", startLine: 1, endLine: 1 },
          neighbors: [],
          history: [{ sha: "abc", subject: "s", whenRelevant: "now" }],
        },
      ],
    };
    const regionsHash = hashText(JSON.stringify(parseChangedRegions(DIFF)));
    cache.set("context", contextInputKey("headsha1", regionsHash), JSON.stringify(cached));

    // A hit never opens a worktree, so the nonexistent repo path is never touched.
    const result = await buildContextCached(cache, changeSet, "/nonexistent/repo");
    expect(result).toEqual(cached);
    cache.close();
  });

  it("misses on a different head SHA (same regions) — the key carries both", async () => {
    const cache = openCache(":memory:");
    const regionsHash = hashText(JSON.stringify(parseChangedRegions(DIFF)));
    cache.set(
      "context",
      contextInputKey("OTHER-sha", regionsHash),
      JSON.stringify({ headSha: "OTHER-sha", regions: [] }),
    );
    // The miss path reaches for a real worktree of the (nonexistent) repo and throws —
    // proving the stale-SHA entry was not served.
    await expect(buildContextCached(cache, changeSet, "/nonexistent/repo")).rejects.toThrow();
    cache.close();
  });
});
