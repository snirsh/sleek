import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createLspManager,
  pooledWorktreePath,
  selectStaleWorktrees,
  worktreeReuseDecision,
} from "./manager.ts";
import type { LspManager } from "./manager.ts";

/**
 * Routing + status. PATH is pointed at an empty dir for the whole suite so
 * rust/java deterministically probe as unavailable regardless of the host
 * machine; the ts provider is in-process and needs no PATH.
 */
describe("createLspManager", () => {
  let root: string;
  let manager: LspManager;
  let savedPath: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sleek-lsp-mgr-"));
    savedPath = process.env.PATH;
    process.env.PATH = root; // empty of binaries
    await writeFile(
      join(root, "hello.ts"),
      'export const greeting = "hi";\nconst n: number = greeting;\n',
    );
    manager = createLspManager(root);
  });

  afterAll(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("routes by extension", () => {
    expect(manager.providerFor("a/b/c.ts")?.languages).toContain("ts");
    expect(manager.providerFor("x.jsx")?.languages).toContain("jsx");
    expect(manager.providerFor("lib.rs")?.languages).toEqual(["rs"]);
    expect(manager.providerFor("Main.java")?.languages).toEqual(["java"]);
    expect(manager.providerFor("style.css")).toBeNull();
    expect(manager.providerFor("Makefile")).toBeNull();
  });

  it("answers ts queries through the routed provider (worktree-relative path)", async () => {
    const hover = await manager.hover("hello.ts", 1, 14); // `greeting`
    expect(hover?.contents).toContain('const greeting: "hi"');

    const diags = await manager.diagnostics("hello.ts");
    expect(diags.some((d) => d.severity === "error")).toBe(true);
  });

  it("availability: ts yes; missing binaries no (with hint); unknown ext no (no hint)", async () => {
    expect(await manager.availability("hello.ts")).toEqual({ available: true });
    expect(await manager.availability("lib.rs")).toEqual({
      available: false,
      installHint: "brew install rust-analyzer",
    });
    expect(await manager.availability("style.css")).toEqual({
      available: false,
    });
  });

  it("status reports per-language availability and state", async () => {
    const status = await manager.status();
    // ts additionally reports its live project cache (memory telemetry).
    expect(status.ts).toEqual({
      available: true,
      state: "ready",
      projects: { count: expect.any(Number), max: 4 },
    });
    expect(status.rust).toEqual({
      available: false,
      state: "unavailable",
      installHint: "brew install rust-analyzer",
    });
    expect(status.java).toEqual({
      available: false,
      state: "unavailable",
      installHint: "brew install jdtls",
    });
  });

  it("queries for unroutable or unavailable languages degrade to null/[]", async () => {
    expect(await manager.hover("style.css", 1, 1)).toBeNull();
    expect(await manager.definition("lib.rs", 1, 1)).toEqual([]);
    expect(await manager.diagnostics("Main.java")).toEqual([]);
  });
});

/**
 * Pure decision core of the stale-worktree sweep (the fs/git side is best-effort and
 * exercised by the demo/serve scripts, not unit-tested).
 */
