import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  contextInputKey,
  ghDiffKey,
  ghViewKey,
  hashText,
  htmlKey,
  isFresh,
  openCache,
  rendererVersionHash,
  selectEvictions,
  type CacheRowMeta,
} from "./cache.ts";

describe("cache keys", () => {
  it("compose their parts distinctly", () => {
    expect(ghViewKey("https://github.com/o/r", 123)).toBe("https://github.com/o/r#123");
    expect(ghDiffKey("https://github.com/o/r", 123, "abc")).toBe(
      "https://github.com/o/r#123#abc",
    );
    expect(contextInputKey("abc", "regions-hash")).toBe("abc#regions-hash");
    expect(htmlKey(7, "abc", "data", "renderer")).toBe("7#abc#data#renderer");
  });

  it("hashText is a stable sha256 hex", () => {
    expect(hashText("x")).toBe(hashText("x"));
    expect(hashText("x")).not.toBe(hashText("y"));
    expect(hashText("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isFresh (TTL decision)", () => {
  it("no TTL → always fresh; within TTL fresh; past TTL stale", () => {
    expect(isFresh(0, 1_000_000, undefined)).toBe(true);
    expect(isFresh(1000, 1500, 600)).toBe(true);
    expect(isFresh(1000, 1601, 600)).toBe(false);
  });
});

describe("selectEvictions", () => {
  const row = (kind: string, key: string, createdAtMs: number, bytes = 10): CacheRowMeta => ({
    kind,
    key,
    bytes,
    createdAtMs,
  });

  it("keeps the newest maxRowsPerKind per kind, evicting older ones", () => {
    const rows = [
      row("html", "a", 1),
      row("html", "b", 2),
      row("html", "c", 3),
      row("gh-diff", "d", 1),
    ];
    expect(selectEvictions(rows, { maxRowsPerKind: 2, maxTotalBytes: 1000 })).toEqual([
      { kind: "html", key: "a" },
    ]);
  });

  it("evicts oldest-first across kinds when over the byte cap", () => {
    const rows = [
      row("html", "old", 1, 400),
      row("gh-diff", "mid", 2, 400),
      row("gh-view", "new", 3, 400),
    ];
    expect(selectEvictions(rows, { maxRowsPerKind: 10, maxTotalBytes: 800 })).toEqual([
      { kind: "html", key: "old" },
    ]);
  });

  it("evicts nothing when within both caps", () => {
    const rows = [row("html", "a", 1), row("gh-diff", "b", 2)];
    expect(selectEvictions(rows, { maxRowsPerKind: 2, maxTotalBytes: 1000 })).toEqual([]);
  });

  it("breaks created-at ties by key for determinism", () => {
    const rows = [row("html", "b", 5), row("html", "a", 5), row("html", "c", 5)];
    expect(selectEvictions(rows, { maxRowsPerKind: 2, maxTotalBytes: 1000 })).toEqual([
      { kind: "html", key: "c" },
    ]);
  });
});

describe("openCache", () => {
  it("round-trips values and misses on absent keys", () => {
    const cache = openCache(":memory:");
    expect(cache.get("html", "k")).toBeNull();
    cache.set("html", "k", "<html>");
    expect(cache.get("html", "k")).toBe("<html>");
    cache.close();
  });

  it("expires reads past their TTL (and keeps TTL-less kinds forever)", () => {
    let now = 1000;
    const cache = openCache(":memory:", { now: () => now });
    cache.set("gh-view", "k", "payload");
    cache.set("gh-diff", "k", "diff");
    now += 61_000;
    expect(cache.get("gh-view", "k", { ttlMs: 60_000 })).toBeNull();
    expect(cache.get("gh-diff", "k")).toBe("diff"); // immutable: no TTL passed
    cache.close();
  });

  it("self-invalidates rows written under an older schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "sleek-cache-test-"));
    const path = join(dir, "cache.db");
    try {
      const v1 = openCache(path, { schemaVersion: 1 });
      v1.set("context", "k", '{"old":"shape"}');
      v1.close();

      const v2 = openCache(path, { schemaVersion: 2 });
      expect(v2.get("context", "k")).toBeNull(); // stale shape reads as a miss
      v2.set("context", "k", '{"new":"shape"}');
      expect(v2.get("context", "k")).toBe('{"new":"shape"}');
      v2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the eviction caps on set", () => {
    let now = 0;
    const cache = openCache(":memory:", {
      caps: { maxRowsPerKind: 2, maxTotalBytes: 1_000_000 },
      now: () => ++now,
    });
    cache.set("html", "a", "1");
    cache.set("html", "b", "2");
    cache.set("html", "c", "3");
    expect(cache.get("html", "a")).toBeNull(); // oldest of 3 evicted
    expect(cache.get("html", "b")).toBe("2");
    expect(cache.get("html", "c")).toBe("3");
    cache.close();
  });

  it("purge() drops everything (the `sleek clean` hook)", () => {
    const cache = openCache(":memory:");
    cache.set("html", "a", "1");
    cache.set("gh-diff", "b", "2");
    cache.purge();
    expect(cache.get("html", "a")).toBeNull();
    expect(cache.get("gh-diff", "b")).toBeNull();
    cache.close();
  });
});

describe("rendererVersionHash", () => {
  const dir = mkdtempSync(join(tmpdir(), "sleek-render-hash-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("changes when a renderer source changes, ignores non-.ts files", () => {
    writeFileSync(join(dir, "html.ts"), "export const a = 1;");
    writeFileSync(join(dir, "notes.md"), "ignored");
    const before = rendererVersionHash(dir);
    expect(before).toMatch(/^[0-9a-f]{64}$/);

    writeFileSync(join(dir, "notes.md"), "still ignored, changed");
    expect(rendererVersionHash(dir)).toBe(before);

    writeFileSync(join(dir, "html.ts"), "export const a = 2;");
    expect(rendererVersionHash(dir)).not.toBe(before);
  });

  it("hashes the real src/render dir by default (memoized)", () => {
    const version = rendererVersionHash();
    expect(version).toMatch(/^[0-9a-f]{64}$/);
    expect(rendererVersionHash()).toBe(version);
  });
});
