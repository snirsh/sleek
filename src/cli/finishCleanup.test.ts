import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyFinishCleanup,
  describeFinishCleanup,
  finishCleanupPlan,
} from "./finishCleanup.ts";

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join("/tmp", "sleek-finish-test-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".sleek"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("finish cleanup", () => {
  it("plans cache db sidecars and the active worktree", () => {
    const cacheDb = join(repo, ".sleek", "cache.db");
    const worktree = join(root, "sleek-wt-active");
    writeFileSync(cacheDb, "cache");
    writeFileSync(`${cacheDb}-wal`, "wal");
    writeFileSync(join(repo, ".sleek", "demo.db"), "demo");
    mkdirSync(worktree);

    const plan = finishCleanupPlan({
      repo,
      headSha: "abc123",
      cacheDbPath: cacheDb,
      worktreePath: worktree,
    });

    expect(plan.cacheFiles).toEqual([cacheDb, `${cacheDb}-wal`]);
    expect(plan.worktreeExists).toBe(true);
    expect(describeFinishCleanup(plan)).toContain(".sleek/demo.db is NEVER removed");
  });

  it("deletes planned cache files and worktree without deleting demo.db", async () => {
    const cacheDb = join(repo, ".sleek", "cache.db");
    const demoDb = join(repo, ".sleek", "demo.db");
    const worktree = join(root, "sleek-wt-active");
    writeFileSync(cacheDb, "cache");
    writeFileSync(`${cacheDb}-shm`, "shm");
    writeFileSync(demoDb, "demo");
    mkdirSync(worktree);

    const plan = finishCleanupPlan({
      repo,
      headSha: "abc123",
      cacheDbPath: cacheDb,
      worktreePath: worktree,
    });

    await applyFinishCleanup(plan, repo);

    expect(existsSync(cacheDb)).toBe(false);
    expect(existsSync(`${cacheDb}-shm`)).toBe(false);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(demoDb)).toBe(true);
  });

  it("reports nothing when no targets exist", () => {
    const plan = finishCleanupPlan({
      repo,
      headSha: "abc123",
      cacheDbPath: join(repo, ".sleek", "cache.db"),
      worktreePath: join(root, "missing-worktree"),
    });

    expect(describeFinishCleanup(plan)).toBe("Nothing to clean.\n");
  });
});