describe("selectStaleWorktrees", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 10 * HOUR;
  const stale = now - 2 * HOUR;
  const fresh = now - HOUR / 2;

  it("deletes prefixed, unregistered, hour-old dirs only", () => {
    expect(
      selectStaleWorktrees(
        [
          { path: "/tmp/sleek-lsp-worktree-old1", mtimeMs: stale },
          { path: "/tmp/sleek-lsp-worktree-old2", mtimeMs: stale },
        ],
        [],
        now,
      ),
    ).toEqual(["/tmp/sleek-lsp-worktree-old1", "/tmp/sleek-lsp-worktree-old2"]);
  });

  it("keeps registered worktrees even when old (a running server owns one)", () => {
    expect(
      selectStaleWorktrees(
        [{ path: "/tmp/sleek-lsp-worktree-live", mtimeMs: stale }],
        ["/tmp/sleek-lsp-worktree-live"],
        now,
      ),
    ).toEqual([]);
  });

  it("matches registrations by basename (symlinked tmpdir: /var vs /private/var)", () => {
    expect(
      selectStaleWorktrees(
        [{ path: "/var/folders/x/T/sleek-lsp-worktree-live", mtimeMs: stale }],
        ["/private/var/folders/x/T/sleek-lsp-worktree-live"],
        now,
      ),
    ).toEqual([]);
  });

  it("keeps fresh dirs (racing process between mkdtemp and `git worktree add`)", () => {
    expect(
      selectStaleWorktrees(
        [{ path: "/tmp/sleek-lsp-worktree-racing", mtimeMs: fresh }],
        [],
        now,
      ),
    ).toEqual([]);
  });

  it("never touches dirs without a sleek worktree prefix", () => {
    expect(
      selectStaleWorktrees(
        [{ path: "/tmp/some-other-tempdir", mtimeMs: stale }],
        [],
        now,
      ),
    ).toEqual([]);
  });

  // Wave-5 pool: sleek-wt- dirs are MEANT to be reused, so they age out at ~24h,
  // not 1h — and registration still protects a running server's pooled checkout.
  describe("pooled (sleek-wt-) worktrees", () => {
    const DAY = 24 * HOUR;
    const poolNow = 3 * DAY;

    it("keeps a pooled dir an hour (even a day) old; sweeps past ~24h", () => {
      expect(
        selectStaleWorktrees(
          [
            { path: "/tmp/sleek-wt-aaaa-1111", mtimeMs: poolNow - 2 * HOUR },
            { path: "/tmp/sleek-wt-bbbb-2222", mtimeMs: poolNow - DAY },
            { path: "/tmp/sleek-wt-cccc-3333", mtimeMs: poolNow - DAY - HOUR },
          ],
          [],
          poolNow,
        ),
      ).toEqual(["/tmp/sleek-wt-cccc-3333"]);
    });

    it("keeps a registered pooled dir regardless of age", () => {
      expect(
        selectStaleWorktrees(
          [{ path: "/tmp/sleek-wt-dddd-4444", mtimeMs: poolNow - 2 * DAY }],
          ["/private/tmp/sleek-wt-dddd-4444"],
          poolNow,
        ),
      ).toEqual([]);
    });

    it("applies per-scheme ages side by side (legacy 1h, pooled 24h)", () => {
      expect(
        selectStaleWorktrees(
          [
            { path: "/tmp/sleek-lsp-worktree-legacy", mtimeMs: poolNow - 2 * HOUR },
            { path: "/tmp/sleek-wt-eeee-5555", mtimeMs: poolNow - 2 * HOUR },
          ],
          [],
          poolNow,
        ),
      ).toEqual(["/tmp/sleek-lsp-worktree-legacy"]);
    });
  });
});

/** Pure decision core of the Wave-5 worktree pool (createWorktreeLsp). */
describe("worktreeReuseDecision", () => {
  it("creates when nothing exists at the pooled path", () => {
    expect(worktreeReuseDecision({ exists: false, headSha: null }, "abc")).toBe("create");
  });

  it("reuses when the existing checkout's HEAD matches the wanted sha", () => {
    expect(worktreeReuseDecision({ exists: true, headSha: "abc" }, "abc")).toBe("reuse");
  });

  it("recreates on a different HEAD or an unreadable checkout", () => {
    expect(worktreeReuseDecision({ exists: true, headSha: "def" }, "abc")).toBe("recreate");
    expect(worktreeReuseDecision({ exists: true, headSha: null }, "abc")).toBe("recreate");
  });
});

describe("pooledWorktreePath", () => {
  it("is stable per (repo, sha) and distinct across repos and shas", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const a = pooledWorktreePath("/repo/a", sha);
    expect(a).toBe(pooledWorktreePath("/repo/a", sha));
    expect(a).toContain("sleek-wt-0123456789ab");
    expect(pooledWorktreePath("/repo/b", sha)).not.toBe(a);
    expect(
      pooledWorktreePath("/repo/a", "fedcba9876543210fedcba9876543210fedcba98"),
    ).not.toBe(a);
  });
});
